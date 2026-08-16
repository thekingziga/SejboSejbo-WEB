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
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"
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

  gunzip -c "$OUT" | docker run --rm -i -e PGPASSWORD="$PGPASSWORD" "$PG_IMAGE" \
    psql -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PGUSER" -d "$TMPDB" -q > /dev/null 2>&1

  COUNTS=$(docker run --rm -e PGPASSWORD="$PGPASSWORD" "$PG_IMAGE" \
    psql -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PGUSER" -d "$TMPDB" -tAc \
    "SELECT 'uploads=' || (SELECT COUNT(*) FROM uploads) || ' votes=' || (SELECT COUNT(*) FROM votes) || ' comments=' || (SELECT COUNT(*) FROM comments) || ' visits=' || (SELECT value FROM counters WHERE key='visits')" < /dev/null)
  echo "  restored copy contains: $COUNTS"
fi

# Prune old backups. -mtime +N is strictly older than N days.
DELETED=$(find "$BACKUP_DIR" -name 'sejbosejbo-*.sql.gz' -mtime "+$BACKUP_KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
[ "$DELETED" -gt 0 ] && echo "  pruned $DELETED backup(s) older than $BACKUP_KEEP_DAYS days"

echo "  $(find "$BACKUP_DIR" -name 'sejbosejbo-*.sql.gz' | wc -l | tr -d ' ') backups on disk, $(du -sh "$BACKUP_DIR" | cut -f1) total"
