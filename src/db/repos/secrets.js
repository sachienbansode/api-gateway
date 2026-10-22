'use strict';

const db = require('../pool');
const secretbox = require('../../core/secretbox');

/**
 * Supplier credentials: sealed on the way in, opened only where a call is
 * about to be made.
 *
 * There are two SCOPES, and they behave identically in every respect except
 * which table they live in and what their AAD binds them to:
 *
 *   upstream  one credential for a supplier account — the usual case
 *   endpoint  a credential that belongs to one endpoint and must not be
 *             reachable from the others (see 009_endpoint_secrets.sql)
 *
 * One implementation serves both, so a fix to the audit path or the rotation
 * routine cannot apply to one and be forgotten for the other.
 *
 * Two rules this module keeps:
 *
 *   1. Nothing here ever RETURNS a plaintext to a caller that is going to
 *      serialise it. `resolve()` is for the request path and the test button.
 *      `status()` is for everything that renders.
 *
 *   2. Every write is recorded in secret_audit — who, when, which key, and the
 *      last four characters. Never the value. A credential that changed with
 *      no record of who changed it is the start of a bad week.
 */

/**
 * The two scopes, as data.
 *
 * `aad` is the additional authenticated data each ciphertext is bound to. It
 * includes the scope name, so a row copied from upstream_secrets into
 * endpoint_secrets fails its integrity check rather than quietly
 * authenticating as something it is not.
 */
const SCOPES = {
  upstream: {
    table: 'gateway.upstream_secrets',
    column: 'upstream',
    aad: (subject, slot) => `upstream:${subject}:${slot}`,
  },
  endpoint: {
    table: 'gateway.endpoint_secrets',
    column: 'endpoint',
    aad: (subject, slot) => `endpoint:${subject}:${slot}`,
  },
  // A credential that travels as an ordinary request parameter, because the
  // supplier has no Authorization header to put one in — ACL, and most of the
  // SMS and payment gateways that predate JSON. The subject is the endpoint
  // and the slot is the parameter's name, so a sealed `Password` on one
  // endpoint is a different row, with different AAD, from a `Password` on
  // another: one cannot be copied over the other.
  param: {
    table: 'gateway.endpoint_param_secrets',
    column: 'endpoint',
    auditColumn: 'endpoint',
    aad: (subject, slot) => `param:${subject}:${slot}`,
  },
};

function scopeOf(name) {
  const s = SCOPES[name];
  if (!s) throw new Error(`unknown credential scope "${name}"`);
  return s;
}

// ---------------------------------------------------------------------------
// The generic core. Every exported function is a thin call into one of these.
// ---------------------------------------------------------------------------

/**
 * Store (or replace) one credential.
 * @returns {{hint:string, keyId:string, rotated:boolean}}
 */
async function setIn(scopeName, { subject, slot = 'value', plaintext, actor }) {
  const scope = scopeOf(scopeName);
  if (!subject) throw new Error(`which ${scopeName}?`);
  if (typeof plaintext !== 'string' || !plaintext.length) throw new Error('nothing to store');

  const sealed = secretbox.seal(plaintext, scope.aad(subject, slot));
  const existing = await db.query(
    `SELECT 1 FROM ${scope.table} WHERE ${scope.column} = $1 AND slot = $2`,
    [subject, slot]
  );
  const rotated = (existing?.rows?.length || 0) > 0;

  await db.query(
    `INSERT INTO ${scope.table}
       (${scope.column}, slot, ciphertext, iv, tag, key_id, hint, set_by, rotated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9 THEN now() END)
     ON CONFLICT (${scope.column}, slot) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
       key_id = EXCLUDED.key_id, hint = EXCLUDED.hint,
       set_at = now(), set_by = EXCLUDED.set_by, rotated_at = now()`,
    [
      subject, slot, sealed.ciphertext, sealed.iv, sealed.tag, sealed.keyId,
      sealed.hint || null, actor, rotated,
    ]
  );

  await audit({
    scope: scopeName, subject, slot, action: rotated ? 'rotate' : 'set', actor,
    keyId: sealed.keyId, hint: sealed.hint,
  });

  return { hint: sealed.hint, keyId: sealed.keyId, rotated };
}

async function clearIn(scopeName, { subject, slot = 'value', actor }) {
  const scope = scopeOf(scopeName);
  await db.query(
    `DELETE FROM ${scope.table} WHERE ${scope.column} = $1 AND slot = $2`,
    [subject, slot]
  );
  const left = await db.query(
    `SELECT 1 FROM ${scope.table} WHERE ${scope.column} = $1`,
    [subject]
  );
  await audit({ scope: scopeName, subject, slot, action: 'clear', actor });
  return { empty: !left?.rows?.length };
}

/**
 * The plaintext, for a call that is about to be made.
 *
 * Callers must not log it, store it, or put it in a response. There is exactly
 * one correct destination: an Authorization header.
 */
async function resolveIn(scopeName, subject, slot = 'value') {
  const scope = scopeOf(scopeName);
  const r = await db.query(
    `SELECT ciphertext, iv, tag, key_id FROM ${scope.table}
      WHERE ${scope.column} = $1 AND slot = $2`,
    [subject, slot]
  );
  const row = r?.rows?.[0];
  if (!row) return null;
  try {
    return secretbox.open(
      { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, keyId: row.key_id },
      scope.aad(subject, slot)
    );
  } catch (err) {
    // Worth a record of its own: either the key is gone or the row was
    // altered, and both are things somebody needs to see.
    await audit({
      scope: scopeName, subject, slot, action: 'decrypt_failed', actor: 'system',
      keyId: row.key_id, note: err.message,
    }).catch(() => {});
    throw err;
  }
}

async function resolveAllIn(scopeName, subject) {
  const scope = scopeOf(scopeName);
  const r = await db.query(
    `SELECT slot FROM ${scope.table} WHERE ${scope.column} = $1`,
    [subject]
  );
  const out = {};
  for (const row of r?.rows || []) out[row.slot] = await resolveIn(scopeName, subject, row.slot);
  return out;
}

/**
 * Read a stored credential back, deliberately and on the record.
 *
 * Separate from resolve() on purpose. resolve() is the request path — it runs
 * constantly and logs nothing. This runs when a PERSON asks to see a token,
 * and every call writes a row naming them, the subject and the reason they
 * gave. The caller is responsible for checking that they are allowed to.
 */
async function revealIn(scopeName, { subject, slot = 'value', actor, reason = null }) {
  const scope = scopeOf(scopeName);
  const r = await db.query(
    `SELECT key_id, hint FROM ${scope.table} WHERE ${scope.column} = $1 AND slot = $2`,
    [subject, slot]
  );
  const row = r?.rows?.[0];
  if (!row) throw new Error(`no credential is stored for this ${scopeName}`);

  const value = await resolveIn(scopeName, subject, slot);
  // Written BEFORE returning, so a reveal that reaches the caller is a reveal
  // that is in the log. If the insert fails, nobody sees the token.
  await auditStrict({
    scope: scopeName, subject, slot, action: 'reveal', actor,
    keyId: row.key_id, hint: row.hint, reason,
  });
  return value;
}

// ---------------------------------------------------------------------------
// Upstream scope — the original API, unchanged for its callers.
// ---------------------------------------------------------------------------

async function set({ upstream, slot = 'value', plaintext, actor }) {
  const out = await setIn('upstream', { subject: upstream, slot, plaintext, actor });
  // Switch the upstream over, so the resolver stops looking at the env var.
  await db.query(
    `UPDATE gateway.upstreams SET auth_source = 'vault', updated_at = now(), updated_by = $2
      WHERE name = $1`,
    [upstream, actor]
  );
  return out;
}

/** Remove a stored credential and fall back to the ${VAR} reference. */
async function clear({ upstream, slot = 'value', actor }) {
  const { empty } = await clearIn('upstream', { subject: upstream, slot, actor });
  if (empty) {
    await db.query(
      `UPDATE gateway.upstreams SET auth_source = 'env', updated_at = now(), updated_by = $2
        WHERE name = $1`,
      [upstream, actor]
    );
  }
}

const resolve = (upstream, slot = 'value') => resolveIn('upstream', upstream, slot);
const resolveAll = (upstream) => resolveAllIn('upstream', upstream);
const reveal = ({ upstream, slot = 'value', actor, reason = null }) =>
  revealIn('upstream', { subject: upstream, slot, actor, reason });

/** Safe to render: is it set, who set it, when — never the value. */
async function status(upstream = null) {
  const r = await db.query(
    `SELECT * FROM gateway.upstream_credentials
      WHERE ($1::text IS NULL OR upstream = $1) ORDER BY upstream`,
    [upstream]
  );
  return r?.rows || [];
}

// ---------------------------------------------------------------------------
// Endpoint scope.
//
// `setForEndpoint` deliberately does NOT flip the endpoint into override mode
// on its own. Which credential an endpoint calls with is a catalogue decision
// that goes through the Studio's save path with the rest of the endpoint —
// having a secret and using it are two different statements, and conflating
// them would mean uploading a token silently changed what the gateway sends.
// ---------------------------------------------------------------------------

const setForEndpoint = ({ endpoint, slot = 'value', plaintext, actor }) =>
  setIn('endpoint', { subject: endpoint, slot, plaintext, actor });

const clearForEndpoint = ({ endpoint, slot = 'value', actor }) =>
  clearIn('endpoint', { subject: endpoint, slot, actor });

const resolveForEndpoint = (endpoint, slot = 'value') => resolveIn('endpoint', endpoint, slot);
const resolveAllForEndpoint = (endpoint) => resolveAllIn('endpoint', endpoint);
const revealForEndpoint = ({ endpoint, slot = 'value', actor, reason = null }) =>
  revealIn('endpoint', { subject: endpoint, slot, actor, reason });

async function statusForEndpoint(endpoint = null) {
  const r = await db.query(
    `SELECT * FROM gateway.endpoint_credentials
      WHERE ($1::text IS NULL OR endpoint = $1) ORDER BY endpoint`,
    [endpoint]
  );
  return r?.rows || [];
}

// ---------------------------------------------------------------------------
// Parameter scope — a credential the supplier expects as a request parameter.
// ---------------------------------------------------------------------------

const setForParam = ({ endpoint, param, plaintext, actor }) =>
  setIn('param', { subject: endpoint, slot: param, plaintext, actor });

const clearForParam = ({ endpoint, param, actor }) =>
  clearIn('param', { subject: endpoint, slot: param, actor });

const resolveForParam = (endpoint, param) => resolveIn('param', endpoint, param);

/** Every sealed parameter of one endpoint, as { name: plaintext }. */
const resolveAllForParams = (endpoint) => resolveAllIn('param', endpoint);

const revealForParam = ({ endpoint, param, actor, reason = null }) =>
  revealIn('param', { subject: endpoint, slot: param, actor, reason });

/**
 * What a screen is allowed to know: set or not, by whom, when, last four.
 *
 * Reads the view, which selects no ciphertext column at all — so a screen
 * built on this is structurally incapable of leaking one, rather than merely
 * not leaking one today.
 */
async function statusForParams(endpoint = null) {
  const r = await db.query(
    `SELECT * FROM gateway.endpoint_param_credentials
      WHERE ($1::text IS NULL OR endpoint = $1) ORDER BY endpoint, param`,
    [endpoint]
  );
  return r?.rows || [];
}

/** Every endpoint of one upstream that carries its own credential. */
async function endpointOverrides(upstream = null) {
  const r = await db.query(
    `SELECT * FROM gateway.endpoint_credentials
      WHERE auth_mode = 'override' AND ($1::text IS NULL OR upstream = $1)
      ORDER BY endpoint`,
    [upstream]
  );
  return r?.rows || [];
}

// ---------------------------------------------------------------------------
// The record.
// ---------------------------------------------------------------------------

async function auditStrict({
  scope = 'upstream', subject, slot, action, actor,
  keyId = null, hint = null, note = null, reason = null,
}) {
  // The audit table has one column per subject kind, and a parameter
  // credential's subject is an endpoint. secret_audit_scope_chk requires one
  // of them to be set, so a new scope that filled in neither would make every
  // write to it fail — silently, because audit() swallows its errors.
  const auditColumn = SCOPES[scope]?.auditColumn || scope;
  const upstream = auditColumn === 'upstream' ? subject : null;
  const endpoint = auditColumn === 'endpoint' ? subject : null;
  await db.query(
    `INSERT INTO gateway.secret_audit
       (upstream, endpoint, slot, action, actor, key_id, hint, note, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [upstream, endpoint, slot, action, actor, keyId, hint || null, note, reason]
  );
}

/** The same row, but a failure to write it must not fail the operation. */
async function audit(args) {
  await auditStrict(args).catch(() => {});
}

async function accessLog(limit = 25) {
  const r = await db.query(
    `SELECT occurred_at, actor, subject, scope, upstream, endpoint, slot,
            action, reason, hint, key_id
       FROM gateway.credential_access LIMIT $1`,
    [limit]
  );
  return r?.rows || [];
}

async function recentAudit(limit = 20) {
  const r = await db.query(
    `SELECT occurred_at, upstream, endpoint, slot, action, actor, key_id, hint, note
       FROM gateway.secret_audit ORDER BY occurred_at DESC LIMIT $1`,
    [limit]
  );
  return r?.rows || [];
}

/**
 * Re-seal every row that is not on the newest key, in BOTH scopes.
 *
 * Rotation in one pass: read with whichever key the row names, write with the
 * current primary. Rows already on the primary are left alone, so it is safe
 * to run on a schedule.
 */
async function rotateAll(actor) {
  const ring = secretbox.keyring();
  if (!ring) throw new Error('GW_SECRET_KEY is not set');
  const done = [];
  const failed = [];

  for (const scopeName of ['upstream', 'endpoint']) {
    const scope = SCOPES[scopeName];
    const r = await db
      .query(
        `SELECT ${scope.column} AS subject, slot, key_id FROM ${scope.table} WHERE key_id <> $1`,
        [ring.primary]
      )
      // endpoint_secrets does not exist until 009 is applied; a gateway that
      // has not run it yet should still be able to rotate its upstreams.
      .catch(() => null);
    for (const row of r?.rows || []) {
      const label = `${scopeName}:${row.subject}/${row.slot}`;
      try {
        const plain = await resolveIn(scopeName, row.subject, row.slot);
        await setIn(scopeName, { subject: row.subject, slot: row.slot, plaintext: plain, actor });
        done.push(label);
      } catch (err) {
        failed.push({ scope: scopeName, subject: row.subject, slot: row.slot, error: err.message });
      }
    }
  }
  return { rotated: done, failed, primary: ring.primary };
}

module.exports = {
  // upstream scope
  set, clear, resolve, resolveAll, reveal, status,
  // endpoint scope
  setForEndpoint, clearForEndpoint, resolveForEndpoint, resolveAllForEndpoint,
  revealForEndpoint, statusForEndpoint, endpointOverrides,
  // parameter scope
  setForParam, clearForParam, resolveForParam, resolveAllForParams,
  revealForParam, statusForParams,
  // shared
  recentAudit, accessLog, rotateAll,
};
