---
apiVersion: brain.keyrus/v1
kind: Tool
metadata:
  id: fixture.echo
  version: 1.0.0
spec:
  effectClass: read
  inputSchemaRef: schemas/echo-input.json
  outputSchemaRef: schemas/echo-output.json
  requiredCapabilities:
  - tool:bash
  - tool:python3
  timeoutSeconds: 10
  maxOutputBytes: 1048576
  allowedEnvironments:
  - fixture
  owner: team_demo
  license: LicenseRef-Internal
  entrypoint: run.sh
  testEntrypoint: test.sh
---

# Fixture echo

Read one bounded JSON object from stdin and emit its message. No network or target credentials. The Python/Bash requirements are explicit capabilities. Frontmatter equals the canonical config/tool.yaml fixture. A real release hashes scripts, schemas, metadata and mode bits together.
