/**
 * content script —— UI 组件层（任务 4 ~ 任务 8）
 *
 * - 全部自定义 DOM 统一使用 `yr-recorder-` 前缀，避免污染 YouTube 页面。
 * - 样式全部由本文件动态创建 <style> 注入，选择器均带 `yr-recorder-` 前缀，
 *   不使用通用标签选择器，不使用任何外部 CSS / UI 库。
 * - 提供：主面板 / 模态框 / 加载框（行内 + 全屏）/ toast / 主题适配 / 全局清理。
 *
 * 对外暴露 window.YRUI。
 */
(() => {
  'use strict';

  /** @type {string} 注入 style 的 id，用于幂等与清理 */
  const STYLE_ID = 'yr-recorder-style';

  /** 状态文本映射（任务 5.3.2 五态） */
  const PHASE_TEXT = {
    idle: '空闲',
    capturing: '准备捕获标签页',
    recording: '正在录制',
    stopping: '停止处理中',
    exported: '导出完成',
  };

  /**
   * 全部自定义样式（CSS 变量两套配色，见 4.3；选择器全部带前缀，见 4.2）。
   * 深色切换通过根节点上的 .yr-recorder-dark 类完成（4.3）。
   */
  const CSS_TEXT = `
/* ===== 变量（浅色为默认，.yr-recorder-dark 覆盖为深色） ===== */
.yr-recorder-panel,
.yr-recorder-modal,
.yr-recorder-loading-mask,
.yr-recorder-toast {
  --yr-bg: #ffffff;
  --yr-text: #111111;
  --yr-text-muted: #8a8a8a;
  --yr-divider: rgba(0, 0, 0, 0.07);
  --yr-primary: #1a73e8;
  --yr-primary-hover: #1765cc;
  --yr-danger: #e62117;
  --yr-danger-hover: #c71f16;
  --yr-success: #188038;
  --yr-disabled-bg: #ececec;
  --yr-disabled-text: #a8a8a8;
  --yr-overlay: rgba(0, 0, 0, 0.6);
  --yr-shadow: 0 4px 12px rgba(120, 120, 120, 0.12), 0 18px 56px rgba(120, 120, 120, 0.3);
  --yr-spin-track: rgba(120, 120, 120, 0.25);
  --yr-toast-success: rgba(46, 160, 67, 0.92);
  --yr-toast-warning: rgba(214, 138, 18, 0.94);
  --yr-toast-error: rgba(214, 40, 33, 0.92);
  --yr-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
    'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
}

.yr-recorder-dark {
  --yr-bg: #212121;
  --yr-text: #f1f1f1;
  --yr-text-muted: #9c9c9c;
  --yr-divider: rgba(255, 255, 255, 0.09);
  --yr-primary: #4c8dff;
  --yr-primary-hover: #6ba1ff;
  --yr-danger: #ff5252;
  --yr-danger-hover: #ff7070;
  --yr-success: #4caf50;
  --yr-disabled-bg: #3a3a3a;
  --yr-disabled-text: #7a7a7a;
  --yr-overlay: rgba(0, 0, 0, 0.7);
  --yr-shadow: 0 4px 12px rgba(0, 0, 0, 0.5), 0 18px 56px rgba(0, 0, 0, 0.6);
  --yr-spin-track: rgba(255, 255, 255, 0.22);
}

/* ===== 旋转动画（7.3：纯 @keyframes，无图片/SVG） ===== */
@keyframes yr-recorder-spin {
  to { transform: rotate(360deg); }
}
@keyframes yr-recorder-toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.yr-recorder-spinner {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--yr-spin-track);
  border-top-color: var(--yr-primary);
  animation: yr-recorder-spin 0.8s linear infinite;
}

/* ===== 主操作面板（任务 5） ===== */
.yr-recorder-panel {
  position: fixed;
  top: 12%;
  right: 24px;
  z-index: 99999; /* 5.1 */
  width: 340px; /* 5.2 */
  box-sizing: border-box;
  background: var(--yr-bg);
  color: var(--yr-text);
  border-radius: 12px; /* 5.2 */
  box-shadow: var(--yr-shadow); /* 5.2 柔和浅灰大模糊阴影 */
  font-family: var(--yr-font);
  font-size: 14px;
  text-align: left;
  line-height: 1.5;
}

.yr-recorder-header { /* 5.3.1 标题区 */
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px; /* 上下留 12px 内边距 */
  border-bottom: 1px solid var(--yr-divider);
}

.yr-recorder-title {
  font-size: 16px;
  font-weight: 700;
}

.yr-recorder-close {
  border: none;
  background: transparent;
  color: var(--yr-text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.yr-recorder-close:hover {
  background: var(--yr-divider);
}

.yr-recorder-status { /* 5.3.2 状态区 */
  padding: 12px 16px 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.yr-recorder-state-text {
  font-size: 13px;
  color: var(--yr-text);
}
.yr-recorder-state-capturing,
.yr-recorder-state-stopping {
  color: var(--yr-primary); /* 处理中：蓝色 */
}
.yr-recorder-state-recording {
  color: var(--yr-danger); /* 录制中：醒目红色 */
  font-weight: 600;
}
.yr-recorder-state-exported {
  color: var(--yr-success);
}

/* 行内加载（7.1）：嵌入面板内，旋转圈 + 文字 */
.yr-recorder-inline-loading {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 8px 16px 0;
  color: var(--yr-text-muted);
  font-size: 12px;
}
.yr-recorder-inline-loading.yr-recorder-show {
  display: flex;
}

/* 5.3.3 + 5.4 按钮区 */
.yr-recorder-actions {
  padding: 14px 16px 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.yr-recorder-btn {
  display: block;
  width: 100%;
  height: 40px;
  box-sizing: border-box;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-family: inherit;
  color: #ffffff;
  cursor: pointer;
  transition: background 0.15s ease;
}

.yr-recorder-btn-start { background: var(--yr-primary); } /* 开始：蓝底白字 */
.yr-recorder-btn-start:hover:not(:disabled) { background: var(--yr-primary-hover); }

.yr-recorder-btn-stop { background: var(--yr-danger); } /* 停止：红底白字 */
.yr-recorder-btn-stop:hover:not(:disabled) { background: var(--yr-danger-hover); }

.yr-recorder-btn:disabled { /* 禁用态浅灰背景 */
  background: var(--yr-disabled-bg);
  color: var(--yr-disabled-text);
  cursor: not-allowed;
}

/* 5.3.4 提示文本区 */
.yr-recorder-tip {
  padding: 0 16px 12px;
  font-size: 12px;
  color: var(--yr-text-muted);
}

/* ===== 模态框（任务 6） ===== */
.yr-recorder-overlay { /* 6.1 遮罩 */
  position: fixed;
  inset: 0;
  background: var(--yr-overlay);
  z-index: 100000; /* 高于主面板 */
}

.yr-recorder-modal { /* 6.2 本体 */
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 420px;
  max-width: 90vw;
  box-sizing: border-box;
  background: var(--yr-bg);
  color: var(--yr-text);
  border-radius: 12px;
  padding: 22px 24px;
  z-index: 100001;
  box-shadow: var(--yr-shadow);
  font-family: var(--yr-font);
  text-align: left;
}

.yr-recorder-modal-title { /* 6.3 标题 */
  font-size: 16px;
  font-weight: 700;
  margin: 0 0 10px;
}

.yr-recorder-modal-body { /* 6.3 正文 */
  font-size: 14px;
  line-height: 1.65;
  white-space: pre-line;
  margin: 0 0 18px;
}

.yr-recorder-modal-footer {
  display: flex;
  justify-content: flex-end;
}

.yr-recorder-modal-ok {
  width: auto;
  padding: 0 24px;
}

/* ===== 全屏悬浮加载弹窗（7.2） ===== */
.yr-recorder-loading-mask {
  position: fixed;
  inset: 0;
  background: var(--yr-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100002;
}

.yr-recorder-loading-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  max-width: 340px;
  box-sizing: border-box;
  padding: 28px 36px;
  background: var(--yr-bg);
  color: var(--yr-text);
  border-radius: 14px;
  box-shadow: var(--yr-shadow);
  font-family: var(--yr-font);
  font-size: 14px;
  line-height: 1.7;
  text-align: center;
}

.yr-recorder-loading-card .yr-recorder-spinner {
  width: 42px;
  height: 42px;
  border-width: 3px;
}

/* ===== toast（任务 8） ===== */
.yr-recorder-toast {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 100010; /* 最高 */
  max-width: 320px;
  box-sizing: border-box;
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
  color: #ffffff;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  animation: yr-recorder-toast-in 0.18s ease-out;
  font-family: var(--yr-font);
}

.yr-recorder-toast-success { background: var(--yr-toast-success); } /* 8.2 成功绿半透明 */
.yr-recorder-toast-warning { background: var(--yr-toast-warning); } /* 8.2 警告黄半透明 */
.yr-recorder-toast-error { background: var(--yr-toast-error); } /* 8.2 错误红半透明 */

.yr-recorder-toast-leaving {
  opacity: 0;
  transition: opacity 0.3s ease;
}
`;

/** 工具：创建元素 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** 注入样式（4.4） */
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = el('style');
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  (document.head || document.documentElement).appendChild(style);
}

/** 移除单个样式节点 */
function removeStyle() {
  const style = document.getElementById(STYLE_ID);
  if (style) style.remove();
}

/** 深色主题检测（4.3）：YouTube 新聚合物主题以 <html dark/light> 标记，兼容系统偏好 */
function isDarkTheme() {
  const html = document.documentElement;
  if (html.hasAttribute('dark')) return true;
  if (html.hasAttribute('light')) return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 对给定根节点同步明暗 class */
function applyTheme(root) {
  if (!root) return;
  if (isDarkTheme()) root.classList.add('yr-recorder-dark');
  else root.classList.remove('yr-recorder-dark');
}

/** 当前存活的组件根（面板 / 模态框 / 全屏加载），主题变化时统一刷新 */
function refreshAllTheme() {
  document.querySelectorAll('.yr-recorder-panel, .yr-recorder-modal, .yr-recorder-loading-mask')
    .forEach(applyTheme);
}

// ============ 模块状态 ============

/** @type {Element|null} 面板根 */
let panelRoot = null;
/** @type {Element|null} 状态文本节点 */
let stateTextEl = null;
/** @type {Element|null} 行内加载节点 */
let inlineLoadingEl = null;
/** @type {Element|null} 行内加载文字节点 */
let inlineLoadingTextEl = null;

/** 用户交互回调（由 content.js 注入） */
const handlers = {
  onStart: null, // () => void
  onStop: null,  // () => void
  onClose: null, // () => void
};

/** 主题监听资源（4.5 清理用） */
const themeObserver = new MutationObserver(refreshAllTheme);

/** 主题监听是否已启动（init/cleanup 幂等控制） */
let themeWatching = false;
/** matchMedia 监听回调（便于重复启动时先解绑） */
let mqChangeHandler = null;

/** 启动明暗主题监听（4.3）；幂等，可在 cleanup 后再次调用 */
function startThemeWatch() {
  if (themeWatching) return;
  themeWatching = true;
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['dark', 'light'] });
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mqChangeHandler = () => refreshAllTheme();
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', mqChangeHandler);
    else if (typeof mq.addListener === 'function') mq.addListener(mqChangeHandler);
  }
}

// ============ 主面板（任务 5） ============

function removeExistingPanel() {
  const old = document.querySelector('.yr-recorder-panel');
  if (old) old.remove();
}

function buildPanel() {
  removeExistingPanel();

  const panel = el('div', 'yr-recorder-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'YouTube Recorder 录制面板');

  // 标题区（5.3.1）
  const header = el('div', 'yr-recorder-header');
  header.appendChild(el('div', 'yr-recorder-title', 'YouTube Recorder'));
  const closeBtn = el('button', 'yr-recorder-close', '\u00d7');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '关闭录制面板');
  closeBtn.addEventListener('click', () => {
    if (typeof handlers.onClose === 'function') handlers.onClose();
  });
  header.appendChild(closeBtn);

  // 状态区（5.3.2）
  const statusRow = el('div', 'yr-recorder-status');
  stateTextEl = el('span', 'yr-recorder-state-text yr-recorder-state-idle', PHASE_TEXT.idle);
  statusRow.appendChild(stateTextEl);

  // 行内加载（7.1）
  inlineLoadingEl = el('div', 'yr-recorder-inline-loading');
  inlineLoadingTextEl = el('span', 'yr-recorder-inline-loading-text', '正在初始化捕获流');
  inlineLoadingEl.appendChild(el('span', 'yr-recorder-spinner'));
  inlineLoadingEl.appendChild(inlineLoadingTextEl);

  // 按钮区（5.3.3）
  const actions = el('div', 'yr-recorder-actions');
  const startBtn = el('button', 'yr-recorder-btn yr-recorder-btn-start yr-recorder-start-btn', '开始录制');
  startBtn.type = 'button';
  startBtn.addEventListener('click', () => {
    if (typeof handlers.onStart === 'function') handlers.onStart();
  });
  const stopBtn = el('button', 'yr-recorder-btn yr-recorder-btn-stop yr-recorder-stop-btn', '停止录制');
  stopBtn.type = 'button';
  stopBtn.disabled = true; // 空闲时停止按钮置灰（5.3.3）
  stopBtn.addEventListener('click', () => {
    if (typeof handlers.onStop === 'function') handlers.onStop();
  });
  actions.appendChild(startBtn);
  actions.appendChild(stopBtn);

  // 提示文本区（5.3.4）
  const tip = el(
    'div',
    'yr-recorder-tip',
    '输出格式：webm。录制期间请勿切换标签页、滚动页面或缩放窗口，并保持播放器完整可见。'
  );

  panel.appendChild(header);
  panel.appendChild(statusRow);
  panel.appendChild(inlineLoadingEl);
  panel.appendChild(actions);
  panel.appendChild(tip);

  applyTheme(panel);
  document.body.appendChild(panel);
  panelRoot = panel;
  return panel;
}

// ============ 模态框（任务 6） ============

/**
 * 弹出全局模态框；点击确认后移除（6.4）。
 * @param {{title:string, body:string, okText?:string}} opts
 * @returns {Promise<void>}
 */
function showModal(opts) {
  injectStyle(); // 确保 cleanup 后重开时样式仍可用
  return new Promise((resolve) => {
    const overlay = el('div', 'yr-recorder-overlay');
    const box = el('div', 'yr-recorder-modal');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    box.appendChild(el('div', 'yr-recorder-modal-title', opts.title || '提示'));
    box.appendChild(el('div', 'yr-recorder-modal-body', opts.body || ''));

    const footer = el('div', 'yr-recorder-modal-footer');
    const okBtn = el('button', 'yr-recorder-btn yr-recorder-btn-start yr-recorder-modal-ok', opts.okText || '我知道了');
    okBtn.type = 'button';
    const close = () => {
      overlay.remove();
      box.remove();
      resolve();
    };
    okBtn.addEventListener('click', close);
    footer.appendChild(okBtn);
    box.appendChild(footer);

    applyTheme(overlay);
    applyTheme(box);
    document.body.appendChild(overlay);
    document.body.appendChild(box);
  });
}

// ============ 加载框（任务 7） ============

/** 行内加载：显示 / 隐藏（7.1） */
function setInlineLoading(show, text) {
  if (!inlineLoadingEl) return;
  if (show) inlineLoadingEl.classList.add('yr-recorder-show');
  else inlineLoadingEl.classList.remove('yr-recorder-show');
  if (typeof text === 'string' && text.length > 0 && inlineLoadingTextEl) {
    inlineLoadingTextEl.textContent = text;
  }
}

/** 全屏悬浮加载（7.2）：保证单例 */
let fullLoadingEl = null;

function setFullLoading(show, text) {
  injectStyle(); // 确保 cleanup 后重开时样式仍可用
  if (show) {
    if (fullLoadingEl) return; // 已显示
    const mask = el('div', 'yr-recorder-loading-mask');
    const card = el('div', 'yr-recorder-loading-card');
    card.appendChild(el('span', 'yr-recorder-spinner'));
    card.appendChild(el('div', 'yr-recorder-loading-text', text || '正在组装视频文件，请稍候，不要关闭页面'));
    mask.appendChild(card);
    applyTheme(mask);
    document.body.appendChild(mask);
    fullLoadingEl = mask;
  } else if (fullLoadingEl) {
    fullLoadingEl.remove();
    fullLoadingEl = null;
  }
}

// ============ toast（任务 8） ============

/** @type {Element|null} 当前 toast */
let toastEl = null;

/**
 * 轻量提示，3 秒自动消失（8.3）。
 * @param {string} text
 * @param {'success'|'warning'|'error'} type
 */
function toast(text, type) {
  injectStyle(); // 确保 cleanup 后重开时样式仍可用
  if (toastEl) toastEl.remove(); // 同类型快速连发时替换
  const node = el('div', `yr-recorder-toast yr-recorder-toast-${type || 'success'}`, text);
  toastEl = node;
  document.body.appendChild(node);
  window.setTimeout(() => {
    node.classList.add('yr-recorder-toast-leaving');
    window.setTimeout(() => {
      node.remove();
      if (toastEl === node) toastEl = null;
    }, 300);
  }, 3000);
}

// ============ 全局监听与清理（4.5） ============

/** 记录在 window/document 等上的监听器，供统一清理 */
const globalListeners = [];

/** @type {MutationObserver[]} */
const trackedObservers = [];

/** 注册需要随组件清理的全局监听 */
function addGlobalListener(target, type, fn, options) {
  globalListeners.push({ target, type, fn, options });
  target.addEventListener(type, fn, options);
}

/** 登记 MutationObserver，随清理断开 */
function trackObserver(observer) {
  trackedObservers.push(observer);
  return observer;
}

/**
 * 全量清理（4.5 / 17.5 / 18.10）：
 * 移除全部 yr-recorder- 节点、style、事件监听与 CSS 动画。
 */
function cleanup() {
  // 移除全部自定义节点（含面板 / 模态框 / 遮罩 / toast / 加载框）
  document.querySelectorAll('[class*="yr-recorder-"]').forEach((n) => n.remove());
  panelRoot = null;
  stateTextEl = null;
  inlineLoadingEl = null;
  inlineLoadingTextEl = null;
  fullLoadingEl = null;
  toastEl = null;

  // 移除监听器
  for (const l of globalListeners) {
    l.target.removeEventListener(l.type, l.fn, l.options);
  }
  globalListeners.length = 0;

  // 断开 Observer
  themeObserver.disconnect();
  themeWatching = false;
  trackedObservers.forEach((o) => o.disconnect());
  trackedObservers.length = 0;

  removeStyle();
}

// ============ 状态控制 API ============

/**
 * 更新状态区文字与颜色（5.3.2）。
 * @param {keyof typeof PHASE_TEXT} phase
 */
function setStatus(phase) {
  if (!stateTextEl) return;
  const text = PHASE_TEXT[phase] || PHASE_TEXT.idle;
  stateTextEl.textContent = text;
  stateTextEl.className = 'yr-recorder-state-text yr-recorder-state-' + (PHASE_TEXT[phase] ? phase : 'idle');
}

/** 按钮互斥控制（5.3.3）：开始/停止默认不同时可用 */
function setButtons(startDisabled, stopDisabled) {
  const panel = panelRoot || document.querySelector('.yr-recorder-panel');
  if (!panel) return;
  const start = panel.querySelector('.yr-recorder-start-btn');
  const stop = panel.querySelector('.yr-recorder-stop-btn');
  if (start) start.disabled = !!startDisabled;
  if (stop) stop.disabled = !!stopDisabled;
}

// ============ 对外接口 ============

window.YRUI = {
  init() {
    injectStyle(); // 4.4 注入动态样式
    startThemeWatch(); // 4.3 启动主题监听（幂等）
  },

  isDarkTheme,
  refreshAllTheme,
  applyTheme,

  /** 打开主面板（任务 5）：确保样式已注入、主题监听存活 */
  openPanel() {
    injectStyle();
    startThemeWatch();
    buildPanel();
  },

  /** 关闭主面板 */
  closePanel() {
    removeExistingPanel();
    panelRoot = null;
    stateTextEl = null;
    inlineLoadingEl = null;
    inlineLoadingTextEl = null;
  },

  get panelVisible() {
    return !!document.querySelector('.yr-recorder-panel');
  },

  /** 面板按钮回调注册 */
  setHandlers(h) {
    Object.assign(handlers, h || {});
  },

  setStatus,
  setButtons,

  /** 7.1 行内加载（正在获取标签页流等短时等待） */
  setInlineLoading,

  /** 7.2 全屏悬浮加载（组装 blob 等耗时阶段） */
  setFullLoading,

  /** 6.x 模态框；resolve 时机 = 用户点击确认 */
  showModal,

  /** 8.x toast */
  toast,

  /** 4.5 统一清理 */
  cleanup,

  addGlobalListener,
  trackObserver,
};
})();
