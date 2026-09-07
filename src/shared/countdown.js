/**
 * shared/countdown.js —— 「开始录制前倒计时」配置的公共定义（popup / content 共用）
 *
 * 【要解决的问题】
 * 用户点「开始录制」时往往还停在扩展弹窗或刚切回播放器，第一帧经常录到
 * 「鼠标还没移开 / 播放器控制条还亮着 / 还没进全屏」的画面。
 * 加入倒计时后，用户点完开始还有几秒钟把页面调整到想要的状态。
 *
 * 【为什么配置要单独成文件】
 * 与 shared/indicator.js 同理：同一份配置要被三处消费 ——
 *   1. popup 设置弹窗（读 / 写）；
 *   2. popup 主界面（倒计时态展示剩余秒数）；
 *   3. background（决定「立即开始」还是「先倒计时」）。
 * 键名、默认值、取值范围收敛在这里，避免各处硬编码不一致。
 *
 * 【取值语义】
 * 0 = 关闭倒计时（点开始即录制，保持旧行为）；1~10 = 倒计时秒数。
 * 上限 10 秒是体验取舍：再长就变成「等待」，且过长的等待容易让人以为没点中。
 *
 * 【存储格式】
 * chrome.storage.sync 下的单个数字键；缺失 / 非法值一律回退默认值 3。
 */
(() => {
  'use strict';

  /** storage.sync 中的键名 */
  const KEY = 'yrCountdownSec';

  /** 默认值（秒）：3 秒——够切回播放器 / 躲开鼠标，又不至于让人等 */
  const DEFAULT = 3;
  /** 最小值：0 = 关闭 */
  const MIN = 0;
  /** 最大值（秒） */
  const MAX = 10;

  /** 快捷档位（设置弹窗里的一键选择） */
  const PRESETS = [0, 3, 5, 10];

  /**
   * 规整任意输入为合法秒数（四舍五入后夹到 [MIN, MAX]，非法值回退 DEFAULT）。
   * @param {unknown} value
   * @returns {number}
   */
  function normalize(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT;
    const rounded = Math.round(n);
    if (rounded <= MIN) return MIN;
    return Math.min(MAX, rounded);
  }

  /**
   * 读取当前倒计时秒数（缺失回退默认值）。
   * @returns {Promise<number>}
   */
  function read() {
    return new Promise((resolve) => {
      try {
        if (!chrome.storage || !chrome.storage.sync) {
          resolve(DEFAULT);
          return;
        }
        chrome.storage.sync.get(KEY, (data) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(DEFAULT);
            return;
          }
          resolve(normalize(data ? data[KEY] : undefined));
        });
      } catch (err) {
        resolve(DEFAULT);
      }
    });
  }

  /**
   * 写入倒计时秒数（写入前规整，返回实际写入的值）。
   * @param {unknown} value
   * @returns {Promise<number>}
   */
  function write(value) {
    const next = normalize(value);
    return new Promise((resolve) => {
      try {
        if (!chrome.storage || !chrome.storage.sync) {
          resolve(next);
          return;
        }
        chrome.storage.sync.set({ [KEY]: next }, () => resolve(next));
      } catch (err) {
        resolve(next);
      }
    });
  }

  window.YRCountdown = {
    KEY,
    DEFAULT,
    MIN,
    MAX,
    PRESETS,
    normalize,
    read,
    write,
  };
})();
