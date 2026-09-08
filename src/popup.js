/**
 * popup —— 录制控制台（扩展图标弹窗）
 *
 * 【为什么控件放在 popup 里】
 * `chrome.tabCapture` 捕获的是整个标签页的合成画面，任何注入到页面里的浮层
 * （面板 / 模态框 / 加载遮罩 / toast）都会被合成进捕获帧、出现在最终视频中。
 * popup 是扩展自己的页面，不属于被捕获标签页的渲染内容，因此画面永远干净。
 *
 * 交互约定：
 * - popup 可能因失焦关闭，录制状态以 background 为准：
 *   打开时回查 `YR_GET_STATE`；存活期间监听广播实时刷新；关掉再打开也能继续「停止并保存」。
 * - 开始 / 停止均由用户点击触发（满足 tabCapture 的用户手势约束）。
 */
(() => {
  'use strict';

  /** 状态文案（对应 offscreen 广播的 phase） */
  const PHASE_TEXT = {
    idle: '空闲',
    countdown: '即将开始录制',
    capturing: '正在准备捕获…',
    recording: '正在录制',
    stopping: '正在组装视频…',
    exported: '正在保存到本地…',
    error: '录制失败',
  };

  /** MP4 能力探测候选（与 offscreen.js 的 mp4 段保持一致） */
  const MP4_MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.4d401f,mp4a.40.2',
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4',
  ];

  const els = {
    dot: document.getElementById('yr-dot'),
    state: document.getElementById('yr-state'),
    timer: document.getElementById('yr-timer'),
    primary: document.getElementById('yr-primary'),
    select: document.getElementById('yr-select'),
    reset: document.getElementById('yr-reset'),
    settings: document.getElementById('yr-settings'),
    hkHint: document.getElementById('yr-hk-hint'),
    tip: document.getElementById('yr-tip'),
    error: document.getElementById('yr-error'),
    offsetX: document.getElementById('yr-offset-x'),
    offsetY: document.getElementById('yr-offset-y'),
  };

  /** 画面微调（裁剪框偏移）在 storage.sync 中的键 */
  const OFFSET_KEYS = ['yrOffsetX', 'yrOffsetY'];

  /** 当前标签页 id */
  let tabId = null;
  /** content script 是否就绪（能 ping 通 = 已注入且确为受支持的视频页） */
  let tabReady = false;
  /** 当前站点 id（'youtube' / 'bilibili' / 'dailymotion' / 'vimeo' / 'instagram' / 'facebook' / 'tiktok'，由页面 content 的 YR_PING 回执上报） */
  let siteId = '';
  /** background 侧状态 */
  let state = {
    phase: 'idle',
    startedAt: 0,
    durationMs: 0,
    error: null,
    notice: '',
    countdownSec: 0,
    countdownEndsAt: 0,
  };
  /** 是否展示「强制复位」按钮（残留会话 / 启动失败时） */
  let showReset = false;
  /** 计时刷新定时器 */
  let tickTimer = null;
  /** 「开始 / 停止录制」快捷键配置（由 shared/hotkey.js 统一读写） */
  let hotkey = window.YRHotkey ? window.YRHotkey.normalize(window.YRHotkey.DEFAULT_COMBO) : null;
  /** 「开始录制前倒计时」秒数（由 shared/countdown.js 统一读写） */
  let countdownSec = window.YRCountdown ? window.YRCountdown.DEFAULT : 0;

  /** 当前环境能否原生录制 MP4（H.264/AAC） */
  const mp4Supported = detectMp4();

  function detectMp4() {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return false;
    for (const candidate of MP4_MIME_CANDIDATES) {
      try {
        if (MediaRecorder.isTypeSupported(candidate)) return true;
      } catch (err) {
        /* 继续探测 */
      }
    }
    return false;
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return m + ':' + s;
  }

  /** 倒计时剩余秒数（页面浮层与弹窗读的是同一个结束时间戳） */
  function countdownLeft() {
    const endsAt = Number(state.countdownEndsAt) || 0;
    if (!endsAt) return 0;
    return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  }

  /** 发消息给 background（无响应时返回空对象，绝不抛错） */
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) resolve({});
          else resolve(resp || {});
        });
      } catch (err) {
        resolve({});
      }
    });
  }

  /** 发消息给页面 content script（带超时兜底） */
  function sendToTab(id, msg, timeout) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      try {
        chrome.tabs.sendMessage(id, msg, (resp) => {
          if (chrome.runtime.lastError) finish(null);
          else finish(resp || null);
        });
      } catch (err) {
        finish(null);
      }
      window.setTimeout(() => finish(null), timeout || 1500);
    });
  }

  // ===================== 渲染 =====================

  function render() {
    const phase = state.phase || 'idle';
    const recording = phase === 'recording';
    const counting = phase === 'countdown';
    const busy = phase === 'capturing' || phase === 'stopping' || phase === 'exported';

    els.state.textContent = PHASE_TEXT[phase] || PHASE_TEXT.idle;
    els.dot.className = 'yr-dot yr-dot-' + phase;

    // 计时：倒计时态读剩余秒数，录制中走实时，其它态展示上一次录制时长
    if (counting) {
      const left = countdownLeft();
      els.timer.hidden = false;
      els.timer.textContent = '倒计时 ' + left + 's';
    } else {
      const elapsed = recording && state.startedAt ? Date.now() - state.startedAt : state.durationMs || 0;
      els.timer.hidden = !elapsed;
      els.timer.textContent = formatClock(elapsed);
    }

    // 主按钮：空闲可开始 / 倒计时中可取消 / 录制中可停止 / 处理中禁用
    els.primary.classList.toggle('yr-btn-stop', recording);
    els.primary.classList.toggle('yr-btn-cancel', counting);
    if (counting) {
      const left = countdownLeft();
      els.primary.textContent = '取消倒计时' + (left > 0 ? '（' + left + 's）' : '');
      els.primary.disabled = false;
      if (els.select) els.select.hidden = true;
    } else if (recording) {
      els.primary.textContent = '停止并保存';
      els.primary.disabled = false;
      if (els.select) els.select.hidden = true;
    } else if (busy) {
      els.primary.textContent = '处理中…';
      els.primary.disabled = true;
      if (els.select) els.select.hidden = true;
    } else {
      els.primary.textContent = '开始录制';
      els.primary.disabled = !tabReady;
      if (els.select) {
        els.select.hidden = false;
        els.select.disabled = !tabReady;
      }
    }

    els.reset.hidden = !showReset;

    // 录制中优先展示录制提示与「停止并保存」：即使当前打开的是另一个标签页，
    // 也必须能停止（停止是全局广播，不依赖当前页）
    if (counting) {
      els.tip.textContent =
        '页面正中央已显示倒计时，归零后才开始捕获（倒计时本身不会被录进视频）。' +
        '趁这几秒把鼠标移开、切换全屏或调整播放器；' +
        (hotkey && hotkey.enabled && hotkey.key
          ? '反悔可再按一次快捷键 ' + window.YRHotkey.format(hotkey) + '、按 Esc 或'
          : '反悔可按 Esc 或') +
        '点上面的「取消倒计时」。';
    } else if (recording) {
      els.tip.textContent =
        '录制中：页面已被遮罩锁定（视频播放控制可用，但请勿滚动页面 / 点击视频以外的元素），请保持该标签页可见、不要缩放窗口；结束请' +
        (hotkey && hotkey.enabled && hotkey.key
          ? '按快捷键 ' + window.YRHotkey.format(hotkey) + ' 或'
          : '') +
        '点「停止并保存」。';
    } else if (!tabReady) {
      els.tip.textContent = '请打开 YouTube、Bilibili（B 站）、Dailymotion、Vimeo、Instagram、Facebook 或 TikTok 的视频播放页（首次打开需刷新一次页面），再点击「开始录制」。';
    } else {
      els.tip.textContent =
        '录制播放器区域画面与音频，' +
        (mp4Supported ? '输出 MP4。' : '当前环境不支持原生 MP4，将输出 WebM。') +
        (countdownSec > 0
          ? '开始后先在页面上倒计时 ' + countdownSec + ' 秒再录制（可在设置中调整）。'
          : '点击「开始录制」后立即开始（可在设置中开启倒计时）。');
    }

    const err = phase === 'error' ? state.error : null;
    if (err) {
      els.error.hidden = false;
      els.error.className = 'yr-error';
      els.error.textContent = (err.title ? err.title + '\n' : '') + (err.message || '');
    } else if (state.notice) {
      els.error.hidden = false;
      els.error.className = 'yr-error yr-notice';
      els.error.textContent = state.notice;
    } else {
      els.error.hidden = true;
    }
  }

  // ===================== 画面微调（裁剪框偏移校准） =====================
  //
  // 裁剪坐标由「捕获帧尺寸 ÷ 视口 CSS 尺寸」实测换算（见 offscreen.js 的 mapRectToFrame），
  // 个别环境（异常缩放组合、多显示器混插等）仍可能存在固定偏差，这里提供人工微调入口。

  function readOffsetInputs() {
    return {
      yrOffsetX: Number(els.offsetX && els.offsetX.value) || 0,
      yrOffsetY: Number(els.offsetY && els.offsetY.value) || 0,
    };
  }

  function saveOffsets() {
    try {
      chrome.storage.sync.set(readOffsetInputs());
    } catch (err) {
      /* 存储不可用：不影响录制 */
    }
  }

  async function loadOffsets() {
    const data = await new Promise((resolve) => {
      try {
        chrome.storage.sync.get(OFFSET_KEYS, resolve);
      } catch (err) {
        resolve({});
      }
    });
    if (els.offsetX) els.offsetX.value = String(Number(data && data.yrOffsetX) || 0);
    if (els.offsetY) els.offsetY.value = String(Number(data && data.yrOffsetY) || 0);
  }

  if (els.offsetX) els.offsetX.addEventListener('change', saveOffsets);
  if (els.offsetY) els.offsetY.addEventListener('change', saveOffsets);

  // ===================== 录制快捷键 / 设置模态框 =====================
  //
  // 快捷键在视频播放页内生效（content/hotkey.js），配置存在 storage.sync：
  // 改完即时生效，无需刷新页面。模态框与主界面的文案共用同一份配置。

  function renderHotkeyHint() {
    if (!els.hkHint || !window.YRHotkey) return;
    if (!hotkey || !hotkey.enabled || !hotkey.key) {
      els.hkHint.hidden = true;
      return;
    }
    els.hkHint.hidden = false;
    els.hkHint.textContent = '快捷键 ' + window.YRHotkey.format(hotkey) + '：开始 / 停止录制';
  }

  async function loadHotkey() {
    if (!window.YRHotkey) return;
    hotkey = await window.YRHotkey.read();
    renderHotkeyHint();
  }

  async function loadCountdown() {
    if (!window.YRCountdown) return;
    countdownSec = await window.YRCountdown.read();
  }

  if (els.settings) {
    els.settings.addEventListener('click', () => {
      if (window.YRSettings) window.YRSettings.open();
    });
  }

  // ===================== 状态同步 =====================

  async function refreshState() {
    const resp = await send({ type: 'YR_GET_STATE' });
    if (resp && resp.state) {
      state = Object.assign(
        {
          phase: 'idle',
          startedAt: 0,
          durationMs: 0,
          error: null,
          notice: '',
          countdownSec: 0,
          countdownEndsAt: 0,
        },
        resp.state
      );
    }
  }

  async function detectTab() {
    const tabs = await new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, resolve);
      } catch (err) {
        resolve([]);
      }
    });
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.id !== 'number') {
      tabReady = false;
      return;
    }
    tabId = tab.id;
    const ping = await sendToTab(tabId, { type: 'YR_PING' }, 1200);
    tabReady = !!(ping && ping.ok);
    if (ping && ping.site) siteId = ping.site; // content 回执带上当前站点（youtube / bilibili / dailymotion / vimeo / instagram / facebook / tiktok）
  }

  // ===================== 用户操作 =====================

  /** 取消倒计时：撤掉页面浮层并回到空闲（不会开始录制） */
  async function doCancelCountdown() {
    els.primary.disabled = true;
    await send({ type: 'YR_CANCEL_COUNTDOWN' });
    await refreshState();
    render();
  }

  async function doStart() {
    showReset = false;
    // 乐观置为「准备中」：启动握手可能持续数秒，避免按钮看起来没反应
    state.phase = countdownSec > 0 ? 'countdown' : 'capturing';
    // 倒计时态先给一个乐观的结束时刻，等 background 回执后再按真实值刷新
    state.countdownEndsAt = countdownSec > 0 ? Date.now() + countdownSec * 1000 : 0;
    state.error = null;
    state.notice = '';
    render();
    // 兜底超时：极端情况下（SW 被回收等）也要把按钮还给用户可以重试
    const resp = await Promise.race([
      send({ type: 'YR_START', tabId, site: siteId }),
      new Promise((resolve) => window.setTimeout(() => resolve(null), 15000)),
    ]);
    await refreshState();
    if (resp && resp.busy) {
      // 残留会话占用：不自动丢弃用户数据，给出「强制复位」入口
      showReset = true;
      state.notice = '检测到尚未结束的录制会话（' + (resp.phase || '未知') + '）。可点击「强制复位并重新开始」放弃残留数据。';
      render();
      return;
    }
    if (resp && resp.ok === false) {
      showReset = true;
      state.error = { title: '无法开始录制', message: resp.message || '离屏录制进程不可用，请刷新页面后重试。' };
      state.phase = 'error';
    } else if (!resp) {
      // 超时且状态仍停在准备中：给出明确错误，避免界面卡在「准备中」
      if ((state.phase || 'idle') === 'capturing') {
        showReset = true;
        state.error = { title: '无法开始录制', message: '启动请求超时，请刷新页面后重试。' };
        state.phase = 'error';
      }
    }
    render();
    // 「开始录制」已被 background 受理（倒计时启动 / 立即捕获均返回 ok:true）→ 自动关闭主界面，
    // 把页面让出来：倒计时卡片与录制锁定遮罩都在页面上，弹窗继续留着只会遮挡准备动作
    // （与「框选录制」点击后关闭弹窗的交互一致）。
    // 注：YR_START 消息在 await 之前已同步发出，关闭后启动握手继续由 background / 离屏完成，
    // popup 可随时重新打开查看与停止；失败 / 残留占用 / 超时场景则保留弹窗就地提示。
    if (resp && resp.ok === true) window.close();
  }

  async function doStop() {
    els.primary.disabled = true;
    await send({ type: 'YR_STOP' });
    await refreshState();
    render();
  }

  els.primary.addEventListener('click', () => {
    const phase = state.phase || 'idle';
    if (phase === 'recording') doStop();
    else if (phase === 'countdown') doCancelCountdown();
    else doStart();
  });

  els.select.addEventListener('click', () => {
    if (!tabId) return;
    // 必须在关闭弹窗之前同步发出消息：popup 一旦关闭其脚本环境随即销毁，
    // 若先 window.close() 再异步发送，消息可能根本没机会发出，表现为页面毫无反应。
    try {
      chrome.tabs.sendMessage(tabId, { type: 'YR_SELECT_REGION' }, () => {
        /* popup 即将关闭，无需处理回执（含 lastError） */
      });
    } catch (err) {
      /* ignore */
    }
    window.close(); // 关闭弹窗，让出页面给框选遮罩
  });

  els.reset.addEventListener('click', async () => {
    els.reset.disabled = true;
    await send({ type: 'YR_RESET' });
    // 等离屏完成复位（广播无回执，固定等待片刻后重试）
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    els.reset.disabled = false;
    showReset = false;
    await doStart();
  });

  // ===================== 实时广播 =====================

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return;
    if (
      message.type === 'REC_STATE' ||
      message.type === 'DOWNLOAD_RESULT' ||
      message.type === 'UI_ACTION'
    ) {
      // background / offscreen 广播：回查最新状态后重绘
      refreshState().then(render);
    }
  });

  // ===================== 初始化 =====================

  (async function init() {
    await loadOffsets();
    await loadHotkey();
    await loadCountdown();
    await detectTab();
    await refreshState();
    render();
    // 在设置里改了快捷键 / 倒计时 → 主界面提示即时刷新（页面侧由 content 自行同步）
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (window.YRHotkey && changes[window.YRHotkey.STORAGE_KEY]) {
          hotkey = window.YRHotkey.normalize(changes[window.YRHotkey.STORAGE_KEY].newValue);
          renderHotkeyHint();
          render();
        }
        if (window.YRCountdown && changes[window.YRCountdown.KEY]) {
          countdownSec = window.YRCountdown.normalize(changes[window.YRCountdown.KEY].newValue);
          render();
        }
      });
    } catch (err) {
      /* 忽略：storage 不可用则维持初始配置 */
    }
    // 录制中 / 倒计时中每 500ms 刷新一次计时；其它态由广播驱动刷新
    tickTimer = window.setInterval(() => {
      const phase = state.phase || 'idle';
      if (phase === 'recording' || phase === 'countdown') render();
    }, 500);
  })();

  window.addEventListener('unload', () => {
    if (tickTimer) window.clearInterval(tickTimer);
  });
})();
