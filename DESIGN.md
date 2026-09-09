# YouTube 播放器录制插件 设计文档

> 项目：Chrome Manifest V3 浏览器扩展 —— 在 YouTube 播放页手动点击触发，捕获当前标签页完整画面与页面内音频，用 Canvas 裁剪出播放器区域，输出带音频的视频文件并下载到本地：原生优先输出 **MP4（H.264/AAC）**，浏览器或系统不支持时自动回退 **webm**。
> 技术约束：仅使用浏览器原生 JavaScript / TypeScript（TS 仅作类型标注），零第三方依赖，无 ffmpeg 与任何二次转码工具（MP4 由 `MediaRecorder` 原生录制，不引入录后转码）。

> **重要架构变更（阶段八）**：录制控件已从「页面内注入浮层」上移到**扩展图标弹窗（popup）**，content script 变为**零注入**的无界面脚本。
> 原因：`chrome.tabCapture` 捕获的是整个标签页的合成画面，任何注入到页面里的浮层（面板 / 模态框 / 加载遮罩 / toast）都会与播放器一起被合成进捕获帧、出现在最终视频中；而播放器区域会随全屏 / 剧场模式 / 窗口尺寸变化，「浮层恰好不压到播放器」无法稳定保证。popup 是独立扩展页面，不属于被捕获标签页的渲染内容，因此画面永远干净。
> 影响章节：2.2 职责划分、2.3 消息协议、2.4 时序主线（页面内 UI 相关内容已成为历史留档）。

> **补充变更（阶段九）**：录制期间会在页面里注入一层**交互锁定遮罩**（`content/guard.js`），用于禁止滚动 / 缩放告警 / 屏蔽点击与播放器快捷键，防止录制中途操作页面导致画面错位或录制中断。它采用「按播放器画面矩形挖洞」的聚光灯方案，**不会覆盖被录画面**，详见第 4 节。

> **补充变更（阶段十一）**：新增**开始录制前倒计时**（默认 3 秒，设置页可调 0–10 秒）。它运行在**捕获开始之前**：页面浮层归零 → 先撤掉浮层 → 再开始捕获，因此倒计时本身绝不会进入成片（`content/countdown.js`），详见第 4.7 节。

---

## 1. 底层能力清单（任务 1）

### 1.1 Chrome 扩展专属接口

| 接口 | 用途 | 说明 |
| --- | --- | --- |
| `chrome.tabCapture.getMediaStreamId({targetTabId})` | 为当前标签页申请可消费的 streamId | 在用户手势链路内由 background 调用，再交给 offscreen 用 `getUserMedia` 消费 |
| `chrome.tabCapture.onStatusChanged` | 监听捕获状态（可选兜底） | 用于异常时提示 |
| `chrome.downloads.download` | 把组装好的视频文件（mp4/webm）保存到本地 | MV3 权限 `downloads` |
| `chrome.downloads.onChanged` | 监听下载完成，释放临时 URL | 避免内存泄漏 |
| `chrome.action` | 点击插件图标入口 | 本设计配置 `default_popup`，popup 即录制控制台（开始 / 停止并保存 / 状态 / 计时 / 提示）；`setBadgeText` 用于在图标上显示 `REC` 等状态 |
| `chrome.tabs` | 向录制标签页的 content script 转发消息 | popup / background 使用 |
| `chrome.runtime` | 扩展内上下文间消息 | background / content / offscreen 统一走 `runtime.onMessage` |
| `chrome.offscreen` | 创建离屏文档承载捕获/裁剪/录制 | MV3 专用，`reason: USER_MEDIA` |

### 1.2 权限模型

- `tabCapture`：**受限权限**。仅允许扩展自身页面发起捕获；对受保护内容（DRM/Widevine）返回的轨道会被加密，画面为黑屏。合规要点：捕获只能在**用户点击「开始录制」后**由扩展发起，绝不后台静默自启。
- `downloads`：允许扩展保存 webm 到本地。
- `activeTab`：用户点击 action 时授予当前标签页临时访问权；配合 `preferCurrentTab` 缩小捕获面。
- `offscreen`：创建离屏文档所需。
- `storage`（仅 `session` 级）：点击「开始录制」时将启动意图写入 `chrome.storage.session`，作为跨 Service Worker 生命周期 / 上下文消息转发丢失时的启动兜底（离屏加载后自查该标记自行启动）。会话级内存，浏览器会话结束即清除，不存任何用户数据。
- `notifications`（阶段十新增）：全屏录制状态指示 —— 录制中常驻一条系统通知（浮在全屏之上、不属于被捕获标签页，绝不会入画），并提供「停止并保存」按钮。
- `host_permissions`：无需额外声明——content script 通过 `content_scripts.matches` 注入即可，不需要网络权限。
- 最小权限核对：`tabCapture` + `downloads` + `activeTab` + `offscreen` + `notifications`。

### 1.3 浏览器 Web 原生接口

| 能力 | 在本项目中的角色 |
| --- | --- |
| `MediaStream` / `MediaStreamTrack` | `tabCapture` 返回全页流；拆分 audio/video 轨；`new MediaStream()` 重组裁剪后视频轨 + 原始音频轨 |
| `MediaRecorder` | 录制 `finalStream` 分片：`video/mp4`（H.264 `avc1.*` + AAC `mp4a.40.2`）优先，探测/构造失败逐级回退 `video/webm`（vp9 → vp8）；绝不二次转码 |
| Canvas 2D（`canvas.captureStream` / `ctx.drawImage`） | 逐帧裁剪播放器区域画面；canvas 输出仅含视频轨的流 |
| `getBoundingClientRect` | 获取播放器容器相对视口的 CSS 像素矩形 |
| `requestAnimationFrame` | 逐帧绘制循环（画面裁剪的唯一原生手段） |
| 隐藏 `video` 元素 | 消费 `tabCapture` 全页流，作为 drawImage 的图像源 |
| `URL.createObjectURL` / `URL.revokeObjectURL` | 把 Blob 变成可下载 URL；下载后释放 |
| `Blob` | 组装 webm 分片 |
| `MutationObserver` / `resize` / `scroll` / `fullscreenchange` | 播放器尺寸/位置变化的实时监听 |
| `devicePixelRatio` / `visualViewport` / `innerWidth` | CSS 像素 → 捕获帧物理像素的换算基准（高分屏 / 缩放场景防错位；实际比例由离屏用帧尺寸实测得出） |

### 1.4 技术边界

- 不安装任何 npm 第三方包；无构建产物依赖，`src/` 直接作为「加载已解压的扩展程序」目录。
- 运行时全部为原生 JavaScript（含 JSDoc 类型标注）；TS 仅以 `.d.ts` 声明形式存在于 `src/types/` 供编辑器/LSP 提示。
- 无任何二次转码：输出格式由 `MediaRecorder` 原生决定——新版 Chrome（≥126，按平台/编码器逐步放行）原生输出 `video/mp4`（H.264 + AAC）；旧版 Chrome 或平台缺 H.264/AAC 编码器时回退 `video/webm`（vp9/vp8 + opus）。录制前在 content 侧做同款探测，无法输出 MP4 时弹框告知原因。

### 1.5 安全性设计约束

- 录制**必须**由用户在页面上的「开始录制」按钮点击触发（content script 收到 click → 消息链到 offscreen 发起 `tabCapture`），后台/SW 绝不静默自动开启捕获。
- 捕获期间 UI 明确展示录制状态（红点/文案）；所有媒体轨道在录制结束后显式 `stop()`，杜绝红点残留。
- 权限最小化；离屏文档仅在有录制需求时创建，结束后关闭。

---

## 2. 总体架构与模块划分（任务 2）

```
src/
├── manifest.json          # MV3 清单
├── background.js          # Service Worker：消息路由、offscreen 生命周期、心跳、系统通知（阶段十）、倒计时启动链（阶段十一）
├── shared/
│   ├── hotkey.js          # 「开始 / 停止录制」快捷键公共定义（popup / content 共用）
│   ├── indicator.js       # 全屏录制状态指示三开关（pip / notif / border）的读写（阶段十）
│   └── countdown.js       # 「开始录制前倒计时」秒数的读写（默认 3 秒，0–10；阶段十一）
├── content/
│   ├── ui.js              # 【已废弃】注入层 UI 组件（已移入 popup）
│   ├── guard.js           # 录制期页面交互锁定遮罩（按播放器画面矩形挖洞）+ 全屏黑边红框（阶段十）
│   ├── pip.js             # 全屏 Document PiP 置顶状态窗：REC + 计时 + 停止按钮（阶段十）
│   ├── countdown.js       # 开始录制前的页面倒计时浮层（环形进度 + 取消；捕获前必定撤除，阶段十一）
│   └── content.js         # content script 主逻辑：定位播放器、上报矩形、开关遮罩
├── offscreen.html         # 离屏文档宿主（捕获/裁剪/录制/下载全在离屏完成）
├── offscreen.js           # tabCapture → 隐藏 video → canvas 裁剪 → MediaRecorder
├── popup.html / popup.js  # action 入口：录制控制台 + 设置弹窗
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
| content script | **自身零注入**（不创建任何 DOM / 不注入样式）；定位播放器元素；上报视口基准（CSS 尺寸 / DPR / 可视视口偏移）；实时上报播放器矩形；页面隐藏/跳转通知；随会话开关录制期锁定遮罩 | 只有它能访问 YouTube 页面 DOM 与布局坐标；任何覆盖被录画面的浮层都会被录进视频 |
| content/guard.js | 录制期交互锁定遮罩：按画面矩形挖洞的黑底半透明遮罩 + 洞内全透明拦截层 + 滚动/快捷键拦截 + 尺寸变化告警；会话结束即移除 | 唯一允许在页面里创建 DOM 的模块，且几何上永不覆盖被录画面（见第 4 节） |
| popup | 录制控制台：开始 / 停止并保存 / 状态 / 计时 / 错误与提示 / 画面微调（裁剪偏移校准） | 独立扩展页面，不属于被捕获标签页的渲染内容，绝不会入镜 |
| offscreen | `tabCapture`、隐藏 video 播放、canvas 逐帧裁剪、合并音视频、`MediaRecorder`、组装 Blob、`chrome.downloads.download` | 只有它能拿到 tab 流并操作媒体 DOM |
| background | 创建/关闭 offscreen、路由消息、**维护全局录制状态（storage.session 持久化）与图标徽标** | Service Worker 是生命周期管理者；popup 会失焦关闭，状态必须有常驻归属 |

### 2.3 消息协议（`chrome.runtime.onMessage`）

**popup → background（录制控制入口）**
- `{ type: 'YR_START', tabId }`：开始录制（**带回执**：background 确保离屏就绪并转发 `REC_START` 后，回复 `{ok:true}` / `{ok:false,busy:true,phase}` / `{ok:false,code,message}`；离屏未就绪时按 1.5s 节奏重发，上限约 9s）
- `{ type: 'YR_STOP' }`：停止并保存（background 广播 `REC_STOP` 给离屏）；若仍在倒计时则视为放弃本次录制
- `{ type: 'YR_RESET' }`：强制复位残留会话后重新开始
- `{ type: 'YR_GET_STATE' }`：弹窗打开/收到广播时回查 `{phase, startedAt, durationMs, error, notice, tabId, countdownSec, countdownEndsAt}`
- `{ type: 'YR_CANCEL_COUNTDOWN' }`：取消进行中的倒计时（弹窗 / 全屏 PiP 的「取消倒计时」按钮）

**background ↔ content（阶段十一，开始录制前倒计时）**
- `{ type: 'YR_COUNTDOWN_START', seconds }`：请页面显示倒计时浮层（带回执；页面不可用时 background 降级为立即开始）
- `{ type: 'YR_COUNTDOWN_DONE' }`：页面倒计时归零**且浮层已从 DOM 移除**后发出，background 收到才真正开始捕获
- `{ type: 'YR_COUNTDOWN_CANCEL' }`：双向取消（页面 Esc / 卡片按钮 → background；background 取消 → 页面撤浮层）

**content ↔ background**
- `{ type: 'YR_PING' }`：popup 经 `tabs.sendMessage` 探测页面脚本是否已注入（能回执即说明当前页是 YouTube 且脚本就绪）
- `{ type: 'YR_RECT_ON' }` / `{ type: 'YR_RECT_OFF' }`：background 开关 content 的播放器矩形心跳（空闲时零开销）
- `{ type: 'PLAYER_RECT', rect, dpr, hasPlayer }`：content 高频上报播放器矩形（带 DPR）
- `{ type: 'PAGE_HIDDEN' }` / `{ type: 'PAGE_LEAVING' }`：录制中切页/刷新兜底
- `{ type: 'UI_ACTION', action: 'toast', payload }`：content（遮罩）发出的提示——目前仅「录制中检测到窗口尺寸变化」一条，由 background 记入 `notice`、popup 实时展示（复用离屏提示链路，无需新增消息类型）

**background → content（阶段十，全屏状态指示）**
- `{ type: 'YR_PIP_STATE', phase, startedAt, durationMs }`：录制 phase 每次变化（`setPhase`）广播，content/pip.js 置顶状态窗据此刷新文案与计时
- `{ type: 'YR_PIP_CFG', enabled }`：popup 设置里关掉「置顶状态窗」时下发，content/pip.js 立即收起已打开的小窗

**offscreen → 其它上下文（广播）**
- `{ type: 'REC_STATE', phase, payload? }`：`idle | capturing | recording | stopping | exported | error`；background 据此更新全局状态与徽标，popup 直接监听并刷新界面
- `{ type: 'UI_ACTION', action: 'modal'|'toast', payload }`：提示文案；页面内已无 UI，由 background 记入状态、popup 展示
- `{ type: 'DOWNLOAD_RESULT', ok, message? }`

**offscreen → background**
- `{ type: 'OFFSCREEN_READY' }`：离屏脚本就绪信号；background 收到后补发所有排队中的启动请求
- `{ type: 'YR_LOG', text }`：离屏诊断日志，转发到 SW 控制台供排查

**跨上下文（storage.session 兜底）**
- 启动意图键 `yrPendingStart`：content 点击开始后由 background 先写入（早于离屏创建），离屏加载完成时自查、或经 `storage.onChanged` 实时感知，在 `idle` 状态下自行 `begin()`。SW 休眠/重启、消息转发丢失均不影响该路径。

> 健壮性说明：
> - 离屏是唯一录制核心（单例）。`REC_START` 仅在离屏 `idle` 时受理并回执（`{ok:true}`）；非空闲时如实回执 `{ok:false,busy:true,phase}`，由发起侧区分处理：`preparing` 视为启动进行中继续等待；`recording/stopping/exported` 由 popup 展示「强制复位并重新开始」（`REC_RESET` 清理残留会话）。
> - background 对启动请求做带去重回执的重发（约 1.5s/次，上限约 9s），容忍离屏刚创建时消息丢失；与 `storage.session` 启动意图自查、`OFFSCREEN_READY` 补发队列三重兜底。
> - 弹窗会失焦关闭，故状态以 background 为准：内存态 + `storage.session` 持久化 + 启动水合，SW 重启后重开弹窗仍能看到真实状态；`chrome.action` 徽标提供不开弹窗的状态提示。
> - 每次会话结束（`broadcastIdle`）重置 `finalized`，保证失败/复位后会话可再次启用。
> - 诊断：background/offscreen 输出 `[YR-*]` 日志；错误由 `REC_STATE error` 回传，在 popup 中展示。

### 2.4 关键时序（数据流主线）

1. 用户在 YouTube 播放页点击扩展图标 → popup（录制控制台）打开 → 探测当前页脚本就绪后启用「开始录制」。
2. 用户点「开始录制」→ popup 发 `YR_START` → background 状态转 `capturing`、开启矩形心跳、转发 `REC_START`（带回执，必要时重发）；content 收到 `YR_RECT_ON` 时启用页面锁定遮罩，首次心跳把播放器矩形交给遮罩完成挖洞（遮罩早于首帧就位，绝不会出现在视频里）。
3. background 确保 offscreen 存在并转发 `REC_START`。
4. background 调用 `chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id })` 获取 `streamId`，并把它发送给 offscreen。
5. 拆分：`videoTrack` 交给隐藏 `<video>`；`audioTrack` 暂存（若缺失弹警告 toast，录无声）。
6. content 通过 `getBoundingClientRect` 定位播放器元素，经 `PLAYER_RECT` 高频上报矩形 **与视口基准**（视口 CSS 尺寸、`devicePixelRatio`、可视视口偏移/缩放）。
7. offscreen 隐藏 `<video>` 播放 `tabStream`；隐藏 `<canvas>`（尺寸 = 换算后的播放器宽高，取偶数）每帧 `drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch)` 完成裁剪。
   - 换算采用**实测比例**：`帧像素尺寸 ÷ 视口 CSS 尺寸 = 每 CSS 像素对应的帧像素数`，而不是 `rect × devicePixelRatio`。
     原因：`帧尺寸 = CSS 视口 × DPR` 只是常见情况下的巧合，页面缩放 / 系统缩放 / Chrome 对超大画面降采样时并不成立；
     一旦实际比例小于 DPR，裁剪区就会整体偏左上 —— 表现为「录进了播放器上方的网页内容、播放器下半部分丢失」。`devicePixelRatio` 仅在拿不到视口尺寸时兜底。
   - 录制开始后**锁定画布尺寸**（中途改分辨率会导致编码异常 / 画面被拉伸或裁掉），输出宽高取偶数（H.264 要求偶数尺寸）。
8. `canvas.captureStream(30)` 得到裁剪视频轨；`new MediaStream([videoTrack, audioTrack])` 合并为 `finalStream`。
9. `new MediaRecorder(finalStream, {mimeType: 候选链首个可用项})` `start()` 录制；候选链为 `video/mp4`（`avc1.*`+`mp4a.40.2` 多档）优先、失败逐档回退 `video/webm`。
10. 用户在 popup 点「停止并保存」→ 状态转 `stopping`（弹窗展示「正在组装视频文件」）→ offscreen 停帧循环、停 video、停全部 track、`recorder.stop()`。
11. `ondataavailable` 分片 → `onstop` 组装完整 Blob（type 取 `recorder.mimeType`，`.mp4`/`.webm` 由输出格式决定）→ `URL.createObjectURL` → `chrome.downloads.download`。
12. `downloads.onChanged` 完成后 `revokeObjectURL`；popup 收到 `DOWNLOAD_RESULT` 展示「已保存到下载目录（时长 xx:xx）」；background 收到 `idle` 后关闭 offscreen、关闭矩形心跳，全链路复位。content 收到 `YR_RECT_OFF` 时移除遮罩 DOM 与全部监听，页面恢复原状（失败 / 强制复位 / 页面卸载同样走这条清理路径）。

---

## 3. 边界情况与坑点清单（任务 18 依据）

| # | 坑点 | 对策 |
| --- | --- | --- |
| 1 | 录制中切换标签页：tabCapture 只对激活标签页有效，切走会静止/中断 | content 监听 `visibilitychange/pagehide` → 提示 + 停止流程兜底 |
| 2 | 高分屏 / 缩放：CSS 像素 ≠ 捕获物理像素，且比例未必等于 DPR | content 一并上报视口 CSS 尺寸与 DPR，离屏按「帧尺寸 ÷ 视口 CSS 尺寸」实测比例裁剪（DPR 仅兜底）；极端缩放组合下若仍有固定偏差，可用弹窗「画面微调」手动校准偏移 |
| 3 | 播放器 DOM 变化（全屏/缩放/滚动） | content 用 `MutationObserver` + `resize/scroll/fullscreenchange` 监听，事件与周期心跳双保险上报 |
| 4 | 逐帧 drawImage 的 CPU 开销 | 文档注明；提供 30fps 固定输出（`captureStream` 帧率独立于 rAF），不做多余帧绘制。可选项：长时录制若需降低 CPU 占用，可在 `drawLoop` 内对 rAF 做帧节流（例如隔帧绘制），`captureStream` 输出帧率随之下降 |
| 5 | DRM/Widevine：tabCapture 对受保护内容输出黑屏 | 录制开始 ~2s 后离屏采样画面中心像素，近似全黑则弹模态框告知（公开视频不受影响） |
| 6 | 音频只能取 `tabCapture` 原始 audioTrack，canvas 无音频能力 | audioTrack 全程不经过 canvas，直接并入 finalStream |
| 7 | 用户手势约束：capture 必须由点击驱动 | 状态机保证 REC_START 仅由按钮 click 发出 |
| 8 | 资源释放：不 `track.stop()` 会常驻红点 | 停止流程统一 stop 全部 track + `video.srcObject=null` + 关闭 offscreen |
| 9 | 格式：优先 MP4(H.264/AAC)，不支持回退 webm | mimeType 候选链：`video/mp4`（`avc1`+`mp4a.40.2` 多档）→ `video/mp4` → webm(vp9 → vp8)；构造与探测都纳入循环，单档失败自动落回下一档；全程不二次转码 |
| 10 | DOM 残留与内存泄漏 | 全部自定义节点统一 `yr-recorder-` 前缀；`cleanupYR()` 批量移除节点/监听/动画，供完成、异常、页面离开时调用 |
| 11 | **播放器元素盒子 ≠ 真实画面**：`<video>` 默认 `object-fit: contain`，剧场模式留白 / 21:9 / 4:3 / 竖屏片源时画面被等比内接居中，盒子上下多出的部分不是视频内容 | content 用 `videoWidth/videoHeight` 结合 `object-fit` / `object-position` 计算**真实绘制画面矩形**（命中容器时取内部 `<video>`），并夹进视口、上报可见比例；只录画面本身，不录黑边与留白 |
| 12 | `visualViewport.offsetTop/offsetLeft` 在桌面 Chrome 部分版本返回文档滚动量而非 0，原点修正会让裁剪区整体上移 | 仅在确实捏合缩放（`vvScale` 偏离 1）时才做可视视口原点换算；画面矩形已在 content 侧夹进视口，离屏侧的 clamp 只作兜底 |
| 11 | 暗黑模式 | CSS 变量两套配色，`matchMedia('(prefers-color-scheme: dark)')` + YouTube 页面类名探测动态切换 |
| 12 | **录制中操作页面**：滚动 / 缩放 / 点击链接会改变布局或触发跳转，导致裁剪错位、画面拉伸，甚至录制中断丢数据 | 录制期注入交互锁定遮罩（第 4 节）：屏蔽点击 / 滚动 / 快捷键，并对窗口尺寸变化告警 |

---

## 4. 录制期页面锁定遮罩（阶段九）

### 4.1 目标与约束

| 目标 | 约束 |
| --- | --- |
| 遮住播放器画面以外的全部内容，让用户在录制期间点不到任何链接 / 按钮 | 遮罩**绝不能**出现在被录画面里（离屏按画面矩形裁剪，遮罩一旦压到画面即入镜） |
| 禁止滚动页面 | 不能改变页面布局（改 `overflow` 会让滚动条消失 → 布局位移 → 裁剪区漂移） |
| 提示用户「录制中请勿操作」 | 提示文案同样不能压到画面上 |
| 会话结束（完成 / 失败 / 复位 / 卸载）后页面恢复原状 | 不留 DOM、不留监听、不留样式 |

### 4.2 为什么不把播放器「抬到遮罩之上」

播放器嵌在多层 stacking context 中（`body → ytd-app → ytd-page-manager → ytd-watch-flexy → ytd-player → #movie_player …`），要把播放器抬到遮罩之上必须逐层改写祖先的 `position` / `z-index`：既侵入页面布局（布局一变，被录画面跟着变），又会在 YouTube 改版时失效。
因此采用**反向思路 —— 聚光灯挖洞**：遮罩铺满视口，只在播放器画面处留洞。

### 4.3 几何（关键：洞 ≥ 被录画面）

```
┌──────────────────────── 视口 ────────────────────────┐
│  上遮罩（半透明黑 0.66）                              │
├──────────┬───────────────────────────────┬───────────┤
│ 左遮罩    │   洞（= 画面矩形外扩 M）        │  右遮罩   │
│          │   ┌───────────────────────┐   │           │
│          │   │ 播放器真实画面（被录） │   │           │
│          │   └───────────────────────┘   │           │
│          │   洞内盖一层「全透明」拦截层     │           │
├──────────┴───────────────────────────────┴───────────┤
│  下遮罩 + 提示文案（录制中，请勿操作页面）             │
└──────────────────────────────────────────────────────┘
```

- **洞** = content 上报的播放器「真实画面矩形」外扩 `M` 像素，再夹进视口：
  `M = HOLE_MARGIN_BASE(10) + |用户在弹窗设置的画面微调偏移|`。
  外扩用于容忍裁剪换算的 1~2px 抖动；叠加校准偏移是因为裁剪区会随偏移平移，洞必须同步外扩。
- **洞内拦截层**：`background: transparent` + `pointer-events: auto`，`z-index` 与遮罩同级。
  作用：吞掉点击与悬停（用户点不到播放器、YouTube 控制条也不会因悬停弹出，画面更干净）。
  它是**全透明**的，不参与合成，即使与画面重叠也不改变任何像素 —— 双保险。
- **提示文案**只放在洞外（画面下方优先、上方次之）；空间不足时先降级为单行，仍放不下则隐藏 ——
  **宁可不提示，也不允许压到画面上**。
- 布局由 content 的矩形心跳驱动（约 120ms/次），天然跟随剧场模式 / 全屏 / 窗口尺寸变化。

### 4.4 交互拦截清单

| 渠道 | 处理 |
| --- | --- |
| 鼠标点击 / 悬停 | 遮罩（4 块）+ 洞内透明拦截层覆盖视口，`pointer-events: auto` 吞掉事件 |
| 滚轮 / 触摸滑动 | `wheel` / `touchmove` 捕获阶段 `preventDefault` |
| 滚动兜底 | `scroll` 监听把页面拉回录制开始时的滚动位置（不改 `overflow`，避免布局位移） |
| 键盘 | 拦截空格 / 方向键 / PageUp·Down / Home·End，以及 YouTube 快捷键 `f t k j l m i c` 与数字键（0–9 按百分比跳转）；全屏时拦截 `Esc`；不拦截带 Ctrl / Cmd / Alt 的组合键，也不打断输入框内的正常输入 |
| 中键自动滚动 | `mousedown(button===1)` / `auxclick` 阻止默认行为 |
| **窗口缩放** | 网页无权禁止（由操作系统控制）。检测到视口尺寸变化 → 遮罩上亮出告警行 + 广播 `UI_ACTION` 到弹窗，建议停止后重新录制；遮罩按新尺寸重新挖洞，保证仍不压到画面 |

### 4.5 生命周期

```
YR_RECT_ON  → guard.enable()  → 记录滚动位置 / 视口尺寸、绑定监听、等待首次矩形心跳布局显示
PLAYER_RECT → guard.layout(rect)（~120ms 一次，跟随布局变化；定位不到播放器时隐藏遮罩）
YR_RECT_OFF → guard.disable()  → 解绑监听、移除 DOM 与 style，页面恢复原状
pagehide    → guard.disable()
```

失败 / 强制复位 / 页面卸载都会由 background 发出 `YR_RECT_OFF`（或 `pagehide`），因此不存在遮罩残留。
全屏状态下浏览器只渲染全屏子树，遮罩宿主相应切换为全屏元素（`document.fullscreenElement`）；若全屏目标是 `<video>`（其子节点不渲染）则放弃遮罩 —— 此时画面铺满屏幕，本就没有可点的页面元素。

---

## 4.6 全屏录制期的可见状态指示（阶段十）

### 4.6.1 问题与约束

HTML 全屏时画面铺满屏幕：洞 = 被录画面 = 整屏，遮罩四块与提示文案没有任何可显示空间，用户看不到「是否在录制」。任何画在画面内的标识都会被离屏按画面矩形裁剪进成片 —— **「画面内可见」与「完全不入画」在全屏铺满时互斥**。因此把指示放到两个合法层：**被捕获标签页之外**（浏览器 / 系统层）与**裁剪区之外**（letterbox 黑边）。

| 指示手段 | 载体 | 全屏可见 | 是否入画 | 说明 |
| --- | --- | --- | --- | --- |
| 系统通知 | `chrome.notifications` | 是（系统层浮于全屏之上） | 否 | 录制中常驻一条 `requireInteraction` 通知作为指示，带「停止并保存」按钮；保存成功 / 失败各发一次性回执；SW 重启水合后自动恢复。开关 `yrIndNotif` |
| 置顶状态窗 | Document PiP（`content/pip.js`） | 是（Windows/macOS/Linux，独立置顶小窗） | 否 | REC 红点 + 实时计时 + 停止按钮。开关 `yrIndPip` |
| 黑边红框 | guard 遮罩内（`content/guard.js`） | 画面有 letterbox 时可见，铺满时自动隐藏 | 否 | 红框距画面矩形 ≥ `RING_GAP(12px)`，像素只落在裁剪区之外。开关 `yrIndBorder` |
| 图标徽标 + popup | `chrome.action` / popup | 退出全屏后 | 否 | 原有能力，始终兜底 |

三开关读写收敛于 `shared/indicator.js`（`storage.sync`，默认全开），popup 设置弹窗「全屏录制状态提示」分组控制。

### 4.6.2 置顶状态窗的打开时机（为什么只能由快捷键驱动）

`documentPictureInPicture.requestWindow()` 需要**瞬态用户激活**。全屏场景只能用页面快捷键（`content/hotkey.js` 的 keydown）开始录制 → 本次按键天然携带激活，`hotkey.js` 在按键任务内同步调用 `YRPip.openIfFullscreen()`：
- 内部自检：配置开启、页面处于 HTML 全屏、当前未在录制（录制中按键 = 停止，不再弹窗）、浏览器提供 Document PiP 且存在用户激活，任一不满足即静默跳过；
- 成功打开后由 background 经 `YR_PIP_STATE { phase, startedAt, durationMs }` 广播驱动文案与计时（每个 phase 变化由 `setPhase` 触发一次 `syncPipStateToTab()`）；
- 小窗内容全部由 content 在 isolated world 里写入（同源窗口），「停止并保存」按钮直接发 `YR_STOP`；录制结束（idle/exported/error）自动关闭；用户也可手动关闭（当次会话不再自动重开，停止仍走快捷键 / 通知按钮 / popup）。

popup 点击开始录制的场景用户不在全屏（点扩展图标需工具栏可见），页面内遮罩提示已足够，无需小窗 —— 该判断逻辑自洽。

### 4.6.3 黑边红框的几何（为什么不担心入画）

letterbox 只会成对出现：宽片源（21:9）左右黑边、高片源（4:3 / 竖屏）上下黑边。红框要求某侧黑边 ≥ `RING_GAP + RING_WIDTH + 2` 才在该侧绘制（上下成对 / 左右成对，各一条贯穿线）；任何一侧空间不足即不画该侧，画面铺满（黑边 = 0）时全部隐藏。红框离画面矩形留足 12px，即使裁剪换算存在 1~2px 抖动也切不到红框；红框 z 序高于半透明遮罩（像素本就在裁剪区外，与遮罩层级无关，绝不影响录制像素）。

### 4.6.4 平台注意

macOS 全屏（独立 Space）下系统通知与 Document PiP 的浮层行为取决于操作系统 / Chrome 版本，出现「全屏上看不到」时以系统通知 + 黑边红框兜底；Windows / Linux 上三者通常全部可见。所有指示都不属于被捕获标签页 → 输出视频恒不受影响。

---

## 4.7 开始录制前的倒计时（阶段十一）

### 4.7.1 问题与约束

| 目标 | 约束 |
| --- | --- |
| 点「开始录制」后留几秒把页面调整好（移开鼠标、切全屏、等控制条淡出） | 倒计时**绝不能**出现在成片里 |
| 用户随时可以反悔 | 取消后不能残留任何状态 / 不能开始捕获 |
| 不能因为倒计时把录制卡死 | 页面脚本异常 / 消息丢失 / 标签页关闭都要有确定行为 |

### 4.7.2 为什么「先撤浮层、后开捕获」是唯一正确时序

tabCapture 捕获整个标签页的合成画面，捕获期间任何页面浮层都会入画。因此倒计时不能放在
「捕获已开始、靠裁剪区外摆放来避让」（guard.js 的思路）—— 它必须整体前移到**捕获之前**：

```
点开始 → 页面显示倒计时（捕获未开始，浮层可见且安全）
       → 归零：淡出(160ms) → 移出 DOM → 等 SAFE_GAP(120ms)
       → 页面发 YR_COUNTDOWN_DONE → background 才调用 getMediaStreamId() 开始捕获
```

由**页面**驱动而不是由 background 数秒，是因为只有页面能保证「浮层确实已移除」与
「开始捕获」的先后次序；弹窗会失焦关闭、SW 会被回收，都不能承担这个时序保证。

### 4.7.3 为什么不在点击时就申请 streamId

`chrome.tabCapture.getMediaStreamId()` 返回的 ID **只能使用一次，未使用会在几秒钟后过期**
（官方文档明确说明）。倒计时 3–10 秒后再消费，提前申请的 ID 必然失效，
因此 `requestStart()` 一定在倒计时结束后才调用 `beginRecording()`。

### 4.7.4 取消与兜底

| 场景 | 处理 |
| --- | --- |
| Esc / 卡片「取消」按钮 | 页面发 `YR_COUNTDOWN_CANCEL` → background 撤状态回 `idle` |
| 弹窗「取消倒计时」/ 全屏 PiP 按钮 | `YR_CANCEL_COUNTDOWN` → 通知页面撤浮层 + 回 `idle` |
| 再按一次录制快捷键 | background 在 `countdown` phase 下视为取消（等同点取消） |
| 页面脚本不可用（未注入 / 需刷新） | `YR_COUNTDOWN_START` 无回执 → **降级立即开始**，绝不卡住录制 |
| 页面消息丢失 | background 兜底定时器（结束时刻 + 3s）强制开始，并先补发撤浮层指令 |
| 标签页关闭 / 跳走 / SW 重启 | 取消倒计时并回到 `idle`（SW 重启后绝不替用户静默开始捕获） |

### 4.7.5 呈现

- 浮层锚定在播放器画面中央（直观提示「录的是这块」），播放器定位不到时退回视口中央；
- 环形进度随剩余时间递减 + 大数字逐秒跳动（轻微缩放动画），下方「取消（Esc）」；
- 浮层只是一层很淡的遮罩且不吃点击（倒计时正是留给用户「点全屏 / 调播放器」的时间），只有中央卡片接收点击；
- 全屏时挂进 `document.fullscreenElement`（与 guard.js 同款宿主选择），全屏下同样可见；
- 弹窗与全屏 PiP 小窗同步显示剩余秒数与「取消倒计时」按钮。

---

## 4.8 保存后时间裁剪（阶段十二）

**目标**：视频保存成功后弹出询问框；用户选择「去裁剪」则打开一个新浏览器窗口播放该视频，
并以下方 iOS 风格的缩略胶片 + 左右把手时间条做**时间区间裁剪**；点「保存」用裁剪结果
**替换刚才已保存的原文件**（同名覆盖，仅 MP4 环境；回退 WebM 时另存新名）。

**为什么用 OPFS 中转，而不是直接把 Blob 传给新窗口**：Chrome 的消息通道只可靠传递
JSON 数据（Blob 无法稳定跨上下文传递）；`chrome.downloads` 只能拿到下载元数据、读不回文件内容；
扩展页面又禁止 `file://`。而 OPFS（Origin Private File System）是扩展自身 origin 的私有
文件系统，离屏文档 / 询问窗口 / 编辑窗口天然同源共享、无需新增权限、不依赖任何常驻上下文内存。

**新增上下文与职责**（新文件均为扩展自有页面，不注入任何站点）：

| 文件 | 上下文 | 职责 |
| --- | --- | --- |
| `shared/pending-video.js` | offscreen / ask / editor 共用 | 「待裁剪视频」OPFS 暂存读写（save/load/clear + session 元信息），唯一的数据交接口 |
| `ask.html` + `ask.js` | background 弹出的小窗 | 询问是否裁剪：是 → `chrome.windows.create` 打开 `editor.html`；否 → 清理暂存并关闭 |
| `editor.html` | 编辑窗口 | 播放器 + 控制行 + 时间裁剪条 + 区间信息 + 导出浮层 |
| `editor/editor.css` | 编辑窗口 | iOS 风格布局（视频上、胶片把手条中、按钮下），明暗两套主题 |
| `editor/trim-bar.js` | 编辑窗口 | iOS 风格双把手时间条组件（缩略胶片底、区间压暗/高亮、播放头、拖动/预览回调），纯 UI 组件 |
| `editor/exporter.js` | 编辑窗口 | 时间区间导出内核：隐藏 `<video>` seek 到起点 → canvas 逐帧 drawImage + `MediaElementAudioSourceNode` 取音轨 → `MediaRecorder`（mp4 优先/webm 回退）→ 覆盖保存原文件 |
| `editor/editor.js` | 编辑窗口 | 装配：读取暂存/选文件 → 生成胶片 → 选区间试听 → 调导出内核 → 替换原文件 |

**消息链路（对既有录制主流程几乎零侵入）**：

```
录制完成 → offscreen 组装 Blob → background 代理下载
  → background: downloads.onChanged(complete) → 状态 idle + 成功通知（原逻辑）
  → offscreen 收到 DOWNLOAD_RESULT{ok} → 先 broadcastIdle（不阻塞下一次录制）
      再 YRPendingVideo.save(Blob) 写入 OPFS → 广播 YR_EDITOR_PERSISTED{ok}
  → background 收到 YR_EDITOR_PERSISTED{ok} → chrome.windows.create(ask.html)（重复保存先去重）
  → ask「去裁剪」→ 打开 editor.html（数据仍在 OPFS，编辑器自行读取并清理）
  → 编辑器裁剪完成 → chrome.downloads.download({ filename: 原名, conflictAction:'overwrite' })
```

**技术边界（与阶段一「零第三方依赖」一致）**：时间裁剪 = 浏览器原生「重编码」，
非容器级无损切割（后者需 mp4box / ffmpeg 之类）；导出耗时接近被选区间实际时长；
二次编码会带来轻微再压缩损耗。这些限制在编辑器内以提示文案说明。

---

## 5. 验收方式（任务 20）

1. Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」选择 `src/`。
2. 访问任意公开 YouTube 播放页 → 点击图标 → popup 点「打开录制面板」→ 页面右上浮出面板。
3. 按 TODO 阶段七 20.1~20.8 逐项验证（明暗主题、录制裁剪正确性、DPR、切页兜底、全屏跟随、DRM/异常提示、资源释放）。
4. 代码静态自检：对 `src/` 下所有 JS 执行 `node --check`，`manifest.json` 用 `JSON.parse` 校验（见阶段七执行命令）。
5. 遮罩专项：录制开始后页面被半透明遮罩盖住（播放器画面区域除外）、滚轮与快捷键无效、点不到任何按钮；点击「停止并保存」后遮罩立即消失、页面恢复可交互；输出视频中不含遮罩、不含提示文案。
6. 倒计时专项（阶段十一）：点开始后播放器中央出现环形倒计时并逐秒递减；归零后浮层先消失、随即出现录制遮罩，成片首帧不含倒计时；Esc / 卡片「取消」/ 弹窗「取消倒计时」/ 再按快捷键均能回到空闲且不产出文件；设置改为 0 秒时点击后立即开始。
