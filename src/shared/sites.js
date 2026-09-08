/**
 * shared/sites.js —— 支持的录制站点识别与各站点播放器候选（content / popup 共用）
 *
 * 【背景】
 * 扩展从「只支持 YouTube」逐步扩展为「YouTube + Bilibili（B 站）+ Dailymotion + Vimeo +
 * Instagram + Facebook + TikTok」。
 * 各站点的录制链路（tabCapture → 定位 video → canvas 裁剪 → MediaRecorder）完全一致，
 * 差别只在于：
 *   1. 注入域名（见 manifest.json 的 content_scripts.matches）；
 *   2. 页面里定位「真实画面」所用的播放器 DOM 选择器；
 *   3. 输出文件名前缀 / 文案里展示的站点名。
 *
 * 【设计：注册表（表驱动） + 按站点归位（Strategy 化）】
 * 本模块是站点差异的「唯一事实来源」。每个站点在 SITES 注册表里是一条记录，记录中
 * 内嵌它自己的播放器候选列表（playerSelectors）与容器级兜底（containerSelectors）：
 *   - content.js / countdown.js 先 detectCurrent() 命中当前站点，再只取**本站点**的
 *     候选 + 一条通用兜底进行探测 —— 不再像早期那样把七个站点的选择器平铺成一个
 *     全局大数组、每 120ms 心跳全量遍历；
 *   - 输出文件名前缀（offscreen.js）、通知站点名（background.js）等仍因 MV3 上下文
 *     隔离而各有一份副本，verify_extension.py 会静态断言它们与本注册表一致，防止漂移。
 *
 * 【为什么按「站内可见的大 video 元素」定位即可】
 * 离屏裁剪以 content 上报的播放器矩形为准，而矩形来源必须是 <video> 的「真实绘制
 * 画面」（含 object-fit / object-position 换算，见 content.js）。因此这里只负责给出
 * 每个站点从哪个容器里取 <video> 的候选列表：命中容器时 content.js 会自动取其内部
 * <video>。
 *
 * 【约定】
 * 1. 注册表顺序只影响展示与遍历，不影响候选探测（content 侧按当前站点取用）。
 * 2. 每条记录的 hostSuffixes **第 0 项是站点主域名**，manifest.json 的
 *    content_scripts.matches 必须注入它；其余项是可选的别名域名（如
 *    youtube-nocookie.com），不要求注入。
 * 3. playerSelectors 末尾无需写通用 `video` 兜底 —— probeSelectorsOf() 会统一追加；
 *    站间共享的语义选择器请用下方 IG_FB_TT_SEMANTIC 常量，按站点显式引用。
 */
(() => {
  'use strict';

  /**
   * 跨站共享的「语义 / 角色」播放器候选。
   * Instagram / Facebook / TikTok 三家网页版都把真实 <video> 直接渲染进主文档，外壳
   * 类名是运行时生成的 hash、无稳定 class，因此共用这套语义容器：
   *   - role="dialog"：打开帖文 / Reel / 快拍 / 视频的模态视图；
   *   - article：Feed 帖卡片 / 单帖内容区；
   *   - main：主导航内容区（如 TikTok 详情页、FB Watch）。
   * 注释说明（原平铺时代三者只写一份、位于 IG 段）：它们对 IG / FB / TikTok 页面
   * 都生效，且必须排在各家「站点特有候选」之前 —— 站点数组里显式引用本常量即保证
   * 该相对顺序与历史实现一致。
   */
  const IG_FB_TT_SEMANTIC = ['div[role="dialog"] video', 'article video', 'main video'];

  /**
   * 站点注册表（表驱动：id 跨上下文传递，hostSuffixes 识别域名，label / filePrefix 供
   * 展示与输出文件名，playerSelectors / containerSelectors 供播放器定位）。
   * playerSelectors 均为「播放器容器或 video 元素」候选，命中顺序即数组顺序；
   * containerSelectors 仅当 playerSelectors + 通用 `video` 兜底全部 miss 时才使用，
   * 命中元素不要求含 <video>（直接以容器矩形作录制区），目前只用于 Dailymotion 与
   * Vimeo（其真实 <video> 被跨域 iframe / shadow DOM 封装时的外壳兜底）。
   */
  const SITES = [
    {
      id: 'youtube',
      label: 'YouTube',
      filePrefix: 'YouTube',
      hostSuffixes: ['youtube.com', 'youtube-nocookie.com'],
      // 沿用原 content.js 候选顺序：新布局主视频 → 播放器容器 → 旧版容器兜底
      playerSelectors: [
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
      ],
    },
    {
      id: 'bilibili',
      label: 'Bilibili',
      labelZh: '哔哩哔哩（B 站）',
      filePrefix: 'Bilibili',
      hostSuffixes: ['bilibili.com'],
      // 同时覆盖新版 bpx 播放器（.bpx-player-*）与旧版 bilibili 播放器（.bilibili-player-*），
      // 顺序同原实现：新版视频区/容器 → 旧版 video/容器 → 播放器外壳容器
      playerSelectors: [
        '#bilibili-player video',
        '.bpx-player-video-wrap video',
        '.bpx-player-video-area video',
        '.bpx-player-video video',
        '.bpx-player-container video',
        '#bilibili-player .bpx-player-video-area',
        '.bilibili-player-video-wrap video',
        '.bilibili-player-video video',
        '.bilibili-player-video-real',
        '#bilibili-player .bilibili-player-video',
        '#bilibili-player',
        '.bpx-player-video-wrap',
        '.bilibili-player-video-wrap',
      ],
    },
    {
      id: 'dailymotion',
      label: 'Dailymotion',
      filePrefix: 'Dailymotion',
      hostSuffixes: ['dailymotion.com'],
      // DM 官网视频播放页（www.dailymotion.com/video/…）的 neon player 会把真实 <video>
      // 直接渲染进主文档（曾见于 #player-wrapper / #player 等容器，video 标签自身有无
      // class 都能命中）。以下按「播放器容器内 video」多路覆盖；若改版后把 <video> 移入
      // 跨域 iframe 或 shadow DOM（主文档读不到），由下方 containerSelectors 依次收尾。
      playerSelectors: [
        '#player-wrapper video',
        '.player-wrapper video',
        '#player video',
        '.dmp_Video',
        '.dmp_video',
        '.dmp-player video',
        '[class*="Player"] video',
      ],
      containerSelectors: [
        '#player-wrapper',
        '.player-wrapper',
        '[class*="Player__player"]',
        '[class*="TopPlayer__player"]',
        '[class*="TopPlayer__placeholder"]',
        '[class*="PlayerPlaceholder"]',
        '[class*="Player__body"]',
      ],
    },
    {
      id: 'vimeo',
      label: 'Vimeo',
      filePrefix: 'Vimeo',
      hostSuffixes: ['vimeo.com'],
      // Vimeo 官网播放页（vimeo.com/…）把真实 <video> 渲染进主文档，播放器自身的 CSS
      // 命名空间为 .vp-*（.vp-video / .vp-video-wrapper / .vp-player / .vp-player-layout
      // 等，具体类名随播放器版本变化），历史容器还见过 .video-player / .vimeo-player。
      // 个别版本把 <video> 放进 open shadow DOM 时由通用 `video` 兜底收尾；外壳容器
      // 在下方 containerSelectors。
      playerSelectors: [
        '.vp-video video',
        '.vp-video-wrapper video',
        '.vp-player video',
        '.vp-player-layout video',
        '.video-player video',
        '.vimeo-player video',
      ],
      containerSelectors: [
        '.vp-player-layout',
        '.vp-player',
        '.vp-video',
        '.video-player',
        '.vimeo-player',
      ],
    },
    {
      id: 'instagram',
      label: 'Instagram',
      filePrefix: 'Instagram',
      hostSuffixes: ['instagram.com'],
      // 无稳定外壳类名：只用共享语义 / 角色容器；主页 Feed 一次性渲染多条视频时，
      // 「当前在播的那条」交由通用 `video` 兜底按「可见面积最大的已解码 video」命中
      playerSelectors: IG_FB_TT_SEMANTIC.slice(),
    },
    {
      id: 'facebook',
      label: 'Facebook',
      filePrefix: 'Facebook',
      hostSuffixes: ['facebook.com'],
      // 与 Instagram 同型（无稳定 class），先共享语义容器；再补 Facebook 特有承载：
      // Watch / 单视频页主 video 的外层容器带 data-video-id（内部即唯一主 video）
      playerSelectors: IG_FB_TT_SEMANTIC.concat(['[data-video-id] video']),
    },
    {
      id: 'tiktok',
      label: 'TikTok',
      filePrefix: 'TikTok',
      hostSuffixes: ['tiktok.com'],
      // 与 IG / FB 同型（外壳 hash class），先共享语义容器；再补 TikTok 特有承载：
      // 播放器带语义属性 data-e2e="video-player"（历史布局还见过 .video-player 类）
      playerSelectors: IG_FB_TT_SEMANTIC.concat([
        '[data-e2e="video-player"] video',
        '[data-e2e="video-player-basic"] video',
        '.video-player video',
        '[data-e2e="video-player"]',
      ]),
    },
  ];

  /** 通用尾兜底：content.js / countdown.js 的探测序列末尾统一追加的裸 `video` 哨兵 */
  const GENERIC_FALLBACK_SELECTOR = 'video';

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

  /** 当前页面所属站点定义（content script 上下文使用；识别失败返回 null） */
  function detectCurrent() {
    return detectByHost(window && window.location ? window.location.hostname : '');
  }

  /** 站点 id → 展示名（未命中退回通用「视频」名） */
  function labelOf(siteId) {
    const site = siteById(siteId);
    return site ? site.labelZh || site.label : '视频';
  }

  /** 站点 id → 站点定义（注册表遍历；未命中返回 null） */
  function siteById(id) {
    for (const site of SITES) {
      if (site.id === id) return site;
    }
    return null;
  }

  /**
   * 某站点的完整播放器探测序列 = 站点自身候选 + 通用尾兜底 `video`。
   * content.js 会对裸 `video` 哨兵特殊处理为「取可见面积最大的已解码 video」
   * （而非 querySelector 的第一个），因此它必须位于探测序列最末。
   */
  function probeSelectorsOf(siteOrId) {
    const site = typeof siteOrId === 'string' ? siteById(siteOrId) : siteOrId;
    const list = site && Array.isArray(site.playerSelectors) ? site.playerSelectors.slice() : [];
    list.push(GENERIC_FALLBACK_SELECTOR);
    return list;
  }

  /** 某站点的容器级兜底候选（无则返回空数组） */
  function containerSelectorsOf(siteOrId) {
    const site = typeof siteOrId === 'string' ? siteById(siteOrId) : siteOrId;
    return site && Array.isArray(site.containerSelectors) ? site.containerSelectors.slice() : [];
  }

  window.YRSites = {
    SITES,
    GENERIC_FALLBACK_SELECTOR,
    hostOfUrl,
    detectByHost,
    detectByUrl,
    detectCurrent,
    labelOf,
    siteById,
    probeSelectorsOf,
    containerSelectorsOf,
  };
})();
