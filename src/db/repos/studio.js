'use strict';

const db = require('../pool');

/**
 * Everything the API Studio reads and writes.
 *
 * The rules this module keeps, because the UI cannot be trusted to:
 *
 *  1. A credential never lands in a column. Step 1 takes a token and writes
 *     the NAME of the environment variable that will hold it. The CHECK
 *     constraint on upstreams backs this up; this is the layer that makes the
 *     UI co-operate rather than fight it.
 *
 *  2. An endpoint is created as a DRAFT and stays unroutable until someone
 *     publishes it. Everything the wizard saves mid-flight is therefore safe
 *     to save — a half-built endpoint cannot be called.
 *
 *  3. The response whitelist lives in endpoint_fields and is copied into
 *     endpoints.response_fields by a database trigger (003). Nothing here
 *     writes response_fields directly; doing so would create a second truth.
 */

// ---------------------------------------------------------------------------
// Dropdowns and lists
// ---------------------------------------------------------------------------

async function applications() {
  const r = await db.query(
    `SELECT a.code, a.name, a.description,
            (SELECT count(*) FROM gateway.endpoints e WHERE e.application = a.code) AS endpoint_count,
            (SELECT count(*) FROM gateway.upstreams u WHERE u.application = a.code) AS upstream_count
       FROM gateway.applications a
      WHERE a.enabled
      ORDER BY a.sort_order, a.name`
  );
  return r?.rows || [];
}

async function apiTypes() {
  const r = await db.query(
    `SELECT code, label, description FROM gateway.api_types
      WHERE enabled ORDER BY sort_order, label`
  );
  return r?.rows || [];
}

async function categories(application = null) {
  const r = await db.query(
    `SELECT application, code, label, description FROM gateway.api_categories
      WHERE enabled AND ($1::text IS NULL OR application = $1)
      ORDER BY sort_order, label`,
    [application]
  );
  return r?.rows || [];
}

/**
 * Upstreams, with the STATUS of each credential — never the credential.
 *
 * The hint and the key id come from upstream_secrets; the ciphertext is not
 * selected at all, so there is nothing here that could be serialised into a
 * page by accident.
 */
async function upstreams(application = null) {
  const r = await db.query(
    `SELECT u.name, u.application, u.display_name, u.vendor_name, u.base_url, u.timeout_ms,
            u.auth_type, u.auth_name, u.auth_value_env, u.auth_user_env, u.auth_source,
            u.enabled, u.health_path, u.last_test_at, u.last_test_status, u.last_test_ms,
            (SELECT count(*) FROM gateway.endpoints e WHERE e.upstream = u.name) AS endpoint_count,
            (s.upstream IS NOT NULL) AS secret_stored,
            s.hint   AS secret_hint,
            s.key_id AS secret_key_id,
            s.set_at AS secret_set_at,
            s.set_by AS secret_set_by
       FROM gateway.upstreams u
       LEFT JOIN gateway.upstream_secrets s
              ON s.upstream = u.name AND s.slot = 'value'
      WHERE ($1::text IS NULL OR u.application = $1)
      ORDER BY u.display_name NULLS LAST, u.name`,
    [application]
  );
  return (r?.rows || []).map((row) => ({
    ...row,
    credential: row.secret_stored
      ? {
          stored: true,
          hint: row.secret_hint ? `••••${row.secret_hint}` : '••••',
          keyId: row.secret_key_id,
          setAt: row.secret_set_at,
          setBy: row.secret_set_by,
        }
      : { stored: false },
  }));
}

async function endpoints(application = null, { status = null, q = null } = {}) {
  const r = await db.query(
    `SELECT e.name, e.application, e.display_name, e.category, e.api_type, e.method,
            e.path, e.upstream, e.upstream_path, e.response_mode, e.status, e.enabled,
            e.frequency, e.updated_at, e.last_test_at, e.last_test_status,
            cardinality(e.response_fields) AS exposed_count,
            (SELECT count(*) FROM gateway.endpoint_fields f WHERE f.endpoint = e.name) AS field_count,
            (SELECT count(*) FROM gateway.endpoint_params p WHERE p.endpoint = e.name) AS param_count,
            c.label AS category_label
       FROM gateway.endpoints e
       LEFT JOIN gateway.api_categories c
              ON c.application = e.application AND c.code = e.category
      WHERE ($1::text IS NULL OR e.application = $1)
        AND ($2::text IS NULL OR e.status = $2)
        AND ($3::text IS NULL OR e.name ILIKE '%'||$3||'%' OR e.display_name ILIKE '%'||$3||'%'
             OR e.path ILIKE '%'||$3||'%')
      ORDER BY c.sort_order NULLS LAST, e.display_name NULLS LAST, e.name`,
    [application, status, q]
  );
  return r?.rows || [];
}

/** One endpoint with its parameters and field catalogue — the wizard's load. */
async function endpoint(name) {
  const e = (await db.query(`SELECT * FROM gateway.endpoints WHERE name = $1`, [name]))?.rows?.[0];
  if (!e) return null;
  const [params, fields, tests] = await Promise.all([
    db.query(
      `SELECT * FROM gateway.endpoint_params WHERE endpoint = $1 ORDER BY sort_order, name`,
      [name]
    ),
    db.query(
      `SELECT * FROM gateway.endpoint_fields WHERE endpoint = $1 ORDER BY sort_order, path`,
      [name]
    ),
    db.query(
      `SELECT occurred_at, kind, status, latency_ms, ok, error, field_count
         FROM gateway.connection_tests WHERE endpoint = $1
        ORDER BY occurred_at DESC LIMIT 5`,
      [name]
    ),
  ]);
  return { ...e, params: params?.rows || [], fields: fields?.rows || [], tests: tests?.rows || [] };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function logChange(client, { actor, action, objectType, objectId, before, after }) {
  await client
    .query(
      `INSERT INTO gateway.catalog_audit (actor, action, object_type, object_id, before, after)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [actor, action, objectType, objectId, before || null, after || null]
    )
    .catch(() => {});
}

async function saveApplication(row, actor) {
  const r = await db.query(
    `INSERT INTO gateway.applications (code, name, description, owner_email, created_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name,
       description = EXCLUDED.description, owner_email = EXCLUDED.owner_email
     RETURNING *`,
    [row.code, row.name, row.description || null, row.ownerEmail || null, actor]
  );
  return r.rows[0];
}

async function saveCategory(row) {
  const r = await db.query(
    `INSERT INTO gateway.api_categories (application, code, label, description, sort_order)
     VALUES ($1,$2,$3,$4,COALESCE($5,100))
     ON CONFLICT (application, code) DO UPDATE SET label = EXCLUDED.label,
       description = EXCLUDED.description
     RETURNING *`,
    [row.application, row.code, row.label, row.description || null, row.sortOrder || null]
  );
  return r.rows[0];
}

/**
 * Step 1. `authValueEnv` must be a ${VAR} reference; the plaintext token the
 * operator typed is never passed to this function — the route strips it and
 * tells them which variable to set on the VM.
 */
async function saveUpstream(row, actor) {
  const before = (await db.query(`SELECT * FROM gateway.upstreams WHERE name = $1`, [row.name]))
    ?.rows?.[0] || null;
  const r = await db.query(
    `INSERT INTO gateway.upstreams
       (name, application, display_name, vendor_name, base_url, timeout_ms, auth_type,
        auth_name, auth_value_env, auth_user_env, health_path, enabled, notes, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (name) DO UPDATE SET
       application=EXCLUDED.application, display_name=EXCLUDED.display_name,
       vendor_name=EXCLUDED.vendor_name, base_url=EXCLUDED.base_url,
       timeout_ms=EXCLUDED.timeout_ms, auth_type=EXCLUDED.auth_type,
       auth_name=EXCLUDED.auth_name, auth_value_env=EXCLUDED.auth_value_env,
       auth_user_env=EXCLUDED.auth_user_env, health_path=EXCLUDED.health_path,
       enabled=EXCLUDED.enabled, notes=EXCLUDED.notes,
       updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING *`,
    [
      row.name, row.application || null, row.displayName || null, row.vendorName || null,
      row.baseUrl, row.timeoutMs || 15000, row.authType || 'none', row.authName || null,
      row.authValueEnv || null, row.authUserEnv || null, row.healthPath || null,
      row.enabled !== false, row.notes || null, actor,
    ]
  );
  await logChange(db, {
    actor, action: before ? 'update' : 'create', objectType: 'upstream',
    objectId: row.name, before, after: r.rows[0],
  });
  return r.rows[0];
}

/**
 * Steps 2 and 3, saved as one transaction.
 *
 * Params and fields are replaced wholesale rather than diffed: the form posts
 * the complete intended state, and a diff that drops a delete is a field that
 * quietly stays exposed.
 */
async function saveEndpoint(row, actor) {
  return db.transaction(async (client) => {
    const before =
      (await client.query(`SELECT * FROM gateway.endpoints WHERE name = $1`, [row.name]))
        ?.rows?.[0] || null;

    const mode = row.responseMode || 'whitelist';
    const res = await client.query(
      `INSERT INTO gateway.endpoints
         (name, application, display_name, category, api_type, description, method, path,
          upstream, upstream_path, upstream_method, response_mode, response_exclude,
          acknowledge_unfiltered, request_query, request_body, rate_window_ms, rate_max,
          idempotency, frequency, refresh_at, sample_path, status, enabled, notes, updated_by,
          auth_mode, auth_type, auth_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
               COALESCE($23,'draft'),$24,$25,$26,
               COALESCE($27,'inherit'),$28,$29)
       ON CONFLICT (name) DO UPDATE SET
         application=EXCLUDED.application, display_name=EXCLUDED.display_name,
         category=EXCLUDED.category, api_type=EXCLUDED.api_type,
         description=EXCLUDED.description, method=EXCLUDED.method, path=EXCLUDED.path,
         upstream=EXCLUDED.upstream, upstream_path=EXCLUDED.upstream_path,
         upstream_method=EXCLUDED.upstream_method, response_mode=EXCLUDED.response_mode,
         response_exclude=EXCLUDED.response_exclude,
         acknowledge_unfiltered=EXCLUDED.acknowledge_unfiltered,
         request_query=EXCLUDED.request_query, request_body=EXCLUDED.request_body,
         rate_window_ms=EXCLUDED.rate_window_ms, rate_max=EXCLUDED.rate_max,
         idempotency=EXCLUDED.idempotency, frequency=EXCLUDED.frequency,
         refresh_at=EXCLUDED.refresh_at, sample_path=EXCLUDED.sample_path,
         enabled=EXCLUDED.enabled, notes=EXCLUDED.notes,
         auth_mode=EXCLUDED.auth_mode, auth_type=EXCLUDED.auth_type,
         auth_name=EXCLUDED.auth_name,
         updated_at=now(), updated_by=EXCLUDED.updated_by
       RETURNING *`,
      [
        row.name, row.application || null, row.displayName || null, row.category || null,
        row.apiType || null, row.description || null, row.method || 'GET', row.path,
        row.upstream, row.upstreamPath, row.upstreamMethod || null, mode,
        row.responseExclude || [], mode === 'passthrough', row.requestQuery || [],
        row.requestBody || [], row.rateWindowMs || 60000, row.rateMax || 60,
        row.idempotency || null, row.frequency || null, row.refreshAt || null,
        row.samplePath || null, row.status || null, row.enabled !== false,
        row.notes || null, actor,
        row.authMode || null, row.authType || null, row.authName || null,
      ]
    );

    if (Array.isArray(row.params)) {
      await client.query(`DELETE FROM gateway.endpoint_params WHERE endpoint = $1`, [row.name]);
      let i = 0;
      for (const p of row.params) {
        i += 10;
        await client.query(
          `INSERT INTO gateway.endpoint_params
             (endpoint, name, location, source, forward_as, data_type, required,
              fixed_value, allowed, example, description, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            row.name, p.name, p.location || 'query', p.source || 'vendor',
            p.forwardAs || null, p.dataType || 'string', p.required === true,
            p.fixedValue || null, p.allowed || [], p.example || null,
            p.description || null, i,
          ]
        );
      }
    }

    if (Array.isArray(row.fields)) {
      await client.query(`DELETE FROM gateway.endpoint_fields WHERE endpoint = $1`, [row.name]);
      let i = 0;
      for (const f of row.fields) {
        i += 10;
        await client.query(
          `INSERT INTO gateway.endpoint_fields
             (endpoint, path, data_type, description, exposed, rename_to, sensitive,
              discovered, first_seen, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            row.name, f.path, f.dataType || null, f.description || null,
            f.exposed === true, f.renameTo || null, f.sensitive === true,
            f.discovered === true, f.firstSeen || null, i,
          ]
        );
      }
    }

    await logChange(client, {
      actor, action: before ? 'update' : 'create', objectType: 'endpoint',
      objectId: row.name, before, after: res.rows[0],
    });
    return res.rows[0];
  });
}

/**
 * Publish or withdraw.
 *
 * Publishing is the only moment an endpoint becomes callable, so it is the
 * right place for the last checks: something to route to, and — for a
 * whitelist — at least one field to return. The CHECK constraint enforces the
 * second one too; this exists to say why in words a person can act on.
 */
async function setStatus(name, status, actor) {
  const e = await endpoint(name);
  if (!e) throw new Error(`endpoint "${name}" does not exist`);

  if (status === 'live') {
    const up = (await db.query(`SELECT enabled FROM gateway.upstreams WHERE name = $1`, [e.upstream]))
      ?.rows?.[0];
    if (!up) throw new Error(`upstream "${e.upstream}" does not exist`);
    if (!up.enabled) throw new Error(`upstream "${e.upstream}" is disabled — enable it first`);
    if (e.response_mode === 'whitelist' && !e.fields.some((f) => f.exposed)) {
      throw new Error('nothing is ticked in step 3 — a whitelist endpoint with no exposed field would return {} for every call');
    }
    if (e.response_mode === 'passthrough' && !e.acknowledge_unfiltered) {
      throw new Error('passthrough has to be acknowledged before it can go live');
    }

    // An endpoint set to use its OWN credential, with no credential saved.
    // Caught here rather than at boot because the useful moment to say so is
    // while the person who configured it is still looking at the screen — at
    // boot it is a log line, and the endpoint simply would not be served.
    const cred = (
      await db
        .query(`SELECT broken FROM gateway.endpoint_credentials WHERE endpoint = $1`, [name])
        .catch(() => null)
    )?.rows?.[0];
    if (cred && cred.broken) {
      throw new Error(
        'this endpoint is set to use its own key, but no key has been saved for it. ' +
          'Save the key in step 1, or switch it back to the supplier credential.'
      );
    }
  }

  const r = await db.query(
    `UPDATE gateway.endpoints SET status = $2, updated_at = now(), updated_by = $3
      WHERE name = $1 RETURNING *`,
    [name, status, actor]
  );
  await logChange(db, {
    actor, action: status === 'live' ? 'publish' : 'withdraw',
    objectType: 'endpoint', objectId: name, after: r.rows[0],
  });
  return r.rows[0];
}

async function deleteEndpoint(name, actor) {
  const before = (await db.query(`SELECT * FROM gateway.endpoints WHERE name = $1`, [name]))
    ?.rows?.[0] || null;
  if (before && before.status === 'live') {
    throw new Error('withdraw it first — a live endpoint should stop answering before it disappears');
  }
  await db.query(`DELETE FROM gateway.endpoints WHERE name = $1`, [name]);
  await logChange(db, { actor, action: 'delete', objectType: 'endpoint', objectId: name, before });
}

// ---------------------------------------------------------------------------
// Test log
// ---------------------------------------------------------------------------

async function recordTest(t) {
  const r = await db.query(
    `INSERT INTO gateway.connection_tests
       (kind, upstream, endpoint, actor, request_url, status, latency_ms, ok, error,
        field_count, response_sample)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, occurred_at`,
    [
      t.kind, t.upstream || null, t.endpoint || null, t.actor, t.requestUrl || null,
      t.status || null, t.latencyMs || null, t.ok === true, t.error || null,
      t.fieldCount || null, t.responseSample ? JSON.stringify(t.responseSample) : null,
    ]
  );
  if (t.kind === 'upstream' && t.upstream) {
    await db.query(
      `UPDATE gateway.upstreams SET last_test_at = now(), last_test_status = $2, last_test_ms = $3
        WHERE name = $1`,
      [t.upstream, t.status || null, t.latencyMs || null]
    ).catch(() => {});
  }
  if (t.kind === 'endpoint' && t.endpoint) {
    await db.query(
      `UPDATE gateway.endpoints SET last_test_at = now(), last_test_status = $2 WHERE name = $1`,
      [t.endpoint, t.status || null]
    ).catch(() => {});
  }
  return r?.rows?.[0];
}

async function recentTests(limit = 20) {
  const r = await db.query(
    `SELECT occurred_at, kind, upstream, endpoint, actor, status, latency_ms, ok, error
       FROM gateway.connection_tests ORDER BY occurred_at DESC LIMIT $1`,
    [limit]
  );
  return r?.rows || [];
}

module.exports = {
  applications, apiTypes, categories, upstreams, endpoints, endpoint,
  saveApplication, saveCategory, saveUpstream, saveEndpoint, setStatus, deleteEndpoint,
  recordTest, recentTests,
};
