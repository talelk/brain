# Keyrus Brain

Brain helps teams investigate issues, draft support responses and advance work through
reviewed workflows. Start with an outcome, follow progress and review the independently
checked result. Proposed external actions still require their declared approvals.

## Start

Requirements: Linux, Node 24, pnpm 12.11.2, Python 3, Bash, curl, Docker and a reachable
self-hosted OpenAI-compatible model endpoint. Run from this checkout:

```bash
rtk pnpm install --frozen-lockfile
rtk pnpm brain start
```

Open the printed URL. A fresh installation creates:

- `admin@brain.local` with the default local password `admin-password`; no password change is required.
- **My workspace**, with **Investigate an operational issue** and **Draft a support response**.
- The agents, governed context tool and independent validator those tasks need.
- TencentDB Agent Memory Core, Knowledge, Proxy and Panel, with administration at **http://localhost:8125**.
- Two scoped runners: Pi for authoring agents and Claude Code for the evaluator group. The default model is paired during initialization.

Set `BRAIN_ADMIN_EMAIL` and `BRAIN_ADMIN_PASSWORD` before initialization to use different
credentials, especially if Governor is exposed beyond the local host. **Administration → Setup**
can replace the default model URL, exact model ID and credential. Use the installation
test in the setup checklist to verify execution. **Administration → Integrations** opens
the TencentDB Memory UI without forwarding Brain credentials. Startup fails rather than
silently using local memory when the managed TencentDB stack is unavailable.

## Do work

From Today, select **Start a task**. Three entry points share the same review and start flow:

- **Ask Brain:** describe your goal and review a proposed existing task. Conversation alone never starts that task.
- **Choose a task:** complete a short form or use an example, review the inputs, then start.
- **From a work item:** open a card, ticket or incident and start a task with known information prefilled. Its run remains linked to the item.

Activity shows progress and results. Evidence explains independent validation. The supplied
context tool is a local demonstration, not a production connection. Support responses
remain drafts; these starter tasks do not send messages or execute remediation.

## Operate the local instance

```bash
rtk pnpm brain status
rtk pnpm brain logs
rtk pnpm brain stop
rtk pnpm brain backup /path/to/new-backup
```

State defaults to `~/.local/share/brain`; set `BRAIN_INSTANCE_DIR` to use another private
instance directory outside the checkout. Restart preserves accounts, workspaces, model
settings and runner identities. Administration includes setup, health, access management
and a redacted diagnostics download. Claude and custom deployment topologies use the
[advanced configuration reference](docs/howto/configuration-reference.md).

## Reset all local state

```bash
rtk pnpm brain reset
# For an explicitly unattended reset:
rtk pnpm brain reset --yes
rtk pnpm brain start
```

Reset stops the managed processes and erases the instance's accounts, workspaces,
releases, runs, artifacts, conversations, model settings, credentials and logs. It requires
terminal confirmation, or `--yes`. The next start creates a new administrator and populated
workspace. The checkout, sandbox images, backups and unrelated files are preserved.
Reset does not undo actions already applied to external systems.
Reset refuses linked paths, external managed directories, unresolved processes and active
Governor writers. It operates only on a registered local instance.

To restore a verified local archive after reset, use `rtk pnpm brain restore /path/to/backup`.
Restore requires a fresh data directory and leaves execution suspended for reconciliation;
it does not silently reactivate old credentials, approvals or external effects.

## Guides and verification

[Using Brain](docs/howto/use-brain.md) · [Administration and authoring](docs/howto/README.md)
· [Backup and restore](docs/howto/backup-restore.md) · [Implementation architecture](IMPLEMENTATION.md)

```bash
rtk pnpm verify:full
rtk node --import tsx scripts/verify-local-setup.ts
```

The local setup proof uses a live model and Docker, preserves failure evidence and stops
its owned processes. Model output structure checks do not establish semantic accuracy or
production connector readiness. Formal usability sessions and independent certification
are separate from automated workflow verification.
