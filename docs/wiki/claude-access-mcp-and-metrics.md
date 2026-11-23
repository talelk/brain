# Claude access: the Brain MCP and Brain's metrics

Dated record. Claims name the commit they were true at; nothing here describes the present.

- On 2026-11-23, the user asked to plan from and optimise Brain from their own Claude, and to give Claude Brain's performance data from VictoriaMetrics (request through `/chief-of-staff`).
- As of `talelk/brain@40fd23f6`, `apps/mcp` is a stdio MCP server run on the user's PC. It signs in with the existing session (no personal API token exists) using `BRAIN_MCP_ENV_FILE`, and leaves out approvals, memory decisions, secrets and users on purpose. See `apps/mcp/README.md`.
- On 2026-11-23, it was registered in the user's Claude at user scope as `brain` and showed Connected.
- As of `talelk/brain@40fd23f6`, the Governor has `GET /metrics` (bearer `BRAIN_METRICS_TOKEN`, 404 when unset or behind the proxy headers) and the deploy adds a marked scrape job to the host's `vmagent.yml`. On 2026-11-23 a deploy of it was held for the user's approval, because that file belongs to another stack on the host.
- On 2026-11-23, `https://victoria.mykeyrus.tn/vm/` answered a read query through basic auth, the user supplied the login in chat. The host's own `/login` page covers the other paths. The login is not stored in this repository.
- On 2026-11-23, the cleanup pass found the codebase already clean: 10 unused i18n keys, 3 CSS lines and 89 needless exports removed. `pnpm typecheck:web` was not part of `pnpm verify` and had hidden 2 type errors; it is now.
- On 2026-11-23, the user approved the metrics deploy and it ran: vmagent on the host scraped \`brain-governor\` (\`up\` was 1, \`brain_runner_slots\` was 8 in VictoriaMetrics).
- On 2026-11-23, \`brain_metrics_names\`, \`brain_metrics_query\` and \`brain_metrics_range\` were added to the Brain MCP, reading the login from \`~/.config/brain-dev/victoria.env\` (mode 600, outside the repository), since the official VictoriaMetrics MCP documents no basic auth. They answered live queries.
