# 25. Forward-only schema migrations: built, not yet policy

Status: proposed, 2026-11-13. Not active until the owner changes the implementation policy (backlog row 74).

Teams will hold data that must be kept, and some changes (a renamed column or table) cannot be made by adding a column with a default, which is all `repair-live-schema` does. The policy in `AGENTS.md` and `contracts/v1/implementation-policy.json` still says no migration work, so this ADR proposes the path and ships the runner as an additive capability with an empty list. Neither file was edited.

## Decision
1. **Numbered, ordered, forward only.** `Migration { id, name, database: control | workspace, sql | run }`, ids 1..n with no gaps. A `workspace` migration runs once on every workspace database. There is no down migration; recovery is the pre-deploy snapshot.
2. **One transaction per migration**, immediate, with its record, so a migration is either applied and recorded or not there at all. Table rebuilds that need foreign keys off declare it, and a clean `foreign_key_check` is required before commit.
3. **Recorded in `schema_migrations`** (id, name, checksum, time) in each database. The runner creates the table itself, only when a migration is pending; it is not in `control.sql`, so an empty list changes no database.
4. **Refuses to guess.** A database that records a migration the build does not know (newer than the code), or whose text changed after it was applied, is refused with nothing changed. Migrations are never edited, only added.
5. **The pre-deploy snapshot check stays.** `maintenance migrate <data-dir>` first copies every database (`VACUUM INTO`) and migrates the copies; only if all succeed does it touch the real files. `--check` stops after the trial. It needs the directory lock, so the Governor is stopped.
6. **Deploy order when activated:** snapshot check (as today), backup, stop, `maintenance migrate`, `repair-live-schema` for plain additions, start.

## What is built today
`infrastructure/persistence/migrations.ts` and the `maintenance migrate` command, with `MIGRATIONS = []`. Nothing calls it from startup, `initialize-local`, `repair-live-schema` or the deploy script; fresh initialization is unchanged. Tests use fixture lists.

## To activate
The owner edits the policy (row 74), then renames land as numbered entries in `MIGRATIONS` and the deploy script runs step 6. Until then schema changes keep the add-with-default rule.

Rejected: an ORM migration tool (a second schema authority beside the schema files); automatic migrate on boot (a crash loop on a bad migration, no snapshot check).
