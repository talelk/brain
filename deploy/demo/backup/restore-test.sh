#!/usr/bin/env bash
# Monthly restore rehearsal: fetch the newest backup, verify its checksum, decrypt it, restore it into a scratch folder (what
# `pnpm brain restore` does) and verify the audit log of the restored data (`pnpm brain audit-verify`). Exits non-zero when any step fails
# or the whole takes more than 30 minutes; the unit's state and journal are the record. It never touches the live data.
set -euo pipefail
ROOT="${BRAIN_DEPLOY_DIR:-/srv/demos/brain}"
[ -r "$ROOT/backup.env" ] && { set -a; . "$ROOT/backup.env"; set +a; }
: "${BRAIN_BACKUP_HOST:?set BRAIN_BACKUP_HOST in $ROOT/backup.env}"
BUSER="${BRAIN_BACKUP_USER:-brain-backup}"; BDIR="${BRAIN_BACKUP_DIR:-/srv/brain-backups}"; KEY="$ROOT/backup.key"
LIMIT_SECONDS="${BRAIN_RESTORE_LIMIT_SECONDS:-1800}"
START="$(date +%s)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT; chmod 700 "$WORK"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=20 $BUSER@$BRAIN_BACKUP_HOST"
LATEST="$($SSH "ls -1 $BDIR/nightly/brain-*.tar.gz.enc | sort | tail -n 1")"
rsync -a "$BUSER@$BRAIN_BACKUP_HOST:$LATEST" "$BUSER@$BRAIN_BACKUP_HOST:$LATEST.sha256" "$WORK/"
FILE="$WORK/$(basename "$LATEST")"
[ "$(sha256sum "$FILE" | cut -d' ' -f1)" = "$(cat "$FILE.sha256")" ] || { echo "checksum mismatch" >&2; exit 1; }
openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$KEY" -in "$FILE" -out "$WORK/brain.tar.gz"
# A scratch Brain of its own: its own folders, and a port nothing listens on, so the live one is neither seen nor touched.
export BRAIN_HOME="$WORK/home" BRAIN_DATA_DIR="$WORK/home/data" BRAIN_RUN_DIR="$WORK/home/run" BRAIN_PORT=39173
cd "$ROOT/src"
node --import tsx scripts/brain.ts restore "$WORK/brain.tar.gz"
node --import tsx scripts/brain.ts audit-verify
ELAPSED=$(( $(date +%s) - START ))
[ "$ELAPSED" -le "$LIMIT_SECONDS" ] || { echo "restore took ${ELAPSED}s, over the ${LIMIT_SECONDS}s limit" >&2; exit 1; }
echo "restore rehearsal ok: $(basename "$LATEST") in ${ELAPSED}s"
