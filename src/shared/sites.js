/**
 * shared/sites.js —— 支持的录制站点识别与各站点播放器选择器（content / popup 共用）
 *
 * 【背景】
 * 扩展从「只支持 YouTube」逐步扩展为「YouTube + Bilibili（B 站）+ Dailymotion + Vimeo +
 * Instagram + Facebook + TikTok」。
 * 各站点的录制链路（tabCapture → 定位 video → canvas 裁剪 → MediaRecorder）完全一致，
 * 差别只在于：
 *   1. 注入域名（见 manifest.json 的 content_scripts.matches）；
 *   2. 页面里定位「真实画面」所用的播放器 DOM 选择器；
 *   3. 输出文件名前缀 / 文案里展示的站点名。
 * 本模块把这些站点差异收敛到一处，content.js（播放器矩形上报）、countdown.js
 * （倒计时卡片锚点）、popup（站点识别）共用，避免各处维护多套不同步的选择器。
 *
 * 【为什么按「站内可见的大 video 元素」定位即可】
 * 离屏裁剪以 content 上报的播放器矩形为准，而矩形来源必须是 <video> 的「真实绘制
 * 画面」（含 object-fit / object-position 换算，见 content.js）。因此这里只负责给出
 * 每个站点从哪个容器里取 <video> 的候选列表：命中容器时 content.js 会自动取其内部
 * <video>。
 */
(() => {
  'use strict';

  /** 站点定义：id 用于跨上下文传递，hostSuffixes 用于 URL/域名识别 */
  const SITES = [
    {
      id: 'youtube',
      label: 'YouTube',
      filePrefix: 'YouTube',
      hostSuffixes: ['youtube.com', 'youtube-nocookie.com'],
    },
    {
      id: 'bilibili',
      label: 'Bilibili',
      labelZh: '哔哩哔哩（B 站）',
      filePrefix: 'Bilibili',
      hostSuffixes: ['bilibili.com'],
    },
    {
      id: 'dailymotion',
      label: 'Dailymotion',
      filePrefix: 'Dailymotion',
      hostSuffixes: ['dailymotion.com'],
    },
    {
      id: 'vimeo',
      label: 'Vimeo',
      filePrefix: 'Vimeo',
      hostSuffixes: ['vimeo.com'],
    },
    {
      id: 'instagram',
      label: 'Instagram',
      filePrefix: 'Instagram',
      hostSuffixes: ['instagram.com'],
    },
    {
      id: 'facebook',
      label: 'Facebook',
      filePrefix: 'Facebook',
      hostSuffixes: ['facebook.com'],
    },
    {
      id: 'tiktok',
      label: 'TikTok',
      filePrefix: 'TikTok',
      hostSuffixes: ['tiktok.com'],
    },
  ];

  /**
   * 播放器候选定位器（合并七个站点 + 通用兜底，注入页只会命中其中一段）。
   * YouTube 段沿用原 content.js 的候选顺序；Bilibili 段同时覆盖新版 bpx 播放器
   * （.bpx-player-*）与旧版 bilibili 播放器（.bilibili-player-*）；Dailymotion 段
   * 覆盖其站点页/播放器里可见的 video（含 #player 等历史容器，video 标签自身有无
   * class 都能命中）。列表末尾放一条通用 `video` 作为兜底 —— 仅在前面全部未命中时
   * 才会匹配到页面里唯一的可见视频（例如新版播放器 DOM 或播放页仅此一个主视频），
   * 成本可忽略。
   */
  const PLAYER_SELECTORS = [
    // ---------- YouTube ----------
    'video.html5-main-video',
    '#movie_player video',
    '.html5-video-container video',
    '.video-stream.html5-main-video',
    '#movie_player',
    '#c4-player',
    '#player',
    '#player-container',
    '#player-container-outer',
    'ytd-watch-flexy #player',
    'ytd-player',
    '#ytd-player',
    // ---------- Bilibili（bpx 新版播放器） ----------
    '#bilibili-player video',
    '.bpx-player-video-wrap video',
    '.bpx-player-video-area video',
    '.bpx-player-video video',
    '.bpx-player-container video',
    '#bilibili-player .bpx-player-video-area',
    // ---------- Bilibili（旧版播放器） ----------
    '.bilibili-player-video-wrap video',
    '.bilibili-player-video video',
    '.bilibili-player-video-real',
    '#bilibili-player .bilibili-player-video',
    '#bilibili-player',
    '.bpx-player-video-wrap',
    '.bilibili-player-video-wrap',
    // ---------- Dailymotion ----------
    // DM 官网视频播放页（www.dailymotion.com/video/…）的 neon player 会把真实
    // <video> 直接渲染进主文档（曾见于 #player-wrapper / #player 等容器，video
    // 标签本身也可被 content 脚本定位到）。以下按「播放器容器内 video」多路覆盖；
    // 若 DM 改版后把 <video> 移入跨域 iframe 或 shadow DOM（主文档读不到），
    // 则由 content.js 的「最大可见 video」兜底与 CONTAINER_SELECTORS 依次收尾。
    '#player-wrapper video',
    '.player-wrapper video',
    '#player video',
    '.dmp_Video',
    '.dmp_video',
    '.dmp-player video',
    '[class*="Player"] video',
    // ---------- Vimeo ----------
    // Vimeo 官网播放页（vimeo.com/…）把真实 <video> 渲染进主文档，播放器自身的 CSS
    // 命名空间为 .vp-*（.vp-video / .vp-video-wrapper / .vp-player / .vp-player-layout
    // 等，具体类名随播放器版本变化），历史容器还见过 .video-player / .vimeo-player。
    // 以下按「外壳容器内 video」多路覆盖；个别版本把 <video> 放进 open shadow DOM
    // （主文档读不到）时，由下方 `video` 候选的「最大可见 video（递归 shadow root）」
    // 收尾，无需在此穷举。
    '.vp-video video',
    '.vp-video-wrapper video',
    '.vp-player video',
    '.vp-player-layout video',
    '.video-player video',
    '.vimeo-player video',
    // ---------- Instagram ----------
    // instagram.com 网页版（帖文 / Reel / 快拍 / 主页 Feed）把真实 <video> 直接渲染进
    // 主文档；播放器外壳没有稳定类名（当前版本是运行时生成的 hash class），因此这里只用
    // 语义 / 角色选择器覆盖「单个主视频」的场景：role="dialog"（打开帖文 / Reel / 快拍的
    // 模态视图）、article（Feed 帖卡片 / 单帖内容区）、main（主导航内容区）。
    // 主页 Feed 会一次性渲染多条视频（其余多是未播放的预览卡，videoWidth/Height 尚未解码
    // 为 0），滚动浏览时「当前在播的那条」交由下方通用 `video` 兜底按「可见面积最大的
    // 已解码 video」命中即可，无需在此穷举类名。
    'div[role="dialog"] video',
    'article video',
    'main video',
    // ---------- Facebook ----------
    // facebook.com 的视频（Watch / Reel / 单视频弹层 / 时间线）同样把真实 <video> 直接渲染进
    // 主文档，外壳类名是运行时生成的 hash，无稳定 class，结构与 Instagram 同型 —— 因此上方
    // Instagram 段的 role="dialog"（打开视频 / Reel 的模态层）、article、main 与列表末尾裸
    // `video` 的「最大可见已解码」兜底对 Facebook 页面同样生效。这里只需补充 Facebook 特有的
    // 承载容器：Watch / 单视频页主 video 的外层容器带 data-video-id（内部即唯一主 video）。
    // 时间线 / 主页同时渲染多条带 data-video-id 的视频时，其余多为未解码预览卡（videoWidth
    // 为 0，content.js 会跳过），在播主视频最终由裸 `video` 兜底按可见面积命中。
    '[data-video-id] video',
    // ---------- TikTok ----------
    // tiktok.com（视频详情页 / 打开视频的模态层 / For You 信息流）把真实 <video> 直接渲染进
    // 主文档，外壳类名是运行时生成的 hash、随版本变化，无稳定 class —— 与 Instagram /
    // Facebook 同型。播放器承载容器带语义属性 data-e2e="video-player"（历史布局还见过
    // .video-player 类），因此这里只用 e2e / 语义容器多路覆盖「单个主视频」的场景；
    // 信息流（/foryou / 主页）会一次性渲染多条视频，其余多为未解码预览卡（videoWidth 为 0，
    // content.js 会跳过），当前在播的那条最终由下方裸 `video` 兜底按可见面积命中。
    '[data-e2e="video-player"] video',
    '[data-e2e="video-player-basic"] video',
    '.video-player video',
    '[data-e2e="video-player"]',
    // ---------- 通用兜底 ----------
    // content.js 对裸 `video` 选择器会特殊处理为「取可见面积最大的已就绪 video」，
    // 而非 document.querySelector 返回的第一个 —— 避免命中推荐位 / 迷你小窗视频。
    'video',
  ];

  /** 提取 URL 的主机名（解析失败返回空串，不抛错） */
  function hostOfUrl(url) {
    try {
      const u = new URL(String(url || ''));
      return u.hostname || '';
    } catch (err) {
      return '';
    }
  }

  /** 主机名是否命中某站点（支持主域名与 *.子域名） */
  function hostMatch(host, suffixes) {
    const h = String(host || '').toLowerCase();
    if (!h) return false;
    return suffixes.some((suffix) => h === suffix || h.endsWith('.' + suffix));
  }

  /** 根据主机名识别站点；未命中返回 null */
  function detectByHost(host) {
    for (const site of SITES) {
      if (hostMatch(host, site.hostSuffixes)) return site;
    }
    return null;
  }

  /** 根据完整 URL 识别站点；未命中返回 null */
  function detectByUrl(url) {
    return detectByHost(hostOfUrl(url));
  }

  /** 当前页面所属站点（content script 上下文使用） */
  function detectCurrent() {
    return detectByHost(window && window.location ? window.location.hostname : '');
  }

  /** 站点 id → 展示名（未命中退回通用「视频」名） */
  function labelOf(siteId) {
    for (const site of SITES) {
      if (site.id === siteId) return site.labelZh || site.label;
    }
    return '视频';
  }

  /**
   * 「容器级」播放器候选：当且仅当 PLAYER_SELECTORS（含最大可见 video 兜底）全部
   * miss 时才使用；命中元素不要求内部包含 <video>，直接以该元素的 boundingClientRect
   * 作为录制区矩形。
   *
   * 目前只用于 Dailymotion 与 Vimeo：两者播放页主文档通常能直接读到真实 <video>
   * （上面的 video 候选已覆盖）；但当 video 被放进跨域 iframe / shadow DOM（同源策略
   * 或封装导致 content script 读不到）时，主文档渲染的播放器外壳容器矩形与视频画面
   * 矩形一致，且容器之外的其它 UI 不会被录进，因此用容器矩形作为兜底可行；
   * 其他站点容器往往内嵌其它 UI，不纳入此列表。
   */
  const CONTAINER_SELECTORS = [
    // ---------- Dailymotion ----------
    '#player-wrapper',
    '.player-wrapper',
    '[class*="Player__player"]',
    '[class*="TopPlayer__player"]',
    '[class*="TopPlayer__placeholder"]',
    '[class*="PlayerPlaceholder"]',
    '[class*="Player__body"]',
    // ---------- Vimeo ----------
    // 真实 <video> 无法从主文档读到时的外壳容器（.vp-* 播放器根 / 画面区）。
    '.vp-player-layout',
    '.vp-player',
    '.vp-video',
    '.video-player',
    '.vimeo-player',
  ];

  window.YRSites = {
    SITES,
    PLAYER_SELECTORS,
    CONTAINER_SELECTORS,
    hostOfUrl,
    detectByHost,
    detectByUrl,
    detectCurrent,
    labelOf,
  };
})();
