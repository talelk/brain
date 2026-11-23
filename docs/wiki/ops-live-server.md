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

## Brain's own metrics

The Governor answers `GET /metrics` (Prometheus text; the list is in [docs/architecture.md](../architecture.md) section 9) to a bearer token
only. The deploy makes the token once in `/srv/demos/brain/metrics.token` (mode 600, never printed), gives it to the Governor as
`BRAIN_METRICS_TOKEN`, and adds a scrape job to the host's vmagent (`/srv/demos/victoria/vmagent.yml`) between the lines
`# >>> brain-governor` and `# <<< brain-governor`. It checks the new file with `vmagent -dryRun` first, keeps the original once as
`vmagent.yml.before-brain`, writes the file in place (it is a single-file bind mount), makes it mode 640 because the token is inside, and
reloads vmagent with SIGHUP (no restart). If vmagent does not accept the file, the deploy leaves it alone and says so. The same job by hand, appended
under `scrape_configs:` (the token is `cat /srv/demos/brain/metrics.token`), then `docker kill --signal=HUP victoria-vmagent`:

```yaml
  - job_name: brain-governor
    metrics_path: /metrics
    authorization: { type: Bearer, credentials: "<the token>" }
    static_configs:
      - targets: ["127.0.0.1:3100"]
```

The public name cannot reach it: nginx adds `X-Forwarded-For`, and the Governor answers 404 to any request that has it. The scrape goes to
`127.0.0.1:3100` directly. Series are labelled `env="demos"`, `host="demos.mykeyrus.tn"`, `job="brain-governor"`; VictoriaMetrics keeps one day.

Look without Grafana (`https://victoria.mykeyrus.tn/vm/` is behind the host's basic auth; the API path is `/vm/api/v1/query`):

```bash
q() { curl -fsS -u "$VM_USER:$VM_PASS" --data-urlencode "query=$1" https://victoria.mykeyrus.tn/vm/api/v1/query; }
q 'sum by (state) (brain_tasks{job="brain-governor"})'                                   # queue depth and what is running
q 'sum by (wait) (brain_tasks_waiting)'                                                  # why tasks wait (daily-cap, slot, no-runner, ...)
q 'brain_oldest_queued_seconds'                                                          # longest wait for a slot
q 'sum(brain_tokens_today{direction=~"input|output"})'                                   # tokens today (resets at 00:00 UTC)
q 'sum by (workspace) (brain_micro_usd_today) / 1e6'                                     # dollars today
q 'brain_goals_today{result="failed"}'                                                   # goals failed today
q 'histogram_quantile(0.95, sum by (le, route) (rate(brain_http_request_duration_seconds_bucket[5m])))'   # p95 latency by route
q 'sum by (route) (rate(brain_http_request_duration_seconds_count{status="5xx"}[5m]))'   # server errors per second
q 'brain_runner_free_slots == 0 and on() brain_tasks_waiting{wait="slot"} > 0'           # runners full with work waiting
q 'brain_runners{state="online"} == 0'                                                   # no runner online
q 'brain_schedules_overdue > 0'                                                          # a scheduled Play did not start
q 'brain_event_loop_lag_seconds{quantile="0.99"}'                                        # the Governor is blocked when this passes ~0.2
q 'brain_sqlite_bytes{file="wal"}'                                                       # a WAL that keeps growing is a stuck checkpoint
q 'brain_process_resident_memory_bytes / 2^20'                                           # Governor memory in MiB
```

Counters of the histogram reset when the Governor restarts (`resets()` and `rate()` handle it); the `*_today` gauges are recounted from the database.

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
