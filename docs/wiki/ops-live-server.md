# Live server operations

As of `talelk/brain@e4017e5` (2026-11-11):
- Demo URL `https://brain.mykeyrus.tn`; the browser is already signed in as Administrator in the user's Chrome (Claude-in-Chrome tools).
- SSH: `demos.mykeyrus.tn:42242` timed out after many connections on 2026-11-10; use the Tailscale host `ns390729` port 42242 user `talel`. The key `/home/talel/dev/keys/id_rsa` is only configured for the other host name, so start a temporary `ssh-agent` + `ssh-add` inside the same shell command (agent env does not persist between Bash calls) and pass `-p 42242`.
- Deploy: `BRAIN_DEPLOY_HOST=ns390729 BRAIN_DEPLOY_PORT=42242 BRAIN_DEPLOY_SUDO_PASSWORD=<ask the user> ./scripts/deploy-demo.sh`. It rsyncs, repairs live schema, recreates the governor container, restarts launcher and runners; it never resets data. Runners restart right after: wait ~1 min before judging planning/runs.
- Inspect data: `scp` a `node:sqlite` script to the host, `docker cp` it into `brain-governor-1`, `docker exec brain-governor-1 node /tmp/x.mjs`. DBs: `/data/control.db`, `/data/workspaces/ws-ded6091d-fea2-44b0-b46a-2a5cb10ae7c1.db` (workspace id `ws-ded6091d-fea2-44b0-b46a-2a5cb10ae7c1`). The container is recreated on deploy, so re-copy scripts.
- Tests: `export TMPDIR=$HOME/.cache/tmp` (the default /tmp fills); `pnpm verify:fast`, `pnpm test:integration`, `pnpm test:chaos`, `pnpm test:security`; browser: `pnpm build` then `npx playwright test <spec> --project=1440-light --forbid-only --update-snapshots=none`. Kill orphaned Playwright runs.
- Changing an agent markdown file re-pins digests and needs a release restage + activation.

Deploy safety net and the DEFAULT rule for new columns (enforced by `tests/contracts/live-schema-upgrade.test.ts`): `docs/wiki/archive/ops-live-server-2026-11-11-deploy-safety.md`. Credentials come from `~/.config/brain-dev/credentials.env`; `pnpm test:integration|security|chaos` pick a private TMPDIR.

Older ops notes (notification webhook, stuck-run watchdog, runner capacity): `docs/wiki/archive/ops-live-server-2026-11-11.md`.

## SRE workspace and host access for the demos server (2026-11-12, ADR 0021, deployed)
Workspace `ws-sre-demos`, made by `scripts/provision-sre-demos.sh` (idempotent; `BRAIN_PROVISION_REVISE=1` saves `scripts/demo/sre-demos/*.md` as new document revisions): four documents (inventory, monitoring, runbook, access rules) and two missions ("Keep the demos server healthy", achieved; "Check the demos server live", uses `sre-task`). 
- Host access: `host.read` lists/reads/finds text files under `/srv` read-only; `host.exec` runs one named read-only diagnostic. Used by the `sre-operator` agent through the hidden `sre-task` workflow. Operator config, set by `scripts/deploy-demo.sh` on every deploy: launcher drop-in `/etc/systemd/system/brain-launcher.service.d/host-access.conf` (`BRAIN_LAUNCHER_DATA_MOUNTS=srv=/srv`, `BRAIN_LAUNCHER_HOST_COMMANDS=/srv/demos/brain/host-commands.json`, from `scripts/demo/host-commands.json`) and `BRAIN_TOOL_DATA_MOUNTS=host.read=srv` in `runner-agents.env` (format `tool=mount+mount,...`, per tool).
- Checked live: launcher health lists the mount and commands; probes refused an undeclared command and a flag-like argument; a real mission made `host.exec` and `host.read` calls on `/srv/demos/*`. Secrets, databases, archives and `backups` are denied by name; secret-looking values are redacted.
- Live run 2026-11-12: a task made 168 refused calls (budget 14) and parked; fixed with `http.check-demos`, budget 30 and a stop-when-refused rule.
- Not done: privileged commands (restart/reload, each needing an effect permit) and a writable per-run output directory (results already appear in Outputs). Tools are org-wide (only `sre-operator` lists them; `sre-task` is hidden); a dedicated runner group is the next hardening step.

- Dated notes of 2026-11-12 (Tools tab, parked-task healing, release re-pinning): `docs/wiki/archive/ops-live-server-2026-11-12.md`. Pi attempts are judged while they run (ADR 0030).
