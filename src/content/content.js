/**
 * content script —— 数据上报与录制期页面锁定（自身不创建任何 UI）
 *
 * 【为什么页面内不再有「录制控件」】
 * tabCapture 捕获的是「整个标签页的合成画面」，离屏再用 canvas 按播放器矩形裁剪。
 * 只要页面里存在扩展注入的浮层（面板 / 模态框 / 加载遮罩 / toast），它就会和播放器
 * 一起被合成进捕获帧，从而被录进最终视频；而且播放器会随全屏、剧场模式、窗口尺寸
 * 变化，浮层「恰好不压到播放器」这件事无法稳定保证。
 * 因此录制控件全部上移到扩展图标弹窗（popup）：popup 是独立的扩展页面，不属于被
 * 捕获标签页的渲染内容，天然不会出现在视频里。
 *
 * 【为什么又多了一层遮罩】
 * 录制开始后画布尺寸被锁定、裁剪区固定，此时滚动页面、缩放窗口或点到页面链接都会
 * 毁掉这次录制（画面错位、拉伸，甚至跳转导致来不及保存）。遮罩（content/guard.js）
 * 按播放器「真实画面矩形」挖洞，只覆盖画面以外的区域，因此同样不会被录进视频。
 * 本脚本只负责在会话开始 / 结束时开关遮罩，并把每次心跳量到的矩形交给它做布局，
 * 自身依旧不直接创建任何 DOM 节点。
 *
 * 职责：
 * 1. 高频上报播放器矩形（PLAYER_RECT + DPR），供离屏 canvas 做像素级裁剪；
 * 2. 响应离屏主动拉取矩形（PLAYER_RECT_REQUEST），用于心跳中断自愈；
 * 3. 页面隐藏 / 跳转时通知离屏，避免录制中断丢数据；
 * 4. 响应 popup 的就绪探测（YR_PING）；
 * 5. 随录制会话开关「页面交互锁定遮罩」（YR_RECT_ON / YR_RECT_OFF）。
 *
 * 受 background 通过 YR_RECT_ON / YR_RECT_OFF 控制心跳开关，空闲时零开销。
 */
(() => {
  'use strict';

  /** 是否需要上报播放器矩形（由 background 在录制会话开始 / 结束时切换） */
  let captureActive = false;

  /** 用户自定义选区（框选录制模式下有效） */
  let customRect = null;

  /** 录制期交互锁定遮罩（由 guard.js 提供；未注入时静默降级，不影响录制） */
  function guardApi() {
    const api = window.YRGuard;
    return api && typeof api.enable === 'function' ? api : null;
  }

  /** 矩形心跳定时器 id */
  let rectTimer = null;

  /** 心跳间隔（ms）：持续重取，天然覆盖滚动 / 缩放 / 全屏 / SPA 切视频等布局变化 */
  const RECT_INTERVAL_MS = 120;

  /**
   * 播放器候选定位器：按优先级依次探测。
   * YouTube 新旧布局 / 剧场模式 / 迷你播放器等变体较多，多写几个候选
   * 仅在未命中时才多做一次 querySelector，代价可忽略；命中即返回首个
   * 真实可见（尺寸 ≥ 4px）的元素矩形。
   */
  const PLAYER_SELECTORS = [
    'video.html5-main-video', // 新布局：主视频元素
    '#movie_player video', // 播放器容器内 video
    '.html5-video-container video', // 旧布局容器
    '.video-stream.html5-main-video', // video class 兜底
    '#movie_player', // 新版播放器容器
    '#c4-player', // 旧版剧场模式容器
    '#player',
    '#player-container',
    '#player-container-outer',
    'ytd-watch-flexy #player',
    'ytd-player',
    '#ytd-player',
  ];

  /** 诊断日志（仅写控制台，页面内无 UI 可展示） */
  function dlog(text) {
    try {
      console.log('[YR-content]', text);
    } catch (err) {
      /* ignore */
    }
  }

  /** 单值位置关键字 → 0~1 锚点比例（用于 object-position） */
  function positionRatio(token) {
    const t = String(token || '').trim().toLowerCase();
    if (!t || t === 'center') return 0.5;
    if (t === 'left' || t === 'top') return 0;
    if (t === 'right' || t === 'bottom') return 1;
    if (t.slice(-1) === '%') {
      const n = Number(t.slice(0, -1));
      return Number.isFinite(n) ? n / 100 : 0.5;
    }
    // px 等绝对值：缺少元素尺寸无法安全换算，退回居中（YouTube 为默认居中）
    return 0.5;
  }

  /** 解析 object-position（默认 50% 50%），返回 0~1 的水平 / 垂直锚点 */
  function parseObjectPosition(value) {
    const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { x: 0.5, y: 0.5 };
    if (parts.length === 1) {
      const only = String(parts[0]).toLowerCase();
      // 单值语义：top / bottom 指垂直方向，left / right 指水平方向
      if (only === 'top' || only === 'bottom') return { x: 0.5, y: positionRatio(only) };
      if (only === 'left' || only === 'right') return { x: positionRatio(only), y: 0.5 };
      return { x: positionRatio(only), y: positionRatio(only) };
    }
    return { x: positionRatio(parts[0]), y: positionRatio(parts[1]) };
  }

  /**
   * 计算元素「真正绘制出来的画面矩形」。
   *
   * 关键：`<video>` 元素的布局盒子 ≠ 它实际绘制的画面。YouTube 的 `<video>`
   * 默认 `object-fit: contain`，当元素盒子比例与视频自身比例不一致时
   * （剧场模式上下留白、21:9 / 4:3 / 竖屏片源、播放器外壳容器等），
   * 画面会被等比内接并按 object-position 居中，盒子里多出来的部分并不是
   * 视频内容（黑边 / 环境模式光晕 / 剧场模式背景 / 网页内容）。
   * 若直接按元素盒子裁剪，画面上下多余区域就会被一起录进视频。
   */
  function paintedRect(el, rect) {
    const plain = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    if (!el || el.tagName !== 'VIDEO') return plain;
    const vw = el.videoWidth;
    const vh = el.videoHeight;
    // 关键修复：如果视频尺寸尚未就绪（加载中），返回 null 而非 plain。
    // 这将导致 readPlayerRect 暂时跳过该元素，直到它解码出真实的片源宽高，
    // 从而避免在录制开始瞬间因拿到「包含黑边的容器尺寸」而锁定错误的分辨率。
    if (!vw || !vh) return null;
    let cs = null;
    try {
      cs = window.getComputedStyle(el);
    } catch (err) {
      cs = null;
    }
    const fit = (cs && cs.objectFit) || 'contain';
    // fill / cover / none：画面铺满或溢出裁切，元素盒子即画面范围
    if (fit === 'fill' || fit === 'cover' || fit === 'none') return plain;
    // contain / scale-down：等比内接（scale-down 取「内接」与「原始尺寸」的较小者）
    let scale = Math.min(rect.width / vw, rect.height / vh);
    if (fit === 'scale-down') scale = Math.min(scale, 1);
    const w = vw * scale;
    const h = vh * scale;
    const pos = parseObjectPosition(cs && cs.objectPosition);
    return {
      x: rect.x + (rect.width - w) * pos.x,
      y: rect.y + (rect.height - h) * pos.y,
      width: w,
      height: h,
    };
  }

  /** 把画面矩形夹到可视视口内，并给出可见比例（供离屏判断「播放器是否被滚出屏幕」） */
  function clipToViewport(box) {
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const x0 = Math.max(0, box.x);
    const y0 = Math.max(0, box.y);
    const x1 = Math.min(vw, box.x + box.width);
    const y1 = Math.min(vh, box.y + box.height);
    const width = Math.max(0, x1 - x0);
    const height = Math.max(0, y1 - y0);
    const full = Math.max(1, box.width * box.height);
    return {
      x: x0,
      y: y0,
      width,
      height,
      visible: Math.min(1, (width * height) / full),
      fullWidth: box.width,
      fullHeight: box.height,
    };
  }

  /** 读取真实播放器可视区域相对视口的矩形（附带命中的选择器，便于诊断定位是否量错了元素） */
  function readPlayerRect() {
    if (customRect) {
      return {
        x: customRect.x,
        y: customRect.y,
        width: customRect.w,
        height: customRect.h,
        visible: 1,
        fullWidth: customRect.w,
        fullHeight: customRect.h,
        via: 'custom-selector'
      };
    }
    for (const selector of PLAYER_SELECTORS) {
      let el = null;
      try {
        el = document.querySelector(selector);
      } catch (err) {
        continue; // 个别选择器异常不阻断后续候选
      }
      if (!el) continue;
      // 收紧：录制区域的矩形来源必须是一个 <video> 元素。命中容器（如
      // #movie_player）时强制取其内部 <video>；取不到 video 就跳过该候选，
      // 绝不退回更大的容器盒——否则成片会把播放器外壳 / 剧场模式留白 /
      // 页面内容一并录进来（表现为视频上下多出网页内容）。
      let target = el;
      if (target.tagName !== 'VIDEO') {
        let inner = null;
        try {
          inner = target.querySelector('video');
        } catch (err) {
          inner = null;
        }
        if (inner && inner.tagName === 'VIDEO') target = inner;
        else continue;
      }
      const rect = target.getBoundingClientRect();
      // 必须真实可见（有尺寸）；0 尺寸元素（加载中 / 被折叠 / 迷你化前的空壳）继续探测
      if (rect.width < 4 || rect.height < 4) continue;
      const painted = paintedRect(target, rect);
      if (!painted || painted.width < 4 || painted.height < 4) continue;
      const clipped = clipToViewport(painted);
      if (clipped.width < 4 || clipped.height < 4) continue;
      let fit = '';
      try {
        fit = window.getComputedStyle(target).objectFit || '';
      } catch (err) {
        fit = '';
      }
      return {
        x: clipped.x,
        y: clipped.y,
        width: clipped.width,
        height: clipped.height,
        visible: clipped.visible, // 画面完整显示 ≈ 1；被滚出视口时 < 1
        fullWidth: clipped.fullWidth,
        fullHeight: clipped.fullHeight,
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, // video 元素布局盒（诊断用）
        fit, // video 的 object-fit（诊断用）
        srcW: target.videoWidth || 0, // 片源原始像素尺寸（诊断用）
        srcH: target.videoHeight || 0,
        via: selector,
      };
    }
    return null;
  }

  /**
   * 读取视口基准：捕获帧与 CSS 坐标的换算基准。
   *
   * 早期实现直接用「rect × devicePixelRatio」，其隐含前提是
   * 「捕获帧尺寸 = CSS 视口尺寸 × DPR」。该前提在页面缩放、系统缩放、
   * Chrome 对超大画面降采样等场景下并不成立，一旦不成立裁剪区就会整体偏移
   * （表现为录进了播放器上方的网页内容、播放器下半部分丢失）。
   * 现在由离屏用「帧像素尺寸 ÷ 本视口 CSS 尺寸」实测换算，这里只需如实上报视口尺寸；
   * 同时上报可视视口（visualViewport）的偏移与缩放，供双指缩放场景修正原点。
   */
  function readViewportInfo() {
    const vv = window.visualViewport;
    return {
      vw: window.innerWidth || 0,
      vh: window.innerHeight || 0,
      dpr: window.devicePixelRatio || 1,
      vvX: vv && typeof vv.offsetLeft === 'number' ? vv.offsetLeft : 0,
      vvY: vv && typeof vv.offsetTop === 'number' ? vv.offsetTop : 0,
      vvScale: vv && typeof vv.scale === 'number' && vv.scale > 0 ? vv.scale : 1,
    };
  }

  /** 定位失败时的 DOM 体检摘要（限频输出，便于定位根因） */
  function probePlayerDomDetail() {
    const parts = [];
    for (const selector of PLAYER_SELECTORS) {
      let nodes = [];
      try {
        nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
      } catch (err) {
        continue;
      }
      if (!nodes.length) continue;
      const el = nodes[0];
      let rect = null;
      let cs = null;
      try {
        rect = el.getBoundingClientRect();
        cs = window.getComputedStyle(el);
      } catch (err) {
        /* ignore */
      }
      const size = rect ? Math.round(rect.width) + 'x' + Math.round(rect.height) : 'n/a';
      const style = cs ? 'disp=' + cs.display + ',vis=' + cs.visibility : '';
      parts.push(selector + '(x' + nodes.length + ') ' + size + ' ' + style);
    }
    return parts.length ? parts.join(' ; ') : '全部候选均未命中';
  }

  /** 距上次「定位失败」诊断日志的时间（限频 2s，避免刷屏） */
  let lastNoPlayerLogAt = 0;

  /** 执行一次矩形采集并上报（供心跳与离屏主动拉取共用） */
  function sendPlayerRectOnce() {
    const rect = readPlayerRect();
    // 同步给遮罩：录制期遮罩据此挖洞（洞 = 画面矩形外扩），保证遮罩压不到被录画面
    const g = guardApi();
    if (g) g.layout(rect);
    if (!rect) {
      const now = Date.now();
      if (now - lastNoPlayerLogAt >= 2000) {
        lastNoPlayerLogAt = now;
        dlog('播放器定位失败（' + location.href.slice(0, 100) + '）：' + probePlayerDomDetail());
      }
    }
    try {
      chrome.runtime.sendMessage({
        type: 'PLAYER_RECT',
        rect,
        dpr: window.devicePixelRatio || 1, // 高分屏换算（离屏实测换算失败时的兜底）
        viewport: readViewportInfo(), // 视口基准：供离屏实测 CSS → 帧像素的换算比例
        hasPlayer: !!rect,
      });
    } catch (err) {
      /* 页面卸载竞态：忽略 */
    }
  }

  function startRectReporter() {
    if (rectTimer) return;
    sendPlayerRectOnce();
    rectTimer = window.setInterval(sendPlayerRectOnce, RECT_INTERVAL_MS);
  }

  function stopRectReporter() {
    if (rectTimer) {
      window.clearInterval(rectTimer);
      rectTimer = null;
    }
  }

  // ===================== 消息接收 =====================

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'YR_PING':
        // popup 就绪探测：能收到即说明本页已注入脚本（配合 manifest 的域名限定 = YouTube 页）
        sendResponse({ ok: true, hasPlayer: !!readPlayerRect() });
        break;
      case 'YR_SELECT_REGION':
        if (window.YRSelector) {
          window.YRSelector.start();
        }
        sendResponse({ ok: true });
        break;
      case 'YR_RECT_ON': {
        captureActive = true;
        const g = guardApi();
        if (g && !customRect) g.enable(); // 录制会话开始：锁定页面交互（仅在非自定义选区模式下启用原生遮罩）
        startRectReporter(); // 首次心跳会立刻把播放器矩形交给遮罩完成布局
        sendResponse({ ok: true });
        break;
      }
      case 'YR_RECT_OFF': {
        captureActive = false;
        stopRectReporter();
        const g = guardApi();
        if (g) g.disable(); // 会话结束（完成 / 失败 / 复位）：移除遮罩并解绑监听
        sendResponse({ ok: true });
        break;
      }
      case 'PLAYER_RECT_REQUEST':
        // 离屏主动拉取（心跳中断自愈）：无论开关状态都补报一次，避免误判「无播放器」
        sendPlayerRectOnce();
        break;
      default:
        break;
    }
    return false; // 全部同步响应，不保持通道
  });

  // ===================== 自定义选区事件 =====================

  window.addEventListener('YR_SET_CUSTOM_RECT', (e) => {
    customRect = e.detail;
    // 选区模式下不使用 guard.js 的聚光灯，因为 selector.js 已经有自己的遮罩了
  });

  window.addEventListener('YR_CLEAR_CUSTOM_RECT', () => {
    customRect = null;
  });

  // ===================== 边界处理 =====================

  // 录制中页面被切到后台（document.hidden）→ 通知离屏，tabCapture 可能降帧或中断
  document.addEventListener('visibilitychange', () => {
    if (!captureActive || !document.hidden) return;
    try {
      chrome.runtime.sendMessage({ type: 'PAGE_HIDDEN' });
    } catch (err) {
      /* ignore */
    }
  });

  // 页面跳转 / 刷新 / 关闭：通知离屏自动停止并导出，避免丢数据
  window.addEventListener('pagehide', () => {
    const g = guardApi();
    if (g) g.disable(); // 页面即将卸载：先撤遮罩，避免节点与监听残留
    if (!captureActive) return;
    try {
      chrome.runtime.sendMessage({ type: 'PAGE_LEAVING' });
    } catch (err) {
      /* ignore */
    }
  });
})();
