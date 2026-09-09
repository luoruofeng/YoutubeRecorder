/**
 * pending-video.js —— 「保存后裁剪」待处理视频的暂存（阶段十二）
 *
 * 为什么需要它：录制结束的 Blob 属于离屏文档的内存，离屏在会话空闲后会被回收；
 * 而「保存成功后是否裁剪」的询问框 / 编辑窗口由用户触发，打开时间不可控。
 * 浏览器又不允许扩展读取已下载到磁盘的文件内容（chrome.downloads 只暴露元数据），
 * 消息通道也只传递 JSON 序列化数据（Blob 无法可靠跨上下文传输）。
 *
 * 因此这里用 **OPFS（Origin Private File System，扩展自身 origin 的私有文件系统）**
 * 作为「刚保存的视频 → 编辑窗口」的中间载体：
 * - 同扩展的所有上下文（offscreen / 询问窗口 / 编辑窗口 / background）同源共享；
 * - 无需新增任何权限（标准 Web API，扩展页面与离屏文档均可用）；
 * - 不依赖任何常驻上下文的内存，离屏 / Service Worker 何时回收都不影响；
 * - 通过 chrome.storage.session 附带一条纯 JSON 元信息（原始文件名 / 格式）。
 *
 * 上下文边界：本模块只在扩展自身页面（offscreen / ask / editor）加载，
 * 不属于 content script，不涉及任何录制画面，不影响既有架构边界检查。
 *
 * 对外暴露 window.YRPendingVideo = { save / load / clear }。
 */
window.YRPendingVideo = (() => {
  'use strict';

  /** OPFS 内固定文件名（同一扩展同一时刻只维护「最近一次保存」的待裁剪视频） */
  const FILE_NAME = 'yr-pending-edit.bin';
  /** chrome.storage.session 中保存的元信息键（filename / mime / size / savedAt） */
  const META_KEY = 'yrPendingEdit';

  /** 当前上下文是否可用 OPFS（secure context + Chrome ≥ 无版本门槛） */
  function hasOpfs() {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.storage &&
      typeof navigator.storage.getDirectory === 'function'
    );
  }

  /**
   * 保存一段「待裁剪」视频。写成功返回 true；任一环节失败返回 false
   * （调用方按 false 处理 = 本次不提供「保存后裁剪」，行为与旧版本一致）。
   */
  async function save(blob, meta) {
    if (!blob || !blob.size) return false;
    try {
      if (!hasOpfs()) return false;
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(FILE_NAME, { create: true });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();

      const record = Object.assign({}, meta || {}, {
        size: blob.size,
        mime: blob.type || (meta && meta.mime) || 'video/mp4',
        savedAt: Date.now(),
      });
      if (chrome.storage && chrome.storage.session) {
        await chrome.storage.session.set({ [META_KEY]: record });
      }
      return true;
    } catch (err) {
      console.warn('[YR-pending] save 失败：', err);
      return false;
    }
  }

  /** 读取最近一次保存的待裁剪视频。没有（或已清理）返回 null。 */
  async function load() {
    try {
      if (!hasOpfs()) return null;
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(FILE_NAME); // 文件不存在会抛错 → 走 catch
      const file = await handle.getFile();
      if (!file || !file.size) return null;
      let meta = null;
      if (chrome.storage && chrome.storage.session) {
        const data = await chrome.storage.session.get(META_KEY);
        meta = (data && data[META_KEY]) || null;
      }
      return { blob: file, meta };
    } catch (err) {
      return null;
    }
  }

  /** 清理待裁剪视频（用户选择不裁剪 / 编辑窗口已取走数据后调用），幂等。 */
  async function clear() {
    try {
      if (hasOpfs()) {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(FILE_NAME, { recursive: true });
      }
    } catch (err) {
      /* 文件不存在等：忽略 */
    }
    try {
      if (chrome.storage && chrome.storage.session) {
        await chrome.storage.session.remove(META_KEY);
      }
    } catch (err) {
      /* ignore */
    }
  }

  return { save, load, clear };
})();
