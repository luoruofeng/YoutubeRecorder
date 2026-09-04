/**
 * chrome.* 扩展 API 的最小类型声明（仅用于编辑器 / LSP 类型标注）。
 *
 * 说明：
 * - 运行时全部为原生 JavaScript（JSDoc 标注类型）。
 * - 本目录不参与任何构建，TS 只做「类型标注」用途（符合 TODO 技术约束）。
 * - 若项目后续引入 typescript 做 `tsc --check`，可用该声明完成严格校验。
 */

declare namespace chrome {
  // ---------- runtime ----------
  namespace runtime {
    type MessageSender = {
      id?: string;
      url?: string;
      tab?: chrome.tabs.Tab;
    };
    type OnMessageListener = (
      message: any,
      sender: MessageSender,
      sendResponse: (response?: any) => void
    ) => boolean | void;

    const onMessage: {
      addListener: (listener: OnMessageListener) => void;
      removeListener: (listener: OnMessageListener) => void;
    };
    const onConnect: {
      addListener: (listener: (...args: any[]) => void) => void;
    };
    function sendMessage(message: any, callback?: (response: any) => void): void;
    function sendMessage<T>(message: any): Promise<T>;
    function getManifest(): any;
    const lastError: Error | undefined;
  }

  // ---------- tabs ----------
  type Tab = {
    id?: number;
    url?: string;
    title?: string;
    active: boolean;
    windowId: number;
  };
  namespace tabs {
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function query(
      queryInfo: { active?: boolean; currentWindow?: boolean },
      callback: (tabs: Tab[]) => void
    ): void;
    function sendMessage(tabId: number, message: any, callback?: (response: any) => void): void;
    function sendMessage<T>(tabId: number, message: any): Promise<T>;
    const onActivated: {
      addListener: (listener: (info: { tabId: number; windowId: number }) => void) => void;
    };
  }

  // ---------- tabCapture ----------
  namespace tabCapture {
    type CaptureOptions = {
      audio?: boolean;
      video?: boolean;
      /** 仅捕获当前标签页（需 activeTab），缩小授权面 */
      preferCurrentTab?: boolean;
    };
    type GetMediaStreamOptions = {
      consumerTabId?: number;
      targetTabId?: number;
    };
    type CaptureInfo = {
      status: 'pending' | 'active' | 'stopped' | 'error';
      fullscreen?: boolean;
      tabId?: number;
    };
    function capture(options: CaptureOptions, callback: (stream: MediaStream | null) => void): void;
    function capture(options: CaptureOptions): Promise<MediaStream | null>;
    function getMediaStreamId(options: GetMediaStreamOptions, callback: (streamId: string) => void): void;
    function getMediaStreamId(options?: GetMediaStreamOptions): Promise<string>;
    const onStatusChanged: {
      addListener: (listener: (info: CaptureInfo) => void) => void;
    };
  }

  // ---------- downloads ----------
  namespace downloads {
    type DownloadOptions = {
      url: string;
      filename?: string;
      saveAs?: boolean;
      conflictAction?: 'uniquify' | 'overwrite' | 'prompt';
    };
    type DownloadItem = {
      id: number;
      state: 'in_progress' | 'interrupted' | 'complete';
      error?: string;
    };
    type DownloadDelta = {
      id: number;
      state?: { previous?: string; current?: string };
      error?: { previous?: string; current?: string };
    };
    function download(options: DownloadOptions, callback?: (downloadId: number) => void): void;
    function download(options: DownloadOptions): Promise<number>;
    const onChanged: {
      addListener: (listener: (delta: DownloadDelta) => void) => void;
    };
  }

  // ---------- action ----------
  namespace action {
    function setIcon(details: { path?: string | { [size: string]: string }; tabId?: number }): void;
    function setBadgeText(details: { text: string; tabId?: number }): void;
    const onClicked: {
      addListener: (listener: (tab: chrome.tabs.Tab) => void) => void;
    };
  }

  // ---------- offscreen ----------
  namespace offscreen {
    type Reason =
      | 'TESTING'
      | 'AUDIO_PLAYBACK'
      | 'BLOBS'
      | 'CLIPBOARD'
      | 'DOM_PARSER'
      | 'DISPLAY_MEDIA'
      | 'IFRAME_SCRIPTING'
      | 'LOCAL_STORAGE'
      | 'MATCH_MEDIA'
      | 'USER_MEDIA'
      | 'WORKERS'
      | 'WEB_RTC';
    type CreateDocumentOptions = {
      url: string;
      reasons: Reason[];
      justification: string;
    };
    function createDocument(options: CreateDocumentOptions): Promise<void>;
    function closeDocument(): Promise<void>;
    function hasDocument(): Promise<boolean>;
  }

  // ---------- i18n ----------
  function i18n(messageName: string): string;
}
