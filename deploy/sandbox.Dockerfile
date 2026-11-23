# The tool sandbox image: where a workspace tool's run.sh runs. The pack tools state what they need of it (packs/README.md, "Script
# tools"): bash, python3 and curl. git is there because a tool may read the working copy, which is mounted read-only at /work.
# poppler-utils gives doc.extract its pdftotext.
# The deliverable tools write into /out (the launcher mounts it read-write for a tool run): pandoc and LibreOffice (Writer and Impress,
# headless, no Java) turn Markdown into docx, pptx, pdf and html for doc.build; python-docx, python-pptx and openpyxl (sheet.build) and
# matplotlib with arabic-reshaper and python-bidi (chart.make) are pinned; the Noto fonts (Latin and Arabic) make Arabic text render.
# chromium and playwright (python, no bundled browser) give web.render a headless browser for pages that build themselves with JavaScript.
# The launcher runs it once per call with a read-only root, no capabilities, resource limits, the tool's files at /tools and a network
# only through the egress proxy; nothing here may assume more.
# Build from the repository root: docker build -f deploy/sandbox.Dockerfile -t brain-sandbox-tool .
FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git poppler-utils \
    pandoc libreoffice-writer libreoffice-impress fonts-noto-core fonts-dejavu-core chromium \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir python-docx==1.1.2 python-pptx==1.0.2 openpyxl==3.1.5 matplotlib==3.10.0 arabic-reshaper==3.0.0 python-bidi==0.6.3 playwright==1.65.2
WORKDIR /tmp
CMD ["sleep", "infinity"]
