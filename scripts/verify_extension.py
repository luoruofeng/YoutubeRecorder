#!/usr/bin/env python3
"""
YouTube Recorder 扩展静态自检（任务 20 的自动化部分）。

用法：
    python3 scripts/verify_extension.py

检查项：
  1. manifest.json 为合法 MV3，必需文件全部存在（含图标 / popup / offscreen / content）。
  2. content_scripts 仅匹配支持的站点域名（YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok）。
  3. 权限最小集：tabCapture + downloads + activeTab + offscreen。
  4. 零第三方依赖：HTML 不引用 http(s) 外部资源；无 npm 工程文件。
  5. 全部 JS 通过 node --check 语法校验。
  6. 架构边界：content script 中不得出现 tabCapture/downloads/offscreen API
     （它们只允许出现在 background / offscreen）；capture 调用必须位于 offscreen。
  7. 页面注入边界：tabCapture 捕获的是整个标签页的合成画面，控件必须位于扩展图标
     弹窗（popup）；content.js 只允许上报数据，不得创建可见 DOM；唯一允许在页面里
     创建 DOM 的是 content/guard.js —— 录制期交互锁定遮罩，且必须按播放器画面矩形
     挖洞（不覆盖被录画面）、仅在录制会话期间存在、结束即移除。
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
errors = []
warnings = []


def check(ok, name, detail=""):
    if ok:
        print("  [OK ] " + name)
    else:
        errors.append(name)
        print("  [FAIL] " + name + ("  " + detail if detail else ""))


def warn(name, detail=""):
    warnings.append(name)
    print("  [WARN] " + name + ("  " + detail if detail else ""))


print("== 1. manifest / MV3 / 必需文件 ==")
with open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as f:
    manifest = json.load(f)
check(manifest.get("manifest_version") == 3, "manifest_version == 3")

required = [
    manifest.get("background", {}).get("service_worker", "background.js"),
    manifest.get("action", {}).get("default_popup", "popup.html"),
]
cs = manifest.get("content_scripts", [{}])[0]
required += cs.get("js", [])
required += list(manifest.get("icons", {}).values())
required += ["offscreen.html", "offscreen.js", "popup.js", "background.js"]
for rel in sorted(set(required)):
    check(os.path.isfile(os.path.join(SRC, rel)), "文件存在: " + rel)
check(
    manifest.get("name") and manifest.get("version") and manifest.get("description"),
    "声明 name/version/description",
)

print("== 2. content_scripts 限定支持站点（YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok） ==")
check(bool(cs), "存在 content_scripts 配置")
if cs:
    matches = cs.get("matches", [])
    check(
        bool(matches)
        and all(
            (
                "youtube.com" in m
                or "bilibili.com" in m
                or "dailymotion.com" in m
                or "vimeo.com" in m
                or "instagram.com" in m
                or "facebook.com" in m
                or "tiktok.com" in m
            )
            for m in matches
        ),
        "matches 仅限 youtube.com / bilibili.com / dailymotion.com / vimeo.com / instagram.com / facebook.com / tiktok.com",
        str(matches),
    )
    js = cs.get("js", [])
    # 页面内脚本顺序：
    # shared/hotkey.js（快捷键定义，弹窗共用）→ shared/indicator.js（全屏录制状态
    # 指示三开关，阶段十）→ shared/sites.js（站点识别与各站点播放器选择器）→ content/guard.js（录制期锁定遮罩 + 全屏黑边红框）→ content/pip.js
    # （Document PiP 全屏置顶状态窗，阶段十）→ content/selector.js（框选录制选择器，
    # 仅用户点击「框选录制」时启用）→ content/countdown.js（开始前倒计时浮层，阶段十一）
    # → content/content.js（数据上报，自身零 DOM）→ content/hotkey.js（页面级快捷键监听）
    check(
        js
        == [
            "shared/hotkey.js",
            "shared/indicator.js",
            "shared/sites.js",
            "content/guard.js",
            "content/pip.js",
            "content/selector.js",
            "content/countdown.js",
            "content/content.js",
            "content/hotkey.js",
        ],
        "注入顺序：hotkey → indicator → sites → guard → pip → selector → countdown → content → content/hotkey",
        str(js),
    )
    check(cs.get("run_at") in ("document_idle", "document_start", "document_end"), "run_at 合理", str(cs.get("run_at")))

print("== 3. 最小权限集 ==")
perms = set(manifest.get("permissions", []))
need = {"tabCapture", "downloads", "activeTab", "offscreen"}
check(need <= perms, "必需权限齐备", "missing=" + str(need - perms))
extra = perms - need - {"storage", "tabs", "alarms", "notifications"}
if extra:
    warn("额外权限（确认必要）", str(extra))

print("== 4. 零第三方依赖 ==")
check(not os.path.exists(os.path.join(ROOT, "package.json")), "无 package.json / npm")
for html in ("popup.html", "offscreen.html"):
    p = os.path.join(SRC, html)
    if os.path.isfile(p):
        text = open(p, encoding="utf-8").read()
        check(
            not re.search(r'(src|href)\s*=\s*["\']https?://', text, re.I),
            html + " 无外部资源引用",
        )

print("== 5. JS 语法（node --check） ===")
js_files = []
for base, _, files in os.walk(SRC):
    for name in files:
        if name.endswith(".js"):
            js_files.append(os.path.join(base, name))
for jf in sorted(js_files):
    res = subprocess.run(["node", "--check", jf], capture_output=True, text=True)
    check(res.returncode == 0, "语法 OK: " + os.path.relpath(jf, SRC), (res.stderr or "").strip()[:200])

print("== 6. 架构边界（API 所在上下文） ==")
def strip_comments(src):
    """去掉块注释与行注释，避免注释中的 API 名称干扰架构边界检查。"""
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"(?m)//.*$", "", src)
    return src


def read(rel):
    p = os.path.join(SRC, rel)
    if not os.path.isfile(p):
        return ""  # 文件可安全删除（如已废弃的页面 UI 层）
    with open(p, encoding="utf-8") as f:
        return f.read()


content_src = strip_comments(
    read("content/content.js")
    + read("content/ui.js")
    + read("content/guard.js")
    + read("content/pip.js")
    + read("shared/indicator.js")
)
check("chrome.tabCapture" not in content_src, "content script 不直接调用 tabCapture")
check("chrome.downloads" not in content_src, "content script 不直接调用 downloads")
check("chrome.offscreen" not in content_src, "content script 不直接调用 offscreen")
offscreen_src = read("offscreen.js")
bg = read("background.js")
check("chrome.tabCapture.getMediaStreamId" in bg, "background 负责申请 tabCapture streamId")
check("chromeMediaSourceId" in offscreen_src, "offscreen 使用 streamId 消费标签页流")
check("chrome.downloads.download" in offscreen_src, "downloads.download 位于 offscreen")
check("chrome.offscreen.createDocument" in bg, "offscreen 生命周期由 background 管理")

print("== 7. 页面注入边界（控件不进入录制画面 / 遮罩不得覆盖画面） ==")
content_code = strip_comments(read("content/content.js"))
check(
    not re.search(r"document\.(body|documentElement|head)\.appendChild", content_code),
    "content.js 不向页面追加任何 DOM 节点",
)
check("createElement" not in content_code, "content.js 不创建元素（保持零注入）")
check("yr-recorder-" not in content_code, "content.js 不含 yr-recorder- UI 代码")
popup_html = read("popup.html")
check("yr-primary" in popup_html, "开始 / 停止控件位于扩展图标弹窗")

guard_code = strip_comments(read("content/guard.js"))
check("window.YRGuard" in guard_code, "guard.js 暴露 YRGuard（生命周期由 content.js 控制）")
check("function enable" in guard_code and "function disable" in guard_code, "遮罩可随会话启用 / 移除")
check(
    "hole" in guard_code and "HOLE_MARGIN_BASE" in guard_code,
    "遮罩按播放器画面矩形挖洞（不覆盖被录画面）",
)
check(
    "pointer-events:none" in guard_code,
    "遮罩根节点 pointer-events:none（洞内留空，不改变画面像素）",
)
check("removeEventListener" in guard_code, "结束时解绑全部页面监听")
check(
    "preventDefault" in guard_code,
    "拦截滚动 / 快捷键等页面交互",
)

print("== 8. 录制快捷键（页面级，配置在扩展弹窗） ==")
hotkey_code = strip_comments(read("content/hotkey.js"))
shared_hotkey = strip_comments(read("shared/hotkey.js"))
check("createElement" not in hotkey_code, "content/hotkey.js 不创建元素（保持零注入）")
check("window.YRHotkey" in shared_hotkey, "shared/hotkey.js 暴露 YRHotkey（popup 与 content 共用）")
check(
    "chrome.tabCapture" not in hotkey_code + shared_hotkey,
    "快捷键模块不直接调用 tabCapture（仍由 background 申请 streamId）",
)
settings_code = strip_comments(read("popup/settings.js"))
check("window.YRSettings" in settings_code, "popup/settings.js 暴露设置模态框接口")
check("yr-primary" in read("popup.html") and "yr-settings" in read("popup.html"), "弹窗含录制按钮与设置入口")
bg_code = read("background.js")
check("YR_HOTKEY" in bg_code, "background 处理页面快捷键（按状态切换开始 / 停止）")

print("== 9. 全屏录制状态指示（阶段十） ==")
pip_code = strip_comments(read("content/pip.js"))
ind_code = strip_comments(read("shared/indicator.js"))
check("window.YRPip" in pip_code, "content/pip.js 暴露 YRPip（全屏置顶状态窗）")
check("openIfFullscreen" in pip_code, "状态窗由页面快捷键（用户激活）驱动打开")
check("window.YRIndicator" in ind_code, "shared/indicator.js 暴露 YRIndicator（三个指示开关）")
check(
    "chrome.notifications" in bg_code,
    "background 使用系统通知（录制常驻 / 结果回执）",
)
check(
    any(("notifications" in p) for p in manifest.get("permissions", [])),
    "manifest 声明 notifications 权限",
)
check(
    "YR_PIP_STATE" in bg_code and "YR_PIP_STATE" in pip_code,
    "YR_PIP_STATE 广播链路（background → content 状态窗）",
)

print("== 10. 站点清单一致性（shared/sites.js 注册表为单一数据源） ==")
# sites.js 是纯浏览器脚本（IIFE 挂 window.YRSites），用 node 模拟 window 求值得到
# 站点注册表权威清单（id / filePrefix / hostSuffixes），再与各隔离上下文中的副本
# （offscreen 文件名前缀表、background 站点识别/文案函数、manifest 注入域名）逐项比对，
# 防止「新增站点只改了部分地方」造成静默漂移（如漏改 offscreen 后文件名退化为通用
# Video、漏改 background 后通知无站点名、漏改 manifest 后脚本根本不注入）。
def load_sites_registry():
    probe = (
        "global.window = global;"
        "eval(require('fs').readFileSync(process.argv[1], 'utf8'));"
        "const L = window.YRSites;"
        "if (!L || !Array.isArray(L.SITES)) { console.error('SITES 未暴露'); process.exit(2); }"
        "console.log(JSON.stringify(L.SITES.map(s => ({"
        "id: s.id, filePrefix: s.filePrefix || '', hosts: (s.hostSuffixes || [])}))))"
    )
    res = subprocess.run(
        ["node", "-e", probe, os.path.join(SRC, "shared", "sites.js")],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        return None, (res.stderr or res.stdout or "").strip()[:300]
    return json.loads(res.stdout), ""

registry, registry_err = load_sites_registry()
check(registry is not None, "shared/sites.js 可被 node 求值（读取注册表）", registry_err)
if registry is None:
    errors.append("sites.js 求值失败，跳过站点一致性断言")
else:
    ids = [s["id"] for s in registry]
    check(len(ids) == len(set(ids)), "注册表站点 id 无重复")
    all_hosts = {h for s in registry for h in s["hosts"]}
    check(
        all(bool(s["hosts"]) for s in registry),
        "注册表每条记录 hostSuffixes 非空（第 0 项为站点主域名）",
    )

    # 10.1 offscreen.js 输出文件名前缀表（每站点键与值都要一致）
    off_prefix_src = read("offscreen.js")
    prefix_m = re.search(r"SITE_FILE_PREFIX\s*=\s*\{([^}]*)\}", off_prefix_src)
    prefix_map = {}
    if prefix_m:
        prefix_map = dict(re.findall(r"([A-Za-z0-9_]+)\s*:\s*'([^']*)'", prefix_m.group(1)))
    check(
        set(prefix_map.keys()) == set(ids),
        "offscreen SITE_FILE_PREFIX 站点键与注册表一致",
        "offscreen=" + ",".join(sorted(prefix_map)) + " sites=" + ",".join(sorted(ids)),
    )
    for s in registry:
        check(
            prefix_map.get(s["id"]) == s["filePrefix"],
            "offscreen 前缀值一致: " + s["id"],
            "offscreen='" + str(prefix_map.get(s["id"])) + "' sites='" + s["filePrefix"] + "'",
        )

    # 10.2 background.js 站点识别 / 通知文案函数（截取函数体，避免全文其它 return 干扰）
    def func_body(src, fname):
        m = re.search(r"function %s\b[\s\S]*?\n  \}" % re.escape(fname), src)
        return m.group(0) if m else ""

    bg_src = read("background.js")
    detect_body = func_body(bg_src, "detectSiteFromUrl")
    name_body = func_body(bg_src, "siteNameForText")
    bg_tokens = set(re.findall(r"return\s+'([a-z0-9]+)'", detect_body)) | set(
        re.findall(r"siteId\s*===\s*'([a-z0-9]+)'", name_body)
    )
    check(
        bg_tokens == set(ids),
        "background 站点识别 / 文案函数与注册表一致",
        "bg=" + ",".join(sorted(bg_tokens)) + " sites=" + ",".join(sorted(ids)),
    )

    # 10.3 manifest content_scripts.matches 注入域名（必须含全部主域名、不得含未知域名）
    injected_hosts = set()
    for m in cs.get("matches", []):
        mm = re.match(r"\*://\*\.([^/]+)/\*", m)
        if mm:
            injected_hosts.add(mm.group(1))
    primary_hosts = {s["hosts"][0] for s in registry}
    check(
        primary_hosts <= injected_hosts,
        "manifest.matches 已注入全部站点主域名（hostSuffixes[0]）",
        "missing=" + ",".join(sorted(primary_hosts - injected_hosts)),
    )
    check(
        injected_hosts <= all_hosts,
        "manifest.matches 不含注册表之外的未知域名",
        "extra=" + ",".join(sorted(injected_hosts - all_hosts)),
    )

print()
if errors:
    print("RESULT: FAIL (%d 项未通过)" % len(errors))
    sys.exit(1)
print("RESULT: PASS" + ("（含 %d 条警告）" % len(warnings) if warnings else ""))
