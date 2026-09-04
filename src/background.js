/**
 * background service worker（manifest 3.4）
 *
 * 职责（见 DESIGN.md 2.2）：
 * - 创建 / 关闭 offscreen document（录制核心宿主）。
 * - 消息路由：popup 的 SHOW_PANEL 定向转发给录制标签页的 content script。
 * - 监听 REC_STATE idle（全链路复位）→ 回收 offscreen 资源。
 *
 * 说明：录制媒体逻辑放在 offscreen.js，但 tabCapture 的正确入口放在本文件。
 * MV3 中稳定做法是：service worker 在用户手势链路内调用
 * chrome.tabCapture.getMediaStreamId()，再把 streamId 交给 offscreen document
 * 通过 getUserMedia 消费。REC_START 由 content 以 REC_START_REQUEST 请求发起，
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

  /** 当前录制关联的标签页 ID（用于路由离屏广播给 content script） */
  let activeTabId = null;

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

  // ===================== 启动握手（REC_START_REQUEST） =====================

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
   * REC_START_REQUEST 主流程：
   * 1. 先生成并持久化当前标签页的 streamId —— 即使消息在离屏初始化阶段丢失，
   *    也能在 OFFSCREEN_READY 队列补发时复用同一个 streamId；
   * 2. 确保离屏文档存在（无则创建）；
   * 3. 立即向离屏转发 REC_START 并等待回执（离屏已就绪时的快速通道）。
   * 每次点击开始都会有明确答复（已受理 / 占用 / 离屏不可用），不再让 content 空等超时。
   */
  function startRecording(tabId, respond) {
    ensurePendingStart(tabId)
      .then((pendingStart) => ensureOffscreen().then(() => pendingStart))
      .then((pendingStart) => {
        forwardStartToOffscreen(respond, pendingStart);
      })
      .catch((err) => {
        try {
          respond({ ok: false, code: 'offscreen-error', message: String((err && err.message) || err) });
        } catch (e) {
          /* 发起方已离开：忽略 */
        }
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

  /** REC_RESET_REQUEST：离屏若存在则广播强制复位，解除残留会话造成的启动卡死 */
  async function flushOffscreenReset() {
    try {
      const has = await chrome.offscreen.hasDocument();
      if (!has) {
        console.log('[YR-bg] REC_RESET_REQUEST：离屏不存在，无需复位');
        return; // 离屏不存在则无需复位（下一轮启动请求会自动重建）
      }
      console.log('[YR-bg] 广播 REC_RESET 给离屏');
      chrome.runtime.sendMessage({ type: 'REC_RESET' });
    } catch (err) {
      /* 忽略：复位失败不影响主流程 */
    }
  }

  // ===================== 消息路由 =====================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return;

    const tabId = sender.tab && sender.tab.id;

    switch (message.type) {
      case 'SHOW_PANEL': {
        // 其它扩展页面传来：定向转发给目标标签页的 content script
        const targetTabId = message.tabId;
        if (typeof targetTabId === 'number' && targetTabId >= 0) {
          chrome.tabs.sendMessage(targetTabId, { type: 'SHOW_PANEL' }, () => {
            if (sendResponse) {
              sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
            }
          });
          return true; // 异步 sendResponse
        }
        break;
      }

      case 'REC_START_REQUEST': {
        // content 发起录制：确保离屏存活并把 REC_START 转发给离屏（带回执）
        console.log('[YR-bg] 收到 REC_START_REQUEST from tab=' + tabId);
        if (tabId) activeTabId = tabId; // 记录当前活动的录制标签页
        startRecording(tabId, sendResponse);
        return true; // 异步回执（保持消息通道）
      }

      case 'PLAYER_RECT':
      case 'REC_STOP':
      case 'PAGE_LEAVING':
      case 'PAGE_HIDDEN': {
        // 心跳包同样用于同步 activeTabId（应对 SW 重启后丢失内存变量的场景）
        if (tabId) {
          activeTabId = tabId;
          // 转发给离屏文档（MV3 下 content script 发出的消息通常只到达 SW）
          chrome.runtime.sendMessage(message).catch(() => {});
        }
        break;
      }

      case 'REC_RESET_REQUEST': {
        // content 兜底复位：解除残留会话导致的「无法开始」
        console.log('[YR-bg] 收到 REC_RESET_REQUEST');
        flushOffscreenReset();
        break;
      }

      case 'OFFSCREEN_READY': {
        // 离屏就绪：补发所有排队中的启动请求（此刻离屏脚本已注册监听，不会再丢）
        console.log('[YR-bg] 收到 OFFSCREEN_READY（队列 ' + pendingStartResponders.length + '）');
        flushPendingStarts();
        break;
      }

      case 'REC_STATE': {
        // 转发给 content script（MV3 下 content script 无法直接收到来自离屏的广播）
        if (activeTabId) chrome.tabs.sendMessage(activeTabId, message).catch(() => {});
        // 全链路复位（录制完成 / 失败后离屏自清）→ 延迟回收离屏资源
        console.log('[YR-bg] REC_STATE phase=' + message.phase);
        if (message.phase === 'idle') {
          scheduleCloseOffscreen();
        }
        break;
      }

      case 'UI_ACTION':
      case 'DOWNLOAD_RESULT':
      case 'YR_LOG': {
        // 路由转发：离屏 -> background -> content
        if (activeTabId) chrome.tabs.sendMessage(activeTabId, message).catch(() => {});
        if (message.type === 'YR_LOG') {
          console.log('[YR-offscreen]', (message && message.text) || '');
        }
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
        // 通知 content 和 offscreen
        const result = { type: 'DOWNLOAD_RESULT', ok: true, downloadId };
        if (activeTabId) chrome.tabs.sendMessage(activeTabId, result).catch(() => {});
        chrome.runtime.sendMessage(result).catch(() => {});
      } else if (current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        const message = (delta.error && delta.error.current) || 'UNKNOWN';
        console.error('[YR-bg] 下载中断:', downloadId, message);
        const result = { type: 'DOWNLOAD_RESULT', ok: false, message, downloadId };
        if (activeTabId) chrome.tabs.sendMessage(activeTabId, result).catch(() => {});
        chrome.runtime.sendMessage(result).catch(() => {});
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  }
})();
