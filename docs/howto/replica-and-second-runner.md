# Replica and second runner host

Decisions: ADR 0027 (replica). Both are off until you configure them; nothing in a deploy changes without them.

## Database replica to a second host
1. On the second host create user `brain-replica` with `/srv/brain-replica`, allow the demo server's SSH key, install Node 24 and pnpm and put a checkout of the same version at `/srv/brain-src`.
2. On the demo server write `BRAIN_REPLICA_HOST=<host>` (optional `BRAIN_REPLICA_USER`, `BRAIN_REPLICA_REMOTE_DIR`) to `/srv/demos/brain/replica.env`, then run `scripts/deploy-demo.sh`. It adds `BRAIN_REPLICA_DIR=/replica` to `.env`, mounts `/srv/demos/brain/replica`, and installs `brain-replica-ship.timer` (every minute). Optional: `BRAIN_REPLICA_INTERVAL_SECONDS` (60), `BRAIN_REPLICA_WARN_SECONDS` (300), `BRAIN_REPLICA_CRITICAL_SECONDS` (900).
The replica carries `authority.keys` and `secrets/` unencrypted: the second host must be as trusted as the primary.
3. Health shows a `replica` line: the age of the newest snapshot that reached the second host. Degraded means the shipping timer or the link needs a look (`journalctl -u brain-replica-ship`); critical means a failover now would lose more than 15 minutes.

**Fail over** (the primary is gone or unusable). On the second host, from the checkout:
`deploy/demo/replica/restore-from-replica.sh /srv/brain-replica /srv/brain-restored/data`. It verifies the newest complete snapshot and refuses a damaged copy. Start a Governor with `BRAIN_DATA_DIR=/srv/brain-restored/data` (same version, same `BRAIN_BASE_URL`). The restored data is suspended: all sessions and runner credentials are revoked and nothing executes until an administrator signs in, re-enrolls the runners if they are refused, and resumes. Work after the last snapshot is lost. Rehearse it on a copy before relying on it; the restore time is the replica's size.

## A second runner host
A runner pulls work, so a second host only needs to reach the Governor over https and run its own trusted launcher.
1. In Brain (or `brain runner token create --group agents`) create an enrollment token for the group; save it to a 0600 file on the new host.
2. On the new host, from a checkout of the same version: `deploy/demo/runner-host/enroll-runner-host.sh --governor-url https://… --token-file ~/runner.token --id runner-agents-2 --group agents --slots 3 --host-label beta`. It writes a private env file and a unit and prints the remaining steps (install the unit, run the launcher). It never prints the token.
3. Health, `runners`, shows the new total of slots. Work spreads over both hosts, each slot is used once, and a host that stops answering loses its attempts to the other after the lease expires. To take a host out, set its runner to draining. Host tools (`host.*`) stay on the runner group the owner marked for them; a new host does not get them unless it joins that group.
