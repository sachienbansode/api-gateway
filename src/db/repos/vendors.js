'use strict';

const crypto = require('crypto');
const db = require('../pool');

/**
 * Vendor and key store, with a read-through cache.
 *
 * Why a cache and not a query per request: authentication runs on every single
 * vendor call. Even at 2ms, a database round trip per request means the gateway
 * cannot serve a single request while Postgres is failing over — and Azure
 * Flexible Server does fail over, for maintenance, roughly monthly.
 *
 * So: the full vendor/key set is small (tens of rows), and we hold it in memory,
 * refreshed on an interval. The trade-offs, stated plainly:
 *
 *   - A revocation takes effect within REFRESH_MS (default 30s), not instantly.
 *     `revokeNow()` exists for the case where you need it immediately on the
 *     instance you are talking to; across instances, 30s is the honest number.
 *   - If a refresh fails, the LAST GOOD cache keeps serving. A database outage
 *     therefore degrades key management, not traffic. The alternative — failing
 *     auth closed on a DB blip — turns a 30-second Azure failover into a
 *     vendor-visible outage, which is worse for everyone.
 *
 * `last_used_at` is updated lazily and best-effort, never on the request path.
 */

const REFRESH_MS = Number(process.env.VENDOR_CACHE_REFRESH_MS) || 30000;

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

class VendorStore {
  constructor({ logger, fallback = null } = {}) {
    this.logger = logger;
    /** Vendors from config/env, used when there is no database at all. */
    this.fallback = fallback;
    /** @type {Map<string, object>} key hash -> vendor */
    this.byKeyHash = new Map();
    /** @type {Map<string, object>} vendor id -> vendor */
    this.byId = new Map();
    this.loadedAt = null;
    this.lastRefreshError = null;
    this.usedHashes = new Set();
  }

  /** Load once at boot. Throws if the DB is configured but unreadable. */
  async start() {
    if (!db.isEnabled()) {
      this.byKeyHash = this.fallback?.vendorsByKeyHash || new Map();
      for (const v of this.fallback?.vendors || []) this.byId.set(v.id, v);
      this.loadedAt = new Date();
      this.logger?.info(
        { vendors: this.byId.size, source: 'config' },
        'vendor store loaded from config (no database configured)'
      );
      return;
    }

    await this.refresh({ throwOnError: true });

    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
      this.flushLastUsed().catch(() => {});
    }, REFRESH_MS);
    if (this.timer.unref) this.timer.unref();
  }

  async refresh({ throwOnError = false } = {}) {
    if (!db.isEnabled()) return;

    try {
      const res = await db.query(`
        SELECT v.id, v.name, v.rate_window_ms, v.rate_max, v.monthly_quota,
               COALESCE(
                 (SELECT array_agg(s.scope ORDER BY s.scope)
                    FROM gateway.vendor_scopes s WHERE s.vendor_id = v.id),
                 '{}'
               ) AS scopes,
               COALESCE(
                 (SELECT array_agg(k.key_hash)
                    FROM gateway.vendor_keys k
                   WHERE k.vendor_id = v.id
                     AND k.revoked_at IS NULL
                     AND (k.expires_at IS NULL OR k.expires_at > now())),
                 '{}'
               ) AS key_hashes
          FROM gateway.vendors v
         WHERE v.enabled = TRUE
      `);

      const byKeyHash = new Map();
      const byId = new Map();

      for (const row of res.rows) {
        const vendor = {
          id: row.id,
          name: row.name,
          scopes: new Set(row.scopes || []),
          rateLimit: { windowMs: row.rate_window_ms, max: row.rate_max },
          monthlyQuota: row.monthly_quota === null ? null : Number(row.monthly_quota),
        };
        byId.set(vendor.id, vendor);
        for (const h of row.key_hashes || []) byKeyHash.set(h, vendor);
      }

      const previous = this.byKeyHash.size;
      this.byKeyHash = byKeyHash;
      this.byId = byId;
      this.loadedAt = new Date();
      this.lastRefreshError = null;

      if (previous !== byKeyHash.size) {
        this.logger?.info(
          { vendors: byId.size, liveKeys: byKeyHash.size },
          'vendor store refreshed'
        );
      }
    } catch (err) {
      this.lastRefreshError = err.message;
      this.logger?.error(
        { err: err.message, servingFrom: this.loadedAt },
        'vendor store refresh failed — continuing to serve from the last good cache'
      );
      if (throwOnError) throw err;
    }
  }

  /** @returns {object|undefined} the vendor, or undefined for an unknown key */
  lookupByKey(plaintextKey) {
    const hash = sha256(plaintextKey);
    const vendor = this.byKeyHash.get(hash);
    if (vendor) this.usedHashes.add(hash);
    return vendor;
  }

  getById(id) {
    return this.byId.get(id);
  }

  list() {
    return [...this.byId.values()];
  }

  /**
   * Record that keys were used. Batched off the request path, because a write
   * per request would triple our database traffic to store something nobody
   * reads in real time.
   */
  async flushLastUsed() {
    if (!db.isEnabled() || this.usedHashes.size === 0) return;
    const hashes = [...this.usedHashes];
    this.usedHashes.clear();
    await db
      .query(
        `UPDATE gateway.vendor_keys SET last_used_at = now() WHERE key_hash = ANY($1::char(64)[])`,
        [hashes]
      )
      .catch((err) => this.logger?.warn({ err: err.message }, 'could not update key last_used_at'));
  }

  /** Drop a key from this instance's cache immediately, ahead of the refresh. */
  revokeNow(keyHash) {
    return this.byKeyHash.delete(keyHash);
  }

  snapshot() {
    return {
      source: db.isEnabled() ? 'database' : 'config',
      vendors: this.byId.size,
      liveKeys: this.byKeyHash.size,
      loadedAt: this.loadedAt,
      lastRefreshError: this.lastRefreshError,
    };
  }

  async stop() {
    clearInterval(this.timer);
    // Flush pending last-used marks before the pool closes. Without this, a
    // process that lives less than one refresh interval loses them entirely,
    // and the key inventory reports a key in active use as "never used".
    await this.flushLastUsed().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Write operations, used by the operator CLI rather than the request path.
// ---------------------------------------------------------------------------

async function upsertVendor({ id, name, scopes = [], rateWindowMs, rateMax, monthlyQuota, notes }) {
  return db.transaction(async (client) => {
    await client.query(
      `INSERT INTO gateway.vendors (id, name, rate_window_ms, rate_max, monthly_quota, notes)
       VALUES ($1, $2, COALESCE($3, 60000), COALESCE($4, 600), $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         rate_window_ms = EXCLUDED.rate_window_ms,
         rate_max = EXCLUDED.rate_max,
         monthly_quota = EXCLUDED.monthly_quota,
         notes = COALESCE(EXCLUDED.notes, gateway.vendors.notes),
         updated_at = now()`,
      [id, name || id, rateWindowMs || null, rateMax || null, monthlyQuota ?? null, notes || null]
    );

    // Replace the scope set wholesale, so removing a scope from the call
    // removes it from the vendor. Additive-only would make revoking access
    // awkward and easy to get wrong.
    await client.query(`DELETE FROM gateway.vendor_scopes WHERE vendor_id = $1`, [id]);
    for (const scope of scopes) {
      await client.query(
        `INSERT INTO gateway.vendor_scopes (vendor_id, scope) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [id, scope]
      );
    }
    return { id };
  });
}

/**
 * Issue a key. Returns the plaintext ONCE — it is never stored and cannot be
 * recovered afterwards.
 */
async function issueKey({ vendorId, label = null, expiresAt = null }) {
  const secret = crypto.randomBytes(32).toString('base64url');
  const key = `vk_${vendorId}_${secret}`;
  const hash = sha256(key);

  await db.query(
    `INSERT INTO gateway.vendor_keys (vendor_id, key_hash, label, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [vendorId, hash, label, expiresAt]
  );

  return { key, hash };
}

async function revokeKey({ vendorId, keyHash }) {
  const res = await db.query(
    `UPDATE gateway.vendor_keys
        SET revoked_at = now()
      WHERE vendor_id = $1 AND key_hash = $2 AND revoked_at IS NULL`,
    [vendorId, keyHash]
  );
  return res?.rowCount || 0;
}

async function setEnabled(vendorId, enabled) {
  const res = await db.query(
    `UPDATE gateway.vendors SET enabled = $2, updated_at = now() WHERE id = $1`,
    [vendorId, enabled]
  );
  return res?.rowCount || 0;
}

async function listVendorsWithKeys() {
  const res = await db.query(`
    SELECT v.id, v.name, v.enabled, v.monthly_quota, v.rate_max, v.rate_window_ms,
           COALESCE((SELECT array_agg(s.scope ORDER BY s.scope)
                       FROM gateway.vendor_scopes s WHERE s.vendor_id = v.id), '{}') AS scopes,
           (SELECT count(*) FROM gateway.vendor_keys k
             WHERE k.vendor_id = v.id AND k.revoked_at IS NULL
               AND (k.expires_at IS NULL OR k.expires_at > now())) AS live_keys,
           (SELECT max(k.last_used_at) FROM gateway.vendor_keys k WHERE k.vendor_id = v.id)
             AS last_used_at
      FROM gateway.vendors v
     ORDER BY v.id
  `);
  return res?.rows || [];
}

async function listKeys(vendorId) {
  const res = await db.query(
    `SELECT key_hash, label, created_at, expires_at, revoked_at, last_used_at
       FROM gateway.vendor_keys WHERE vendor_id = $1 ORDER BY created_at DESC`,
    [vendorId]
  );
  return res?.rows || [];
}

module.exports = {
  VendorStore,
  upsertVendor,
  issueKey,
  revokeKey,
  setEnabled,
  listVendorsWithKeys,
  listKeys,
  sha256,
};
