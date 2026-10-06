'use strict';

const crypto = require('crypto');
const db = require('../pool');

/**
 * Idempotency for write endpoints.
 *
 * The problem this solves: the vendor POSTs /v1/shipments, the response is lost
 * to a network timeout, their client retries, and you have created two
 * shipments. Nothing else in the gateway prevents that, and it will happen —
 * you do not control the vendor's retry logic or the network between you.
 *
 * The protocol:
 *   1. Vendor sends `Idempotency-Key: <their unique string>` on a write.
 *   2. We atomically INSERT a claim row. Winning the insert means "you are the
 *      first, go do the work".
 *   3. On success we store the status and body against that key.
 *   4. A later request with the same key returns the stored response without
 *      touching the upstream.
 *
 * Three cases that matter and are easy to get wrong:
 *
 *   - Same key, DIFFERENT body. That is a client bug, and returning the first
 *     response would hide it while the vendor believes their second, different
 *     request succeeded. We reject with 422. Hence request_hash.
 *
 *   - Same key, request still in flight (the vendor retried before we
 *     answered). Returning "not found" would double-execute. We return 409 so
 *     the vendor retries in a moment and then gets the stored response.
 *
 *   - A claim whose request died mid-flight — process killed, upstream hung —
 *     would otherwise block that key forever. Claims carry a lease; once it
 *     lapses the claim is considered abandoned and can be retaken.
 */

const LEASE_MS = Number(process.env.IDEMPOTENCY_LEASE_MS) || 60000;
const TTL_HOURS = Number(process.env.IDEMPOTENCY_TTL_HOURS) || 24;

/**
 * Hash the parts of the request that define what it DOES. Deliberately excludes
 * headers and the key itself: the same logical operation retried must hash the
 * same even if a trace header changed.
 */
function hashRequest({ method, path, query, body }) {
  const canonical = JSON.stringify({
    method,
    path,
    query: sortObject(query || {}),
    body: sortObject(body || {}),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Stable key order, recursively, so {a,b} and {b,a} hash identically. */
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortObject(value[k]);
        return acc;
      }, {});
  }
  return value;
}

const OUTCOME = {
  PROCEED: 'proceed',
  REPLAY: 'replay',
  IN_PROGRESS: 'in_progress',
  MISMATCH: 'mismatch',
};

/**
 * Try to claim the key.
 *
 * @returns {Promise<{outcome:string, status?:number, body?:any}>}
 */
async function claim({ vendorId, key, endpoint, requestHash }) {
  if (!db.isEnabled()) return { outcome: OUTCOME.PROCEED, persisted: false };

  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

  // One statement does the whole decision atomically. The DO UPDATE fires only
  // when the existing claim is an expired lease still in_progress — i.e. an
  // abandoned attempt — which lets us retake it. A live claim or a completed
  // row conflicts and returns no rows, and we then read what is there.
  const inserted = await db.query(
    `INSERT INTO gateway.idempotency_keys
       (vendor_id, idempotency_key, endpoint, request_hash, state, expires_at, created_at)
     VALUES ($1, $2, $3, $4, 'in_progress', $5, now())
     ON CONFLICT (vendor_id, idempotency_key, endpoint) DO UPDATE
        SET request_hash = EXCLUDED.request_hash,
            created_at   = now(),
            expires_at   = EXCLUDED.expires_at
      WHERE gateway.idempotency_keys.state = 'in_progress'
        AND gateway.idempotency_keys.created_at < now() - ($6 || ' milliseconds')::interval
     RETURNING 1 AS claimed`,
    [vendorId, key, endpoint, requestHash, expiresAt, String(LEASE_MS)]
  );

  if (inserted?.rowCount > 0) {
    return { outcome: OUTCOME.PROCEED, persisted: true };
  }

  // Something is already there. Find out what.
  const existing = await db.query(
    `SELECT request_hash, state, response_status, response_body, created_at
       FROM gateway.idempotency_keys
      WHERE vendor_id = $1 AND idempotency_key = $2 AND endpoint = $3`,
    [vendorId, key, endpoint]
  );

  const row = existing?.rows?.[0];
  if (!row) {
    // Raced with an expiry sweep. Treat as first attempt.
    return { outcome: OUTCOME.PROCEED, persisted: true };
  }

  if (row.request_hash !== requestHash) {
    return { outcome: OUTCOME.MISMATCH };
  }

  if (row.state === 'completed') {
    return {
      outcome: OUTCOME.REPLAY,
      status: row.response_status,
      body: row.response_body,
    };
  }

  return { outcome: OUTCOME.IN_PROGRESS };
}

/** Store the response so a retry can replay it. */
async function complete({ vendorId, key, endpoint, status, body }) {
  if (!db.isEnabled()) return;
  await db.query(
    `UPDATE gateway.idempotency_keys
        SET state = 'completed',
            response_status = $4,
            response_body = $5::jsonb,
            completed_at = now()
      WHERE vendor_id = $1 AND idempotency_key = $2 AND endpoint = $3`,
    [vendorId, key, endpoint, status, JSON.stringify(body ?? null)]
  );
}

/**
 * Release a claim after a failure, so the vendor can retry immediately rather
 * than waiting out the lease. Only failures that are safe to retry should call
 * this — if the upstream may have applied the write, leave the claim in place
 * and let the lease expire.
 */
async function release({ vendorId, key, endpoint }) {
  if (!db.isEnabled()) return;
  await db.query(
    `DELETE FROM gateway.idempotency_keys
      WHERE vendor_id = $1 AND idempotency_key = $2 AND endpoint = $3
        AND state = 'in_progress'`,
    [vendorId, key, endpoint]
  );
}

/** Housekeeping. Run from cron alongside the audit purge. */
async function purgeExpired() {
  const res = await db.query(
    `DELETE FROM gateway.idempotency_keys WHERE expires_at < now()`
  );
  return res?.rowCount || 0;
}

module.exports = {
  claim,
  complete,
  release,
  purgeExpired,
  hashRequest,
  sortObject,
  OUTCOME,
  LEASE_MS,
  TTL_HOURS,
};
