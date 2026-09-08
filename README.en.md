# YouTube Recorder

<div align="center">
  <a href="README.md">简体中文</a> ·
  <b>English</b> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.it.md">Italiano</a>
</div>

A Chrome Manifest V3 browser extension: on the video page of a supported site — **YouTube, Bilibili, Dailymotion, Vimeo, Instagram, Facebook, TikTok** — a **manual click** starts recording. It captures the full surface of the current tab plus its page audio, crops the player's **true painted picture area (or any region you drag-select)** frame by frame with Canvas inside the browser, and finally exports a **video file with audio** and downloads it locally — natively preferring **MP4 (H.264/AAC)**, automatically falling back to **WebM** when the browser or OS cannot provide it.

The site to record is recognized automatically: the extension detects the site from the current page's domain and switches the output filename prefix and the site label in the popup / notifications accordingly (see "Supported sites" below).

## Features

- **Record one site out of seven major video platforms**: native video pages of YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok all share the same pipeline (tabCapture → locate player → Canvas crop → MediaRecorder). The current site is auto-detected and switches the filename prefix and site copy; differences between old and new player layouts on each site are consolidated in `src/shared/sites.js`, maintained in one place (see "Supported sites" below).
- **Zero third-party dependencies**: no npm, no build step, no ffmpeg, no re-encoding at all (MP4 is recorded natively by `MediaRecorder`, never converted afterwards).
- **Two recording modes**
  - **Full player**: automatically locates the player's *true painted* rectangle (computed from `object-fit` / `object-position`, so letterboxing, theatre-mode padding and player chrome are excluded).
  - **Region select**: drag a rectangle anywhere on the page and record only that area.
- **Absolutely clean output**: every control lives in the extension icon popup (a separate extension page that is not part of the captured tab's rendering), so no extension UI can ever appear in the video.
- **Page hotkey**: the default single key `R` starts recording when idle and stops/saves while recording. Change it freely in the popup → **Settings** (`Ctrl` / `Alt` / `Shift` / `Command` combinations supported). It only works on supported video pages, never steals keys from other tabs, and never conflicts with global browser shortcuts.
- **Page locked while recording**: a translucent mask covers everything *outside* the picture with a "hole" cut out for it, blocking scrolling, clicks and destructive shortcuts — while **play/pause, seeking, volume, subtitles and playback speed remain fully usable**.
- **Stable cropping**: fixed 30 fps output; the canvas size is locked on the first frame; the crop rectangle must stay stable for 3 consecutive frames before recording starts, so transient oversized rectangles (ads, theatre-mode transitions) never end up in the finished video.
- **Audio is never lost**: the captured audio track is played back through an `AudioContext`, preventing the tab from being muted and producing a silent recording.
- **"Recording" stays visible even in fullscreen**: when playing fullscreen the picture fills the screen and the mask hint has nowhere to go, so the state is shown by a persistent system notification plus an always-on-top Document PiP window (REC + timer + stop button); when the picture has black bars, a thin red border is also drawn inside them. All indicators sit outside the captured picture and **never enter the video**; each can be toggled individually in the popup under **Settings → Fullscreen recording status**.
- **Robust fallbacks**: DRM black-frame detection, automatic stop-and-export when you switch tabs or navigate away, self-healing when the rectangle heartbeat stalls, automatic download retry, and a "Force reset and restart" escape hatch for stuck sessions.
- **Recording is only ever triggered by a user click** — no silent background capture, ever.

## Supported sites

The recording pipeline (tabCapture → locate player → Canvas crop → MediaRecorder) is identical on every site; only three things differ: the **injection domains** (`content_scripts.matches` in `manifest.json`), the **DOM selectors** used to locate the player, and the **site name** used in the filename prefix / copy. The table below lists the currently supported sites and their applicable pages:

| Site | Recordable page forms | Notes and limitations |
| --- | --- | --- |
| YouTube | Video pages (`youtube.com/watch…`, Shorts, etc.) | Members-only / paid / DRM sources render black (browser protection; see general limitations below) |
| Bilibili | Video pages (`bilibili.com/video/BV…`) | Both the new bpx and the legacy bilibili players are covered; shows and films under membership / DRM may render black; **livestreams are not supported** |
| Dailymotion | Video pages (`dailymotion.com/video/…`) | When the player `<video>` is wrapped in a cross-origin iframe / shadow DOM (unreadable from the main document), it falls back to locating the player shell container rectangle |
| Vimeo | Video pages (`vimeo.com/…`) | Private videos require being logged in and having viewing permission |
| Instagram | Posts / Reels / Stories (opened modal view), single videos in the home feed | Some content only has a playable video after logging in |
| Facebook | Watch / Reels / single-video overlays / videos in the timeline | Some content requires login; when several videos share the timeline, the "currently visible main video" is hit automatically |
| TikTok | Video detail pages (`tiktok.com/@…/video/…`), opened video overlays, single items in the For You feed | When several previews share the feed, the one "currently playing / with the largest visible area" is hit automatically |

> **Locating mechanism**: the content script locates the recording region by the *actually visible* `<video>` on the page. `src/shared/sites.js` centrally maintains the player container / video candidate selectors for old and new layouts of every site; once a container is hit, its inner `<video>` is taken and the real painted picture rectangle is derived from `object-fit` / `object-position` (removing black bars, chrome and padding). If all candidates miss, a generic fallback picks the "decoded `<video>` with the largest visible area" (recursively covering open shadow DOM). Therefore the main player must render its real `<video>` into the page's main document (or a readable open shadow root) — **players embedded from other pages through cross-origin iframes are not supported**; pure canvas / WebGL or other non-`<video>` self-painted surfaces cannot be auto-located — use **Region select** instead.

> **General limitations**:
> - Videos protected by DRM / paid membership (paid movies, subscription exclusives, exclusive licensed content on each platform) render black in the capture — a browser "protected content" restriction, not an extension defect;
> - For content that requires login (most videos on Instagram / Facebook / TikTok, some Bilibili shows, etc.) please log in to the corresponding site in the browser first;
> - If selectors drift after a site redesign and several visible `<video>`s share the screen, the recording region defaults to the one with the largest visible area that is decoding — keep the target video playing inside the viewport.

## Project layout

```
DESIGN.md                    Technical design doc (capabilities / architecture / message protocol / edge cases / data flow)
TODO.md                      Development task list (check off during acceptance)
src/
├── manifest.json            MV3 manifest (tabCapture + downloads + activeTab + offscreen + storage + notifications)
├── background.js            Service Worker: offscreen lifecycle, message routing, global state & badge, system notifications, download proxy
├── offscreen.html           Offscreen document host
├── offscreen.js             Recording core: getUserMedia(tab stream) → hidden video → canvas crop → MediaRecorder → Blob
├── shared/
│   ├── hotkey.js            Shared definition of the "start / stop recording" hotkey (popup settings, popup hint, content listener)
│   ├── indicator.js         Read/write of the three fullscreen recording-status switches (pip / notif / border) (popup / content / guard)
│   ├── countdown.js         Shared definition & read/write of the "countdown before recording starts" seconds (popup / content / background)
│   └── sites.js             Supported-site recognition (YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok)
│                           plus per-site player candidate selectors (content / popup / countdown)
├── content/
│   ├── guard.js             Page lock mask used during recording (hole cut to the picture rect) + fullscreen black-bar red border
│   ├── pip.js               Fullscreen Document PiP always-on-top status window (REC + timer + stop button)
│   ├── selector.js          Region-select overlay (enabled on demand after clicking "Region record")
│   ├── countdown.js         "Countdown before recording starts" page overlay (overlay first, capture second)
│   ├── content.js           Headless script: player rect heartbeat + page hidden/navigation notices + mask toggle
│   └── hotkey.js            Page-level "start / stop recording" hotkey listener
├── popup.html               Extension icon popup: recording console (start / region / stop / status / timer / hints / settings)
├── popup.js
├── popup/
│   └── settings.js          Settings modal (hotkey, countdown before start, fullscreen recording-status switches)
├── assets/                  Static assets
├── icons/                   16/32/48/128 icons
└── types/                   chrome.* API type declarations (types only)
scripts/verify_extension.py  Static self-check script
```

## Why an offscreen document?

`chrome.tabCapture` cannot be called from a content script, while the `video` / `canvas` / `MediaRecorder` pipeline requires a DOM window context. A popup closes as soon as it loses focus and a Service Worker has no DOM at all, so the recording core lives in an **offscreen document**:

1. The **content script** (injects no UI of its own; it only reports data) locates the player on the supported page (recognized by `shared/sites.js`) every ~120 ms and reports the true picture rectangle plus the viewport basis (CSS size, `devicePixelRatio`, visual-viewport offset).
2. **background** creates the offscreen document on demand and calls `chrome.tabCapture.getMediaStreamId()` inside the user-gesture chain to obtain a `streamId`.
3. The **offscreen document** consumes the full-tab stream via `getUserMedia({ chromeMediaSourceId: streamId })` (video + page audio).
4. Inside **offscreen**: hidden `video` plays the tab stream → hidden `canvas` crops it frame by frame with `drawImage` → `canvas.captureStream(30)` video track merged with the original `audioTrack` → `MediaRecorder` records (`video/mp4` first, progressively falling back to `video/webm`) → chunks are assembled into a Blob.
   - Coordinate mapping uses a **measured ratio** ("captured frame size ÷ viewport CSS size", with a contain model and centered padding) instead of a naive `rect × devicePixelRatio`, which eliminates drift on HiDPI displays and zoomed pages.
5. The offscreen document **cannot** call `chrome.downloads` directly, so it sends `DOWNLOAD_FILE` to **background**, which performs the download and reports the result via `downloads.onChanged`.

See `DESIGN.md` for details.

## Load it (development)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the `src/` directory of this repository (no build step, nothing to compile).

> Requires Chrome ≥ 116 (`minimum_chrome_version`, needed for `chrome.offscreen`); native MP4 output requires Chrome ≥ 126. Latest stable is recommended.

## Usage

1. Open a video page of any supported site (see "Supported sites" above — e.g. a YouTube watch page, a Bilibili `video/BV…` page, a TikTok video detail page; refresh once on first visit so the scripts get injected). Keep the video playing normally — DRM / paid videos render black, a browser protection restriction.
2. Click the extension icon → click **Start recording** in the popup (keep the tab visible and the player fully inside the viewport).
   - If the browser / OS cannot produce native MP4 (Chrome < 126, or missing H.264/AAC encoders), the popup explains that this session falls back to WebM.
   - While recording, the icon shows a red `REC` badge. Closing the popup does not stop recording — just click the icon again.
3. **Region record** (optional): click **Region record** → the popup closes → drag a rectangle on the page → click **Record selection** (press `Esc` to leave the selector).
   - While recording, the **Stop** button is automatically placed *outside* the selection so it can never be cropped into the video. If the selection nearly fills the viewport and no room is left, on-page controls are hidden — stop from the extension popup or with the hotkey.
4. Click **Stop and save** → the file is assembled and downloaded as `Site-YYYYMMDD-HHMMSS.mp4` (the prefix switches with the site, e.g. `YouTube-20240908-153000.mp4`, `Bilibili-20240908-153000.mp4`; `.webm` on fallback environments).
5. **Hotkey**: press the default `R` on a supported video page to start recording; press it again to stop and save.
   - Click **Settings** in the popup's top-right corner to change it: click the key box and press the new combination, `Esc` cancels. Changes apply immediately, no page reload needed.
   - The hotkey only fires when a supported video page has focus and never triggers inside inputs such as the search or comment box. Conflicts with browser or player shortcuts are flagged in the settings panel.
6. **Crop calibration** (collapsible section at the bottom of the popup): on rare setups (unusual zoom combinations, mixed-DPI monitors) the crop may still be slightly off — enter vertical / horizontal pixel offsets to shift the crop box (positive = down / right).
7. **The page is locked by a mask while recording** (full-player mode):
   - Everything outside the picture is covered by translucent black: buttons and links are unclickable, wheel and touch scrolling are blocked, and the scroll position is pinned.
   - **Allowed**: play/pause, seeking, volume, subtitles, playback speed — anything that is pure playback control.
   - **Blocked**: scroll/page keys (Space, PageUp/PageDown, Home/End, Up/Down arrows), fullscreen `f`, theatre `t`, miniplayer `i`, mute `m`, and double-clicking the picture — these change layout or silence the audio track.
   - The mask has a hole cut out for the picture, so it covers nothing that is being recorded and therefore **never appears in the output**; a "Recording · page locked" hint is shown below the picture (above it when space is tight).
   - Resizing the browser window cannot be prevented by a web page: when a viewport change is detected, the mask shows a warning and the popup suggests re-recording (the crop may have drifted).
8. After stopping, the mask is removed automatically and the page returns to normal with no leftover nodes or listeners.

### Output formats

| Environment | Output |
| --- | --- |
| Chrome ≥ 126 with H.264/AAC encoders (e.g. recent Chrome on Windows / macOS) | **MP4** (H.264 + AAC, `.mp4`) |
| Chrome < 126 | WebM (`.webm`) — the popup explains why |
| Chrome ≥ 126 but platform lacks encoders (some Linux builds) | WebM (`.webm`) — the popup explains why |

> No re-encoding is ever performed: when MP4 is available it is recorded natively by `MediaRecorder` (instant, lossless); otherwise the extension falls back to WebM.

### Permissions

| Permission | Purpose |
| --- | --- |
| `tabCapture` | Restricted permission; captures the current tab's picture and audio after a user click |
| `downloads` | Saves the recording to the local downloads folder |
| `activeTab` | Temporary access to the current tab granted when you click the extension icon |
| `offscreen` | Creates the offscreen document that hosts capture / crop / recording |
| `storage` | `session` keeps recording state and the start intent; `sync` keeps the hotkey, crop calibration and fullscreen recording-status switches |
| `notifications` | Fullscreen recording indicator: a persistent "Recording" notification during recording (with a button to stop) + a one-shot save success / failure receipt (can be disabled in settings) |

No `host_permissions`, no network requests, no user data collection; the content script is injected only under the seven supported-site domains listed in `content_scripts.matches` — other sites get no script injection and no action of any kind.

## Static self-check

```bash
python3 scripts/verify_extension.py
```

Covers: manifest / MV3 / required files, domain restriction and injection order for the supported sites (YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok) (`shared/hotkey.js` → `shared/indicator.js` → `shared/sites.js` → `content/guard.js` → `content/pip.js` → `content/selector.js` → `content/countdown.js` → `content/content.js` → `content/hotkey.js`), minimal permissions, zero third-party dependencies, JS syntax of every file (`node --check`), API context boundaries (content scripts must not call `tabCapture` / `downloads` / `offscreen` directly), page-injection boundaries (controls must live in the extension popup; `content/guard.js` is the only module allowed to create DOM, and it must cut a hole for the picture, leave the hole empty, and be removable per session), and hotkey-module boundaries.

## Manual acceptance checklist (task 20 in `TODO.md`)

Verify each item below after following the "Load + Usage" steps above. **Multi-site part**: besides YouTube, run the full "start → stop and save" flow on at least two more newly supported sites (e.g. Bilibili, TikTok), and confirm the popup / notifications show the right site name, the output file uses the matching prefix (e.g. `Bilibili-*.mp4`), and the picture contains only that site's player area without drift. In the items below, "video page" always means a video page of a supported site:

- [ ] 20.1 The popup opens correctly: status / timer / buttons change with the recording phase; the icon shows a red `REC` badge while recording.
- [ ] 20.2 Click **Start recording** → capture succeeds (status "Recording" + running timer) → click **Stop and save** → an mp4 file is downloaded (on environments without native MP4, the popup warns and a webm is downloaded).
- [ ] 20.3 Open the output with a system player / Chrome: the picture is the cropped player area, audio is present, playback works.
- [ ] 20.4 On HiDPI screens (DPR ≠ 1, e.g. Retina) the picture is not shifted or misaligned.
- [ ] 20.5 Switching tabs while recording: the popup warns that capture may break; returning resumes or auto-stops and exports without errors.
- [ ] 20.6 Toggling fullscreen / browser zoom while recording: the crop area follows correctly.
- [ ] 20.7 Error cases report correctly: non-video page (start button disabled), DRM video (warning in the popup after ~2.6 s), capture denied, etc.
- [ ] 20.8 After recording ends (including errors): no recording dot in the address bar, no leftover extension nodes, no repeated errors.
- [ ] 20.9 On Chrome < 126 or platforms without H.264/AAC: the popup says "native MP4 unsupported, WebM will be produced" and recording still works.
- [ ] 20.10 The output contains no extension controls (no buttons / modals / toast overlays).
- [ ] 20.11 The output contains no lock mask (no dark edges, no hint text).
- [ ] 20.12 While recording the page is locked by the mask: buttons / links are unclickable and wheel + shortcuts do nothing, the page does not scroll; playback controls (play/pause, seek, volume) still work.
- [ ] 20.13 Resizing the window while recording: the mask warns, the popup is notified, and the mask re-cuts its hole without covering the picture.
- [ ] 20.14 After stop-and-save the mask disappears, the page is interactive again, and no `yr-guard-` nodes remain.
- [ ] 20.15 Region record: drag a selection → **Record selection** → the output contains only the selected area and no on-page buttons such as Start / Stop.
- [ ] 20.16 Starting recording in fullscreen via the hotkey: the always-on-top Document PiP window appears and counts up, its **Stop and save** button works, and the PiP window never appears in the output.
- [ ] 20.17 Fullscreen-recording a source with black bars (e.g. 21:9 / vertical): a thin red border appears inside the bars and the finished picture contains no red border; bar-free full-bleed sources automatically have no red border.
- [ ] 20.18 A system notification stays during recording and can stop it via its button; a one-shot result notification appears after saving; the notification and the PiP window both disappear afterwards.
- [ ] 20.19 Turning off all three items of **Fullscreen recording status** in Settings: no PiP / notification / red border, and the rest of the recording features are unaffected.

Once everything passes, check off the items of task 20 in `TODO.md`.
