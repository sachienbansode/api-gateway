'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./pool');

/**
 * Minimal forward-only migration runner.
 *
 * Deliberately not a framework. Migrations are plain .sql files applied in
 * filename order, each inside a transaction, recorded with a checksum.
 *
 * The checksum matters: if someone edits an already-applied migration, the
 * runner refuses to proceed rather than leaving your environments silently
 * diverged. Fix that by writing a NEW migration, which is the only safe way to
 * change a schema that already exists somewhere.
 *
 * An advisory lock means two instances booting at once cannot both migrate.
 */

// All SQL lives under db/ at the project root: db/migrations, db/setup,
// db/queries. Overridable so tests and tooling can point elsewhere.
const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR || path.join(__dirname, '..', '..', 'db', 'migrations');
// Arbitrary but fixed — it only needs to be the same number in every instance.
const LOCK_ID = 4815162342;

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      return { file, sql, checksum: sha256(sql) };
    });
}

async function ensureLedger(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS gateway`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS gateway.schema_migrations (
      file        TEXT PRIMARY KEY,
      checksum    CHAR(64) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER
    )
  `);
}

/**
 * @returns {Promise<{applied:string[], skipped:string[]}>}
 */
async function migrate(logger) {
  if (!db.isEnabled()) {
    logger?.warn('no DATABASE_URL — skipping migrations');
    return { applied: [], skipped: [], enabled: false };
  }

  // A clearer failure than "permission denied for schema gateway" three frames
  // deep, which is what you get if the gateway's restricted role is used here.
  const usingOwner = Boolean(process.env.MIGRATION_DATABASE_URL);
  if (!usingOwner) {
    logger?.info(
      'MIGRATION_DATABASE_URL is not set — migrating with DATABASE_URL. That works ' +
        'if this role owns the schema; if you followed azure-postgres-setup.sql, set ' +
        'MIGRATION_DATABASE_URL to the gw_owner credential instead.'
    );
  }

  const pool = db.getPool();
  const client = await pool.connect();
  const applied = [];
  const skipped = [];

  try {
    // Serialise across instances. Released automatically when the session ends.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await ensureLedger(client);

    const { rows } = await client.query(
      'SELECT file, checksum FROM gateway.schema_migrations'
    );
    const already = new Map(rows.map((r) => [r.file, r.checksum]));

    for (const m of listMigrations()) {
      const prior = already.get(m.file);

      if (prior) {
        if (prior !== m.checksum) {
          throw new Error(
            `Migration ${m.file} has been modified since it was applied ` +
              `(recorded ${prior.slice(0, 12)}…, file is now ${m.checksum.slice(0, 12)}…). ` +
              `Editing an applied migration leaves environments silently diverged. ` +
              `Revert the file and add a new migration instead.`
          );
        }
        skipped.push(m.file);
        continue;
      }

      const started = Date.now();
      logger?.info({ migration: m.file }, 'applying migration');

      // Each migration is atomic: it either fully applies or not at all.
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO gateway.schema_migrations (file, checksum, duration_ms)
           VALUES ($1, $2, $3)`,
          [m.file, m.checksum, Date.now() - started]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${m.file} failed: ${err.message}`);
      }

      applied.push(m.file);
      logger?.info({ migration: m.file, ms: Date.now() - started }, 'migration applied');
    }

    return { applied, skipped, enabled: true };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

/** What has been applied, for a status command. */
async function status() {
  if (!db.isEnabled()) return { enabled: false, pending: listMigrations().map((m) => m.file) };

  const res = await db.query(
    `SELECT file, applied_at, duration_ms FROM gateway.schema_migrations ORDER BY file`
  ).catch(() => null);

  const appliedFiles = new Set((res?.rows || []).map((r) => r.file));
  return {
    enabled: true,
    applied: res?.rows || [],
    pending: listMigrations()
      .map((m) => m.file)
      .filter((f) => !appliedFiles.has(f)),
  };
}

module.exports = { migrate, status, listMigrations };
