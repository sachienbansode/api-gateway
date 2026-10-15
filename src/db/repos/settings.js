'use strict';

const db = require('../pool');

/**
 * Console-managed settings, with the environment as the fallback.
 *
 * Resolution order, and the reason for it:
 *
 *   1. the database — an administrator set it deliberately, in the console
 *   2. the environment — what the deployment was configured with
 *   3. a built-in default — so a fresh install is never broken
 *
 * The database wins because the person who changed it in the console is making
 * a decision about the product; the env var is how the box was set up. If the
 * two disagree the more recent, more deliberate act should hold.
 *
 * Cached for CACHE_MS. These are read on page renders and on every generated
 * document; a query per read would be a query per field.
 */

const CACHE_MS = Number(process.env.SETTINGS_CACHE_MS || 15000);

const FALLBACK = {
  public_base_url: () => process.env.PUBLIC_BASE_URL || '',
  docs_contact: () => process.env.DOCS_CONTACT || '',
  vendor_key_header: () => process.env.API_KEY_HEADER || 'X-API-Key',
};

let cache = null;
let cachedAt = 0;

async function all() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const out = {};
  try {
    const r = await db.query(
      `SELECT key, value, label, help, kind, sort_order, updated_at, updated_by
         FROM gateway.settings ORDER BY sort_order, key`
    );
    for (const row of r?.rows || []) {
      const fallback = FALLBACK[row.key] ? FALLBACK[row.key]() : '';
      out[row.key] = {
        ...row,
        effective: row.value !== null && row.value !== '' ? row.value : fallback,
        source: row.value !== null && row.value !== '' ? 'console' : fallback ? 'environment' : 'unset',
        fallback,
      };
    }
  } catch {
    // Before 008 is applied, or if the database is unreachable: fall back
    // rather than breaking every page that wants a base URL.
    for (const [k, fn] of Object.entries(FALLBACK)) {
      out[k] = { key: k, value: null, effective: fn(), source: 'environment', fallback: fn() };
    }
  }
  cache = out;
  cachedAt = Date.now();
  return out;
}

/** The value to actually use. Never throws; returns '' if nothing is set. */
async function get(key) {
  const s = await all();
  if (s[key]) return s[key].effective || '';
  return FALLBACK[key] ? FALLBACK[key]() : '';
}

/**
 * The vendor-facing base URL, without a trailing slash.
 *
 * Normalised here rather than at every call site, because exactly one of them
 * will forget and produce `https://host//v1/thing` in a document a partner
 * then integrates against.
 */
async function baseUrl() {
  return String(await get('public_base_url')).replace(/\/+$/, '');
}

async function set(key, value, actor) {
  const before = await db.query(`SELECT value FROM gateway.settings WHERE key = $1`, [key]);
  if (!before?.rows?.length) throw new Error(`"${key}" is not a known setting`);
  const old = before.rows[0].value;
  const next = value === null || value === '' ? null : String(value).trim();

  await db.query(
    `UPDATE gateway.settings SET value = $2, updated_at = now(), updated_by = $3 WHERE key = $1`,
    [key, next, actor]
  );
  await db.query(
    `INSERT INTO gateway.settings_audit (key, old_value, new_value, actor) VALUES ($1,$2,$3,$4)`,
    [key, old, next, actor]
  ).catch(() => {});
  cache = null;
  return next;
}

async function history(limit = 20) {
  const r = await db.query(
    `SELECT occurred_at, key, old_value, new_value, actor
       FROM gateway.settings_audit ORDER BY occurred_at DESC LIMIT $1`,
    [limit]
  ).catch(() => null);
  return r?.rows || [];
}

/** Drop the cache — for tests, and after a bulk change. */
function invalidate() { cache = null; }

module.exports = { all, get, set, baseUrl, history, invalidate };
