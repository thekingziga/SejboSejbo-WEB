#!/usr/bin/env node
/**
 * Checks that every live post's media actually exists in BOTH buckets.
 *
 * The mirror is the only backup of user media, and mirror writes are
 * deliberately best-effort: `storage.commit()` logs a failed mirror write
 * and carries on, because a healthy upload should not fail just because
 * MEGA is having a moment. The cost of that choice is silent drift - an
 * object that only ever landed in the primary looks completely fine until
 * the day you need the backup.
 *
 * This is the check that turns "we have a mirror" into "the mirror has
 * everything". It also catches the opposite and more urgent case: an
 * object missing from the PRIMARY, which means a live post is serving a
 * broken image right now.
 *
 *   node scripts/verify-media.js            # report only, exit 1 on drift
 *   node scripts/verify-media.js --repair   # copy primary -> mirror to heal
 *   node scripts/verify-media.js --quiet    # one summary line, for cron
 *
 * Deleted posts still inside their grace period are checked too: their
 * media is exactly what a restore depends on.
 */
const storage = require("../lib/storage");
const { statements, pool } = require("../lib/db");

const REPAIR = process.argv.includes("--repair");
const QUIET = process.argv.includes("--quiet");
const { signedHeaders, s3Put, keyFor, S3, MIRROR } = storage._internal;

function log(...args) {
  if (!QUIET) console.log(...args);
}

async function exists(filename, cfg) {
  const url = `${cfg.endpoint.replace(/\/$/, "")}/${cfg.bucket}/${keyFor(filename, cfg)}`;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: signedHeaders({ method: "HEAD", url, cfg }),
      signal: AbortSignal.timeout(20000)
    });
    if (res.status === 200) return { ok: true, size: Number(res.headers.get("content-length") || 0) };
    if (res.status === 404) return { ok: false };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function main() {
  if (!storage.isRemote()) {
    console.error("storage driver is not s3 - nothing to verify");
    process.exit(0);
  }
  if (!storage.isMirroring()) {
    console.error("no mirror configured - S3_MIRROR_* is unset or incomplete");
    process.exit(2);
  }

  const rows = await statements.liveMediaKeys.all();
  log(`checking ${rows.length} objects in both buckets`);

  const missingPrimary = [];
  const missingMirror = [];
  const errors = [];
  let repaired = 0;

  for (const row of rows) {
    const [p, m] = await Promise.all([exists(row.filename, S3), exists(row.filename, MIRROR)]);

    if (p.error || m.error) {
      errors.push(`#${row.id} ${row.filename}: ${p.error || m.error}`);
      continue;
    }
    if (!p.ok) missingPrimary.push(row);
    if (!m.ok) {
      missingMirror.push(row);
      // Only the primary can heal the mirror. If the primary is missing
      // too there is nothing to copy and the object is simply gone.
      if (REPAIR && p.ok) {
        try {
          const res = await storage.getObject(row.filename);
          if (!res.ok) throw new Error(`primary GET returned ${res.status}`);
          await s3Put(row.filename, Buffer.from(await res.arrayBuffer()), MIRROR);
          repaired += 1;
          log(`  repaired mirror copy of #${row.id} ${row.filename}`);
        } catch (err) {
          errors.push(`#${row.id} repair failed: ${err.message}`);
        }
      }
    }
  }

  const gone = missingPrimary.filter((r) => missingMirror.some((m) => m.id === r.id));

  if (QUIET) {
    console.log(
      `checked=${rows.length} missing_primary=${missingPrimary.length} ` +
      `missing_mirror=${missingMirror.length - repaired} unrecoverable=${gone.length} errors=${errors.length}`
    );
  } else {
    console.log("");
    console.log(`  checked:              ${rows.length}`);
    console.log(`  missing from primary: ${missingPrimary.length}${missingPrimary.length ? "  <- live posts are serving broken media" : ""}`);
    console.log(`  missing from mirror:  ${missingMirror.length - repaired}${REPAIR && repaired ? ` (${repaired} repaired)` : ""}`);
    console.log(`  in neither bucket:    ${gone.length}${gone.length ? "  <- UNRECOVERABLE" : ""}`);
    if (errors.length) console.log(`  errors:               ${errors.length}`);
    for (const row of missingPrimary) console.log(`    primary missing: #${row.id} ${row.filename}`);
    for (const row of missingMirror.slice(0, 20)) console.log(`    mirror missing:  #${row.id} ${row.filename}`);
    for (const e of errors.slice(0, 20)) console.log(`    error: ${e}`);
    if (!REPAIR && missingMirror.length > repaired) {
      console.log("");
      console.log("  re-run with --repair to copy the missing objects to the mirror");
    }
  }

  await pool.end();
  const drift = missingPrimary.length + (missingMirror.length - repaired) + errors.length;
  process.exit(drift > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`verify-media failed: ${err.message}`);
  try { await pool.end(); } catch {}
  process.exit(2);
});
