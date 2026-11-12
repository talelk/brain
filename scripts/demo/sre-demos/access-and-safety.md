# Access, safety and change rules

## What the SRE agent can do (set up 2026-11-12, ADR 0021)
- **`host.read`**: list folders, read text files and find files under the demos host's `/srv`, read-only. Secrets (`.env*`, keys, `.git`), databases, archives and any `backups` folder are refused on purpose; password and token values in files are redacted. Paths are relative to `/srv`, for example `demos/gatus/config/config.yaml`.
- **`host.exec`**: run one named read-only diagnostic: `docker.ps`, `docker.logs {lines, container}`, `docker.stats`, `docker.df`, `host.df`, `host.memory`, `host.uptime`, `host.du`, `systemd.is-active {unit}`, `systemd.status {unit}`, `http.head-local {port}`, `http.head-public {host}`, `http.check-demos` (every demo site in one call). The operator fixed the real command lines; the agent supplies only the name and validated arguments.
- **`documents.read`, `knowledge.search`**: this workspace's documents and stored knowledge.
- Everything an agent reads can appear in model prompts, including the independent evaluator's. Keep secrets out of `/srv` files that are not on the deny list.

## What it cannot do
- It cannot change anything on the server: no restart, reload, delete, write, package or firewall change. When a fix is needed it writes the exact command, its risk and how to undo it, and a person runs it.
- It cannot reach any other machine. Commands on other hosts over SSH are out of scope.
- No agent receives SSH keys, sudo passwords, `.env` files or tokens. If a task seems to need one, stop and ask a person.

## Needs the owner's explicit yes (a person runs these)
Deleting anything under `/srv/demos/backups`, `docker volume rm`, `docker compose down -v`, `docker system prune`, firewall or Tailscale changes, certificate removal, changing a `.env`, restarting every container, kernel or package upgrades during demos.

## Change rules
- Record every change as a note on the task it belongs to: what, why, how to undo.
- SSH reaches the host as `talel` on port 42242 over the Tailscale name; `demos.mykeyrus.tn:42242` has timed out before, so prefer Tailscale.
- Brain deploys use `scripts/deploy-demo.sh` and `scripts/stage-demo-release.sh` in the Brain repository.
- Adding a host command or mount is an operator change (`scripts/demo/host-commands.json`, the deploy), never something an agent or a release does for itself.
