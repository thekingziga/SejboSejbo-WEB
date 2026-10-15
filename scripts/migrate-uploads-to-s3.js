#!/usr/bin/env node
/**
 * Copies every file referenced by the uploads table from local disk into the
 * configured S3 bucket.
 *
 * Run this BEFORE flipping STORAGE_DRIVER=s3, with the S3_* vars already set:
 *
 *   STORAGE_DRIVER=s3 S3_BUCKET=... S3_ENDPOINT=... S3_ACCESS_KEY_ID=... \
 *   S3_SECRET_ACCESS_KEY=... node scripts/migrate-uploads-to-s3.js
 *
 * Safe to re-run: it re-uploads, which simply overwrites identical objects.
 * Nothing is deleted from local disk - verify the site works on S3 first,
 * then remove ./uploads by hand when you're satisfied.
 *
 * Pass --dry-run to list what would be copied without transferring anything.
 *
 * Pass --mirror to target the S3_MIRROR_* bucket instead of the primary.
 * That is how the mirror gets backfilled the first time, and how it heals
 * after a mirror write failed during an upload (those are logged and
 * deliberately not retried inline, so the mirror can drift). Safe to run on
 * a schedule - it re-uploads, which just overwrites identical objects.
 */
const fs = require("fs");
const path = require("path");

const { statements, uploadDir } = require("../lib/db");
const storage = require("../lib/storage");

const dryRun = process.argv.includes("--dry-run");
const toMirror = process.argv.includes("--mirror");

async function main() {
  if (!storage.isRemote()) {
    console.error("STORAGE_DRIVER is not 's3' (or the S3_* vars are incomplete).");
    console.error("Set them in the environment before running this script.");
    process.exit(1);
  }

  const target = toMirror ? storage._internal.MIRROR : storage._internal.S3;
  if (toMirror && !storage._internal.bucketConfigured(target)) {
    console.error("--mirror given but the S3_MIRROR_* vars are incomplete.");
    process.exit(1);
  }

  const rows = (await statements.allUploadsAdmin.all()).filter((r) => r.filename);
  console.log(`${rows.length} rows reference a file.`);
  console.log(`target: ${target.label} bucket ${target.bucket} at ${target.endpoint}${target.prefix ? ` (prefix ${target.prefix})` : ""}${dryRun ? "  [DRY RUN]" : ""}\n`);

  let copied = 0;
  let missing = 0;
  let failed = 0;

  /** Where the bytes come from.
   *
   * Local disk is only the right source for the *first* copy into the
   * primary bucket. Healing the mirror has to read from the primary
   * instead: once uploads/ is deleted - which is the whole point of moving
   * to object storage - a local-disk source would find nothing and report
   * a cheerful "missing locally: 50" while copying zero files. The mirror
   * would then quietly stop being a mirror.
   *
   * Falls back to local disk so a first-time backfill still works while
   * both copies exist. */
  async function readBytes(filename) {
    if (toMirror) {
      const res = await storage.getObject(filename);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      // fall through to disk - the primary may not have it yet
    }
    const localPath = path.join(uploadDir, filename);
    if (fs.existsSync(localPath)) return fs.readFileSync(localPath);
    return null;
  }

  for (const row of rows) {
    if (dryRun) {
      console.log(`WOULD COPY  #${row.id} ${row.filename}`);
      copied++;
      continue;
    }
    try {
      const bytes = await readBytes(row.filename);
      if (!bytes) {
        console.warn(`MISSING  #${row.id} ${row.filename} (not in the source bucket or on disk)`);
        missing++;
        continue;
      }
      await storage._internal.s3Put(row.filename, bytes, target);
      console.log(`OK       #${row.id} ${row.filename}`);
      copied++;
    } catch (err) {
      console.error(`FAILED   #${row.id} ${row.filename}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${dryRun ? "would copy" : "copied"}: ${copied}   missing: ${missing}   failed: ${failed}`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
