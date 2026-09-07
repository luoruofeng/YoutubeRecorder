/**
 * content/pip.js —— 全屏录制「置顶状态窗」（Document Picture-in-Picture）
 *
 * 【要解决的问题】
 * YouTube 的 HTML 全屏只渲染全屏子树的画面，录制期锁定遮罩（guard.js）挖洞后，
 * 洞 = 被录画面 = 整屏，遮罩与提示文案没有任何可显示的空间 → 用户在全屏时看不到
 * 任何「是否在录制」的标识。而任何画在画面之内的标识都会随 tabCapture 一起被录进视频。
 *
 * 【为什么用 Document PiP】
 * Document PiP 窗口是浏览器层面的独立置顶小窗（Chrome 116+，与标签页平级）：
 * 1. 它不属于被捕获标签页的渲染内容 → 绝不会出现在视频里（与 popup 同性质，但无需
 *    标签页失去全屏焦点，天然浮在全屏之上，用户随时看得见）；
 * 2. 窗口里直接放「REC 红点 + 计时 + 停止并保存」按钮，顺带解决全屏下「怎么停」；
 * 3. 只在全屏时打开，非全屏时页面内有遮罩提示，不额外打扰。
 *
 * 【为什么打开时机由快捷键驱动】
 * `documentPictureInPicture.requestWindow()` 需要瞬态用户激活。全屏场景只能用页面
 * 快捷键（content/hotkey.js 的 keydown）开始录制 → 本次按键天然携带激活。
 * popup 点击开始录制时用户不在全屏（点扩展图标需要工具栏可见），页面内提示已足够。
 * 因此本模块暴露 `openIfFullscreen()`，由 hotkey.js 在按下快捷键时同步调用。
 *
 * 【状态同步】
 * background 在每次录制 phase 变化时向录制标签页广播 YR_PIP_STATE
 * { phase, startedAt, durationMs }，本模块据此更新小窗文案与计时。
 *
 * 【生命周期】
 * 录制结束（idle / exported / error）自动关闭小窗；用户也可手动关闭小窗
 * （仅当次会话不再自动重开，快捷键停止仍有效）。
 */
(() => {
  'use strict';

  const WINDOW_W = 320;
  const WINDOW_H = 132;

  /** 小窗配置缓存（yrIndPip，默认开） */
  const cfg = { pip: true };

  /** 运行态 */
  const S = {
    pipWindow: null, // 打开的 PiP 窗口（null = 未开）
    opening: false, // 打开请求进行中（防并发）
    phase: 'idle', // 最近同步的录制 phase
    startedAt: 0, // 录制开始时间戳（进入 recording 的时刻）
    durationMs: 0, // 最近一次录制时长
    els: null, // 小窗内元素（dot / title / timer / stop / tip）
    tickTimer: null, // 计时刷新定时器
    closeTimer: null, // 结束后的延迟关闭
  };

  // ===================== 基础工具 =====================

  function setCfg(value) {
    cfg.pip = !value || value.pip !== false;
  }

  function readCfg() {
    const api = window.YRIndicator;
    if (!api || typeof api.read !== 'function') return;
    api.read().then(setCfg);
  }

  /** mm:ss / hh:mm:ss（>=1 小时时带小时位） */
  function formatClock(totalSec) {
    const t = Math.max(0, totalSec);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? String(h).padStart(2, '0') + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function make(tag, css, text) {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (text != null) el.textContent = text;
    return el;
  }

  // ===================== 小窗 DOM =====================

  function buildDom(win) {
    const doc = win.document;
    const body = doc.body;
    body.style.cssText =
      'margin:0;overflow:hidden;background:rgba(10,10,12,.92);color:#fff;' +
      'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,' +
      '"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;';
    doc.title = '正在录制 · YouTube Recorder';

    const row = make(
      'div',
      'display:flex;align-items:center;gap:8px;padding:10px 12px 0;box-sizing:border-box;'
    );
    const dot = make('span', 'flex:none;width:10px;height:10px;border-radius:50%;' + 'background:#ff4b3e;');
    const title = make('span', 'font-size:13px;font-weight:600;white-space:nowrap;', '正在录制');
    const timer = make(
      'span',
      'margin-left:auto;font-size:14px;font-variant-numeric:tabular-nums;' +
        'color:rgba(255,255,255,.88);white-space:nowrap;',
      '00:00'
    );
    row.appendChild(dot);
    row.appendChild(title);
    row.appendChild(timer);

    const tip = make(
      'div',
      'padding:2px 12px 0;box-sizing:border-box;color:rgba(255,255,255,.55);' +
        'font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      '本窗口不会进入视频 · 停止后自动保存到下载目录'
    );

    const stop = make(
      'button',
      'display:block;width:calc(100% - 24px);margin:8px 12px 10px;height:34px;border:none;' +
        'border-radius:8px;background:#e62117;color:#fff;font:inherit;font-size:13px;' +
        'font-weight:600;cursor:pointer;',
      '停止并保存'
    );
    stop.type = 'button';
    stop.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'YR_STOP' }, () => void chrome.runtime.lastError);
      } catch (err) {
        /* 扩展上下文失效：忽略 */
      }
    });

    body.appendChild(row);
    body.appendChild(tip);
    body.appendChild(stop);
    S.els = { dot, title, timer, tip, stop };
  }

  // ===================== 渲染 =====================

  function applyUi() {
    if (!S.pipWindow || !S.els) return;
    const els = S.els;
    const phase = S.phase;
    const recording = phase === 'recording';

    if (phase === 'preparing' || phase === 'capturing') {
      els.title.textContent = '正在启动录制…';
      els.timer.textContent = '';
      els.stop.disabled = true;
      els.dot.style.background = '#ffb020';
      els.tip.textContent = '画面稳定后将开始计时';
    } else if (recording) {
      els.title.textContent = '正在录制';
      els.stop.disabled = false;
      els.dot.style.background = '#ff4b3e';
      els.tip.textContent = '本窗口不会进入视频 · 停止后自动保存到下载目录';
    } else if (phase === 'stopping' || phase === 'exported') {
      els.title.textContent = '正在保存视频…';
      els.stop.disabled = true;
      els.dot.style.background = '#1a73e8';
      els.tip.textContent = '请稍候，请勿关闭页面';
    } else {
      // idle / error：短暂展示后关闭
      els.title.textContent = phase === 'error' ? '录制已中止' : '录制已结束';
      els.stop.disabled = true;
      els.dot.style.background = phase === 'error' ? '#e62117' : '#2e7d32';
      scheduleClose(1200);
      return;
    }

    // 录制中每 500ms 刷新一次计时；其它态展示最近时长
    if (recording) {
      startTick();
    } else {
      stopTick();
      els.timer.textContent = S.durationMs > 0 ? formatClock(Math.round(S.durationMs / 1000)) : '';
    }
  }

  function setState(state) {
    if (!state) return;
    S.phase = state.phase || S.phase;
    if (typeof state.startedAt === 'number') S.startedAt = state.startedAt;
    if (typeof state.durationMs === 'number') S.durationMs = state.durationMs;
    if (S.pipWindow) applyUi();
  }

  function startTick() {
    if (S.tickTimer) return;
    S.tickTimer = window.setInterval(() => {
      if (!S.pipWindow || !S.els) return;
      const secs = S.startedAt > 0 ? Math.floor((Date.now() - S.startedAt) / 1000) : 0;
      S.els.timer.textContent = formatClock(secs);
      // 呼吸效果由红点透明度模拟（PiP 文档无动画关键帧依赖，用 JS 更稳）
      S.els.dot.style.opacity = S.els.dot.style.opacity === '0.35' ? '1' : '0.35';
    }, 500);
  }

  function stopTick() {
    if (S.tickTimer) {
      window.clearInterval(S.tickTimer);
      S.tickTimer = null;
    }
  }

  function scheduleClose(delay) {
    if (S.closeTimer) window.clearTimeout(S.closeTimer);
    S.closeTimer = window.setTimeout(() => {
      S.closeTimer = null;
      closePip();
    }, delay || 800);
  }

  // ===================== 打开 / 关闭 =====================

  function onOpenFailed() {
    S.opening = false;
    S.pipWindow = null;
  }

  function onOpened(win) {
    S.opening = false;
    if (!win) {
      S.pipWindow = null;
      return;
    }
    S.pipWindow = win;
    buildDom(win);
    win.addEventListener('pagehide', onPipClosed, { once: true });
    applyUi();
  }

  function onPipClosed() {
    stopTick();
    if (S.closeTimer) {
      window.clearTimeout(S.closeTimer);
      S.closeTimer = null;
    }
    S.pipWindow = null;
    S.els = null;
  }

  function closePip() {
    const win = S.pipWindow;
    if (!win) return;
    try {
      win.close();
    } catch (err) {
      /* 窗口可能已被外部关闭：忽略 */
    }
    onPipClosed();
  }

  function openIfFullscreen() {
    // 小窗已开 / 正在开 / 配置关闭 → 跳过
    if (S.pipWindow || S.opening || !cfg.pip) return;
    // 仅 HTML 全屏场景需要（非全屏时页面内有遮罩提示）
    if (!document.fullscreenElement) return;
    // 录制中再按快捷键 = 停止，此时不要重新弹窗（小窗要么已开、要么用户主动关了）
    if (S.phase === 'recording' || S.phase === 'stopping') return;
    const dpip = window.documentPictureInPicture;
    if (!dpip || typeof dpip.requestWindow !== 'function') return;
    // requestWindow 需要瞬态用户激活（快捷键 keydown 链路内调用时满足）
    if (navigator.userActivation && !navigator.userActivation.isActive) return;

    S.opening = true;
    S.phase = 'preparing';
    try {
      const winPromise = dpip.requestWindow({ width: WINDOW_W, height: WINDOW_H });
      if (winPromise && typeof winPromise.then === 'function') {
        winPromise.then(onOpened, onOpenFailed);
      } else {
        onOpenFailed();
      }
    } catch (err) {
      onOpenFailed();
    }
  }

  // ===================== 消息接收 =====================

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'YR_PIP_STATE') {
      setState(message); // background 广播录制 phase 变化
    } else if (message.type === 'YR_PIP_CFG') {
      // 设置弹窗里关掉「置顶状态窗」→ 立即关闭已开的小窗
      if (message && typeof message.enabled === 'boolean') cfg.pip = message.enabled;
      if (!cfg.pip) closePip();
    }
    return false;
  });

  // ===================== 边界处理 =====================

  // 全屏中途退出（正常路径下录制中被 guard 禁止，这里只做兜底）：非全屏时遮罩提示可见，
  // 小窗不再需要，主动关闭，避免悬浮窗口残留。
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && S.pipWindow && S.phase === 'recording') closePip();
  });

  // 页面跳转 / 刷新：PiP 窗口会随 opener 销毁，这里仅清理内部引用与定时器
  window.addEventListener('pagehide', () => {
    stopTick();
    if (S.closeTimer) {
      window.clearTimeout(S.closeTimer);
      S.closeTimer = null;
    }
    S.pipWindow = null;
    S.els = null;
  });

  // ===================== 初始化 =====================

  readCfg();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const api = window.YRIndicator;
      if (!api) return;
      const change = changes[api.KEYS.pip];
      if (!change) return;
      setCfg({ pip: change.newValue });
      if (!cfg.pip) closePip();
    });
  } catch (err) {
    /* storage 不可用则维持当前配置 */
  }

  window.YRPip = {
    openIfFullscreen,
    close: closePip,
    isOpen: () => !!S.pipWindow,
  };
})();
