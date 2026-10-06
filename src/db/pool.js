'use strict';

const { Pool } = require('pg');
const fs = require('fs');

/**
 * Postgres connection pool, configured for Azure Database for PostgreSQL
 * Flexible Server.
 *
 * Azure specifics that bite people:
 *   - TLS is mandatory. Flexible Server rejects a plaintext connection, so
 *     `ssl` is on unless you explicitly opt out for a local dev database.
 *   - By default the driver would verify against the system CA store, which on
 *     a bare VM may not include the DigiCert root Azure uses. Set
 *     DB_CA_CERT_PATH to the downloaded root and we verify properly.
 *     DB_SSL_INSECURE=true skips verification — it works, it is worse, and it
 *     logs a warning every boot so nobody forgets it is on.
 *   - Flexible Server caps connections by SKU tier (a Burstable B1ms allows
 *     ~50). Our default pool max of 10 leaves room for migrations, your admin
 *     tooling, and a second gateway instance.
 *
 * The gateway runs fine with NO database at all: if DATABASE_URL is unset,
 * `isEnabled()` is false and every DB-backed feature degrades to the in-memory
 * behaviour it had before. That is deliberate, so you can run locally and get
 * the thing up before the database exists.
 */

let pool = null;
let enabled = false;
let lastError = null;

function buildSslConfig(logger) {
  const mode = (process.env.DB_SSL || 'require').toLowerCase();

  if (mode === 'disable') {
    logger?.warn('database TLS is DISABLED — acceptable for a local dev database only');
    return false;
  }

  const caPath = process.env.DB_CA_CERT_PATH;
  if (caPath) {
    if (!fs.existsSync(caPath)) {
      throw new Error(`DB_CA_CERT_PATH points at a file that does not exist: ${caPath}`);
    }
    return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }

  if (String(process.env.DB_SSL_INSECURE).toLowerCase() === 'true') {
    logger?.warn(
      'database TLS certificate verification is OFF (DB_SSL_INSECURE=true). The ' +
        'connection is encrypted but not authenticated, so it is vulnerable to an ' +
        'active attacker. Set DB_CA_CERT_PATH to the Azure root certificate instead.'
    );
    return { rejectUnauthorized: false };
  }

  // Verify against the system store. Correct when the VM's CA bundle is current.
  return { rejectUnauthorized: true };
}

/**
 * Initialise the pool.
 *
 * @param {object} logger
 * @param {{forMigration?:boolean}} [opts]
 *        `forMigration: true` prefers MIGRATION_DATABASE_URL, which should be
 *        the schema OWNER's credential. The running gateway uses the restricted
 *        app role; only migrations need DDL. Keeping them separate means a
 *        compromised gateway cannot DROP the audit log it was caught in.
 */
function init(logger, { forMigration = false } = {}) {
  const url = forMigration
    ? process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL
    : process.env.DATABASE_URL;

  if (forMigration && process.env.MIGRATION_DATABASE_URL) {
    logger?.info('using MIGRATION_DATABASE_URL (owner role) for schema changes');
  }

  if (!url) {
    enabled = false;
    logger?.warn(
      'DATABASE_URL is not set — running without a database. Audit rows, durable ' +
        'quotas and idempotency are disabled; vendor keys come from config/env. ' +
        'Fine for local development, not for production.'
    );
    return null;
  }

  // Warn loudly if the gateway itself is pointed at an owner/admin credential.
  // This is easy to do by accident when copying the migration URL, and it
  // silently throws away the least-privilege separation.
  if (!forMigration && /:\/\/(gw_owner|postgres|pgadmin|azureuser)[:@]/i.test(url)) {
    logger?.warn(
      'DATABASE_URL appears to use an owner or admin role. The running gateway ' +
        'should connect as the restricted app role (gw_app) and only migrations ' +
        'should use the owner. See db/setup/ for the setup scripts.'
    );
  }

  pool = new Pool({
    connectionString: url,
    ssl: buildSslConfig(logger),
    max: Number(process.env.DB_POOL_MAX) || 10,
    min: Number(process.env.DB_POOL_MIN) || 0,
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 30000,
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 5000,
    // Cap how long one query can hold a connection. Without this a single slow
    // query can starve the pool and take the gateway down with it.
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 5000,
    query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS) || 5000,
    application_name: 'vendor-api-wrapper',
  });

  // An idle client erroring (network blip, Azure maintenance failover) must not
  // become an uncaught exception that kills the process.
  pool.on('error', (err) => {
    lastError = err.message;
    logger?.error({ err: err.message }, 'idle postgres client error');
  });

  enabled = true;
  return pool;
}

function isEnabled() {
  return enabled && pool !== null;
}

/**
 * Run a query. Returns null when no database is configured, so callers can
 * treat "no DB" and "no rows" distinctly without every call site checking.
 */
async function query(text, params) {
  if (!isEnabled()) return null;
  return pool.query(text, params);
}

/** Run several statements in one transaction. */
async function transaction(fn) {
  if (!isEnabled()) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the connection is already gone; nothing to roll back onto */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function health() {
  if (!isEnabled()) return { enabled: false };
  try {
    const started = Date.now();
    await pool.query('SELECT 1');
    return {
      enabled: true,
      ok: true,
      latencyMs: Date.now() - started,
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
  } catch (err) {
    return { enabled: true, ok: false, error: err.message, lastError };
  }
}

async function close() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
    enabled = false;
  }
}

module.exports = { init, isEnabled, query, transaction, health, close, getPool: () => pool };
