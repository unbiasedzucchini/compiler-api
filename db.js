const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const DB_PATH = path.join(__dirname, "compiler-api.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// --- schema ---

db.exec(`
  CREATE TABLE IF NOT EXISTS blobs (
    hash       TEXT PRIMARY KEY,
    data       BLOB NOT NULL,
    size       INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    language        TEXT NOT NULL,
    input_hash      TEXT NOT NULL REFERENCES blobs(hash),
    output_hash     TEXT REFERENCES blobs(hash),
    output_size     INTEGER,
    compile_time_ms INTEGER,
    success         INTEGER NOT NULL,
    error           TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_language ON events(language);
  CREATE INDEX IF NOT EXISTS idx_events_input ON events(input_hash);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
`);

// --- prepared statements ---

const stmts = {
  getBlob: db.prepare("SELECT data FROM blobs WHERE hash = ?"),
  hasBlob: db.prepare("SELECT 1 FROM blobs WHERE hash = ? LIMIT 1"),
  putBlob: db.prepare("INSERT OR IGNORE INTO blobs (hash, data, size) VALUES (?, ?, ?)"),
  insertEvent: db.prepare(`
    INSERT INTO events (language, input_hash, output_hash, output_size, compile_time_ms, success, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  recentEvents: db.prepare(`
    SELECT id, timestamp, language, input_hash, output_hash, output_size, compile_time_ms, success, error
    FROM events ORDER BY id DESC LIMIT ?
  `),
  stats: db.prepare(`
    SELECT
      COUNT(*) as total_compiles,
      SUM(success) as successes,
      COUNT(*) - SUM(success) as failures,
      COUNT(DISTINCT input_hash) as unique_inputs,
      COUNT(DISTINCT output_hash) as unique_outputs,
      (SELECT COUNT(*) FROM blobs) as total_blobs,
      (SELECT SUM(size) FROM blobs) as total_blob_bytes
    FROM events
  `),
};

// --- api ---

function hash(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function putBlob(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = hash(buf);
  stmts.putBlob.run(h, buf, buf.length);
  return h;
}

function getBlob(h) {
  const row = stmts.getBlob.get(h);
  return row ? row.data : null;
}

function recordEvent({ language, inputHash, outputHash, outputSize, compileTimeMs, success, error }) {
  const result = stmts.insertEvent.run(
    language,
    inputHash,
    outputHash || null,
    outputSize || null,
    compileTimeMs || null,
    success ? 1 : 0,
    error || null,
  );
  return result.lastInsertRowid;
}

function recentEvents(limit = 50) {
  return stmts.recentEvents.all(limit);
}

function stats() {
  return stmts.stats.get();
}

module.exports = { putBlob, getBlob, hash, recordEvent, recentEvents, stats, db };
