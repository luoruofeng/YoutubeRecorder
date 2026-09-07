/**
 * shared/hotkey.js —— 「开始 / 停止录制」快捷键的公共定义（popup 与 content 共用）
 *
 * 【为什么单独成文件】
 * 同一份快捷键配置要被三处消费：弹窗设置模态框（读取 / 写入 / 展示）、content 脚本
 * （在 YouTube 页面内监听按键）、以及弹窗主界面的提示文案。三处必须共用同一套
 * 规范化与匹配规则，否则会出现「设置里显示 Alt+R、页面里却只认 R」这类不一致。
 *
 * 【为什么是页面级快捷键，而不是 chrome.commands】
 * chrome.commands 是全局快捷键，但 Chrome 强制要求组合键必须包含 Ctrl / Alt
 * （macOS 为 Command），无法定义「单键 R」这类纯字母快捷键；而本扩展的录制目标
 * 永远是「当前这个 YouTube 标签页」，页面级快捷键既能支持单键、又天然只在该页
 * 生效，不会误伤其它标签页，也能在设置里自由修改。
 *
 * 【存储格式】
 * chrome.storage.sync 的键 `yrHotkey`，值为
 *   { enabled: boolean, key: string, ctrl/alt/shift/meta: boolean }
 * - key 一律小写：字母取物理键位（event.code `KeyR` → 'r'），数字取 `Digit1` → '1'，
 *   其余取 event.key 的小写（'f5' / 'escape' / 'space' / 'arrowup' …）；
 *   用物理键位是为了在非 QWERTY 布局上也能稳定命中。
 * - 修饰键为**严格匹配**：配置了不带 Shift，则按下 Shift+R 不算命中，避免误触发。
 * - key 为空 = 未设置（此时 enabled 视为 false）。
 */
(() => {
  'use strict';

  /** storage.sync 中的键 */
  const STORAGE_KEY = 'yrHotkey';

  /** 默认快捷键：单键 R（空闲开始录制，录制中停止并保存） */
  const DEFAULT_COMBO = {
    enabled: true,
    key: 'r',
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  };

  /** 单独按下时不构成快捷键的键（修饰键自己不能当主键） */
  const INVALID_KEYS = [
    'control',
    'shift',
    'alt',
    'meta',
    'os',
    'capslock',
    'contextmenu',
    'unidentified',
    '',
  ];

  /** 特殊键的展示名 */
  const KEY_LABELS = {
    ' ': 'Space',
    space: 'Space',
    escape: 'Esc',
    enter: 'Enter',
    tab: 'Tab',
    backspace: 'Backspace',
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    home: 'Home',
    end: 'End',
    insert: 'Insert',
    delete: 'Delete',
  };

  /**
   * 浏览器 / 系统级保留组合：这些快捷键由浏览器接管，页面无法拦截，
   * 设置后不会生效（仅作提示，不阻止用户保存）。
   */
  const BROWSER_RESERVED = [
    [{ key: 'r', ctrl: true }, '浏览器刷新页面'],
    [{ key: 'r', meta: true }, '浏览器刷新页面'],
    [{ key: 'f5' }, '浏览器刷新页面'],
    [{ key: 't', ctrl: true }, '浏览器新建标签页'],
    [{ key: 't', meta: true }, '浏览器新建标签页'],
    [{ key: 't', ctrl: true, shift: true }, '浏览器恢复已关闭的标签页'],
    [{ key: 't', meta: true, shift: true }, '浏览器恢复已关闭的标签页'],
    [{ key: 'n', ctrl: true }, '浏览器新建窗口'],
    [{ key: 'n', meta: true }, '浏览器新建窗口'],
    [{ key: 'w', ctrl: true }, '浏览器关闭标签页'],
    [{ key: 'w', meta: true }, '浏览器关闭窗口'],
    [{ key: 'q', ctrl: true }, '浏览器退出'],
    [{ key: 'q', meta: true }, '浏览器退出'],
    [{ key: 'f4', alt: true }, '系统关闭窗口'],
    [{ key: 'l', ctrl: true }, '浏览器地址栏'],
    [{ key: 'l', meta: true }, '浏览器地址栏'],
  ];

  /** YouTube 播放器自带快捷键：覆盖后播放器将不再响应该键 */
  const YOUTUBE_SHORTCUTS = {
    k: '播放 / 暂停',
    j: '快退 10 秒',
    l: '快进 10 秒',
    m: '静音',
    f: '全屏',
    t: '剧场模式',
    i: '迷你播放器',
    c: '字幕开关',
    space: '播放 / 暂停',
    arrowleft: '快退 5 秒',
    arrowright: '快进 5 秒',
    arrowup: '调高音量',
    arrowdown: '降低音量',
    '0': '跳到开头',
    '1': '跳到 10%',
    '2': '跳到 20%',
    '3': '跳到 30%',
    '4': '跳到 40%',
    '5': '跳到 50%',
    '6': '跳到 60%',
    '7': '跳到 70%',
    '8': '跳到 80%',
    '9': '跳到 90%',
  };

  /** 是否 macOS（决定修饰键的展示符号） */
  const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(
    String((navigator.platform || '') + ' ' + (navigator.userAgent || ''))
  );

  function isValidKey(key) {
    return INVALID_KEYS.indexOf(String(key || '').toLowerCase()) < 0;
  }

  /** 从键盘事件取规范化的主键名（字母 / 数字走物理键位，保证跨布局稳定） */
  function keyFromEvent(e) {
    const code = String((e && e.code) || '');
    let m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1].toLowerCase();
    m = /^(?:Digit|Numpad)(\d)$/.exec(code);
    if (m) return m[1];
    const k = String((e && e.key) || '');
    if (k === ' ') return 'space';
    return k.toLowerCase();
  }

  /** 从键盘事件取完整组合（不含 enabled） */
  function comboFromEvent(e) {
    return {
      key: keyFromEvent(e),
      ctrl: !!(e && e.ctrlKey),
      alt: !!(e && e.altKey),
      shift: !!(e && e.shiftKey),
      meta: !!(e && e.metaKey),
    };
  }

  /** 把任意输入（可能来自 storage / 旧版本）规范成合法配置 */
  function normalize(value) {
    const src = value && typeof value === 'object' ? value : {};
    const key = String(src.key || '').toLowerCase();
    if (!isValidKey(key)) {
      // 主键缺失 / 非法 → 视为未设置（enabled 一并置 false，避免页面端误触发）
      return { enabled: false, key: '', ctrl: false, alt: false, shift: false, meta: false };
    }
    return {
      enabled: src.enabled !== false,
      key,
      ctrl: !!src.ctrl,
      alt: !!src.alt,
      shift: !!src.shift,
      meta: !!src.meta,
    };
  }

  /** 键盘事件是否命中该快捷键 */
  function matches(combo, e) {
    if (!combo || !combo.enabled || !combo.key || !e) return false;
    if (combo.ctrl !== !!e.ctrlKey) return false;
    if (combo.alt !== !!e.altKey) return false;
    if (combo.shift !== !!e.shiftKey) return false;
    if (combo.meta !== !!e.metaKey) return false;
    return keyFromEvent(e) === combo.key;
  }

  function modifierLabel(name) {
    if (IS_MAC) {
      if (name === 'ctrl') return '⌃';
      if (name === 'alt') return '⌥';
      if (name === 'shift') return '⇧';
      return '⌘';
    }
    if (name === 'ctrl') return 'Ctrl';
    if (name === 'alt') return 'Alt';
    if (name === 'shift') return 'Shift';
    return 'Win';
  }

  function keyLabel(key) {
    const k = String(key || '');
    if (!k) return '';
    if (KEY_LABELS[k]) return KEY_LABELS[k];
    if (/^f\d{1,2}$/.test(k)) return k.toUpperCase();
    if (k.length === 1) return k.toUpperCase();
    return k.charAt(0).toUpperCase() + k.slice(1);
  }

  /** 组合 → 展示文案（Ctrl + Shift + R / R / 未设置） */
  function format(combo) {
    if (!combo || !combo.key) return '未设置';
    const parts = [];
    if (combo.ctrl) parts.push(modifierLabel('ctrl'));
    if (combo.alt) parts.push(modifierLabel('alt'));
    if (combo.shift) parts.push(modifierLabel('shift'));
    if (combo.meta) parts.push(modifierLabel('meta'));
    parts.push(keyLabel(combo.key));
    return parts.join(' + ');
  }

  function sameCombo(a, b) {
    return (
      !!a &&
      !!b &&
      a.key === b.key &&
      !!a.ctrl === !!b.ctrl &&
      !!a.alt === !!b.alt &&
      !!a.shift === !!b.shift &&
      !!a.meta === !!b.meta
    );
  }

  /**
   * 冲突提示：返回空串表示无冲突。
   * 仅提示不拦截——用户可能就是想用某个键，最终决定权交给用户。
   */
  function describeConflict(combo) {
    if (!combo || !combo.key) return '';
    for (const item of BROWSER_RESERVED) {
      if (sameCombo(item[0], combo)) {
        return '该组合由浏览器 / 系统接管（' + item[1] + '），网页无法拦截，设置后很可能不会生效。';
      }
    }
    const plain = !combo.ctrl && !combo.alt && !combo.meta;
    if (plain && YOUTUBE_SHORTCUTS[combo.key]) {
      return (
        '单键 ' +
        keyLabel(combo.key) +
        ' 是 YouTube 播放器快捷键（' +
        YOUTUBE_SHORTCUTS[combo.key] +
        '），设置后播放器将不再响应该键。'
      );
    }
    return '';
  }

  /** 读取配置（未设置过则返回默认单键 R） */
  function read() {
    return new Promise((resolve) => {
      try {
        if (!chrome.storage || !chrome.storage.sync) {
          resolve(normalize(DEFAULT_COMBO));
          return;
        }
        chrome.storage.sync.get(STORAGE_KEY, (data) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(normalize(DEFAULT_COMBO));
            return;
          }
          const raw = data ? data[STORAGE_KEY] : null;
          resolve(normalize(raw && typeof raw === 'object' ? raw : DEFAULT_COMBO));
        });
      } catch (err) {
        resolve(normalize(DEFAULT_COMBO));
      }
    });
  }

  /** 写入配置（自动规范化） */
  function write(combo) {
    return new Promise((resolve) => {
      try {
        if (!chrome.storage || !chrome.storage.sync) {
          resolve();
          return;
        }
        chrome.storage.sync.set({ [STORAGE_KEY]: normalize(combo) }, () => resolve());
      } catch (err) {
        resolve();
      }
    });
  }

  window.YRHotkey = {
    STORAGE_KEY,
    DEFAULT_COMBO,
    isValidKey,
    keyFromEvent,
    comboFromEvent,
    normalize,
    matches,
    format,
    describeConflict,
    read,
    write,
  };
})();
