#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
docker build -f deploy/sandbox.Dockerfile -t brain-sandbox-evaluator .
docker tag brain-sandbox-evaluator brain-sandbox-agent
docker tag brain-sandbox-evaluator brain-sandbox-tool
