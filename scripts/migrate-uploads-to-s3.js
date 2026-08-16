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
 */
const fs = require("fs");
const path = require("path");

const { statements, uploadDir } = require("../lib/db");
const storage = require("../lib/storage");

const dryRun = process.argv.includes("--dry-run");

async function main() {
  if (!storage.isRemote()) {
    console.error("STORAGE_DRIVER is not 's3' (or the S3_* vars are incomplete).");
    console.error("Set them in the environment before running this script.");
    process.exit(1);
  }

  const rows = statements.allUploadsAdmin.all().filter((r) => r.filename);
  console.log(`${rows.length} rows reference a file. Target: ${storage.describe()}\n`);

  let copied = 0;
  let missing = 0;
  let failed = 0;

  for (const row of rows) {
    const localPath = path.join(uploadDir, row.filename);
    if (!fs.existsSync(localPath)) {
      console.warn(`MISSING  #${row.id} ${row.filename} (no local file - skipping)`);
      missing++;
      continue;
    }
    if (dryRun) {
      console.log(`WOULD COPY  #${row.id} ${row.filename}`);
      copied++;
      continue;
    }
    try {
      // commit() deletes the local temp file, which is exactly what we do
      // NOT want here - so push the bytes directly instead.
      await storage._internal.s3Put(row.filename, fs.readFileSync(localPath));
      console.log(`OK       #${row.id} ${row.filename}`);
      copied++;
    } catch (err) {
      console.error(`FAILED   #${row.id} ${row.filename}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${dryRun ? "would copy" : "copied"}: ${copied}   missing locally: ${missing}   failed: ${failed}`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
