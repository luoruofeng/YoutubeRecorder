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
 * 5. 随录制会话开关「页面交互锁定遮罩」（YR_RECT_ON / YR_RECT_OFF）；
 * 6. 会话期间挂载 beforeunload：浏览器层发起的离开（点书签 / 地址栏跳转 /
 *    刷新 / 关闭标签页）页面内拦不住，只有它能先弹确认框，防止误离开丢录制。
 *
 * 受 background 通过 YR_RECT_ON / YR_RECT_OFF 控制心跳与离开确认开关，空闲时零开销。
 */
(() => {
  'use strict';

  /** 是否需要上报播放器矩形（由 background 在录制会话开始 / 结束时切换） */
  let captureActive = false;

  /** 录制期间挂载的 beforeunload「离开确认」监听是否已注册（防重复 add / remove） */
  let leaveGuardBound = false;

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

  /** 站点识别库（shared/sites.js）：提供各站点（YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok）的播放器候选列表 */
  const YRSITE_LIB = window.YRSites || null;

  /**
   * 播放器候选定位器：按优先级依次探测。
   * 候选列表由 shared/sites.js 统一维护（YouTube / Bilibili / Dailymotion / Vimeo / Instagram /
   * Facebook / TikTok 各自的新旧布局 / 容器选择器 + 通用兜底），命中即返回首个真实可见（尺寸 ≥ 4px）的元素矩形。
   * 站点间选择器天然互不命中，只在 shared/sites.js 缺失时退回下方仅含 YouTube 的兜底。
   */
  const PLAYER_SELECTORS =
    YRSITE_LIB && Array.isArray(YRSITE_LIB.PLAYER_SELECTORS) && YRSITE_LIB.PLAYER_SELECTORS.length
      ? YRSITE_LIB.PLAYER_SELECTORS
      : [
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

  /**
   * 容器级兜底候选（仅当 PLAYER_SELECTORS 全部 miss 时尝试）：
   * 命中元素不要求内部包含 <video>，直接使用容器矩形作为录制区矩形。
   * 主要服务 Dailymotion 与 Vimeo：两者通常把真实 <video> 渲染进主文档（可被上面
   * 的 video 候选命中）；但个别页面 / 改版后 <video> 可能在跨域 iframe 或 shadow DOM
   * 里（content script 受同源策略读不到），此时退而取主文档中矩形一致的播放器外壳
   * （Dailymotion：#player-wrapper / Player__player / TopPlayer__placeholder 等；
   * Vimeo：.vp-player-layout / .vp-player / .vp-video 等）作为录制区；
   * 其他站点容器往往内嵌其它 UI，不纳入此列表。
   */
  const PLAYER_CONTAINER_SELECTORS =
    YRSITE_LIB && Array.isArray(YRSITE_LIB.CONTAINER_SELECTORS) ? YRSITE_LIB.CONTAINER_SELECTORS : [];

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

  /** 递归收集某根节点（含其 open shadow root 子树）内全部 <video>；异常时只返回普通层 */
  function collectVideos(root, out) {
    const list = out || [];
    try {
      const own = root.querySelectorAll('video');
      for (const v of own) list.push(v);
      // 部分播放器把 <video> 封装进自定义元素 / open shadow root（如 DM neon player、
      // 各种 Web Component 播放器），querySelectorAll 默认不进 shadow 内部，这里补扫
      const hosts = root.querySelectorAll('*');
      for (const host of hosts) {
        const sr = host.shadowRoot; // open shadow root 才能读
        if (sr) collectVideos(sr, list);
      }
    } catch (err) {
      /* 个别节点异常不阻断 */
    }
    return list;
  }

  /**
   * 扫描页面上所有 <video>（含 open shadow root 内），返回可见面积最大的那个
   * （用于裸 `video` 通用兜底）。
   * 要求：真实可见（尺寸 ≥ 4px）且已解码出片源（videoWidth/Height > 0，避免把
   * 加载中 / 空壳的 video 当候选）。主播放器通常占页面最大矩形，因此该启发式在
   * YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok 等有多个 video 的页面上都能命中正在播放的主视频。
   * 找不到可见 video 时返回 null（调用方继续探测其它候选）。
   */
  function largestVisibleVideo() {
    let videos = [];
    try {
      videos = collectVideos(document, []);
    } catch (err) {
      videos = [];
    }
    let best = null;
    let bestArea = 0;
    for (const v of videos) {
      // 片源未就绪的 video 一律跳过：paintedRect 会返回 null，选中了也没用
      if (!v.videoWidth || !v.videoHeight) continue;
      let r = null;
      try {
        r = v.getBoundingClientRect();
      } catch (err) {
        continue;
      }
      if (!r || r.width < 4 || r.height < 4) continue;
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
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
      // 裸 `video` 通用兜底：页面上可能存在多个 <video>（推荐位小窗 / 迷你播放器 /
      // 广告等），document.querySelector 会命中 DOM 顺序的第一个，可能是小窗而非主
      // 播放器。因此对裸 `video` 做特判 —— 扫描全部 video，取可见面积最大的那个
      // （主播放器通常占页面最大区域）。该分支对所有站点生效，仅在前置站点选择器
      // 全部 miss 时兜底，命中成本与 querySelector 相同量级。
      if (selector === 'video') {
        el = largestVisibleVideo();
      } else {
        try {
          el = document.querySelector(selector);
        } catch (err) {
          continue; // 个别选择器异常不阻断后续候选
        }
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
    // ============= 容器级候选兜底 =============
    // PLAYER_SELECTORS 全部 miss 时尝试（主要服务 Dailymotion 与 Vimeo：真实 <video>
    // 在跨域 iframe / shadow DOM，主文档读不到；用外壳容器矩形作为录制区）。
    // 其他站点不在此列表里。
    for (const selector of PLAYER_CONTAINER_SELECTORS) {
      let el = null;
      try {
        el = document.querySelector(selector);
      } catch (err) {
        continue;
      }
      if (!el) continue;
      // 容器内若有 <video> 仍优先使用（比容器矩形更准；paintedRect 会按 object-fit 换算）
      let target = el;
      if (target.tagName !== 'VIDEO') {
        let inner = null;
        try {
          inner = target.querySelector('video');
        } catch (err) {
          inner = null;
        }
        if (inner && inner.tagName === 'VIDEO') target = inner;
      }
      const rect = target.getBoundingClientRect();
      // 真实可见尺寸才纳入（与 PLAYER_SELECTORS 同标准）
      if (rect.width < 4 || rect.height < 4) continue;
      const painted = paintedRect(target, rect); // 非 VIDEO 直接返回 plain
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
        visible: clipped.visible,
        fullWidth: clipped.fullWidth,
        fullHeight: clipped.fullHeight,
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        fit,
        srcW: target.videoWidth || 0,
        srcH: target.videoHeight || 0,
        via: selector + '@container',
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

  // ===================== 录制期「离开确认」（beforeunload） =====================
  //
  // guard.js 的遮罩只拦得住「页面内」的点击 / 滚动 / 键盘：用户从浏览器层离开
  // （地址栏输入新网址、点击书签、刷新、关闭标签页）完全不经过页面 DOM，页面内
  // 任何遮罩都拦不住 —— 这是录制数据被误丢弃的最后一种路径。
  //
  // 唯一能让浏览器先弹确认框的标准手段是 beforeunload：会话期间注册后，任何会
  // 卸载当前页面的导航都会先出现浏览器原生确认框（含「留下」选项），用户取消即
  // 留在页面继续录制。
  //
  // 限制：出于反滥用考虑，现代浏览器（Chrome / Firefox / Safari）一律忽略开发者
  // 设置的自定义文案，只显示各自的系统通用提示（Chrome 通常为「离开网站？」并带
  // 「取消」按钮）。因此这里不（也无法）自定义「正在录制」的文案；录制期遮罩提示
  // （guard.js 的 TIP_DETAIL）已提前告知用户该行为。
  function onLeaveConfirm(event) {
    // 同步调用 preventDefault 并写 returnValue 是触发浏览器确认框的规范做法；
    // returnValue 的字符串在现代浏览器中会被忽略，仅为兼容仍读取它的旧内核。
    event.preventDefault();
    try {
      event.returnValue = '';
    } catch (err) {
      /* ignore */
    }
  }

  /** 录制会话开始 / 结束：随会话挂载 / 移除 beforeunload 离开确认 */
  function setLeaveGuard(on) {
    if (!!on === leaveGuardBound) return;
    leaveGuardBound = !!on;
    try {
      if (leaveGuardBound) window.addEventListener('beforeunload', onLeaveConfirm);
      else window.removeEventListener('beforeunload', onLeaveConfirm);
    } catch (err) {
      /* 页面环境异常：离开确认降级（不影响录制主流程） */
    }
  }

  // ===================== 消息接收 =====================

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'YR_PING': {
        // popup 就绪探测：能收到即说明本页已注入脚本（配合 manifest 的域名限定 =
        // YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok 播放页）；site 供 popup 展示站点与 background 生成文件名
        const currentSite =
          YRSITE_LIB && typeof YRSITE_LIB.detectCurrent === 'function' ? YRSITE_LIB.detectCurrent() : null;
        sendResponse({ ok: true, hasPlayer: !!readPlayerRect(), site: currentSite ? currentSite.id : '' });
        break;
      }
      case 'YR_SELECT_REGION':
        if (window.YRSelector) {
          window.YRSelector.start();
        }
        sendResponse({ ok: true });
        break;
      case 'YR_RECT_ON': {
        captureActive = true;
        setLeaveGuard(true); // 会话开始：离开页面（书签 / 刷新 / 关标签页）前先弹浏览器确认框
        const g = guardApi();
        if (g && !customRect) g.enable(); // 录制会话开始：锁定页面交互（仅在非自定义选区模式下启用原生遮罩）
        startRectReporter(); // 首次心跳会立刻把播放器矩形交给遮罩完成布局
        sendResponse({ ok: true });
        break;
      }
      case 'YR_RECT_OFF': {
        captureActive = false;
        stopRectReporter();
        setLeaveGuard(false); // 会话结束（完成 / 失败 / 复位）：解除离开确认，页面恢复可自由导航
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
