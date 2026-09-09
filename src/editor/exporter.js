/**
 * exporter.js —— 时间区间裁剪导出内核（阶段十二）
 *
 * 思路与本项目录制内核同源：不引第三方库，纯浏览器原生「重编码」——
 * 用隐藏 <video> 播放原片并 seek 到选区起点，视频帧逐帧画进 canvas，
 * 音频经 MediaElementAudioSourceNode → MediaStreamDestination 取出，
 * 再把 canvas.captureStream(30) 的视频轨与音频轨合流交给 MediaRecorder，
 * 录到选区终点即得到「只含所选区间」的新文件。最后用 chrome.downloads
 * 覆盖保存原文件（MP4 环境），格式回退（WebM）时另存新名。
 *
 * 说明：浏览器没有「按帧无损切割」的容器级能力，裁剪 = 二次编码，
 * 导出耗时接近视频实际时长，属正常现象。
 *
 * 对外暴露 window.YRExporter.exportClip(opts) → Promise<result>。
 */
window.YRExporter = (() => {
  'use strict';

  /** 输出格式候选链（与 offscreen.js 保持一致：mp4(H.264/AAC) 优先，逐级回退 webm） */
  const MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.4d401f,mp4a.40.2',
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  const TARGET_FPS = 30;

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /** 带超时的事件等待 */
  function waitEvent(target, name, timeoutMs, errMsg) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        target.removeEventListener(name, handler);
        reject(new Error(errMsg || '等待 ' + name + ' 超时'));
      }, timeoutMs || 8000);
      function handler() {
        clearTimeout(timer);
        target.removeEventListener(name, handler);
        resolve();
      }
      target.addEventListener(name, handler);
    });
  }

  /** 轮询等待条件成立 */
  function waitUntil(fn, timeoutMs, errMsg) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        let ok = false;
        try {
          ok = fn();
        } catch (err) {
          ok = false;
        }
        if (ok) {
          resolve();
          return;
        }
        if (Date.now() - start > (timeoutMs || 8000)) {
          reject(new Error(errMsg || '等待条件超时'));
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  /** 逐个候选构造 MediaRecorder（探测构造都纳入循环，逐级回退） */
  function createRecorder(stream) {
    let lastErr = null;
    for (const candidate of MIME_CANDIDATES) {
      try {
        if (typeof MediaRecorder.isTypeSupported === 'function' && !MediaRecorder.isTypeSupported(candidate)) {
          continue;
        }
        return new MediaRecorder(stream, { mimeType: candidate });
      } catch (err) {
        lastErr = err;
      }
    }
    try {
      return new MediaRecorder(stream);
    } catch (err) {
      throw new Error('当前浏览器不支持对视频进行裁剪编码：' + String(((lastErr && lastErr.message) || (err && err.message)) || ''));
    }
  }

  /** 触发一次下载并等待完成 / 中断；resolve {ok, filename} */
  function downloadBlobFile(blob, filename, conflictAction) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const finish = (ok) => {
        try {
          URL.revokeObjectURL(url);
        } catch (err) {
          /* ignore */
        }
        resolve({ ok, filename });
      };
      let downloadId = null;
      try {
        chrome.downloads.download(
          { url, filename, conflictAction: conflictAction || 'uniquify' },
          (id) => {
            if (chrome.runtime.lastError || typeof id !== 'number') {
              finish(false);
              return;
            }
            downloadId = id;
            const onChanged = (delta) => {
              if (!delta || delta.id !== id) return;
              const state = delta.state && delta.state.current;
              if (state === 'complete') {
                chrome.downloads.onChanged.removeListener(onChanged);
                finish(true);
              } else if (state === 'interrupted') {
                chrome.downloads.onChanged.removeListener(onChanged);
                finish(false);
              }
            };
            chrome.downloads.onChanged.addListener(onChanged);
          }
        );
      } catch (err) {
        finish(false);
      }
      // 极端情况下下载完成事件丢失的兜底：别让 Promise 悬挂（主动查询一次）
      setTimeout(() => {
        if (downloadId === null) return;
        try {
          chrome.downloads.search({ id: downloadId }, (items) => {
            const item = items && items[0];
            if (item && item.state === 'complete') finish(true);
            else if (item && item.state === 'interrupted') finish(false);
          });
        } catch (err) {
          /* ignore */
        }
      }, 15000);
    });
  }

  /**
   * 裁剪导出主函数。
   * opts:
   *   blobUrl   原视频 objectURL
   *   start/end 保留区间（秒）
   *   filename  原始文件名（保存成功后覆盖它；格式不一致时另存新名）
   *   audioContext 由调用方在用户手势内同步创建（规避自动播放策略）；可省略
   *   onProgress(ratio) 0..1
   * resolve: { ok, mime, savedFilename, overwritten } | { ok:false, error }
   */
  async function exportClip(opts) {
    const blobUrl = opts.blobUrl;
    const startRaw = Number(opts.start) || 0;
    const endRaw = Number(opts.end) || 0;
    const filename = String(opts.filename || 'video');
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

    const video = document.createElement('video');
    video.muted = true; // 预览与捕获都静音；MediaElementSourceNode 仍能取到音频
    video.playsInline = true;
    video.preload = 'auto';
    video.src = blobUrl;
    video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);

    const cleanup = () => {
      try {
        video.pause();
      } catch (err) {
        /* ignore */
      }
      try {
        video.removeAttribute('src');
        video.load();
      } catch (err) {
        /* ignore */
      }
      if (video.parentNode) video.parentNode.removeChild(video);
    };

    let recorder = null;
    let finalStream = null;
    let videoTrack = null;
    let audioContext = null;
    let raf = 0;

    /** 释放本次导出占用的全部媒体资源（轨道 / 音频上下文 / 隐藏 video） */
    const releaseMedia = () => {
      try {
        if (finalStream) {
          for (const track of finalStream.getTracks()) track.stop();
        }
      } catch (err) {
        /* ignore */
      }
      if (audioContext) {
        try {
          audioContext.close();
        } catch (err) {
          /* ignore */
        }
        audioContext = null;
      }
      cleanup();
    };

    try {
      await waitEvent(video, 'loadedmetadata', 12000, '视频加载失败（无法读取元数据）');
      await waitUntil(
        () => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.duration > 0,
        12000,
        '视频解码超时'
      );

      const duration = video.duration;
      const start = clamp(startRaw, 0, duration);
      const end = clamp(endRaw, start + 0.05, duration);
      if (end - start < 0.05) throw new Error('保留区间过短，无法导出。');

      // 音频图（若调用方在用户手势内创建好了 AudioContext，则直接复用）
      audioContext = opts.audioContext || null;
      if (!audioContext) {
        const Ctor = window.AudioContext || window['webkitAudioContext'];
        audioContext = Ctor ? new Ctor() : null;
      }
      let audioTrack = null;
      let srcNode = null;
      let dst = null;
      if (audioContext) {
        try {
          srcNode = audioContext.createMediaElementSource(video);
          dst = audioContext.createMediaStreamDestination();
          srcNode.connect(dst);
          const audioTracks = dst.stream.getAudioTracks();
          if (audioTracks.length) audioTrack = audioTracks[0];
          if (audioContext.state === 'suspended') {
            try {
              await audioContext.resume();
            } catch (err) {
              /* 自动播放策略兜底失败：仅丢失声音轨仍可导出画面 */
            }
          }
        } catch (err) {
          audioTrack = null;
        }
      }

      // 画布取偶数尺寸（编码要求），保持原分辨率
      const cw = Math.max(2, Math.round((video.videoWidth || 2) / 2) * 2);
      const ch = Math.max(2, Math.round((video.videoHeight || 2) / 2) * 2);
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d', { alpha: false });

      const canvasStream = canvas.captureStream(TARGET_FPS);
      videoTrack = canvasStream.getVideoTracks()[0];

      finalStream = new MediaStream();
      finalStream.addTrack(videoTrack);
      if (audioTrack) finalStream.addTrack(audioTrack);

      recorder = createRecorder(finalStream);
      const mime = recorder.mimeType || 'video/mp4';
      const chunks = [];

      recorder.ondataavailable = (ev) => {
        if (ev && ev.data && ev.data.size > 0) chunks.push(ev.data);
      };

      // 先 seek 到选区起点，再开始录制与播放
      if (start > 0.02) {
        video.currentTime = start;
        await waitEvent(video, 'seeked', 8000, '定位到裁剪起点超时');
      }
      await waitUntil(() => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA, 8000);

      const recorderStopped = new Promise((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start(1000); // 每秒落片，与离屏录制策略一致

      const total = Math.max(0.001, end - start);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (raf) cancelAnimationFrame(raf);
        try {
          video.pause();
        } catch (err) {
          /* ignore */
        }
        try {
          if (recorder && recorder.state !== 'inactive') recorder.stop();
        } catch (err) {
          /* ignore */
        }
      };

      const drawTick = () => {
        if (finished) return;
        const t = video.currentTime;
        if (!video.paused && t >= end - 0.001) {
          onProgress(1);
          finish();
          return;
        }
        if (!video.paused && t >= start) {
          try {
            ctx.drawImage(video, 0, 0, cw, ch);
          } catch (err) {
            /* drawImage 偶发失败：下一帧再试 */
          }
          onProgress(Math.min(1, Math.max(0, (t - start) / total)));
        }
        raf = requestAnimationFrame(drawTick);
      };

      await video.play(); // 用户手势或本地文件自动播放（muted）均可
      raf = requestAnimationFrame(drawTick);

      await recorderStopped;
      try {
        if (raf) cancelAnimationFrame(raf);
      } catch (err) {
        /* ignore */
      }

      const blob = new Blob(chunks, { type: mime });
      if (!blob || !blob.size) throw new Error('裁剪结果为空，导出失败。');

      // 决定保存文件名：同为 MP4 时覆盖原文件；格式回退为 webm 时另存新名，避免伪扩展名
      const isMp4 = /video\/mp4/i.test(mime);
      const extOf = (name) => {
        const m = /\.([A-Za-z0-9]+)$/.exec(name);
        return m ? m[1].toLowerCase() : '';
      };
      const base = filename.replace(/\.[A-Za-z0-9]+$/, '') || 'video';
      let saveName;
      let conflictAction;
      if (isMp4 && extOf(filename) === 'mp4') {
        saveName = filename;
        conflictAction = 'overwrite';
      } else {
        saveName = base + (isMp4 ? '.mp4' : '.webm');
        conflictAction = 'uniquify';
      }

      const saved = await downloadBlobFile(blob, saveName, conflictAction);
      releaseMedia();
      if (!saved.ok) throw new Error('保存失败：浏览器未能写入文件（可能被占用，请重试或手动另存）。');

      return { ok: true, mime, savedFilename: saved.filename, overwritten: conflictAction === 'overwrite' };
    } catch (err) {
      try {
        if (raf) cancelAnimationFrame(raf);
      } catch (e) {
        /* ignore */
      }
      try {
        if (recorder && recorder.state !== 'inactive') recorder.stop();
      } catch (e) {
        /* ignore */
      }
      releaseMedia();
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  return { exportClip, MIME_CANDIDATES };
})();
