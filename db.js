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
    type            TEXT NOT NULL DEFAULT 'compile',
    language        TEXT,
    input_hash      TEXT REFERENCES blobs(hash),
    output_hash     TEXT REFERENCES blobs(hash),
    module_hash     TEXT REFERENCES blobs(hash),
    alias           TEXT,
    output_size     INTEGER,
    duration_ms     INTEGER,
    success         INTEGER NOT NULL,
    error           TEXT
  );

  CREATE TABLE IF NOT EXISTS aliases (
    name        TEXT PRIMARY KEY,
    hash        TEXT NOT NULL REFERENCES blobs(hash),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_language ON events(language);
  CREATE INDEX IF NOT EXISTS idx_events_input ON events(input_hash);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_aliases_hash ON aliases(hash);
`);

// --- prepared statements ---

const stmts = {
  getBlob: db.prepare("SELECT data FROM blobs WHERE hash = ?"),
  hasBlob: db.prepare("SELECT 1 FROM blobs WHERE hash = ? LIMIT 1"),
  blobSize: db.prepare("SELECT size FROM blobs WHERE hash = ?"),
  putBlob: db.prepare("INSERT OR IGNORE INTO blobs (hash, data, size) VALUES (?, ?, ?)"),
  insertEvent: db.prepare(`
    INSERT INTO events (type, language, input_hash, output_hash, module_hash, alias, output_size, duration_ms, success, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  recentEvents: db.prepare(`
    SELECT id, timestamp, type, language, input_hash, output_hash, module_hash, alias, output_size, duration_ms, success, error
    FROM events ORDER BY id DESC LIMIT ?
  `),
  stats: db.prepare(`
    SELECT
      COUNT(*) as total_events,
      SUM(CASE WHEN type='compile' THEN 1 ELSE 0 END) as compiles,
      SUM(CASE WHEN type='execute' THEN 1 ELSE 0 END) as executions,
      SUM(CASE WHEN type='resolve' THEN 1 ELSE 0 END) as resolutions,
      SUM(success) as successes,
      COUNT(*) - SUM(success) as failures,
      COUNT(DISTINCT input_hash) as unique_inputs,
      COUNT(DISTINCT output_hash) as unique_outputs,
      (SELECT COUNT(*) FROM blobs) as total_blobs,
      (SELECT SUM(size) FROM blobs) as total_blob_bytes,
      (SELECT COUNT(*) FROM aliases) as total_aliases
    FROM events
  `),
  setAlias: db.prepare(`
    INSERT INTO aliases (name, hash) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET hash=excluded.hash, updated_at=strftime('%Y-%m-%dT%H:%M:%f', 'now')
  `),
  getAlias: db.prepare("SELECT name, hash, created_at, updated_at FROM aliases WHERE name = ?"),
  deleteAlias: db.prepare("DELETE FROM aliases WHERE name = ?"),
  listAliases: db.prepare("SELECT name, hash, created_at, updated_at FROM aliases ORDER BY name"),
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

function recordEvent({ type, language, inputHash, outputHash, moduleHash, alias, outputSize, durationMs, success, error }) {
  const result = stmts.insertEvent.run(
    type || "compile",
    language || null,
    inputHash || null,
    outputHash || null,
    moduleHash || null,
    alias || null,
    outputSize || null,
    durationMs || null,
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

function blobSize(h) {
  const row = stmts.blobSize.get(h);
  return row ? row.size : null;
}

// --- aliases ---

function setAlias(name, hash) {
  // Verify blob exists
  if (!stmts.hasBlob.get(hash)) return null;
  stmts.setAlias.run(name, hash);
  return { name, hash };
}

function getAlias(name) {
  return stmts.getAlias.get(name) || null;
}

function deleteAlias(name) {
  return stmts.deleteAlias.run(name).changes > 0;
}

function listAliases() {
  return stmts.listAliases.all();
}

// Resolve a ref (alias or hash) to a hash
function resolveRef(ref) {
  const alias = getAlias(ref);
  if (alias) return { hash: alias.hash, alias: ref };
  if (stmts.hasBlob.get(ref)) return { hash: ref, alias: null };
  return null;
}

module.exports = { putBlob, getBlob, blobSize, hash, recordEvent, recentEvents, stats, setAlias, getAlias, deleteAlias, listAliases, resolveRef, db };
