#!/usr/bin/env bash
set -euo pipefail
# doc.extract: plain text of one PDF, DOCX or XLSX file under /work.
#   stdin:  {"path": "/work/...", "max_chars": 20000}
#   stdout: {"path", "format", "pages", "text", "truncated"}
# A refused input or an unreadable file prints {"error": "..."} and exits 2.
# DOCX and XLSX are read with the Python standard library (they are zip files of XML);
# a PDF is read with `pdftotext`, which the tool sandbox must provide. DOC_EXTRACT_ROOT
# is for test.sh only: it replaces /work as the folder the path must be under.

exec python3 -I -c '
import json, os, re, subprocess, sys, zipfile
import xml.etree.ElementTree as ET

def fail(why):
    print(json.dumps({"error": why}))
    sys.exit(2)

try:
    v = json.load(sys.stdin)
except ValueError:
    fail("the input is not JSON")
if not isinstance(v, dict):
    fail("the input must be a JSON object")
root = os.environ.get("DOC_EXTRACT_ROOT", "/work")
path = v.get("path")
if not isinstance(path, str) or not path or "\x00" in path:
    fail("path must be text")
limit = v.get("max_chars", 20000)
if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100000:
    fail("max_chars must be a whole number from 1 to 100000")
real = os.path.realpath(path)
if not (real + "/").startswith(os.path.realpath(root) + "/"):
    fail("the file must be under /work")
if not os.path.isfile(real):
    fail("no such file")
if os.path.getsize(real) > 50_000_000:
    fail("the file is larger than 50 MB")
ext = os.path.splitext(real)[1].lower()
pages = None

def local(tag):
    return tag.rsplit("}", 1)[-1]

def read_zip(name):
    with zipfile.ZipFile(real) as z:
        info = z.getinfo(name)
        if info.file_size > 100_000_000:
            fail("a part of the file is too large to read")
        return z.read(name)

try:
    if ext == ".pdf":
        fmt = "pdf"
        try:
            r = subprocess.run(["pdftotext", "-layout", real, "-"], capture_output=True, timeout=45)
        except FileNotFoundError:
            fail("pdftotext is not installed in the tool sandbox")
        except subprocess.TimeoutExpired:
            fail("reading the PDF took too long")
        if r.returncode != 0:
            fail("the PDF could not be read: " + r.stderr.decode("utf-8", "replace")[:200].strip())
        text = r.stdout.decode("utf-8", "replace")
        pages = text.count("\f")
        text = text.replace("\f", "\n\n").strip()
        if not text:
            text = "(no text layer: the PDF may be a scan)"
    elif ext == ".docx":
        fmt = "docx"
        body = ET.fromstring(read_zip("word/document.xml"))
        paragraphs = []
        for p in body.iter():
            if local(p.tag) != "p":
                continue
            parts = []
            for e in p.iter():
                t = local(e.tag)
                if t == "t":
                    parts.append(e.text or "")
                elif t == "tab":
                    parts.append("\t")
                elif t in ("br", "cr"):
                    parts.append("\n")
            paragraphs.append("".join(parts))
        text = re.sub(r"\n{3,}", "\n\n", "\n".join(paragraphs)).strip()
    elif ext == ".xlsx":
        fmt = "xlsx"
        with zipfile.ZipFile(real) as z:
            names = z.namelist()
        shared = []
        if "xl/sharedStrings.xml" in names:
            for si in ET.fromstring(read_zip("xl/sharedStrings.xml")):
                shared.append("".join(t.text or "" for t in si.iter() if local(t.tag) == "t"))
        sheet_names = {}
        if "xl/workbook.xml" in names:
            rels = {}
            if "xl/_rels/workbook.xml.rels" in names:
                for r in ET.fromstring(read_zip("xl/_rels/workbook.xml.rels")):
                    rels[r.get("Id")] = r.get("Target", "")
            for s in ET.fromstring(read_zip("xl/workbook.xml")).iter():
                if local(s.tag) == "sheet":
                    rid = [val for key, val in s.attrib.items() if local(key) == "id"]
                    target = rels.get(rid[0], "") if rid else ""
                    sheet_names["xl/" + target.lstrip("/").removeprefix("xl/")] = s.get("name", "")
        sheets = sorted((n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)), key=lambda n: int(re.findall(r"\d+", n)[-1]))
        blocks = []
        for n in sheets:
            lines = []
            for row in ET.fromstring(read_zip(n)).iter():
                if local(row.tag) != "row":
                    continue
                cells = []
                for c in row:
                    if local(c.tag) != "c":
                        continue
                    kind = c.get("t")
                    val = ""
                    for e in c:
                        if local(e.tag) == "v" and e.text is not None:
                            val = shared[int(e.text)] if kind == "s" and e.text.isdigit() and int(e.text) < len(shared) else e.text
                        elif local(e.tag) == "is":
                            val = "".join(t.text or "" for t in e.iter() if local(t.tag) == "t")
                    cells.append(val.replace("\t", " ").replace("\n", " "))
                lines.append("\t".join(cells).rstrip("\t"))
            blocks.append("## " + sheet_names.get(n, os.path.basename(n)) + "\n" + "\n".join(lines).strip())
        text = "\n\n".join(blocks).strip()
    else:
        fail("only .pdf, .docx and .xlsx files are read")
except (zipfile.BadZipFile, KeyError, ET.ParseError):
    fail("the file is not a valid " + ext[1:].upper() + " file")

out = {"path": path, "format": fmt, "text": text[:limit], "truncated": len(text) > limit}
if pages is not None:
    out["pages"] = pages
print(json.dumps(out))
'
