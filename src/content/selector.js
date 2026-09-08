/**
 * content/selector.js —— 框选录制区域选择器
 * 
 * 提供类似截屏的框选体验：
 * 1. 蒙层覆盖视口；
 * 2. 鼠标拖拽产生红框选区；
 * 3. 选区中央显示“开始录制选区”与“取消选区”按钮（选区再大也不会跑到屏幕外）；
 * 4. 已进入框选态时按 Esc 可退出选择器（录制中不响应）；
 * 5. 录制开始后显示“停止录制”与提示 —— 必须整体落在选区外：tabCapture 捕获整页，
 *    成片只保留选区内的像素，任何压在选区上的控件都会被录进视频。
 *    优先放进选区外的留白区（下 → 上 → 右 → 左）；若选区几乎铺满视口、选区外
 *    放不下，则从选区里让出一条控件条（实际被录区域相应缩小，让出的部分被蒙层
 *    盖住），确保控件永远在成片之外。
 */
(() => {
  'use strict';

  const NS = 'yr-selector';
  const Z_INDEX = '2147483647'; // 甚至高于 guard
  const DIM_BG = 'rgba(0, 0, 0, 0.6)';
  const BORDER_COLOR = '#ff2e2e'; // 霓虹红
  /** 控件与「实际被录区域」之间必须留出的安全间距（px）：吸收裁剪换算 1~2px 抖动 */
  const CTRL_GAP = 14;
  /** 控件与视口边缘的最小间距（px）：保证可见、可点 */
  const EDGE_PAD = 10;
  /** 从选区里让出控件条时，选区至少要保留的尺寸（px）：别把选区吃没 */
  const MIN_RECT_SIZE = 80;

  const S = {
    active: false,
    selecting: false,
    recorded: false,
    startX: 0,
    startY: 0,
    rect: null, // { x, y, w, h } 用户框选的区域
    effRect: null, // 实际被录区域：通常等于 rect；选区外放不下控件时 = rect 让出控件条后的结果
    prevRect: null, // 按下前已有的选区：纯点击（未拖动）时不至于丢失选区
    offX: 0, // 用户在弹窗中设置的画面微调（CSS px，正 = 向右）：会让裁剪区平移
    offY: 0,
    pageLocked: false, // 录制中页面滚动 / 按键锁定是否已生效
    lockX: 0, // 录制开始时的页面滚动位置（录制期间锁定，防止裁剪区漂移）
    lockY: 0,
    root: null,
    veils: null,
    border: null,
    controls: null,
    actions: null, // 待录制按钮行：[开始录制选区] [取消选区]
    recBar: null, // 录制中按钮行：[停止录制] + 提示（整行必须落在选区外）
    btnStart: null,
    btnCancel: null,
    btnStop: null,
    tip: null,
    starting: false, // YR_START 请求进行中（乐观 UI 期间禁止 Esc / 取消）
    listeners: []
  };

  function makeEl(tag, cls, css) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (css) el.style.cssText = css;
    return el;
  }

  function addL(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    S.listeners.push([target, type, handler, opts]);
  }

  function unbind() {
    S.listeners.forEach(item => {
      try { item[0].removeEventListener(item[1], item[2], item[3]); } catch(e) {}
    });
    S.listeners = [];
  }

  function ensureStyle() {
    const id = NS + '-style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      .${NS}-btn {
        padding: 10px 24px;
        border-radius: 12px;
        border: none;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        backdrop-filter: blur(12px);
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        letter-spacing: 0.5px;
      }
      .${NS}-btn-start {
        background: linear-gradient(135deg, rgba(26, 115, 232, 0.8), rgba(0, 82, 204, 0.8));
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 0 15px rgba(26, 115, 232, 0.3);
      }
      .${NS}-btn-start:hover {
        background: linear-gradient(135deg, rgba(26, 115, 232, 1), rgba(0, 82, 204, 1));
        transform: translateY(-2px) scale(1.02);
        box-shadow: 0 0 25px rgba(26, 115, 232, 0.6);
      }
      .${NS}-btn-stop {
        background: linear-gradient(135deg, rgba(230, 33, 23, 0.8), rgba(190, 0, 0, 0.8));
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 0 15px rgba(230, 33, 23, 0.3);
      }
      .${NS}-btn-stop:hover {
        background: linear-gradient(135deg, rgba(230, 33, 23, 1), rgba(190, 0, 0, 1));
        transform: translateY(-2px) scale(1.02);
        box-shadow: 0 0 25px rgba(230, 33, 23, 0.6);
      }
      .${NS}-btn-cancel {
        background: linear-gradient(135deg, rgba(60, 60, 60, 0.75), rgba(40, 40, 40, 0.75));
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.15);
        box-shadow: 0 0 12px rgba(0, 0, 0, 0.35);
      }
      .${NS}-btn-cancel:hover {
        background: linear-gradient(135deg, rgba(90, 90, 90, 0.9), rgba(60, 60, 60, 0.9));
        transform: translateY(-2px) scale(1.02);
        box-shadow: 0 0 20px rgba(255, 255, 255, 0.15);
      }
      .${NS}-recbar {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 12px;
        white-space: nowrap;
      }
      .${NS}-tip {
        margin-top: 0;
        color: #fff;
        font-size: 12px;
        font-weight: 500;
        text-shadow: 0 0 10px rgba(255, 255, 255, 0.3);
        text-align: center;
        pointer-events: none;
        opacity: 0.9;
        animation: yr-pulse 2s infinite ease-in-out;
      }
      @keyframes yr-pulse {
        0%, 100% { opacity: 0.7; transform: scale(0.98); }
        50% { opacity: 1; transform: scale(1); }
      }
      @keyframes yr-fade-in {
        from { opacity: 0; backdrop-filter: blur(0); }
        to { opacity: 1; backdrop-filter: blur(2px); }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildDom() {
    if (S.root) return;
    ensureStyle();
    const root = makeEl('div', NS + '-root', `position:fixed;left:0;top:0;width:100%;height:100%;z-index:${Z_INDEX};cursor:crosshair;animation:yr-fade-in 0.2s ease;`);
    
    const veilBase = `position:fixed;background:${DIM_BG};pointer-events:auto;transition: all 0.05s linear;`;
    S.veils = {
      top: makeEl('div', NS + '-veil', veilBase),
      bottom: makeEl('div', NS + '-veil', veilBase),
      left: makeEl('div', NS + '-veil', veilBase),
      right: makeEl('div', NS + '-veil', veilBase)
    };

    S.border = makeEl('div', NS + '-border', `position:fixed;border:1px solid ${BORDER_COLOR};box-shadow:0 0 8px ${BORDER_COLOR};pointer-events:none;display:none;box-sizing:border-box;`);
    
    S.controls = makeEl('div', NS + '-controls', `position:fixed;display:none;flex-direction:column;align-items:center;pointer-events:auto;z-index:1;`);
    
    S.actions = makeEl('div', NS + '-actions', 'display:flex;flex-direction:row;align-items:center;gap:10px;');

    S.btnStart = makeEl('button', NS + '-btn ' + NS + '-btn-start');
    S.btnStart.textContent = '开始录制选区';

    S.btnCancel = makeEl('button', NS + '-btn ' + NS + '-btn-cancel');
    S.btnCancel.textContent = '取消选区';

    S.actions.appendChild(S.btnStart);
    S.actions.appendChild(S.btnCancel);

    // 录制中整行 [停止录制] + 提示：作为整体参与「选区外定位」，
    // 行内横排比竖排更矮，更容易塞进选区上下的留白条里
    S.recBar = makeEl('div', NS + '-recbar', 'display:none;');

    S.btnStop = makeEl('button', NS + '-btn ' + NS + '-btn-stop');
    S.btnStop.textContent = '停止录制';

    S.tip = makeEl('div', NS + '-tip');
    S.tip.textContent = '录制中 · 请勿操作页面';

    S.recBar.appendChild(S.btnStop);
    S.recBar.appendChild(S.tip);

    S.controls.appendChild(S.actions);
    S.controls.appendChild(S.recBar);

    root.appendChild(S.veils.top);
    root.appendChild(S.veils.bottom);
    root.appendChild(S.veils.left);
    root.appendChild(S.veils.right);
    root.appendChild(S.border);
    root.appendChild(S.controls);

    document.body.appendChild(root);
    S.root = root;
  }

  function updateLayout() {
    if (!S.root) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    
    if (!S.rect) {
      Object.values(S.veils).forEach(v => {
        v.style.left = '0';
        v.style.top = '0';
        v.style.width = '100%';
        v.style.height = '100%';
        v.style.display = 'block';
      });
      S.veils.bottom.style.display = 'none';
      S.veils.left.style.display = 'none';
      S.veils.right.style.display = 'none';
      S.border.style.display = 'none';
      S.controls.style.display = 'none';
      return;
    }

    // 录制中一律以「实际被录区域」为准：它与用户选区可能相差一条控件条
    const { x, y, w, h } = S.recorded && S.effRect ? S.effRect : S.rect;
    
    // Veils（蒙层 = 被录区域之外，控件放在蒙层上就不会进成片）
    setBox(S.veils.top, 0, 0, vw, y);
    setBox(S.veils.bottom, 0, y + h, vw, vh - (y + h));
    setBox(S.veils.left, 0, y, x, h);
    setBox(S.veils.right, x + w, y, vw - (x + w), h);

    // Border（录制开始后隐藏红框，避免红框边缘像素进入成片）
    setBox(S.border, x, y, w, h);
    S.border.style.display = S.recorded ? 'none' : 'block';

    // Controls：拖拽尚未形成有效矩形时先隐藏，避免按钮跟随框闪动；
    // 「准备录制…」期间（YR_START 已发出、离屏可能已开始出帧）也必须撤掉页面内控件，
    // 否则 [开始录制选区] 会正好出现在成片开头
    if (S.starting || (S.selecting && (w < 10 || h < 10))) {
      S.controls.style.display = 'none';
      return;
    }
    S.controls.style.display = 'flex';

    if (S.recorded) {
      // 录制中：隐藏 [开始][取消]，仅显示 [停止] + 提示，并放到选区外
      S.actions.style.display = 'none';
      S.recBar.style.display = 'flex';
      positionControls(false);
    } else {
      // 待录制：只显示 [开始][取消]，置于选区中央 —— 选区再大 / 再贴边，
      // 按钮也不会被挤出视口导致无法点击
      S.actions.style.display = 'flex';
      S.recBar.style.display = 'none';
      positionControls(true);
    }
  }

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  /**
   * 读取用户在弹窗中设置的画面微调（与 guard.js 同源）。
   * 微调会把实际裁剪区整体平移，因此安全间距必须把它算进去，
   * 否则「放在选区外」的控件可能被平移后的裁剪区扫进去。
   */
  function loadCropOffset() {
    try {
      if (!chrome.storage || !chrome.storage.sync) return;
      chrome.storage.sync.get(['yrOffsetX', 'yrOffsetY'], (data) => {
        S.offX = Number(data && data.yrOffsetX) || 0;
        S.offY = Number(data && data.yrOffsetY) || 0;
      });
    } catch (err) {
      /* storage 不可用：按 0 处理 */
    }
  }

  /** 控件相对被录区域的安全间距（已叠加画面微调的绝对值） */
  function gapX() {
    return CTRL_GAP + Math.abs(S.offX);
  }

  function gapY() {
    return CTRL_GAP + Math.abs(S.offY);
  }

  /** 「选区外放不下停止按钮」的告警（每次录制最多一次，避免刷屏） */
  let noRoomWarned = false;
  function warnNoRoom() {
    if (noRoomWarned) return;
    noRoomWarned = true;
    try {
      console.warn('[YR-selector] 选区外没有足够空间放置「停止录制」，已隐藏页面内控件，请用扩展弹窗或快捷键停止录制。');
    } catch (err) {
      /* ignore */
    }
  }

  /** 矩形是否与「实际被录区域」相交（相交即意味着会被录进成片） */
  function overlapsRect(px, py, pw, ph, r) {
    return px < r.x + r.w && px + pw > r.x && py < r.y + r.h && py + ph > r.y;
  }

  /** 该位置是否既在视口内、又完全在被录区域之外 */
  function spotFits(pos, box, r) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return (
      pos.x >= EDGE_PAD &&
      pos.y >= EDGE_PAD &&
      pos.x + box.w <= vw - EDGE_PAD &&
      pos.y + box.h <= vh - EDGE_PAD &&
      !overlapsRect(pos.x, pos.y, box.w, box.h, r)
    );
  }

  /**
   * 在被录区域外侧找一处放得下控件的留白（下 → 上 → 右 → 左）。
   * 返回的坐标保证与选区零交叠；四处都放不下时返回 null。
   */
  function findOutsideSpot(box, r) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clampX = (v) => clamp(v, EDGE_PAD, Math.max(EDGE_PAD, vw - box.w - EDGE_PAD));
    const clampY = (v) => clamp(v, EDGE_PAD, Math.max(EDGE_PAD, vh - box.h - EDGE_PAD));
    const gx = gapX();
    const gy = gapY();
    const candidates = [
      { x: clampX(r.x + (r.w - box.w) / 2), y: r.y + r.h + gy }, // 下
      { x: clampX(r.x + (r.w - box.w) / 2), y: r.y - gy - box.h }, // 上
      { x: r.x + r.w + gx, y: clampY(r.y + (r.h - box.h) / 2) }, // 右
      { x: r.x - gx - box.w, y: clampY(r.y + (r.h - box.h) / 2) }, // 左
    ];
    for (const pos of candidates) {
      if (spotFits(pos, box, r)) return pos;
    }
    return null;
  }

  /**
   * 选区外确实放不下控件（选区几乎铺满视口）时的兜底：从选区里让出一条控件条，
   * 实际被录区域相应缩小，让出的部分归入蒙层 —— 控件依旧落在被录区域之外。
   * 返回 { eff, pos }；无法安全让出时返回 null。
   */
  function reserveControlStrip(box) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const base = S.rect;
    if (!base) return null;
    const stripV = box.h + gapY() * 2; // 上 / 下让出条的高度
    const stripH = box.w + gapX() * 2; // 左 / 右让出条的宽度
    const clampX = (v) => clamp(v, EDGE_PAD, Math.max(EDGE_PAD, vw - box.w - EDGE_PAD));
    const clampY = (v) => clamp(v, EDGE_PAD, Math.max(EDGE_PAD, vh - box.h - EDGE_PAD));
    const centerX = clampX(base.x + (base.w - box.w) / 2);
    const centerY = clampY(base.y + (base.h - box.h) / 2);

    const plans = [];
    // 优先底部：录视频时下方多为黑边 / 字幕区，让出的代价最小
    if (base.h - stripV >= MIN_RECT_SIZE && box.w + EDGE_PAD * 2 <= vw) {
      const eff = { x: base.x, y: base.y, w: base.w, h: base.h - stripV };
      plans.push({ eff, pos: { x: centerX, y: eff.y + eff.h + gapY() } });
    }
    if (base.h - stripV >= MIN_RECT_SIZE && box.w + EDGE_PAD * 2 <= vw) {
      const eff = { x: base.x, y: base.y + stripV, w: base.w, h: base.h - stripV };
      plans.push({ eff, pos: { x: centerX, y: base.y + gapY() } });
    }
    if (base.w - stripH >= MIN_RECT_SIZE && box.h + EDGE_PAD * 2 <= vh) {
      const eff = { x: base.x, y: base.y, w: base.w - stripH, h: base.h };
      plans.push({ eff, pos: { x: eff.x + eff.w + gapX(), y: centerY } });
    }
    if (base.w - stripH >= MIN_RECT_SIZE && box.h + EDGE_PAD * 2 <= vh) {
      const eff = { x: base.x + stripH, y: base.y, w: base.w - stripH, h: base.h };
      plans.push({ eff, pos: { x: base.x + gapX(), y: centerY } });
    }
    for (const plan of plans) {
      if (spotFits(plan.pos, box, plan.eff)) return plan;
    }
    return null;
  }

  /** 量出「录制中」控件组合（[停止录制] + 提示）的尺寸，不破坏当前可见状态 */
  function measureRecordingBox() {
    const fallback = { w: 260, h: 40 };
    if (!S.controls || !S.recBar) return fallback;
    const prev = {
      display: S.controls.style.display,
      visibility: S.controls.style.visibility,
      left: S.controls.style.left,
      top: S.controls.style.top,
      actions: S.actions.style.display,
      bar: S.recBar.style.display,
    };
    S.actions.style.display = 'none';
    S.recBar.style.display = 'flex';
    S.controls.style.display = 'flex';
    S.controls.style.visibility = 'hidden'; // 离屏测量：避免闪一下
    S.controls.style.left = '-99999px';
    S.controls.style.top = '0px';
    const box = {
      w: S.controls.offsetWidth || fallback.w,
      h: S.controls.offsetHeight || fallback.h,
    };
    S.controls.style.display = prev.display;
    S.controls.style.visibility = prev.visibility;
    S.controls.style.left = prev.left;
    S.controls.style.top = prev.top;
    S.actions.style.display = prev.actions;
    S.recBar.style.display = prev.bar;
    return box;
  }

  /**
   * 控件定位。
   * @param {boolean} center true = 置于选区中央（待录制态）；
   *                  false = 置于选区外（录制中，绝不进成片）。
   */
  function positionControls(center) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ctrlH = S.controls.offsetHeight || 60;
    const ctrlW = S.controls.offsetWidth || 200;
    const r = S.recorded && S.effRect ? S.effRect : S.rect;
    const { x, y, w, h } = r;

    let ctrlX;
    let ctrlY;
    if (center) {
      ctrlX = x + (w - ctrlW) / 2;
      ctrlY = y + (h - ctrlH) / 2;
    } else {
      // 录制中：宁可不显示，也绝不让按钮压在被录区域上（压上就会被裁进视频）
      const spot = findOutsideSpot({ w: ctrlW, h: ctrlH }, r);
      if (!spot) {
        // 选区外连让出一条都做不到（极小的视口 / 极大的选区）：隐藏页面内控件，
        // 改用扩展弹窗或快捷键停止 —— 无论如何不能让按钮出现在成片里。
        S.controls.style.display = 'none';
        warnNoRoom();
        return;
      }
      ctrlX = spot.x;
      ctrlY = spot.y;
    }

    // 始终夹在视口内（并留 10px 边距），保证按钮可见、可点
    ctrlX = clamp(ctrlX, EDGE_PAD, Math.max(EDGE_PAD, vw - ctrlW - EDGE_PAD));
    ctrlY = clamp(ctrlY, EDGE_PAD, Math.max(EDGE_PAD, vh - ctrlH - EDGE_PAD));

    S.controls.style.left = Math.round(ctrlX) + 'px';
    S.controls.style.top = Math.round(ctrlY) + 'px';
  }

  function setBox(el, x, y, w, h) {
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    el.style.width = Math.max(0, Math.round(w)) + 'px';
    el.style.height = Math.max(0, Math.round(h)) + 'px';
    el.style.display = (w > 0 && h > 0) ? 'block' : 'none';
  }

  function onMouseDown(e) {
    if (S.recorded) return;
    if (e.button !== 0) return; // 只响应鼠标左键
    const t = e.target;
    // 只在遮罩（veil）上按下才开始框选：按钮 / 控件区域内的按下不触发，
    // 否则点击「开始录制选区」的瞬间会把已选好的矩形清空，导致点了没反应。
    if (!t || typeof t.closest !== 'function' || !t.closest('.' + NS + '-veil')) return;
    S.selecting = true;
    S.prevRect = S.rect; // 记住按下前的选区：仅点击未拖动时恢复，不破坏已有选区
    S.startX = e.clientX;
    S.startY = e.clientY;
    S.rect = { x: S.startX, y: S.startY, w: 0, h: 0 };
    updateLayout();
  }

  function onMouseMove(e) {
    if (!S.selecting) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 夹紧到视口内：鼠标拖出窗口 / 移向地址栏时坐标可能越界
    const curX = Math.max(0, Math.min(vw, e.clientX));
    const curY = Math.max(0, Math.min(vh, e.clientY));
    S.rect = {
      x: Math.min(S.startX, curX),
      y: Math.min(S.startY, curY),
      w: Math.abs(curX - S.startX),
      h: Math.abs(curY - S.startY)
    };
    updateLayout();
  }

  function onMouseUp() {
    if (!S.selecting) return;
    S.selecting = false;
    if (S.rect && (S.rect.w < 10 || S.rect.h < 10)) {
      // 只是点了一下而没拖动：恢复按下前的选区（没有则退出框选态）
      S.rect = S.prevRect || null;
      S.prevRect = null;
      updateLayout();
      return;
    }
    S.prevRect = null; // 新选区生效，丢弃历史
  }

  async function startRecording() {
    if (!S.rect || S.starting) return;
    noRoomWarned = false;

    // 决定「实际被录区域」：选区外放得下控件就不动用户选区；
    // 放不下（选区几乎铺满视口）才从选区里让出一条控件条，保证控件不进成片
    const box = measureRecordingBox();
    const reserved = findOutsideSpot(box, S.rect) ? null : reserveControlStrip(box);
    S.effRect = reserved ? reserved.eff : S.rect;

    // 通知 content.js 使用自定义区域
    window.dispatchEvent(new CustomEvent('YR_SET_CUSTOM_RECT', { detail: S.effRect }));

    // 乐观 UI：显示准备状态
    const originalText = S.btnStart.textContent;
    S.starting = true;
    S.btnStart.textContent = '准备录制...';
    S.btnStart.disabled = true;
    S.btnStart.style.opacity = '0.7';
    S.btnStart.style.cursor = 'wait';
    S.btnCancel.disabled = true;
    S.btnCancel.style.opacity = '0.5';
    updateLayout(); // 立刻撤掉页面内控件：离屏随时可能开始出帧

    // 发消息给 background 开始录制（附上当前站点：content 侧由 shared/sites.js 识别）
    const currentSite =
      window.YRSites && typeof window.YRSites.detectCurrent === 'function' ? window.YRSites.detectCurrent() : null;
    chrome.runtime.sendMessage({ type: 'YR_START', site: currentSite ? currentSite.id : '' }, (resp) => {
      // 恢复按钮基础样式
      S.starting = false;
      S.btnStart.disabled = false;
      S.btnStart.style.opacity = '1';
      S.btnStart.style.cursor = 'pointer';
      S.btnStart.textContent = originalText;
      S.btnCancel.disabled = false;
      S.btnCancel.style.opacity = '';

      if (chrome.runtime.lastError || (resp && !resp.ok)) {
        const msg = (resp && resp.message) || (chrome.runtime.lastError ? chrome.runtime.lastError.message : '离屏录制进程无响应');
        console.error('[YR-selector] 启动录制失败:', msg);
        alert('无法开始录制：' + msg + '\n\n请确认已开启标签页捕获权限，并尝试刷新页面后重试。');

        // 恢复 UI 状态：选区保留，可重试或点「取消选区」清除
        S.recorded = false;
        S.effRect = null;
        S.root.style.cursor = 'crosshair';
        window.dispatchEvent(new CustomEvent('YR_CLEAR_CUSTOM_RECT'));
        updateLayout();
        return;
      }

      // 启动成功，更新 UI
      S.recorded = true;
      S.prevRect = null;
      S.root.style.cursor = 'default';
      lockPage(); // 锁定页面滚动 / 破坏性快捷键，防止裁剪区漂移
      updateLayout(); // 按钮布局变化（隐藏开始 / 取消，显示停止与提示）后重排控件位置
    });
  }

  /** 取消当前选中的选区（仅清除选区回到可重新框选状态；区别于按 Esc 整体退出选择器） */
  function cancelSelection() {
    if (S.recorded || S.starting) return;
    S.rect = null;
    S.prevRect = null;
    updateLayout();
  }

  function stopRecording() {
    chrome.runtime.sendMessage({ type: 'YR_STOP' });
    destroy();
  }

  // ===================== 录制中页面锁定 =====================
  //
  // 与「整页录制」的 guard.js 不同，框选录制由 selector 自带全屏遮罩，
  // 无法再叠加 guard：guard 的洞会按播放器矩形外扩，把遮罩压进被录选区边缘。
  // 因此在录制开始后做最小必要的锁定：禁止滚轮 / 触摸滑动产生页面滚动，
  // 兜底拉回滚动位置，并拦截会改变播放器布局（全屏 / 剧场 / 迷你）或让音轨
  // 无声（静音）的 YouTube 快捷键，防止录制画面错位或被静音。

  function lockPage() {
    if (S.pageLocked) return;
    S.pageLocked = true;
    S.lockX = window.scrollX || window.pageXOffset || 0;
    S.lockY = window.scrollY || window.pageYOffset || 0;
    addL(window, 'wheel', onPageWheel, { capture: true, passive: false });
    addL(window, 'touchmove', onPageTouch, { capture: true, passive: false });
    addL(window, 'scroll', onPageScroll, { capture: true, passive: true });
    addL(window, 'keydown', onPageKey, { capture: true });
  }

  function onPageWheel(e) {
    if (S.recorded) e.preventDefault();
  }

  function onPageTouch(e) {
    if (S.recorded) e.preventDefault();
  }

  function onPageScroll() {
    if (!S.recorded) return;
    const x = window.scrollX || window.pageXOffset || 0;
    const y = window.scrollY || window.pageYOffset || 0;
    if (x === S.lockX && y === S.lockY) return;
    try {
      window.scrollTo({ left: S.lockX, top: S.lockY, behavior: 'instant' });
    } catch (err) {
      window.scrollTo(S.lockX, S.lockY);
    }
  }

  /** 需拦截的滚动 / 翻页键（与 guard.js 保持一致；不含左右键，播放器快退快进可正常用） */
  const SCROLL_KEYS = [' ', 'Spacebar', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'];
  /** 会破坏录制的 YouTube 播放器快捷键：全屏 / 剧场 / 迷你 / 静音 */
  const LAYOUT_KEYS = ['f', 't', 'i', 'm'];

  function onPageKey(e) {
    if (!S.recorded) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && t.nodeType === 1 && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const key = e.key || '';
    let blocked = SCROLL_KEYS.indexOf(key) >= 0;
    if (!blocked && key.length === 1) blocked = LAYOUT_KEYS.indexOf(key.toLowerCase()) >= 0;
    // 全屏状态下 Esc 会退出全屏并改变布局（与 guard.js 行为一致）
    if (!blocked && key === 'Escape' && document.fullscreenElement) blocked = true;
    if (blocked) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** 打开框选状态时按 Esc 退出选择器（录制中 / 录制启动请求进行中不响应） */
  function onCancelKey(e) {
    if (!S.active || S.recorded || S.starting) return;
    if ((e.key || '') !== 'Escape') return;
    destroy();
  }

  function destroy() {
    S.active = false;
    S.pageLocked = false;
    S.starting = false;
    unbind();
    if (S.root && S.root.parentNode) S.root.parentNode.removeChild(S.root);
    S.root = null;
    S.rect = null;
    S.effRect = null;
    S.prevRect = null;
    S.recorded = false;
    window.dispatchEvent(new CustomEvent('YR_CLEAR_CUSTOM_RECT'));
  }

  window.YRSelector = {
    /** 选择器是否处于打开状态（快捷键据此让位，避免抢走框选态的按键） */
    isActive: () => S.active,
    start: () => {
      if (S.active) return;
      S.active = true;
      loadCropOffset(); // 画面微调 → 控件安全间距（异步，点击开始时通常已就绪）
      buildDom();
      updateLayout();
      addL(S.root, 'mousedown', onMouseDown);
      addL(window, 'mousemove', onMouseMove);
      addL(window, 'mouseup', onMouseUp);
      addL(window, 'resize', updateLayout);
      addL(window, 'keydown', onCancelKey, true); // Esc 取消（捕获阶段优先于页面快捷键）
      addL(S.btnStart, 'click', (e) => { e.stopPropagation(); startRecording(); });
      addL(S.btnCancel, 'click', (e) => { e.stopPropagation(); cancelSelection(); });
      addL(S.btnStop, 'click', (e) => { e.stopPropagation(); stopRecording(); });
    },
    destroy
  };

  // 监听录制状态变化，如果录制被外部停止（比如在 popup 停止），销毁选择器
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'REC_STATE' && msg.phase === 'idle') {
      if (S.active) destroy();
    }
  });

})();
