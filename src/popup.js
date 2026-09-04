/**
 * popup —— 主界面入口（任务 3.5）
 *
 * 点击「在页面中打开录制面板」→ 向当前激活标签页的 content script
 * 发送 SHOW_PANEL，随后关闭自身。content script 会在 YouTube 页面内
 * 注入 yr-recorder- 前缀的主操作面板（见 content/ui.js）。
 */
(() => {
  'use strict';

  const statusEl = document.getElementById('yr-popup-status');
  const openBtn = document.getElementById('yr-open-panel');

  function setStatus(text, ok) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'yr-popup-status ' + (ok ? 'yr-popup-status-ok' : 'yr-popup-status-err');
  }

  function openPanel() {
    openBtn.disabled = true;
    setStatus('正在通知页面…', true);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (chrome.runtime.lastError || !tab || typeof tab.id !== 'number') {
        setStatus('未找到当前标签页。', false);
        openBtn.disabled = false;
        return;
      }
      // 向该页面的 content script 广播 SHOW_PANEL
      chrome.tabs.sendMessage(tab.id, { type: 'SHOW_PANEL' }, () => {
        if (chrome.runtime.lastError) {
          // 无接收方：非 YouTube 页 / content script 未注入
          setStatus('请先打开 / 刷新一个 YouTube 播放页，再点击此按钮。', false);
          openBtn.disabled = false;
          return;
        }
        window.close(); // 录制面板已在页面内浮出
      });
    });
  }

  openBtn.addEventListener('click', openPanel);
})();
