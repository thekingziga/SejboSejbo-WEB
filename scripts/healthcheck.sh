#!/usr/bin/env bash
#
# Watches the things that fail silently, and pushes to ntfy when one of
# them does.
#
# The gap this closes: when Postgres died on 18 Aug the site was down and
# nothing said so - it was found by grepping logs afterwards. Backups have
# the same problem in slower motion; pg_dump could stop working and the
# first sign would be needing a restore that isn't there.
#
# Runs on the Pi from cron, e.g. every 5 minutes:
#
#   */5 * * * * /home/pidocker/sejbosejbo/healthcheck.sh >> /home/pidocker/sejbosejbo/db-backups/healthcheck.log 2>&1
#
# IMPORTANT: this runs on the same Pi it is watching, so it catches a dead
# database, a dead container, a stale backup or a full disk - but it
# cannot report that the Pi itself is off or has lost its connection.
# Something outside the house is needed for that; see README.
#
# Alerts fire on state *change*, not on every run, so a fault that lasts a
# day produces one alert and one recovery notice rather than 288 of each.
set -uo pipefail

NTFY_URL="${NTFY_URL:-http://127.0.0.1:6677}"
NTFY_TOPIC="${NTFY_TOPIC:-sejbosejbo}"
NTFY_TOKEN="${NTFY_TOKEN:-}"
SITE_URL="${SITE_URL:-https://sejbosejbo.fyi}"
CONTAINER="${CONTAINER:-sejbosejbo}"
BACKUP_DIR="${BACKUP_DIR:-/home/pidocker/sejbosejbo/db-backups}"
STATE_DIR="${STATE_DIR:-/home/pidocker/sejbosejbo/.healthcheck}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-30}"
DISK_MIN_PCT_FREE="${DISK_MIN_PCT_FREE:-10}"
APP_DIR="${APP_DIR:-/opt/sejbosejbo}"

# The media-queue check is gated on TRANSCODE_ENABLED, which is set in the
# stack's .env - not in cron's environment. Reading it only from the
# environment meant the check silently never ran: transcoding could be on
# and a stalled queue would raise nothing at all. Take it from the same
# file the app does, so the two cannot drift apart, while still letting an
# explicit environment value win for a one-off run.
if [ -z "${TRANSCODE_ENABLED:-}" ] && [ -r "$APP_DIR/.env" ]; then
  TRANSCODE_ENABLED=$(sed -n 's/^TRANSCODE_ENABLED=//p' "$APP_DIR/.env" | tail -1)
fi
TRANSCODE_ENABLED="${TRANSCODE_ENABLED:-false}"

mkdir -p "$STATE_DIR"
stamp() { date "+%Y-%m-%d %H:%M:%S"; }

# --- notification -----------------------------------------------------------
# One alert when a check starts failing, one when it recovers. The state
# file per check is what makes that possible; without it cron would
# re-send the same alert every five minutes until someone noticed.
notify() {
  local title="$1" message="$2" priority="$3" tags="$4"
  local args=(-s -m 10 -o /dev/null -w "%{http_code}")
  [ -n "$NTFY_TOKEN" ] && args+=(-H "Authorization: Bearer $NTFY_TOKEN")
  local code
  code=$(curl "${args[@]}" \
    -H "Title: $title" \
    -H "Priority: $priority" \
    -H "Tags: $tags" \
    -d "$message" \
    "$NTFY_URL/$NTFY_TOPIC" 2>/dev/null)
  if [ "$code" != "200" ]; then
    echo "$(stamp) WARN could not reach ntfy at $NTFY_URL (HTTP ${code:-none})"
  fi
}

failed=0

# Records the result of one check and notifies only when it differs from
# last time.
report() {
  local name="$1" ok="$2" detail="$3"
  local state_file="$STATE_DIR/$name"
  local previous="ok"
  [ -f "$state_file" ] && previous=$(cat "$state_file")

  if [ "$ok" = "1" ]; then
    echo "$(stamp) OK   $name"
    if [ "$previous" != "ok" ]; then
      notify "sejbosejbo: $name recovered" "$detail" "default" "white_check_mark"
    fi
    echo "ok" > "$state_file"
  else
    failed=1
    echo "$(stamp) FAIL $name - $detail"
    if [ "$previous" != "fail" ]; then
      notify "sejbosejbo: $name FAILED" "$detail" "high" "rotating_light"
    fi
    echo "fail" > "$state_file"
  fi
}

# --- checks -----------------------------------------------------------------

# The site answering /health with ok:true covers the whole chain at once:
# reverse proxy, container, and the database query behind it.
health_body=$(curl -s -m 15 "$SITE_URL/health" 2>/dev/null)
if echo "$health_body" | grep -q '"ok":true'; then
  report "site" 1 "$SITE_URL/health responded"
else
  report "site" 0 "$SITE_URL/health did not return ok:true. Got: ${health_body:0:200}"
fi

# Checked separately from the site because the container can be up and
# serving error pages while Postgres is unreachable - which is exactly
# what happened on 18 Aug.
if docker exec "$CONTAINER" node -e "
  const { pool } = require('/app/lib/db');
  pool.query('select 1').then(() => process.exit(0)).catch(() => process.exit(1));
" >/dev/null 2>&1; then
  report "database" 1 "postgres answered a query"
else
  report "database" 0 "the app container could not query postgres"
fi

# Uploads live in object storage now, so the bucket being unreachable
# means every image on the site is broken even though the site is 'up'.
if docker exec "$CONTAINER" node -e "
  const storage = require('/app/lib/storage');
  if (!storage.isRemote()) process.exit(0);
  storage.getObject('__healthcheck_probe__')
    .then((res) => process.exit(res.status === 404 || res.ok ? 0 : 1))
    .catch(() => process.exit(1));
" >/dev/null 2>&1; then
  report "storage" 1 "object storage answered"
else
  report "storage" 0 "the primary S3 bucket did not answer"
fi

# A backup that silently stopped is only discovered when a restore is
# needed, which is the worst possible moment.
newest_backup=$(find "$BACKUP_DIR" -name "*.sql.gz" -type f -printf "%T@ %p\n" 2>/dev/null | sort -rn | head -1)
if [ -z "$newest_backup" ]; then
  report "backup" 0 "no .sql.gz backup found in $BACKUP_DIR"
else
  backup_path=${newest_backup#* }
  age_hours=$(( ( $(date +%s) - $(stat -c %Y "$backup_path") ) / 3600 ))
  backup_size=$(stat -c %s "$backup_path")
  if [ "$age_hours" -gt "$BACKUP_MAX_AGE_HOURS" ]; then
    report "backup" 0 "newest backup is ${age_hours}h old ($(basename "$backup_path")). Backups run 03:30 daily."
  elif [ "$backup_size" -lt 1000 ]; then
    report "backup" 0 "newest backup is only ${backup_size} bytes - almost certainly truncated"
  else
    report "backup" 1 "newest backup is ${age_hours}h old, ${backup_size} bytes"
  fi
fi

# A transcode queue with nothing draining it is invisible otherwise: the
# site keeps working and uploads keep succeeding, they just never get any
# smaller. Nothing is unplayable while it waits - the post has been
# serving the uploaded file since it was uploaded - so a queue with work
# in it is NORMAL: encoding only runs in the small hours, and a job
# uploaded at noon is meant to sit there until tonight.
#
# What is not normal is a job that has sat through a whole window without
# being picked up. That is the real "the worker is off" signal, and it is
# the only thing worth waking anyone for.
# Only checked when transcoding is actually enabled.
if [ "${TRANSCODE_ENABLED:-}" = "true" ]; then
  QUEUE=$(docker exec "$CONTAINER" node -e "
    const { pool } = require('/app/lib/db');
    pool.query(\`SELECT
        count(*) FILTER (WHERE status IN ('pending','processing'))::int AS waiting,
        count(*) FILTER (WHERE status IN ('pending','processing')
                           AND created_at < now() - interval '\${process.env.QUEUE_STALE_HOURS || 36} hours')::int AS stale,
        count(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM media_jobs\`)
      .then((r) => {
        const row = r.rows[0];
        console.log(row.waiting + ' ' + row.stale + ' ' + row.failed);
        process.exit(0);
      })
      .catch(() => { console.log('err'); process.exit(0); });
  " 2>/dev/null)

  if [ "$QUEUE" = "err" ] || [ -z "$QUEUE" ]; then
    report "media_queue" 0 "could not read the media job queue"
  else
    WAITING=$(echo "$QUEUE" | awk '{print $1}')
    STALE=$(echo "$QUEUE" | awk '{print $2}')
    FAILED=$(echo "$QUEUE" | awk '{print $3}')
    if [ "${STALE:-0}" -gt 0 ]; then
      report "media_queue" 0 "$STALE job(s) have waited through an encoding window - is the transcode worker running?"
    elif [ "${FAILED:-0}" -gt "${QUEUE_MAX_FAILED:-5}" ]; then
      report "media_queue" 0 "$FAILED media jobs have failed permanently"
    else
      report "media_queue" 1 "$WAITING waiting, $FAILED failed"
    fi
  fi
fi

# A full disk breaks uploads, backups and Postgres all at once, and gives
# no warning before it does.
pct_used=$(df --output=pcent "$BACKUP_DIR" 2>/dev/null | tail -1 | tr -dc '0-9')
pct_free=$(( 100 - ${pct_used:-0} ))
if [ "$pct_free" -lt "$DISK_MIN_PCT_FREE" ]; then
  report "disk" 0 "only ${pct_free}% disk free"
else
  report "disk" 1 "${pct_free}% disk free"
fi

exit $failed
