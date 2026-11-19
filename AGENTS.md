# Workspace instructions

@/home/talel/.codex/RTK.md

Explicitly read `/home/talel/.codex/RTK.md`; do not assume an assistant expands the
`@file` line.

## The model comes first

`docs/model.md` is the whole product model: workspace, project, agent, tool, Play,
memory, pack, task. `docs/architecture.md` is how it is built. `GLOSSARY.md` fixes the
words. If a change needs a concept that is not in `docs/model.md`, change the model page
first, and only when a real use needs it.

Keep it small. `pnpm verify` runs `scripts/complexity.mjs`, which fails when the number
of tables, commands and queries, glossary terms or screens passes the budget in
`docs/complexity.json`. Raise a budget only with the reason in the commit.

## Architecture

One Governor process (API and web app) with one SQLite file, and separate runner,
launcher and git store executables for isolation. Only `packages/contracts` is shared. Configuration is
plain files in a workspace folder; the Governor never stores an agent, tool or Play in
the database. Every state change appends to the audit chain in the same transaction.

## Implementation policy — until the user explicitly changes it

Build the current target directly. Backward or forward compatibility, data or
configuration migration, compatibility shims, legacy aliases, dual paths and deprecated
wrappers are out of scope. Remove code the model no longer needs in the same change that
makes it unneeded. Breaking changes across modules, contracts, schema, callers and tests
are allowed.

Tests check the model. Add a test only for behaviour named in `docs/model.md` or
`docs/architecture.md`; delete a test when its behaviour is removed.

Preserve unrelated user changes and existing user data; this policy does not authorize
deleting or resetting data that is not disposable.

## Agent skills

### Issue tracker

GitHub Issues on `talelk/brain`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, used as-is (`needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root, the model in `docs/model.md`. See
`docs/agents/domain.md`.
