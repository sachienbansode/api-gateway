'use strict';

const { Pool } = require('pg');
const fs = require('fs');

/**
 * Second connection: the PLATFORM meta database (users, roles).
 *
 * Why a second pool rather than a second schema on the gateway pool:
 * Postgres cannot join across databases. `gateway` and `uat_ananta_staging`
 * are different databases on the same server, so a query from the gateway pool
 * can never name "admin-staging-api".users. OFS hit exactly this and solved it
 * the same way — two pools, two adapters, no cross-database SQL (REUSE.md §1.1).
 *
 * This pool is READ-ONLY by intent. The gateway reads identity and grants from
 * the platform; it never writes a user, a role or a grant. Nothing here issues
 * an UPDATE or INSERT, and the credential you configure should not have the
 * privilege to either.
 *
 * Env, following the platform's own convention:
 *   ADMIN_DATABASE_URL     postgres URL WITHOUT the password
 *   ADMIN_PG_PASSWORD      applied after the URL is parsed, and overrides any
 *                          password embedded in it. Keeping the secret in its
 *                          own variable means a logged or pasted URL is not a
 *                          credential leak.
 *   ADMIN_PG_SSL           'true' (default) or 'false'
 *   ADMIN_PG_POOL_MAX      default 5 — admin traffic is console users, not
 *                          vendor traffic, and the 15s permission cache means
 *                          even a busy console is a trickle of queries
 *   ADMIN_SCHEMA           default 'admin-staging-api'
 *
 * Absent ADMIN_DATABASE_URL, `isEnabled()` is false and the gateway runs with
 * the .env superadmin alone. That is the documented degraded mode, not a
 * failure — see ADMIN_AUTH.md.
 */

let pool = null;
let enabled = false;
let lastError = null;

const SCHEMA = process.env.ADMIN_SCHEMA || 'admin-staging-api';

/** Quote an identifier. The schema name contains a hyphen, so this is required. */
const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';

/** Schema-qualified, correctly quoted table reference. */
const T = (name) => q(SCHEMA) + '.' + q(name);

function buildSsl(logger) {
  if (String(process.env.ADMIN_PG_SSL || 'true').toLowerCase() === 'false') {
    logger?.warn('platform database TLS is DISABLED — local development only');
    return false;
  }

  const caPath = process.env.ADMIN_PG_CA_CERT_PATH;
  if (caPath) {
    if (!fs.existsSync(caPath)) {
      throw new Error(`ADMIN_PG_CA_CERT_PATH points at a file that does not exist: ${caPath}`);
    }
    return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }

  if (String(process.env.ADMIN_PG_SSL_INSECURE).toLowerCase() === 'true') {
    logger?.warn(
      'platform database TLS certificate verification is OFF ' +
        '(ADMIN_PG_SSL_INSECURE=true). The connection is encrypted but not ' +
        'authenticated. This link carries who may administer the gateway, so ' +
        'an active attacker on the path could answer for the platform.'
    );
    return { rejectUnauthorized: false };
  }

  return { rejectUnauthorized: true };
}

function init(logger) {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) {
    enabled = false;
    logger?.warn(
      'ADMIN_DATABASE_URL is not set — platform users and roles are unavailable. ' +
        'Admin access falls back to the .env superadmin only.'
    );
    return;
  }

  const cfg = {
    connectionString: url,
    ssl: buildSsl(logger),
    max: Number(process.env.ADMIN_PG_POOL_MAX || 5),
    min: 0,
    connectionTimeoutMillis: Number(process.env.ADMIN_PG_CONNECT_TIMEOUT_MS || 8000),
    idleTimeoutMillis: 30000,
    // An admin lookup must never hold a connection open against a sick
    // platform database. It fails, the request gets a 503, the gateway's
    // vendor traffic is untouched.
    statement_timeout: Number(process.env.ADMIN_PG_STATEMENT_TIMEOUT_MS || 5000),
    application_name: 'api-gateway-admin',
  };

  // The platform convention: the password lives in its own variable and wins
  // over anything in the URL.
  if (process.env.ADMIN_PG_PASSWORD) cfg.password = process.env.ADMIN_PG_PASSWORD;

  pool = new Pool(cfg);

  // A pool-level error is an idle client dropped by the server. Without a
  // handler, pg raises it on the process and takes the gateway down with it —
  // which would mean the PLATFORM database killing a connection stops VENDOR
  // traffic. Log it and let the pool reconnect.
  pool.on('error', (err) => {
    lastError = err.message;
    logger?.warn({ err: err.message }, 'platform database pool error (idle client)');
  });

  enabled = true;
  logger?.info(
    { schema: SCHEMA, poolMax: cfg.max },
    'platform database configured for admin identity'
  );
}

function isEnabled() {
  return enabled && pool !== null;
}

async function query(text, params) {
  if (!isEnabled()) throw new Error('platform database is not configured');
  return pool.query(text, params);
}

async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

async function health() {
  if (!isEnabled()) return { enabled: false };
  try {
    const started = Date.now();
    await pool.query('SELECT 1');
    return { enabled: true, ok: true, ms: Date.now() - started, schema: SCHEMA };
  } catch (err) {
    lastError = err.message;
    return { enabled: true, ok: false, error: err.message, schema: SCHEMA };
  }
}

async function close() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
    enabled = false;
  }
}

module.exports = { init, isEnabled, query, one, health, close, SCHEMA, T, lastError: () => lastError };
