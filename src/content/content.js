/**
 * content script —— 录制主逻辑（任务 9 / 12 / 16 / 17 / 18）
 *
 * 职责：
 * 1. 接收 popup 的 SHOW_PANEL，渲染主面板（组件见 ui.js）。
 * 2. 用户手势触发「开始 / 停止」，经 chrome.runtime 消息驱动 offscreen 录制核心。
 * 3. 高频定位播放器（ytd-player），换算 DPR 后以 PLAYER_RECT 喂给 offscreen，
 *    供离屏 canvas 做像素级裁剪。
 * 4. 监听离屏广播（REC_STATE / UI_ACTION / DOWNLOAD_RESULT）驱动 UI 状态机。
 * 5. 边界处理：录制中切标签页 / 页面跳转 / 异常清理。
 *
 * 依赖：content/ui.js（window.YRUI），按 manifest 顺序先加载。
 */
(() => {
  'use strict';

  /** 面板打开与否作为本页是否参与流程的开关（多标签页下忽略无关广播） */
  const isPanelActive = () => window.YRUI && YRUI.panelVisible;

  /** 录制状态机：idle | capturing | recording | stopping | exported */
  let phase = 'idle';

  /** rect 心跳定时器 id */
  let rectTimer = null;

  /** 导出完成后的延迟清理定时器 id（重开面板时可取消） */
  let cleanupTimer = null;

  /** 「开始录制」回执等待定时器：离屏无回应时兜底复位 */
  let startAckTimer = null;

  /** 启动请求幂等轮询定时器 id */
  let startAttemptTimer = null;

  /** 启动轮询已重试次数 */
  let startAttempts = 0;

  /** 启动轮询间隔 / 上限（总窗口约 9s，略早于 armStartAck 的 10s 兜底） */
  const START_ATTEMPT_INTERVAL_MS = 1500;
  const START_ATTEMPT_MAX = 6;

  /** 错误模态框是否已弹出（广播与握手回执可能双路径到达，避免重复弹窗） */
  let errorModalOpen = false;

  /** 残留会话 phase 的可读化（用于 busy 回执提示） */
  const PHASE_READABLE = {
    preparing: '准备捕获标签页',
    recording: '录制中',
    stopping: '停止处理中',
    exported: '导出处理中',
  };

  /** 诊断日志环形缓冲（错误弹窗尾部自动附上，便于远程定位） */
  const debugLogs = [];
  function dlog(text) {
    const line = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + text;
    debugLogs.push(line);
    if (debugLogs.length > 24) debugLogs.shift();
    try {
      console.log('[YR-content]', text);
    } catch (err) {
      /* ignore */
    }
  }
  function recentDebugText() {
    return debugLogs.slice(-14).join('\n');
  }

  // ===================== 消息接收 =====================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'SHOW_PANEL':
        handleShowPanel();
        break;
      case 'REC_STATE':
        handleRecState(message.phase, message.payload || {});
        break;
      case 'UI_ACTION':
        handleUiAction(message.action, message.payload || {});
        break;
      case 'DOWNLOAD_RESULT':
        handleDownloadResult(message);
        break;
      case 'YR_LOG':
        // 离屏诊断日志同步记入本页环形缓冲（帮助定位）
        if (message && message.text) dlog('离屏: ' + message.text);
        break;
      default:
        break;
    }
    // 不保持消息通道
  });

  // ===================== 面板入口 =====================

  function handleShowPanel() {
    if (!window.YRUI) return; // ui.js 尚未就绪（理论上先于本文件加载）
    // 取消挂起的「导出后自动清理」定时器（用户在清理窗口内重新打开面板时防误清）
    if (cleanupTimer) {
      window.clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }
    YRUI.openPanel();
    if (phase === 'recording' || phase === 'capturing') {
      // 兜底：录制进行中重新呼出面板 → 恢复真实录制态而非空闲
      YRUI.setStatus(phase);
      YRUI.setButtons(phase === 'recording', phase !== 'recording');
      startRectReporter(); // 12.x 恢复心跳上报
      if (phase === 'capturing') {
        // capturing 态重开（此前关闭面板会停掉轮询）：恢复启动轮询，避免按钮卡死
        YRUI.setInlineLoading(true, '正在准备捕获标签页流');
        armStartAck();
        startStartAttempts();
      }
      return;
    }
    // 每次呼出统一复位到空闲初始态
    phase = 'idle';
    YRUI.setStatus('idle');
    YRUI.setButtons(false, true);
    YRUI.setInlineLoading(false);
    YRUI.setFullLoading(false);
  }

  // ===================== 用户手势（任务 9 / 16） =====================

  function handleStartClick() {
    if (phase !== 'idle') return; // 9.1 防重复点击
    if (!document.querySelector('ytd-player')) {
      // 12.1 非播放页前置检查
      YRUI.showModal({
        title: '无法开始录制',
        body: '当前页面不是有效的 YouTube 播放页面。\n请打开一个 YouTube 视频后再点击「开始录制」。',
      });
      return;
    }
    dlog('点击开始录制');
    phase = 'capturing';
    YRUI.setStatus('capturing'); // 「准备捕获标签页」
    YRUI.setButtons(true, true); // 处理中：两个按钮均不可点
    YRUI.setInlineLoading(true, '正在准备捕获标签页流');
    startRectReporter();
    armStartAck(); // 最终兜底超时
    startStartAttempts(); // 幂等重发启动请求
  }

  /**
   * 幂等重发 REC_START_REQUEST：
   * 单次回执可能因 SW 生命周期 / 离屏未就绪而丢失或延迟，轮询保证至少一次生效；
   * 成功（收到 ok / capturing / recording）或失败提示后即停止。
   */
  function startStartAttempts() {
    stopStartAttempts();
    startAttempts = 0;
    sendStartRequest();
    startAttemptTimer = window.setInterval(() => {
      if (phase !== 'capturing') {
        stopStartAttempts();
        return;
      }
      startAttempts += 1;
      if (startAttempts > START_ATTEMPT_MAX) {
        dlog('启动轮询达到上限，等待 armStartAck 兜底');
        stopStartAttempts();
        return;
      }
      sendStartRequest();
    }, START_ATTEMPT_INTERVAL_MS);
  }

  function stopStartAttempts() {
    if (startAttemptTimer) {
      window.clearInterval(startAttemptTimer);
      startAttemptTimer = null;
    }
  }

  function sendStartRequest() {
    dlog('发送 REC_START_REQUEST（第 ' + (startAttempts + 1) + ' 次）');
    try {
      chrome.runtime.sendMessage({ type: 'REC_START_REQUEST' }, (resp) => {
        handleStartReply(resp);
      });
    } catch (err) {
      dlog('REC_START_REQUEST 发送异常：' + String((err && err.message) || err));
      // 忽略：由下一轮轮询继续
    }
  }

  /**
   * 开始录制回执处理：
   * - ok && pending：离屏尚未就绪，意图已写入 storage.session，离屏就绪后自查自启 → 等待 capturing 广播；
   * - ok：离屏已受理（begin 已同步广播 capturing）→ 停止轮询；
   * - busy(preparing)：正在捕获准备中（可能来自同一会话）→ 继续等待 capturing / recording；
   * - busy(其它)：残留 / 占用会话 → 引导「复位并重试」；
   * - 其它：离屏不可用 → 直接失败提示（无需空等超时）。
   */
  function handleStartReply(resp) {
    if (!resp || phase !== 'capturing') return; // 已被 capturing 广播或错误路径接管
    if (resp.ok) {
      stopStartAttempts();
      clearStartAck(); // 修复：收到明确受理回执即视为启动成功，清理兜底超时
      dlog('开始请求已受理（' + (resp.pending ? 'pending，等待离屏自查自启' : '离屏已开始捕获') + '）');
      return;
    }
    if (resp.busy) {
      if (resp.phase === 'preparing') {
        // 正在捕获准备中 → 视为启动进行中，继续等待 capturing / recording 广播
        dlog('回执 busy(preparing)，视为启动中，继续等待');
        return;
      }
      dlog('回执 busy(' + resp.phase + ')');
      stopStartAttempts();
      clearStartAck();
      stopRectReporter();
      YRUI.setInlineLoading(false);
      const phaseText = PHASE_READABLE[resp.phase] || resp.phase || '未知';
      YRUI.showModal({
        title: '检测到尚未结束的录制会话',
        body:
          '录制进程仍处于「' +
          phaseText +
          '」状态，通常来自上一次未正常结束的录制。\n' +
          '点击「复位并重试」将强制结束该残留会话并重新开始录制（未导出的数据将被放弃）。',
        okText: '复位并重试',
      }).then(() => {
        recoverAndRetry();
      });
      return;
    }
    // offscreen-error / unknown
    dlog('开始请求失败：' + String((resp && resp.message) || '未知错误'));
    stopStartAttempts();
    handleError({
      title: '无法开始录制',
      message:
        ((resp && resp.message) || '离屏录制进程不可用。') +
        '\n请刷新页面后重试；若持续失败，请到 chrome://extensions 重新加载扩展。',
      ui: 'modal',
    });
  }

  /** 复位残留会话后自动重试开始录制 */
  function recoverAndRetry() {
    dlog('用户确认复位 → REC_RESET_REQUEST 后自动重试');
    if (phase !== 'capturing') {
      phase = 'capturing';
      YRUI.setStatus('capturing');
    }
    YRUI.setButtons(true, true);
    YRUI.setInlineLoading(true, '正在复位残留会话并重试');
    startRectReporter(); // busy 分支已停过 rect 心跳，此处重新开启
    armStartAck(); // 兜底超时
    try {
      chrome.runtime.sendMessage({ type: 'REC_RESET_REQUEST' }, () => {
        // 等离屏完成复位（REC_RESET 广播无回执，固定等待片刻后重启轮询）
        window.setTimeout(() => {
          startStartAttempts();
        }, 400);
      });
    } catch (err) {
      handleError({ title: '录制启动失败', message: String((err && err.message) || err), ui: 'modal' });
    }
  }

  /**
   * 开始录制兜底超时：正常情况下握手回执 / capturing 广播会立即到达。
   * 若长时间无任何反馈（如离屏进程被浏览器回收且重建异常），
   * 先广播复位解除可能存在的残留卡死，再提示用户重试。
   */
  function armStartAck() {
    clearStartAck();
    startAckTimer = window.setTimeout(() => {
      startAckTimer = null;
      if (phase !== 'capturing') return;
      stopStartAttempts();
      dlog('armStartAck 10s 超时触发');
      try {
        chrome.runtime.sendMessage({ type: 'REC_RESET_REQUEST' });
      } catch (err) {
        /* ignore */
      }
      handleError({
        title: '无法开始录制',
        message:
          '录制未能启动：离屏录制进程长时间无响应（可能已被浏览器回收或处于异常状态）。\n' +
          '已尝试自动复位，请再次点击「开始录制」；若仍失败，请刷新页面后重试。',
        ui: 'modal',
      });
    }, 10000);
  }

  function clearStartAck() {
    if (startAckTimer) {
      window.clearTimeout(startAckTimer);
      startAckTimer = null;
    }
  }

  function handleStopClick() {
    if (phase !== 'recording') return; // 16.x 仅录制中可停止
    phase = 'stopping';
    YRUI.setStatus('stopping'); // 「停止处理中」
    // 16.1 全屏悬浮加载
    YRUI.setFullLoading(true, '正在组装视频文件，请稍候，不要关闭页面');
    chrome.runtime.sendMessage({ type: 'REC_STOP' });
  }

  function handlePanelClose() {
    if (phase === 'recording' || phase === 'stopping') {
      YRUI.toast('录制进行中，暂不能关闭面板', 'warning');
      return;
    }
    YRUI.closePanel();
    // 关闭面板：停止 rect 心跳、取消挂起的启动轮询/回执等待与清理定时器，
    // 防止 interval / timeout 泄漏（面板关闭后离屏广播已无 UI 需要响应）
    stopRectReporter();
    stopStartAttempts();
    clearStartAck();
    if (cleanupTimer) {
      window.clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }
  }

  // ===================== 播放器定位（任务 12） =====================

  /** 读取真实播放器可视区域相对视口矩形 + DPR（12.1/12.2/12.3） */
  function readPlayerRect() {
    const candidates = [
      'video.html5-main-video',
      '#movie_player video',
      '.html5-video-container video',
      '#movie_player',
      '#ytd-player',
      'ytd-player',
      '.video-stream.html5-main-video',
    ];
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      // 容忍极小的偏差，但必须有尺寸且在视口内（或部分在视口内）
      if (rect.width < 4 || rect.height < 4) continue;
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }
    return null;
  }

  /**
   * 心跳上报（12.4）：以 ~120ms 间隔持续重取播放器矩形。
   * 由于播放器静止不动时 rect 恒定，心跳天然覆盖：页面缩放 / 全屏 /
   * 滚动 / SPA 内切换视频等一切布局变化，无需额外 observer。
   */
  function startRectReporter() {
    if (rectTimer) return;
    const sendOnce = () => {
      if (!isPanelActive()) return; // 面板关了就不需要上报
      const rect = readPlayerRect();
      try {
        chrome.runtime.sendMessage({
          type: 'PLAYER_RECT',
          rect,
          dpr: window.devicePixelRatio || 1, // 12.3 高分屏换算
          hasPlayer: !!rect,
        });
      } catch (err) {
        /* 页面卸载竞态：忽略 */
      }
    };
    sendOnce();
    rectTimer = window.setInterval(sendOnce, 120);
  }

  function stopRectReporter() {
    if (rectTimer) {
      window.clearInterval(rectTimer);
      rectTimer = null;
    }
  }

  // ===================== 离屏广播 → UI 状态机 =====================

  function handleRecState(nextPhase, payload) {
    if (!isPanelActive()) return; // 非录制 tab / 未开面板，忽略广播
    dlog('收到 REC_STATE: ' + nextPhase);
    switch (nextPhase) {
      case 'capturing': // 离屏确认进入准备
        stopStartAttempts();
        clearStartAck();
        phase = 'capturing';
        YRUI.setStatus('capturing');
        YRUI.setButtons(true, true);
        startRectReporter(); // 确保正在心跳上报
        break;
      case 'recording': // 13.5 / 15.x 已开始录制
        stopStartAttempts();
        clearStartAck();
        phase = 'recording';
        YRUI.setStatus('recording');
        YRUI.setButtons(true, false); // 停止按钮可用
        YRUI.setInlineLoading(false);
        break;
      case 'stopping':
        phase = 'stopping';
        YRUI.setStatus('stopping');
        YRUI.setFullLoading(true, '正在组装视频文件，请稍候，不要关闭页面');
        break;
      case 'exported': // 17.1 blob 组装完成
        phase = 'exported';
        YRUI.setStatus('exported');
        YRUI.setFullLoading(false);
        break;
      case 'error': // 9.4 / 异常：恢复空闲并提示
        handleError(payload);
        break;
      case 'idle': // 生命周期信号（供 background 关闭离屏），UI 侧忽略
      default:
        break;
    }
  }

  function handleError(payload) {
    clearStartAck();
    stopStartAttempts();
    phase = 'idle';
    YRUI.setStatus('idle');
    YRUI.setButtons(false, true);
    YRUI.setInlineLoading(false);
    YRUI.setFullLoading(false);
    stopRectReporter();
    if (payload && payload.ui === 'modal') {
      // 广播与握手回执可能双路径各自报一次，这里去重避免重复弹窗
      if (errorModalOpen) return;
      errorModalOpen = true;
      dlog('错误弹窗：' + (payload.title || '录制失败') + ' | ' + String(payload.message || '').slice(0, 60));
      YRUI.showModal({
        title: payload.title || '录制失败',
        body: (payload.message || '出现未知错误，请重试。') + '\n\n—— 诊断日志 ——\n' + recentDebugText(),
      }).then(() => {
        errorModalOpen = false;
      });
    } else {
      YRUI.toast((payload && payload.message) || '录制失败', 'error');
    }
  }

  function handleUiAction(action, payload) {
    if (!isPanelActive()) return;
    if (action === 'toast') {
      YRUI.toast(payload.message || '', payload.type || 'warning');
    } else if (action === 'modal') {
      YRUI.showModal({
        title: payload.title || '提示',
        body: payload.message || '',
        okText: payload.okText,
      });
    }
  }

  function handleDownloadResult(message) {
    if (!isPanelActive()) return;
    if (message.ok) {
      dlog('收到 DOWNLOAD_RESULT: ok');
      // 17.3 下载已触发
      YRUI.toast('已触发下载，webm 文件将保存到本地', 'success');
    } else {
      dlog('收到 DOWNLOAD_RESULT: fail | ' + String(message.message || '未知错误'));
      YRUI.showModal({
        title: '下载失败',
        body: (message.message || '未能保存文件，请检查浏览器下载设置。') + '\n录制数据仍在离屏文档中，可重新尝试。',
      });
    }
    // 17.5 展示约 1.5s 后清理全部自定义 DOM，回到空闲
    cleanupTimer = window.setTimeout(() => {
      cleanupTimer = null;
      stopRectReporter(); // 停止 rect 心跳上报，防止定时器泄漏
      YRUI.cleanup();
      phase = 'idle';
    }, 1600);
  }

  // ===================== 边界处理（任务 18） =====================

  // 18.1 标签页切换：录制中页面被切走（document.hidden）→ 提示 + 离屏兜底
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && phase === 'recording') {
      YRUI.toast('检测到标签页切换：tabCapture 可能中断录制，请切回本页', 'warning');
      try {
        chrome.runtime.sendMessage({ type: 'PAGE_HIDDEN' });
      } catch (err) {
        /* ignore */
      }
    }
  });

  // 页面跳转 / 刷新 / 关闭：通知离屏自动停止并导出，避免丢数据（18.10）
  window.addEventListener('pagehide', () => {
    if (phase === 'recording' || phase === 'capturing' || phase === 'stopping') {
      try {
        chrome.runtime.sendMessage({ type: 'PAGE_LEAVING' });
      } catch (err) {
        /* ignore */
      }
    }
  });

  // ===================== 初始化 =====================

  function init() {
    if (!window.YRUI) {
      // ui.js 未注入（极端情况），稍后重试一次
      window.setTimeout(init, 200);
      return;
    }
    YRUI.init(); // 注入样式 + 主题监听
    YRUI.setHandlers({
      onStart: handleStartClick,
      onStop: handleStopClick,
      onClose: handlePanelClose,
    });
  }

  init();
})();
