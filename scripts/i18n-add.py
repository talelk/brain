#!/usr/bin/env python3
"""Append message keys to the three catalogues at once.

Usage: python3 scripts/i18n-add.py keys.json
keys.json maps a key to [english, french, arabic]. Keys that already exist are an error, so a
message is written once, in all three languages, in the same commit (the catalogue test checks it).
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1] / "apps" / "web" / "src" / "i18n"
MARK = "  // @@END"


def main() -> None:
    keys = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    texts = {lang: (ROOT / f"{lang}.ts").read_text(encoding="utf-8") for lang in ("en", "fr", "ar")}
    extra = ("_zero", "_two", "_few", "_many")  # plural categories only Arabic needs; English and French use one/other
    for key in keys:
        if not key.endswith(extra) and f'  "{key}":' in texts["en"]:
            raise SystemExit(f"duplicate key {key}")
    for index, lang in enumerate(("en", "fr", "ar")):
        lines = "".join(f'  {json.dumps(key)}: {json.dumps(values[index], ensure_ascii=False)},\n' for key, values in keys.items() if lang == "ar" or not key.endswith(extra))
        text = texts[lang]
        assert MARK in text, lang
        (ROOT / f"{lang}.ts").write_text(text.replace(MARK, lines + MARK), encoding="utf-8")
    print(f"added {len(keys)} keys")


main()
