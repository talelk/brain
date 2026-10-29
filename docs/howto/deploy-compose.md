# Deploy the reference topology

`deploy/reference/` describes the separate Governor/runner trust boundary. These files
are topology references, not deployable manifests: they intentionally fail
interpolation when required settings are absent, and no `latest` image is supplied.
Read `deploy/reference/README.md` for the current caveats before attempting a run.

## Files

| File | Role |
|---|---|
| `compose.core.yaml` | Governor plus its SQLite/CAS volumes and external memory service |
| `compose.runner.yaml` | Runner and the trusted launcher on a separate host/trust domain |
| `deploy/sandbox.Dockerfile` | Ephemeral sandbox image built by `scripts/build-sandbox-images.sh` |

## Principles

- The runner never receives the launcher socket; the launcher authenticates the
  supervisor socket and enforces independent cgroup, egress, and mount profiles.
- Plain Compose networking does not enforce an egress allowlist; do not expose local
  plaintext HTTP or the launcher socket to an untrusted network.
- The Governor image carries the static web bundle and the reviewed UI foundation
  manifest; activation/readiness refuse a manifest digest mismatch.
- TencentDB must be generated from pinned upstream manifests and adapted to private
  bindings, volumes, and resource budgets — no invented image tags.

## Render and smoke

```bash
rtk docker compose -f deploy/reference/compose.core.yaml config
rtk docker compose -f deploy/reference/compose.runner.yaml config
```

Then run health, permissions, restart, and rootless isolation scenarios in disposable
directories. The current pack checks YAML shape and forbidden mounts only; it does not
certify a running deployment. Pin images by digest (`BRAIN_LAUNCHER_IMAGE_DIGESTS`)
before production use.
