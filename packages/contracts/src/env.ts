/**
 * Every environment variable of Brain, in one place: who reads it, its default and what it does. `docs/environment.md` is written from this
 * list (`pnpm docs:gen`), and a test fails when the code reads a variable that is not here, or the list or the page is out of date.
 */
export interface EnvVar { readonly name: string; readonly fallback?: string; readonly about: string }
export interface EnvGroup { readonly title: string; readonly about: string; readonly vars: readonly EnvVar[] }

export const ENVIRONMENT: readonly EnvGroup[] = [
  {
    title: "pnpm brain", about: "One Brain on one machine (`scripts/brain.ts`). Anything else in its environment reaches the processes it starts as it is.",
    vars: [
      { name: "BRAIN_HOME", fallback: "~/.local/share/brain", about: "where this Brain lives: data/, store/, run/ and backups/" },
      { name: "BRAIN_DATA_DIR", fallback: "<home>/data", about: "the directory Brain keeps its data in (the Governor requires it)" },
      { name: "BRAIN_RUN_DIR", fallback: "<home>/run", about: "pids, logs, the launcher's socket and the runner's folder" },
      { name: "BRAIN_PORT", fallback: "3100", about: "the Governor's port" },
      { name: "BRAIN_STORE_PORT", fallback: "3110", about: "the git store's port" },
      { name: "BRAIN_ENGINES", fallback: "pi", about: "the runner's engines, comma-separated" },
      { name: "BRAIN_PROFILE", about: "`fixture` runs every agent on the fixture engine: no Docker and no model" },
    ],
  },
  {
    title: "Governor", about: "The API and the web app (`apps/governor`).",
    vars: [
      { name: "PORT", fallback: "3100", about: "the port to listen on" },
      { name: "BRAIN_BIND_HOST", fallback: "127.0.0.1", about: "the addresses to listen on, comma-separated (the git store reads one)" },
      { name: "BRAIN_BASE_URL", fallback: "http://localhost:<port>", about: "the address people reach Brain at" },
      { name: "BRAIN_GATEWAY_URL", about: "the address engines reach the model gateway at, when sandboxes cannot use the base address" },
      { name: "BRAIN_STORE_URL", about: "the address runners reach the git store at; without it an attempt that needs the store fails" },
      { name: "BRAIN_PACKS_DIR", fallback: "the packs shipped with Brain", about: "the packs directory" },
      { name: "BRAIN_LOCAL_RUNNER_TOKEN_FILE", about: "where to leave a one-use runner token while no runner is enrolled" },
      { name: "BRAIN_METRICS_TOKEN", about: "the bearer token `GET /metrics` asks for; without it the route answers 404" },
      { name: "BRAIN_COMMIT", about: "the commit this build was made from, shown on Health and in `brain_build_info`" },
      { name: "BRAIN_AUTH_TRUSTED_PROXIES", about: "proxy addresses whose forwarded client address is trusted for sign-in limits" },
      { name: "BRAIN_SMTP_URL", about: "a mail server for invitations and reset links; without it links are only copied" },
      { name: "BRAIN_SMTP_FROM", about: "the sender of that mail" },
      { name: "BRAIN_SMTP_INSECURE", about: "`1` allows a mail connection without encryption" },
      { name: "LOG_LEVEL", fallback: "info", about: "the least level logged: debug, info, warn or error" },
    ],
  },
  {
    title: "Runner", about: "Runs attempts (`apps/runner`). It holds no model key.",
    vars: [
      { name: "BRAIN_GOVERNOR_URL", fallback: "http://127.0.0.1:3100", about: "the Governor's address" },
      { name: "BRAIN_RUNNER_STATE_DIR", fallback: "./.runner-state", about: "the runner's folder" },
      { name: "BRAIN_RUNNER_NAME", fallback: "the host name", about: "the name to enrol under" },
      { name: "BRAIN_RUNNER_ENROLL_TOKEN", about: "the one-use enrolment token, for the first start only" },
      { name: "BRAIN_RUNNER_CAPABILITIES", fallback: "bash", about: "comma-separated capability names the operator declares" },
      { name: "BRAIN_RUNNER_ENGINES", fallback: "fixture", about: "comma-separated engines: fixture, pi, claude, opencode, codex" },
      { name: "BRAIN_RUNNER_FIXTURE_FOR", about: "engines the fixture stands in for: an agent written for one then runs with no model, and its attempts say so" },
      { name: "BRAIN_RUNNER_SLOTS", fallback: "1", about: "attempts at a time" },
      { name: "BRAIN_RUNNER_ATTEMPT_TIMEOUT_SECONDS", fallback: "3600", about: "how long one engine session may run" },
      { name: "BRAIN_RUNNER_SANDBOX_CPU_MILLICORES", fallback: "2000", about: "cpu of an engine sandbox" },
      { name: "BRAIN_RUNNER_SANDBOX_MEMORY_MB", fallback: "4096", about: "memory of an engine sandbox" },
      { name: "BRAIN_LAUNCHER_SOCKET", fallback: "launcher: /tmp/brain-launcher/launcher.sock", about: "the launcher's socket; for a runner, unset means no launcher" },
      { name: "BRAIN_LAUNCHER_TOKEN", about: "the launcher's token (for the launcher: use this one instead of a generated one)" },
      { name: "BRAIN_LAUNCHER_TOKEN_FILE", fallback: "<socket>.token", about: "the file that holds the launcher's token" },
      { name: "BRAIN_OPENCODE_COMMAND", fallback: "opencode acp", about: "the command line of the OpenCode ACP agent" },
      { name: "BRAIN_CODEX_COMMAND", fallback: "codex-acp", about: "the command line of the Codex ACP agent" },
    ],
  },
  {
    title: "Launcher", about: "Starts sandboxes and runs the operator's host commands (`apps/launcher`).",
    vars: [
      { name: "BRAIN_LAUNCHER_ATTEMPTS_ROOT", about: "the runner's `<state>/attempts` folder on this host; without it no sandbox starts" },
      { name: "BRAIN_LAUNCHER_SANDBOX_USER", fallback: "the launcher's own", about: "`uid:gid` sandboxes run as: the owner of the attempt folders" },
      { name: "BRAIN_LAUNCHER_EGRESS_GRANTS_DIR", about: "where the egress proxy reads its grants; without it no sandbox gets a network" },
      { name: "BRAIN_LAUNCHER_HOST_COMMANDS", about: "the operator's host-command file, which limits the host commands offered" },
      { name: "BRAIN_LAUNCHER_IMAGE_DIGESTS", about: "image pins, `name=sha256:...,name=sha256:...`" },
      { name: "BRAIN_LAUNCHER_ENGINE_IDLE_MS", fallback: "90000", about: "how long an engine sandbox may go unspoken to before it is stopped" },
    ],
  },
  {
    title: "Egress proxy", about: "The only way a sandbox reaches a network (`apps/launcher/src/egress-proxy.ts`).",
    vars: [
      { name: "BRAIN_PROXY_PORT", fallback: "18080", about: "the port it listens on" },
      { name: "BRAIN_EGRESS_GRANTS_DIR", fallback: "/grants", about: "the grants it reads" },
      { name: "BRAIN_EGRESS_ALLOW_INTERNAL", about: "comma-separated `host` or `host:port` entries that may resolve to private addresses" },
    ],
  },
  {
    title: "Git store", about: "Holds the work one attempt leaves for the next (`apps/store`). It also reads `PORT` (default 3110) and `BRAIN_BIND_HOST`.",
    vars: [
      { name: "BRAIN_STORE_DIR", about: "where the repositories are kept (required)" },
      { name: "BRAIN_STORE_PUBLIC_KEY_FILE", about: "the Governor's `store.pub` (required)" },
    ],
  },
  {
    title: "MCP server", about: "For a person's own Claude (`apps/mcp`).",
    vars: [
      { name: "BRAIN_URL", about: "the address of Brain" },
      { name: "BRAIN_EMAIL", about: "the account to sign in as" },
      { name: "BRAIN_PASSWORD", about: "its password" },
      { name: "BRAIN_MCP_ENV_FILE", about: "a dotenv file to read the three above from; values of the environment win" },
      { name: "BRAIN_LIVE_ADMIN_EMAIL", about: "read from that file as the account too" },
      { name: "BRAIN_LIVE_ADMIN_PASSWORD", about: "read from that file as its password too" },
      { name: "BRAIN_MCP_READONLY", about: "`1` serves only the read tools" },
      { name: "BRAIN_MCP_METRICS_ENV_FILE", about: "a dotenv file with the metrics address and sign-in" },
      { name: "VM_URL", about: "VictoriaMetrics address, for the metric tools" },
      { name: "VM_USER", about: "its user" },
      { name: "VM_PASS", about: "its password" },
    ],
  },
  {
    title: "Set by Brain", about: "Brain sets these for the processes it starts; an operator never does.",
    vars: [
      { name: "BRAIN_SECRET_<NAME>", about: "a leased secret, in the environment of one tool run" },
      { name: "BRAIN_MODEL_URL", about: "the model gateway, for the commands of an agent with `model_in_commands`" },
      { name: "BRAIN_MODEL_TOKEN", about: "the attempt's token, with it" },
      { name: "BRAIN_MODEL_NAME", about: "the model route to ask for, with it" },
      { name: "BRAIN_MODEL_API", about: "the kind of API of that route, with it" },
      { name: "BRAIN_ENGINE_HOST", about: "`1` inside an engine sandbox" },
      { name: "BRAIN_MCP_URL", about: "the tool bridge, for the stdio relay of an ACP agent" },
      { name: "BRAIN_MCP_TOKEN", about: "its token" },
      { name: "BRAIN_STORE_GOAL", about: "the goal a push may write under, for the git store's hook" },
      { name: "BRAIN_STORE_ATTEMPT", about: "the attempt that pushes, for the same hook" },
    ],
  },
];

/** The page `docs/environment.md`. */
export function environmentDoc(): string {
  const table = (vars: readonly EnvVar[]): string => ["| Variable | Default | What it does |", "|---|---|---|", ...vars.map((one) => `| \`${one.name}\` | ${one.fallback ?? ""} | ${one.about} |`)].join("\n");
  return `# Environment variables\n\nWritten from \`packages/contracts/src/env.ts\` by \`pnpm docs:gen\`. Do not edit it here.\n\n${ENVIRONMENT.map((group) => `## ${group.title}\n\n${group.about}\n\n${table(group.vars)}`).join("\n\n")}\n`;
}
