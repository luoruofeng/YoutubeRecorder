/**
 * ask.js —— 「保存成功后是否裁剪」询问小窗逻辑（阶段十二）
 *
 * 由 background 在视频保存成功（离屏已把视频暂存 OPFS）后自动打开。
 * - 「去裁剪」→ 打开编辑器窗口 editor.html（数据保留在 OPFS，编辑器自行读取）；
 * - 「不需要」→ 清理暂存数据并关闭。
 *
 * 本文件只做「询问 → 路由」，不包含任何裁剪实现，职责单一。
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fileEl = $('ask-file');
  const descEl = $('ask-desc');
  const tipEl = $('ask-tip');
  const yesBtn = $('ask-yes');
  const noBtn = $('ask-no');

  /** 是否已确认存在可裁剪的视频（决定「去裁剪」按钮可用性） */
  let ready = false;

  /** 脚本关闭自身；个别环境 window.close 被拦截时用 chrome.windows 兜底 */
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

  function setBusy(busy) {
    yesBtn.disabled = busy || !ready;
    noBtn.disabled = busy;
  }

  async function init() {
    let pending = null;
    try {
      pending = window.YRPendingVideo ? await window.YRPendingVideo.load() : null;
    } catch (err) {
      pending = null;
    }

    if (pending && pending.meta && pending.meta.filename) {
      fileEl.textContent = '文件：' + pending.meta.filename;
      fileEl.title = pending.meta.filename;
      ready = true;
      tipEl.hidden = true;
    } else if (pending && pending.blob) {
      fileEl.textContent = '文件：刚保存的视频（无文件名信息）';
      fileEl.title = '';
      ready = true;
      tipEl.hidden = true;
    } else {
      // 暂存数据不存在：可能是已被处理，或当前环境（无 OPFS / 写入失败）不支持
      descEl.textContent = '没有找到可裁剪的视频。它可能已被处理，或本次环境的暂存未能生效。';
      tipEl.textContent = '无需处理，关闭本窗口即可。';
      fileEl.hidden = true;
      yesBtn.disabled = true;
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  // 「去裁剪」：打开编辑器窗口后关闭本询问窗。暂存数据保留，由编辑器读取并负责清理。
  yesBtn.addEventListener('click', async () => {
    if (!ready) return;
    setBusy(true);
    tipEl.hidden = false;
    tipEl.textContent = '正在打开视频裁剪编辑器…';
    try {
      await new Promise((resolve) => {
        chrome.windows.create(
          {
            url: chrome.runtime.getURL('editor.html'),
            type: 'normal',
            width: 1120,
            height: 820,
            focused: true,
          },
          () => resolve()
        );
      });
      closeSelf();
    } catch (err) {
      setBusy(false);
      tipEl.textContent = '打开编辑器失败：' + String((err && err.message) || err);
    }
  });

  // 「不需要」：清理本次暂存（释放磁盘），关闭询问窗；原始录制文件保持不变。
  noBtn.addEventListener('click', async () => {
    setBusy(true);
    if (window.YRPendingVideo) {
      try {
        await window.YRPendingVideo.clear();
      } catch (err) {
        /* 清理失败：残留由下次保存覆盖，忽略 */
      }
    }
    closeSelf();
  });

  init();
})();
