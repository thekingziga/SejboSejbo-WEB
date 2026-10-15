#!/usr/bin/env node
/**
 * Copies the live SQLite database into Postgres.
 *
 *   node scripts/migrate-sqlite-to-postgres.js [--sqlite <path>] [--dry-run]
 *
 * Reads data/sejbosejbo.sqlite by default and writes to whatever the PG*
 * environment variables point at. The SQLite file is opened read-only and
 * never modified, so it stays a valid rollback target.
 *
 * Safe to re-run: every table is truncated and reloaded inside one
 * transaction, so a failure halfway leaves Postgres exactly as it was
 * rather than half-populated.
 *
 * Row ids are preserved. That matters beyond tidiness - image filenames,
 * deep links (/post/12) and the app's cached post ids all reference them,
 * so renumbering would break links people already have.
 */
const fs = require("fs");
const path = require("path");

const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

const { initDb } = require("../lib/db");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const sqlitePathArg = args.indexOf("--sqlite");
const sqlitePath = sqlitePathArg !== -1
  ? args[sqlitePathArg + 1]
  : path.join(__dirname, "..", "data", "sejbosejbo.sqlite");

// Order matters: parents before children, because of the foreign keys.
const TABLES = [
  { name: "uploads",       columns: ["id", "title", "description", "filename", "original_name", "kind", "hidden", "pinned", "featured", "upvotes", "downvotes", "report_count", "comment_count", "created_at"], booleans: ["hidden", "pinned", "featured"], dates: ["created_at"] },
  { name: "comments",      columns: ["id", "post_id", "body", "device_id", "hidden", "upvotes", "downvotes", "created_at"], booleans: ["hidden"], dates: ["created_at"] },
  { name: "votes",         columns: ["id", "post_id", "device_id", "value", "created_at"], booleans: [], dates: ["created_at"] },
  { name: "comment_votes", columns: ["id", "comment_id", "device_id", "value", "created_at"], booleans: [], dates: ["created_at"] },
  { name: "reports",       columns: ["id", "post_id", "comment_id", "reason", "details", "created_at"], booleans: [], dates: ["created_at"] },
  { name: "donations",     columns: ["id", "source", "tier_id", "amount_minor", "currency", "external_id", "created_at"], booleans: [], dates: ["created_at"] },
  { name: "counters",      columns: ["key", "value"], booleans: [], dates: [] },
  { name: "settings",      columns: ["key", "value"], booleans: [], dates: [] },
  { name: "ai_content",    columns: ["key", "lang", "value", "updated_at"], booleans: [], dates: ["updated_at"] }
];

/** sqlite stored timestamps as "YYYY-MM-DD HH:MM:SS" strings with no zone,
 * written by CURRENT_TIMESTAMP - which is UTC. Postgres would read a bare
 * string in the session's timezone, so every row would silently shift by
 * the server's offset. Tag it explicitly. */
function toUtcTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  if (!text) return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(text)) return text;
  return `${text.replace(" ", "T")}Z`;
}

async function main() {
  if (!fs.existsSync(sqlitePath)) {
    console.error(`SQLite database not found: ${sqlitePath}`);
    process.exit(1);
  }

  // Create the schema if the target is a brand new database. Without this
  // the first run against a fresh Postgres fails with 'relation "uploads"
  // does not exist' - which is exactly what happens on the one run that
  // matters, the real cutover, because every rehearsal happened against a
  // database the app had already initialised.
  await initDb();

  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: 4
  });

  const client = await pool.connect();
  const summary = [];
  let committed = false;

  try {
    const { rows: [info] } = await client.query("SELECT current_database() AS db, pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = current_database()");
    console.log(`source: ${sqlitePath}`);
    console.log(`target: ${info.db} (${info.enc})${dryRun ? "  [DRY RUN]" : ""}\n`);

    // Existing tables in sqlite - a fresh install may not have them all.
    const present = new Set(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );

    if (!dryRun) await client.query("BEGIN");

    // One statement so the dependency order can't bite, and so re-running
    // never leaves duplicates behind.
    if (!dryRun) {
      await client.query(`TRUNCATE ${TABLES.map((t) => t.name).join(", ")} RESTART IDENTITY CASCADE`);
    }

    for (const table of TABLES) {
      if (!present.has(table.name)) {
        summary.push([table.name, 0, "not in source"]);
        continue;
      }

      const rows = sqlite.prepare(`SELECT * FROM ${table.name}`).all();
      if (!rows.length) {
        summary.push([table.name, 0, "empty"]);
        continue;
      }

      const cols = table.columns.filter((c) => c in rows[0]);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const sql = `INSERT INTO ${table.name} (${cols.join(", ")}) VALUES (${placeholders})`;

      for (const row of rows) {
        const values = cols.map((c) => {
          if (table.booleans.includes(c)) return Boolean(row[c]);
          if (table.dates.includes(c)) return toUtcTimestamp(row[c]);
          return row[c];
        });
        if (!dryRun) await client.query(sql, values);
      }
      summary.push([table.name, rows.length, dryRun ? "would copy" : "copied"]);
    }

    // Identity sequences don't know about explicitly-inserted ids, so the
    // next insert would collide with row 1. Fast-forward each to the max.
    if (!dryRun) {
      for (const table of TABLES) {
        if (!table.columns.includes("id")) continue;
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${table.name}', 'id'),
                         GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table.name}), 1),
                         (SELECT COUNT(*) FROM ${table.name}) > 0)`
        );
      }
      await client.query("COMMIT");
      committed = true;
    }

    console.log("table            rows   status");
    console.log("--------------------------------------");
    for (const [name, count, status] of summary) {
      console.log(`${name.padEnd(16)} ${String(count).padStart(4)}   ${status}`);
    }

    if (!dryRun) {
      console.log("\nverifying row counts match...");
      let mismatch = false;
      for (const [name, expected] of summary) {
        if (!present.has(name)) continue;
        const { rows: [{ count }] } = await client.query(`SELECT COUNT(*)::int AS count FROM ${name}`);
        const ok = count === expected;
        if (!ok) mismatch = true;
        console.log(`  ${name.padEnd(16)} sqlite=${expected} postgres=${count} ${ok ? "OK" : "*** MISMATCH ***"}`);
      }
      if (mismatch) process.exitCode = 1;

      const { rows: [seq] } = await client.query(
        "SELECT pg_sequence_last_value(pg_get_serial_sequence('uploads','id')::regclass) AS last_value"
      );
      console.log(`\nuploads id sequence now at ${seq.last_value} - the next new post gets ${Number(seq.last_value) + 1}`);
    }
  } catch (err) {
    if (!dryRun && !committed) {
      try { await client.query("ROLLBACK"); } catch { /* connection gone */ }
    }
    // Distinguish "the copy failed" from "the copy committed and something
    // afterwards blew up" - reporting a successful migration as a failure
    // is how someone ends up running it twice or restoring a backup they
    // never needed.
    console.error(committed
      ? `\nData was COMMITTED, but a post-migration step failed: ${err.message}`
      : `\nFAILED - nothing was committed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main();
