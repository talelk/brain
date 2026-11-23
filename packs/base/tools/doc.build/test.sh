#!/usr/bin/env bash
set -euo pipefail
# Proves run.sh on temporary folders: no network and nothing outside them. It needs pandoc and, for
# the PDF, soffice; where one is absent the check is skipped with a message (the sandbox image has both).

here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v pandoc >/dev/null; then echo "doc.build: skipped (pandoc is not installed here)"; exit 0; fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/work" "$tmp/out"
printf '# Report\n\n## First\n\n- one\n- two\n\n## Second\n\nمرحبا بالعالم\n' >"$tmp/work/a.md"

DOC_BUILD_WORK="$tmp/work" DOC_BUILD_OUT="$tmp/out" HAVE_SOFFICE="$(command -v soffice || true)" python3 - "$here/run.sh" "$tmp" <<'CHECKS'
import json, os, subprocess, sys, zipfile

script, tmp = sys.argv[1], sys.argv[2]

def run(payload):
    r = subprocess.run(["bash", script], input=payload if isinstance(payload, str) else json.dumps(payload), capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout)

src = tmp + "/work/a.md"
code, out = run({"source": src, "format": "docx", "name": "sub/dir/a.docx"})
assert code == 0 and out["path"] == "/out/sub/dir/a.docx" and zipfile.is_zipfile(tmp + "/out/sub/dir/a.docx"), out
code, out = run({"source": src, "format": "pptx"})
assert code == 0 and out["path"] == "/out/a.pptx", out
with zipfile.ZipFile(tmp + "/out/a.pptx") as z:
    slides = [n for n in z.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")]
assert len(slides) == 3, slides  # title slide + one per H2
code, out = run({"source": src, "format": "html", "title": "T"})
assert code == 0 and "<li>" in open(tmp + "/out/a.html", encoding="utf-8").read(), out
if os.environ.get("HAVE_SOFFICE"):
    code, out = run({"source": src, "format": "pdf"})
    assert code == 0 and open(tmp + "/out/a.pdf", "rb").read(5) == b"%PDF-", out

for payload in [
    {"source": src, "format": "exe"},
    {"source": src, "format": "docx", "name": "../x.docx"},
    {"source": src, "format": "docx", "name": "/abs.docx"},
    {"source": src, "format": "docx", "name": "a.pdf"},
    {"source": "/etc/passwd", "format": "docx"},
    {"source": tmp + "/work/none.md", "format": "docx"},
    {"format": "docx"},
    "not json",
]:
    code, out = run(payload)
    assert code == 2 and "error" in out, (payload, out)
print("doc.build: ok")
CHECKS
