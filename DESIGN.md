# YouTube 播放器录制插件 设计文档

> 项目：Chrome Manifest V3 浏览器扩展 —— 在 YouTube 播放页手动点击触发，捕获当前标签页完整画面与页面内音频，用 Canvas 裁剪出播放器区域，输出带音频的 `video/webm` 并下载到本地。
> 技术约束：仅使用浏览器原生 JavaScript / TypeScript（TS 仅作类型标注），零第三方依赖，无 ffmpeg 与任何转码工具。

---

## 1. 底层能力清单（任务 1）

### 1.1 Chrome 扩展专属接口

| 接口 | 用途 | 说明 |
| --- | --- | --- |
| `chrome.tabCapture.getMediaStreamId({targetTabId})` | 为当前标签页申请可消费的 streamId | 在用户手势链路内由 background 调用，再交给 offscreen 用 `getUserMedia` 消费 |
| `chrome.tabCapture.onStatusChanged` | 监听捕获状态（可选兜底） | 用于异常时提示 |
| `chrome.downloads.download` | 把组装好的 webm 保存到本地 | MV3 权限 `downloads` |
| `chrome.downloads.onChanged` | 监听下载完成，释放临时 URL | 避免内存泄漏 |
| `chrome.action` | 点击插件图标入口 | 本设计配置 `default_popup`，popup 作为「打开录制面板」入口 |
| `chrome.tabs` | 向录制标签页的 content script 转发消息 | popup / background 使用 |
| `chrome.runtime` | 扩展内上下文间消息 | background / content / offscreen 统一走 `runtime.onMessage` |
| `chrome.offscreen` | 创建离屏文档承载捕获/裁剪/录制 | MV3 专用，`reason: USER_MEDIA` |

### 1.2 权限模型

- `tabCapture`：**受限权限**。仅允许扩展自身页面发起捕获；对受保护内容（DRM/Widevine）返回的轨道会被加密，画面为黑屏。合规要点：捕获只能在**用户点击「开始录制」后**由扩展发起，绝不后台静默自启。
- `downloads`：允许扩展保存 webm 到本地。
- `activeTab`：用户点击 action 时授予当前标签页临时访问权；配合 `preferCurrentTab` 缩小捕获面。
- `offscreen`：创建离屏文档所需。
- `storage`（仅 `session` 级）：点击「开始录制」时将启动意图写入 `chrome.storage.session`，作为跨 Service Worker 生命周期 / 上下文消息转发丢失时的启动兜底（离屏加载后自查该标记自行启动）。会话级内存，浏览器会话结束即清除，不存任何用户数据。
- `host_permissions`：无需额外声明——content script 通过 `content_scripts.matches` 注入即可，不需要网络权限。
- 最小权限核对：`tabCapture` + `downloads` + `activeTab` + `offscreen`。

### 1.3 浏览器 Web 原生接口

| 能力 | 在本项目中的角色 |
| --- | --- |
| `MediaStream` / `MediaStreamTrack` | `tabCapture` 返回全页流；拆分 audio/video 轨；`new MediaStream()` 重组裁剪后视频轨 + 原始音频轨 |
| `MediaRecorder` | 录制 `finalStream` 为 webm 分片（`mimeType: video/webm;codecs=vp9,opus`，带 vp8 回退） |
| Canvas 2D（`canvas.captureStream` / `ctx.drawImage`） | 逐帧裁剪播放器区域画面；canvas 输出仅含视频轨的流 |
| `getBoundingClientRect` | 获取播放器容器相对视口的 CSS 像素矩形 |
| `requestAnimationFrame` | 逐帧绘制循环（画面裁剪的唯一原生手段） |
| 隐藏 `video` 元素 | 消费 `tabCapture` 全页流，作为 drawImage 的图像源 |
| `URL.createObjectURL` / `URL.revokeObjectURL` | 把 Blob 变成可下载 URL；下载后释放 |
| `Blob` | 组装 webm 分片 |
| `MutationObserver` / `resize` / `scroll` / `fullscreenchange` | 播放器尺寸/位置变化的实时监听 |
| `devicePixelRatio` | CSS 像素 → 物理像素换算（高分屏防错位） |

### 1.4 技术边界

- 不安装任何 npm 第三方包；无构建产物依赖，`src/` 直接作为「加载已解压的扩展程序」目录。
- 运行时全部为原生 JavaScript（含 JSDoc 类型标注）；TS 仅以 `.d.ts` 声明形式存在于 `src/types/` 供编辑器/LSP 提示。
- 无任何转码：`MediaRecorder` 原生只输出 `video/webm`（vp9/vp8 + opus），mp4 等一律不做。

### 1.5 安全性设计约束

- 录制**必须**由用户在页面上的「开始录制」按钮点击触发（content script 收到 click → 消息链到 offscreen 发起 `tabCapture`），后台/SW 绝不静默自动开启捕获。
- 捕获期间 UI 明确展示录制状态（红点/文案）；所有媒体轨道在录制结束后显式 `stop()`，杜绝红点残留。
- 权限最小化；离屏文档仅在有录制需求时创建，结束后关闭。

---

## 2. 总体架构与模块划分（任务 2）

```
src/
├── manifest.json          # MV3 清单
├── background.js          # Service Worker：消息路由、offscreen 生命周期、心跳
├── content/
│   ├── ui.js              # 注入层 UI 组件（panel/modal/loading/toast，yr-recorder- 前缀）
│   └── content.js         # content script 主逻辑：定位播放器、状态机、与离屏消息
├── offscreen.html         # 离屏文档宿主（捕获/裁剪/录制/下载全在离屏完成）
├── offscreen.js           # tabCapture → 隐藏 video → canvas 裁剪 → MediaRecorder
├── popup.html / popup.js  # action 入口：一键在页面打开录制面板
├── types/
│   └── chrome-ext.d.ts    # chrome.* 扩展 API 类型声明（仅类型标注用）
└── icons/                 # 16/48/128 图标
```

### 2.1 为什么必须有 offscreen document

1. `chrome.tabCapture` **不可从 content script 调用**（content script 只能访问有限的 `chrome.*` API）。
2. 裁剪需要 `video` + `canvas` + `MediaRecorder`，这些必须运行在有 DOM 的 Window 上下文。
3. popup 一旦失焦即关闭，无法承载长时间录制。
4. Service Worker 无 DOM，无法 `drawImage` / `MediaRecorder` 全流程。
5. ⇒ 唯一正确落点是 **offscreen document**：由 background 按需创建，承载裁剪 → 录制 → 下载全链路；capture 的正确做法是 background 在用户手势链路内调用 `chrome.tabCapture.getMediaStreamId()`，再由 offscreen 用 `getUserMedia()` 直接消费该流。

### 2.2 渲染层职责划分

| 上下文 | 职责 | 为什么 |
| --- | --- | --- |
| content script | 注入 `yr-recorder-` UI；定位 `ytd-player`；DPR 换算；实时上报播放器矩形；收状态广播渲染 UI | 只有它能访问 YouTube 页面 DOM 与布局坐标 |
| offscreen | `tabCapture`、隐藏 video 播放、canvas 逐帧裁剪、合并音视频、`MediaRecorder`、组装 Blob、`chrome.downloads.download` | 只有它能拿到 tab 流并操作媒体 DOM |
| background | 创建/关闭 offscreen、路由消息 | Service Worker 是生命周期管理者 |

### 2.3 消息协议（`chrome.runtime.onMessage`）

**content/popup → background**
- `{ type: 'SHOW_PANEL' }`（popup 发起，background 用 `tabs.sendMessage` 转发给录制 tab）
- `{ type: 'REC_START_REQUEST' }`：content 点击开始录制（**带回执**：background 确保离屏就绪并转发 `REC_START` 后，回复 `{ok:true}` / `{ok:false,busy:true,phase}` / `{ok:false,code,message}`，杜绝空等超时与「误报其它会话占用」）
- `{ type: 'REC_RESET_REQUEST' }`：content 兜底复位（解除离屏残留会话导致的启动卡死；background 向离屏广播 `REC_RESET` 强制清理）
- `{ type: 'REC_STOP' }`：content 点击停止录制（广播，offscreen 直接消费）
- `{ type: 'PLAYER_RECT', rect, dpr, hasPlayer }`：content 高频上报播放器矩形（带 DPR）
- `{ type: 'PAGE_HIDDEN' }` / `{ type: 'PAGE_LEAVING' }`：录制中切页/刷新兜底

**offscreen → content（广播，经 runtime 消息，content 侧监听）**
- `{ type: 'REC_STATE', phase, detail? }`：`idle | capturing | recording | stopping | exported | error`
- `{ type: 'UI_ACTION', action: 'modal'|'toast'|'loading-on'|'loading-off', payload }`：驱动 content 侧 UI 组件
- `{ type: 'DOWNLOAD_RESULT', ok, error? }`

**offscreen → background**
- `{ type: 'OFFSCREEN_READY' }`：离屏脚本就绪信号；background 收到后补发所有排队中的启动请求
- `{ type: 'YR_LOG', text }`：离屏诊断日志，转发到 SW 控制台供排查

**跨上下文（storage.session 兜底）**
- 启动意图键 `yrPendingStart`：content 点击开始后由 background 先写入（早于离屏创建），离屏加载完成时自查、或经 `storage.onChanged` 实时感知，在 `idle` 状态下自行 `begin()`。SW 休眠/重启、消息转发丢失均不影响该路径。

> 健壮性说明：
> - 离屏是唯一录制核心（单例）。`REC_START` 仅在离屏 `idle` 时受理并回执（`{ok:true}`）；非空闲时如实回执 `{ok:false,busy:true,phase}`，由发起侧区分处理：`preparing` 视为启动进行中继续等待；`recording/stopping/exported` 提示「复位并重试」（`REC_RESET` 强制清理残留会话）。
> - content 侧对 `REC_START_REQUEST` 做幂等轮询（约 1.5s/次，上限 9s），容忍单次回执因 SW 生命周期丢失；成功（`ok` / `capturing` / `recording` 广播）即停止。
> - 每次会话结束（`broadcastIdle`）重置 `finalized`，保证失败/复位后会话可再次启用。
> - 诊断：content/background/offscreen 三端均输出 `[YR-*]` 日志；content 错误弹窗自动附带最近 14 条环形日志。

### 2.4 关键时序（数据流主线）

1. 用户在 YouTube 播放页点击扩展图标 → popup 打开 → 点「打开录制面板」→ background 转发 → content script 显示主面板浮层。
2. 用户点「开始录制」→ content 状态机转 `capturing`（行内加载）→ 发 `REC_START`。
3. background 确保 offscreen 存在并转发 `REC_START`。
4. background 调用 `chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id })` 获取 `streamId`，并把它发送给 offscreen。
5. 拆分：`videoTrack` 交给隐藏 `<video>`；`audioTrack` 暂存（若缺失弹警告 toast，录无声）。
6. content 通过 `getBoundingClientRect` 定位 `ytd-player`，× `devicePixelRatio` 得到物理像素源矩形，经 `PLAYER_RECT` 高频喂给 offscreen。
7. offscreen 隐藏 `<video>` 播放 `tabStream`；隐藏 `<canvas>`（尺寸 = DPR 换算后的播放器宽高）每帧 `rAF → drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch)` 完成裁剪。
8. `canvas.captureStream(30)` 得到裁剪视频轨；`new MediaStream([videoTrack, audioTrack])` 合并为 `finalStream`。
9. `new MediaRecorder(finalStream, {mimeType:'video/webm;codecs=vp9,opus'})`（带回退）`start()` 录制。
10. 用户点「停止」→ content 弹全屏加载「正在组装视频文件」→ offscreen 停 rAF、停 video、停全部 track、`recorder.stop()`。
11. `ondataavailable` 分片 → `onstop` 组装完整 `Blob('video/webm')` → `URL.createObjectURL` → `chrome.downloads.download` → 成功后 toast。
12. `downloads.onChanged` 完成后 `revokeObjectURL`；content 收到 `exported` → 清理全部 `yr-recorder-` DOM；background 收到 `idle` 后关闭 offscreen，全链路复位。

---

## 3. 边界情况与坑点清单（任务 18 依据）

| # | 坑点 | 对策 |
| --- | --- | --- |
| 1 | 录制中切换标签页：tabCapture 只对激活标签页有效，切走会静止/中断 | content 监听 `visibilitychange/pagehide` → 提示 + 停止流程兜底 |
| 2 | 高分屏 DPR：CSS 像素 ≠ 捕获物理像素 | content 侧取 `devicePixelRatio` 随 rect 一并上报，离屏按 `rect × dpr` 裁剪 |
| 3 | 播放器 DOM 变化（全屏/缩放/滚动） | content 用 `MutationObserver` + `resize/scroll/fullscreenchange` 监听，事件与周期心跳双保险上报 |
| 4 | 逐帧 drawImage 的 CPU 开销 | 文档注明；提供 30fps 固定输出（`captureStream` 帧率独立于 rAF），不做多余帧绘制。可选项：长时录制若需降低 CPU 占用，可在 `drawLoop` 内对 rAF 做帧节流（例如隔帧绘制），`captureStream` 输出帧率随之下降 |
| 5 | DRM/Widevine：tabCapture 对受保护内容输出黑屏 | 录制开始 ~2s 后离屏采样画面中心像素，近似全黑则弹模态框告知（公开视频不受影响） |
| 6 | 音频只能取 `tabCapture` 原始 audioTrack，canvas 无音频能力 | audioTrack 全程不经过 canvas，直接并入 finalStream |
| 7 | 用户手势约束：capture 必须由点击驱动 | 状态机保证 REC_START 仅由按钮 click 发出 |
| 8 | 资源释放：不 `track.stop()` 会常驻红点 | 停止流程统一 stop 全部 track + `video.srcObject=null` + 关闭 offscreen |
| 9 | 格式：只输出 webm | mimeType 探测回退链：`vp9,opus → vp8,opus → video/webm`；全程不转码 |
| 10 | DOM 残留与内存泄漏 | 全部自定义节点统一 `yr-recorder-` 前缀；`cleanupYR()` 批量移除节点/监听/动画，供完成、异常、页面离开时调用 |
| 11 | 暗黑模式 | CSS 变量两套配色，`matchMedia('(prefers-color-scheme: dark)')` + YouTube 页面类名探测动态切换 |

---

## 4. 验收方式（任务 20）

1. Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」选择 `src/`。
2. 访问任意公开 YouTube 播放页 → 点击图标 → popup 点「打开录制面板」→ 页面右上浮出面板。
3. 按 TODO 阶段七 20.1~20.8 逐项验证（明暗主题、录制裁剪正确性、DPR、切页兜底、全屏跟随、DRM/异常提示、资源释放）。
4. 代码静态自检：对 `src/` 下所有 JS 执行 `node --check`，`manifest.json` 用 `JSON.parse` 校验（见阶段七执行命令）。
