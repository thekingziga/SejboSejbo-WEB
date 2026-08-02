const fs = require("fs");
const path = require("path");

const { DatabaseSync } = require("node:sqlite");

const rootDir = path.join(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const uploadDir = path.join(rootDir, "uploads");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "sejbosejbo.sqlite"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    filename TEXT,
    original_name TEXT,
    kind TEXT NOT NULL DEFAULT 'image',
    hidden INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    featured INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS counters (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );

  INSERT OR IGNORE INTO counters (key, value) VALUES ('visits', 0);

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    value INTEGER NOT NULL CHECK (value IN (-1, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (post_id, device_id)
  );

  CREATE INDEX IF NOT EXISTS idx_votes_post ON votes(post_id);

  CREATE TABLE IF NOT EXISTS donations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    tier_id TEXT,
    amount_minor INTEGER,
    currency TEXT DEFAULT 'EUR',
    external_id TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// uploads predates the votes feature, so upvotes/downvotes are backfilled here
// rather than in the CREATE TABLE above (which only runs for a fresh DB).
const uploadColumns = db.prepare("PRAGMA table_info(uploads)").all().map((c) => c.name);
if (!uploadColumns.includes("upvotes")) {
  db.exec("ALTER TABLE uploads ADD COLUMN upvotes INTEGER NOT NULL DEFAULT 0");
}
if (!uploadColumns.includes("downvotes")) {
  db.exec("ALTER TABLE uploads ADD COLUMN downvotes INTEGER NOT NULL DEFAULT 0");
}

const statements = {
  totalVisits: db.prepare("SELECT value FROM counters WHERE key = 'visits'"),
  incrementVisits: db.prepare("UPDATE counters SET value = value + 1 WHERE key = 'visits'"),
  resetVisits: db.prepare("UPDATE counters SET value = 0 WHERE key = 'visits'"),
  totalUploads: db.prepare("SELECT COUNT(*) AS count FROM uploads WHERE hidden = 0"),
  latestUpload: db.prepare("SELECT id, title, created_at FROM uploads WHERE hidden = 0 ORDER BY datetime(created_at) DESC, id DESC LIMIT 1"),
  newestUploads: db.prepare("SELECT * FROM uploads WHERE hidden = 0 ORDER BY pinned DESC, datetime(created_at) DESC, id DESC LIMIT ?"),
  pagedUploads: db.prepare("SELECT * FROM uploads WHERE hidden = 0 ORDER BY pinned DESC, datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?"),
  pagedUploadsTop: db.prepare("SELECT * FROM uploads WHERE hidden = 0 ORDER BY (upvotes - downvotes) DESC, upvotes DESC, datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?"),
  pagedUploadsFeatured: db.prepare("SELECT * FROM uploads WHERE hidden = 0 AND featured = 1 ORDER BY datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?"),
  topUploadsAllTime: db.prepare("SELECT * FROM uploads WHERE hidden = 0 ORDER BY (upvotes - downvotes) DESC, upvotes DESC, datetime(created_at) DESC, id DESC LIMIT ?"),
  allUploadsAdmin: db.prepare("SELECT * FROM uploads ORDER BY datetime(created_at) DESC, id DESC"),
  uploadByIdPublic: db.prepare("SELECT * FROM uploads WHERE id = ? AND hidden = 0"),
  uploadByIdAny: db.prepare("SELECT * FROM uploads WHERE id = ?"),
  insertUpload: db.prepare("INSERT INTO uploads (title, description, filename, original_name, kind) VALUES (?, ?, ?, ?, ?)"),
  updateFlag: db.prepare("UPDATE uploads SET hidden = ?, pinned = ?, featured = ? WHERE id = ?"),
  deleteUpload: db.prepare("DELETE FROM uploads WHERE id = ?"),
  dailyPool: db.prepare("SELECT * FROM uploads WHERE hidden = 0 ORDER BY id"),

  upsertVote: db.prepare(`
    INSERT INTO votes (post_id, device_id, value) VALUES (?, ?, ?)
    ON CONFLICT (post_id, device_id) DO UPDATE SET value = excluded.value, created_at = CURRENT_TIMESTAMP
  `),
  deleteVote: db.prepare("DELETE FROM votes WHERE post_id = ? AND device_id = ?"),
  recountVotes: db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0) AS up,
      COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0) AS down
    FROM votes WHERE post_id = ?
  `),
  updateVoteCounts: db.prepare("UPDATE uploads SET upvotes = ?, downvotes = ? WHERE id = ?"),

  insertDonation: db.prepare(`
    INSERT OR IGNORE INTO donations (source, tier_id, amount_minor, currency, external_id)
    VALUES (?, ?, ?, ?, ?)
  `)
};

/** Casts (or withdraws, for value === 0) a vote and refreshes the denormalized
 * upvotes/downvotes on the post in one transaction, so list endpoints never
 * need a per-row subquery. */
function castVote(postId, deviceId, value) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (value === 0) {
      statements.deleteVote.run(postId, deviceId);
    } else {
      statements.upsertVote.run(postId, deviceId, value);
    }
    const { up, down } = statements.recountVotes.get(postId);
    statements.updateVoteCounts.run(up, down, postId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

module.exports = { db, statements, castVote, rootDir, dataDir, uploadDir };
