# Environment variables

Written from `packages/contracts/src/env.ts` by `pnpm docs:gen`. Do not edit it here.

## pnpm brain

One Brain on one machine (`scripts/brain.ts`). Anything else in its environment reaches the processes it starts as it is.

| Variable | Default | What it does |
|---|---|---|
| `BRAIN_HOME` | ~/.local/share/brain | where this Brain lives: data/, store/, run/ and backups/ |
| `BRAIN_DATA_DIR` | <home>/data | the directory Brain keeps its data in (the Governor requires it) |
| `BRAIN_RUN_DIR` | <home>/run | pids, logs, the launcher's socket and the runner's folder |
| `BRAIN_PORT` | 3100 | the Governor's port |
| `BRAIN_STORE_PORT` | 3110 | the git store's port |
| `BRAIN_ENGINES` | pi | the runner's engines, comma-separated |
| `BRAIN_PROFILE` |  | `fixture` runs every agent on the fixture engine: no Docker and no model |

## Governor

The API and the web app (`apps/governor`).

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 3100 | the port to listen on |
| `BRAIN_BIND_HOST` | 127.0.0.1 | the addresses to listen on, comma-separated (the git store reads one) |
| `BRAIN_BASE_URL` | http://localhost:<port> | the address people reach Brain at |
| `BRAIN_GATEWAY_URL` |  | the address engines reach the model gateway at, when sandboxes cannot use the base address |
| `BRAIN_STORE_URL` |  | the address runners reach the git store at; without it an attempt that needs the store fails |
| `BRAIN_PACKS_DIR` | the packs shipped with Brain | the packs directory |
| `BRAIN_LOCAL_RUNNER_TOKEN_FILE` |  | where to leave a one-use runner token while no runner is enrolled |
| `BRAIN_METRICS_TOKEN` |  | the bearer token `GET /metrics` asks for; without it the route answers 404 |
| `BRAIN_COMMIT` |  | the commit this build was made from, shown on Health and in `brain_build_info` |
| `BRAIN_AUTH_TRUSTED_PROXIES` |  | proxy addresses whose forwarded client address is trusted for sign-in limits |
| `BRAIN_SMTP_URL` |  | a mail server for invitations and reset links; without it links are only copied |
| `BRAIN_SMTP_FROM` |  | the sender of that mail |
| `BRAIN_SMTP_INSECURE` |  | `1` allows a mail connection without encryption |
| `LOG_LEVEL` | info | the least level logged: debug, info, warn or error |

## Runner

Runs attempts (`apps/runner`). It holds no model key.

| Variable | Default | What it does |
|---|---|---|
| `BRAIN_GOVERNOR_URL` | http://127.0.0.1:3100 | the Governor's address |
| `BRAIN_RUNNER_STATE_DIR` | ./.runner-state | the runner's folder |
| `BRAIN_RUNNER_NAME` | the host name | the name to enrol under |
| `BRAIN_RUNNER_ENROLL_TOKEN` |  | the one-use enrolment token, for the first start only |
| `BRAIN_RUNNER_CAPABILITIES` | bash | comma-separated capability names the operator declares |
| `BRAIN_RUNNER_ENGINES` | fixture | comma-separated engines: fixture, pi, claude, opencode, codex |
| `BRAIN_RUNNER_FIXTURE_FOR` |  | engines the fixture stands in for: an agent written for one then runs with no model, and its attempts say so |
| `BRAIN_RUNNER_SLOTS` | 1 | attempts at a time |
| `BRAIN_RUNNER_ATTEMPT_TIMEOUT_SECONDS` | 3600 | how long one engine session may run |
| `BRAIN_RUNNER_SANDBOX_CPU_MILLICORES` | 2000 | cpu of an engine sandbox |
| `BRAIN_RUNNER_SANDBOX_MEMORY_MB` | 4096 | memory of an engine sandbox |
| `BRAIN_LAUNCHER_SOCKET` | launcher: /tmp/brain-launcher/launcher.sock | the launcher's socket; for a runner, unset means no launcher |
| `BRAIN_LAUNCHER_TOKEN` |  | the launcher's token (for the launcher: use this one instead of a generated one) |
| `BRAIN_LAUNCHER_TOKEN_FILE` | <socket>.token | the file that holds the launcher's token |
| `BRAIN_OPENCODE_COMMAND` | opencode acp | the command line of the OpenCode ACP agent |
| `BRAIN_CODEX_COMMAND` | codex-acp | the command line of the Codex ACP agent |

## Launcher

Starts sandboxes and runs the operator's host commands (`apps/launcher`).

| Variable | Default | What it does |
|---|---|---|
| `BRAIN_LAUNCHER_ATTEMPTS_ROOT` |  | the runner's `<state>/attempts` folder on this host; without it no sandbox starts |
| `BRAIN_LAUNCHER_SANDBOX_USER` | the launcher's own | `uid:gid` sandboxes run as: the owner of the attempt folders |
| `BRAIN_LAUNCHER_EGRESS_GRANTS_DIR` |  | where the egress proxy reads its grants; without it no sandbox gets a network |
| `BRAIN_LAUNCHER_HOST_COMMANDS` |  | the operator's host-command file, which limits the host commands offered |
| `BRAIN_LAUNCHER_IMAGE_DIGESTS` |  | image pins, `name=sha256:...,name=sha256:...` |
| `BRAIN_LAUNCHER_ENGINE_IDLE_MS` | 90000 | how long an engine sandbox may go unspoken to before it is stopped |

## Egress proxy

The only way a sandbox reaches a network (`apps/launcher/src/egress-proxy.ts`).

| Variable | Default | What it does |
|---|---|---|
| `BRAIN_PROXY_PORT` | 18080 | the port it listens on |
| `BRAIN_EGRESS_GRANTS_DIR` | /grants | the grants it reads |
| `BRAIN_EGRESS_ALLOW_INTERNAL` |  | comma-separated `host` or `host:port` entries that may resolve to private addresses |

## Git store

Holds the work one attempt leaves for the next (`apps/store`). It also reads `PORT` (default 3110) and `BRAIN_BIND_HOST`.

| Variable | Default | What it does |
|---|---|---|
| `BRAIN_STORE_DIR` |  | where the repositories are kept (required) |
| `BRAIN_STORE_PUBLIC_KEY_FILE` |  | the Governor's `store.pub` (required) |

## MCP server

For a person's own Claude (`apps/mcp`).

| Variable | Default | What it does |
|---|---|---|
| `BRAIN_URL` |  | the address of Brain |
| `BRAIN_EMAIL` |  | the account to sign in as |
| `BRAIN_PASSWORD` |  | its password |
| `BRAIN_MCP_ENV_FILE` |  | a dotenv file to read the three above from; values of the environment win |
| `BRAIN_LIVE_ADMIN_EMAIL` |  | read from that file as the account too |
| `BRAIN_LIVE_ADMIN_PASSWORD` |  | read from that file as its password too |
| `BRAIN_MCP_READONLY` |  | `1` serves only the read tools |
| `BRAIN_MCP_METRICS_ENV_FILE` |  | a dotenv file with the metrics address and sign-in |
| `VM_URL` |  | VictoriaMetrics address, for the metric tools |
| `VM_USER` |  | its user |
| `VM_PASS` |  | its password |

## Set by Brain

Brain sets these for the processes it starts; an operator never does.

| Variable | Default | What it does |
|---|---|---|
| `BRAIN_SECRET_<NAME>` |  | a leased secret, in the environment of one tool run |
| `BRAIN_MODEL_URL` |  | the model gateway, for the commands of an agent with `model_in_commands` |
| `BRAIN_MODEL_TOKEN` |  | the attempt's token, with it |
| `BRAIN_MODEL_NAME` |  | the model route to ask for, with it |
| `BRAIN_MODEL_API` |  | the kind of API of that route, with it |
| `BRAIN_ENGINE_HOST` |  | `1` inside an engine sandbox |
| `BRAIN_MCP_URL` |  | the tool bridge, for the stdio relay of an ACP agent |
| `BRAIN_MCP_TOKEN` |  | its token |
| `BRAIN_STORE_GOAL` |  | the goal a push may write under, for the git store's hook |
| `BRAIN_STORE_ATTEMPT` |  | the attempt that pushes, for the same hook |
