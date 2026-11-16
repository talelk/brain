#!/usr/bin/env python3
"""List message keys the web app uses (t("..."), tn("..."), `"key": "..."` in typed maps) that en.ts does not define yet."""
import pathlib
import re

SRC = pathlib.Path(__file__).resolve().parents[1] / "apps" / "web" / "src"
en = (SRC / "i18n" / "en.ts").read_text(encoding="utf-8")
defined = set(re.findall(r'^\s*"([^"]+)":', en, re.M))
used: dict[str, str] = {}
for path in SRC.rglob("*.ts*"):
    if "i18n" in path.parts:
        continue
    text = path.read_text(encoding="utf-8")
    for key in re.findall(r'\bt\(\s*"([a-zA-Z0-9_.-]+)"', text):
        used.setdefault(key, str(path.relative_to(SRC)))
    for base in re.findall(r'\btn\(\s*"([a-zA-Z0-9_.-]+)"', text):
        for suffix in ("one", "other"):
            used.setdefault(f"{base}_{suffix}", str(path.relative_to(SRC)))
    for key in re.findall(r'"((?:nav|shell|live|decision|today|start|working|result|attempts|state|common|wait|setup|first)\.[a-zA-Z0-9_.-]+)"', text):
        used.setdefault(key, str(path.relative_to(SRC)))
for key in sorted(used):
    if key not in defined:
        print(key, "<-", used[key])
