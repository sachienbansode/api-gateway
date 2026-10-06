'use strict';

const db = require('../pool');

/**
 * Durable monthly quotas.
 *
 * Distinct from the in-process rate limiter, and both are needed:
 *
 *   rate limit  protects your infrastructure from a burst. Must be enforced in
 *               microseconds, so it lives in memory. Resets on restart, and
 *               that is fine — a restart also clears the burst.
 *
 *   quota       is a commercial commitment ("100,000 calls/month"). Must survive
 *               restarts and be shared across instances, so it lives in
 *               Postgres.
 *
 * Enforcement uses a single atomic UPSERT that increments and returns the new
 * count, so two instances cannot both let the 100,000th call through. That is
 * one round trip per request — acceptable now that the database is Azure
 * Postgres in the same region as the VM (single-digit ms). It would not have
 * been acceptable against the AWS instance.
 *
 * The counter increments even for the request that exceeds the quota. That is
 * deliberate: it means the usage figure reflects attempted calls, which is what
 * you want when a vendor argues about being throttled.
 *
 * If the database is unavailable, quota checks FAIL OPEN and log an error.
 * Rationale: a quota is a billing concern, and blocking a paying vendor's
 * traffic because your counter table is unreachable causes more damage than
 * letting a few hundred extra calls through. The rate limiter still protects
 * the infrastructure meanwhile.
 */

/** First day of the current month, UTC, as a YYYY-MM-DD string. */
function currentPeriod(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * Increment and check in one statement.
 *
 * @returns {Promise<{allowed:boolean, used:number, limit:number|null, period:string, degraded?:boolean}>}
 */
async function consume({ vendorId, endpoint, limit, logger }) {
  const period = currentPeriod();

  if (!db.isEnabled() || limit === null || limit === undefined) {
    return { allowed: true, used: 0, limit: limit ?? null, period, tracked: false };
  }

  try {
    // Two rows per call: the vendor total ('*') which the limit applies to, and
    // a per-endpoint row for reporting. Both in one statement, one round trip.
    const res = await db.query(
      `WITH bumped AS (
         INSERT INTO gateway.quota_usage (vendor_id, period, endpoint, calls, updated_at)
         VALUES ($1, $2::date, '*', 1, now()), ($1, $2::date, $3, 1, now())
         ON CONFLICT (vendor_id, period, endpoint) DO UPDATE
            SET calls = gateway.quota_usage.calls + 1,
                updated_at = now()
         RETURNING endpoint, calls
       )
       SELECT calls FROM bumped WHERE endpoint = '*'`,
      [vendorId, period, endpoint]
    );

    const used = Number(res?.rows?.[0]?.calls ?? 0);
    return { allowed: used <= limit, used, limit, period, tracked: true };
  } catch (err) {
    logger?.error(
      { err: err.message, vendorId },
      'quota check failed — failing OPEN. Traffic is still rate limited, but the ' +
        'monthly cap is not being enforced until the database recovers.'
    );
    return { allowed: true, used: 0, limit, period, degraded: true, tracked: false };
  }
}

async function usageFor({ vendorId, period = currentPeriod() }) {
  const res = await db.query(
    `SELECT endpoint, calls, updated_at
       FROM gateway.quota_usage
      WHERE vendor_id = $1 AND period = $2::date
      ORDER BY (endpoint = '*') DESC, calls DESC`,
    [vendorId, period]
  );
  return res?.rows || [];
}

async function allUsage({ period = currentPeriod() } = {}) {
  const res = await db.query(
    `SELECT q.vendor_id, q.calls AS used, v.monthly_quota AS limit
       FROM gateway.quota_usage q
       JOIN gateway.vendors v ON v.id = q.vendor_id
      WHERE q.period = $1::date AND q.endpoint = '*'
      ORDER BY q.calls DESC`,
    [period]
  );
  return res?.rows || [];
}

/** Manual correction, e.g. after a billing dispute or a bad load test. */
async function reset({ vendorId, period = currentPeriod() }) {
  const res = await db.query(
    `DELETE FROM gateway.quota_usage WHERE vendor_id = $1 AND period = $2::date`,
    [vendorId, period]
  );
  return res?.rowCount || 0;
}

module.exports = { consume, usageFor, allUsage, reset, currentPeriod };
