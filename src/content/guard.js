/**
 * content/guard.js —— 录制期「页面交互锁定遮罩」（聚光灯式挖洞）
 *
 * 【要解决的问题】
 * tabCapture 捕获的是整个标签页的合成画面，离屏再按 content 上报的「播放器真实画面
 * 矩形」裁剪，且录制开始后画布尺寸被锁定。录制期间一旦滚动页面、缩放窗口或点到页面
 * 上的链接 / 按钮：滚动与缩放会让裁剪区错位（画面拉伸 / 录进网页内容），点击链接会
 * 触发页面跳转，严重时录制中断、视频来不及保存。
 *
 * 【为什么不把播放器「抬到」遮罩之上】
 * YouTube 播放器嵌在多层 stacking context 中（body → ytd-app → ytd-page-manager →
 * ytd-watch-flexy → ytd-player → #movie_player …），要把播放器抬到遮罩之上必须逐层
 * 改写祖先的 position / z-index，既侵入页面布局（布局一变，被录画面也跟着变），
 * 又会在 YouTube 改版时失效。
 * 更稳的做法是反过来：遮罩铺满视口，只在播放器画面处「挖洞」（spotlight）。
 *
 * 【为什么遮罩不会被录进视频】
 * 洞 = content 上报的画面矩形「外扩」HOLE_MARGIN_BASE（并叠加用户在弹窗中设置的
 * 画面微调偏移的绝对值），因此遮罩像素永远落在裁剪区之外。
 *
 * 【为什么洞内不再盖拦截层 —— 视频与播放器控件要能点】
 * 早期实现在洞内盖了一层全透明拦截层，本意是「不让用户点到播放器」，但它把
 * 播放 / 暂停、进度条、音量这些**纯播放控制**也一起挡住了 —— 录制期间用户应当
 * 可以正常操作视频本身（这类操作只改变播放状态，不改变播放器布局，也不影响裁剪）。
 * 因此洞内改为**完全留空**：遮罩根节点 `pointer-events: none`，洞内没有任何扩展节点，
 * 点击与悬停自然穿透到 YouTube 播放器；只有洞外的四块遮罩 `pointer-events: auto`
 * 吃掉页面元素的点击。
 *
 * 【哪些播放器操作仍然要拦】
 * 只拦两类会真正破坏本次录制的操作（键鼠一致）：
 * 1. 改变播放器布局：全屏 `f`、剧场 `t`、迷你播放器 `i`、全屏下的 `Esc`、双击画面 ——
 *    录制开始后画布尺寸已锁定，布局一变裁剪区即错位（画面拉伸 / 录进网页内容）；
 * 2. 让音轨无声：静音 `m` —— tabCapture 捕获的是标签页音频，静音后录制结果就是无声视频。
 * 其余（播放暂停 `k`、快退快进 `j`/`l`、数字键跳转、字幕 `c`、音量、倍速、进度拖动）全部放行。
 *
 * 【为什么光有遮罩还不够】
 * 遮罩挡得住鼠标，挡不住滚轮 / 触摸滑动 / 键盘翻页 / 中键自动滚动，因此额外拦截
 * wheel / touchmove / 滚动键 / YouTube 播放器快捷键，并把页面滚动位置锁定在
 * 录制会话开始那一刻。
 *
 * 【窗口缩放】
 * 浏览器窗口尺寸由操作系统控制，网页无法禁止。这里的对策是：检测到视口尺寸变化后
 * 立即在遮罩上亮出告警，并广播一条 UI_ACTION 提示到弹窗，建议用户停止后重新录制。
 *
 * 【生命周期】
 * 由 content.js 在 YR_RECT_ON（录制会话开始）/ YR_RECT_OFF（会话结束、失败、复位）
 * 时开关；结束后移除全部 DOM 与监听，页面恢复原状。仅在录制会话期间存在。
 */
(() => {
  'use strict';

  /** 元素 class / id 前缀（与其它扩展代码一致，避免与 YouTube 样式冲突） */
  const NS = 'yr-guard';
  const STYLE_ID = 'yr-guard-style';
  /** 遮罩层级：远高于 YouTube 自有 UI（其最高约数千） */
  const Z_INDEX = '2147483646';
  /** 遮罩颜色：黑色半透明 */
  const DIM_BG = 'rgba(6, 6, 6, 0.66)';
  /** 洞相对「播放器真实画面矩形」的基础外扩像素：容忍裁剪换算 1~2px 抖动 */
  const HOLE_MARGIN_BASE = 10;

  /**
   * 全屏黑边安全区红框（录制状态指示）。
   * 全屏时若画面未铺满（letterbox，例如 4:3 / 21:9 / 竖屏片源），黑边不属被录区域，
   * 此时可在黑边内画一条红色边框提示「正在录制」，绝不被录进视频。
   * RING_GAP 保证红框离画面矩形留足距离：即便裁剪换算有 1~2px 抖动也不会切到红框。
   */
  const RING_GAP = 12; // 红框与画面矩形边缘之间的空隙（px）
  const RING_WIDTH = 4; // 红框线宽（px）
  /** 画面某侧的黑边至少需要留出这么多空间才画框（否则宁可不画） */
  const RING_MIN_SPACE = RING_GAP + RING_WIDTH + 2;
  /** 红框颜色 */
  const RING_COLOR = '#ff4438';

  const TIP_TITLE = '录制中 · 页面已锁定';
  /**
   * 提示副文案。{HK} 会被替换成用户配置的快捷键提示（未启用时为空串）。
   * 该提示位于遮罩上（洞外），不会被录进视频。
   */
  const TIP_DETAIL =
    '视频播放控制（播放 / 暂停、进度、音量、字幕、倍速）可正常操作；\n' +
    '请勿滚动页面、缩放窗口，也不要点击视频以外的按钮或链接。\n' +
    '需要结束时，请{HK}点击浏览器工具栏中的扩展图标 →「停止并保存」。\n' +
    '如需离开本页（点书签 / 地址栏跳转 / 刷新 / 关闭），浏览器会先弹出确认框。';
  /** 提示框内「停止并保存」按钮文案（点击即走与快捷键一致的停止链路） */
  const TIP_STOP_TEXT = '停止并保存视频';
  /** 按钮被点击后、遮罩随会话结束移除前的短暂状态文案 */
  const TIP_STOPPING_TEXT = '正在停止…';
  const TIP_RESIZE = '检测到窗口尺寸变化，画面裁剪可能偏移，建议停止后重新录制。';
  const RESIZE_NOTICE =
    '录制中检测到窗口尺寸变化：画面裁剪可能偏移（录制开始后画布尺寸已锁定）。建议点击扩展图标「停止并保存」后重新录制。';
  const CONTROL_BLOCK_NOTICE =
    '录制中已阻止该操作：切换全屏 / 剧场 / 迷你播放器会让画面裁剪错位，静音会让录制音轨无声。';

  /**
   * 需拦截的滚动 / 翻页按键。
   * 左 / 右方向键不在此列：它们在播放器上是「快退 / 快进 5 秒」，属正常视频操作
   * （页面横向滚动已由 scroll 兜底拉回，不会被它们带偏）。
   * 空格同样拦截：焦点若落在页面按钮上，空格会触发该按钮的点击。
   */
  const SCROLL_KEYS = [' ', 'Spacebar', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'];

  /**
   * 需拦截的 YouTube 播放器快捷键（只留「会破坏录制」的两类）：
   * f 全屏 / t 剧场 / i 迷你播放器 —— 改变播放器布局，而录制开始后画布尺寸已锁定；
   * m 静音 —— 会让捕获到的音轨无声。
   * 其余播放控制（k 播放暂停 / j、l 快退快进 / 数字键跳转 / c 字幕）一律放行。
   */
  const BLOCKED_PLAYER_KEYS = ['f', 't', 'i', 'm'];

  /**
   * 允许点击播放器后仍需拦截的控件（与上面的快捷键一一对应）：
   * 全屏 / 迷你播放器 / 剧场模式会改变布局；静音会让录制的音轨无声。
   * YouTube 走稳定类名 + aria-keyshortcuts 兜底；Bilibili 同时覆盖旧版
   * （.bilibili-player-*）与新版 bpx（.bpx-player-*）播放器的全屏 / 静音按钮，
   * 并以 #bilibili-player 作用域内的 aria-label / title 中文文案作为改版兜底。
   */
  const BLOCKED_CONTROLS_SELECTOR = [
    // ---------- YouTube ----------
    '.ytp-fullscreen-button',
    '.ytp-miniplayer-button',
    '.ytp-size-button',
    '.ytp-mute-button',
    '[aria-keyshortcuts="f"]',
    '[aria-keyshortcuts="t"]',
    '[aria-keyshortcuts="i"]',
    '[aria-keyshortcuts="m"]',
    // ---------- Bilibili（bpx 新版播放器） ----------
    '.bpx-player-ctrl-full',
    '.bpx-player-ctrl-web-full',
    '.bpx-player-ctrl-widescreen', // 宽屏 / 影院模式会改变播放器布局（等同剧场模式 t）
    '.bpx-player-ctrl-mute',
    // ---------- Bilibili（旧版播放器） ----------
    '.bilibili-player-icon-fullscreen',
    '.bilibili-player-icon-statefullscreen',
    '.bilibili-player-icon-web-fullscreen',
    '.bilibili-player-icon-fixfullscreen',
    '.bilibili-player-video-btn-fullscreen',
    '.bilibili-player-icon-widescreen',
    '.bilibili-player-icon-mute',
    // ---------- Bilibili 中文文案兜底（限定播放器作用域内） ----------
    '#bilibili-player [aria-label*="全屏"]',
    '#bilibili-player [aria-label*="宽屏"]',
    '#bilibili-player [aria-label*="静音"]',
    '#bilibili-player [title*="全屏"]',
    '#bilibili-player [title*="宽屏"]',
    '#bilibili-player [title*="静音"]',
  ].join(',');

  /** 被拦控件的提示限频（ms）：连点时不刷屏 */
  const BLOCK_NOTICE_INTERVAL_MS = 3000;

  /** 遮罩运行时状态 */
  const S = {
    enabled: false, // 是否处于录制会话中（由 content.js 开关）
    root: null, // 遮罩根节点（pointer-events: none，洞内留空 → 播放器可点）
    veils: null, // 四块半透明遮罩（上 / 下 / 左 / 右，pointer-events: auto 吃掉洞外点击）
    tip: null, // 提示文案容器
    tipDetail: null, // 提示副文案（空间不足时隐藏）
    tipWarn: null, // 尺寸变化告警行
    host: null, // 当前挂载宿主（全屏时需挂到全屏元素内才会渲染）
    rect: null, // 最近一次播放器画面矩形（CSS 像素，视口坐标）
    marginX: HOLE_MARGIN_BASE, // 洞的水平外扩（含用户校准偏移）
    marginY: HOLE_MARGIN_BASE, // 洞的垂直外扩
    lockX: 0, // 录制开始时的页面滚动位置（会话期间锁定）
    lockY: 0,
    baseW: 0, // 录制开始时的视口尺寸（用于检测缩放 / 窗口变化）
    baseH: 0,
    resizeWarned: false, // 尺寸变化告警是否已提示过（避免刷屏）
    lastBlockedAt: 0, // 上次「阻止破坏性操作」提示的时间（限频）
    showRing: true, // 是否显示全屏黑边安全区红框（读取用户配置 yrIndBorder）
    ring: null, // 黑边红框四段（top / bottom / left / right）
    listeners: [], // 已绑定的监听（结束时统一解绑）
  };

  // ===================== 基础工具 =====================

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function makeEl(tag, cls, css) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (css) el.style.cssText = css;
    return el;
  }

  /** 输入类元素中的按键不拦截（录制开始时焦点若已在输入框，不打断正常输入） */
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return !!el.isContentEditable;
  }

  function addL(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    S.listeners.push([target, type, handler, opts]);
  }

  function unbind() {
    const list = S.listeners.slice();
    S.listeners.length = 0;
    for (const item of list) {
      try {
        item[0].removeEventListener(item[1], item[2], item[3]);
      } catch (err) {
        /* 页面卸载竞态：忽略 */
      }
    }
  }

  /** 提示类消息：交给 background 记入状态，弹窗可见（复用 UI_ACTION 链路） */
  function notify(message) {
    try {
      chrome.runtime.sendMessage({
        type: 'UI_ACTION',
        action: 'toast',
        payload: { type: 'warning', message },
      });
    } catch (err) {
      /* 通道异常：遮罩内的告警仍然可见，不阻断 */
    }
  }

  // ===================== DOM 构建 =====================

  /** 注入动画关键帧（仅一个 style 节点，结束即移除） */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '@keyframes yr-guard-pulse{0%{opacity:1}50%{opacity:.25}100%{opacity:1}}' +
      '@keyframes yr-guard-in{from{opacity:0}to{opacity:1}}' +
      '@keyframes yr-guard-ring{0%,100%{opacity:.85}50%{opacity:.45}}';
    (document.head || document.documentElement).appendChild(style);
  }

  function removeStyle() {
    const style = document.getElementById(STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }

  function buildDom() {
    if (S.root) return;

    const root = makeEl(
      'div',
      NS + '-root',
      'position:fixed;left:0;top:0;width:100%;height:100%;z-index:' + Z_INDEX + ';pointer-events:none;'
    );
    // 供自检 / 排查：页面中出现该节点即代表当前处于录制锁定状态
    root.setAttribute('data-yr-guard', 'recording');

    const veilBase = 'position:fixed;display:none;background:' + DIM_BG + ';pointer-events:auto;';
    const veils = {
      top: makeEl('div', NS + '-veil', veilBase),
      bottom: makeEl('div', NS + '-veil', veilBase),
      left: makeEl('div', NS + '-veil', veilBase),
      right: makeEl('div', NS + '-veil', veilBase),
    };

    const tip = makeEl(
      'div',
      NS + '-tip',
      'position:fixed;display:none;left:50%;transform:translate(-50%,0);' +
        'box-sizing:border-box;padding:10px 16px;border-radius:10px;' +
        'background:rgba(15,15,15,.82);border:1px solid rgba(255,255,255,.14);color:#fff;' +
        'font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,' +
        '"PingFang SC","Microsoft YaHei",sans-serif;pointer-events:none;' +
        'animation:yr-guard-in .18s ease-out;'
    );
    const row = makeEl('div', NS + '-tip-row', 'display:flex;align-items:center;gap:8px;white-space:nowrap;');
    const dot = makeEl(
      'span',
      NS + '-dot',
      'display:inline-block;width:9px;height:9px;border-radius:50%;background:#ff4b3e;' +
        'flex:0 0 auto;animation:yr-guard-pulse 1.2s infinite;'
    );
    const title = makeEl('span', NS + '-tip-title', 'font-size:14px;font-weight:600;letter-spacing:.2px;');
    title.textContent = TIP_TITLE;
    row.appendChild(dot);
    row.appendChild(title);

    // pre-line：保留文案里的手动换行（洞外提示，绝不会压到画面上）
    const detail = makeEl(
      'div',
      NS + '-tip-detail',
      'margin-top:4px;color:rgba(255,255,255,.78);font-size:12px;white-space:pre-line;'
    );
    detail.textContent = TIP_DETAIL.replace('{HK}', '');

    // 「停止并保存」按钮。点击后发送与页面快捷键（content/hotkey.js）完全相同的
    // YR_HOTKEY 消息，由 background 按当前状态决定动作——录制中即进入现有的
    // 「停止并保存」流程，这里不引入任何新的保存 / 停止逻辑。
    // tip 整块 pointer-events:none（文字只读不拦截点击），仅按钮自身 pointer-events:auto；
    // 按钮随 tip 位于洞外（遮罩上），绝不会被录进视频。
    const stopBtn = makeEl(
      'button',
      NS + '-tip-stop',
      'display:flex;align-items:center;justify-content:center;' +
        'margin:10px auto 0;min-width:132px;height:32px;padding:0 18px;' +
        'border:none;border-radius:8px;outline:none;' +
        'background:#e62117;color:#fff;' +
        'font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,' +
        '"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;' +
        'cursor:pointer;pointer-events:auto;user-select:none;' +
        'transition:background .15s ease,opacity .15s ease;'
    );
    stopBtn.type = 'button';
    stopBtn.textContent = TIP_STOP_TEXT;
    stopBtn.addEventListener('click', () => {
      if (stopBtn.disabled) return; // 防连点：停止流程不可重复触发
      stopBtn.disabled = true;
      stopBtn.textContent = TIP_STOPPING_TEXT;
      stopBtn.style.opacity = '.55';
      try {
        chrome.runtime.sendMessage({ type: 'YR_HOTKEY' }, () => {
          // 回执仅用于消化 lastError（background 无监听方时不产生控制台告警）
          void chrome.runtime.lastError;
        });
      } catch (err) {
        /* 扩展上下文失效（升级 / 重载）：忽略 */
      }
    });

    const warn = makeEl(
      'div',
      NS + '-tip-warn',
      'display:none;margin-top:4px;color:#ffb4ae;font-size:12px;white-space:pre-line;'
    );
    warn.textContent = TIP_RESIZE;

    tip.appendChild(row);
    tip.appendChild(detail);
    tip.appendChild(stopBtn);
    tip.appendChild(warn);

    root.appendChild(veils.top);
    root.appendChild(veils.bottom);
    root.appendChild(veils.left);
    root.appendChild(veils.right);
    root.appendChild(tip);

    // 全屏黑边安全区红框：四段独立绘制，只落在裁剪区（画面矩形）之外的 letterbox 上。
    // 置于遮罩 / 提示之后 → 不被半透明遮罩压暗（红框像素本就在裁剪区外，不会入画）。
    const ringCss =
      'position:fixed;display:none;background:' + RING_COLOR + ';pointer-events:none;' +
      'border-radius:2px;animation:yr-guard-ring 1.6s ease-in-out infinite;';
    const ring = {
      top: makeEl('div', NS + '-ring-top', ringCss),
      bottom: makeEl('div', NS + '-ring-bottom', ringCss),
      left: makeEl('div', NS + '-ring-left', ringCss),
      right: makeEl('div', NS + '-ring-right', ringCss),
    };
    root.appendChild(ring.top);
    root.appendChild(ring.bottom);
    root.appendChild(ring.left);
    root.appendChild(ring.right);

    S.root = root;
    S.veils = veils;
    S.ring = ring;
    S.tip = tip;
    S.tipDetail = detail;
    S.tipWarn = warn;
  }

  /**
   * 选择挂载宿主。
   * 全屏状态下浏览器只渲染全屏元素的子树，遮罩必须挂进该子树才会显示；
   * 若全屏目标是 <video>（其子节点按规范不渲染），则放弃遮罩（此时画面铺满屏幕，
   * 本来也没有可点击的页面元素）。
   */
  function pickHost() {
    const fs = document.fullscreenElement;
    if (fs && fs !== document.documentElement) {
      if (fs.tagName === 'VIDEO') return null;
      return fs;
    }
    return document.body || document.documentElement;
  }

  function destroyDom() {
    if (S.root && S.root.parentNode) S.root.parentNode.removeChild(S.root);
    S.root = null;
    S.veils = null;
    S.ring = null;
    S.tip = null;
    S.tipDetail = null;
    S.tipWarn = null;
    S.host = null;
  }

  function hide() {
    if (S.root) S.root.style.display = 'none';
  }

  // ===================== 布局 =====================

  function setBox(el, x, y, w, h) {
    if (!el) return;
    if (!(w > 0) || !(h > 0)) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    el.style.width = Math.round(w) + 'px';
    el.style.height = Math.round(h) + 'px';
  }

  /**
   * 放置提示文案：必须放在洞外（否则会被录进视频）。
   * 优先放在画面下方空间，其次上方；空间不足时先降级为单行，仍放不下则隐藏。
   * 提示框内含「停止并保存」按钮，因此按实际高度自适应降级：
   * 先按完整内容（标题 + 副文案 + 按钮）测量，放不下时隐藏副文案再测，
   * 让标题与按钮优先可见（都是同步排版，不会出现闪烁 / 中间帧）。
   */
  function placeTip(vw, vh, hole) {
    const tip = S.tip;
    if (!tip) return;
    S.tipWarn.style.display = S.resizeWarned ? 'block' : 'none';

    const topH = hole.y;
    const bottomH = Math.max(0, vh - (hole.y + hole.h));
    const useBottom = bottomH >= topH;
    const regionTop = useBottom ? hole.y + hole.h : 0;
    const regionH = useBottom ? bottomH : topH;

    tip.style.maxWidth = Math.round(Math.min(vw * 0.92, 720)) + 'px';
    S.tipDetail.style.display = 'block';
    tip.style.display = 'block';
    let h = tip.offsetHeight || 0;
    if (regionH < h + 8) {
      S.tipDetail.style.display = 'none'; // 副文案降级隐藏，保住标题与停止按钮
      h = tip.offsetHeight || 0;
    }
    if (!h || regionH < h + 8) {
      tip.style.display = 'none'; // 绝不允许压到被录画面上
      return;
    }
    tip.style.top = Math.round(regionTop + Math.max(6, (regionH - h) / 2)) + 'px';
  }

  // ===================== 全屏黑边安全区红框 =====================

  function hideRing() {
    if (!S.ring) return;
    for (const key of ['top', 'bottom', 'left', 'right']) {
      if (S.ring[key]) S.ring[key].style.display = 'none';
    }
  }

  function setSeg(el, x, y, w, h) {
    if (!el || !(w > 0) || !(h > 0)) return;
    el.style.display = 'block';
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    el.style.width = Math.round(w) + 'px';
    el.style.height = Math.round(h) + 'px';
  }

  /**
   * 绘制「全屏黑边安全区」红框。约束（缺一不画，宁缺毋滥）：
   * 1. 录制中且用户开启了红框指示；
   * 2. 处于 HTML 全屏（非全屏时遮罩提示已可见，不需要红框）；
   * 3. 提示文案当前未显示（两者都在画面外的空间竞争，避免叠字）；
   * 4. 画面某侧黑边足够宽（≥ RING_MIN_SPACE），保证红框绝不会压到被录画面。
   * letterbox 只会成对出现（左右 / 上下），满足哪对就画哪两条；铺满画面时自动全隐藏。
   */
  function layoutRing(rect) {
    if (!S.ring) return;
    hideRing();
    if (!S.enabled || !S.showRing) return;
    if (!document.fullscreenElement) return;
    if (!S.tip || S.tip.style.display === 'block') return;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;

    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const r = rect;
    const spaceTop = r.y;
    const spaceBottom = vh - (r.y + r.height);
    const spaceLeft = r.x;
    const spaceRight = vw - (r.x + r.width);

    // 上下黑边足够 → 画上 / 下两条横线（跨满屏宽，线贴画面边缘留出 RING_GAP 空隙）
    if (spaceTop >= RING_MIN_SPACE && spaceBottom >= RING_MIN_SPACE) {
      setSeg(S.ring.top, 0, r.y - RING_GAP - RING_WIDTH, vw, RING_WIDTH);
      setSeg(S.ring.bottom, 0, r.y + r.height + RING_GAP, vw, RING_WIDTH);
    }
    // 左右黑边足够 → 画左 / 右两条竖线
    if (spaceLeft >= RING_MIN_SPACE && spaceRight >= RING_MIN_SPACE) {
      setSeg(S.ring.left, r.x - RING_GAP - RING_WIDTH, 0, RING_WIDTH, vh);
      setSeg(S.ring.right, r.x + r.width + RING_GAP, 0, RING_WIDTH, vh);
    }
  }

  /**
   * 按最新播放器画面矩形刷新遮罩（由 content.js 的矩形心跳驱动，约 120ms 一次，
   * 天然跟随剧场模式 / 全屏 / 窗口尺寸等布局变化）。
   */
  function layout(rect) {
    S.rect = rect || null;
    if (!S.enabled) return;
    if (!S.rect) {
      // 定位不到播放器时不遮罩（宁可不遮，也不能遮住画面被录进去）
      hide();
      return;
    }
    const host = pickHost();
    if (!host) {
      hide();
      return;
    }
    ensureStyle();
    buildDom();
    if (S.host !== host || S.root.parentNode !== host) {
      host.appendChild(S.root);
      S.host = host;
    }
    S.root.style.display = 'block';

    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const r = S.rect;
    // 洞 = 播放器真实画面矩形外扩（基础外扩 + 用户校准偏移绝对值），再夹进视口
    const hx = clamp(r.x - S.marginX, 0, vw);
    const hy = clamp(r.y - S.marginY, 0, vh);
    const hx2 = clamp(r.x + r.width + S.marginX, 0, vw);
    const hy2 = clamp(r.y + r.height + S.marginY, 0, vh);
    const hole = {
      x: hx,
      y: hy,
      w: Math.max(0, hx2 - hx),
      h: Math.max(0, hy2 - hy),
    };

    setBox(S.veils.top, 0, 0, vw, hole.y);
    setBox(S.veils.bottom, 0, hole.y + hole.h, vw, vh - (hole.y + hole.h));
    setBox(S.veils.left, 0, hole.y, hole.x, hole.h);
    setBox(S.veils.right, hole.x + hole.w, hole.y, vw - (hole.x + hole.w), hole.h);
    placeTip(vw, vh, hole);
    layoutRing(S.rect);
  }

  // ===================== 交互拦截 =====================

  function onWheel(e) {
    e.preventDefault(); // 禁止滚轮滚动页面
  }

  function onTouchMove(e) {
    e.preventDefault(); // 禁止触摸滑动
  }

  function onScroll() {
    // 兜底：任何来源的滚动都拉回录制开始时的位置，保证裁剪区不漂移
    const x = window.scrollX || window.pageXOffset || 0;
    const y = window.scrollY || window.pageYOffset || 0;
    if (x === S.lockX && y === S.lockY) return;
    try {
      window.scrollTo({ left: S.lockX, top: S.lockY, behavior: 'instant' });
    } catch (err) {
      window.scrollTo(S.lockX, S.lockY);
    }
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // 不干扰浏览器 / 系统快捷键
    if (isEditable(e.target)) return;
    const key = e.key || '';
    let blocked = SCROLL_KEYS.indexOf(key) >= 0;
    if (!blocked && key.length === 1) {
      blocked = BLOCKED_PLAYER_KEYS.indexOf(key.toLowerCase()) >= 0;
    }
    // 全屏状态下 Esc 会退出全屏并改变布局
    if (!blocked && key === 'Escape' && document.fullscreenElement) blocked = true;
    if (blocked) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onMouseDown(e) {
    if (e.button === 1) e.preventDefault(); // 中键自动滚动
  }

  function onAuxClick(e) {
    e.preventDefault();
  }

  /**
   * 播放器上的「破坏性控件」拦截（捕获阶段吞掉事件）。
   * 洞内已放行给 YouTube 播放器：播放 / 暂停、进度、音量、字幕、倍速都可用；
   * 只有会改变布局（全屏 / 剧场 / 迷你播放器）或让音轨无声（静音）的按钮被拦下。
   * 三种按下 / 点击事件都监听，是为了兼容 YouTube 不同版本用不同事件绑定按钮。
   */
  function onPlayerControl(e) {
    const el = e.target;
    if (!el || typeof el.closest !== 'function') return;
    if (!el.closest(BLOCKED_CONTROLS_SELECTOR)) return;
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - S.lastBlockedAt >= BLOCK_NOTICE_INTERVAL_MS) {
      S.lastBlockedAt = now;
      notify(CONTROL_BLOCK_NOTICE);
    }
  }

  /** 双击画面 = YouTube / Bilibili 播放器切换全屏（改变布局），同快捷键 f 一并拦掉 */
  function onDblClick(e) {
    const el = e.target;
    if (!el || typeof el.closest !== 'function') return;
    if (!el.closest('video, #movie_player, #movie_player *, #bilibili-player, #bilibili-player *')) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onResize() {
    if (!S.enabled) return;
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    if (!S.resizeWarned && (Math.abs(w - S.baseW) > 1 || Math.abs(h - S.baseH) > 1)) {
      S.resizeWarned = true;
      notify(RESIZE_NOTICE);
    }
    layout(S.rect);
  }

  function onFullscreenChange() {
    layout(S.rect); // 全屏切换后宿主可能变化，需要重新挂载
  }

  function bind() {
    addL(window, 'wheel', onWheel, { capture: true, passive: false });
    addL(window, 'touchmove', onTouchMove, { capture: true, passive: false });
    addL(window, 'keydown', onKeyDown, { capture: true });
    addL(window, 'scroll', onScroll, { capture: true, passive: true });
    addL(window, 'mousedown', onMouseDown, { capture: true });
    addL(window, 'auxclick', onAuxClick, { capture: true });
    addL(window, 'pointerdown', onPlayerControl, { capture: true });
    addL(window, 'mousedown', onPlayerControl, { capture: true });
    addL(window, 'click', onPlayerControl, { capture: true });
    addL(window, 'dblclick', onDblClick, { capture: true });
    addL(window, 'resize', onResize, { capture: true, passive: true });
    addL(document, 'fullscreenchange', onFullscreenChange, true);
  }

  /**
   * 读取用户在弹窗中设置的画面微调：偏移量越大，裁剪区可能越出画面矩形，
   * 洞必须同步外扩，确保遮罩像素不落在裁剪区里。
   */
  function loadCropOffset() {
    try {
      if (!chrome.storage || !chrome.storage.sync) return;
      chrome.storage.sync.get(['yrOffsetX', 'yrOffsetY'], (data) => {
        S.marginX = HOLE_MARGIN_BASE + Math.abs(Number(data && data.yrOffsetX) || 0);
        S.marginY = HOLE_MARGIN_BASE + Math.abs(Number(data && data.yrOffsetY) || 0);
        layout(S.rect);
      });
    } catch (err) {
      /* storage 不可用：用基础外扩值 */
    }
  }

  /**
   * 把「开始 / 停止录制」快捷键写进提示副文案。
   * 配置由 shared/hotkey.js 统一读写（与弹窗设置面板同源），遮罩出现时读一次即可；
   * 快捷键未启用时退化成原来的文案（不出现空的「请 点击」）。
   */
  function applyHotkeyHint() {
    const HK = window.YRHotkey;
    if (!HK || typeof HK.read !== 'function') return;
    HK.read().then((combo) => {
      if (!S.tipDetail) return; // 遮罩可能在读取完成前就已销毁
      const hint = combo && combo.enabled && combo.key ? '按快捷键 ' + HK.format(combo) + '，或' : '';
      S.tipDetail.textContent = TIP_DETAIL.replace('{HK}', hint);
    });
  }

  /**
   * 读取「全屏红框」开关（yrIndBorder，默认开）。红框只在录制会话期间绘制，
   * 配置随会话开关读取一次即可；关掉后红框立即隐藏（遮罩与提示不受影响）。
   */
  function loadIndicatorPref() {
    const api = window.YRIndicator;
    if (!api || typeof api.read !== 'function') {
      S.showRing = true;
      return;
    }
    api.read().then((value) => {
      S.showRing = !value || value.border !== false;
      if (!S.showRing) hideRing();
      else layout(S.rect);
    });
  }

  // ===================== 对外接口 =====================

  /** 录制会话开始：锁定页面交互并显示遮罩 */
  function enable() {
    if (S.enabled) return;
    S.enabled = true;
    S.resizeWarned = false;
    S.lastBlockedAt = 0;
    S.rect = null;
    S.showRing = true;
    S.marginX = HOLE_MARGIN_BASE;
    S.marginY = HOLE_MARGIN_BASE;
    S.baseW = window.innerWidth || 0;
    S.baseH = window.innerHeight || 0;
    S.lockX = window.scrollX || window.pageXOffset || 0;
    S.lockY = window.scrollY || window.pageYOffset || 0;
    bind();
    loadCropOffset();
    loadIndicatorPref();
    layout(S.rect); // 此刻尚无矩形 → 隐藏，等下一个心跳带来矩形后再显示
    applyHotkeyHint(); // DOM 建好后再写快捷键提示（读取 storage 是异步的）
  }

  /** 录制会话结束（完成 / 失败 / 复位）：移除遮罩与全部监听 */
  function disable() {
    if (!S.enabled && !S.root) return;
    S.enabled = false;
    unbind();
    destroyDom();
    removeStyle();
    S.rect = null;
    S.resizeWarned = false;
    S.lastBlockedAt = 0;
  }

  window.YRGuard = {
    enable,
    disable,
    layout,
    isEnabled: () => S.enabled,
  };
})();
