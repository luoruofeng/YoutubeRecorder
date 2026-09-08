/**
 * content/countdown.js —— 「开始录制前倒计时」页面浮层
 *
 * 【要解决的问题】
 * 点「开始录制」的那一刻，鼠标往往还压在播放器上、控制条还亮着、或者用户还没来得及
 * 切全屏。倒计时给用户几秒钟把页面调整好，再真正开始捕获。
 *
 * 【为什么浮层绝不会被录进视频】
 * tabCapture 捕获的是整个标签页的合成画面，只要捕获期间页面里还有浮层，它就会被
 * 合成进捕获帧。因此本模块与 guard.js 的遮罩不同 —— 它运行在**捕获开始之前**：
 *   倒计时归零 → 立刻淡出 → 从 DOM 移除 → 再等一小拍 → 才通知 background 开始捕获。
 * 「先撤浮层、后开捕获」是本模块唯一不可动摇的时序（见 finish()）。
 *
 * 【为什么倒计时由页面驱动、而不是由 popup / background 自己数】
 * 弹窗会因失焦关闭、service worker 会被回收，页面浮层与「捕获真正开始」的先后次序
 * 必须由**同一个上下文**保证：只有页面自己能在「浮层确实已从 DOM 移除」之后再发出
 * 开始信号。background 侧仅保留一个兜底定时器，应对页面消息丢失。
 *
 * 【交互】
 * 浮层只是一层很淡的遮罩且**不吃点击**（倒计时正是留给用户「点全屏 / 调播放器」的），
 * 只有中央卡片本身接收点击。取消有两个入口：卡片上的「取消」按钮与 Esc 键；
 * 取消只通知 background 复位，不会开始录制。
 *
 * 【生命周期】
 * background 发 YR_COUNTDOWN_START 启动，YR_COUNTDOWN_CANCEL 取消；
 * 归零后本模块发 YR_COUNTDOWN_DONE 让 background 开始捕获。
 */
(() => {
  'use strict';

  const NS = 'yr-countdown';
  const STYLE_ID = 'yr-countdown-style';
  /** 与遮罩同级：倒计时期间必须盖住页面所有可点元素 */
  const Z_INDEX = '2147483646';

  /** 环形尺寸（px） */
  const SIZE = 132;
  const RADIUS = 58;
  const STROKE = 6;
  /** 圆周长：用于 stroke-dasharray 表现「剩余比例」 */
  const CIRC = 2 * Math.PI * RADIUS;

  /** 归零后的淡出时长（ms） */
  const FADE_MS = 160;
  /**
   * 浮层移除后到「通知 background 开始捕获」之间的安全间隔（ms）。
   * 目的：确保移除已真正生效（并至少绘制一帧干净画面），宁可晚 0.1 秒开始，
   * 也不能让浮层的最后一帧被捕获取到。
   */
  const SAFE_GAP_MS = 120;

  /** 锚点（跟随播放器位置）刷新间隔（ms）：无需每帧重排 */
  const ANCHOR_INTERVAL_MS = 200;

  const TIP = '倒计时结束后自动开始录制';
  const SUB = '这段时间可以切回视频、进入全屏或移开鼠标\n倒计时不会被录进视频';

  const S = {
    active: false, // 是否正在倒计时
    endsAt: 0, // 结束时间戳
    total: 0, // 总时长（ms）
    raf: 0, // requestAnimationFrame id
    lastAnchorAt: 0, // 上次刷新锚点的时间
    lastShown: -1, // 上次显示的数字（变化时才重绘 + 播放动画）
    root: null, // 全屏淡色底
    card: null, // 中央卡片
    num: null, // 中间大数字
    arc: null, // 环形进度（SVG circle）
    host: null, // 挂载宿主（全屏时挂到全屏元素内才会渲染）
    hooked: false, // 是否已绑定 Esc / pagehide
  };

  // ===================== 基础工具 =====================

  function makeEl(tag, css) {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    return el;
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const key of Object.keys(attrs || {})) el.setAttribute(key, attrs[key]);
    return el;
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch (err) {
      /* 扩展上下文失效（升级 / 重载）：忽略 */
    }
  }

  /**
   * 选择挂载宿主。
   * 全屏状态下浏览器只渲染全屏元素的子树，浮层必须挂进该子树才会显示。
   */
  function pickHost() {
    const fs = document.fullscreenElement;
    if (fs && fs !== document.documentElement) {
      // 全屏目标是 <video> 时其子节点不渲染：退回 body（此时倒计时不可见，但仍会走完流程）
      if (fs.tagName === 'VIDEO') return document.body || document.documentElement;
      return fs;
    }
    return document.body || document.documentElement;
  }

  /** 播放器矩形（倒计时卡片锚定在它中央：直观告诉用户「录的是这块」） */
  function anchorRect() {
    // 与 content.js 共用同一份候选列表（shared/sites.js：YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok 合并）
    const selectors =
      window.YRSites && Array.isArray(window.YRSites.PLAYER_SELECTORS) && window.YRSites.PLAYER_SELECTORS.length
        ? window.YRSites.PLAYER_SELECTORS
        : [
            // 兜底：shared/sites.js 未加载时才走到这里，尽量覆盖常见站点 / 通用 video 的容器
            'video.html5-main-video',
            '#movie_player video',
            '.html5-video-container video',
            '#movie_player',
            '#bilibili-player video',
            '.bpx-player-video-wrap video',
            '#player video',
            'video',
          ];
    for (const selector of selectors) {
      let el = null;
      try {
        el = document.querySelector(selector);
      } catch (err) {
        continue;
      }
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 60 && r.height > 60) return r;
    }
    return null;
  }

  // ===================== DOM =====================

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '@keyframes yr-cd-in{from{opacity:0}to{opacity:1}}' +
      '@keyframes yr-cd-card{from{opacity:0;transform:translate(-50%,-50%) scale(.9)}' +
      'to{opacity:1;transform:translate(-50%,-50%) scale(1)}}';
    (document.head || document.documentElement).appendChild(style);
  }

  function removeStyle() {
    const style = document.getElementById(STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }

  function buildDom() {
    if (S.root) return;

    // 底色刻意做得很淡，且不吃点击：倒计时期间用户仍可以点播放器的全屏 / 剧场按钮，
    // 把页面调整到想要的状态（只有卡片本身接收点击，用于「取消」）。
    const root = makeEl(
      'div',
      'position:fixed;left:0;top:0;width:100%;height:100%;z-index:' + Z_INDEX + ';' +
        'background:rgba(8,9,12,.3);pointer-events:none;animation:yr-cd-in .16s ease-out;'
    );
    root.setAttribute('data-yr-countdown', '1');

    const card = makeEl(
      'div',
      'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
        'display:flex;flex-direction:column;align-items:center;gap:2px;' +
        'padding:20px 34px 16px;border-radius:20px;box-sizing:border-box;' +
        'background:rgba(18,18,20,.74);border:1px solid rgba(255,255,255,.14);' +
        'box-shadow:0 18px 48px rgba(0,0,0,.38);backdrop-filter:blur(10px);' +
        'color:#fff;user-select:none;pointer-events:auto;' +
        'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",' +
        'Arial,"PingFang SC","Microsoft YaHei",sans-serif;' +
        'animation:yr-cd-card .18s cubic-bezier(.2,.8,.3,1);'
    );

    // 环形进度：外圈轨道 + 剩余弧（弧长 = 剩余比例，随时间递减）
    const ring = makeEl('div', 'position:relative;width:' + SIZE + 'px;height:' + SIZE + 'px;flex:none;');
    const svg = svgEl('svg', {
      width: SIZE,
      height: SIZE,
      viewBox: '0 0 ' + SIZE + ' ' + SIZE,
      style: 'position:absolute;left:0;top:0;transform:rotate(-90deg);',
    });
    const track = svgEl('circle', {
      cx: SIZE / 2,
      cy: SIZE / 2,
      r: RADIUS,
      fill: 'none',
      stroke: 'rgba(255,255,255,.16)',
      'stroke-width': STROKE,
    });
    const arc = svgEl('circle', {
      cx: SIZE / 2,
      cy: SIZE / 2,
      r: RADIUS,
      fill: 'none',
      stroke: '#ff4b3e',
      'stroke-width': STROKE,
      'stroke-linecap': 'round',
      'stroke-dasharray': String(CIRC),
      'stroke-dashoffset': '0',
      style: 'filter:drop-shadow(0 0 6px rgba(255,75,62,.55));',
    });
    svg.appendChild(track);
    svg.appendChild(arc);

    const num = makeEl(
      'div',
      'position:absolute;left:0;top:0;width:100%;height:100%;display:flex;' +
        'align-items:center;justify-content:center;font-size:52px;font-weight:700;' +
        'font-variant-numeric:tabular-nums;letter-spacing:-1px;color:#fff;' +
        'text-shadow:0 2px 12px rgba(0,0,0,.35);'
    );
    num.textContent = '3';
    ring.appendChild(svg);
    ring.appendChild(num);

    const title = makeEl('div', 'margin-top:12px;font-size:15px;font-weight:600;letter-spacing:.3px;');
    title.textContent = TIP;
    const sub = makeEl(
      'div',
      'margin-top:4px;color:rgba(255,255,255,.6);font-size:12px;text-align:center;white-space:pre-line;'
    );
    sub.textContent = SUB;

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消（Esc）';
    cancel.style.cssText =
      'margin-top:10px;height:30px;padding:0 16px;border:1px solid rgba(255,255,255,.26);' +
      'border-radius:999px;background:transparent;color:rgba(255,255,255,.9);' +
      'font:inherit;font-size:12px;cursor:pointer;transition:background .15s;';
    cancel.addEventListener('mouseenter', () => {
      cancel.style.background = 'rgba(255,255,255,.12)';
    });
    cancel.addEventListener('mouseleave', () => {
      cancel.style.background = 'transparent';
    });
    cancel.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelCountdown(true);
    });

    card.appendChild(ring);
    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(cancel);
    root.appendChild(card);

    S.root = root;
    S.card = card;
    S.num = num;
    S.arc = arc;
  }

  function destroyDom() {
    if (S.root && S.root.parentNode) S.root.parentNode.removeChild(S.root);
    S.root = null;
    S.card = null;
    S.num = null;
    S.arc = null;
    S.host = null;
  }

  /** 把卡片放到播放器中央（定位不到播放器时退回视口中央），并夹进视口不出屏 */
  function place(force) {
    if (!S.card) return;
    const now = Date.now();
    if (!force && now - S.lastAnchorAt < ANCHOR_INTERVAL_MS) return;
    S.lastAnchorAt = now;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const r = anchorRect();
    const cx = r ? r.left + r.width / 2 : vw / 2;
    const cy = r ? r.top + r.height / 2 : vh / 2;
    const halfW = Math.min(160, vw / 2);
    const halfH = Math.min(150, vh / 2);
    S.card.style.left = Math.round(Math.max(halfW, Math.min(vw - halfW, cx))) + 'px';
    S.card.style.top = Math.round(Math.max(halfH, Math.min(vh - halfH, cy))) + 'px';
  }

  // ===================== 计时 =====================

  /** 数字变化时的轻微缩放动画（Web Animations API，无依赖） */
  function popNumber() {
    if (!S.num || typeof S.num.animate !== 'function') return;
    try {
      S.num.animate(
        [
          { transform: 'scale(1.14)', opacity: 0.55 },
          { transform: 'scale(1)', opacity: 1 },
        ],
        { duration: 300, easing: 'cubic-bezier(.2,.8,.3,1)' }
      );
    } catch (err) {
      /* 不支持动画：忽略 */
    }
  }

  function tick() {
    if (!S.active) return;
    const remain = S.endsAt - Date.now();
    if (remain <= 0) {
      finish();
      return;
    }
    const ratio = Math.max(0, Math.min(1, remain / S.total));
    if (S.arc) S.arc.style.strokeDashoffset = String(CIRC * (1 - ratio));
    const shown = Math.max(1, Math.ceil(remain / 1000));
    if (shown !== S.lastShown) {
      S.lastShown = shown;
      if (S.num) S.num.textContent = String(shown);
      popNumber();
    }
    place(false);
    S.raf = window.requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (S.raf) window.cancelAnimationFrame(S.raf);
    S.raf = 0;
  }

  function onKeyDown(e) {
    if (!S.active) return;
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancelCountdown(true);
  }

  function onPageHide() {
    // 页面卸载：直接清理，不再回报（background 有兜底定时器）
    if (!S.active) return;
    S.active = false;
    stopLoop();
    destroyDom();
    removeStyle();
  }

  function hook() {
    if (S.hooked) return;
    S.hooked = true;
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pagehide', onPageHide, true);
  }

  function unhook() {
    if (!S.hooked) return;
    S.hooked = false;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('pagehide', onPageHide, true);
  }

  // ===================== 对外流程 =====================

  /** 开始倒计时 */
  function start(seconds) {
    const total = Math.max(1, Math.round(Number(seconds) || 0) * 1000);
    // 已在倒计时（重复触发）：静默复位后重新开始，避免叠加两个浮层
    if (S.active) {
      S.active = false;
      stopLoop();
      destroyDom();
    }
    S.total = total;
    S.endsAt = Date.now() + total;
    S.lastShown = -1;
    S.lastAnchorAt = 0;
    S.active = true;
    ensureStyle();
    buildDom();
    hook();
    const host = pickHost();
    if (S.root && S.root.parentNode !== host) host.appendChild(S.root);
    S.host = host;
    place(true);
    tick();
    return true;
  }

  /**
   * 归零 → 真正开始录制前的收尾。
   * 顺序不可调换：淡出 → 移除 DOM → 等 SAFE_GAP_MS → 才通知 background 开始捕获。
   */
  function finish() {
    if (!S.active) return;
    S.active = false;
    stopLoop();
    unhook();
    const root = S.root;
    if (root) {
      root.style.transition = 'opacity ' + FADE_MS + 'ms ease-out';
      root.style.opacity = '0';
    }
    window.setTimeout(() => {
      destroyDom();
      removeStyle();
    }, FADE_MS);
    window.setTimeout(() => send({ type: 'YR_COUNTDOWN_DONE' }), FADE_MS + SAFE_GAP_MS);
  }

  /** 取消倒计时（notify=true 时回报 background，让其复位状态） */
  function cancelCountdown(notify) {
    if (!S.active) return;
    S.active = false;
    stopLoop();
    unhook();
    const root = S.root;
    if (root) {
      root.style.transition = 'opacity 120ms ease-out';
      root.style.opacity = '0';
    }
    window.setTimeout(() => {
      destroyDom();
      removeStyle();
    }, 120);
    if (notify) send({ type: 'YR_COUNTDOWN_CANCEL' });
  }

  // ===================== 消息接收 =====================

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'YR_COUNTDOWN_START') {
      const ok = start(message.seconds);
      if (typeof sendResponse === 'function') sendResponse({ ok });
    } else if (message.type === 'YR_COUNTDOWN_CANCEL') {
      // background 侧取消（弹窗点取消 / 快捷键再按一次）：不再回报，避免回环
      cancelCountdown(false);
      if (typeof sendResponse === 'function') sendResponse({ ok: true });
    }
    return false;
  });

  // 全屏切换后宿主可能变化，需要重新挂载（倒计时途中进入 / 退出全屏）
  document.addEventListener('fullscreenchange', () => {
    if (!S.active || !S.root) return;
    const host = pickHost();
    if (host && S.root.parentNode !== host) {
      host.appendChild(S.root);
      S.host = host;
    }
    place(true);
  });

  window.YRCountdownUI = {
    start,
    cancel: cancelCountdown,
    isActive: () => S.active,
  };
})();
