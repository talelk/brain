# 27. The database replica is a snapshot loop shipped to a second host

Status: accepted, 2026-11-13. Does not replace the nightly encrypted backup; it narrows the recovery point.

## Decision
1. **In-process snapshot loop.** When `BRAIN_REPLICA_DIR` is set, the Governor writes, every `BRAIN_REPLICA_INTERVAL_SECONDS` (default 60), an online snapshot of every SQLite database and the key file into the replica directory, in the existing `brain.local-backup/v1` format (so `maintenance verify` and `restore` already understand it), without the directory lock a running Governor holds. The content-addressed store is immutable, so it is mirrored separately, copying only files the replica lacks. The newest three snapshots are kept.
2. **A host timer ships the directory** to the second host over ssh (`deploy/demo/replica/ship-replica.sh`, every minute) and then writes `shipped.json` with the snapshot that arrived.
3. **Replica lag is the age of the newest snapshot on the second host** (the local snapshot when no shipper is configured). Health shows it as the `replica` line (healthy to 5 minutes, degraded to 15, critical past that, all configurable), the owner is told once when it turns bad, and `/metrics` exposes `brain_replica_lag_seconds` for the alert rule.
4. **Failover is a restore.** `maintenance restore-replica <replica-dir> <empty-data-dir>` verifies the newest complete snapshot (every digest, every integrity check), restores it suspended (sessions and credentials revoked, execution off until an operator resumes) and restores the mirrored store. A damaged copy restores nothing.
5. **Nothing happens without configuration.** The deploy script wires the replica only when `replica.env` exists on the server; the compose file passes empty values otherwise.

## Honest limits
The recovery point is the interval plus the shipping delay (minutes), not zero, and databases are snapshotted one after another, so a failover can show a control row a few seconds newer or older than its workspace rows; the suspended restore and the reconciler handle that as they do a crash. A WAL-shipping sidecar (Litestream) would give seconds; it needs a binary and a bucket or second host, so it is a backlog row, chosen only if the measured loss matters. SQLite stays (see `docs/howto/load-and-capacity.md`).
