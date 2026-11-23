# Brain MCP server

A stdio MCP server for your own Claude (Claude Code): plan work in a live Brain and optimise it. It talks to Brain over its
HTTP API as you (the same sign-in, roles and audit as the web app); it adds no command or query to Brain. Design: `docs/architecture.md`, section 12.

## Register

From a checkout with `pnpm install` done (replace `<repo>`):

```sh
claude mcp add brain --scope user \
  -e BRAIN_URL=https://brain.mykeyrus.tn \
  -e BRAIN_MCP_ENV_FILE=$HOME/.config/brain-dev/credentials.env \
  -- <repo>/node_modules/.bin/tsx <repo>/apps/mcp/src/main.ts
```

No build step: `tsx` runs the TypeScript directly.

## Configuration (environment)

| Name | Meaning |
| --- | --- |
| `BRAIN_URL` | Address of Brain. |
| `BRAIN_EMAIL`, `BRAIN_PASSWORD` | The account to sign in as. |
| `BRAIN_MCP_ENV_FILE` | A dotenv file to read the above from; `BRAIN_LIVE_ADMIN_EMAIL` and `BRAIN_LIVE_ADMIN_PASSWORD` are read as the account too. Environment values win. |
| `BRAIN_MCP_READONLY=1` | Serve only the read tools. |

Credentials are never printed or logged. What the account can do is what its roles allow; prefer a member account to an admin one
unless you want the configuration tools.

## Tools

Read (all `readOnlyHint`): `brain_overview`, `brain_queue`, `brain_insights`, `brain_workspaces`, `brain_workspace_files`,
`brain_file_read`, `brain_tasks_list`, `brain_task_get`, `brain_task_events`, `brain_packs_list`, `brain_audit_verify`, `brain_schedules_list`.

Work: `brain_task_create` (a goal, or a Play with inputs), `brain_task_steer`, `brain_task_stop`, `brain_task_retry`, `brain_task_check`,
`brain_task_answer`, `brain_task_checkpoint`.

Optimise: `brain_file_write`, `brain_file_delete` (agents, tools, Plays, memory, `brain.toml`; one commit, refused whole when the folder
would be invalid), `brain_pack_release`, `brain_workspace_create`, `brain_workspace_archive`.

Left out on purpose: approving calls, deciding memory proposals, users and secrets. Those stay with a person in the web app.

Each tool takes the input of the matching command or query in `packages/contracts/src/api.ts` (workspace ids as `brain_workspaces`
shows them). Long text and lists in answers are cut and say so.

## Optimising loop

Read `brain_insights` and failed or `needs_you` tasks, open the worst with `brain_task_get` and `brain_task_events`, read the agent,
tool or Play behind it with `brain_file_read`, change a small thing with `brain_file_write`, run a task to verify, and compare.
