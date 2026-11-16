# Deploy the reference topology

`deploy/reference/` describes the separate Governor/runner trust boundary. These files
are topology references, not deployable manifests: they intentionally fail
interpolation when required settings are absent, and no `latest` image is supplied.
Read `deploy/reference/README.md` for the current caveats before attempting a run.

## Files

| File | Role |
|---|---|
| `compose.core.yaml` | Governor plus its SQLite/CAS volumes and external memory service |
| `compose.runner.yaml` | Runner and the egress proxy; the trusted launcher runs beside them on the same host |
| `deploy/sandbox.Dockerfile`, `deploy/egress-proxy.Dockerfile` | Ephemeral sandbox and egress proxy images built by `scripts/build-sandbox-images.sh` |

## Principles

- The runner never receives the launcher socket; the launcher authenticates the
  supervisor socket and enforces independent cgroup, egress, and mount profiles.
- Sandboxes reach a network only through the `egress-proxy` service, which allows each
  workspace's own hosts (ADR 0037). Point the launcher's `BRAIN_LAUNCHER_EGRESS_GRANTS_DIR`
  at the directory the proxy mounts (`BRAIN_EGRESS_GRANTS_DIR`), and build the proxy image
  with `scripts/build-sandbox-images.sh`. Do not expose local plaintext HTTP or the launcher
  socket to an untrusted network. The proxy resolves each listed name once, refuses loopback,
  private, link-local (cloud metadata), unique-local and its own addresses (IPv4-mapped forms
  included) and connects to the address it checked. An internal host is granted on purpose only
  by listing it in the proxy's `BRAIN_EGRESS_ALLOW_INTERNAL` (comma-separated `host`,
  `host:port`; empty by default); a workspace's grant must still name it. A sandboxed engine
  that reaches its model host on a Tailscale (100.64.0.0/10) or other private address is refused
  until that host is listed in `BRAIN_EGRESS_ALLOW_INTERNAL` on the proxy (for example
  `tntungx10:8000`) or the model is reached through the model gateway (ADR 0072) instead.
- Engines run in per-attempt sandboxes (ADR 0073): set `BRAIN_LAUNCHER_ENGINE_STATE_ROOT` on the launcher (the runner mounts it as `BRAIN_RUNNER_ENGINE_STATE_DIR`), build `brain-sandbox-engine` with `scripts/build-sandbox-images.sh`, and see `deploy/reference/README.md`.
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
