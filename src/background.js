/**
 * background service worker（manifest 3.4）
 *
 * 职责（见 DESIGN.md 2.2）：
 * - 创建 / 关闭 offscreen document（录制核心宿主）。
 * - 承接 popup（扩展图标弹窗）的开始 / 停止 / 复位指令。
 * - 维护全局录制状态（含 storage.session 持久化）与 chrome.action 徽标，
 *   供随时开关的 popup 回查 —— 页面内不再注入任何 UI，画面中不会出现扩展控件。
 * - 转发 content 的播放器矩形心跳给离屏，转发离屏广播（REC_STATE 等）的状态到本地。
 * - 监听 REC_STATE idle（全链路复位）→ 回收 offscreen 资源。
 *
 * 说明：录制媒体逻辑放在 offscreen.js，但 tabCapture 的正确入口放在本文件。
 * MV3 中稳定做法是：service worker 在用户手势链路内调用
 * chrome.tabCapture.getMediaStreamId()，再把 streamId 交给 offscreen document
 * 通过 getUserMedia 消费。REC_START 由 popup 以 YR_START 请求发起，
 * 本文件确保离屏存在并转发带 streamId 的 REC_START（带回执）；REC_STOP /
 * PLAYER_RECT 等仍为广播消息由 offscreen 直接消费；REC_STATE idle 触发离屏回收。
 */
(() => {
  'use strict';

  const OFFSCREEN_URL = 'offscreen.html';
  const OFFSCREEN_REASON = 'USER_MEDIA';

  /** 离屏创建中的 Promise（防重复 createDocument 竞态） */
  let ensurePromise = null;
  /** 延迟关闭定时器：会话结束后留 ~5s 复用窗口，避免紧邻操作反复重建 */
  let closeTimer = null;
  /**
   * 等待离屏就绪后再转发 REC_START 的队列（元素为 content 传来的 sendResponse）。
   * 离屏文档刚创建、脚本尚未注册监听时，广播消息会丢失，因此先入队，
   * 等 OFFSCREEN_READY 到达后再逐个补发，杜绝「点开始无回执 → 误报占用」。
   */
  const pendingStartResponders = [];

  /** 启动请求重发节奏：离屏脚本尚未注册监听时消息会丢失，重发保证至少一次生效 */
  const START_FORWARD_INTERVAL_MS = 1500;
  const START_FORWARD_MAX = 6;

  /** 当前录制关联的标签页 ID（用于路由离屏广播给 content script） */
  let activeTabId = null;

  // ===================== 全局状态（popup 查询 + 图标徽标） =====================
  //
  // 录制控件已全部迁移到扩展图标弹窗（页面内不再注入任何 DOM，保证画面干净），
  // 而弹窗会因失焦关闭，故状态由本文件统一维护：
  // · 内存态供即时查询；· storage.session 持久化，SW 重启后弹窗仍能看到真实状态；
  // · chrome.action 徽标提供「无需打开弹窗」的录制状态提示。
  const STATE_KEY = 'yrState';
  const TAB_KEY = 'yrActiveTabId';

  /** 最近一次已知状态 */
  let yrState = {
    phase: 'idle', // idle | countdown | capturing | recording | stopping | exported | error
    startedAt: 0, // 进入 recording 的时刻（弹窗据此计时）
    durationMs: 0, // 最近一次录制时长（结束后保留展示）
    error: null, // { title, message }
    notice: '', // 最近一条提示文案（toast / 模态框）
    countdownSec: 0, // 倒计时总秒数（仅 countdown 阶段有效）
    countdownEndsAt: 0, // 倒计时结束时间戳（弹窗据此显示剩余秒数）
    updatedAt: 0,
  };

  /** 图标徽标：不用打开弹窗也能看到当前状态 */
  const BADGE_BY_PHASE = {
    idle: { text: '', color: '#1a73e8' },
    countdown: { text: '···', color: '#f29900' },
    capturing: { text: '···', color: '#8a8a8a' },
    recording: { text: 'REC', color: '#e62117' },
    stopping: { text: '···', color: '#8a8a8a' },
    exported: { text: 'OK', color: '#188038' },
    error: { text: '!', color: '#e62117' },
  };

  // ===================== 录制状态指示（系统通知） =====================
  //
  // 全屏（HTML fullscreen）播放时页面内没有任何可见标识（见 DESIGN.md 阶段十），
  // 系统通知浮在全屏之上、不属于被捕获标签页 → 不会入画。录制中保持一条常驻通知
  // 作为「正在录制」的跨全屏指示，并提供一个「停止并保存」按钮兜底停止入口；
  // 保存成功 / 失败再发一条一次性通知回执。开关为 storage.sync 的 yrIndNotif（默认开）。
  const NOTIF_REC_ID = 'yr-recording';
  const NOTIF_RESULT_ID = 'yr-result';
  /** 系统通知开关缓存（默认开；启动与 storage.onChanged 时刷新） */
  let notifOn = true;

  function notifIcon() {
    return chrome.runtime.getURL('icons/icon128.png');
  }

  function refreshNotifPref() {
    try {
      chrome.storage.sync.get('yrIndNotif', (data) => {
        if (data && typeof data.yrIndNotif === 'boolean') notifOn = data.yrIndNotif;
      });
    } catch (err) {
      /* storage 不可用：维持默认开启 */
    }
  }

  function createNotif(id, options) {
    if (!notifOn) return;
    try {
      if (!options.iconUrl) options.iconUrl = notifIcon();
      chrome.notifications.create(id, options, () => void chrome.runtime.lastError);
    } catch (err) {
      /* 通知不可用不影响主流程 */
    }
  }

  function clearNotif(id) {
    try {
      chrome.notifications.clear(id, () => void chrome.runtime.lastError);
    } catch (err) {
      /* ignore */
    }
  }

  /** 录制中常驻通知（全屏场景的「正在录制」指示） */
  function showRecordingNotif() {
    createNotif(NOTIF_REC_ID, {
      type: 'basic',
      title: '正在录制 YouTube 视频',
      message: '全屏观看时本通知保持可见；完成后视频自动保存到下载目录。',
      contextMessage: 'YouTube Recorder',
      requireInteraction: true,
      priority: 1,
      buttons: [{ title: '停止并保存' }],
    });
  }

  /** 保存完成 / 失败的一次性结果通知 */
  function showResultNotif(ok, message) {
    createNotif(NOTIF_RESULT_ID, {
      type: 'basic',
      title: ok ? '录制完成 · 视频已保存' : '录制完成 · 保存失败',
      message: message || (ok ? '视频已保存到下载目录。' : '未能保存文件，请检查浏览器下载设置。'),
      contextMessage: 'YouTube Recorder',
      requireInteraction: false,
    });
  }

  /** 启动时的状态水合（SW 可能已被回收重建，内存变量会丢失） */
  const hydration = (async () => {
    try {
      if (!chrome.storage || !chrome.storage.session) return;
      const data = await chrome.storage.session.get([STATE_KEY, TAB_KEY]);
      if (data && data[STATE_KEY]) yrState = Object.assign(yrState, data[STATE_KEY]);
      if (data && typeof data[TAB_KEY] === 'number') activeTabId = data[TAB_KEY];
    } catch (err) {
      /* 读取失败：保持内存默认值 */
    }
  })();

  // SW 重启后若仍在录制：恢复常驻通知（用户在全屏时依然能看到录制指示）
  hydration
    .catch(() => {})
    .then(() => {
      if (yrState.phase === 'recording') showRecordingNotif();
      // SW 重启后倒计时已失去驱动（计时在页面侧，SW 侧无法续跑）：回到空闲，
      // 由用户重新点击开始，绝不静默替用户启动捕获。
      if (yrState.phase === 'countdown') setPhase('idle', { error: null, notice: '' });
    });

  function persistState() {
    yrState.updatedAt = Date.now();
    if (!chrome.storage || !chrome.storage.session) return;
    chrome.storage.session.set({ [STATE_KEY]: yrState, [TAB_KEY]: activeTabId }).catch(() => {});
  }

  function updateBadge(phase) {
    try {
      const b = BADGE_BY_PHASE[phase] || BADGE_BY_PHASE.idle;
      chrome.action.setBadgeText({ text: b.text });
      chrome.action.setBadgeBackgroundColor({ color: b.color });
    } catch (err) {
      /* 徽标不可用不影响主流程 */
    }
  }

  /**
   * 统一状态变更入口：维护录制时长、图标徽标、系统通知（常驻「正在录制」）
   * 与持久化，并把最新 phase 广播给录制标签页的 content（全屏 PiP 状态窗据此刷新）。
   */
  function setPhase(phase, extra) {
    const prev = yrState.phase;
    if (prev === 'recording' && phase !== 'recording') {
      yrState.durationMs = yrState.startedAt ? Date.now() - yrState.startedAt : 0;
    }
    if (phase === 'recording' && prev !== 'recording') {
      yrState.startedAt = Date.now();
      showRecordingNotif();
    } else if (prev === 'recording' && phase !== 'recording') {
      clearNotif(NOTIF_REC_ID);
    }
    if (phase === 'idle' || phase === 'error') yrState.startedAt = 0;
    // 倒计时字段只在 countdown 阶段有意义，离开该阶段即清零（弹窗据此停止读秒）
    if (phase !== 'countdown') {
      yrState.countdownSec = 0;
      yrState.countdownEndsAt = 0;
    }
    yrState.phase = phase;
    if (extra) Object.assign(yrState, extra);
    updateBadge(phase);
    persistState();
    syncPipStateToTab();
  }

  /** 通知 content 开启 / 关闭播放器矩形心跳上报 */
  function setRectReport(on) {
    if (typeof activeTabId !== 'number') return;
    chrome.tabs.sendMessage(activeTabId, { type: on ? 'YR_RECT_ON' : 'YR_RECT_OFF' }).catch(() => {});
  }

  /**
   * 把最新录制 phase 广播给录制标签页的 content：
   * 全屏 PiP 状态窗（content/pip.js）据此显示「正在启动 / 录制计时 / 正在保存 / 结束」。
   */
  function syncPipStateToTab() {
    if (typeof activeTabId !== 'number') return;
    chrome.tabs
      .sendMessage(activeTabId, {
        type: 'YR_PIP_STATE',
        phase: yrState.phase,
        startedAt: yrState.startedAt,
        durationMs: yrState.durationMs,
        countdownEndsAt: yrState.countdownEndsAt || 0,
      })
      .catch(() => {});
  }

  /** 解析目标标签页：popup 显式传入优先，否则取当前窗口激活页 */
  function resolveTabId(explicit) {
    if (typeof explicit === 'number') return Promise.resolve(explicit);
    return new Promise((resolve, reject) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs && tabs[0];
          if (tab && typeof tab.id === 'number') resolve(tab.id);
          else reject(new Error('未找到当前标签页，无法开始录制。'));
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round((ms || 0) / 1000));
    return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
  }

  /** 下载结果：成功提示 / 失败报错（本地监听与离屏失败广播共用同一处理） */
  function applyDownloadResult(message) {
    setRectReport(false);
    if (message && message.ok) {
      const notice = '视频已保存到下载目录（时长 ' + formatDuration(yrState.durationMs) + '）。';
      setPhase('idle', { error: null, notice });
      showResultNotif(true, notice);
    } else {
      const detail = (message && message.message) || '未能保存文件，请检查浏览器下载设置。';
      setPhase('error', { error: { title: '保存失败', message: detail } });
      showResultNotif(false, detail);
    }
  }

  // ===================== offscreen 生命周期 =====================

  function ensureOffscreen() {
    if (ensurePromise) return ensurePromise;
    ensurePromise = doEnsureOffscreen().finally(() => {
      ensurePromise = null;
    });
    return ensurePromise;
  }

  async function doEnsureOffscreen() {
    let has = false;
    try {
      has = await chrome.offscreen.hasDocument();
    } catch (err) {
      has = false;
    }
    if (has) {
      // 已有文档：取消挂起的延迟关闭（会话复用）
      console.log('[YR-bg] 离屏文档已存在（复用），取消延迟关闭');
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      return;
    }
    console.log('[YR-bg] 创建离屏文档…');
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [OFFSCREEN_REASON],
        justification: '承载 chrome.tabCapture 捕获、canvas 裁剪与 MediaRecorder 录制（录制仅由用户点击触发）',
      });
      console.log('[YR-bg] createDocument 成功');
    } catch (err) {
      // 创建失败：广播 error（content 面板收到后复位），并拒绝排队中的启动请求
      const message = String((err && err.message) || err);
      chrome.runtime.sendMessage({
        type: 'REC_STATE',
        phase: 'error',
        payload: { title: '离屏文档创建失败', message, ui: 'modal' },
      });
      failPendingStartResponders(message);
      throw err; // 让发起方（startRecording）收到明确失败回执，避免空等超时
    }
  }

  function scheduleCloseOffscreen() {
    if (closeTimer) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      closeOffscreen();
    }, 5000);
  }

  async function closeOffscreen() {
    try {
      const has = await chrome.offscreen.hasDocument();
      if (has) await chrome.offscreen.closeDocument();
    } catch (err) {
      /* 忽略：关闭失败不影响主流程 */
    }
  }

  // ===================== 启动握手（popup 的 YR_START） =====================

  /** 读取 storage.session 中的启动意图（含 streamId） */
  function getPendingStart() {
    if (!chrome.storage || !chrome.storage.session) return Promise.resolve(null);
    return chrome.storage.session
      .get('yrPendingStart')
      .then((res) => res && res.yrPendingStart)
      .catch(() => null);
  }

  /** 写入启动意图到 storage.session（会话级，SW 重启不丢） */
  function setPendingStart(value) {
    if (!chrome.storage || !chrome.storage.session) return Promise.resolve();
    console.log('[YR-bg] 写入 storage.session 启动意图');
    return chrome.storage.session.set({ yrPendingStart: value }).catch(() => {});
  }

  /** 离屏创建失败：统一拒绝所有排队中的启动回执 */
  function failPendingStartResponders(message) {
    while (pendingStartResponders.length) {
      const respond = pendingStartResponders.shift();
      try {
        respond({ ok: false, code: 'offscreen-error', message: String(message || '离屏文档不可用') });
      } catch (err) {
        /* 发起方已离开：忽略 */
      }
    }
  }

  /**
   * YR_START 主流程：
   * 1. 先生成并持久化当前标签页的 streamId —— 即使消息在离屏初始化阶段丢失，
   *    也能在 OFFSCREEN_READY 队列补发时复用同一个 streamId；
   * 2. 确保离屏文档存在（无则创建）；
   * 3. 立即向离屏转发 REC_START 并等待回执（离屏已就绪时的快速通道）。
   * 每次点击开始都会有明确答复（已受理 / 占用 / 离屏不可用），不再让 content 空等超时。
   */
  function startRecording(tabId, respond, streamId) {
    // 回执只回一次：重发 / 队列补发 / 超时兜底可能同时到达
    let replied = false;
    const once = (payload) => {
      if (replied) return;
      replied = true;
      if (payload && !payload.ok) {
        setPhase('error', {
          error: { title: '无法开始录制', message: payload.message || '录制启动失败，请刷新页面重试。' },
        });
        setRectReport(false);
      }
      try {
        respond(payload);
      } catch (err) {
        /* 发起方已离开：忽略 */
      }
    };

    const promise = streamId 
      ? Promise.resolve({ createdAt: Date.now(), streamId, tabId })
      : ensurePendingStart(tabId);

    promise
      .then((pendingStart) => ensureOffscreen().then(() => pendingStart))
      .then((pendingStart) => {
        let attempt = 0;
        const handleReply = (resp) => {
          if (resp && resp.ok) {
            once(resp);
            return;
          }
          // busy(preparing)：离屏确实已在准备中（可能由 storage.session 自查自启），
          // 继续等待 capturing / recording 广播，不打断也不误报「残留会话」
          if (resp && resp.busy && resp.phase === 'preparing') return;
          once(resp || { ok: false, code: 'unknown', message: '离屏未确认录制启动' });
        };

        const timer = setInterval(() => {
          if (replied) {
            clearInterval(timer);
            return;
          }
          attempt += 1;
          if (attempt > START_FORWARD_MAX) {
            clearInterval(timer);
            once({ ok: false, code: 'timeout', message: '离屏录制进程长时间无响应，请刷新页面后重试。' });
            return;
          }
          forwardStartToOffscreen(handleReply, pendingStart);
        }, START_FORWARD_INTERVAL_MS);

        forwardStartToOffscreen(handleReply, pendingStart); // 立即发第一次
      })
      .catch((err) => {
        once({ ok: false, code: 'offscreen-error', message: String((err && err.message) || err) });
      });
  }

  /** 确保当前标签页已有可复用的 streamId 启动意图 */
  async function ensurePendingStart(tabId) {
    if (typeof tabId !== 'number') {
      throw new Error('未找到当前标签页，无法开始录制。');
    }

    const existing = await getPendingStart();
    if (existing && existing.streamId && existing.tabId === tabId) {
      console.log('[YR-bg] 复用现有启动意图');
      return existing;
    }

    const streamId = await getTabMediaStreamId(tabId);
    const next = { createdAt: Date.now(), streamId, tabId };
    await setPendingStart(next);
    return next;
  }

  /** 在用户手势链路内生成当前标签页的 streamId */
  function getTabMediaStreamId(tabId) {
    return new Promise((resolve, reject) => {
      try {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || '无法获取标签页流 ID'));
            return;
          }
          if (!streamId) {
            reject(new Error('浏览器未返回可用的标签页流 ID'));
            return;
          }
          resolve(streamId);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /** 清除启动意图（离屏已响应本次请求 / begin 已消费时调用） */
  function clearPendingStart() {
    try {
      if (chrome.storage && chrome.storage.session) chrome.storage.session.remove('yrPendingStart');
    } catch (err) {
      /* ignore */
    }
  }

  function forwardStartToOffscreen(respond, pendingStartOverride) {
    Promise.resolve(pendingStartOverride || getPendingStart())
      .then((pendingStart) => {
        if (!pendingStart || !pendingStart.streamId) {
          throw new Error('缺少可用的标签页流启动信息，请重新点击「开始录制」。');
        }
        chrome.runtime.sendMessage({ type: 'REC_START', streamId: pendingStart.streamId, tabId: pendingStart.tabId }, (resp) => {
          if (chrome.runtime.lastError) {
            // 离屏尚在加载、无监听方：消息已丢失。streamId 已保存在 storage.session，
            // 等 OFFSCREEN_READY 后再补发同一条启动请求。
            console.log('[YR-bg] 离屏未就绪（lastError），依赖 streamId 持久化与 READY 队列双兜底');
            pendingStartResponders.push(respond);
            return;
          }
          // 离屏已响应（ok / busy）→ 本次意图已被消费，清除 storage 标记
          clearPendingStart();
          try {
            if (resp && (resp.ok || resp.busy)) respond(resp);
            else respond({ ok: false, code: 'unknown', message: '离屏未确认录制启动' });
          } catch (err) {
            /* 发起方已离开：忽略 */
          }
        });
      })
      .catch((err) => {
        try {
          respond({ ok: false, code: 'stream-id-error', message: String((err && err.message) || err) });
        } catch (e) {
          /* ignore */
        }
      });
  }

  /** OFFSCREEN_READY：离屏脚本已就绪，逐个补发排队中的启动请求 */
  function flushPendingStarts() {
    getPendingStart().then((pendingStart) => {
      while (pendingStartResponders.length) {
        const respond = pendingStartResponders.shift();
        forwardStartToOffscreen(respond, pendingStart);
      }
    });
  }

  /** YR_RESET：离屏若存在则广播强制复位，解除残留会话造成的启动卡死 */
  async function flushOffscreenReset() {
    try {
      const has = await chrome.offscreen.hasDocument();
      if (!has) {
        console.log('[YR-bg] 复位请求：离屏不存在，无需复位');
        return; // 离屏不存在则无需复位（下一轮启动请求会自动重建）
      }
      console.log('[YR-bg] 广播 REC_RESET 给离屏');
      chrome.runtime.sendMessage({ type: 'REC_RESET' });
    } catch (err) {
      /* 忽略：复位失败不影响主流程 */
    }
  }

  // ===================== 开始录制（弹窗点击 / 页面快捷键共用） =====================

  /**
   * 「开始录制」统一入口。
   * 关键：必须在用户手势链路内立即申请 streamId，避免异步等待导致手势丢失。
   */
  function beginRecording(targetTabId, respondStart) {
    if (!targetTabId) {
      respondStart({ ok: false, code: 'no-tab', message: '未找到当前标签页，无法开始录制。' });
      return;
    }

    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        const msg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '获取标签页流失败';
        console.error('[YR-bg] getMediaStreamId 失败:', msg);
        setPhase('error', { error: { title: '无法开始录制', message: msg } });
        respondStart({ ok: false, code: 'stream-id-error', message: msg });
        return;
      }

      console.log('[YR-bg] getMediaStreamId 成功, id=' + streamId.slice(0, 8) + '...');
      activeTabId = targetTabId;
      setRectReport(true);
      setPhase('capturing', { error: null, notice: '', durationMs: 0 });

      // 将 streamId 暂存并启动离屏录制
      const pendingStart = { createdAt: Date.now(), streamId, tabId: targetTabId };
      setPendingStart(pendingStart).then(() => {
        startRecording(targetTabId, respondStart, streamId);
      });
    });
  }

  // ===================== 开始录制前的倒计时（阶段十一） =====================
  //
  // 点「开始录制」时用户往往还没把页面调整好（鼠标压在播放器上、控制条还亮着、
  // 还没切全屏）。倒计时在**捕获开始之前**进行：页面浮层归零 → 先撤掉浮层 →
  // 再开始捕获，因此倒计时本身绝不会被录进视频。
  //
  // 由页面（content/countdown.js）驱动是刻意的：只有页面能保证「浮层已移除」与
  // 「开始捕获」的先后顺序。background 侧只保留兜底定时器与取消入口，
  // 且页面脚本不可用时直接降级为立即开始 —— 倒计时绝不能把录制卡死。

  /** 倒计时配置键与默认值（与 shared/countdown.js 保持一致；SW 不加载共享脚本） */
  const COUNTDOWN_KEY = 'yrCountdownSec';
  const COUNTDOWN_DEFAULT = 3;
  const COUNTDOWN_MIN = 0;
  const COUNTDOWN_MAX = 10;
  /** 兜底定时器相对倒计时结束的宽限（ms）：页面消息丢失时仍能开始录制 */
  const COUNTDOWN_GRACE_MS = 3000;

  /** 倒计时运行态 */
  const countdown = {
    active: false,
    tabId: null,
    endsAt: 0,
    timer: null, // 兜底定时器
    token: 0, // 每次启动自增：作废上一轮遗留的定时器与回执
  };

  /** 读取用户设置的倒计时秒数（0 = 关闭，直接开始） */
  function readCountdownSec() {
    return new Promise((resolve) => {
      try {
        if (!chrome.storage || !chrome.storage.sync) {
          resolve(COUNTDOWN_DEFAULT);
          return;
        }
        chrome.storage.sync.get(COUNTDOWN_KEY, (data) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(COUNTDOWN_DEFAULT);
            return;
          }
          const n = Number(data ? data[COUNTDOWN_KEY] : NaN);
          if (!Number.isFinite(n)) {
            resolve(COUNTDOWN_DEFAULT);
            return;
          }
          const rounded = Math.round(n);
          resolve(Math.min(COUNTDOWN_MAX, Math.max(COUNTDOWN_MIN, rounded)));
        });
      } catch (err) {
        resolve(COUNTDOWN_DEFAULT);
      }
    });
  }

  function clearCountdownTimer() {
    if (countdown.timer) {
      clearTimeout(countdown.timer);
      countdown.timer = null;
    }
  }

  /** 通知页面撤掉倒计时浮层（幂等：页面已结束时无副作用） */
  function sendCountdownCancelToTab(tabId) {
    if (typeof tabId !== 'number') return;
    chrome.tabs.sendMessage(tabId, { type: 'YR_COUNTDOWN_CANCEL' }).catch(() => {});
  }

  /** 请页面显示倒计时浮层（页面脚本不可用时返回 false，调用方降级为立即开始） */
  function requestCountdownOnTab(tabId, seconds) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      try {
        chrome.tabs.sendMessage(tabId, { type: 'YR_COUNTDOWN_START', seconds }, (resp) => {
          if (chrome.runtime.lastError) finish(false);
          else finish(!!(resp && resp.ok));
        });
      } catch (err) {
        finish(false);
      }
      // 注意：service worker 里没有 window，必须用全局 setTimeout
      setTimeout(() => finish(false), 1200);
    });
  }

  /** 进入倒计时态（页面浮层已确认显示） */
  function beginCountdown(tabId, seconds) {
    countdown.active = true;
    countdown.tabId = tabId;
    countdown.endsAt = Date.now() + seconds * 1000;
    countdown.token += 1;
    const token = countdown.token;
    activeTabId = tabId; // 让弹窗 / 全屏状态窗的广播能找到该标签页
    setPhase('countdown', {
      error: null,
      notice: '',
      durationMs: 0,
      countdownSec: seconds,
      countdownEndsAt: countdown.endsAt,
    });
    // 兜底：页面消息丢失（脚本异常 / 浮层被卸载）时也要把录制启动起来
    clearCountdownTimer();
    countdown.timer = setTimeout(() => {
      countdown.timer = null;
      if (token !== countdown.token || !countdown.active) return;
      finishCountdown(true);
    }, seconds * 1000 + COUNTDOWN_GRACE_MS);
  }

  /**
   * 倒计时结束 → 真正开始录制。
   * fallback=true 表示由兜底定时器触发：先让页面撤掉浮层并留一点余量，
   * 同时确认标签页仍然存在，避免对已关闭的页面发起录制。
   */
  function finishCountdown(fallback) {
    if (!countdown.active) return;
    const tabId = countdown.tabId;
    clearCountdownTimer();
    countdown.active = false;
    countdown.tabId = null;
    countdown.endsAt = 0;
    countdown.token += 1;

    const noop = function () {};
    if (!fallback) {
      beginRecording(tabId, noop);
      return;
    }
    sendCountdownCancelToTab(tabId);
    const start = () => beginRecording(tabId, noop);
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          setPhase('idle', { error: null, notice: '' });
          return;
        }
        setTimeout(start, 300); // 给页面撤浮层留出时间
      });
    } catch (err) {
      setTimeout(start, 300);
    }
  }

  /** 取消倒计时（用户主动取消 / 复位 / 停止）：撤掉浮层并回到空闲 */
  function cancelCountdown(notice) {
    if (!countdown.active) return false;
    const tabId = countdown.tabId;
    clearCountdownTimer();
    countdown.active = false;
    countdown.tabId = null;
    countdown.endsAt = 0;
    countdown.token += 1;
    sendCountdownCancelToTab(tabId);
    setPhase('idle', { error: null, notice: notice || '' });
    return true;
  }

  /**
   * 「开始录制」统一入口（供弹窗与页面快捷键共用）：
   * 先读用户设置的倒计时秒数，> 0 则先走页面倒计时，为 0 或页面不可用时立即开始。
   *
   * 注意：streamId 一定在倒计时结束后才申请 —— getMediaStreamId 返回的 ID
   * 「只能使用一次，未使用会在几秒钟后过期」，提前申请必然失效。
   */
  function requestStart(targetTabId, respondStart) {
    if (!targetTabId) {
      respondStart({ ok: false, code: 'no-tab', message: '未找到当前标签页，无法开始录制。' });
      return;
    }
    readCountdownSec().then((seconds) => {
      if (seconds <= 0) {
        beginRecording(targetTabId, respondStart);
        return;
      }
      requestCountdownOnTab(targetTabId, seconds).then((shown) => {
        if (!shown) {
          // 页面脚本不可用（未注入 / 需刷新）：降级为立即开始，绝不因倒计时卡住录制
          beginRecording(targetTabId, respondStart);
          return;
        }
        beginCountdown(targetTabId, seconds);
        respondStart({ ok: true, countdown: seconds, phase: 'countdown' });
      });
    });
  }

  // ===================== 消息路由 =====================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return;

    const tabId = sender.tab && sender.tab.id;

    switch (message.type) {
      case 'YR_START': {
        // popup 发起录制（扩展页无 sender.tab，tabId 由 popup 显式传入）
        // content script 发起录制（由 sender.tab.id 获取）
        const respondStart = sendResponse || function () {};
        const targetTabId = message.tabId || (sender.tab && sender.tab.id);

        console.log('[YR-bg] 收到 YR_START → tab=' + targetTabId);
        requestStart(targetTabId, respondStart);
        return true; // 异步回执
      }

      case 'YR_CANCEL_COUNTDOWN': {
        // 弹窗 / 全屏状态窗点「取消倒计时」：撤掉页面浮层并回到空闲
        console.log('[YR-bg] 收到 YR_CANCEL_COUNTDOWN');
        cancelCountdown('已取消本次录制（倒计时未结束，未开始捕获）。');
        try {
          sendResponse({ ok: true });
        } catch (err) {
          /* ignore */
        }
        break;
      }

      case 'YR_COUNTDOWN_DONE': {
        // 页面倒计时归零且浮层已移除 → 真正开始捕获
        const doneTabId = (sender.tab && sender.tab.id) || message.tabId;
        console.log('[YR-bg] 收到 YR_COUNTDOWN_DONE → tab=' + doneTabId);
        if (countdown.active && countdown.tabId === doneTabId) finishCountdown(false);
        break;
      }

      case 'YR_COUNTDOWN_CANCEL': {
        // 页面内取消（Esc / 点「取消」）：只在该标签页确实处于倒计时时才复位
        const cancelTabId = (sender.tab && sender.tab.id) || message.tabId;
        if (countdown.active && countdown.tabId === cancelTabId) {
          cancelCountdown('已取消本次录制（倒计时未结束，未开始捕获）。');
        }
        break;
      }

      case 'YR_HOTKEY': {
        // 页面快捷键（content/hotkey.js）：按 background 的真实状态在开始 / 停止间切换。
        // 状态权威在 background —— 弹窗可以随时开关，页面侧不缓存任何状态。
        const respondHotkey = sendResponse || function () {};
        const hotkeyTabId = (sender.tab && sender.tab.id) || message.tabId;
        hydration
          .catch(() => {})
          .then(() => {
            const phase = yrState.phase;
            if (phase === 'recording') {
              console.log('[YR-bg] 快捷键：录制中 → 停止并保存');
              chrome.runtime.sendMessage({ type: 'REC_STOP' }).catch(() => {});
              respondHotkey({ ok: true, action: 'stop' });
              return;
            }
            if (phase === 'countdown') {
              // 倒计时中再按一次 = 放弃这次录制（等同于点「取消」）
              console.log('[YR-bg] 快捷键：倒计时中 → 取消');
              cancelCountdown('已取消本次录制（倒计时未结束，未开始捕获）。');
              respondHotkey({ ok: true, action: 'cancel' });
              return;
            }
            if (phase !== 'idle' && phase !== 'error') {
              // 正在准备 / 组装 / 导出：拒绝本次触发，避免打断不可逆流程
              respondHotkey({ ok: false, code: 'busy', message: '上一次操作尚未结束，请稍候。' });
              return;
            }
            console.log('[YR-bg] 快捷键：空闲 → 开始录制（tab=' + hotkeyTabId + '）');
            requestStart(hotkeyTabId, respondHotkey);
          });
        return true; // 异步回执
      }

      case 'YR_STOP': {
        // popup 请求停止：广播给离屏，由其组装并导出
        console.log('[YR-bg] 收到 YR_STOP');
        cancelCountdown(''); // 仍在倒计时：视为放弃本次录制
        chrome.runtime.sendMessage({ type: 'REC_STOP' }).catch(() => {});
        try {
          sendResponse({ ok: true });
        } catch (err) {
          /* ignore */
        }
        break;
      }

      case 'YR_RESET': {
        // popup 触发强制复位：解除残留会话占用
        console.log('[YR-bg] 收到 YR_RESET');
        cancelCountdown(''); // 残留倒计时一并清掉
        flushOffscreenReset();
        setRectReport(false);
        setPhase('idle', { error: null, notice: '' });
        try {
          sendResponse({ ok: true });
        } catch (err) {
          /* ignore */
        }
        break;
      }

      case 'YR_GET_STATE': {
        // popup 打开时回查当前状态（SW 可能刚被唤醒，先等状态水合完成）
        const respondState = sendResponse || function () {};
        hydration
          .then(() => ({
            ok: true,
            state: {
              phase: yrState.phase,
              startedAt: yrState.startedAt,
              durationMs: yrState.durationMs,
              error: yrState.error,
              notice: yrState.notice,
              tabId: activeTabId,
              countdownSec: yrState.countdownSec || 0,
              countdownEndsAt: yrState.countdownEndsAt || 0,
            },
          }))
          .catch(() => ({ ok: false }))
          .then((payload) => {
            try {
              respondState(payload);
            } catch (err) {
              /* 弹窗已关闭：忽略 */
            }
          });
        return true; // 异步回执
      }

      case 'PLAYER_RECT':
      case 'REC_STOP':
      case 'PAGE_LEAVING':
      case 'PAGE_HIDDEN': {
        // 倒计时途中页面跳走 / 关闭：直接取消，避免兜底定时器对已失效页面发起录制
        if (message.type === 'PAGE_LEAVING' && countdown.active && countdown.tabId === tabId) {
          cancelCountdown('');
        }
        // 心跳包同样用于同步 activeTabId（应对 SW 重启后丢失内存变量的场景）
        if (tabId) {
          activeTabId = tabId;
          // 转发给离屏文档（MV3 下 content script 发出的消息通常只到达 SW）
          chrome.runtime.sendMessage(message).catch(() => {});
        }
        break;
      }

      case 'PLAYER_RECT_REQUEST': {
        // 离屏主动拉取播放器矩形：定向转发给录制标签页的 content 立即补报一次
        // （离屏发出的消息无 sender.tab，须按 activeTabId 转发；content 无法直收离屏广播）
        if (activeTabId) {
          chrome.tabs.sendMessage(activeTabId, { type: 'PLAYER_RECT_REQUEST' }).catch(() => {});
        }
        break;
      }

      case 'OFFSCREEN_READY': {
        // 离屏就绪：补发所有排队中的启动请求（此刻离屏脚本已注册监听，不会再丢）
        console.log('[YR-bg] 收到 OFFSCREEN_READY（队列 ' + pendingStartResponders.length + '）');
        flushPendingStarts();
        break;
      }

      case 'REC_STATE': {
        // 页面内已无 UI，状态不再转发给 content，只维护全局状态 + 徽标供 popup 查询
        const phase = message.phase;
        console.log('[YR-bg] REC_STATE phase=' + phase);
        if (phase === 'error') {
          const payload = message.payload || {};
          const title = payload.title || '录制失败';
          const detail = payload.message || '';
          setPhase('error', { error: { title, message: detail } });
          setRectReport(false);
          showResultNotif(false, detail || title);
        } else if (phase) {
          setPhase(phase, phase === 'recording' ? { error: null } : null);
          // 停止 / 导出 / 复位后不再需要播放器矩形心跳
          if (phase === 'stopping' || phase === 'exported' || phase === 'idle') setRectReport(false);
        }
        // 全链路复位（录制完成 / 失败后离屏自清）→ 延迟回收离屏资源
        if (phase === 'idle') {
          scheduleCloseOffscreen();
        }
        break;
      }

      case 'UI_ACTION': {
        // 离屏提示（无音频 / 标签页切走 / DRM 等）：页面内已无 UI，记入状态供弹窗展示
        const payload = message.payload || {};
        const prefix = message.action === 'modal' && payload.title ? payload.title + '：' : '';
        const text = prefix + (payload.message || '');
        if (text) setPhase(yrState.phase, { notice: text });
        break;
      }

      case 'DOWNLOAD_RESULT': {
        // 离屏侧（下载触发失败）广播的下载结果
        applyDownloadResult(message);
        break;
      }

      case 'YR_LOG': {
        console.log('[YR-offscreen]', (message && message.text) || '');
        break;
      }

      case 'DOWNLOAD_FILE': {
        // 离屏由于 API 限制无法直接调用 chrome.downloads，由 background 代为执行
        const { url, filename } = message;
        console.log('[YR-bg] 收到 DOWNLOAD_FILE 请求:', filename);
        chrome.downloads.download(
          { url, filename, conflictAction: 'uniquify' },
          (downloadId) => {
            if (chrome.runtime.lastError || typeof downloadId !== 'number') {
              const message = chrome.runtime.lastError ? chrome.runtime.lastError.message : '触发下载失败';
              console.error('[YR-bg] 下载启动失败:', message);
              sendResponse({ ok: false, message });
            } else {
              console.log('[YR-bg] 下载已启动, ID:', downloadId);
              sendResponse({ ok: true, downloadId });
              // 监听下载进度（完成后通知 content 并清理离屏）
              watchDownloadProgress(downloadId);
            }
          }
        );
        return true;
      }

      default:
        break;
    }
    return false;
  });

  /** 监听下载状态变化 */
  function watchDownloadProgress(downloadId) {
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      const current = delta.state && delta.state.current;
      
      if (current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        console.log('[YR-bg] 下载完成:', downloadId);
        // 更新全局状态（popup 展示）并通知 offscreen 复位
        const result = { type: 'DOWNLOAD_RESULT', ok: true, downloadId };
        applyDownloadResult(result);
        chrome.runtime.sendMessage(result).catch(() => {});
      } else if (current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        const message = (delta.error && delta.error.current) || 'UNKNOWN';
        console.error('[YR-bg] 下载中断:', downloadId, message);
        // 更新全局状态（popup 展示）并通知 offscreen 复位
        const result = { type: 'DOWNLOAD_RESULT', ok: false, message, downloadId };
        applyDownloadResult(result);
        chrome.runtime.sendMessage(result).catch(() => {});
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  }

  // ===================== 系统通知事件 =====================

  try {
    chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
      if (notificationId !== NOTIF_REC_ID || buttonIndex !== 0) return;
      if (yrState.phase === 'recording') {
        // 通知按钮 = 停止并保存：全屏观看时无需退出全屏即可停止
        console.log('[YR-bg] 系统通知按钮：停止并保存');
        chrome.runtime.sendMessage({ type: 'REC_STOP' }).catch(() => {});
      } else {
        clearNotif(NOTIF_REC_ID); // 会话已结束：清理可能残留的常驻通知
      }
    });

    chrome.notifications.onClicked.addListener((notificationId) => {
      // 点击主体：录制中保留（它本身就是全屏时的录制指示）；非录制态点击即清除
      if (notificationId === NOTIF_REC_ID && yrState.phase !== 'recording') {
        clearNotif(NOTIF_REC_ID);
      }
    });
  } catch (err) {
    /* 通知 API 不可用（极少数平台）：指示降级为徽标 / PiP / 红框 */
  }

  // 倒计时期间标签页被关闭：立即取消（兜底定时器不必再等）
  try {
    chrome.tabs.onRemoved.addListener((tabId) => {
      if (!countdown.active || countdown.tabId !== tabId) return;
      console.log('[YR-bg] 倒计时中的标签页已关闭 → 取消');
      clearCountdownTimer();
      countdown.active = false;
      countdown.tabId = null;
      countdown.endsAt = 0;
      countdown.token += 1;
      setPhase('idle', { error: null, notice: '' });
    });
  } catch (err) {
    /* tabs 事件不可用：兜底定时器仍能收尾 */
  }

  // 读取 / 跟随「系统通知」开关（storage.sync yrIndNotif，默认开）
  refreshNotifPref();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.yrIndNotif) return;
      notifOn = changes.yrIndNotif.newValue !== false;
      if (!notifOn) clearNotif(NOTIF_REC_ID); // 关闭即清理常驻录制通知
    });
  } catch (err) {
    /* storage 不可用则维持当前配置 */
  }
})();
