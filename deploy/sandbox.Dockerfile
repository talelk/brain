# The tool sandbox image: where a workspace tool's run.sh runs. The pack tools state what they need of it (packs/README.md, "Script
# tools"): bash, python3 and curl. git is there because a tool may read the working copy, which is mounted read-only at /work.
# poppler-utils gives doc.extract its pdftotext.
# The launcher runs it once per call with a read-only root, no capabilities, resource limits, the tool's files at /tools and a network
# only through the egress proxy; nothing here may assume more.
# Build from the repository root: docker build -f deploy/sandbox.Dockerfile -t brain-sandbox-tool .
FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git poppler-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp
CMD ["sleep", "infinity"]
