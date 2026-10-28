# Deployment reference status

These are nondeployable topology references until T48 provides and pins actual images, boot/health entrypoints, TLS, initialized volume ownership and secrets. They intentionally fail interpolation when required settings are absent. No image tagged latest is supplied.

The Governor image contains the NewUI-backed static web bundle at `/app/web` and its reviewed foundation manifest at `/app/ui/ui-foundation.json`. The corresponding `BRAIN_WEB_DIST_DIR` and `BRAIN_UI_FOUNDATION_MANIFEST_FILE` variables are proposed Brain image contracts to implement in T33/T48. They are not upstream NewUI environment variables. `BrainConfig.spec.ui.foundationManifestDigest` must match the manifest bytes built into the image before config activation/readiness. YAML never triggers package installation, downloads or a separate UI runtime service. Preserve auth/API/MCP/runner routes when implementing SPA fallback; a missing asset returns 404 rather than HTML.

The validated reference build profile is `examples/v1/config/web-build.json`; Vite/CSS consumer examples are under `examples/v1/web/`. Source package versions there remain candidates until G01/T33 installation and production build gates pass.

The supervisor's resource limits exclude separately launched job containers. The trusted launcher enforces independent cgroup/egress/mount profiles and authenticates the supervisor socket. An agent container never receives the launcher socket. Plain Compose networking does not enforce an egress allowlist.

TencentDB deployment must be generated from the pinned upstream service manifests after G04, then adapted to private bindings/volumes/resource budgets. No invented MemoryCore image tag, secret-file option or completeness guarantee is included. Optional Victoria/ntfy services likewise need reviewed versions/config before enabling.

Render both references with supplied disposable paths/values in T48 using `rtk docker compose -f <file> config`, then run health, permissions, restart and rootless isolation scenarios. The current pack checks YAML shape and forbidden mounts only; it does not certify a running deployment.
