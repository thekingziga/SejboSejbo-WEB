#!/usr/bin/env node
/**
 * Fills uploads.content_hash for posts made before 1.42.0, so re-uploading
 * one of them is refused as a duplicate like any newer post. Streams each
 * file from storage through sha256 - nothing is held in memory or written
 * to disk. Safe to run again: it only touches rows that still have no hash.
 *
 *   docker compose exec sejbosejbo node scripts/backfill-content-hashes.js
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const storage = require("../lib/storage");
const { pool, uploadDir } = require("../lib/db");

async function hashOf(filename) {
  const hash = crypto.createHash("sha256");
  let stream;
  if (storage.isRemote()) {
    const response = await storage.getObject(filename);
    if (!response.ok) throw new Error(`storage answered ${response.status}`);
    stream = Readable.fromWeb(response.body);
  } else {
    stream = fs.createReadStream(path.join(uploadDir, filename));
  }
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const { rows } = await pool.query("SELECT id, filename FROM uploads WHERE content_hash IS NULL AND filename IS NOT NULL ORDER BY id");
  console.log(`${rows.length} post(s) without a content hash`);
  let done = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await pool.query("UPDATE uploads SET content_hash = $1 WHERE id = $2", [await hashOf(row.filename), row.id]);
      done += 1;
    } catch (err) {
      failed += 1;
      console.error(`post ${row.id} (${row.filename}): ${err.message}`);
    }
  }
  console.log(`hashed ${done}, failed ${failed}`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
