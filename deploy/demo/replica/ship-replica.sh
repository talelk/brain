#!/usr/bin/env bash
# Ships the Governor's replica directory to the second host (ADR 0027). Runs ON the demo server from a systemd timer, every minute.
# The Governor writes snapshots of every database into $ROOT/replica; this copies them over ssh and then records, in
# $ROOT/replica/shipped.json, the snapshot that is now safe on the second host. Health reports the age of THAT snapshot as replica lag.
# Env (from /srv/demos/brain/replica.env): BRAIN_REPLICA_HOST (required), BRAIN_REPLICA_USER, BRAIN_REPLICA_REMOTE_DIR.
set -euo pipefail
ROOT="${BRAIN_DEPLOY_DIR:-/srv/demos/brain}"
[ -r "$ROOT/replica.env" ] && { set -a; . "$ROOT/replica.env"; set +a; }
: "${BRAIN_REPLICA_HOST:?set BRAIN_REPLICA_HOST in $ROOT/replica.env}"
RUSER="${BRAIN_REPLICA_USER:-brain-replica}"
RDIR="${BRAIN_REPLICA_REMOTE_DIR:-/srv/brain-replica}"
LOCAL="$ROOT/replica"
[ -s "$LOCAL/replica-status.json" ] || { echo "no replica snapshot yet in $LOCAL" >&2; exit 1; }

# What this run will have shipped: read BEFORE copying, so the record never claims a newer snapshot than the one that was copied.
SNAPSHOT_AT="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).snapshotAtMs))' "$LOCAL/replica-status.json")"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=20 $RUSER@$BRAIN_REPLICA_HOST"
$SSH "mkdir -p $RDIR"
# Content-addressed files first (never rewritten), then the snapshots, so a snapshot never lands before the files it refers to.
rsync -a --partial --ignore-existing -e "ssh -o BatchMode=yes -o ConnectTimeout=20" "$LOCAL/cas/" "$RUSER@$BRAIN_REPLICA_HOST:$RDIR/cas/" || [ ! -d "$LOCAL/cas" ]
rsync -a --partial --delete --exclude shipped.json --exclude cas/ -e "ssh -o BatchMode=yes -o ConnectTimeout=20" "$LOCAL/" "$RUSER@$BRAIN_REPLICA_HOST:$RDIR/"
TMP="$LOCAL/shipped.json.$$"
printf '{"shippedSnapshotAtMs":%s,"shippedAtMs":%s}\n' "$SNAPSHOT_AT" "$(( $(date +%s) * 1000 ))" > "$TMP"
mv "$TMP" "$LOCAL/shipped.json"
echo "replica shipped: snapshot $SNAPSHOT_AT to $BRAIN_REPLICA_HOST"
