/**
 * SQLite connection and migration runner.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { config } = require('../config');
const logger = require('../logger');
const { MIGRATIONS } = require('./schema');

/** @type {Database.Database|null} */
let db = null;

/**
 * Open the database, apply any pending migrations, and return the connection.
 * @returns {Database.Database}
 */
function init() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

  db = new Database(config.db.path);
  // WAL lets the sync worker read while the message handler writes.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Wait rather than throw if another statement holds the write lock.
  db.pragma('busy_timeout = 5000');

  migrate();

  logger.info(`Database ready at ${config.db.path}`);
  return db;
}

/** Apply any migrations that have not yet run. */
function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name)
  );

  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;

    // Each migration is atomic: schema change and its bookkeeping commit together.
    const run = db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.name);
    });

    try {
      run();
      logger.info(`Applied migration ${migration.name}`);
    } catch (error) {
      logger.error(`Migration ${migration.name} failed: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Get the live connection.
 * @returns {Database.Database}
 */
function get() {
  if (!db) throw new Error('Database not initialised — call init() first.');
  return db;
}

/** Close the connection, checkpointing the WAL so nothing is left behind. */
function close() {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Best effort — a failed checkpoint is not worth blocking shutdown.
  }
  db.close();
  db = null;
  logger.info('Database closed');
}

module.exports = { init, get, close };
