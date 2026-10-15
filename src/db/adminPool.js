'use strict';

const { Pool } = require('pg');
const pgConfig = require('./pgConfig');

/**
 * Second connection: the PLATFORM meta database (users, roles).
 *
 * Why a second pool rather than a second schema on the gateway pool:
 * Postgres cannot join across databases. `gateway` and `uat_ananta_staging`
 * are different databases on the same server, so a query from the gateway pool
 * can never name "admin-staging-api".users. OFS hit exactly this and solved it
 * the same way — two pools, two adapters, no cross-database SQL (REUSE.md §1.1).
 *
 * This pool never writes IDENTITY. The gateway reads users, roles and grants
 * and changes none of them, so a gateway compromise cannot become a way to
 * grant yourself access to the platform.
 *
 * It has exactly one write: an append to "admin-staging-api".email_logs, so
 * the codes this console emails appear in Admin → Email & OTP Logs beside
 * every other platform email rather than in a private log nobody checks
 * (REUSE.md §3, and the OFS app does the same). Appending to a log is a
 * different act from changing who may do what, and the log is the thing an
 * auditor reads. If you give this connection a narrowed login, it needs
 * SELECT on users and roles plus INSERT on email_logs — nothing else.
 *
 * Env block prefix: AUTH_ (see .env.example)
 *
 *   AUTH_DATABASE_URL      postgres URL WITHOUT the password
 *   AUTH_PG_PASSWORD       applied after the URL is parsed, and overrides any
 *                          password embedded in it
 *   AUTH_PG_SSL            'true' (default) or 'false'
 *   AUTH_PG_POOL_MAX       default 5 — admin traffic is console users, not
 *                          vendor traffic, and the 15s permission cache means
 *                          even a busy console is a trickle of queries
 *   ADMIN_SCHEMA           default 'admin-staging-api'
 *
 * Absent AUTH_DATABASE_URL, `isEnabled()` is false and the gateway runs with
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

function init(logger) {
  const built = pgConfig.build('AUTH', {
    fallbackUrlVars: ['ADMIN_DATABASE_URL'],
    poolMax: 5,
    applicationName: 'api-gateway-auth',
    logger,
  });

  if (!built) {
    enabled = false;
    logger?.warn(
      'AUTH_DATABASE_URL is not set — platform users and roles are unavailable. ' +
        'Admin access falls back to the .env superadmin only.'
    );
    return;
  }

  const cfg = built.config;
  cfg.connectionTimeoutMillis = Number(process.env.AUTH_PG_CONNECT_TIMEOUT_MS) || 8000;

  pool = new Pool(cfg);

  // A pool-level error is an idle client dropped by the server. Without a
  // handler, pg raises it on the process and takes the gateway down with it —
  // which would mean the AUTH database killing a connection stops VENDOR
  // traffic. Log it and let the pool reconnect.
  pool.on('error', (err) => {
    lastError = err.message;
    logger?.warn({ err: err.message }, 'auth database pool error (idle client)');
  });

  enabled = true;
  logger?.info(
    { database: pgConfig.describe(built.url), from: built.source, schema: SCHEMA, poolMax: cfg.max },
    'auth database configured for admin identity'
  );
}

function isEnabled() {
  return enabled && pool !== null;
}

async function query(text, params) {
  if (!isEnabled()) throw new Error('auth database is not configured');
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
