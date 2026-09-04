/**
 * offscreen document —— 录制核心（任务 9 ~ 任务 17 的离屏落地）
 *
 * 数据流：
 *   REC_START(streamId) ─▶ navigator.mediaDevices.getUserMedia() 消费标签页流
 *             ─▶ 拆出 videoTrack 交隐藏 <video> 播放
 *             ─▶ content 上报 PLAYER_RECT（CSS 坐标 × DPR）
 *             ─▶ 隐藏 <canvas> 每帧 drawImage 裁剪播放器区域（任务 13）
 *             ─▶ canvas.captureStream(30) 视频轨 + 原始 audioTrack
 *                合流 finalStream（任务 14）
 *             ─▶ MediaRecorder(finalStream, webm) start()（任务 15）
 *   REC_STOP ─▶ stop() → 组装 Blob → chrome.downloads.download（任务 16/17）
 *
 * 为什么放 offscreen：service worker 负责在用户手势链路内申请 tabCapture
 * 的 streamId，而真正消费该流、操作 DOM 媒体（video/canvas/MediaRecorder）
 * 必须在扩展页面里完成，即 offscreen document（Service Worker 无 DOM，
 * popup 会失焦关闭）。
 */
(() => {
  'use strict';

  /** 浏览器原生仅支持 webm；候选回退链（15.1，绝不转码） */
  const MIME_CANDIDATES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  /** 录制核心状态 */
  const S = {
    phase: 'idle', // idle | preparing | recording | stopping
    tabStream: null, // tabCapture 返回的完整标签页流
    canvasStream: null, // canvas.captureStream 输出（视频轨）
    finalStream: null, // 裁剪视频轨 + 原始音频轨（10.1 / 14.2）
    video: null, // 隐藏 video（任务 11）
    canvas: null,
    ctx: null,
    rafId: 0,
    audioTrack: null, // 10.1 原始音频轨（canvas 无音频能力，必须直用）
    audioContext: null, // 新增：用于音频回放的上下文
    audioSource: null, // 新增：音频源节点
    recorder: null,
    chunks: [], // 15.2 分片
    playerRect: null, // content 上报的播放器 CSS 矩形（12.x）
    dpr: 1,
    pipelineStarted: false,
    finalized: false,
    prepTimer: null,
    drmTimer: null,
    lastPrepWaitLogAt: 0,
    pendingDownload: null, // { blob, url, filename, attempt, downloadId }
  };

  /** 广播给其它扩展上下文（background 路由 / content 渲染 UI） */
  function broadcast(message) {
    try {
      chrome.runtime.sendMessage(message);
    } catch (err) {
      /* 页面卸载竞态：忽略 */
    }
  }

  /** 轻量诊断日志：同时写入控制台并经 YR_LOG 转发给 background 打印 */
  function dlog(text) {
    try {
      console.log('[YR-offscreen]', text);
      chrome.runtime.sendMessage({ type: 'YR_LOG', text: String(text) });
    } catch (err) {
      /* ignore */
    }
  }

  /** 全链路复位信号：background 据此关闭离屏文档；同时自身回到 idle 可再次启用 */
  function broadcastIdle() {
    S.phase = 'idle';
    S.finalized = false; // 会话终止即允许再次使用（修复：一次失败后无法再次导出的隐患）
    broadcast({ type: 'REC_STATE', phase: 'idle' });
  }

  // ===================== 消息监听 =====================

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'REC_START': {
        // 由 background 转发，或 content 轮询幂等重发；本质上仍是用户点击触发（18.7）
        if (S.phase === 'idle') {
          dlog('REC_START 到达，phase=idle → begin()');
          begin(message.streamId); // 首段为同步逻辑（置 preparing 并广播 capturing），可安全同步回执
          try {
            sendResponse({ ok: true, phase: 'capturing' });
          } catch (err) {
            /* 通道已关：忽略 */
          }
        } else {
          // 非空闲（残留 / 被占用 / 正在 preparing）：如实回执，避免发起方空等超时后误报
          dlog('REC_START 到达但 busy（phase=' + S.phase + '）');
          try {
            sendResponse({ ok: false, busy: true, phase: S.phase });
          } catch (err) {
            /* ignore */
          }
        }
        return true; // 保持消息通道供 sendResponse
      }
      case 'REC_RESET': // 强制复位残留会话（background 转发，发起失败侧兜底触发）
        dlog('收到 REC_RESET → forceReset()');
        forceReset();
        break;
      case 'REC_STOP':
        if (S.phase === 'recording') requestStop();
        break;
      case 'PLAYER_RECT': // 12.x 播放器矩形高频上报
        if (message.hasPlayer && message.rect) {
          S.playerRect = message.rect;
          S.dpr = message.dpr || 1;
        } else {
          S.playerRect = null;
        }
        break;
      case 'PAGE_LEAVING': // 页面跳转/刷新：自动停止并导出（18.10）
        if (S.phase === 'recording' || S.phase === 'preparing') requestStop();
        break;
      case 'DOWNLOAD_RESULT': // 处理来自 background 的下载结果（17.x）
        if (S.pendingDownload && message.downloadId === S.pendingDownload.downloadId) {
          if (message.ok) {
            dlog('收到下载完成通知 (id=' + message.downloadId + ')');
            clearPendingDownload();
            broadcastIdle();
          } else {
            const errName = message.message || '未知';
            const blob = S.pendingDownload.blob;
            const filename = S.pendingDownload.filename;
            const attempt = S.pendingDownload.attempt;
            dlog('收到下载中断通知 (id=' + message.downloadId + '，error=' + errName + ')');
            
            if (blob && shouldRetryInterruptedDownload(errName, attempt)) {
              dlog('检测到可重试的下载中断，自动重试一次');
              downloadBlob(blob, { filename, attempt: attempt + 1 });
            } else {
              clearPendingDownload();
              // 已经在 background 中向 content 发送过失败消息了，这里只需复位离屏
              broadcastIdle();
            }
          }
        }
        break;
      default:
        break;
    }
    return false;
  });

  // 就绪信号：background 可能缓存了「刚点开始、离屏尚在创建」的补发逻辑
  broadcast({ type: 'OFFSCREEN_READY' });
  dlog('离屏脚本已就绪（OFFSCREEN_READY 已广播）');
  dlog('捕获策略：background.getMediaStreamId -> offscreen.getUserMedia');

  // ===================== 启动意图自查（storage.session 兜底） =====================
  //
  // background 的「转发补发」依赖 SW 生命周期，SW 休眠/重启后可能丢失。
  // 因此每次点击开始，background 会把启动意图（含 streamId）写入 chrome.storage.session；
  // 本离屏文档加载完成后在这里自查一次：存在则自行 begin(streamId)。
  // 离屏是长期存活的 document，该路径不依赖任何中间转发，最为可靠。
  (async function checkPendingStart() {
    try {
      if (!chrome.storage || !chrome.storage.session) {
        dlog('storage.session 不可用，跳过启动自查');
        return;
      }
      const { yrPendingStart } = await chrome.storage.session.get('yrPendingStart');
      if (yrPendingStart && yrPendingStart.streamId && S.phase === 'idle') {
        dlog('检测到 storage.session 中的启动意图 → 自行 begin(streamId)');
        await chrome.storage.session.remove('yrPendingStart');
        begin(yrPendingStart.streamId);
      } else {
        dlog('storage.session 无启动意图（或已非 idle），跳过自查');
      }
      // 离屏已存在、但 background 转发丢失的场景：监听 storage 变化实时自启
      if (chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'session') return;
          const change = changes.yrPendingStart;
          if (!change || !change.newValue) return; // 仅响应「写入」，移除不回
          if (S.phase === 'idle' && change.newValue && change.newValue.streamId) {
            dlog('storage.session 启动意图变化（onChanged）→ 自行 begin(streamId)');
            try {
              chrome.storage.session.remove('yrPendingStart');
            } catch (err) {
              /* ignore */
            }
            begin(change.newValue.streamId);
          }
        });
      }
    } catch (err) {
      dlog('启动自查失败：' + String((err && err.message) || err));
    }
  })();

  // ===================== 任务 9：开始捕获 =====================

  async function begin(streamId) {
    S.phase = 'preparing';
    S.finalized = false;
    S.pipelineStarted = false;
    S.chunks = [];
    S.playerRect = null;
    S.dpr = 1;
    S.recorder = null;
    S.lastPrepWaitLogAt = 0;
    if (S.prepTimer) {
      window.clearTimeout(S.prepTimer);
      S.prepTimer = null;
    }
    if (S.drmTimer) {
      window.clearTimeout(S.drmTimer);
      S.drmTimer = null;
    }
    // 清除 storage.session 中的启动意图（已被本次 begin 消费）
    try {
      if (chrome.storage && chrome.storage.session) {
        chrome.storage.session.remove('yrPendingStart');
      }
    } catch (err) {
      /* ignore */
    }
    dlog('begin() → phase=preparing，广播 capturing');
    broadcast({ type: 'REC_STATE', phase: 'capturing' }); // 9.1 状态联动

    if (!streamId) {
      dlog('begin() 缺少 streamId');
      failModal('无法捕获标签页', '未收到可用的标签页流标识，请重新点击「开始录制」。');
      return;
    }

    // 9.2 消费当前激活标签页流（含全页画面 + 页面全部声音）
    let stream = null;
    try {
      stream = await captureTabStream(streamId);
    } catch (err) {
      // 9.4 / 6.5：捕获被拒绝（用户权限、DRM、Chrome 限制等）
      dlog('tabCapture 失败：' + String((err && err.message) || err));
      failModal('无法捕获标签页', explainCaptureError(err));
      return;
    }
    if (!stream || !stream.getVideoTracks().length) {
      dlog('tabCapture 返回空流/无视频轨');
      failModal('无法捕获标签页', '浏览器未返回标签页媒体流。\n请确认：\n· 当前页面为 YouTube 播放页\n· 未开启「受保护内容」屏蔽\n· 未在使用浏览器自带的标签页共享功能');
      return;
    }
    dlog('tabCapture 成功（音频轨：' + (stream.getAudioTracks().length ? '有' : '无') + '）');
    // 等待授权期间可能已被 REC_RESET / 新流程打断（forceReset 已释放全部轨道）
    if (S.phase !== 'preparing') {
      try {
        for (const track of stream.getTracks()) track.stop();
      } catch (err) {
        /* ignore */
      }
      return;
    }

    // 任务 10：提取音频轨道（10.2 缺失 → 警告 toast，可录无声）
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      broadcast({
        type: 'UI_ACTION',
        action: 'toast',
        payload: { type: 'warning', message: '无法获取页面音频：仍可录制，但输出将无声。' },
      });
    }
    S.tabStream = stream;
    S.audioTrack = audioTrack || null;

    // 新增：使用 AudioContext 将捕获到的音频输出到扬声器，防止原标签页静音
    if (audioTrack) {
      try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
        source.connect(audioContext.destination);
        
        // 自动恢复被挂起的上下文（受浏览器自动播放策略影响）
        if (audioContext.state === 'suspended') {
          audioContext.resume().catch(e => dlog('AudioContext resume 失败: ' + e.message));
        }
        
        S.audioContext = audioContext;
        S.audioSource = source;
        dlog('AudioContext 回放已启动，标签页音频已恢复');
        dlog('音频轨状态: ' + audioTrack.readyState + ', enabled=' + audioTrack.enabled);
      } catch (err) {
        dlog('AudioContext 初始化失败: ' + String(err.message || err));
      }
    }

    // 任务 11：隐藏 video 消费 tab 流画面
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true; // 本视频仅作像素源；音频轨由 finalStream 直接消费
    video.autoplay = true;
    video.srcObject = new MediaStream([stream.getVideoTracks()[0]]);
    video.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);
    S.video = video;
    try {
      await video.play();
      dlog('隐藏 video 已开始播放，等待首帧与播放器坐标');
    } catch (err) {
      if (S.phase === 'preparing') {
        failModal('视频初始化失败', String((err && err.message) || err));
      }
      return;
    }

    // 捕获流被浏览器中断（切走标签页/系统弹层等）→ 兜底自动停止（18.1/18.8）
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (S.phase === 'recording' || S.phase === 'preparing') {
        broadcast({
          type: 'UI_ACTION',
          action: 'toast',
          payload: { type: 'warning', message: '标签页画面捕获已中断，正在自动停止并导出…' },
        });
        requestStop();
      }
    });

    // 任务 13：隐藏 canvas（尺寸在首帧有效后落定）
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:none;';
    const ctx = canvas.getContext('2d', { alpha: false });
    S.canvas = canvas;
    S.ctx = ctx;

    // 准备超时兜底（如非播放页 / 无画面上报）
    S.prepTimer = window.setTimeout(() => {
      if (S.phase === 'preparing') {
        failModal('初始化超时', '长时间未获取到播放器画面。\n请确认当前是 YouTube 播放页，播放器可见后再试。');
      }
    }, 15000);

    drawLoop(); // 启动逐帧裁剪循环（13.3）
  }

  /** 用 service worker 生成的 streamId 在 offscreen 中换取真实 MediaStream */
  async function captureTabStream(streamId) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('当前离屏页面不支持 getUserMedia，无法消费标签页流。请重新加载扩展后重试。');
    }
    return navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });
  }

  /** 捕获失败原因的可读化（便于模态框展示） */
  function explainCaptureError(err) {
    const msg = String((err && err.message) || err || '');
    if (/reading 'capture'|\\.capture is not a function/i.test(msg)) {
      return '检测到旧版捕获逻辑仍在运行。\n请前往 chrome://extensions 重新加载当前扩展，然后回到页面再次点击「开始录制」。';
    }
    if (/gesture|interaction|activation/i.test(msg)) {
      return '浏览器要求捕获必须由用户手势触发。\n请关闭面板后重新点击「开始录制」。';
    }
    if (/permission|denied|not allowed/i.test(msg)) {
      return '捕获被拒绝：请确认扩展权限（tabCapture）已开启，并重新点击「开始录制」。';
    }
    return msg || '未知浏览器错误。';
  }

  // ===================== 任务 13：rAF 逐帧裁剪循环 =====================

  function drawLoop() {
    if (S.phase !== 'preparing' && S.phase !== 'recording') {
      S.rafId = 0;
      return;
    }
    const r = S.playerRect;
    const v = S.video;
    const minReadyState = typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.HAVE_CURRENT_DATA : 2;
    let drewFrame = false;
    if (r && v && v.videoWidth > 0 && v.readyState >= minReadyState && S.ctx) {
      // 12.3 CSS 像素 → 物理像素（DPR）
      const dpr = S.dpr || 1;
      const sx = r.x * dpr;
      const sy = r.y * dpr;
      const sw = Math.max(0, r.width * dpr);
      const sh = Math.max(0, r.height * dpr);
      const srcLeft = Math.max(0, Math.min(v.videoWidth, sx));
      const srcTop = Math.max(0, Math.min(v.videoHeight, sy));
      const srcRight = Math.max(0, Math.min(v.videoWidth, sx + sw));
      const srcBottom = Math.max(0, Math.min(v.videoHeight, sy + sh));
      const clippedW = Math.max(0, srcRight - srcLeft);
      const clippedH = Math.max(0, srcBottom - srcTop);
      const visibleRatio = sw > 0 && sh > 0 ? (clippedW * clippedH) / (sw * sh) : 0;
      // 允许轻微越界（YouTube 容器与真实视频像素常有 1~2px 偏差），明显滚出视口时仍继续等待。
      // 降低阈值到 0.7 以应对部分滚动或小范围遮挡（12.x 容错优化）
      if (clippedW >= 2 && clippedH >= 2 && visibleRatio >= 0.7) {
        const cw = Math.max(2, Math.round(clippedW));
        const ch = Math.max(2, Math.round(clippedH));
        if (S.canvas.width !== cw || S.canvas.height !== ch) {
          S.canvas.width = cw;
          S.canvas.height = ch;
        }
        // 13.3 源区域取播放器矩形，目标 (0,0) 同尺寸 → 完成画面裁剪
        S.ctx.drawImage(v, srcLeft, srcTop, clippedW, clippedH, 0, 0, cw, ch);
        drewFrame = true;
        ensurePipeline();
      }
    }
    if (!drewFrame && S.phase === 'preparing') {
      const now = Date.now();
      if (now - S.lastPrepWaitLogAt >= 1000) {
        S.lastPrepWaitLogAt = now;
        dlog(
          '等待首帧：rect=' +
            (r ? Math.round(r.width) + 'x' + Math.round(r.height) + '@(' + Math.round(r.x) + ',' + Math.round(r.y) + ')' : 'none') +
            '，video=' +
            (v ? v.videoWidth + 'x' + v.videoHeight + ' rs=' + v.readyState : 'none')
        );
      }
    }
    S.rafId = requestAnimationFrame(drawLoop); // 13.4 持续下一轮
  }

  // ===================== 任务 14 / 15：合流 + MediaRecorder =====================

  /** 首帧有效后一次性建立：canvas 输出流 → finalStream → MediaRecorder */
  function ensurePipeline() {
    if (S.pipelineStarted || S.phase !== 'preparing') return;
    S.pipelineStarted = true;
    try {
      // 14.1 canvas.captureStream(30)：仅含视频轨
      const canvasStream = S.canvas.captureStream(30);
      const videoTrackOut = canvasStream.getVideoTracks()[0];
      // 14.2 裁剪视频轨 + 原始音频轨
      const finalStream = new MediaStream();
      finalStream.addTrack(videoTrackOut);
      if (S.audioTrack) finalStream.addTrack(S.audioTrack);

      const recorder = createRecorder(finalStream);
      S.canvasStream = canvasStream;
      S.finalStream = finalStream;
      S.recorder = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) S.chunks.push(event.data); // 15.2
      };
      recorder.onstop = onRecorderStop; // 15.3 / 17.1
      recorder.onerror = () => {
        if (S.phase === 'recording') {
          failModal('录制器发生错误', 'MediaRecorder 异常终止，请重试。');
        }
      };

      recorder.start(1000); // 15.4 每秒落一个分片，降低极端掉数据风险

      window.clearTimeout(S.prepTimer);
      S.prepTimer = null;
      S.phase = 'recording';
      dlog('MediaRecorder 已启动，phase=recording');
      broadcast({ type: 'REC_STATE', phase: 'recording' }); // 13.5 状态联动

      scheduleDrmCheck(); // 18.5
    } catch (err) {
      failModal('录制初始化失败', String((err && err.message) || err));
    }
  }

  /** mimeType 探测（15.1）：vp9 → vp8 → 裸 video/webm */
  function createRecorder(stream) {
    let mime = '';
    for (const candidate of MIME_CANDIDATES) {
      try {
        if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(candidate)) {
          mime = candidate;
          break;
        }
      } catch (err) {
        /* 继续探测 */
      }
    }
    try {
      return mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (err) {
      throw new Error('当前浏览器不支持 webm 录制（' + ((err && err.message) || err) + '）');
    }
  }

  // ===================== 任务 16：停止录制 =====================

  function requestStop() {
    if (S.phase === 'preparing') {
      // 尚未建立录制管线（被 PAGE_LEAVING 打断等）：直接复位
      window.clearTimeout(S.prepTimer);
      stopDrawingAndVideo();
      releaseAllTracks();
      S.finalized = true;
      broadcastIdle();
      return;
    }
    if (S.phase !== 'recording') return;
    S.phase = 'stopping';
    broadcast({ type: 'REC_STATE', phase: 'stopping' }); // 16.1 面板状态
    stopDrawingAndVideo(); // 16.3 / 16.4

    const recorder = S.recorder;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop(); // 16.2 → onstop → onRecorderStop → 组装导出
    } else {
      onRecorderStop();
    }
    // 16.5 媒体轨道统一在 onRecorderStop（组装前）释放，防止重复占用
  }

  function stopDrawingAndVideo() {
    if (S.rafId) {
      cancelAnimationFrame(S.rafId);
      S.rafId = 0;
    }
    if (S.video) {
      try {
        S.video.pause();
      } catch (err) {
        /* ignore */
      }
      S.video.srcObject = null;
    }
    // 停止音频上下文
    if (S.audioContext) {
      try {
        if (S.audioContext.state !== 'closed') {
          S.audioContext.close().catch(() => {});
        }
      } catch (err) {
        /* ignore */
      }
      S.audioContext = null;
      S.audioSource = null;
    }
  }

  // ===================== 任务 17：组装 Blob 与下载 =====================

  function onRecorderStop() {
    if (S.finalized) {
      broadcastIdle();
      return;
    }
    releaseAllTracks(); // 16.5：recorder 已停止，此刻安全释放全部轨道
    finishExport();
  }

  function finishExport() {
    // 17.1 全部分片组装为完整 Blob
    const type = (S.recorder && S.recorder.mimeType) || 'video/webm';
    let blob = null;
    try {
      blob = new Blob(S.chunks, { type });
    } catch (err) {
      blob = null;
    }
    if (!blob || blob.size === 0) {
      failModal('录制结果为空', '没有捕获到有效的视频数据（可能录制时长过短），请重试。');
      return;
    }
    S.chunks = [];
    dlog('Blob 组装完成（size=' + blob.size + '），phase=exported');
    broadcast({ type: 'REC_STATE', phase: 'exported' }); // 17.1 关闭全屏加载
    downloadBlob(blob);
  }

  function buildDownloadFilename() {
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (
      'YouTube-' +
      stamp.getFullYear() +
      pad(stamp.getMonth() + 1) +
      pad(stamp.getDate()) +
      '-' +
      pad(stamp.getHours()) +
      pad(stamp.getMinutes()) +
      pad(stamp.getSeconds()) +
      '.webm'
    );
  }

  function revokePendingDownloadUrl() {
    if (S.pendingDownload && S.pendingDownload.url) {
      try {
        URL.revokeObjectURL(S.pendingDownload.url);
      } catch (err) {
        /* ignore */
      }
      S.pendingDownload.url = null;
    }
  }

  function clearPendingDownload() {
    revokePendingDownloadUrl();
    S.pendingDownload = null;
  }

  function shouldRetryInterruptedDownload(errName, attempt) {
    if (attempt >= 2) return false;
    if (!errName) return false;
    return /^(NETWORK_|FILE_TRANSIENT_)/.test(String(errName));
  }

  function downloadBlob(blob, opts) {
    const attempt = (opts && opts.attempt) || 1;
    const filename = (opts && opts.filename) || buildDownloadFilename();
    clearPendingDownload();

    // 17.2 临时本地 URL；保留 blob 引用直到下载完成，避免 blob: URL 在极端情况下过早失效
    const url = URL.createObjectURL(blob);
    S.pendingDownload = { blob, url, filename, attempt, downloadId: null };
    dlog('触发下载（attempt=' + attempt + '，size=' + blob.size + '）');

    try {
      // 离屏无法直接调用 chrome.downloads，通过 background 代理执行
      chrome.runtime.sendMessage(
        { type: 'DOWNLOAD_FILE', url, filename },
        (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            const msg = (resp && resp.error) || (chrome.runtime.lastError ? chrome.runtime.lastError.message : '无法通过 background 触发下载');
            dlog('DOWNLOAD_FILE 代理失败：' + msg);
            if (attempt < 2) {
              dlog('下载触发失败，自动重试一次');
              downloadBlob(blob, { filename, attempt: attempt + 1 });
              return;
            }
            clearPendingDownload();
            broadcast({ type: 'DOWNLOAD_RESULT', ok: false, message: msg });
            broadcastIdle();
            return;
          }
          if (S.pendingDownload) S.pendingDownload.downloadId = resp.downloadId;
          dlog('下载已由 background 创建（id=' + resp.downloadId + '，attempt=' + attempt + '）');
          // 结果将通过 onMessage 中的 DOWNLOAD_RESULT 监听处理
        }
      );
    } catch (err) {
      const msg = String((err && err.message) || err);
      dlog('DOWNLOAD_FILE 抛错：' + msg);
      if (attempt < 2) {
        dlog('下载抛错，自动重试一次');
        downloadBlob(blob, { filename, attempt: attempt + 1 });
        return;
      }
      clearPendingDownload();
      broadcast({ type: 'DOWNLOAD_RESULT', ok: false, message: msg });
      broadcastIdle();
    }
  }

  // ===================== 资源释放（16.5 / 18.8） =====================

  function releaseAllTracks() {
    if (S.rafId) {
      cancelAnimationFrame(S.rafId);
      S.rafId = 0;
    }
    if (S.video) {
      try {
        S.video.pause();
      } catch (err) {
        /* ignore */
      }
      S.video.srcObject = null;
      if (S.video.parentNode) S.video.parentNode.removeChild(S.video);
      S.video = null;
    }
    // 释放音频回放资源
    if (S.audioContext) {
      try {
        if (S.audioContext.state !== 'closed') {
          S.audioContext.close().catch(() => {});
        }
      } catch (err) {
        /* ignore */
      }
      S.audioContext = null;
      S.audioSource = null;
    }
    const streams = [S.tabStream, S.canvasStream, S.finalStream];
    for (const stream of streams) {
      if (stream) {
        for (const track of stream.getTracks()) {
          try {
            track.stop(); // 18.8 必须显式 stop，否则持续占用捕获资源 / 红点残留
          } catch (err) {
            /* ignore */
          }
        }
      }
    }
    S.tabStream = null;
    S.canvasStream = null;
    S.finalStream = null;
    S.audioTrack = null;
  }

  // ===================== 通用失败处理（6.5 / 9.4 / 18.x） =====================

  /**
   * 强制复位（REC_RESET）：丢弃当前残留会话的全部资源回到 idle，不触发导出。
   * 用于「开始录制」被占用/残留会话卡死后的恢复路径（由发起失败侧兜底触发）。
   */
  function forceReset() {
    dlog('forceReset 开始（phase=' + S.phase + '）');
    if (S.finalized) {
      clearPendingDownload();
      broadcastIdle();
      return;
    }
    if (S.prepTimer) {
      window.clearTimeout(S.prepTimer);
      S.prepTimer = null;
    }
    const recorder = S.recorder;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null; // 阻止复位触发导出流程
      try {
        recorder.stop();
      } catch (err) {
        /* ignore */
      }
    }
    stopDrawingAndVideo();
    releaseAllTracks();
    S.recorder = null;
    S.chunks = [];
    S.playerRect = null;
    S.pipelineStarted = false;
    clearPendingDownload();
    broadcast({ type: 'REC_STATE', phase: 'idle', payload: { note: 'force-reset' } });
    broadcastIdle(); // background 据此回收离屏
  }

  function failModal(title, message) {
    if (S.finalized) return;
    dlog('failModal: ' + title + ' | ' + String(message || '').slice(0, 100));
    S.finalized = true;
    if (S.prepTimer) {
      window.clearTimeout(S.prepTimer);
      S.prepTimer = null;
    }
    const recorder = S.recorder;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null; // 防止失败后再次走导出
      try {
        recorder.stop();
      } catch (err) {
        /* ignore */
      }
    }
    stopDrawingAndVideo();
    releaseAllTracks();
    S.recorder = null;
    S.chunks = [];
    clearPendingDownload();
    broadcast({ type: 'REC_STATE', phase: 'error', payload: { title, message, ui: 'modal' } });
    broadcastIdle();
  }

  // ===================== 18.5 DRM 黑屏检测 =====================

  function scheduleDrmCheck() {
    S.drmTimer = window.setTimeout(() => {
      S.drmTimer = null;
      if (S.phase !== 'recording' || !S.ctx || !S.canvas || S.canvas.width < 8) return;
      const w = S.canvas.width;
      const h = S.canvas.height;
      const points = [
        [w / 2, h / 2],
        [w * 0.3, h * 0.3],
        [w * 0.7, h * 0.3],
        [w * 0.3, h * 0.7],
        [w * 0.7, h * 0.7],
      ];
      let sum = 0;
      let samples = 0;
      for (const [px, py] of points) {
        try {
          const data = S.ctx.getImageData(Math.max(0, Math.floor(px) - 2), Math.max(0, Math.floor(py) - 2), 5, 5).data;
          let local = 0;
          for (let i = 0; i < data.length; i += 4) {
            local += (data[i] + data[i + 1] + data[i + 2]) / 3;
          }
          sum += local / (data.length / 4);
          samples += 1;
        } catch (err) {
          /* 跨域等异常跳过该采样点 */
        }
      }
      if (samples > 0 && sum / samples < 6) {
        broadcast({
          type: 'UI_ACTION',
          action: 'modal',
          payload: {
            title: '可能为受保护内容（DRM）',
            message:
              '当前视频可能受 DRM（数字版权）保护，浏览器禁止对其画面进行捕获。\n输出画面可能为黑屏，请确认后继续录制或停止。',
            okText: '知道了',
          },
        });
      }
    }, 2600);
  }
})();
