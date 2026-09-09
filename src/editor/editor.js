/**
 * editor.js —— 视频时间裁剪编辑器主逻辑（阶段十二）
 *
 * 数据来源：优先读取「保存后暂存」的待裁剪视频（shared/pending-video.js，OPFS）；
 * 读取不到（暂存失败 / 已被处理）时退化为让用户自行选择本地视频文件。
 *
 * 职责（高内聚）：把「读取视频 → 生成胶片缩略图 → iOS 风格时间条选区间 →
 * 试听预览 → 调用导出内核覆盖保存原文件」串起来；本身不含时间条与导出实现
 * （分别独立在 trim-bar.js / exporter.js），三者为兄弟模块，互不引用内部细节。
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const videoEl = $('player');

  const dlog = (...args) => console.log('[YR-Editor]', ...args);

  const ui = {
    fileName: $('file-name'),
    empty: $('empty'),
    emptyText: $('empty-text'),
    loading: $('loading'),
    loadingText: $('loading-text'),
    exportBox: $('export'),
    exportBar: $('export-bar'),
    exportMeta: $('export-meta'),
    playBtn: $('btn-play'),
    icoPlay: $('ico-play'),
    muteBtn: $('btn-mute'),
    curTime: $('cur-time'),
    totalTime: $('total-time'),
    rangeLabel: $('range-label'),
    clipDur: $('clip-dur'),
    status: $('status'),
    saveBtn: $('btn-save'),
    closeBtn: $('btn-close'),
    pickBtn: $('btn-pick'),
    picker: $('file-picker'),
    trimBarHolder: $('trim-bar'),
  };

  /** 编辑会话状态 */
  const S = {
    blob: null, // 当前编辑的视频数据
    filename: '',
    objectUrl: '',
    duration: 0,
    loaded: false,
    filmReady: false,
    exporting: false,
    saved: false,
    muted: true, // 预览默认静音（拖动把手 / 试听时不打扰）
    videoReady: false,
    watchTimer: 0,
    loadSeq: 0,
  };

  // ===================== 通用工具 =====================

  function fmtTime(sec) {
    const val = Math.max(0, Number(sec) || 0);
    const m = Math.floor(val / 60);
    const s = val % 60;
    // 保留一位小数，例如 00:05.2
    return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function hasFiniteDuration(video) {
    const d = Number(video && video.duration);
    return isFinite(d) && d > 0;
  }

  function syncVideoDuration() {
    if (!hasFiniteDuration(videoEl)) return false;
    const dur = Number(videoEl.duration);
    if (dur === S.duration && S.loaded) return true; // 已同步过且值没变
    S.duration = dur;
    ui.totalTime.textContent = fmtTime(S.duration);
    return true;
  }

  /** 把视频 seek 到指定秒并等待 seeked（超时不阻断，返回 false 表示超时） */
  function seekTo(video, target, timeoutMs) {
    return new Promise((resolve) => {
      const t = clamp(target, 0, Math.max(0, (video.duration || 0) - 0.001));
      if (!isFinite(t) || Math.abs(video.currentTime - t) < 0.03) {
        resolve(true);
        return;
      }
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', handler);
        resolve(false);
      }, timeoutMs || 2500);
      const handler = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener('seeked', handler);
        resolve(true);
      };
      video.addEventListener('seeked', handler);
      try {
        video.currentTime = t;
      } catch (err) {
        clearTimeout(timer);
        done = true;
        video.removeEventListener('seeked', handler);
        resolve(false);
      }
    });
  }

  function setStatus(text, kind) {
    ui.status.textContent = text || '';
    ui.status.className = 'ed-status' + (kind === 'ok' ? ' is-ok' : kind === 'err' ? ' is-err' : '');
  }

  function setLoading(text) {
    ui.loading.hidden = false;
    ui.loadingText.textContent = text || '正在准备视频…';
  }

  function hideLoading() {
    ui.loading.hidden = true;
  }

  /** 是否对原片做了实际裁剪（选区不等于整段） */
  function rangeIsTrimmed() {
    if (!bar || !S.duration) return false;
    const { start, end } = bar.getRange();
    return end - start < S.duration - 0.2;
  }

  function rangeIsFull() {
    if (!bar || !S.duration) return true;
    const { start, end } = bar.getRange();
    return start <= 0.02 && end >= S.duration - 0.02;
  }

  // ===================== 时间条回调 =====================

  /** 时间条实例（在 setupTrimBar 中创建） */
  let bar = null;

  function onBarRangeChange(range) {
    syncRangeUI(range);
    refreshSaveState();
    if (!range || !range.committing) return; // 拖拽过程中不打扰
    if (rangeIsTrimmed()) {
      setStatus(S.saved ? '已调整裁剪区间，保存将再次替换原文件。' : '');
      onBarSeek(range.start, true); // 定格到选区首帧，便于确认要保留的画面
    } else {
      setStatus('');
      onBarSeek(0, true);
    }
  }

  function onBarSeek(time, committing) {
    if (!S.videoReady || S.exporting) return;
    const v = videoEl;
    if (!v.paused) v.pause(); // 拖动画帧预览时先暂停

    // 增加数值安全检查，防止 NaN 导致 currentTime 报错
    let t = Number(time);
    if (!isFinite(t)) t = 0;

    const target = clamp(t, 0, Math.max(0, S.duration - 0.001));
    try {
      v.currentTime = target;
      if (bar) bar.setPlayhead(target);
    } catch (err) {
      dlog('Seek error:', err);
    }
  }

  function setupTrimBar() {
    bar = window.YRTrimBar.create(ui.trimBarHolder, {
      minSpan: 0.1,
      onRangeChange: (r) => onBarRangeChange(r),
      onSeek: (t, committing) => onBarSeek(t, committing),
    });
    if (S.duration > 0) bar.setDuration(S.duration);
  }

  /** 只负责刷新「保留区间 / 时长」两行文字（不写状态消息，消息由具体动作触发） */
  function syncRangeUI(range) {
    const r = range || (bar && bar.getRange()) || { start: 0, end: 0 };
    ui.rangeLabel.textContent = fmtTime(r.start) + ' – ' + fmtTime(r.end);
    ui.clipDur.textContent = fmtTime(Math.max(0, r.end - r.start)) + ' / ' + fmtTime(S.duration);
  }

  /** 按当前选区与加载状态刷新「保存」按钮可用性（setSaveEnabled 已提升声明） */
  function refreshSaveState() {
    setSaveEnabled(rangeIsTrimmed() && S.loaded && S.filmReady && !S.exporting);
  }

  // ===================== 播放控制 =====================

  function updatePlayIcon(playing) {
    ui.playBtn.classList.toggle('is-playing', !!playing);
  }

  function togglePlay() {
    if (!S.videoReady || S.exporting || !S.filmReady) return;
    const v = videoEl;
    if (!v.paused) {
      v.pause();
      return;
    }
    const { start, end } = bar.getRange();
    if (v.currentTime < start || v.currentTime >= end) v.currentTime = start;
    v.play().catch(() => {});
  }

  function onTimeUpdate() {
    const t = videoEl.currentTime;
    ui.curTime.textContent = fmtTime(t);
    if (bar) bar.setPlayhead(t);
  }

  // ===================== 键盘快捷键 =====================
  // 空格：播放 / 暂停；← / →：播放位置前后移动；Shift+←/→ 大步移动。
  // 注意：这些按键全局拦截（按钮聚焦时同样生效），因此必须 preventDefault，
  // 否则空格默认会去触发当前聚焦按钮（如「保存」），导致功能冲突。
  function nudgePlayhead(deltaSec) {
    if (!S.videoReady || S.exporting) return;
    const v = videoEl;
    const upper = Math.max(0, (S.duration || 0) - 0.001);
    const target = clamp(v.currentTime + deltaSec, 0, upper);
    v.currentTime = target;
    if (bar) bar.setPlayhead(target);
    ui.curTime.textContent = fmtTime(target);
  }

  function onKeyDown(ev) {
    const node = ev.target;
    const tag = node && (node.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (node && node.isContentEditable)) {
      return; // 输入场景不拦截
    }
    if (ev.code === 'Space') {
      ev.preventDefault();
      if (!ev.repeat) togglePlay(); // 长按空格不连续翻转
    } else if (ev.code === 'ArrowLeft') {
      ev.preventDefault();
      nudgePlayhead(-stepForKey(ev));
    } else if (ev.code === 'ArrowRight') {
      ev.preventDefault();
      nudgePlayhead(stepForKey(ev));
    }
  }

  /**
   * 方向键步长：单击 1s；Shift 大步 5s；
   * 按住自动连发时缩到 0.25s，便于快速扫看又不至于飞得太快。
   */
  function stepForKey(ev) {
    if (ev.repeat) return 0.25;
    return ev.shiftKey ? 5 : 1;
  }

  function toggleMute() {
    S.muted = !S.muted;
    videoEl.muted = S.muted;
    ui.muteBtn.textContent = '声音：' + (S.muted ? '关' : '开');
  }

  // ===================== 缩略胶片 =====================

  /** 从视频源裁出「盖满整格」的画面画进格内（cover） */
  function drawCoverCell(ctx, video, cell) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || !cell || cell.w <= 0 || cell.h <= 0) return;
    const cellA = cell.w / cell.h;
    const videoA = vw / vh;
    let sx, sy, sw, sh;
    if (videoA > cellA) {
      sh = vh;
      sy = 0;
      sw = vh * cellA;
      sx = (vw - sw) / 2;
    } else {
      sw = vw;
      sx = 0;
      sh = vw / cellA;
      sy = (vh - sh) / 2;
    }
    ctx.drawImage(video, sx, sy, sw, sh, cell.x, cell.y, cell.w, cell.h);
  }

  /** 逐格 seek 原片并绘制缩略帧 */
  async function paintFilm() {
    if (!bar || !S.duration) return false;
    const info = bar.layoutInfo();
    const cells = info.cells || [];
    if (!cells.length || info.cssW <= 0) return false;

    const ctx = info.ctx;
    // 先画黑色底（canvas.width 被重设后 transform 已复位）
    ctx.setTransform(info.dpr, 0, 0, info.dpr, 0, 0);
    ctx.fillStyle = '#101010';
    ctx.fillRect(0, 0, info.cssW, info.cssH);

    const video = videoEl;
    const wasMuted = video.muted;
    video.muted = true;
    const n = cells.length;
    for (let i = 0; i < n; i++) {
      const mid = ((i + 0.5) / n) * S.duration;
      await seekTo(video, mid, 3000);
      try {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          drawCoverCell(ctx, video, cells[i]);
        }
      } catch (err) {
        /* 单格绘制失败：跳过 */
      }
      if (i % 4 === 3) {
        setLoading('正在生成预览画面… ' + Math.round(((i + 1) / n) * 100) + '%');
        await new Promise((r) => requestAnimationFrame(r));
      }
    }
    video.muted = wasMuted;
    await seekTo(video, 0, 3000);
    video.pause();
    return true;
  }

  // ===================== 视频加载流程 =====================

  function registerVideoEvents() {
    videoEl.addEventListener('loadedmetadata', syncVideoDuration);
    videoEl.addEventListener('durationchange', syncVideoDuration);
    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('play', () => updatePlayIcon(true));
    videoEl.addEventListener('pause', () => updatePlayIcon(false));
    videoEl.addEventListener('ended', () => {
      videoEl.pause();
      updatePlayIcon(false);
      if (bar) bar.setPlayhead(S.duration);
    });
  }

  function failLoad(message) {
    hideLoading();
    setStatus('加载失败：' + message, 'err');
  }

  /** 在设置新视频源前等待元数据，避免本地 / OPFS 文件过快触发导致漏监听 */
  function waitForVideoMetadata(loadSeq, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(
        () => finish(new Error('视频加载超时，未能读取元数据。')),
        timeoutMs || 15000
      );
      const cleanup = () => {
        clearTimeout(timer);
        videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
        videoEl.removeEventListener('durationchange', onLoadedMetadata);
        videoEl.removeEventListener('loadeddata', onLoadedMetadata);
        videoEl.removeEventListener('error', onError);
      };
      const finish = (err) => {
        if (done) return;
        done = true;
        cleanup();
        if (err) reject(err);
        else resolve();
      };
      const onLoadedMetadata = () => {
        if (loadSeq !== S.loadSeq) return;
        if (syncVideoDuration()) finish();
      };
      const onError = () => {
        if (loadSeq !== S.loadSeq) return;
        const mediaErr = videoEl.error;
        let msg = '视频加载失败，文件可能已损坏或格式不受支持。';
        if (mediaErr) {
          msg += ` (Code: ${mediaErr.code}${mediaErr.message ? ', ' + mediaErr.message : ''})`;
        }
        finish(new Error(msg));
      };
      if (loadSeq !== S.loadSeq) {
        finish(new Error('视频源已变更，请重试。'));
        return;
      }
      // 注意：这里不再立即调用 syncVideoDuration，因为 src 刚刚被设置，
      // 必须等待浏览器触发加载事件，以确保读取的是新视频的元数据。
      videoEl.addEventListener('loadedmetadata', onLoadedMetadata);
      videoEl.addEventListener('durationchange', onLoadedMetadata);
      videoEl.addEventListener('loadeddata', onLoadedMetadata);
      videoEl.addEventListener('error', onError);
    });
  }

  /**
   * 主装配：给定 blob / filename 后，加载视频 → 建时间条 → 生成胶片 → 放开交互。
   */
  async function loadAndSetup(blob, filename) {
    const loadSeq = ++S.loadSeq;
    if (S.objectUrl) {
      try {
        URL.revokeObjectURL(S.objectUrl);
      } catch (err) {
        /* ignore */
      }
    }
    S.blob = blob;
    S.filename = filename || 'video.mp4';
    S.duration = 0;
    S.loaded = false;
    S.filmReady = false;
    S.saved = false;
    S.videoReady = false;
    S.objectUrl = URL.createObjectURL(blob);

    ui.fileName.textContent = S.filename || '—';
    ui.fileName.title = S.filename || '';
    ui.empty.hidden = true;
    setLoading('正在准备视频…');
    setStatus('');
    ui.curTime.textContent = '00:00';
    ui.totalTime.textContent = '00:00';
    updatePlayIcon(false);
    
    // 强制复位播放器状态，避免旧视频残留元数据干扰
    try {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
      // 给浏览器一个微任务时间来响应 src 清除
      await new Promise(r => setTimeout(r, 0));
    } catch (err) {
      /* ignore */
    }
    videoEl.muted = S.muted;

    try {
      const ready = waitForVideoMetadata(loadSeq, 15000);
      videoEl.src = S.objectUrl;
      videoEl.load();
      await ready;
    } catch (err) {
      failLoad(String((err && err.message) || err));
      return;
    }

    if (loadSeq !== S.loadSeq) return;
    if (!syncVideoDuration()) {
      failLoad('无法读取视频时长，文件可能已损坏或格式不受支持。');
      return;
    }
    S.loaded = true;

    if (bar) {
      bar.setDuration(S.duration);
    } else {
      setupTrimBar();
    }
    syncRangeUI();

    // 生成胶片缩略图（完成后才开放交互）
    setLoading('正在生成预览画面…');
    const ok = await paintFilm();
    if (!ok) {
      hideLoading();
      setStatus('提示：未能生成预览缩略图，仍可直接拖动选取。', '');
    }
    S.filmReady = true;
    hideLoading();
    S.videoReady = true;
    refreshSaveState();
    setStatus('');
    // 常驻边界监视：播放到选区末端即停（每 80ms 校验一次，轻量）
    if (!S.watchTimer) {
      S.watchTimer = window.setInterval(() => {
        const v = videoEl;
        if (S.exporting || !v || v.paused) return;
        const { end } = bar ? bar.getRange() : { end: 0 };
        if (end > 0 && v.currentTime >= end - 0.04) {
          v.pause();
          if (bar) bar.setPlayhead(Math.min(v.currentTime, end));
          updatePlayIcon(false);
        }
      }, 80);
    }
  }

  // ===================== 保存（裁剪导出并替换原文件） =====================

  function setExportProgress(ratio) {
    const pct = Math.round(clamp(ratio || 0, 0, 1) * 100);
    ui.exportBar.style.width = pct + '%';
    const { start, end } = bar ? bar.getRange() : { start: 0, end: 0 };
    const elapsed = Math.max(0, (end - start) * (ratio || 0));
    ui.exportMeta.textContent =
      pct + '%' + '（已处理 ' + fmtTime(elapsed) + ' / ' + fmtTime(Math.max(0, end - start)) + '）';
  }

  function setSaveEnabled(enabled) {
    if (S.exporting) {
      ui.saveBtn.disabled = true;
      return;
    }
    ui.saveBtn.disabled = !enabled;
  }

  async function runExport() {
    const { start, end } = bar.getRange();
    S.exporting = true;
    ui.exportBox.hidden = false;
    setExportProgress(0);
    ui.playBtn.disabled = true;
    setSaveEnabled(false);
    setStatus('');
    if (!videoEl.paused) videoEl.pause();

    // AudioContext 必须在用户点击手势内同步创建并恢复，规避自动播放策略
    let audioCtx = null;
    try {
      const Ctor = window.AudioContext || window['webkitAudioContext'];
      if (Ctor) {
        audioCtx = new Ctor();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      }
    } catch (err) {
      audioCtx = null;
    }

    const result = await window.YRExporter.exportClip({
      blobUrl: S.objectUrl,
      start,
      end,
      filename: S.filename,
      audioContext: audioCtx,
      onProgress: (ratio) => setExportProgress(ratio),
    });

    S.exporting = false;
    ui.exportBox.hidden = true;
    ui.playBtn.disabled = false;

    if (result && result.ok) {
      S.saved = true;
      setStatus('已保存并替换原文件：' + (result.savedFilename || S.filename), 'ok');
      ui.closeBtn.textContent = '完成';
      refreshSaveState();
    } else {
      setStatus('裁剪失败：' + ((result && result.error) || '未知错误'), 'err');
      refreshSaveState();
    }
  }

  // ===================== 关闭 / 兜底选文件 =====================

  /** 尝试脚本关闭；个别环境 window.close 被拦截时用 chrome.windows 移除自身窗口兜底 */
  function closeSelf() {
    try {
      window.close();
    } catch (err) {
      /* 走到兜底 */
    }
    window.setTimeout(() => {
      try {
        if (!window.closed && chrome.windows) {
          chrome.windows.getCurrent((win) => {
            if (win && typeof win.id === 'number') chrome.windows.remove(win.id);
          });
        }
      } catch (err) {
        /* ignore */
      }
    }, 300);
  }

  async function closeEditor() {
    if (S.exporting) {
      setStatus('正在导出，请等待完成后再关闭。', 'err');
      return;
    }
    if (!S.saved && rangeIsTrimmed()) {
      if (!window.confirm('裁剪尚未保存。关闭窗口将丢弃本次选区设置（原文件不变）。确定关闭吗？')) return;
    }
    if (S.objectUrl) {
      try {
        URL.revokeObjectURL(S.objectUrl);
      } catch (err) {
        /* ignore */
      }
    }
    closeSelf();
  }

  // ===================== 启动 =====================

  function wireEvents() {
    ui.playBtn.addEventListener('click', togglePlay);
    ui.muteBtn.addEventListener('click', toggleMute);
    videoEl.addEventListener('click', togglePlay);
    ui.saveBtn.addEventListener('click', () => {
      if (S.exporting || !S.loaded || !S.filmReady) return;
      if (rangeIsTrimmed()) runExport();
    });
    ui.closeBtn.addEventListener('click', closeEditor);
    // 键盘快捷键：空格 播放/暂停；←/→ 前后移动播放位置
    window.addEventListener('keydown', onKeyDown);
    // 松开空格也要拦截，避免浏览器再把空格当成“激活聚焦按钮”，导致播放状态被二次翻转
    window.addEventListener('keyup', (ev) => {
      if (ev.code === 'Space') ev.preventDefault();
    });
    window.addEventListener('beforeunload', (ev) => {
      if (!S.exporting) return;
      ev.preventDefault();
      ev.returnValue = '';
    });
    // 兜底：没有暂存视频时允许用户自行选择本地文件继续编辑
    ui.pickBtn.addEventListener('click', () => ui.picker.click());
    ui.picker.addEventListener('change', () => {
      const file = ui.picker.files && ui.picker.files[0];
      if (!file) return;
      ui.picker.value = '';
      loadAndSetup(file, file.name || 'video.mp4');
    });
  }

  async function boot() {
    registerVideoEvents();
    wireEvents();
    ui.muteBtn.textContent = '声音：关';
    ui.closeBtn.textContent = '取消';

    // 优先读取「保存后暂存」的待裁剪视频
    let pending = null;
    try {
      pending = window.YRPendingVideo ? await window.YRPendingVideo.load() : null;
    } catch (err) {
      pending = null;
    }

    if (pending && pending.blob) {
      const meta = pending.meta || {};
      const filename = meta.filename || 'video.mp4';
      let blob = pending.blob;
      
      // 修复：如果 File 对象丢失了 MIME 类型（OPFS 恢复常态），尝试从元数据修复
      if (!blob.type && meta.mime) {
        blob = new Blob([blob], { type: meta.mime });
      }

      dlog('启动自动加载暂存视频：' + filename);
      
      try {
        await loadAndSetup(blob, filename);
        // 不再立即清理 OPFS，因为裁剪、导出过程中仍需读取该 Blob（由 OPFS 支撑，删掉会导致 ERR_FILE_NOT_FOUND）
        // OPFS 的同名文件会在下次录制保存时自动被覆盖。
      } catch (err) {
        dlog('自动加载失败：' + err.message);
      }
      return;
    }

    // 暂存缺失：展示空态（可自行选择文件），并提示可能原因
    ui.loading.hidden = true;
    ui.empty.hidden = false;
    setStatus('未找到可裁剪的视频。可手动选择刚保存的本地视频文件。', '');
  }

  boot();
})();
