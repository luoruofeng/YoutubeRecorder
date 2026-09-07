/**
 * shared/indicator.js —— 录制「状态指示」的公共定义（popup / content / guard 共用）
 *
 * 【背景】
 * 全屏播放时页面内的遮罩提示不可见（画面铺满屏幕，洞 = 全屏，遮罩没有可显示的空间），
 * 用户无法知道录制是否在进行。本模块集中管理三种「指示手段」的开关配置，供各消费方读取：
 *
 *   · yrIndPip   —— 全屏置顶状态窗（Document PiP：REC + 计时 + 停止按钮，独立窗口绝不入画）
 *   · yrIndNotif —— 系统通知（开始 / 保存成功 / 失败；系统层浮在全屏之上，不入画）
 *   · yrIndBorder—— 全屏黑边安全区红框（画面铺满时自动隐藏，红框只落在裁剪区之外的 letterbox）
 *
 * 【为什么单独成文件】
 * 同一份开关要被四处消费：popup 设置模态框（读 / 写）、guard.js（画红框前判断）、
 * content/pip.js（开状态窗前判断）、background.js（发系统通知前判断）。
 * 统一键名与默认值，避免四处各自硬编码「开关叫什么、默认开不开」造成不一致。
 *
 * 【存储格式】
 * chrome.storage.sync 下三个布尔键，缺失 / 非布尔一律回退默认值（默认全部开启）。
 */
(() => {
  'use strict';

  /** storage.sync 中的键名 */
  const KEYS = {
    pip: 'yrIndPip',
    notif: 'yrIndNotif',
    border: 'yrIndBorder',
  };

  /** 默认值：全部开启 */
  const DEFAULTS = {
    pip: true,
    notif: true,
    border: true,
  };

  const KEY_LIST = Object.keys(KEYS).map((k) => KEYS[k]);

  /**
   * 读取全部指示开关（缺失键回退默认值）。
   * @returns {Promise<{pip: boolean, notif: boolean, border: boolean}>}
   */
  function read() {
    return new Promise((resolve) => {
      const out = Object.assign({}, DEFAULTS);
      try {
        if (!chrome.storage || !chrome.storage.sync) {
          resolve(out);
          return;
        }
        chrome.storage.sync.get(KEY_LIST, (data) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(out);
            return;
          }
          for (const name of Object.keys(KEYS)) {
            const key = KEYS[name];
            if (data && typeof data[key] === 'boolean') out[name] = data[key];
          }
          resolve(out);
        });
      } catch (err) {
        resolve(out);
      }
    });
  }

  /**
   * 写入指示开关（只写给出的字段，未给出的保持原样）。
   * @param {Partial<{pip: boolean, notif: boolean, border: boolean}>} values
   * @returns {Promise<void>}
   */
  function write(values) {
    return new Promise((resolve) => {
      const payload = {};
      for (const name of Object.keys(KEYS)) {
        if (values && typeof values[name] === 'boolean') payload[KEYS[name]] = values[name];
      }
      if (!Object.keys(payload).length) {
        resolve();
        return;
      }
      try {
        if (!chrome.storage || !chrome.storage.sync) {
          resolve();
          return;
        }
        chrome.storage.sync.set(payload, () => resolve());
      } catch (err) {
        resolve();
      }
    });
  }

  window.YRIndicator = {
    KEYS,
    DEFAULTS,
    read,
    write,
  };
})();
