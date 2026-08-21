#!/usr/bin/env bash
#
# Point-in-time backup of the Postgres database.
#
#   ./scripts/backup-database.sh            # take a backup
#   ./scripts/backup-database.sh --verify   # take one, then prove it restores
#
# Reads PG* from the .env sitting next to docker-compose.yml, writes a
# compressed pg_dump to $BACKUP_DIR, and prunes anything older than
# $BACKUP_KEEP_DAYS.
#
# WHY DUMPS AND NOT REPLICATION
# A streaming replica protects against the database server dying. It does
# NOT protect against the data being destroyed: a dropped table, a bad
# migration, or an admin deleting the wrong post replicates to the standby
# within milliseconds, and now it is gone in two places. These dumps are
# the thing that lets you go back to how yesterday looked. Run both if you
# want, but only this one is a backup.
#
# pg_dump runs from the official postgres image so the Pi needs no client
# tools installed, and the image version is pinned so the dump format can't
# drift under you.
set -euo pipefail

APP_DIR="${APP_DIR:-/home/pidocker/sejbosejbo}"
# MUST match the server's major version. pg_dump 17 against this
# PostgreSQL 16 server emits "SET transaction_timeout = 0", a 17-only
# setting, so the dump fails on line 13 of any restore run with
# ON_ERROR_STOP - which is how a careful restore is done. The --verify
# step below discards stderr and does not set ON_ERROR_STOP, so it
# reported success on dumps that a real restore would have rejected.
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
# Used only by the optional media check: it needs the app image (for
# scripts/verify-media.js and lib/storage.js) and the same .env the site
# runs with, so it talks to the same two buckets.
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
APP_IMAGE="${APP_IMAGE:-thekingziga/sejbosejbo:latest}"
VERIFY=false
[ "${1:-}" = "--verify" ] && VERIFY=true

cd "$APP_DIR"

# shellcheck disable=SC1091
set -a; . ./.env; set +a

BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/db-backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/sejbosejbo-$STAMP.sql.gz"

echo "backing up ${PGDATABASE} from ${PGHOST}:${PGPORT:-5432}"

# --clean --if-exists so the dump can be restored straight over an existing
# database. --no-owner because the restoring role may differ.
docker run --rm -e PGPASSWORD="$PGPASSWORD" "$PG_IMAGE" \
  pg_dump -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PGUSER" -d "$PGDATABASE" \
          --clean --if-exists --no-owner \
  < /dev/null | gzip -9 > "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)

# A dump that silently produced nothing is worse than no dump, because it
# looks like success. Check it actually contains the schema.
if ! gunzip -c "$OUT" | grep -q "CREATE TABLE public.uploads"; then
  echo "FAILED: dump does not contain the uploads table - refusing to keep it"
  rm -f "$OUT"
  exit 1
fi

ROWS=$(gunzip -c "$OUT" | grep -c "^COPY public\." || true)
echo "  wrote $OUT ($SIZE, $ROWS tables with data)"

if [ "$VERIFY" = true ]; then
  echo "  verifying by restoring into a throwaway database..."
  TMPDB="verify_$(date +%s)"
  docker run --rm -e PGPASSWORD="$PGPASSWORD" "$PG_IMAGE" \
    psql -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PGUSER" -d "$PGDATABASE" \
         -tAc "CREATE DATABASE $TMPDB" < /dev/null > /dev/null
  # shellcheck disable=SC2064
  trap "docker run --rm -e PGPASSWORD='$PGPASSWORD' $PG_IMAGE psql -h '$PGHOST' -p '${PGPORT:-5432}' -U '$PGUSER' -d '$PGDATABASE' -tAc 'DROP DATABASE IF EXISTS $TMPDB' < /dev/null > /dev/null" EXIT

  # ON_ERROR_STOP and a visible stderr: a verify that hides errors is not
  # a verify. Restores are done this way, so this has to be too.
  if ! gunzip -c "$OUT" | docker run --rm -i -e PGPASSWORD="$PGPASSWORD" "$PG_IMAGE" \
    psql -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PGUSER" -d "$TMPDB" -q -v ON_ERROR_STOP=1 > /dev/null; then
    echo "  VERIFY FAILED: the dump did not restore cleanly" >&2
    exit 1
  fi

  COUNTS=$(docker run --rm -e PGPASSWORD="$PGPASSWORD" "$PG_IMAGE" \
    psql -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PGUSER" -d "$TMPDB" -tAc \
    "SELECT 'uploads=' || (SELECT COUNT(*) FROM uploads) || ' votes=' || (SELECT COUNT(*) FROM votes) || ' comments=' || (SELECT COUNT(*) FROM comments) || ' visits=' || (SELECT value FROM counters WHERE key='visits')" < /dev/null)
  echo "  restored copy contains: $COUNTS"
fi

# A database dump is only half the backup. User media lives in the two S3
# buckets, and mirror writes are best-effort - a failed one is logged and
# never retried, so the mirror drifts silently and you find out on the day
# you need it. Check it here, where "did the backup work?" is already the
# question being asked.
#
# Off by default because it costs two HEAD requests per object against a
# remote bucket. Set VERIFY_MEDIA=true in the cron entry to turn it on, and
# MEDIA_REPAIR=true to heal drift instead of only reporting it.
if [ "${VERIFY_MEDIA:-false}" = true ]; then
  echo "  verifying media in both buckets..."
  MEDIA_ARGS="--quiet"
  [ "${MEDIA_REPAIR:-false}" = true ] && MEDIA_ARGS="--quiet --repair"
  # shellcheck disable=SC2086
  if MEDIA_OUT=$(docker run --rm --env-file "$ENV_FILE" "$APP_IMAGE" \
      node scripts/verify-media.js $MEDIA_ARGS 2>&1); then
    echo "  media: $MEDIA_OUT"
  else
    echo "  MEDIA DRIFT: $MEDIA_OUT" >&2
    MEDIA_DRIFT=true
  fi
fi

# Prune old backups. -mtime +N is strictly older than N days.
DELETED=$(find "$BACKUP_DIR" -name 'sejbosejbo-*.sql.gz' -mtime "+$BACKUP_KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
[ "$DELETED" -gt 0 ] && echo "  pruned $DELETED backup(s) older than $BACKUP_KEEP_DAYS days"

echo "  $(find "$BACKUP_DIR" -name 'sejbosejbo-*.sql.gz' | wc -l | tr -d ' ') backups on disk, $(du -sh "$BACKUP_DIR" | cut -f1) total"

# Report media drift through the exit code, after the backup summary has
# been printed - the dump itself succeeded, so this must not look like a
# backup failure, but it does need to be noticed.
if [ "${MEDIA_DRIFT:-false}" = true ]; then
  echo "  media verification found drift - run scripts/verify-media.js --repair" >&2
  exit 3
fi
