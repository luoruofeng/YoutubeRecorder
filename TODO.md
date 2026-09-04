# YouTube 播放器录制插件（Chrome MV3）开发 TodoList

> 项目目标：开发一个 Chrome Manifest V3 浏览器插件。用户在 YouTube 播放页手动点击触发录制，捕获当前标签页完整画面与页面内音频，在浏览器内部用 Canvas 裁剪画面只保留播放器区域，最终输出带音频的 webm 文件并下载到本地。
> 技术约束：全程只使用浏览器原生 JavaScript / TypeScript（TypeScript 仅做类型标注，运行时代码仍是 JavaScript），不引入任何第三方库、不使用 ffmpeg 及任何转码工具。

---

## 阶段一：项目初始化与技术方案确认

- [x] 任务 1：梳理并确认全部底层能力清单（写入项目设计文档，如 `DESIGN.md`）
  - [x] 1.1 Chrome 扩展专属接口：`chrome.tabCapture`、`chrome.downloads`、`chrome.action`（弹出面板）
  - [x] 1.2 权限模型确认：`tabCapture`（受限权限）、`downloads`、`activeTab`
  - [x] 1.3 浏览器 Web 原生接口：`MediaStream` 系列（`MediaStreamTrack`）、`MediaRecorder`、Canvas 2D API（`canvas.captureStream` / `ctx.drawImage`）、`getBoundingClientRect`、`requestAnimationFrame`、隐藏 `video` 媒体元素、`URL.createObjectURL` / `URL.revokeObjectURL`、`Blob`
  - [x] 1.4 明确技术边界：不装任何 npm 第三方包，无转码，只输出 `video/webm`
  - [x] 1.5 明确安全性设计约束：录制必须由用户点击按钮触发，绝不允许后台静默自动开启录制
- [x] 任务 2：创建项目目录骨架（无构建工具或仅最简 TS 编译）
  - [x] 2.1 建立 `src/manifest.json`、content script、background（service worker）、popup 相关目录结构
  - [x] 2.2 建立 TS 类型声明目录（用于 chrome 扩展 API 类型标注）

## 阶段二：插件配置与入口（manifest.json）

- [x] 任务 3：编写 `manifest.json`（Manifest V3）
  - [x] 3.1 `manifest_version` 设为 3，声明扩展名称、版本、描述、图标
  - [x] 3.2 `permissions` 声明 `tabCapture`、`downloads`、`activeTab`（`tabCapture` 为受限权限，注释说明审核与合规要点：仅用户交互触发）
  - [x] 3.3 配置 content script（`matches` 限定 YouTube 域名，`js` / `css` 注入，`run_at` 合理时机）
  - [x] 3.4 配置 background service worker 入口（用于承载 `chrome.tabCapture` / `chrome.downloads` 调用，视实现方案而定：capture 也可在 content script 或 action 弹出页发起，需选定并实现其一）
  - [x] 3.5 配置 `action` 弹出面板 HTML（popup 主界面入口）
  - [x] 3.6 配置所需 `host_permissions`（如需要）与最小权限集核对

## 阶段三：页面可视化交互组件（content script 注入层）

> 全部使用原生 DOM / CSS 实现，不引入任何 UI 第三方组件库；样式全部使用内联样式或 content script 内部动态创建 `style` 标签写入，不依赖外部 CSS 文件。

- [x] 任务 4：搭建注入基础框架（样式隔离与通用工具）
  - [x] 4.1 所有自定义 DOM 元素统一使用 `yr-recorder-` 前缀的 class
  - [x] 4.2 所有 CSS 选择器必须带上 `yr-recorder-` 前缀，不使用通用标签选择器，防止污染 YouTube 页面样式
  - [x] 4.3 使用 CSS 变量管理颜色，准备浅色 / 深色两套配色（适配 YouTube 暗黑模式，检测页面是否深色主题并动态切换组件背景文字色，避免白面板在深色页面下突兀）
  - [x] 4.4 实现动态创建 `style` 标签并注入 `document.head` 的公共函数
  - [x] 4.5 实现 DOM 清理函数：批量移除所有 `yr-recorder-` 前缀节点、清除 CSS 动画、移除事件监听（供页面跳转 / 录制结束 / 异常退出时调用）
- [x] 任务 5：实现主操作弹出面板（点击插件图标呼出）
  - [x] 5.1 定位方式：固定定位悬浮在网页视图上层，`z-index: 99999`
  - [x] 5.2 尺寸外观：宽 340px、高度自适应、圆角 12px、纯白背景、柔和浅灰色且模糊程度较大的阴影（悬浮弹窗效果）
  - [x] 5.3 自上而下四个区域：标题区 / 状态展示区 / 功能按钮区 / 提示文本区
    - [x] 5.3.1 标题区：展示插件名称，加粗、字号 16px，上下留 12px 内边距
    - [x] 5.3.2 状态区：展示「空闲 / 准备捕获标签页 / 正在录制 / 停止处理中 / 导出完成」状态，不同文字颜色区分（空闲黑色、录制醒目红色、处理中蓝色）
    - [x] 5.3.3 按钮区：「开始录制」与「停止录制」两个按钮，默认不同时可用（空闲时停止按钮置灰；录制中开始按钮置灰）
    - [x] 5.3.4 提示文本区：字号 12px、灰色小字，展示备注（输出格式为 webm、录制中不要切换标签页等）
  - [x] 5.4 按钮样式：圆角 8px、高度 40px、宽 100%、字号 14px；开始按钮蓝底白字、停止按钮红底白字；禁用态浅灰背景；hover 时背景轻微加深
- [x] 任务 6：实现全局模态框组件
  - [x] 6.1 遮罩层：固定定位铺满视口、半透明黑色透明度 0.6、`z-index` 高于主面板
  - [x] 6.2 模态框本体：固定定位上下左右居中对齐、宽 420px、最大宽 90%、圆角 12px、白底、充足内边距
  - [x] 6.3 内部结构：标题（加粗 16px）+ 正文（常规 14px）+ 底部确认按钮
  - [x] 6.4 交互：点击确认按钮后移除模态框与遮罩 DOM 节点
  - [x] 6.5 触发场景接入：调用 tabCapture 被浏览器拒绝 / 检测到 DRM 加密视频无法录制 / 录制过程发生异常报错
- [x] 任务 7：实现加载框组件（两种形态）
  - [x] 7.1 行内加载：嵌入主面板内部，用于短时等待（如正在获取标签页流），旋转 CSS 动画圆圈 + 文字说明「正在初始化捕获流」
  - [x] 7.2 全屏悬浮加载弹窗：固定居中、带半透明遮罩，用于耗时阶段（如录制结束后组装 blob），居中旋转动画 + 文字「正在组装视频文件，请稍候，不要关闭页面」
  - [x] 7.3 旋转动画统一使用 CSS `@keyframes` 实现，不使用图片或 SVG 等外部资源
- [x] 任务 8：实现轻量临时提示浮层（toast）组件
  - [x] 8.1 固定定位在页面右下角（距底部 24px、距右侧 24px），圆角 8px、内边距 12px、字号 13px
  - [x] 8.2 按类型区分背景：成功绿色半透明 / 警告黄色半透明 / 错误红色半透明，`z-index` 最高
  - [x] 8.3 自动消失：延时 3 秒后移除自身 DOM 节点，无需用户点击
  - [x] 8.4 触发场景接入：出现报错、录制成功、下载触发成功时弹出对应 toast

## 阶段四：核心录制实现流程（content script 主逻辑）

- [x] 任务 9：实现「开始录制」交互入口与 tabCapture 捕获
  - [x] 9.1 用户点击「开始录制」→ 面板切到「准备捕获」状态，展示行内加载（文字「正在准备捕获标签页流」），禁用开始按钮
  - [x] 9.2 调用 `chrome.tabCapture.capture({ audio: true, video: true })` 获取完整标签页媒体流 `tabStream`（含全页画面视频轨 + 页面全部声音音频轨）
  - [x] 9.3 说明性注记：沙箱隔离决定了只能抓取标签页合成输出流，无法直接抓 `video` 标签内部资源；广告弹窗声音会被一并录制；DRM 付费视频将黑屏无声，普通公开视频正常
  - [x] 9.4 异常处理：`tabCapture` 抛出异常 → 弹出错误模态框提示捕获失败 → 关闭加载组件 → 面板恢复空闲状态
- [x] 任务 10：提取并保存音频轨道
  - [x] 10.1 从 `tabStream.getAudioTracks()` 取出第一个有效 `audioTrack` 保存复用（音频直用原始轨道，绝不经过 canvas——canvas 无音频输出能力）
  - [x] 10.2 若取不到有效音频轨道：弹出警告 toast（无法获取页面音频，仍可录制，但输出无声）
- [x] 任务 11：创建隐藏 video 元素消费 tabStream
  - [x] 11.1 动态创建不可见 `video` DOM 元素（不渲染给用户）
  - [x] 11.2 将 `tabStream` 赋给 `video.srcObject` 并调用 `video.play()` 播放
  - [x] 11.3 说明：该 video 作为画面数据源，后续为 canvas 提供像素进行裁剪绘制
- [x] 任务 12：定位播放器区域并做像素换算（含动态监听）
  - [x] 12.1 定位 `ytd-player` 播放器容器 DOM 节点（找不到则弹模态框提示「当前页面不是有效的 YouTube 播放页面」，终止流程并释放已获取的媒体流资源）
  - [x] 12.2 调用 `getBoundingClientRect()` 获取播放器相对视口的 x / y / 宽 / 高
  - [x] 12.3 高分屏换算：所有坐标与宽高乘 `devicePixelRatio`（getBoundingClientRect 是 CSS 像素，tabCapture 输出为物理像素，不换算会偏移错位）
  - [x] 12.4 监听 DOM 变化（`MutationObserver` 或 resize/fullscreenchange），实时重新获取播放器位置尺寸，应对全屏、页面缩放、播放器尺寸变化
- [x] 任务 13：创建隐藏 canvas 并启动 rAF 逐帧裁剪循环
  - [x] 13.1 创建完全隐藏的 canvas 元素（用户不可见），宽高赋值为 DPR 换算后的播放器宽高
  - [x] 13.2 获取 2D 绘图上下文 `ctx`
  - [x] 13.3 开启 `requestAnimationFrame` 循环：内部以隐藏 video 为图像源调用 `ctx.drawImage`，源裁剪区域取播放器在 tab 画面中的 x/y/宽/高，目标绘制到 canvas 的 (0,0) 且宽高与 canvas 一致（丢弃播放器以外画面，完成画面裁剪）
  - [x] 13.4 每帧末尾再次调用 `requestAnimationFrame` 持续下一轮绘制（注明 CPU 开销特性：录制越久 CPU 消耗越高，浏览器无原生媒体流裁剪接口，只能 canvas 逐帧绘制）
  - [x] 13.5 状态联动：进入录制后主面板文字「正在录制」红色提示，停止按钮切换为可点击
- [x] 任务 14：输出裁剪视频流并合并音视频轨道
  - [x] 14.1 调用 `canvas.captureStream(帧率)` 得到仅含视频轨道的 `canvasVideoStream`，取出其中 `videoTrack`
  - [x] 14.2 新建 `finalStream = new MediaStream()`：放入 canvas 输出的 `videoTrack` + 最初保存的原始 `audioTrack`（画面已裁剪为播放器大小，音频为完整原始音频）
- [x] 任务 15：初始化 MediaRecorder 开始录制
  - [x] 15.1 实例化 `new MediaRecorder(finalStream, { mimeType: 'video/webm;codecs=vp9,opus' })`（浏览器原生只支持输出 webm，不转码 mp4）
  - [x] 15.2 准备分片数组；绑定 `ondataavailable`，每次触发将数据块 push 保存
  - [x] 15.3 绑定 `onstop`：把所有分片组装为完整 `Blob`（type 为 `video/webm`）
  - [x] 15.4 调用 `recorder.start()` 启动录制

## 阶段五：停止录制、导出与资源释放

- [x] 任务 16：实现「停止录制」流程
  - [x] 16.1 用户点击停止 → 主面板立即弹出全屏悬浮加载框（提示「正在组装视频文件，请稍候，不要关闭页面」），面板切「停止处理中」状态
  - [x] 16.2 调用 `MediaRecorder.stop()` 结束录制
  - [x] 16.3 停止 `requestAnimationFrame` 循环
  - [x] 16.4 停止隐藏 video 播放
  - [x] 16.5 将所有 MediaStream 中的 track 全部调用 `stop()` 释放媒体资源（防止持续占用 tabCapture 资源、浏览器常驻录制红点）
- [x] 任务 17：组装 Blob、触发下载并复位
  - [x] 17.1 `onstop` 触发后生成完整 webm Blob，关闭全屏悬浮加载框
  - [x] 17.2 `URL.createObjectURL(blob)` 生成临时本地 URL
  - [x] 17.3 调用 `chrome.downloads.download` 触发浏览器下载（保存 webm 到本地磁盘），成功后弹成功 toast
  - [x] 17.4 下载完成后 `URL.revokeObjectURL` 释放临时 URL，防止内存泄漏
  - [x] 17.5 状态更新为「导出完成」并回到空闲初始状态，清理全部自定义 DOM 组件（面板、模态框、加载框、toast），移除事件监听、清除 CSS 动画，确保不污染 YouTube 页面

## 阶段六：边界情况与全局清理

- [x] 任务 18：逐项核对并实现全部坑点 / 边界处理
  - [x] 18.1 标签页切换：tabCapture 只能捕获当前激活标签页，录制中切走会降帧甚至异常（UI 提示 + 异常兜底处理）
  - [x] 18.2 高分屏 DPR 像素换算：防止裁剪画面位置错乱
  - [x] 18.3 播放器 DOM 变化（全屏 / 页面缩放）：监听更新，重新获取 rect
  - [x] 18.4 性能：canvas 逐帧绘制 CPU 开销，长时录制性能压力说明与可选项（降帧）考量
  - [x] 18.5 DRM 加密视频：黑屏无声，检测到该情况弹模态框告知用户
  - [x] 18.6 音频来源：直接复用 tabCapture 原始 audioTrack，绝不让 canvas 产生音频
  - [x] 18.7 用户手势约束：所有录制开始动作必须由用户点击触发，不可代码自动启动（Chrome 安全策略会拦截）
  - [x] 18.8 资源释放：所有媒体轨道录制结束必须手动 stop，避免持续占用捕获资源与录制红点
  - [x] 18.9 格式约束：MediaRecorder 只输出 webm，全程不做任何转码
  - [x] 18.10 DOM 清理与内存：页面跳转、录制异常结束、录制完成时全部销毁 `yr-recorder-` 节点、清除事件监听与 CSS 动画，防止组件残留与内存泄漏
  - [x] 18.11 暗黑模式：CSS 变量两套配色，检测页面深色主题动态切换，避免视觉突兀
- [x] 任务 19：整理整体数据流文档（写入设计文档收尾）
  - [x] 19.1 数据流主线落档：用户点击按钮 → tabCapture 取完整 tab 音视频流 → 分离保存音频轨 → 隐藏 video 消费 tab 流 → 取播放器 DOM 坐标并处理 DPR → 隐藏 canvas + rAF 循环 drawImage 裁剪 → canvas 输出裁剪后视频流 → 合并裁剪视频轨与原始音频轨得到 finalStream → MediaRecorder 录制 finalStream 得到 webm 分片 → 停止录制组装完整 Blob → 触发下载保存 webm → 释放全部媒体资源、销毁全部自定义 UI DOM → 插件回到空闲

## 阶段七：加载测试与验收

- [ ] 任务 20：在 Chrome 中以「加载已解压的扩展程序」方式加载插件并进行功能验证
  - [ ] 20.1 面板正常弹出，样式与 YouTube 页面无冲突，明暗主题下均正常
  - [ ] 20.2 点击开始录制 → 捕获成功 → 录制正常 → 停止 → 下载 webm 文件
  - [ ] 20.3 校验输出视频：画面为播放器区域裁剪、带音频、格式为 webm 可正常播放
  - [ ] 20.4 高清屏（DPR ≠ 1）下画面不偏移不错位
  - [ ] 20.5 录制中切换标签页 / 页面跳转：组件清理无残留、无异常报错
  - [ ] 20.6 全屏切换 / 页面缩放后画面区域跟随正确
  - [ ] 20.7 DRM 视频、非播放页、tabCapture 被拒绝等错误场景的模态框 / toast 提示正确
  - [ ] 20.8 录制结束（含异常）后确认无 track 残留、无录制红点残留、无内存泄漏迹象
