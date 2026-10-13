'use strict';

const fs = require('fs');

/**
 * Build a pg connection config from a prefixed block of environment variables.
 *
 * One function, used by both connections, so the two blocks in the env file
 * behave identically. Each takes:
 *
 *   <PREFIX>_DATABASE_URL        postgres URL, WITHOUT the password
 *   <PREFIX>_PG_PASSWORD         applied after the URL is parsed, and overrides
 *                                any password embedded in it
 *   <PREFIX>_PG_SSL              'true' (default) | 'false'
 *   <PREFIX>_PG_SSL_INSECURE     'true' skips certificate verification
 *   <PREFIX>_PG_CA_CERT_PATH     verify against this CA instead of the system store
 *   <PREFIX>_PG_POOL_MAX         maximum pooled connections
 *   <PREFIX>_PG_CONNECT_TIMEOUT_MS
 *   <PREFIX>_PG_STATEMENT_TIMEOUT_MS
 *
 * Why the password lives in its own variable rather than inside the URL:
 * connection URLs get logged, pasted into tickets, echoed by tooling and shown
 * in `ps`. Keeping the secret separate means none of that leaks a credential.
 * The URL on its own is not sensitive; the password never appears beside it.
 */

function env(prefix, name) {
  return process.env[`${prefix}_${name}`];
}

function buildSsl(prefix, logger) {
  const mode = String(env(prefix, 'PG_SSL') ?? 'true').toLowerCase();

  if (mode === 'false' || mode === 'disable') {
    logger?.warn(`${prefix}: database TLS is DISABLED — local development only`);
    return false;
  }

  const caPath = env(prefix, 'PG_CA_CERT_PATH');
  if (caPath) {
    if (!fs.existsSync(caPath)) {
      throw new Error(`${prefix}_PG_CA_CERT_PATH points at a file that does not exist: ${caPath}`);
    }
    return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }

  if (String(env(prefix, 'PG_SSL_INSECURE')).toLowerCase() === 'true') {
    logger?.warn(
      `${prefix}: TLS certificate verification is OFF (${prefix}_PG_SSL_INSECURE=true). ` +
        'The connection is encrypted but not authenticated, so an active attacker ' +
        'on the path could answer for the database. Set ' +
        `${prefix}_PG_CA_CERT_PATH to the server's CA instead.`
    );
    return { rejectUnauthorized: false };
  }

  return { rejectUnauthorized: true };
}

/**
 * @param {string} prefix       e.g. 'GW' or 'AUTH'
 * @param {object} [opts]
 * @param {string} [opts.url]           an explicit URL, overriding the env block
 * @param {string[]} [opts.fallbackUrlVars]  older variable names still honoured
 * @param {number} [opts.poolMax]
 * @param {string} [opts.applicationName]
 * @param {object} [opts.logger]
 * @returns {{config:object, url:string, source:string}|null}
 *          null when no URL is configured at all.
 */
function build(prefix, opts = {}) {
  const { logger } = opts;

  let url = opts.url || env(prefix, 'DATABASE_URL');
  let source = url ? `${prefix}_DATABASE_URL` : null;

  // Older single-variable names, so an existing env file keeps working.
  if (!url) {
    for (const name of opts.fallbackUrlVars || []) {
      if (process.env[name]) {
        url = process.env[name];
        source = name;
        logger?.warn(
          `${name} is set. The current convention is ${prefix}_DATABASE_URL with ` +
            `${prefix}_PG_PASSWORD alongside it.`
        );
        break;
      }
    }
  }

  if (!url) return null;

  // ⚠ Do NOT pass `connectionString` together with a separate `password`.
  //
  // node-postgres parses the connection string AFTER merging your options, and
  // a URL with no password in it parses to `password: null`. That null then
  // overwrites the password you set, and the driver fails at the handshake
  // with "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string"
  // — while `config.password` still reads as a string right up to the moment
  // the Pool is constructed. Verified against a real PostgreSQL 16 with
  // scram-sha-256: connectionString+password FAILS, discrete fields WORK.
  //
  // So when the password lives in its own variable — which is the whole point
  // of the <PREFIX>_PG_PASSWORD convention — decompose the URL into discrete
  // fields and do not hand the driver a connection string at all.
  const password = env(prefix, 'PG_PASSWORD');
  const urlHasPassword = /:\/\/[^/@]*:[^@]+@/.test(url);

  if (!password && !urlHasPassword) {
    throw new Error(
      `${prefix}_PG_PASSWORD is empty and ${prefix}_DATABASE_URL carries no password. ` +
        `Set ${prefix}_PG_PASSWORD in the env file.`
    );
  }

  let target;
  if (password) {
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`${prefix}_DATABASE_URL is not a valid postgres URL: ${url}`);
    }
    target = {
      host: u.hostname,
      port: Number(u.port) || 5432,
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined,
      user: decodeURIComponent(u.username) || undefined,
      password,
    };
    if (urlHasPassword) {
      logger?.warn(
        `${prefix}_DATABASE_URL contains a password AND ${prefix}_PG_PASSWORD is set. ` +
          `${prefix}_PG_PASSWORD is being used. Remove the one in the URL.`
      );
    }
  } else {
    target = { connectionString: url };
  }

  const config = {
    ...target,
    ssl: buildSsl(prefix, logger),
    max: Number(env(prefix, 'PG_POOL_MAX')) || opts.poolMax || 10,
    min: 0,
    idleTimeoutMillis: Number(env(prefix, 'PG_IDLE_TIMEOUT_MS')) || 30000,
    connectionTimeoutMillis: Number(env(prefix, 'PG_CONNECT_TIMEOUT_MS')) || 5000,
    // Cap how long one query may hold a connection. Without it a single slow
    // query can starve the pool and take the service down with it.
    statement_timeout: Number(env(prefix, 'PG_STATEMENT_TIMEOUT_MS')) || 5000,
    application_name: opts.applicationName || 'api-gateway',
  };

  return { config, url, source };
}

/** Host and database only — safe to log. Never includes credentials. */
function describe(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}

module.exports = { build, describe };
