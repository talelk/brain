# 39. Health reads what the host recorded about backups

Status: accepted, 2026-11-15. Spec #90, stories 96 and 97.

Backups are taken by the host (the nightly job in `deploy/demo/backup`, `maintenance backup`, the replica shipper), not by the Governor. Health must still say whether they work.

## Decision
1. **The Governor never runs or schedules a backup.** The host job records its finish time in `BRAIN_BACKUP_STAMP_FILE` (epoch seconds, already read for `/metrics`) and each restore rehearsal writes `BRAIN_RESTORE_TEST_FILE` (JSON: `ok`, `at`, `backup`, `databases`, `seconds`; `restore-test.sh` writes it on failure too). The Governor only reads them, as the `backup` and `restore-test` health checks beside `replica`.
2. **No record is a warning, not a pass.** Unset: `disabled` and says how to turn it on. Set but empty or unreadable: `degraded`. A backup older than `BRAIN_BACKUP_STALE_SECONDS` (default 36 hours, the `BrainBackupStale` alert's line) is `degraded` (stale), past three times that `unavailable`. A restore test that failed is `unavailable`; one older than 40 days is `degraded`. A bad check alerts the workspace owner once, like every health check.
3. **The diagnostics bundle is allowlisted** (`brain.redacted-diagnostics/v2`): each field is named in `operations/diagnostics.ts`; nothing is copied from a record or the environment and scrubbed. Free text written by agents, runners or people (task diagnostics, attempt errors, titles, messages) is left out; failures appear as classes, codes and ids. The Governor's own sentences still pass the credential redactor.

## Limits
- Health trusts the stamp: a host that writes it without a good backup is not detected. The restore test is the check on that.
- A restore test is only as current as the host's timer; the Governor cannot start one.
