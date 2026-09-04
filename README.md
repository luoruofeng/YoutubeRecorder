# YoutubeRecorder

Chrome Manifest V3 浏览器扩展：在 YouTube 播放页**手动点击**触发录制，捕获当前标签页完整画面与页面音频，在浏览器内用 Canvas 逐帧裁剪出播放器区域，最终输出**带音频的 `video/webm`** 并下载到本地。

- 零第三方依赖、无 npm、无 ffmpeg / 无任何转码。
- 全程原生 JavaScript（TS 仅以 `src/types/*.d.ts` 做类型标注）。
- 录制只由用户点击「开始录制」触发，绝无后台静默捕获。

## 目录结构

```
DESIGN.md            技术设计文档（底层能力清单 / 架构 / 消息协议 / 边界处理 / 数据流）
TODO.md              开发任务清单（逐项验收打勾）
src/
├── manifest.json     MV3 清单（tabCapture + downloads + activeTab + offscreen）
├── background.js     Service Worker：offscreen 生命周期与消息路由
├── offscreen.html   离屏文档宿主
├── offscreen.js     录制核心：tabCapture → 隐藏 video → canvas 裁剪 → MediaRecorder → 下载
├── content/
│   ├── ui.js        content script UI 组件（yr-recorder- 前缀注入层：面板/模态框/加载框/toast）
│   └── content.js   content script 主逻辑（面板交互 + 播放器定位 + 状态机）
├── popup.html       插件图标入口（打开页面内录制面板）
├── popup.js
├── icons/           16/32/48/128 图标
└── types/           chrome.* API 类型声明（仅类型标注）
scripts/verify_extension.py   扩展静态自检脚本
```

## 架构简析（为什么需要 offscreen）

`chrome.tabCapture` 不能在 content script 中调用；而裁剪所需的 `video/canvas/MediaRecorder` 又必须运行在有 DOM 的窗口上下文。因此录制核心放在 **offscreen document** 中，并由 background 先申请 `streamId` 再交给离屏页消费：

1. content script 注入 `yr-recorder-` UI，实时定位 `ytd-player` 并上报播放器矩形（CSS 坐标 × devicePixelRatio）。
2. background 按需创建离屏文档。
3. background 调用 `chrome.tabCapture.getMediaStreamId()` 获取当前标签页的 `streamId`。
4. 离屏内用 `getUserMedia({ chromeMediaSourceId: streamId })` 消费全页流，再完成：隐藏 `video` 播放全页流 → 隐藏 `canvas` 逐帧 `drawImage` 裁剪 → `canvas.captureStream(30)` 视频轨 + 原始 `audioTrack` 合流 → `MediaRecorder` 录 webm → 组装 Blob → `chrome.downloads.download`。

详见 `DESIGN.md`。

## 加载（开发调试）

1. 打开 Chrome，访问 `chrome://extensions`。
2. 右上角开启「开发者模式」。
3. 点「加载已解压的扩展程序」，选择本仓库的 `src/` 目录（无构建步骤，无需编译）。

> 要求：Chrome ≥ 109（`chrome.offscreen` API），推荐最新稳定版。

## 使用

1. 打开任意 **YouTube 播放页**（公开视频；DRM/会员付费视频画面会黑屏，属浏览器保护限制）。
2. 点击扩展图标 → popup 中点击「在页面中打开录制面板」→ 页面右上角浮出录制面板。
3. 点「开始录制」（请保持该标签页可见、播放器完整在视口内）。
4. 结束后点「停止录制」→ 自动组装并下载 `YouTube-日期-时间.webm`。
5. 导出完成后页面内自定义组件会自动清理，不污染页面。

## 静态自检

```bash
python3 scripts/verify_extension.py
```

覆盖：manifest/MV3/必需文件、YouTube 域名限定、最小权限、零第三方依赖、JS 语法、API 上下文边界（content 不直接调用 tabCapture/downloads/offscreen）、UI 前缀与样式隔离抽查。

## 手动验收清单（对应 TODO 任务 20）

按上述「加载 + 使用」操作后逐项验收：

- [ ] 20.1 面板正常弹出，样式与 YouTube 页面无冲突；在 YouTube 明暗主题下分别验证配色正常（暗色下为深底浅字）。
- [ ] 20.2 点「开始录制」→ 捕获成功（状态「正在录制」红色）→ 停止 → 浏览器下载 webm 文件。
- [ ] 20.3 用系统播放器 / Chrome 打开输出文件：画面为播放器区域裁剪、带音频、可正常播放。
- [ ] 20.4 高清屏（DPR ≠ 1，如 Retina）下画面不偏移不错位。
- [ ] 20.5 录制中切换标签页：出现警告 toast；切回页面录制继续或自动停止导出，无异常。
- [ ] 20.6 录制中全屏切换 / 浏览器缩放：画面裁剪区域跟随正确。
- [ ] 20.7 错误场景提示正确：非播放页点开始（模态框）、DRM 视频（约 2.6s 后黑屏检测模态框）、捕获被拒等。
- [ ] 20.8 录制结束（含异常）后：页面无 `yr-recorder-` 残留节点、地址栏无录制红点、无持续报错。

完成全部验收后，将 `TODO.md` 任务 20 各子项打勾即可。
