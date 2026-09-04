#!/usr/bin/env python3
"""
YouTube Recorder 扩展静态自检（任务 20 的自动化部分）。

用法：
    python3 scripts/verify_extension.py

检查项：
  1. manifest.json 为合法 MV3，必需文件全部存在（含图标 / popup / offscreen / content）。
  2. content_scripts 仅匹配 YouTube 域名，且 ui.js 先于 content.js 注入。
  3. 权限最小集：tabCapture + downloads + activeTab + offscreen。
  4. 零第三方依赖：HTML 不引用 http(s) 外部资源；无 npm 工程文件。
  5. 全部 JS 通过 node --check 语法校验。
  6. 架构边界：content script 中不得出现 tabCapture/downloads/offscreen API
     （它们只允许出现在 background / offscreen）；capture 调用必须位于 offscreen。
  7. content UI 类名 / 注入样式选择器统一携带 yr-recorder- 前缀（抽查）。
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

print("== 2. content_scripts 限定 YouTube ==")
check(bool(cs), "存在 content_scripts 配置")
if cs:
    matches = cs.get("matches", [])
    check(
        bool(matches) and all(("youtube.com" in m) for m in matches),
        "matches 仅限 youtube.com",
        str(matches),
    )
    js = cs.get("js", [])
    check(js == ["content/ui.js", "content/content.js"], "注入顺序：ui.js → content.js", str(js))
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
def read(rel):
    with open(os.path.join(SRC, rel), encoding="utf-8") as f:
        return f.read()

content_src = read("content/content.js") + read("content/ui.js")
check("chrome.tabCapture" not in content_src, "content script 不直接调用 tabCapture")
check("chrome.downloads" not in content_src, "content script 不直接调用 downloads")
check("chrome.offscreen" not in content_src, "content script 不直接调用 offscreen")
offscreen_src = read("offscreen.js")
bg = read("background.js")
check("chrome.tabCapture.getMediaStreamId" in bg, "background 负责申请 tabCapture streamId")
check("chromeMediaSourceId" in offscreen_src, "offscreen 使用 streamId 消费标签页流")
check("chrome.downloads.download" in offscreen_src, "downloads.download 位于 offscreen")
check("chrome.offscreen.createDocument" in bg, "offscreen 生命周期由 background 管理")

print("== 7. content UI 前缀抽查 ==")
text = read("content/ui.js")
cls_assigns = re.findall(r"(?:className|el\('[^']*',\s*)\s*'([^']*)'", text)
bad_cls = [c for c in cls_assigns if c and not c.startswith("yr-recorder-") and c not in ("yr-recorder-state-text",)]
# 组合类中的每个 token 都须带前缀
def tokens_ok(c):
    return all(t.startswith("yr-recorder-") for t in c.split())
bad_cls = [c for c in cls_assigns if c and not tokens_ok(c)]
check(not bad_cls, "UI 元素类名均为 yr-recorder- 前缀", "bad=" + str(bad_cls[:3]))
style_block = text[text.find("CSS_TEXT") :]
# 注入 CSS 中不允许出现裸标签选择器（如 "button {" / "body {"/ "div {")
for sel in re.findall(r"(?m)^([A-Za-z][A-Za-z0-9]*(?:\s*\{))", style_block):
    bad = re.findall(r"^(?:html|body|div|span|button|video|canvas)\s*\{", sel)
check(not re.search(r"(?m)^(html|body|div|span|button|video|canvas)\s*\{", style_block), "注入 CSS 无裸标签选择器")

print()
if errors:
    print("RESULT: FAIL (%d 项未通过)" % len(errors))
    sys.exit(1)
print("RESULT: PASS" + ("（含 %d 条警告）" % len(warnings) if warnings else ""))
