#!/usr/bin/env bash
# Builds the three images a runner host needs: the tool sandbox, the engine sandbox and the egress proxy.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
docker build -f deploy/sandbox.Dockerfile -t brain-sandbox-tool .
docker build -f deploy/engine-sandbox.Dockerfile -t brain-sandbox-engine .
docker build -f deploy/egress-proxy.Dockerfile -t brain-egress-proxy .
