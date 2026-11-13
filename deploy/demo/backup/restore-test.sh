#!/usr/bin/env bash
# Monthly timed restore rehearsal: fetch the newest backup, verify its checksum, decrypt, open every database and
# run an integrity check, all in a scratch directory. Exits non-zero (and writes the result) when it takes more
# than 30 minutes or any check fails. Never touches the live data.
set -euo pipefail
ROOT="${BRAIN_DEPLOY_DIR:-/srv/demos/brain}"
[ -r "$ROOT/backup.env" ] && { set -a; . "$ROOT/backup.env"; set +a; }
: "${BRAIN_BACKUP_HOST:?set BRAIN_BACKUP_HOST in $ROOT/backup.env}"
BUSER="${BRAIN_BACKUP_USER:-brain-backup}"; BDIR="${BRAIN_BACKUP_DIR:-/srv/brain-backups}"; KEY="$ROOT/backup.key"
LIMIT_SECONDS="${BRAIN_RESTORE_LIMIT_SECONDS:-1800}"
START="$(date +%s)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT; chmod 700 "$WORK"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=20 $BUSER@$BRAIN_BACKUP_HOST"
LATEST="$($SSH "ls -1 $BDIR/nightly/brain-*.tar.enc | sort | tail -n 1")"
rsync -a "$BUSER@$BRAIN_BACKUP_HOST:$LATEST" "$BUSER@$BRAIN_BACKUP_HOST:$LATEST.sha256" "$WORK/"
FILE="$WORK/$(basename "$LATEST")"
[ "$(sha256sum "$FILE" | cut -d' ' -f1)" = "$(cat "$FILE.sha256")" ] || { echo "checksum mismatch" >&2; exit 1; }
openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$KEY" -in "$FILE" -out "$WORK/payload.tar"
tar -C "$WORK" -xf "$WORK/payload.tar"
COUNT=0
for db in "$WORK/databases/control.db" "$WORK"/databases/workspaces/*.db; do
  [ -e "$db" ] || continue
  RESULT="$(node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync(process.argv[1],{readOnly:true}); console.log(d.prepare('PRAGMA integrity_check').get().integrity_check)" "$db")"
  [ "$RESULT" = ok ] || { echo "integrity check failed for $db: $RESULT" >&2; exit 1; }
  COUNT=$((COUNT+1))
done
[ "$COUNT" -ge 1 ] || { echo "no databases in the backup" >&2; exit 1; }
ELAPSED=$(( $(date +%s) - START ))
mkdir -p "$ROOT/run"
echo "{\"backup\":\"$(basename "$LATEST")\",\"databases\":$COUNT,\"seconds\":$ELAPSED,\"at\":\"$(date -u +%FT%TZ)\"}" > "$ROOT/run/last-restore-test.json"
[ "$ELAPSED" -le "$LIMIT_SECONDS" ] || { echo "restore took ${ELAPSED}s, over the ${LIMIT_SECONDS}s limit" >&2; exit 1; }
echo "restore rehearsal ok: $COUNT databases in ${ELAPSED}s"
