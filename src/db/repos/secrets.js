'use strict';

const db = require('../pool');
const secretbox = require('../../core/secretbox');

/**
 * Supplier credentials: sealed on the way in, opened only where a call is
 * about to be made.
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

const AAD = (upstream, slot) => `upstream:${upstream}:${slot}`;

/**
 * Store (or replace) one credential.
 * @returns {{hint:string, keyId:string, rotated:boolean}}
 */
async function set({ upstream, slot = 'value', plaintext, actor }) {
  if (!upstream) throw new Error('which upstream?');
  if (typeof plaintext !== 'string' || !plaintext.length) throw new Error('nothing to store');

  const sealed = secretbox.seal(plaintext, AAD(upstream, slot));
  const existing = await db.query(
    `SELECT upstream FROM gateway.upstream_secrets WHERE upstream = $1 AND slot = $2`,
    [upstream, slot]
  );
  const rotated = (existing?.rows?.length || 0) > 0;

  await db.query(
    `INSERT INTO gateway.upstream_secrets
       (upstream, slot, ciphertext, iv, tag, key_id, hint, set_by, rotated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9 THEN now() END)
     ON CONFLICT (upstream, slot) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
       key_id = EXCLUDED.key_id, hint = EXCLUDED.hint,
       set_at = now(), set_by = EXCLUDED.set_by, rotated_at = now()`,
    [
      upstream, slot, sealed.ciphertext, sealed.iv, sealed.tag, sealed.keyId,
      sealed.hint || null, actor, rotated,
    ]
  );

  // Switch the upstream over, so the resolver stops looking at the env var.
  await db.query(
    `UPDATE gateway.upstreams SET auth_source = 'vault', updated_at = now(), updated_by = $2
      WHERE name = $1`,
    [upstream, actor]
  );

  await audit({
    upstream, slot, action: rotated ? 'rotate' : 'set', actor,
    keyId: sealed.keyId, hint: sealed.hint,
  });

  return { hint: sealed.hint, keyId: sealed.keyId, rotated };
}

/** Remove a stored credential and fall back to the ${VAR} reference. */
async function clear({ upstream, slot = 'value', actor }) {
  await db.query(
    `DELETE FROM gateway.upstream_secrets WHERE upstream = $1 AND slot = $2`,
    [upstream, slot]
  );
  const left = await db.query(
    `SELECT 1 FROM gateway.upstream_secrets WHERE upstream = $1`,
    [upstream]
  );
  if (!left?.rows?.length) {
    await db.query(
      `UPDATE gateway.upstreams SET auth_source = 'env', updated_at = now(), updated_by = $2
        WHERE name = $1`,
      [upstream, actor]
    );
  }
  await audit({ upstream, slot, action: 'clear', actor });
}

/**
 * The plaintext, for a call that is about to be made.
 *
 * Callers must not log it, store it, or put it in a response. There is exactly
 * one correct destination: an Authorization header.
 */
async function resolve(upstream, slot = 'value') {
  const r = await db.query(
    `SELECT ciphertext, iv, tag, key_id FROM gateway.upstream_secrets
      WHERE upstream = $1 AND slot = $2`,
    [upstream, slot]
  );
  const row = r?.rows?.[0];
  if (!row) return null;
  try {
    return secretbox.open(
      { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, keyId: row.key_id },
      AAD(upstream, slot)
    );
  } catch (err) {
    // Worth a record of its own: either the key is gone or the row was
    // altered, and both are things somebody needs to see.
    await audit({
      upstream, slot, action: 'decrypt_failed', actor: 'system',
      keyId: row.key_id, note: err.message,
    }).catch(() => {});
    throw err;
  }
}

/** Every stored credential for an upstream, decrypted. For the request path. */
async function resolveAll(upstream) {
  const r = await db.query(
    `SELECT slot FROM gateway.upstream_secrets WHERE upstream = $1`,
    [upstream]
  );
  const out = {};
  for (const row of r?.rows || []) out[row.slot] = await resolve(upstream, row.slot);
  return out;
}

/** Safe to render: is it set, who set it, when — never the value. */
async function status(upstream = null) {
  const r = await db.query(
    `SELECT * FROM gateway.upstream_credentials
      WHERE ($1::text IS NULL OR upstream = $1) ORDER BY upstream`,
    [upstream]
  );
  return r?.rows || [];
}

async function audit({ upstream, slot, action, actor, keyId = null, hint = null, note = null }) {
  await db
    .query(
      `INSERT INTO gateway.secret_audit (upstream, slot, action, actor, key_id, hint, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [upstream, slot, action, actor, keyId, hint || null, note]
    )
    .catch(() => {});
}

async function recentAudit(limit = 20) {
  const r = await db.query(
    `SELECT occurred_at, upstream, slot, action, actor, key_id, hint, note
       FROM gateway.secret_audit ORDER BY occurred_at DESC LIMIT $1`,
    [limit]
  );
  return r?.rows || [];
}

/**
 * Re-seal every row that is not on the newest key.
 *
 * Rotation in one pass: read with whichever key the row names, write with the
 * current primary. Rows already on the primary are left alone, so it is safe
 * to run on a schedule.
 */
async function rotateAll(actor) {
  const ring = secretbox.keyring();
  if (!ring) throw new Error('GW_SECRET_KEY is not set');
  const r = await db.query(
    `SELECT upstream, slot, key_id FROM gateway.upstream_secrets WHERE key_id <> $1`,
    [ring.primary]
  );
  const done = [];
  const failed = [];
  for (const row of r?.rows || []) {
    try {
      const plain = await resolve(row.upstream, row.slot);
      await set({ upstream: row.upstream, slot: row.slot, plaintext: plain, actor });
      done.push(`${row.upstream}/${row.slot}`);
    } catch (err) {
      failed.push({ upstream: row.upstream, slot: row.slot, error: err.message });
    }
  }
  return { rotated: done, failed, primary: ring.primary };
}

module.exports = { set, clear, resolve, resolveAll, status, recentAudit, rotateAll };
