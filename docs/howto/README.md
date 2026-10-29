# How-to guides

Task-oriented guides for operating the current target system. The architecture and
decision records stay in `docs/implementation/`; the README keeps the short quickstart.

| Guide | Use it to |
|---|---|
| [Run the local stack](run-local-stack.md) | Start, stop, and troubleshoot Governor, launcher, and runners on one host |
| [Compile and activate a release](compile-activate-release.md) | Stage, inspect, and activate configuration; change documents safely |
| [Add a governed tool](add-governed-tool.md) | Wire a new release-pinned tool into an Agent through the broker |
| [Operate runs and approvals](operate-runs-and-approvals.md) | Dispatch, watch, and reconcile runs; review exact effects |
| [Backup and restore](backup-restore.md) | Run trusted offline maintenance on the Governor host |
| [Run the operational proof](verify-operational.md) | Reproduce the end-to-end acceptance evidence |
| [Deploy the reference topology](deploy-compose.md) | Understand the separate Governor/runner trust boundary files |
