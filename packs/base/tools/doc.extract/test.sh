#!/usr/bin/env bash
set -euo pipefail
# Proves run.sh without any real document service: DOCX and XLSX files are built here
# from XML, and a stub `pdftotext`, first on PATH, answers for the PDF.

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin" "$tmp/work"

cat >"$tmp/bin/pdftotext" <<'STUB'
#!/usr/bin/env bash
printf 'Page one text\n\fPage two text\n\f'
STUB
chmod +x "$tmp/bin/pdftotext"

DOC_EXTRACT_ROOT="$tmp/work" PATH="$tmp/bin:$PATH" python3 - "$here/run.sh" "$tmp/work" <<'CHECKS'
import json, os, subprocess, sys, zipfile

script, work = sys.argv[1], sys.argv[2]

def make(name, parts):
    with zipfile.ZipFile(os.path.join(work, name), "w") as z:
        for part, xml in parts.items():
            z.writestr(part, xml)

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
make("a.docx", {"word/document.xml": f'<w:document {W}><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>'})
S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
make("b.xlsx", {
    "xl/workbook.xml": f'<workbook {S} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Stock" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": f'<sst {S}><si><t>item</t></si><si><t>qty</t></si><si><t>bolt</t></si></sst>',
    "xl/worksheets/sheet1.xml": f'<worksheet {S}><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c t="s"><v>2</v></c><c><v>12</v></c></row></sheetData></worksheet>',
})
open(os.path.join(work, "c.pdf"), "wb").write(b"%PDF-1.4")
open(os.path.join(work, "d.docx"), "wb").write(b"not a zip")
open(os.path.join(work, "e.txt"), "w").write("plain")

def run(payload):
    r = subprocess.run(["bash", script], input=payload if isinstance(payload, str) else json.dumps(payload), capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout)

code, out = run({"path": f"{work}/a.docx"})
assert code == 0 and out["format"] == "docx" and out["text"] == "Hello world\nSecond" and out["truncated"] is False, out
code, out = run({"path": f"{work}/b.xlsx"})
assert code == 0 and out["text"] == "## Stock\nitem\tqty\nbolt\t12", out
code, out = run({"path": f"{work}/c.pdf"})
assert code == 0 and out["format"] == "pdf" and out["pages"] == 2 and "Page two text" in out["text"], out
code, out = run({"path": f"{work}/a.docx", "max_chars": 5})
assert code == 0 and out["text"] == "Hello" and out["truncated"] is True, out

for payload in [
    {"path": f"{work}/d.docx"},          # not a zip
    {"path": f"{work}/e.txt"},           # unsupported type
    {"path": f"{work}/missing.pdf"},
    {"path": "/etc/passwd"},             # outside /work
    {"path": f"{work}/../a.docx"},
    {"path": f"{work}/a.docx", "max_chars": 0},
    {"path": 7},
    {},
    "not json",
]:
    code, out = run(payload)
    assert code == 2 and "error" in out, (payload, out)

print("doc.extract: ok")
CHECKS
