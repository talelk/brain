#!/usr/bin/env bash
set -euo pipefail
# doc.build: a Markdown file of /work or /out becomes a DOCX, PPTX, PDF or HTML deliverable in /out.
#   stdin:  {"source": "/work/...md", "format": "docx|pptx|pdf|html", "name": "reports/q3.docx", "title": "..."}
#   stdout: {"path", "format", "bytes"}
# pandoc does the conversion (a deck has one slide per H2); a PDF is the DOCX converted by
# LibreOffice, so it has no LaTeX dependency. DOC_BUILD_WORK and DOC_BUILD_OUT are for test.sh
# only: they replace /work and /out.

exec python3 -I -c '
import json, os, re, subprocess, sys, tempfile, shutil

def fail(why):
    print(json.dumps({"error": why}))
    sys.exit(2)

try:
    v = json.load(sys.stdin)
except ValueError:
    fail("the input is not JSON")
if not isinstance(v, dict):
    fail("the input must be a JSON object")
work = os.path.realpath(os.environ.get("DOC_BUILD_WORK", "/work"))
out = os.path.realpath(os.environ.get("DOC_BUILD_OUT", "/out"))
source, fmt, name, title = v.get("source"), v.get("format"), v.get("name"), v.get("title")
if not isinstance(source, str) or not source or "\x00" in source:
    fail("source must be text")
if fmt not in ("docx", "pptx", "pdf", "html"):
    fail("format must be docx, pptx, pdf or html")
real = os.path.realpath(source)
if not any((real + "/").startswith(r + "/") for r in (work, out)):
    fail("the source must be under /work or /out")
if not os.path.isfile(real):
    fail("no such file")
if os.path.getsize(real) > 5_000_000:
    fail("the source is larger than 5 MB")
if name is None:
    name = os.path.splitext(os.path.basename(real))[0] + "." + fmt
if not isinstance(name, str) or not name or "\x00" in name or name.startswith("/") or ".." in name.split("/") or len(name) > 200:
    fail("name must be a relative path inside /out, without ..")
if not name.lower().endswith("." + fmt):
    fail("name must end with ." + fmt)
if title is not None and (not isinstance(title, str) or len(title) > 300):
    fail("title must be text of at most 300 characters")
target = os.path.join(out, name)
os.makedirs(os.path.dirname(target), exist_ok=True)
if not (os.path.realpath(os.path.dirname(target)) + "/").startswith(out + "/"):
    fail("name must stay inside /out")

text = open(real, encoding="utf-8", errors="replace").read()
rtl = len(re.findall(r"[֐-ࣿ]", text)) > len(re.findall(r"[A-Za-z]", text))
tmp = tempfile.mkdtemp()
try:
    def run(cmd, what):
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=150, env={**os.environ, "HOME": tmp})
        except FileNotFoundError:
            fail(cmd[0] + " is not installed in the tool sandbox")
        except subprocess.TimeoutExpired:
            fail(what + " took too long")
        if r.returncode != 0:
            fail(what + " failed: " + r.stderr.decode("utf-8", "replace")[:300].strip())

    meta = ["-M", "dir=rtl", "-M", "lang=ar"] if rtl else []
    if title:
        meta += ["-M", "title=" + title]
    base = ["pandoc", "-f", "markdown+smart", "--resource-path", os.path.dirname(real) + ":" + work + ":" + out, *meta]
    if fmt == "pptx":
        run(base + ["--slide-level=2", "-o", target, real], "pandoc")
    elif fmt == "docx":
        run(base + ["-o", target, real], "pandoc")
    elif fmt == "html":
        run(base + ["-s", "--embed-resources", "--metadata", "title=" + (title or os.path.splitext(os.path.basename(name))[0]), "-o", target, real], "pandoc")
    else:
        mid = os.path.join(tmp, "mid.docx")
        run(base + ["-o", mid, real], "pandoc")
        run(["soffice", "--headless", "--norestore", "-env:UserInstallation=file://" + tmp + "/lo", "--convert-to", "pdf", "--outdir", tmp, mid], "LibreOffice")
        pdf = os.path.join(tmp, "mid.pdf")
        if not os.path.isfile(pdf):
            fail("LibreOffice produced no PDF")
        shutil.copyfile(pdf, target)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
if not os.path.isfile(target) or os.path.getsize(target) == 0:
    fail("no file was produced")
print(json.dumps({"path": "/out/" + name, "format": fmt, "bytes": os.path.getsize(target)}))
'
