/**
 * trim-bar.js —— iOS 风格时间区间选择条组件（阶段十二）
 *
 * 视觉：黑色缩略胶片打底（帧图由外部按 layoutInfo() 的格划分逐格绘制），
 * 选中区间两侧压暗、区间高亮，左右两端各一个可拖动的黄色把手；白色细线为播放头。
 *
 * 交互：
 * - 拖动左 / 右把手 → 修改保留区间（start / end），期间逐帧回调 onRangeChange；
 * - 点击或拖动把手之外的胶片 → 预览 seek（onSeek），用于即时预览该时刻画面。
 *
 * 只负责「时间轴选区」这一件事，与视频加载 / 裁剪导出完全解耦。
 * 对外暴露 window.YRTrimBar.create(container, opts) → api。
 */
window.YRTrimBar = (() => {
  'use strict';

  function clamp(v, min, max) {
    let val = Number(v);
    if (isNaN(val)) val = 0;
    return Math.min(max, Math.max(min, val));
  }

  function create(container, opts) {
    const o = opts || {};
    /** 最小可保留时长（秒），防止把区间拖到 0 */
    const minSpan = Math.max(0.05, Number(o.minSpan) || 0.25);

    container.innerHTML =
      '<canvas class="yrbar-film"></canvas>' +
      '<div class="yrbar-dim yrbar-dim-l"></div>' +
      '<div class="yrbar-dim yrbar-dim-r"></div>' +
      '<div class="yrbar-sel"></div>' +
      '<div class="yrbar-grip yrbar-grip-s"></div>' +
      '<div class="yrbar-grip yrbar-grip-e"></div>' +
      '<div class="yrbar-playhead" hidden></div>';

    const canvas = container.querySelector('.yrbar-film');
    const ctx = canvas.getContext('2d');
    const dimL = container.querySelector('.yrbar-dim-l');
    const dimR = container.querySelector('.yrbar-dim-r');
    const sel = container.querySelector('.yrbar-sel');
    const gripS = container.querySelector('.yrbar-grip-s');
    const gripE = container.querySelector('.yrbar-grip-e');
    const playhead = container.querySelector('.yrbar-playhead');

    const st = {
      duration: 0,
      start: 0,
      end: 0,
      width: 0,
      height: 0,
      dpr: 1,
      dragging: null, // 'start' | 'end' | 'scrub'
      dragDx: 0, // 按下点到把手中心的像素偏移，让把手不瞬跳、平滑跟随指针
      changed: false, // 本次拖动是否真的改变了选区
      lastTime: 0,
    };

    /** 把视口内 x 坐标换算成 0..duration 的时间 */
    function timeFromClientX(clientX) {
      const dur = st.duration;
      if (!(dur > 0) || !isFinite(dur)) return 0;
      const rect = container.getBoundingClientRect();
      const width = rect.width || 1;
      const frac = clamp((clientX - rect.left) / width, 0, 1);
      return frac * dur;
    }

    /** 重算容器几何并让 canvas 匹配 CSS 尺寸（保留布局信息供外部绘制胶片） */
    function layoutInfo() {
      const cssW = container.clientWidth || 640;
      const cssH = parseFloat(window.getComputedStyle(container).height) || 76;
      const dpr = window.devicePixelRatio || 1;
      st.width = cssW;
      st.height = cssH;
      st.dpr = dpr;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));

      // 缩略格：目标每格约 56px，总格数 6 ~ 30
      const cellCount = clamp(Math.round(cssW / 56), 6, 30);
      const cellW = cssW / cellCount;
      const cells = [];
      for (let i = 0; i < cellCount; i++) {
        const x = Math.round(i * cellW);
        const w = Math.round((i + 1) * cellW) - x; // 让相邻格无缝
        cells.push({ x, y: 0, w: Math.max(1, w), h: Math.round(cssH) });
      }
      return { cssW, cssH, dpr, cells, ctx, canvas };
    }

    /** 把手 / 区间 / 播放头布局（按百分比定位，胶片区宽度变化时仍正确） */
    function render() {
      const dur = st.duration;
      if (!(dur > 0) || !isFinite(dur)) return;
      
      const sPct = (clamp(st.start, 0, dur) / dur) * 100;
      const ePct = (clamp(st.end, 0, dur) / dur) * 100;
      
      dimL.style.width = sPct + '%';
      dimR.style.left = ePct + '%';
      dimR.style.width = Math.max(0, 100 - ePct) + '%';
      sel.style.left = sPct + '%';
      sel.style.width = Math.max(0, ePct - sPct) + '%';
      gripS.style.left = sPct + '%';
      gripE.style.left = ePct + '%';
    }

    // ===================== 拖动选区 =====================

    function handleMoveTo(ev) {
      const clientX = typeof ev === 'number' ? ev : ev.clientX;
      const mode = st.dragging;
      if (mode === 'start' || mode === 'end') {
        // 按住点与把手中心有偏移时，把手不瞬跳、随指针平滑移动；
        // 一旦把手被 minSpan / 时长边界限制住，就把偏移归零，反向拖动立即跟手。
        let t = timeFromClientX(clientX - st.dragDx);
        const limited = clamp(t, 0, st.duration);
        if (st.dragDx !== 0 && Math.abs(limited - t) > 1e-6) {
          st.dragDx = 0;
          t = timeFromClientX(clientX);
        }

        // 以 0.1s 为步长取整
        t = Math.round(t * 10) / 10;

        if (mode === 'start') {
          const next = clamp(t, 0, st.end - minSpan);
          if (Math.abs(next - st.start) > 1e-6) st.changed = true;
          st.start = next;
        } else {
          const next = clamp(t, st.start + minSpan, st.duration);
          if (Math.abs(next - st.end) > 1e-6) st.changed = true;
          st.end = next;
        }
        render();
        if (o.onRangeChange) o.onRangeChange({ start: st.start, end: st.end, source: mode, committing: false });
      } else if (mode === 'scrub') {
        const t = clamp(timeFromClientX(clientX - st.dragDx), 0, st.duration);
        st.lastTime = t;
        if (o.onSeek) o.onSeek(t, false);
      }
    }

    function endDrag() {
      window.removeEventListener('pointermove', handleMoveTo);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      const mode = st.dragging;
      st.dragging = null;
      st.dragDx = 0;
      container.classList.remove('is-dragging');
      if (!mode) return;
      if (mode === 'start' || mode === 'end') {
        // 仅仅按住把手没真正拖动（例如误触）时不要提交，
        // 避免把视频 seek 到点击处、白线莫名跳动。
        if (st.changed && o.onRangeChange) {
          o.onRangeChange({ start: st.start, end: st.end, source: mode, committing: true });
        }
        st.changed = false;
      } else if (mode === 'scrub' && o.onSeek) {
        o.onSeek(clamp(st.lastTime, 0, st.duration), true);
      }
    }

    function onPointerDown(ev) {
      const dur = st.duration;
      if (!(dur > 0) || !isFinite(dur)) return;

      const rect = container.getBoundingClientRect();
      const width = rect.width || 1;
      const px = ev.clientX - rect.left;
      
      // 计算当前像素位置对应的 start/end/playhead，用于命中检测
      const sx = (clamp(st.start, 0, dur) / dur) * width;
      const ex = (clamp(st.end, 0, dur) / dur) * width;

      const HANDLE_HIT = 28; // 进一步加大命中范围，确保容易抓取
      const target = ev.target;
      let mode;

      if (target === gripS || target.closest('.yrbar-grip-s')) {
        mode = 'start';
        st.dragDx = px - sx;
      } else if (target === gripE || target.closest('.yrbar-grip-e')) {
        mode = 'end';
        st.dragDx = px - ex;
      } else if (target === playhead || target.closest('.yrbar-playhead')) {
        mode = 'scrub';
        const curX = (clamp(st.lastTime || 0, 0, dur) / dur) * width;
        st.dragDx = px - curX;
      } else if (Math.abs(px - sx) <= HANDLE_HIT) {
        mode = 'start';
        st.dragDx = px - sx;
      } else if (Math.abs(px - ex) <= HANDLE_HIT) {
        mode = 'end';
        st.dragDx = px - ex;
      } else {
        mode = 'scrub';
        st.dragDx = 0; // 点击空白处直接跳转
      }

      // 最后的安全检查，防止任何意外导致的 NaN
      if (!isFinite(st.dragDx)) st.dragDx = 0;

      st.dragging = mode;
      st.changed = false;

      ev.preventDefault();
      container.classList.add('is-dragging');
      window.addEventListener('pointermove', handleMoveTo);
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
      
      if (mode === 'scrub') {
        handleMoveTo(ev.clientX);
      }
    }

    container.addEventListener('pointerdown', onPointerDown);

    // ===================== 对外 API =====================

    const api = {
      /** 设置总时长，同时把选区复位为 0..duration */
      setDuration(sec) {
        const d = Number(sec);
        st.duration = (isFinite(d) && d > 0) ? d : 0;
        if (st.duration > 0) {
          st.start = 0;
          st.end = st.duration;
        }
        render();
      },
      /** 外部（如需要程序化复位）设置选区 */
      setRange(start, end) {
        const dur = st.duration;
        if (!(dur > 0) || !isFinite(dur)) return;
        const s = Number(start);
        const e = Number(end);
        st.start = clamp(isFinite(s) ? s : 0, 0, Math.max(0, dur - minSpan));
        st.end = clamp(isFinite(e) ? e : dur, st.start + minSpan, dur);
        render();
      },
      getRange() {
        return { start: st.start, end: st.end };
      },
      getMinSpan() {
        return minSpan;
      },
      /** 胶片布局信息（画布 / 各格矩形 / dpr），供外部逐格绘制缩略帧 */
      layoutInfo,
      /** 播放头位置（秒）；传非数字或 null 则隐藏 */
      setPlayhead(time) {
        if (typeof time === 'number' && isFinite(time) && st.duration > 0) {
          const t = clamp(time, 0, st.duration);
          st.lastTime = t;
          playhead.style.left = (t / st.duration) * 100 + '%';
          playhead.hidden = false;
        } else {
          playhead.hidden = true;
        }
      },
      get el() {
        return container;
      },
    };
    return api;
  }

  return { create };
})();
