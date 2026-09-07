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
 *             ─▶ MediaRecorder(finalStream, mp4 优先 / webm 回退) start()（任务 15）
 *   REC_STOP ─▶ stop() → 组装 Blob → chrome.downloads.download（任务 16/17）
 *
 * 为什么放 offscreen：service worker 负责在用户手势链路内申请 tabCapture
 * 的 streamId，而真正消费该流、操作 DOM 媒体（video/canvas/MediaRecorder）
 * 必须在扩展页面里完成，即 offscreen document（Service Worker 无 DOM，
 * popup 会失焦关闭）。
 */
(() => {
  'use strict';

  /**
   * 输出格式候选链（探测 → 逐个尝试构造，绝不二次转码）：
   * 新版 Chrome（126+，按平台/编码器逐步放行）的 MediaRecorder 原生支持
   * MP4（H.264 视频 + AAC 音频），因此优先请求 mp4；探测失败或构造失败
   * （旧版 Chrome / 平台缺编码器）逐级回退到 webm，行为与旧版本一致。
   * 注意：content 侧 content.js 内有一份同步的 MP4 探测候选，改这里需同步。
   */
  const MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // H.264 Baseline + AAC
    'video/mp4;codecs=avc1.4d401f,mp4a.40.2', // H.264 Main + AAC
    'video/mp4;codecs=avc1.640028,mp4a.40.2', // H.264 High + AAC
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  /** 逐帧裁剪的目标帧率与间隔（30fps） */
  const TARGET_FPS = 30;
  const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

  /**
   * 画布尺寸 / 录制启动前的「矩形稳定帧数」门槛。
   * 播放器初始渲染、进出广告、剧场/全屏切换的瞬间，content 上报的矩形可能
   * 短暂偏大或漂移；若首帧就把该矩形锁成画布尺寸并启动 MediaRecorder，成片
   * 就会以偏大的区域为准——表现为视频上、下方多出网页内容。因此在锁定前
   * 要求同一矩形连续出现 LOCK_STABLE_MIN 帧（约 100ms），期间 canvas 只跟随
   * 绘制、不锁定尺寸，MediaRecorder 也不启动，瞬态矩形绝不会入片。
   */
  const LOCK_STABLE_MIN = 3;

  /** 录制核心状态 */
  const S = {
    phase: 'idle', // idle | preparing | recording | stopping
    tabStream: null, // tabCapture 返回的完整标签页流
    canvasStream: null, // canvas.captureStream 输出（视频轨）
    finalStream: null, // 裁剪视频轨 + 原始音频轨（10.1 / 14.2）
    video: null, // 隐藏 video（任务 11）
    canvas: null,
    ctx: null,
    frameTimer: 0, // 逐帧驱动定时器 id（离屏无 rAF，改用 setTimeout）
    nextFrameAt: 0, // 下一帧的目标时刻（performance.now 基准，做漂移补偿）
    frameCount: 0, // 裁剪循环已执行轮次（诊断：判断循环是否停摆）
    lockKey: '', // 当前候选锁定矩形指纹（整数像素）；连续稳定帧达标前不锁画布 / 不启动录制
    lockStable: 0, // 该矩形已连续出现的帧数（见 LOCK_STABLE_MIN）
    audioTrack: null, // 10.1 原始音频轨（canvas 无音频能力，必须直用）
    audioContext: null, // 新增：用于音频回放的上下文
    audioSource: null, // 新增：音频源节点
    recorder: null,
    outputMime: '', // 探测后最终生效的输出 mimeType（决定下载扩展名 .mp4/.webm）
    chunks: [], // 15.2 分片
    playerRect: null, // content 上报的播放器 CSS 矩形（12.x）
    viewport: null, // content 上报的视口基准（CSS 尺寸 / DPR / 可视视口偏移）
    dpr: 1,
    cropOffsetX: 0, // 画面微调：水平（CSS 像素，正 = 向右）
    cropOffsetY: 0, // 画面微调：垂直（CSS 像素，正 = 向下）
    mappingLogged: false, // 裁剪映射诊断日志（每次会话只输出一次）
    canvasDriftLogged: false, // 画布尺寸漂移诊断（每次会话只输出一次）
    partialViewWarned: false, // 「播放器未完整显示」告警（每次会话只提示一次）
    pipelineStarted: false,
    finalized: false,
    prepTimer: null,
    drmTimer: null,
    lastPrepWaitLogAt: 0,
    lastRectMsgAt: 0, // 最近一次收到 PLAYER_RECT 消息的时间（心跳健康探测）
    rectMsgCount: 0, // 收到 PLAYER_RECT 消息的次数（区分「心跳中断」与「定位不到播放器」）
    pullTimer: null, // preparing 期周期性主动向 content 拉取矩形（心跳中断自愈）
    pendingDownload: null, // { blob, url, filename, attempt, downloadId }
  };

  /** 广播给其它扩展上下文（background 维护全局状态 / popup 渲染状态） */
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
    stopRectPullTimer(); // 准备期结束，停止主动拉取
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
        S.lastRectMsgAt = Date.now(); // 记录心跳到达时刻（健康探测）
        S.rectMsgCount += 1;
        if (message.hasPlayer && message.rect) {
          S.playerRect = message.rect;
          S.viewport = message.viewport || S.viewport; // 视口基准可能随窗口/缩放变化，持续刷新
          S.dpr = (S.viewport && S.viewport.dpr) || message.dpr || 1;
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

  // 环境自检：离屏文档不参与渲染合成，rAF 可能不回调。此处探测一次并写日志，
  // 便于日后区分「rAF 停摆」与「视频源/矩形缺失」两类问题（裁剪循环已改用定时器驱动）。
  (function probeRaf() {
    let rafFired = false;
    try {
      requestAnimationFrame(() => {
        rafFired = true;
      });
    } catch (err) {
      rafFired = false;
    }
    window.setTimeout(() => {
      dlog(
        '环境自检：visibilityState=' +
          (document.visibilityState || '?') +
          '，rAF 回调' +
          (rafFired ? '正常' : '未触发（已改用 setTimeout 驱动裁剪循环）')
      );
    }, 1200);
  })();

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

  /** 读取用户在弹窗中设置的画面微调（CSS 像素）；读不到或异常时按 0 处理 */
  async function loadCropOffset() {
    try {
      if (!chrome.storage || !chrome.storage.sync) return;
      const data = await chrome.storage.sync.get(['yrOffsetX', 'yrOffsetY']);
      S.cropOffsetX = Number(data && data.yrOffsetX) || 0;
      S.cropOffsetY = Number(data && data.yrOffsetY) || 0;
      if (S.cropOffsetX || S.cropOffsetY) {
        dlog('已应用画面微调：x=' + S.cropOffsetX + 'px，y=' + S.cropOffsetY + 'px');
      }
    } catch (err) {
      S.cropOffsetX = 0;
      S.cropOffsetY = 0;
    }
  }

  async function begin(streamId) {
    S.phase = 'preparing';
    S.finalized = false;
    S.pipelineStarted = false;
    S.chunks = [];
    S.playerRect = null;
    S.viewport = null;
    S.dpr = 1;
    S.mappingLogged = false;
    S.canvasDriftLogged = false;
    S.partialViewWarned = false;
    S.recorder = null;
    S.outputMime = '';
    S.lastPrepWaitLogAt = 0;
    S.lastRectMsgAt = 0; // 重置心跳健康探测（区分「心跳中断」与「定位不到播放器」）
    S.rectMsgCount = 0;
    S.frameCount = 0;
    S.lockKey = '';
    S.lockStable = 0;
    if (S.prepTimer) {
      window.clearTimeout(S.prepTimer);
      S.prepTimer = null;
    }
    if (S.drmTimer) {
      window.clearTimeout(S.drmTimer);
      S.drmTimer = null;
    }
    startRectPullTimer(); // 准备期周期性主动拉取播放器矩形（content 心跳偶发中断时自愈）
    await loadCropOffset(); // 读取用户在弹窗中设置的画面微调（CSS 像素）
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
        const AudioContextCtor = window.AudioContext || window['webkitAudioContext'];
        const audioContext = AudioContextCtor ? new AudioContextCtor() : null;
        if (!audioContext) throw new Error('当前环境不支持 AudioContext');
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

    // 准备超时兜底（如非播放页 / 无画面上报）；按失败根因给出可操作提示：
    // ① 心跳中断（content 长时间未上报任何矩形）② 有心跳但定位不到可见播放器
    // ③ 有矩形但视频源始终无有效帧。三者提示不同的处理方向，便于用户自查。
    S.prepTimer = window.setTimeout(() => {
      if (S.phase !== 'preparing') return;
      const heartbeatAge = S.lastRectMsgAt ? Date.now() - S.lastRectMsgAt : Infinity;
      const heartbeatDead = heartbeatAge > 4000; // 距上次心跳过久 ≈ 上报链路中断
      const noPlayerReported = !S.playerRect; // 持续收到心跳但播放器始终不可见
      let message = '';
      if (heartbeatDead) {
        const hbText = S.rectMsgCount > 0 ? Math.round(heartbeatAge / 1000) + ' 秒' : '15 秒';
        message =
          '页面脚本未上报播放器位置（已超过 ' +
          hbText +
          '）。\n' +
          '多为页面脚本已失效或未正确注入，请刷新当前页面后，再点击扩展图标里的「开始录制」。';
      } else if (noPlayerReported) {
        message =
          '未能定位到可见的播放器画面。\n' +
          '请确认：\n' +
          '· 当前确为 YouTube 视频播放页（非首页 / 搜索 / Shorts）\n' +
          '· 播放器完整显示在窗口内（未滚动出屏幕、未最小化窗口、非迷你播放器 / 小窗模式）\n' +
          '· 视频已正常开始播放（非黑屏、非「无法播放」错误页）\n' +
          '· 录制期间标签页保持在前台\n' +
          '满足以上条件后重新点击「开始录制」。';
      } else {
        message =
          '已定位播放器但视频源迟迟未输出有效帧。\n' +
          '多为视频仍在缓冲、广告加载或页面后台节流所致。\n' +
          '请回到前台等待视频正常播放后，重新点击「开始录制」。';
      }
      failModal('初始化超时', message);
    }, 15000);

    S.nextFrameAt = 0; // 逐帧节拍从本刻重新起算
    drawLoop(); // 启动逐帧裁剪循环（13.3，内部自排程）
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
      return '浏览器要求捕获必须由用户手势触发。\n请直接点击扩展图标弹窗中的「开始录制」。';
    }
    if (/permission|denied|not allowed/i.test(msg)) {
      return '捕获被拒绝：请确认扩展权限（tabCapture）已开启，并重新点击「开始录制」。';
    }
    return msg || '未知浏览器错误。';
  }

  // ===================== 准备期主动拉取（自愈） =====================
  //
  // content 心跳（约 120ms 上报一次 PLAYER_RECT）偶尔会因面板 DOM 意外移除 /
  // SPA 布局重置 / interval 被停等而中断；若离屏只被动等待，将盲等至 15s 超时。
  // 这里在 preparing 期周期性向 background 发 PLAYER_RECT_REQUEST，由其定向转发给
  // 录制标签页的 content 立即补报一次，把「心跳中断」从必然超时变为可自愈。
  function startRectPullTimer() {
    stopRectPullTimer();
    S.pullTimer = window.setInterval(() => {
      if (S.phase !== 'preparing') {
        stopRectPullTimer();
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'PLAYER_RECT_REQUEST' });
      } catch (err) {
        /* 通道异常：下一轮再试 */
      }
    }, 2000);
  }

  function stopRectPullTimer() {
    if (S.pullTimer) {
      window.clearInterval(S.pullTimer);
      S.pullTimer = null;
    }
  }

  // ===================== 任务 13：逐帧裁剪循环 =====================

  /**
   * 排程下一帧。
   *
   * 关键：离屏文档（Offscreen Document）没有可见窗口、不参与浏览器的渲染合成，
   * requestAnimationFrame 在其中不会持续回调（实测仅首次触发一次即停），
   * 导致循环跑过一轮后永久停摆，表现为「初始化超时 / 迟迟未输出有效帧」。
   * 因此这里改用 setTimeout 驱动，并按目标帧率做漂移补偿，稳定输出 30fps。
   */
  function scheduleFrame() {
    if (S.phase !== 'preparing' && S.phase !== 'recording') return;
    if (S.frameTimer) return; // 已有排程，避免重复
    const now =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    if (!S.nextFrameAt) S.nextFrameAt = now;
    S.nextFrameAt += FRAME_INTERVAL_MS;
    let delay = S.nextFrameAt - now;
    if (delay < 0 || delay > 1000) {
      // 长时间停顿（后台节流 / 断点 / 首帧）后重新对齐，避免疯狂补帧
      S.nextFrameAt = now;
      delay = 0;
    }
    S.frameTimer = window.setTimeout(() => {
      S.frameTimer = 0;
      drawLoop();
    }, delay);
  }

  /** 停止逐帧驱动 */
  function stopFrameLoop() {
    if (S.frameTimer) {
      window.clearTimeout(S.frameTimer);
      S.frameTimer = 0;
    }
    S.nextFrameAt = 0;
  }

  /**
   * 把 content 上报的 CSS 矩形换算成捕获帧（物理像素）源矩形。
   *
   * 关键修复：tabCapture 输出帧的宽高比不一定与页面 CSS 视口完全一致。
   * 例如浏览器可能把整个视口按统一比例缩放后，再在上下或左右补边以适配
   * 编码尺寸。若简单按 X / Y 分别使用 `帧宽 / 视口宽`、`帧高 / 视口高`
   * 两套比例换算，就会把裁剪框在某一轴上放大，成片表现为视频上下或左右
   * 多录进网页内容。正确模型应是「统一缩放 + 居中补边」。
   *
   * 因此这里按 contain 思路反推：
   * 1. 先把 CSS 视口按统一比例映射进捕获帧；
   * 2. 再加上帧内补边偏移（padX / padY）；
   * 3. DPR 仅作为极端情况下的兜底。
   */
  function mapRectToFrame(r, v) {
    const vp = S.viewport;
    const vvScale = vp && vp.vvScale > 0 ? vp.vvScale : 1;
    // ① 布局视口坐标 → 可视视口坐标。
    // 仅在确实发生捏合缩放（vvScale 明显偏离 1）时才做该换算：桌面 Chrome
    // 部分版本在无捏合缩放时 visualViewport.offsetTop / offsetLeft 会返回文档
    // 滚动量而非 0，盲目相减会让裁剪区整体上移 —— 表现为录进了播放器上方的
    // 网页内容、画面底部被切掉。content 侧已把画面矩形夹进视口，正常情况下
    // 原点修正本就应为 0。
    const pinchZoomed = Math.abs(vvScale - 1) > 0.01;
    const originX = pinchZoomed && vp ? vp.vvX : 0;
    const originY = pinchZoomed && vp ? vp.vvY : 0;
    const cssX = ((r.x || 0) - originX) / vvScale;
    const cssY = ((r.y || 0) - originY) / vvScale;
    const cssW = (r.width || 0) / vvScale;
    const cssH = (r.height || 0) / vvScale;
    // ② CSS → 帧像素：统一缩放 + 帧内补边。
    // tabCapture 对整张页面是等比缩放的；若帧尺寸与 CSS 视口比例不一致，
    // 多出来的那一轴会出现居中补边，而不是页面被非等比拉伸。
    let scale = S.dpr || 1;
    let padX = 0;
    let padY = 0;
    const viewportW = vp && vp.vw > 0 ? vp.vw / vvScale : 0;
    const viewportH = vp && vp.vh > 0 ? vp.vh / vvScale : 0;
    if (viewportW > 0 && viewportH > 0) {
      const measuredX = v.videoWidth / viewportW;
      const measuredY = v.videoHeight / viewportH;
      const containScale = Math.min(measuredX, measuredY);
      if (containScale > 0) {
        scale = containScale;
        padX = Math.max(0, (v.videoWidth - viewportW * scale) / 2);
        padY = Math.max(0, (v.videoHeight - viewportH * scale) / 2);
      }
    }
    // ③ 应用用户在弹窗中设置的画面微调（CSS 像素，正 = 向右 / 向下）
    return {
      sx: padX + (cssX + (S.cropOffsetX || 0)) * scale,
      sy: padY + (cssY + (S.cropOffsetY || 0)) * scale,
      sw: Math.max(0, cssW * scale),
      sh: Math.max(0, cssH * scale),
      scaleX: scale,
      scaleY: scale,
      padX,
      padY,
    };
  }

  /**
   * 播放器未完整可见时提示一次。
   * 此时裁剪区会被夹到画面内，输出会「上方多出网页内容 / 底部被切掉」，
   * 这是录制前滚动了页面或窗口过小导致的，属于可自查项，必须显式告知。
   */
  function warnPartialView(visibleRatio) {
    if (S.partialViewWarned || visibleRatio >= 0.995) return;
    S.partialViewWarned = true;
    broadcast({
      type: 'UI_ACTION',
      action: 'toast',
      payload: {
        type: 'warning',
        message:
          '播放器未完整显示在窗口内（可见比例约 ' +
          Math.round(visibleRatio * 100) +
          '%）。\n录制画面只会包含可见部分，请让播放器完整显示后重新录制。',
      },
    });
  }

  /** 裁剪映射诊断：每次会话输出一次关键数值，便于定位「画面偏移 / 缩放异常」 */
  function logMappingOnce(v, map, srcLeft, srcTop, clippedW, clippedH, cw, ch) {
    if (S.mappingLogged) return;
    S.mappingLogged = true;
    const vp = S.viewport;
    const r = S.playerRect || {};
    const round = (n) => Math.round(n * 100) / 100;
    dlog(
      '裁剪映射：帧=' +
        v.videoWidth +
        'x' +
        v.videoHeight +
        '，CSS视口=' +
        (vp ? vp.vw + 'x' + vp.vh : '未知') +
        '，dpr=' +
        (S.dpr || 1) +
        '，实测缩放=' +
        round(map.scaleX) +
        '/' +
        round(map.scaleY) +
        '，补边=' +
        round(map.padX || 0) +
        '/' +
        round(map.padY || 0) +
        '，矩形=' +
        Math.round(r.width || 0) +
        'x' +
        Math.round(r.height || 0) +
        '@(' +
        Math.round(r.x || 0) +
        ',' +
        Math.round(r.y || 0) +
        ')' +
        (r.via ? '[' + r.via + ']' : '') +
        '，video盒=' +
        (r.box
          ? Math.round(r.box.width) +
            'x' +
            Math.round(r.box.height) +
            '@(' +
            Math.round(r.box.x) +
            ',' +
            Math.round(r.box.y) +
            ')' +
            (r.fit ? '(' + r.fit + ')' : '')
          : '无') +
        '，源区域=(' +
        Math.round(srcLeft) +
        ',' +
        Math.round(srcTop) +
        ') ' +
        Math.round(clippedW) +
        'x' +
        Math.round(clippedH) +
        '，片源=' +
        (r.srcW && r.srcH ? r.srcW + 'x' + r.srcH : '未知') +
        '，画面=' +
        Math.round(r.fullWidth || r.width || 0) +
        'x' +
        Math.round(r.fullHeight || r.height || 0) +
        '，可见=' +
        (typeof r.visible === 'number' ? Math.round(r.visible * 100) + '%' : '未知') +
        '，输出=' +
        cw +
        'x' +
        ch
    );
  }

  /**
   * 画布尺寸漂移诊断（每次会话一次）：
   * 录制开始后画布尺寸被锁定，若后续画面尺寸与之明显不符，输出会按锁定尺寸
   * 拉伸 / 压缩，是「画面比例异常」类问题的首要排查点。
   */
  function logCanvasSizeDrift(wantW, wantH, cw, ch) {
    if (S.canvasDriftLogged) return;
    if (!S.pipelineStarted) return;
    if (Math.abs(wantW - cw) <= 2 && Math.abs(wantH - ch) <= 2) return;
    S.canvasDriftLogged = true;
    dlog(
      '画布尺寸漂移：当前画面=' +
        wantW +
        'x' +
        wantH +
        '，锁定画布=' +
        cw +
        'x' +
        ch +
        '（录制中改变播放器尺寸会导致输出被拉伸）'
    );
  }

  function drawLoop() {
    if (S.phase !== 'preparing' && S.phase !== 'recording') {
      stopFrameLoop();
      return;
    }
    S.frameCount += 1;
    const r = S.playerRect;
    const v = S.video;
    const minReadyState = typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.HAVE_CURRENT_DATA : 2;
    let drewFrame = false;
    if (r && v && v.videoWidth > 0 && v.readyState >= minReadyState && S.ctx) {
      // 12.3 CSS 坐标 → 捕获帧物理像素（实测换算，见 mapRectToFrame）
      const map = mapRectToFrame(r, v);
      const srcLeft = Math.max(0, Math.min(v.videoWidth, map.sx));
      const srcTop = Math.max(0, Math.min(v.videoHeight, map.sy));
      const srcRight = Math.max(0, Math.min(v.videoWidth, map.sx + map.sw));
      const srcBottom = Math.max(0, Math.min(v.videoHeight, map.sy + map.sh));
      const clippedW = Math.max(0, srcRight - srcLeft);
      const clippedH = Math.max(0, srcBottom - srcTop);
      // 画面完整度：优先用 content 上报的可见比例（矩形已夹进视口，
      // 离屏侧 clamp 的结果恒为 1，无法反映「被滚出视口 / 被遮挡」的情况）
      const visibleRatio =
        typeof r.visible === 'number'
          ? r.visible
          : map.sw > 0 && map.sh > 0
            ? (clippedW * clippedH) / (map.sw * map.sh)
            : 0;
      // 允许轻微越界（YouTube 容器与真实视频像素常有 1~2px 偏差），明显滚出视口时仍继续等待。
      // 降低阈值到 0.7 以应对部分滚动或小范围遮挡（12.x 容错优化）
      if (clippedW >= 2 && clippedH >= 2 && visibleRatio >= 0.7) {
        // 输出宽高取偶数（H.264 要求偶数尺寸）；录制开始后锁定画布尺寸，
        // 避免中途分辨率变化导致编码异常或画面被拉伸/裁掉。
        const wantW = Math.max(2, Math.round(clippedW / 2) * 2);
        const wantH = Math.max(2, Math.round(clippedH / 2) * 2);
        // 锁定防抖：MediaRecorder 尚未启动时，裁剪框若在相邻心跳间漂移
        // （播放器初始渲染 / 进出广告 / 剧场全屏切换的瞬态大矩形），canvas
        // 只跟随绘制、不锁尺寸、不启动录制；只有同一矩形（整数像素级）
        // 连续出现 LOCK_STABLE_MIN 帧后才真正锁定画布并启动录制——
        // 避免把短暂偏大的矩形锁成整段成片的尺寸（成片上下多出网页内容）。
        const lockKey =
          Math.round(srcLeft) +
          ',' +
          Math.round(srcTop) +
          ',' +
          Math.round(clippedW) +
          ',' +
          Math.round(clippedH);
        if (!S.pipelineStarted) {
          if (S.lockKey === lockKey) {
            S.lockStable += 1;
          } else {
            S.lockKey = lockKey;
            S.lockStable = 1;
          }
        }
        const stableEnough = S.pipelineStarted || S.lockStable >= LOCK_STABLE_MIN;
        const cw = S.pipelineStarted ? S.canvas.width : wantW;
        const ch = S.pipelineStarted ? S.canvas.height : wantH;
        if (S.canvas.width !== cw || S.canvas.height !== ch) {
          S.canvas.width = cw;
          S.canvas.height = ch;
        }
        // 13.3 源区域取播放器矩形，目标铺满画布 → 完成画面裁剪
        S.ctx.drawImage(v, srcLeft, srcTop, clippedW, clippedH, 0, 0, cw, ch);
        drewFrame = true;
        logMappingOnce(v, map, srcLeft, srcTop, clippedW, clippedH, cw, ch);
        logCanvasSizeDrift(wantW, wantH, cw, ch);
        warnPartialView(visibleRatio);
        if (stableEnough) {
          // 首次满足锁定条件时输出关键数值，便于与成片画面比对定位偏差
          if (!S.pipelineStarted) {
            dlog(
              '锁定裁剪框：源=(' +
                Math.round(srcLeft) +
                ',' +
                Math.round(srcTop) +
                ') ' +
                Math.round(clippedW) +
                'x' +
                Math.round(clippedH) +
                '，画布=' +
                cw +
                'x' +
                ch +
                '，矩形稳定帧=' +
                S.lockStable +
                '（前一个候选稳定帧=' +
                (S.lockStable - 1) +
                '）'
            );
          }
          ensurePipeline();
        }
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
            (v ? v.videoWidth + 'x' + v.videoHeight + ' rs=' + v.readyState : 'none') +
            '，视口=' +
            (S.viewport ? S.viewport.vw + 'x' + S.viewport.vh + ' dpr=' + (S.dpr || 1) : '未知') +
            '，hb=' +
            (S.lastRectMsgAt ? Math.round((now - S.lastRectMsgAt) / 1000) + 's前' : '无') +
            '(x' + S.rectMsgCount + ')' +
            '，loop=x' + S.frameCount
        );
      }
    }
    scheduleFrame(); // 13.4 持续下一轮（定时器驱动，离屏环境无 rAF）
  }

  // ===================== 任务 14 / 15：合流 + MediaRecorder =====================

  /** 首帧有效后一次性建立：canvas 输出流 → finalStream → MediaRecorder */
  function ensurePipeline() {
    if (S.pipelineStarted || S.phase !== 'preparing') return;
    S.pipelineStarted = true;
    try {
      // 14.1 canvas.captureStream：仅含视频轨（帧率与裁剪循环一致）
      const canvasStream = S.canvas.captureStream(TARGET_FPS);
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
      stopRectPullTimer(); // 已进入录制，content 心跳恢复常态，停止主动拉取
      S.phase = 'recording';
      dlog('MediaRecorder 已启动，phase=recording');
      broadcast({ type: 'REC_STATE', phase: 'recording' }); // 13.5 状态联动

      scheduleDrmCheck(); // 18.5
    } catch (err) {
      failModal('录制初始化失败', String((err && err.message) || err));
    }
  }

  /**
   * 创建 MediaRecorder：mp4(H.264/AAC) → webm 按候选链逐档尝试。
   * 部分平台上 isTypeSupported 声称支持 mp4，但 new 时因缺编码器失败，
   * 因此把构造也纳入循环，单档失败自动落回下一档（最终必回到 webm）。
   */
  function createRecorder(stream) {
    let lastErr = null;
    for (const candidate of MIME_CANDIDATES) {
      try {
        if (typeof MediaRecorder.isTypeSupported === 'function' && !MediaRecorder.isTypeSupported(candidate)) {
          continue; // 浏览器明确不支持该容器 / codec 组合
        }
        const recorder = new MediaRecorder(stream, { mimeType: candidate });
        S.outputMime = recorder.mimeType || candidate;
        dlog('已选用输出格式：' + S.outputMime);
        return recorder;
      } catch (err) {
        lastErr = err; // 构造失败（如平台缺编码器）→ 尝试下一档
      }
    }
    try {
      const recorder = new MediaRecorder(stream); // 最后兜底：交由浏览器默认选择
      S.outputMime = recorder.mimeType || '';
      return recorder;
    } catch (err) {
      throw new Error(
        '当前浏览器不支持录制（' + ((lastErr && lastErr.message) || (err && err.message)) + '）'
      );
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
    stopFrameLoop(); // 16.3 停止逐帧驱动
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
    // 按实际选中的输出格式决定扩展名：原生 mp4 输出 .mp4，回退则保持 .webm
    const mime = S.outputMime || (S.recorder && S.recorder.mimeType) || '';
    const ext = /video\/mp4/i.test(mime) ? '.mp4' : '.webm';
    return (
      'YouTube-' +
      stamp.getFullYear() +
      pad(stamp.getMonth() + 1) +
      pad(stamp.getDate()) +
      '-' +
      pad(stamp.getHours()) +
      pad(stamp.getMinutes()) +
      pad(stamp.getSeconds()) +
      ext
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
    stopFrameLoop(); // 18.8 停止逐帧驱动
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
