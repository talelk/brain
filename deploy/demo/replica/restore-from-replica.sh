#!/usr/bin/env bash
# Fail over: rebuild a Brain data directory from the replica copy on the second host (ADR 0027). Run ON the second host, from a checkout
# of this repository (the same version the primary ran), with the Governor stopped everywhere that could write to the target.
#   deploy/demo/replica/restore-from-replica.sh [replica-dir] [target-data-dir]
# Defaults: /srv/brain-replica -> /srv/brain-restored/data. The target must not exist or be empty. The newest COMPLETE snapshot is
# verified (every file digest, every database integrity check) before anything is written; a damaged copy is refused with nothing
# restored. The restored directory is SUSPENDED: sessions and machine credentials are revoked and execution stays off until an
# operator resumes it. Data written after the newest snapshot is lost: the lag Health showed is the size of that loss.
set -euo pipefail
REPLICA="$(realpath "${1:-/srv/brain-replica}")"
TARGET="$(realpath -m "${2:-/srv/brain-restored/data}")"   # absolute: the command below runs from apps/governor
cd "$(dirname "$0")/../../.."
[ -d "$REPLICA/snapshots" ] || { echo "no snapshots in $REPLICA" >&2; exit 1; }
mkdir -p "$(dirname "$TARGET")"
pnpm --filter @brain/governor maintenance restore-replica "$REPLICA" "$TARGET"
echo "restored into $TARGET (suspended). Start a Governor with BRAIN_DATA_DIR=$TARGET, then follow docs/howto/replica-and-second-runner.md to resume it."
