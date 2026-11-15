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
  socket to an untrusted network.
- Engines run in their own per-attempt sandbox (ADR 0065), not in the runner process, and the runner states `ephemeral-container` for Pi, Claude and ACP engines only while it can start those sandboxes. The launcher needs `BRAIN_LAUNCHER_ENGINE_STATE_ROOT` (a host directory; the runner mounts the same one and names it `BRAIN_RUNNER_ENGINE_STATE_DIR`, so `BRAIN_ENGINE_STATE_DIR` in `compose.runner.yaml`), `BRAIN_LAUNCHER_EGRESS_GRANTS_DIR` (every engine sandbox reaches its model only through the proxy), the image `brain-sandbox-engine` (built by `scripts/build-sandbox-images.sh` from `deploy/engine-sandbox.Dockerfile`), and optionally `BRAIN_LAUNCHER_ENGINE_USER` (`uid:gid` the engine runs as; it must be able to write the attempt directories the runner creates, so default it to the runner's uid) and `BRAIN_LAUNCHER_ENGINE_IDLE_MS` (a sandbox its runner stopped talking to is stopped after this long). The model's host is added to each sandbox's allowed hosts from the route or the runner's own model setting; for an ACP agent the operator lists its hosts in `BRAIN_ENGINE_MODEL_HOSTS` on the runner. Without these the attempt fails with `engine sandbox create failed`; it never runs in the runner.
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
