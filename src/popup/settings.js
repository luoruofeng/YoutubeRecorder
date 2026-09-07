/**
 * popup/settings.js —— 弹窗内的「设置」模态框（当前负责「录制快捷键」配置）
 *
 * 【为什么模态框在弹窗里，而不是在 YouTube 页面里】
 * tabCapture 捕获的是整个标签页的合成画面，任何注入页面的浮层都会被合成进捕获帧、
 * 出现在最终视频里。popup 是扩展自己的页面，不属于被捕获标签页的渲染内容，
 * 因此设置界面与快捷键配置都不会污染录制画面。
 *
 * 【为什么自己建 DOM 而不是写在 popup.html 里】
 * 设置面板与它的样式、捕获按键的交互、冲突校验是一个自成一体的小组件；
 * 全部收敛在本文件里（含内联样式），popup.html 只需一个「设置」按钮和一个
 * script 标签，主界面不会被设置项撑长。
 *
 * 【改了快捷键如何生效】
 * 配置写入 chrome.storage.sync → content/hotkey.js 监听 storage.onChanged
 * 即时生效，无需刷新 YouTube 页面。
 */
(() => {
  'use strict';

  const HK = window.YRHotkey;
  if (!HK) return;

  /** 「录制状态提示」三个开关在 storage.sync 中的键（优先用 shared/indicator.js 的定义） */
  const IND = window.YRIndicator
    ? window.YRIndicator.KEYS
    : { pip: 'yrIndPip', notif: 'yrIndNotif', border: 'yrIndBorder' };
  const IND_DEFAULT = { pip: true, notif: true, border: true };

  const STYLE_ID = 'yr-settings-style';

  const CSS =
    '.yr-set-mask{position:fixed;left:0;top:0;right:0;bottom:0;z-index:9999;' +
    'display:flex;flex-direction:column;background:#ffffff;color:#111111;' +
    'font-family:inherit;box-sizing:border-box;}' +
    '.yr-set-mask[hidden]{display:none!important;}' +
    '.yr-set-head{display:flex;align-items:center;gap:8px;flex:none;' +
    'padding:14px 16px 10px;border-bottom:1px solid rgba(0,0,0,.08);}' +
    '.yr-set-title{font-size:15px;font-weight:600;}' +
    '.yr-set-close{margin-left:auto;width:26px;height:26px;flex:none;border:none;border-radius:6px;' +
    'background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer;}' +
    '.yr-set-close:hover{background:rgba(0,0,0,.07);}' +
    '.yr-set-body{flex:1;min-height:0;padding:12px 16px 16px;overflow:auto;}' +
    '.yr-set-legend{margin:0 0 10px;font-size:13px;font-weight:600;}' +
    '.yr-set-toggle{display:flex;align-items:flex-start;gap:8px;font-size:13px;cursor:pointer;}' +
    '.yr-set-toggle input{margin:2px 0 0;}' +
    '.yr-set-label{margin:14px 0 6px;font-size:12px;color:#8a8a8a;}' +
    '.yr-set-key{display:block;width:100%;height:42px;border:1px solid rgba(0,0,0,.18);' +
    'border-radius:8px;background:rgba(0,0,0,.03);color:inherit;font:inherit;' +
    'font-size:14px;font-weight:600;cursor:pointer;transition:border-color .15s,color .15s;}' +
    '.yr-set-key:hover:not(:disabled){border-color:rgba(26,115,232,.55);}' +
    '.yr-set-key:disabled{opacity:.55;cursor:not-allowed;}' +
    '.yr-set-key-capturing{border-color:#1a73e8;color:#1a73e8;background:rgba(26,115,232,.08);}' +
    '.yr-set-actions{display:flex;gap:8px;margin-top:8px;}' +
    '.yr-set-btn{flex:1;height:32px;border:1px solid rgba(0,0,0,.18);border-radius:8px;' +
    'background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;}' +
    '.yr-set-btn:hover{background:rgba(0,0,0,.05);}' +
    '.yr-set-divider{margin:16px 0 12px;border:none;border-top:1px solid rgba(0,0,0,.08);}' +
    '.yr-set-desc{display:block;margin:2px 0 12px;color:#8a8a8a;font-size:12px;' +
    'line-height:1.55;font-weight:400;white-space:normal;}' +
    '.yr-set-tip{margin:10px 0 0;font-size:12px;line-height:1.6;color:#8a8a8a;}' +
    '.yr-set-warn{margin:10px 0 0;padding:8px 10px;border-radius:8px;' +
    'background:rgba(255,152,0,.14);color:#8a4b00;font-size:12px;line-height:1.55;}' +
    '.yr-set-warn[hidden]{display:none!important;}' +
    '@media (prefers-color-scheme:dark){' +
    '.yr-set-mask{background:#212121;color:#f1f1f1;}' +
    '.yr-set-head{border-bottom-color:rgba(255,255,255,.12);}' +
    '.yr-set-label,.yr-set-tip,.yr-set-desc{color:#9c9c9c;}' +
    '.yr-set-divider{border-top-color:rgba(255,255,255,.12);}' +
    '.yr-set-close:hover{background:rgba(255,255,255,.1);}' +
    '.yr-set-key{border-color:rgba(255,255,255,.24);background:rgba(255,255,255,.06);}' +
    '.yr-set-key:hover:not(:disabled){border-color:rgba(107,161,255,.7);}' +
    '.yr-set-key-capturing{border-color:#6ba1ff;color:#6ba1ff;background:rgba(107,161,255,.14);}' +
    '.yr-set-btn{border-color:rgba(255,255,255,.24);}' +
    '.yr-set-btn:hover{background:rgba(255,255,255,.08);}' +
    '.yr-set-warn{background:rgba(255,152,0,.16);color:#ffcc80;}' +
    '}';

  const S = {
    root: null,
    els: null,
    combo: HK.normalize(HK.DEFAULT_COMBO),
    ind: Object.assign({}, IND_DEFAULT), // 三个指示开关的当前值
    capturing: false,
    warnTimer: null,
  };

  // ===================== 录制状态提示开关（数据） =====================

  /** 读取三个指示开关（缺省回退默认值 = 全部开启） */
  function loadInd() {
    return new Promise((resolve) => {
      const out = Object.assign({}, IND_DEFAULT);
      const keys = Object.keys(IND).map((k) => IND[k]);
      try {
        if (!chrome.storage || !chrome.storage.sync) {
          resolve(out);
          return;
        }
        chrome.storage.sync.get(keys, (data) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(out);
            return;
          }
          for (const name of Object.keys(IND)) {
            if (data && typeof data[IND[name]] === 'boolean') out[name] = data[IND[name]];
          }
          resolve(out);
        });
      } catch (err) {
        resolve(out);
      }
    });
  }

  function saveInd(name, value) {
    try {
      if (!chrome.storage || !chrome.storage.sync) return;
      chrome.storage.sync.set({ [IND[name]]: value }, () => {});
    } catch (err) {
      /* 存储不可用：不影响主流程 */
    }
  }

  /** 关掉「置顶状态窗」时通知 YouTube 页面：立即关闭已打开的小窗 */
  function notifyPipCfg(enabled) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (tab && typeof tab.id === 'number') {
          chrome.tabs.sendMessage(tab.id, { type: 'YR_PIP_CFG', enabled }).catch(() => {});
        }
      });
    } catch (err) {
      /* ignore */
    }
  }

  // ===================== DOM =====================

  function make(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function build() {
    if (S.root) return;
    ensureStyle();

    const root = make('div', 'yr-set-mask');
    root.hidden = true;

    const head = make('div', 'yr-set-head');
    head.appendChild(make('span', 'yr-set-title', '设置'));
    const close = make('button', 'yr-set-close', '×');
    close.type = 'button';
    close.title = '关闭';
    close.setAttribute('aria-label', '关闭设置');
    close.addEventListener('click', () => closeModal());
    head.appendChild(close);

    const body = make('div', 'yr-set-body');
    body.appendChild(make('h2', 'yr-set-legend', '录制快捷键'));

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'yr-set-enabled';
    toggle.addEventListener('change', () => {
      save(Object.assign({}, S.combo, { enabled: toggle.checked }));
    });
    const toggleLabel = make('label', 'yr-set-toggle');
    toggleLabel.setAttribute('for', 'yr-set-enabled');
    toggleLabel.appendChild(toggle);
    toggleLabel.appendChild(make('span', '', '启用「开始 / 停止录制」快捷键'));
    body.appendChild(toggleLabel);

    body.appendChild(make('div', 'yr-set-label', '快捷键组合'));
    const key = make('button', 'yr-set-key', '未设置');
    key.type = 'button';
    key.title = '点击后按下新的快捷键组合';
    key.addEventListener('click', () => startCapture());
    body.appendChild(key);

    const actions = make('div', 'yr-set-actions');
    const btnDefault = make('button', 'yr-set-btn', '恢复默认');
    btnDefault.type = 'button';
    btnDefault.addEventListener('click', () => {
      stopCapture();
      save(Object.assign({}, HK.DEFAULT_COMBO));
    });
    const btnClear = make('button', 'yr-set-btn', '清除');
    btnClear.type = 'button';
    btnClear.addEventListener('click', () => {
      stopCapture();
      save({ enabled: false, key: '', ctrl: false, alt: false, shift: false, meta: false });
    });
    actions.appendChild(btnDefault);
    actions.appendChild(btnClear);
    body.appendChild(actions);

    const warn = make('p', 'yr-set-warn');
    warn.hidden = true;
    body.appendChild(warn);

    body.appendChild(
      make(
        'p',
        'yr-set-tip',
        '点击上方按键框后直接按下想要的组合键（支持 Ctrl / Alt / Shift / Command 搭配字母、数字或功能键），按 Esc 取消修改。'
      )
    );
    body.appendChild(
      make(
        'p',
        'yr-set-tip',
        '在 YouTube 播放页按下该键：空闲时开始录制，录制中停止并保存到下载目录。快捷键仅在 YouTube 页面获得焦点时生效，在搜索框 / 评论框等输入区域不会触发。'
      )
    );

    // ===== 全屏录制状态提示（指示手段本身都不属于被捕获页面 → 永不入画）=====

    body.appendChild(make('hr', 'yr-set-divider'));
    body.appendChild(make('h2', 'yr-set-legend', '全屏录制状态提示'));
    body.appendChild(
      make(
        'p',
        'yr-set-tip',
        '全屏播放时页面内不会出现任何录制标识（画面铺满屏幕，标识必然入画）。以下指示都放在画面之外，不会被录进视频；可按需关闭。'
      )
    );

    const inds = {};
    const indDefs = [
      {
        name: 'pip',
        title: '置顶状态窗（画中画）',
        desc: '全屏播放时用置顶小窗持续显示「正在录制 + 计时 + 停止并保存」按钮。窗口是浏览器独立小窗，不会进入视频；仅在全屏内用快捷键开始录制时出现。',
      },
      {
        name: 'notif',
        title: '系统通知',
        desc: '开始录制时弹出一条常驻系统通知作为全屏下的指示，保存成功 / 失败再各提醒一次；也可点通知上的「停止并保存」直接停止。通知浮在全屏之上，不会进入视频。',
      },
      {
        name: 'border',
        title: '全屏画面红框',
        desc: '全屏且画面未铺满屏幕（上下或左右有黑边）时，在黑边内显示细红框提示正在录制；画面铺满屏幕时红框自动隐藏，不会进入视频。',
      },
    ];
    for (const def of indDefs) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = 'yr-set-ind-' + def.name;
      const row = make('label', 'yr-set-toggle');
      row.setAttribute('for', input.id);
      const text = make('span', 'yr-set-toggle-text');
      text.appendChild(make('b', '', def.title));
      text.appendChild(make('span', 'yr-set-desc', def.desc));
      row.appendChild(input);
      row.appendChild(text);
      input.addEventListener('change', () => {
        S.ind[def.name] = input.checked;
        saveInd(def.name, input.checked);
        if (def.name === 'pip' && !input.checked) notifyPipCfg(false); // 关掉即收起已开的小窗
      });
      inds[def.name] = input;
      body.appendChild(row);
    }

    root.appendChild(head);
    root.appendChild(body);
    document.body.appendChild(root);

    S.root = root;
    S.els = { toggle, key, warn, inds };
  }

  // ===================== 渲染 =====================

  function render() {
    if (!S.els) return;
    const c = S.combo;
    S.els.toggle.checked = !!c.enabled;
    S.els.key.textContent = S.capturing ? '请按下快捷键…' : HK.format(c);
    S.els.key.classList.toggle('yr-set-key-capturing', S.capturing);
    S.els.key.disabled = !c.enabled;
    const warn = HK.describeConflict(c);
    S.els.warn.textContent = warn;
    S.els.warn.hidden = !warn;
  }

  /** 临时提示（如「请按字母键」），2.5s 后回到常规渲染 */
  function flashWarn(text) {
    if (!S.els) return;
    S.els.warn.textContent = text;
    S.els.warn.hidden = !text;
    if (S.warnTimer) window.clearTimeout(S.warnTimer);
    if (text) S.warnTimer = window.setTimeout(() => render(), 2500);
  }

  // ===================== 按键捕获 =====================

  function onCaptureKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      stopCapture();
      return;
    }
    if (e.key === 'Tab') return; // 捕获期间不把焦点让出去
    const next = HK.comboFromEvent(e);
    if (!HK.isValidKey(next.key)) {
      flashWarn('请按下字母、数字或功能键（可搭配 Ctrl / Alt / Shift / Command），单独按修饰键无效。');
      return;
    }
    save(Object.assign({}, S.combo, next, { enabled: true }));
    stopCapture();
  }

  function startCapture() {
    if (S.capturing) return;
    if (!S.combo.enabled) save(Object.assign({}, S.combo, { enabled: true }));
    S.capturing = true;
    render();
    document.addEventListener('keydown', onCaptureKey, true);
  }

  function stopCapture() {
    if (!S.capturing) return;
    S.capturing = false;
    document.removeEventListener('keydown', onCaptureKey, true);
    render();
  }

  // ===================== 数据 =====================

  function save(next) {
    S.combo = HK.normalize(next);
    render();
    HK.write(S.combo);
  }

  /** 弹窗关闭 / 取消捕获时的兜底：解绑文档级监听 */
  function onDocKeyWhileOpen(e) {
    if (S.capturing) return;
    if ((e.key || '') === 'Escape') closeModal();
  }

  function openModal() {
    build();
    HK.read().then((combo) => {
      S.combo = combo;
      render();
    });
    loadInd().then((value) => {
      S.ind = value;
      renderInd();
    });
    S.root.hidden = false;
    document.body.classList.add('yr-settings-open');
    document.addEventListener('keydown', onDocKeyWhileOpen, true);
  }

  /** 按当前配置刷新三个指示开关的勾选状态 */
  function renderInd() {
    if (!S.els || !S.els.inds) return;
    for (const name of Object.keys(S.els.inds)) {
      if (typeof S.ind[name] === 'boolean') S.els.inds[name].checked = S.ind[name];
    }
  }

  function closeModal() {
    if (!S.root) return;
    stopCapture();
    S.root.hidden = true;
    document.body.classList.remove('yr-settings-open');
    document.removeEventListener('keydown', onDocKeyWhileOpen, true);
  }

  window.YRSettings = { open: openModal, close: closeModal };
})();
