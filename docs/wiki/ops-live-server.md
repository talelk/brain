# Live server operations

The demo is `https://brain.mykeyrus.tn`, on the demos host under `/srv/demos/brain`. The model is
[docs/model.md](../model.md); this page is only how the demo host is run.

## Layout on the host

| Path | What |
|---|---|
| `src/` | this repository, synced by the deploy |
| `data/` | the Governor's data (`brain.db`, `cas/`, `workspaces/`, `instance.key`, `audit/`) |
| `run/` | launcher socket, the runner's folder (`run/runner`), egress grants |
| `archive/` | what earlier versions left (`data-<time>/`, `config-<time>/`). Never delete it. |
| `docker-compose.yml`, `.env`, `runner.env` | written by the deploy |

What runs: the container `brain-governor-1` on `127.0.0.1:3100` behind the host's nginx, the container
`brain-egress-proxy`, and the systemd units `brain-launcher` and `brain-runner` (one runner, engines
`pi,claude`, in sandboxes). With `backup.env` on the host: `brain-backup.timer` (nightly, encrypted, to a
second host) and `brain-restore-test.timer` (monthly).

## Deploy

```bash
scripts/deploy-demo.sh --dry-run   # prints every local and remote action; connects to nothing
scripts/deploy-demo.sh             # needs BRAIN_DEPLOY_SUDO_PASSWORD
```

The host, port and sudo password come from the environment (`BRAIN_DEPLOY_HOST`, `BRAIN_DEPLOY_PORT`,
`BRAIN_DEPLOY_SUDO_PASSWORD`); a dev machine keeps them in `~/.config/brain-dev/credentials.env`, which the
script reads by itself. Never copy the values anywhere else. The steps are listed at the top of the script.

The first deploy of the simplified model (no `/srv/demos/brain/.simplified-model` yet) moves the earlier
`data/` to `archive/data-<time>/`, retires the earlier units, and starts on an empty `data/`; it prints the
setup link with the setup token. Later deploys keep `data/` as it is. A deploy restarts the Governor and
the runner: attempts that were running are taken back and run again.

## Day to day

```bash
ssh <host> 'cd /srv/demos/brain && docker compose logs --tail=100 governor'
ssh <host> 'journalctl -u brain-runner -n 100'      # or brain-launcher
ssh <host> 'cd /srv/demos/brain/src && BRAIN_HOME=/srv/demos/brain pnpm brain backup /tmp/brain.tar.gz'
ssh <host> 'cd /srv/demos/brain/src && BRAIN_HOME=/srv/demos/brain pnpm brain audit-verify'
```

Restore on the host: `docker compose stop governor`, then `BRAIN_HOME=/srv/demos/brain pnpm brain restore <file>`
(it refuses while the Governor answers; the data that was in place is moved to `data.before-restore-<time>`),
then `docker compose start governor`.

## Starting over (the playground reset)

To start a Brain from empty without losing the old one, move the data aside; never delete it. `data/` and the git
store hold keys that belong together (`data/store.pub` signs what `store/` keeps), so they move together.

```bash
export BRAIN_HOME=/srv/demos/brain            # locally: ~/.local/share/brain
pnpm brain backup /tmp/brain-before-reset.tar.gz       # skip when data/ holds no brain.db
docker compose stop governor                    # locally: pnpm brain stop
stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BRAIN_HOME/archive" && mv "$BRAIN_HOME/data" "$BRAIN_HOME/archive/data-$stamp"
[ -d "$BRAIN_HOME/store" ] && mv "$BRAIN_HOME/store" "$BRAIN_HOME/archive/store-$stamp"
docker compose start governor                   # locally: pnpm brain start; it prints the setup link
```

Open the setup link, create the admin, then `pnpm playground` (environment listed at the top of `scripts/playground.ts`)
creates the playground workspaces. Restoring the old Brain is `pnpm brain restore` of the backup, or moving the two
archived folders back while the Governor is stopped.

- A second runner: create a token on the Health screen, then start `apps/runner/src/main.ts` on the other
  host with `BRAIN_GOVERNOR_URL`, `BRAIN_RUNNER_ENROLL_TOKEN` and the variables listed in
  `apps/runner/src/config.ts`; a launcher beside it gives it sandboxes (`apps/launcher/src/server.ts`).
- Host commands of the `sre` pack (`host.status`, `host.logs`, `host.disk`, `host.restart`, `host.redeploy`)
  are built into the launcher (`apps/launcher/src/host-commands.ts`) and open; `host.run` runs one shell line. Privileged ones wait for approval. To limit them, write a host-commands file and set `BRAIN_LAUNCHER_HOST_COMMANDS`. The launcher runs them as the deploy user, who
  is in the `docker` group. `host.redeploy` takes the name of a folder under `/srv/demos` other than `brain`.
- Engines in sandboxes reach the model gateway at `host.docker.internal:3100`, the Governor's port on
  Docker's bridge address. The last step of the deploy checks that path.

## Locally

`pnpm brain start | stop | status | logs | backup | restore <file> | audit-verify` runs the same stack
without containers for the Governor (`scripts/brain.ts` lists the environment variables). Tests: `pnpm verify`,
`pnpm test:browser`. Use `export TMPDIR=$HOME/.cache/tmp` when `/tmp` is full.
