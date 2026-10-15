'use strict';

const db = require('../pool');

/**
 * Paged, searchable, filterable reads for the catalogue screens.
 *
 * Separate from studio.js because the Studio edits ONE thing and these read
 * MANY — different shapes, different indexes, different failure modes. Mixing
 * them is how a list page ends up loading an endpoint's 938 field rows.
 *
 * Paging is done in SQL with a window-function total, not by fetching
 * everything and slicing in Node. With 68 endpoints that hardly matters; with
 * the fifth supplier onboarded it will.
 */

const MAX_SIZE = 100;

function paging(page, size) {
  const limit = Math.min(Math.max(Number(size) || 25, 1), MAX_SIZE);
  const current = Math.max(Number(page) || 1, 1);
  return { limit, offset: (current - 1) * limit, page: current };
}

function envelope(rows, { limit, offset, page }) {
  const total = rows.length ? Number(rows[0].total_rows) : 0;
  return {
    rows: rows.map(({ total_rows, ...r }) => r),
    total,
    page,
    size: limit,
    pages: Math.max(Math.ceil(total / limit), 1),
    from: total ? offset + 1 : 0,
    to: Math.min(offset + limit, total),
  };
}

/**
 * Endpoints, filtered and paged.
 *
 * `q` searches the reference, the display name, our path and the supplier
 * path. Those are the four things somebody actually has in their hand when
 * they come looking: a name from a ticket, a name from the workbook, a URL a
 * vendor quoted, or a supplier URL from a support thread.
 */
async function endpoints({
  application = null, category = null, status = null, mode = null,
  upstream = null, q = null, page = 1, size = 25,
} = {}) {
  const pg = paging(page, size);
  const res = await db.query(
    `SELECT count(*) OVER () AS total_rows,
            e.name, e.display_name, e.method, e.path, e.upstream, e.upstream_path,
            e.application, e.category, e.api_type, e.response_mode, e.status,
            e.enabled, e.frequency, e.updated_at, e.last_test_at, e.last_test_status,
            cardinality(e.response_fields)                                   AS exposed_count,
            (SELECT count(*) FROM gateway.endpoint_fields f WHERE f.endpoint = e.name) AS field_count,
            (SELECT count(*) FROM gateway.endpoint_params p WHERE p.endpoint = e.name) AS param_count,
            (SELECT count(*) FROM gateway.vendor_endpoints ve WHERE ve.endpoint = e.name) AS vendor_count,
            c.label AS category_label,
            t.label AS type_label,
            u.display_name AS upstream_label
       FROM gateway.endpoints e
       LEFT JOIN gateway.api_categories c
              ON c.application = e.application AND c.code = e.category
       LEFT JOIN gateway.api_types t  ON t.code = e.api_type
       LEFT JOIN gateway.upstreams u  ON u.name = e.upstream
      WHERE ($1::text IS NULL OR e.application = $1)
        AND ($2::text IS NULL OR e.category    = $2)
        AND ($3::text IS NULL OR e.status      = $3)
        AND ($4::text IS NULL OR e.response_mode = $4)
        AND ($5::text IS NULL OR e.upstream    = $5)
        AND ($6::text IS NULL OR e.name ILIKE '%'||$6||'%'
                              OR e.display_name ILIKE '%'||$6||'%'
                              OR e.path ILIKE '%'||$6||'%'
                              OR e.upstream_path ILIKE '%'||$6||'%')
      ORDER BY c.sort_order NULLS LAST, e.display_name NULLS LAST, e.name
      LIMIT $7 OFFSET $8`,
    [application, category, status, mode, upstream, q, pg.limit, pg.offset]
  );
  return envelope(res?.rows || [], pg);
}

/** Supplier APIs, with how much is built on each. */
async function upstreams({ application = null, q = null, page = 1, size = 25 } = {}) {
  const pg = paging(page, size);
  const res = await db.query(
    `SELECT count(*) OVER () AS total_rows,
            u.name, u.display_name, u.vendor_name, u.base_url, u.timeout_ms,
            u.auth_type, u.auth_source, u.auth_value_env, u.enabled, u.application,
            u.last_test_at, u.last_test_status, u.last_test_ms, u.updated_at,
            (s.upstream IS NOT NULL) AS secret_stored,
            s.hint AS secret_hint, s.key_id AS secret_key_id,
            s.set_at AS secret_set_at, s.set_by AS secret_set_by,
            (SELECT count(*) FROM gateway.endpoints e WHERE e.upstream = u.name) AS endpoint_count,
            (SELECT count(*) FROM gateway.endpoints e
              WHERE e.upstream = u.name AND e.status = 'live')               AS live_count,
            (SELECT count(*) FROM gateway.endpoints e
              WHERE e.upstream = u.name AND e.response_mode <> 'whitelist')  AS unfiltered_count
       FROM gateway.upstreams u
       LEFT JOIN gateway.upstream_secrets s
              ON s.upstream = u.name AND s.slot = 'value'
      WHERE ($1::text IS NULL OR u.application = $1)
        AND ($2::text IS NULL OR u.name ILIKE '%'||$2||'%'
                              OR u.display_name ILIKE '%'||$2||'%'
                              OR u.vendor_name ILIKE '%'||$2||'%'
                              OR u.base_url ILIKE '%'||$2||'%')
      ORDER BY u.display_name NULLS LAST, u.name
      LIMIT $3 OFFSET $4`,
    [application, q, pg.limit, pg.offset]
  );
  return envelope(res?.rows || [], pg);
}

/** One supplier, everything about it except the credential itself. */
async function upstream(name) {
  const r = await upstreams({ q: null, page: 1, size: 1 });
  const direct = await db.query(
    `SELECT u.*, (s.upstream IS NOT NULL) AS secret_stored, s.hint AS secret_hint,
            s.key_id AS secret_key_id, s.set_at AS secret_set_at, s.set_by AS secret_set_by
       FROM gateway.upstreams u
       LEFT JOIN gateway.upstream_secrets s ON s.upstream = u.name AND s.slot = 'value'
      WHERE u.name = $1`,
    [name]
  );
  const row = direct?.rows?.[0];
  if (!row) return null;
  const [tests, counts] = await Promise.all([
    db.query(
      `SELECT occurred_at, status, latency_ms, ok, error, actor, request_url
         FROM gateway.connection_tests
        WHERE upstream = $1 ORDER BY occurred_at DESC LIMIT 10`,
      [name]
    ),
    db.query(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE status = 'live')  AS live,
              count(*) FILTER (WHERE status = 'draft') AS draft,
              count(*) FILTER (WHERE response_mode <> 'whitelist') AS unfiltered
         FROM gateway.endpoints WHERE upstream = $1`,
      [name]
    ),
  ]);
  void r;
  return { ...row, tests: tests?.rows || [], counts: counts?.rows?.[0] || {} };
}

/** The values the filter dropdowns offer, counted so empty ones can be hidden. */
async function facets(application = null) {
  const [apps, cats, statuses, modes, ups] = await Promise.all([
    db.query(`SELECT a.code, a.name,
                     (SELECT count(*) FROM gateway.endpoints e WHERE e.application = a.code) AS n
                FROM gateway.applications a WHERE a.enabled ORDER BY a.sort_order, a.name`),
    db.query(`SELECT c.code, c.label,
                     (SELECT count(*) FROM gateway.endpoints e
                       WHERE e.application = c.application AND e.category = c.code) AS n
                FROM gateway.api_categories c
               WHERE c.enabled AND ($1::text IS NULL OR c.application = $1)
               ORDER BY c.sort_order, c.label`, [application]),
    db.query(`SELECT status AS code, count(*) AS n FROM gateway.endpoints
               WHERE ($1::text IS NULL OR application = $1) GROUP BY status ORDER BY status`,
             [application]),
    db.query(`SELECT response_mode AS code, count(*) AS n FROM gateway.endpoints
               WHERE ($1::text IS NULL OR application = $1)
               GROUP BY response_mode ORDER BY response_mode`, [application]),
    db.query(`SELECT u.name AS code, COALESCE(u.display_name, u.name) AS label,
                     (SELECT count(*) FROM gateway.endpoints e WHERE e.upstream = u.name) AS n
                FROM gateway.upstreams u
               WHERE ($1::text IS NULL OR u.application = $1)
               ORDER BY u.display_name NULLS LAST, u.name`, [application]),
  ]);
  return {
    applications: apps?.rows || [],
    categories: cats?.rows || [],
    statuses: statuses?.rows || [],
    modes: modes?.rows || [],
    upstreams: ups?.rows || [],
  };
}

module.exports = { endpoints, upstreams, upstream, facets };
