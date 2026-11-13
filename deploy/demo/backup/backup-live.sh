#!/usr/bin/env bash
# Nightly encrypted backup of the live Brain data to a second host. Runs ON the demo server (systemd timer).
#   * consistent snapshot of every SQLite database (VACUUM INTO, never a copy of a live file)
#   * the other files of the data volume (artifacts, evidence) from the same container
#   * AES-256 encryption with a key that never leaves this host and the owner's safe (/srv/demos/brain/backup.key)
#   * copy to BRAIN_BACKUP_HOST; keep 14 nightly + 8 weekly (Sundays) there
# Env (from /srv/demos/brain/backup.env): BRAIN_BACKUP_HOST (required), BRAIN_BACKUP_USER, BRAIN_BACKUP_DIR.
set -euo pipefail
ROOT="${BRAIN_DEPLOY_DIR:-/srv/demos/brain}"
[ -r "$ROOT/backup.env" ] && { set -a; . "$ROOT/backup.env"; set +a; }
: "${BRAIN_BACKUP_HOST:?set BRAIN_BACKUP_HOST in $ROOT/backup.env}"
BUSER="${BRAIN_BACKUP_USER:-brain-backup}"
BDIR="${BRAIN_BACKUP_DIR:-/srv/brain-backups}"
KEY="$ROOT/backup.key"
SRC="$ROOT/src"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT; chmod 700 "$WORK"

[ -s "$KEY" ] || { umask 077; openssl rand -base64 32 > "$KEY"; echo "created $KEY: store a copy of it in the owner's password manager, backups cannot be restored without it" >&2; }

GOV="$(cd "$ROOT" && docker compose ps -q governor)"
[ -n "$GOV" ] || { echo "governor container is not running" >&2; exit 1; }
docker exec -i "$GOV" node --input-type=module - < "$SRC/scripts/snapshot-live-dbs.mjs" >/dev/null
docker cp "$GOV:/tmp/precheck-snap" "$WORK/databases"
docker exec "$GOV" rm -rf /tmp/precheck-snap
# Everything in /data that is not a database file (artifact and evidence stores).
docker exec "$GOV" sh -c 'cd /data && find . -type f ! -name "*.db" ! -name "*.db-wal" ! -name "*.db-shm" -print0 | tar --null -T - -cf -' > "$WORK/files.tar" || true

tar -C "$WORK" -cf "$WORK/payload.tar" databases files.tar
ARCHIVE="brain-$STAMP.tar.enc"
openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEY" -in "$WORK/payload.tar" -out "$WORK/$ARCHIVE"
sha256sum "$WORK/$ARCHIVE" | cut -d' ' -f1 > "$WORK/$ARCHIVE.sha256"

SSH="ssh -o BatchMode=yes -o ConnectTimeout=20 $BUSER@$BRAIN_BACKUP_HOST"
$SSH "mkdir -p $BDIR/nightly $BDIR/weekly"
rsync -a --partial "$WORK/$ARCHIVE" "$WORK/$ARCHIVE.sha256" "$BUSER@$BRAIN_BACKUP_HOST:$BDIR/nightly/"
if [ "$(date -u +%u)" = 7 ]; then
  $SSH "cd $BDIR && cp nightly/$ARCHIVE nightly/$ARCHIVE.sha256 weekly/"
fi
# Retention: 14 nightly, 8 weekly.
$SSH "cd $BDIR/nightly && ls -1 brain-*.tar.enc | sort | head -n -14 | while read f; do rm -f \"\$f\" \"\$f.sha256\"; done
      cd $BDIR/weekly && ls -1 brain-*.tar.enc | sort | head -n -8 | while read f; do rm -f \"\$f\" \"\$f.sha256\"; done"
date -u +%s > "$ROOT/run/last-backup-ok"
echo "backup $ARCHIVE done"
