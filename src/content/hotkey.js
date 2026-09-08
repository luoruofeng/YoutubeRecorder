/**
 * content/hotkey.js —— 「开始 / 停止录制」页面级快捷键
 *
 * 【为什么放页面里而不是用 chrome.commands】
 * chrome.commands 的全局组合键被 Chrome 强制要求带 Ctrl / Alt（macOS 为 Command），
 * 无法定义用户想要的「单键 R」。而本扩展的录制目标固定是当前视频播放标签页
 * （YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok），在页面内监听既支持单键，又天然只在该页
 * 生效，不会误伤其它标签页。
 *
 * 【为什么不自己判断「该开始还是该停止」】
 * 录制状态的唯一权威在 background（popup 可以随时开关，页面不该缓存状态）。
 * 本文件只上报 `YR_HOTKEY`，由 background 按其真实 phase 决定 start / stop，
 * 避免状态不一致时按错方向。
 *
 * 【为什么必须是捕获阶段且尽早注册】
 * 1. 视频站点（YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok 等）在 document 上绑了大量快捷键，
 *    捕获阶段可以先拦下来（命中后 preventDefault + stopPropagation，
 *    播放器不会再响应同一按键）；
 * 2. 录制期的锁定遮罩（guard.js）也会在捕获阶段拦键，本文件先注册，
 *    因此快捷键的优先级高于遮罩拦截，录制中一定能按到「停止并保存」。
 *
 * 【为什么这里不创建任何 DOM】
 * 页面里任何浮层都会被 tabCapture 合成进捕获帧。快捷键按下后没有任何页面提示，
 * 反馈全部交给：录制开始 → 锁定遮罩出现；录制停止 → 遮罩消失 + 浏览器下载条；
 * 扩展图标徽标（REC / OK / !）以及弹窗中的状态与错误。
 * 全屏场景例外：页面遮罩在全屏时无显示空间，因此在按键链路内顺带打开
 * Document PiP 置顶状态窗（content/pip.js），那是浏览器独立窗口，不会入画。
 */
(() => {
  'use strict';

  const HK = window.YRHotkey;
  if (!HK) return;

  /** 当前生效的快捷键配置 */
  let combo = HK.normalize(HK.DEFAULT_COMBO);

  /** 输入类元素中的按键不拦截（正在搜索 / 发评论时不抢键） */
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return !!el.isContentEditable;
  }

  /** 框选录制的选择器打开时：Esc 退出选择器优先，不抢它的按键 */
  function selectorActive() {
    const api = window.YRSelector;
    return !!(api && typeof api.isActive === 'function' && api.isActive());
  }

  function onKeyDown(e) {
    if (!combo.enabled || !combo.key) return;
    if (e.repeat) return; // 长按不重复触发
    if (isEditable(e.target)) return;
    if (selectorActive()) return;
    if (!HK.matches(combo, e)) return;
    e.preventDefault();
    e.stopPropagation();

    // 全屏下开始录制 → 打开全屏置顶状态窗（Document PiP：REC + 计时 + 停止按钮）。
    // requestWindow 需要瞬态用户激活，必须在本次按键任务里同步调用（pip.js 内部自检
    // 全屏 / 开关 / 是否已在录制，非全屏时直接跳过，不影响原有流程）。
    const pip = window.YRPip;
    if (pip && typeof pip.openIfFullscreen === 'function') pip.openIfFullscreen();

    try {
      chrome.runtime.sendMessage({ type: 'YR_HOTKEY' }, () => {
        // 回执仅用于消化 lastError（无监听方时避免控制台告警）
        void chrome.runtime.lastError;
      });
    } catch (err) {
      /* 扩展上下文失效（升级 / 重载）：忽略 */
    }
  }

  function apply(next) {
    combo = HK.normalize(next);
  }

  HK.read().then(apply);

  // 设置弹窗里改了快捷键 → 本页即时生效，无需刷新
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes[HK.STORAGE_KEY]) return;
      apply(changes[HK.STORAGE_KEY].newValue);
    });
  } catch (err) {
    /* 忽略：storage 不可用则维持默认值 */
  }

  window.addEventListener('keydown', onKeyDown, true);
})();
