#!/usr/bin/env python3
"""Патчит сгенерированный `cap add android` проект: целевой API 36, разрешения, версия, иконки.
Запускается в CI из папки android-app после `npx cap add android`."""
import os, re, sys
from pathlib import Path

root = Path(__file__).resolve().parent
repo = root.parent
android = root / "android"

# 1) целевой и компилируемый уровень API: не ниже 36 (требование Google Play для новых приложений)
vg = android / "variables.gradle"
txt = vg.read_text()
def bump(name, minimum):
    global txt
    m = re.search(r"(%s\s*=\s*)(\d+)" % name, txt)
    if m and int(m.group(2)) < minimum:
        txt = txt[:m.start(2)] + str(minimum) + txt[m.end(2):]
    print(name, "=", re.search(r"%s\s*=\s*(\d+)" % name, txt).group(1))
bump("compileSdkVersion", 36)
bump("targetSdkVersion", 36)
vg.write_text(txt)

# 2) разрешения: геолокация (кнопка «Найти меня»)
mf = android / "app/src/main/AndroidManifest.xml"
m = mf.read_text()
perms = ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"]
for p in perms:
    if p not in m:
        m = m.replace("</manifest>", '    <uses-permission android:name="%s" />\n</manifest>' % p)
mf.write_text(m)

# 3) версия приложения: versionCode растёт с каждой сборкой, versionName из файла VERSION
bg = android / "app/build.gradle"
g = bg.read_text()
code = os.environ.get("VERSION_CODE", "1")
name = (root / "VERSION").read_text().strip() if (root / "VERSION").exists() else "1.0.0"
g = re.sub(r"versionCode\s+\d+", "versionCode " + code, g)
g = re.sub(r'versionName\s+"[^"]*"', 'versionName "%s"' % name, g)
bg.write_text(g)
print("versionCode", code, "versionName", name)

# 4) иконки из PNG сайта: старые квадратные значки для всех плотностей
from PIL import Image
res = android / "app/src/main/res"
sizes = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
src = Image.open(repo / "icon-512.png").convert("RGBA")
for d, s in sizes.items():
    out = res / ("mipmap-" + d)
    out.mkdir(parents=True, exist_ok=True)
    img = src.resize((s, s), Image.LANCZOS)
    for fn in ("ic_launcher.png", "ic_launcher_round.png"):
        img.save(out / fn)
# адаптивные иконки: foreground из maskable-иконки, фон тёмный (как у приложения)
fg = Image.open(repo / "icon-maskable-512.png").convert("RGBA")
fsizes = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
for d, s in fsizes.items():
    fg.resize((s, s), Image.LANCZOS).save(res / ("mipmap-" + d) / "ic_launcher_foreground.png")
any26 = res / "mipmap-anydpi-v26"
any26.mkdir(parents=True, exist_ok=True)
adaptive = '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n'
(any26 / "ic_launcher.xml").write_text(adaptive)
(any26 / "ic_launcher_round.xml").write_text(adaptive)
vals = res / "values"
vals.mkdir(parents=True, exist_ok=True)
(vals / "ic_launcher_background.xml").write_text('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#14171C</color>\n</resources>\n')
# старый векторный foreground шаблона убираем, чтобы не конфликтовал с PNG
for p in res.glob("drawable*/ic_launcher_foreground.xml"):
    p.unlink()
print("icons done")
