# Backup and restore

For a managed local installation, run from the checkout:

```bash
rtk pnpm brain backup /path/to/new-backup
```

Brain stops its managed processes, creates and verifies the archive, then restarts.
Keep the backup outside the instance's `data`, `run` and `cli` directories so reset
preserves it. To restore into a fresh local data directory after an intentional reset:

```bash
rtk pnpm brain restore /path/to/backup
rtk pnpm brain start
```

Restore verifies the archive first and keeps execution suspended for reconciliation.
It does not overwrite an existing data directory.

## Custom deployments

Maintenance runs on the Governor host inside the Governor executable. The remote CLI
does not open databases or accept arbitrary server paths; its `brain backup` command
prints this guide. Custom deployments can use the lower-level maintenance commands:

```bash
# Stop the Governor and any other writers first.
rtk pnpm --filter @brain/governor maintenance backup /srv/brain/data /srv/backups/brain-20261029
rtk pnpm --filter @brain/governor maintenance verify /srv/backups/brain-20261029
rtk pnpm --filter @brain/governor maintenance restore /srv/backups/brain-20261029 /srv/brain/restored
```

Governor and maintenance contend for the same kernel-held SQLite ownership lock, so a
live Governor makes `backup` fail with `CONFLICT` instead of copying a torn state. A
crash releases ownership automatically. Output directories must be absent or empty,
with existing real parents, separate from the source.

## What is captured

Database files via the SQLite backup API (committed WAL pages included; WAL/SHM and
process ownership files excluded), CAS bytes, pinned releases, engine snapshots.
Verification reads every archived file and checks hashes, SQLite integrity, and foreign
keys; unsafe relative paths, duplicates, links, and special files are refused. Output
is staged privately and published by rename only on success.

The archive's internal `brain.local-backup/v1` framing is deliberately not the product
`brain.backup/v1` manifest, and its completeness is always `partial`: authorized
memory/Wiki/CodeGraph exports and consistent authority watermarks remain separate
requirements. Encrypted off-host backup and RPO/RTO targets are policy choices, not
what these commands claim.

## After a restore

Each restore writes a fresh restore identity. On first open one transaction revokes
old sessions, runner credentials, tokens, grants, approvals and unused permits,
quarantines runners, suspends workspace execution, blocks queued jobs, marks active
attempts outcome-unknown, and parks pending deliveries. Restored workspaces stay
`restore_pending` until controlled reconciliation completes. Do not reset production
data to bypass this state; reconcile external effects before reactivation.

Regression coverage lives in `tests/chaos/backup.test.ts`, `restore.test.ts`, and
`recovery.test.ts`. Objectives and open work are recorded in
`docs/implementation/10-performance-and-operations.md`.
