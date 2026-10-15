'use strict';

const db = require('../pool');

/**
 * The two log screens.
 *
 * TRAFFIC is gateway.audit_log: one row per call a consumer made. Thousands a
 * day, so every query here is bounded, indexed and paged. Nothing on this path
 * does `SELECT *` without a LIMIT.
 *
 * CHANGES is gateway.admin_audit: one row per thing an administrator did,
 * across the catalogue, credentials and settings.
 *
 * Paging uses `count(*) OVER ()` rather than a second COUNT query: one trip,
 * and the total always describes the same snapshot as the rows beside it.
 */

const PAGE = 25;

const clampPage = (p) => Math.max(1, Number(p) || 1);

/** Window clauses shared by both screens. 'all' is deliberately offered. */
const SINCE = {
  '1h': "1 hour", '24h': "24 hours", '7d': "7 days", '30d': "30 days",
};
function sinceClause(key, col = 'occurred_at') {
  const iv = SINCE[key];
  return iv ? `AND ${col} >= now() - interval '${iv}'` : '';
}

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

async function traffic({
  q = null, consumer = null, endpoint = null, status = null,
  since = '24h', page = 1, size = PAGE,
} = {}) {
  const p = clampPage(page);

  // `status` is a BAND, not a code: people look for "the errors", and nobody
  // remembers whether the one they want was a 502 or a 504.
  const band = {
    ok: 'AND status < 400',
    client: 'AND status >= 400 AND status < 500',
    server: 'AND status >= 500',
    error: 'AND status >= 400',
  }[status] || '';

  const res = await db.query(
    `SELECT count(*) OVER () AS total_rows,
            id, request_id, occurred_at, vendor_id, endpoint, method, path,
            status, error_code, upstream, upstream_status, upstream_ms,
            total_ms, response_mode, host(client_ip) AS client_ip, internal_reason
       FROM gateway.audit_log
      WHERE true
        ${sinceClause(since)}
        ${band}
        AND ($1::text IS NULL OR vendor_id = $1)
        AND ($2::text IS NULL OR endpoint = $2)
        AND ($3::text IS NULL OR
             path ILIKE '%' || $3 || '%' OR
             endpoint ILIKE '%' || $3 || '%' OR
             request_id::text = $3)
      ORDER BY occurred_at DESC
      LIMIT $4 OFFSET $5`,
    [consumer, endpoint, q, size, (p - 1) * size]
  );
  const rows = res?.rows || [];
  const total = rows.length ? Number(rows[0].total_rows) : 0;
  return { rows, total, page: p, size, pages: Math.max(1, Math.ceil(total / size)) };
}

/**
 * Headline numbers for the window being looked at.
 *
 * Returned beside the rows so the screen can say "4,812 calls, 3.1% errors"
 * rather than making somebody count a page of twenty-five and guess.
 */
async function trafficSummary({ since = '24h', consumer = null, endpoint = null } = {}) {
  const r = await db.query(
    `SELECT count(*)::int                                            AS calls,
            count(*) FILTER (WHERE status >= 400)::int               AS errors,
            count(*) FILTER (WHERE status >= 500)::int               AS server_errors,
            count(DISTINCT vendor_id)::int                           AS consumers,
            count(DISTINCT endpoint)::int                            AS endpoints,
            -- Percentiles, not an average. A handful of 15-second timeouts
            -- drag a mean well above everything anyone actually experienced,
            -- so the one number people would quote is the one that describes
            -- nobody. The median says what a typical call cost; the 95th says
            -- what the unlucky twentieth cost; the max says how bad it got.
            coalesce(percentile_disc(0.50) WITHIN GROUP (ORDER BY total_ms), 0)::int AS p50_ms,
            coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY total_ms), 0)::int AS p95_ms,
            coalesce(max(total_ms), 0)::int                          AS max_ms
       FROM gateway.audit_log
      WHERE true ${sinceClause(since)}
        AND ($1::text IS NULL OR vendor_id = $1)
        AND ($2::text IS NULL OR endpoint = $2)`,
    [consumer, endpoint]
  );
  return r?.rows?.[0] || {};
}

/** Values to populate the filter dropdowns, with counts. */
async function trafficFacets({ since = '24h' } = {}) {
  const [consumers, endpoints] = await Promise.all([
    db.query(
      `SELECT vendor_id AS code, count(*)::int AS n FROM gateway.audit_log
        WHERE vendor_id IS NOT NULL ${sinceClause(since)}
        GROUP BY vendor_id ORDER BY n DESC LIMIT 50`
    ),
    db.query(
      `SELECT endpoint AS code, count(*)::int AS n FROM gateway.audit_log
        WHERE endpoint IS NOT NULL ${sinceClause(since)}
        GROUP BY endpoint ORDER BY n DESC LIMIT 50`
    ),
  ]);
  return { consumers: consumers?.rows || [], endpoints: endpoints?.rows || [] };
}

/**
 * Every row sharing one request id.
 *
 * The request id is what a consumer quotes when they call to complain, so it
 * is the one lookup that has to be exact rather than a search.
 */
async function byRequestId(requestId) {
  const r = await db.query(
    `SELECT * FROM gateway.audit_log WHERE request_id::text = $1
      ORDER BY occurred_at LIMIT 50`,
    [String(requestId)]
  );
  return r?.rows || [];
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

async function changes({
  q = null, actor = null, area = null, since = '30d', page = 1, size = PAGE,
} = {}) {
  const p = clampPage(page);
  try {
    const res = await db.query(
      `SELECT count(*) OVER () AS total_rows, *
         FROM gateway.admin_audit
        WHERE true
          ${sinceClause(since)}
          AND ($1::text IS NULL OR actor = $1)
          AND ($2::text IS NULL OR area = $2)
          AND ($3::text IS NULL OR
               object ILIKE '%' || $3 || '%' OR
               actor ILIKE '%' || $3 || '%' OR
               action ILIKE '%' || $3 || '%')
        ORDER BY occurred_at DESC
        LIMIT $4 OFFSET $5`,
      [actor, area, q, size, (p - 1) * size]
    );
    const rows = res?.rows || [];
    const total = rows.length ? Number(rows[0].total_rows) : 0;
    return { rows, total, page: p, size, pages: Math.max(1, Math.ceil(total / size)) };
  } catch (err) {
    // Before 013 is applied. Say so rather than showing an empty log, which
    // would read as "nobody has changed anything" — the opposite of the truth.
    if (/relation .* does not exist/i.test(err.message)) {
      return { rows: [], total: 0, page: 1, size, pages: 1, missing: true };
    }
    throw err;
  }
}

async function changeFacets() {
  try {
    const [actors, areas] = await Promise.all([
      db.query(`SELECT actor AS code, count(*)::int AS n FROM gateway.admin_audit
                 GROUP BY actor ORDER BY n DESC LIMIT 50`),
      db.query(`SELECT area AS code, count(*)::int AS n FROM gateway.admin_audit
                 GROUP BY area ORDER BY area`),
    ]);
    return { actors: actors?.rows || [], areas: areas?.rows || [] };
  } catch {
    return { actors: [], areas: [] };
  }
}

/** The full before/after for one catalogue change, fetched only when asked. */
async function catalogDiff(id) {
  const r = await db.query(
    `SELECT occurred_at, actor, action, object_type, object_id, before, after
       FROM gateway.catalog_audit WHERE id = $1`,
    [Number(id)]
  );
  return r?.rows?.[0] || null;
}

module.exports = {
  PAGE, SINCE,
  traffic, trafficSummary, trafficFacets, byRequestId,
  changes, changeFacets, catalogDiff,
};
