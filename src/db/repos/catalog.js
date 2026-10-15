'use strict';

const db = require('../pool');
const secretRepo = require('./secrets');

/**
 * The API catalogue: upstreams, endpoints, per-vendor endpoint grants and IP
 * allowlists — all managed from the admin console.
 *
 * Two rules this module exists to enforce:
 *
 *  1. No credential is ever written here. An upstream's auth value holds the
 *     NAME of an environment variable (`${INTERNAL_NODE_API_TOKEN}`), and the
 *     secret stays in the env file on the VM. A database is backed up and
 *     shared; a token in a backup is a token you cannot confidently rotate.
 *     The table has a CHECK constraint, and `toManifest` passes the reference
 *     through unchanged so the existing `${VAR}` interpolation resolves it at
 *     load time exactly as it does for YAML.
 *
 *  2. Rows are turned back into the SAME plain objects the YAML files produce,
 *     then handed to the same validator. There is one definition of what a
 *     valid endpoint is, so a whitelist mistake made in a form fails the same
 *     way as one committed to a file.
 */

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function listUpstreams() {
  const res = await db.query(`SELECT * FROM gateway.upstreams ORDER BY name`);
  return res?.rows || [];
}

async function listEndpoints() {
  const res = await db.query(`
    SELECT e.*,
           COALESCE((SELECT jsonb_object_agg(i.key, i.value)
                       FROM gateway.endpoint_inject i WHERE i.endpoint = e.name), '{}'::jsonb)
             AS inject,
           (SELECT count(*) FROM gateway.vendor_endpoints ve WHERE ve.endpoint = e.name)
             AS vendor_count
      FROM gateway.endpoints e
     ORDER BY e.path, e.method
  `);
  return res?.rows || [];
}

async function endpointsForVendor(vendorId) {
  const res = await db.query(
    `SELECT endpoint FROM gateway.vendor_endpoints WHERE vendor_id = $1 ORDER BY endpoint`,
    [vendorId]
  );
  return (res?.rows || []).map((r) => r.endpoint);
}

async function listVendorEndpointMap() {
  const res = await db.query(
    `SELECT vendor_id, array_agg(endpoint ORDER BY endpoint) AS endpoints
       FROM gateway.vendor_endpoints GROUP BY vendor_id`
  );
  const out = new Map();
  for (const r of res?.rows || []) out.set(r.vendor_id, r.endpoints);
  return out;
}

async function listIps(vendorId = null) {
  const res = await db.query(
    `SELECT vendor_id, host(cidr) AS ip, masklen(cidr) AS mask, cidr::text AS cidr,
            label, created_at
       FROM gateway.vendor_ips
      WHERE ($1::text IS NULL OR vendor_id = $1)
      ORDER BY vendor_id, cidr`,
    [vendorId]
  );
  return res?.rows || [];
}

/** vendor id -> CIDR[]; absent means "no restriction". */
async function ipMap() {
  const res = await db.query(
    `SELECT vendor_id, array_agg(cidr::text) AS cidrs
       FROM gateway.vendor_ips GROUP BY vendor_id`
  );
  const out = new Map();
  for (const r of res?.rows || []) out.set(r.vendor_id, r.cidrs);
  return out;
}

// ---------------------------------------------------------------------------
// Row -> manifest
// ---------------------------------------------------------------------------

/**
 * Each endpoint gets a scope of its own, `ep:<name>`, and a vendor's grants
 * become exactly those scopes.
 *
 * Why not add a second authorisation path keyed on vendor_endpoints: because
 * the runtime already decides access by scope, and two mechanisms that must
 * agree eventually will not. This keeps one.
 */
const scopeFor = (endpointName) => `ep:${endpointName}`;

/**
 * A credential sealed in the database is NOT put into the manifest here.
 *
 * The manifest goes through config interpolation, which resolves ${NAME}
 * against the environment — and a token that happened to contain `${` would
 * be mangled, or worse, would resolve to something else. So vault upstreams
 * carry this placeholder through validation, and the real value is injected
 * afterwards by applyVaultSecrets(). The secret therefore never passes through
 * a string-rewriting step.
 */
const VAULT_PLACEHOLDER = '__vault__';

function upstreamToManifest(row) {
  const auth = { type: row.auth_type };
  const vault = row.auth_source === 'vault';
  const main = vault ? VAULT_PLACEHOLDER : row.auth_value_env;
  const user = vault ? VAULT_PLACEHOLDER : row.auth_user_env;

  if (row.auth_type === 'bearer') auth.token = main;
  else if (row.auth_type === 'header') {
    auth.name = row.auth_name;
    auth.value = main;
  } else if (row.auth_type === 'query') {
    auth.name = row.auth_name;
    auth.value = main;
  } else if (row.auth_type === 'basic') {
    auth.username = user;
    auth.password = main;
  }
  return { baseUrl: row.base_url, timeoutMs: row.timeout_ms, auth };
}

/**
 * Put the decrypted credentials into an ALREADY VALIDATED config.
 *
 * Called after config.loadFrom(), never before. Mutates in place because the
 * validated objects are what the request path holds a reference to.
 *
 * A failure to decrypt one upstream disables that upstream rather than taking
 * the reload down: the rest of the catalogue has nothing to do with it. The
 * returned `failed` list is for the caller to log — loudly.
 */
/** Put one decrypted value into an auth block, whatever its scheme. */
function fillAuth(auth, secrets) {
  const value = secrets.value;
  if (!value) throw new Error('no credential is stored');
  if (auth.type === 'bearer') auth.token = value;
  else if (auth.type === 'header' || auth.type === 'query') auth.value = value;
  else if (auth.type === 'basic') {
    auth.password = value;
    if (secrets.username) auth.username = secrets.username;
  }
}

async function applyVaultSecrets(cfg, scoped, logger) {
  // Accepts the old positional array as well as {upstreams, endpoints}, so a
  // caller that has not been updated still gets correct upstream behaviour
  // rather than silently filling nothing.
  const vaultUpstreams = Array.isArray(scoped) ? scoped : scoped?.upstreams || [];
  const vaultEndpoints = Array.isArray(scoped) ? [] : scoped?.endpoints || [];

  const failed = [];
  for (const name of vaultUpstreams) {
    const up = cfg.upstreams && cfg.upstreams[name];
    if (!up || !up.auth) continue;
    try {
      fillAuth(up.auth, await secretRepo.resolveAll(name));
    } catch (err) {
      failed.push({ upstream: name, error: err.message });
      // Leaving the placeholder in place would send the literal string
      // "__vault__" to the supplier as a bearer token. Remove the upstream
      // instead, which makes its endpoints unroutable — visibly broken beats
      // quietly authenticating as nobody.
      delete cfg.upstreams[name];
      cfg.endpoints = cfg.endpoints.filter((e) => e.upstream !== name);
      logger?.error?.(
        { upstream: name, err: err.message },
        'could not decrypt this upstream credential — its endpoints are not being served'
      );
    }
  }

  // Endpoint-scoped credentials. One failure removes ONE endpoint; its
  // siblings on the same upstream are unaffected, which is the entire reason
  // for scoping a credential this narrowly in the first place.
  //
  // Note what is NOT done here: falling back to the upstream's token. An
  // override exists because the wider credential must not be used for this
  // call, so an endpoint whose own credential cannot be read goes dark.
  for (const name of vaultEndpoints) {
    const ep = (cfg.endpoints || []).find((e) => e.name === name);
    if (!ep || !ep.auth) continue;
    try {
      fillAuth(ep.auth, await secretRepo.resolveAllForEndpoint(name));
    } catch (err) {
      failed.push({ endpoint: name, error: err.message });
      cfg.endpoints = cfg.endpoints.filter((e) => e.name !== name);
      logger?.error?.(
        { endpoint: name, err: err.message },
        'could not decrypt this endpoint credential — the endpoint is not being served. ' +
          'It is NOT falling back to the supplier credential.'
      );
    }
  }
  return failed;
}

function endpointToManifest(row) {
  const isWrite = ['POST', 'PUT', 'PATCH'].includes(row.method);
  const ep = {
    name: row.name,
    method: row.method,
    path: row.path,
    upstream: row.upstream,
    upstreamPath: row.upstream_path,
    scopes: [scopeFor(row.name)],
    rateLimit: { windowMs: row.rate_window_ms, max: row.rate_max },
    response: {
      mode: row.response_mode,
      fields: row.response_fields || [],
      exclude: row.response_exclude || [],
    },
    request: {
      query: row.request_query || [],
      body: row.request_body || [],
      inject: row.inject || {},
    },
  };
  if (row.upstream_method) ep.upstreamMethod = row.upstream_method;
  if (row.response_mode === 'passthrough') ep.response.acknowledgeUnfiltered = true;
  if (row.idempotency) ep.idempotency = row.idempotency;
  else if (!isWrite) ep.idempotency = 'off';

  // An endpoint that carries its own credential. The VALUE is the placeholder
  // here for the same reason an upstream's is: the loader interpolates
  // ${NAME} against the environment, and a real token must not go through a
  // string rewriter. applyVaultSecrets() puts it in after validation.
  if (row.auth_mode === 'override') {
    const type = row.auth_type || 'none';
    const auth = { type };
    if (type === 'bearer') auth.token = VAULT_PLACEHOLDER;
    else if (type === 'header' || type === 'query') {
      auth.name = row.auth_name;
      auth.value = VAULT_PLACEHOLDER;
    } else if (type === 'basic') {
      auth.username = VAULT_PLACEHOLDER;
      auth.password = VAULT_PLACEHOLDER;
    }
    ep.auth = auth;
  }
  return ep;
}

/**
 * Build the whole catalogue as plain objects, ready for config.loadFrom().
 *
 * Disabled upstreams and endpoints are left out rather than marked, so a
 * disabled endpoint is genuinely unroutable — not merely flagged somewhere.
 */
async function toManifest() {
  const [ups, eps, vmap] = await Promise.all([
    listUpstreams(),
    listEndpoints(),
    listVendorEndpointMap(),
  ]);

  const upstreams = {};
  const vaultUpstreams = [];
  for (const u of ups) {
    if (!u.enabled) continue;
    upstreams[u.name] = upstreamToManifest(u);
    if (u.auth_source === 'vault' && u.auth_type !== 'none') vaultUpstreams.push(u.name);
  }

  // `status` arrived with migration 003. A draft is an endpoint someone is
  // still building in the Studio; it must not be routed. Rows that predate the
  // column were set to 'live' by the migration, so this does not quietly
  // unpublish anything that was already being served.
  const live = eps.filter(
    (e) => e.enabled && upstreams[e.upstream] && (e.status === undefined || e.status === 'live')
  );
  const endpoints = live.map(endpointToManifest);
  const liveNames = new Set(live.map((e) => e.name));

  // Endpoints whose credential has to be unsealed before they can be called.
  // 'none' is an override too — "call this one unauthenticated" — but it has
  // no secret to fetch.
  const vaultEndpoints = live
    .filter((e) => e.auth_mode === 'override' && e.auth_type && e.auth_type !== 'none')
    .map((e) => e.name);

  return {
    upstreams, endpoints, vendorScopes: vmap, liveEndpointNames: liveNames,
    vaultUpstreams, vaultEndpoints, scopeFor,
  };
}

/**
 * Fold the database catalogue into the YAML files, producing one source for
 * config.loadFrom().
 *
 * The database wins on a name collision, and it is told about rather than
 * resolved quietly: two definitions of one endpoint is a situation someone
 * needs to go and tidy up, not a thing to discover during an incident.
 *
 * Vendors stay in YAML. Partner identity is managed on the Vendors screen and
 * in the vendors/vendor_keys tables, and this function is about the catalogue.
 */
async function mergeWithFiles(files) {
  const dbm = await toManifest();
  const fileUps = (files.upstreams && files.upstreams.upstreams) || {};
  const fileEps = (files.endpoints && files.endpoints.endpoints) || [];

  const upstreams = { ...fileUps, ...dbm.upstreams };
  const dbNames = new Set(dbm.endpoints.map((e) => e.name));
  const kept = fileEps.filter((e) => !dbNames.has(e.name));
  const shadowed = fileEps.filter((e) => dbNames.has(e.name)).map((e) => e.name);

  return {
    upstreams: { upstreams },
    endpoints: { endpoints: [...kept, ...dbm.endpoints] },
    vendors: files.vendors || {},
    // Not read by the validator; carried so the caller can act on them.
    _shadowed: shadowed,
    _vaultUpstreams: dbm.vaultUpstreams,
    _vaultEndpoints: dbm.vaultEndpoints,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function logChange({ actor, action, objectType, objectId, before = null, after = null }) {
  await db
    .query(
      `INSERT INTO gateway.catalog_audit (actor, action, object_type, object_id, before, after)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [actor, action, objectType, objectId, before, after]
    )
    .catch(() => {});
}

async function upsertUpstream(row, actor) {
  const before = (await db.query('SELECT * FROM gateway.upstreams WHERE name = $1', [row.name]))
    ?.rows?.[0] || null;
  const res = await db.query(
    `INSERT INTO gateway.upstreams
       (name, base_url, timeout_ms, auth_type, auth_name, auth_value_env, auth_user_env,
        enabled, notes, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (name) DO UPDATE SET
       base_url=EXCLUDED.base_url, timeout_ms=EXCLUDED.timeout_ms,
       auth_type=EXCLUDED.auth_type, auth_name=EXCLUDED.auth_name,
       auth_value_env=EXCLUDED.auth_value_env, auth_user_env=EXCLUDED.auth_user_env,
       enabled=EXCLUDED.enabled, notes=EXCLUDED.notes,
       updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING *`,
    [
      row.name, row.baseUrl, row.timeoutMs || 5000, row.authType || 'none',
      row.authName || null, row.authValueEnv || null, row.authUserEnv || null,
      row.enabled !== false, row.notes || null, actor,
    ]
  );
  await logChange({
    actor, action: before ? 'update' : 'create', objectType: 'upstream',
    objectId: row.name, before, after: res.rows[0],
  });
  return res.rows[0];
}

async function deleteUpstream(name, actor) {
  const before = (await db.query('SELECT * FROM gateway.upstreams WHERE name = $1', [name]))
    ?.rows?.[0] || null;
  // ON DELETE RESTRICT means this throws while any endpoint still points here,
  // which is the correct outcome — deleting it would silently break routes.
  await db.query('DELETE FROM gateway.upstreams WHERE name = $1', [name]);
  await logChange({ actor, action: 'delete', objectType: 'upstream', objectId: name, before });
}

async function upsertEndpoint(row, actor) {
  const before = (await db.query('SELECT * FROM gateway.endpoints WHERE name = $1', [row.name]))
    ?.rows?.[0] || null;
  const res = await db.query(
    `INSERT INTO gateway.endpoints
       (name, method, path, upstream, upstream_path, upstream_method,
        response_mode, response_fields, response_exclude, acknowledge_unfiltered,
        request_query, request_body, rate_window_ms, rate_max, idempotency,
        enabled, notes, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (name) DO UPDATE SET
       method=EXCLUDED.method, path=EXCLUDED.path, upstream=EXCLUDED.upstream,
       upstream_path=EXCLUDED.upstream_path, upstream_method=EXCLUDED.upstream_method,
       response_mode=EXCLUDED.response_mode, response_fields=EXCLUDED.response_fields,
       response_exclude=EXCLUDED.response_exclude,
       acknowledge_unfiltered=EXCLUDED.acknowledge_unfiltered,
       request_query=EXCLUDED.request_query, request_body=EXCLUDED.request_body,
       rate_window_ms=EXCLUDED.rate_window_ms, rate_max=EXCLUDED.rate_max,
       idempotency=EXCLUDED.idempotency, enabled=EXCLUDED.enabled, notes=EXCLUDED.notes,
       updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING *`,
    [
      row.name, row.method || 'GET', row.path, row.upstream, row.upstreamPath,
      row.upstreamMethod || null, row.responseMode || 'whitelist',
      row.responseFields || [], row.responseExclude || [],
      row.responseMode === 'passthrough',
      row.requestQuery || [], row.requestBody || [],
      row.rateWindowMs || 60000, row.rateMax || 60, row.idempotency || null,
      row.enabled !== false, row.notes || null, actor,
    ]
  );
  await logChange({
    actor, action: before ? 'update' : 'create', objectType: 'endpoint',
    objectId: row.name, before, after: res.rows[0],
  });
  return res.rows[0];
}

async function setEndpointEnabled(name, enabled, actor) {
  const res = await db.query(
    `UPDATE gateway.endpoints SET enabled=$2, updated_at=now(), updated_by=$3
      WHERE name=$1 RETURNING *`,
    [name, enabled, actor]
  );
  await logChange({
    actor, action: enabled ? 'enable' : 'disable', objectType: 'endpoint',
    objectId: name, after: res?.rows?.[0] || null,
  });
  return res?.rows?.[0];
}

async function deleteEndpoint(name, actor) {
  const before = (await db.query('SELECT * FROM gateway.endpoints WHERE name = $1', [name]))
    ?.rows?.[0] || null;
  await db.query('DELETE FROM gateway.endpoints WHERE name = $1', [name]);
  await logChange({ actor, action: 'delete', objectType: 'endpoint', objectId: name, before });
}

/** Replace a vendor's endpoint grants wholesale. */
async function setVendorEndpoints(vendorId, endpointNames, actor) {
  const before = await endpointsForVendor(vendorId);
  await db.query('DELETE FROM gateway.vendor_endpoints WHERE vendor_id = $1', [vendorId]);
  if (endpointNames.length) {
    await db.query(
      `INSERT INTO gateway.vendor_endpoints (vendor_id, endpoint)
       SELECT $1, e FROM unnest($2::text[]) AS e
       ON CONFLICT DO NOTHING`,
      [vendorId, endpointNames]
    );
  }
  await logChange({
    actor, action: 'grant', objectType: 'vendor_endpoints', objectId: vendorId,
    before: { endpoints: before }, after: { endpoints: endpointNames },
  });
}

async function addIp(vendorId, cidr, label, actor) {
  await db.query(
    `INSERT INTO gateway.vendor_ips (vendor_id, cidr, label, created_by)
     VALUES ($1, $2::cidr, $3, $4) ON CONFLICT DO NOTHING`,
    [vendorId, cidr, label || null, actor]
  );
  await logChange({
    actor, action: 'add', objectType: 'vendor_ip', objectId: vendorId, after: { cidr, label },
  });
}

async function removeIp(vendorId, cidr, actor) {
  await db.query('DELETE FROM gateway.vendor_ips WHERE vendor_id = $1 AND cidr = $2::cidr', [
    vendorId,
    cidr,
  ]);
  await logChange({
    actor, action: 'remove', objectType: 'vendor_ip', objectId: vendorId, before: { cidr },
  });
}

async function recentChanges(limit = 50) {
  const res = await db.query(
    `SELECT occurred_at, actor, action, object_type, object_id
       FROM gateway.catalog_audit ORDER BY occurred_at DESC LIMIT $1`,
    [limit]
  );
  return res?.rows || [];
}

module.exports = {
  scopeFor,
  listUpstreams,
  listEndpoints,
  endpointsForVendor,
  listVendorEndpointMap,
  listIps,
  ipMap,
  toManifest,
  mergeWithFiles,
  applyVaultSecrets,
  VAULT_PLACEHOLDER,
  upsertUpstream,
  deleteUpstream,
  upsertEndpoint,
  setEndpointEnabled,
  deleteEndpoint,
  setVendorEndpoints,
  addIp,
  removeIp,
  recentChanges,
};
