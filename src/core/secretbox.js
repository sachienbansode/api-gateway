'use strict';

const crypto = require('crypto');

/**
 * Authenticated encryption for supplier credentials held in the database.
 *
 * AES-256-GCM. Every secret gets a fresh 96-bit IV, and the 128-bit auth tag
 * is stored alongside — so a row that has been tampered with fails to decrypt
 * rather than yielding a different plaintext.
 *
 * THE KEY DOES NOT LIVE IN THE DATABASE. It comes from GW_SECRET_KEY in
 * /etc/api-gateway/env, which is the entire point: a backup, a replica, a
 * dump handed to a DBA, a stolen disk — none of them decrypt to anything. An
 * encryption key kept next to the ciphertext it protects is decoration.
 *
 * Key rotation: GW_SECRET_KEY may hold SEVERAL keys, newest first:
 *
 *     GW_SECRET_KEY=v2:<base64 32 bytes>,v1:<base64 32 bytes>
 *
 * New secrets are encrypted with the first; old rows still decrypt with
 * whichever key id they name. Re-encrypting them is then a background job, not
 * an outage. A single bare key with no id is accepted and treated as "v1".
 *
 * Generate one with:
 *     node -e "console.log('v1:'+require('crypto').randomBytes(32).toString('base64'))"
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

let CACHE = null;
let CACHE_SOURCE = null;

class SecretError extends Error {}

/**
 * Parse GW_SECRET_KEY into an ordered map of id -> key buffer.
 * Cached, but keyed on the raw string so a changed env var is picked up.
 */
function keyring() {
  const raw = (process.env.GW_SECRET_KEY || '').trim();
  if (CACHE && CACHE_SOURCE === raw) return CACHE;
  if (!raw) {
    CACHE = null;
    CACHE_SOURCE = null;
    return null;
  }

  const keys = new Map();
  let primary = null;
  for (const partRaw of raw.split(',')) {
    const part = partRaw.trim();
    if (!part) continue;
    const m = /^([A-Za-z0-9_]+):(.+)$/.exec(part);
    const id = m ? m[1] : 'v1';
    const material = m ? m[2] : part;
    let buf;
    try {
      buf = /^[0-9a-fA-F]{64}$/.test(material)
        ? Buffer.from(material, 'hex')
        : Buffer.from(material, 'base64');
    } catch {
      throw new SecretError(`GW_SECRET_KEY: key "${id}" is neither base64 nor hex`);
    }
    if (buf.length !== KEY_BYTES) {
      throw new SecretError(
        `GW_SECRET_KEY: key "${id}" is ${buf.length} bytes, needs ${KEY_BYTES}. ` +
          `Generate one with: node -e "console.log('v1:'+require('crypto').randomBytes(32).toString('base64'))"`
      );
    }
    if (!keys.has(id)) keys.set(id, buf);
    if (!primary) primary = id;
  }
  if (!primary) return null;

  CACHE = { keys, primary };
  CACHE_SOURCE = raw;
  return CACHE;
}

/** Is the gateway able to store secrets at all? */
function enabled() {
  try {
    return keyring() !== null;
  } catch {
    return false;
  }
}

function requireRing() {
  const ring = keyring();
  if (!ring) {
    throw new SecretError(
      'GW_SECRET_KEY is not set on this server, so credentials cannot be stored ' +
        'encrypted. Generate one with: ' +
        'node -e "console.log(\'v1:\'+require(\'crypto\').randomBytes(32).toString(\'base64\'))" ' +
        'then add it to /etc/api-gateway/env and restart.'
    );
  }
  return ring;
}

/**
 * @param {string} plaintext
 * @param {string} aad  Additional authenticated data — bind the ciphertext to
 *                      the row it belongs to, so a ciphertext copied from one
 *                      upstream to another fails to decrypt instead of quietly
 *                      authenticating as the wrong supplier.
 * @returns {{ciphertext: Buffer, iv: Buffer, tag: Buffer, keyId: string, hint: string}}
 */
function seal(plaintext, aad = '') {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new SecretError('nothing to encrypt');
  }
  const ring = requireRing();
  const key = ring.keys.get(ring.primary);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext,
    iv,
    tag: cipher.getAuthTag(),
    keyId: ring.primary,
    // Enough to recognise a credential, not enough to be one. Short secrets
    // get nothing, because four of eight characters is half the secret.
    hint: plaintext.length >= 12 ? plaintext.slice(-4) : '',
  };
}

/** @returns {string} the plaintext. Throws if the row or the key is wrong. */
function open({ ciphertext, iv, tag, keyId }, aad = '') {
  const ring = requireRing();
  const id = keyId || ring.primary;
  const key = ring.keys.get(id);
  if (!key) {
    throw new SecretError(
      `this row was encrypted with key "${id}", which is not in GW_SECRET_KEY. ` +
        `Add that key back, or re-enter the credential.`
    );
  }
  const decipher = crypto.createDecipheriv(ALGO, key, toBuf(iv));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(toBuf(tag));
  try {
    return Buffer.concat([decipher.update(toBuf(ciphertext)), decipher.final()]).toString('utf8');
  } catch {
    // GCM failing means the ciphertext, the IV, the tag or the AAD is not what
    // it was when this was written. Do not say which: that is an oracle.
    throw new SecretError(
      'the stored credential failed its integrity check — it was altered, or it ' +
        'belongs to a different upstream. Re-enter it.'
    );
  }
}

function toBuf(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v && typeof v === 'object' && v.type === 'Buffer') return Buffer.from(v.data);
  if (typeof v === 'string') return Buffer.from(v, 'base64');
  throw new SecretError('expected bytes');
}

/** What the console may show: never the secret, always enough to recognise it. */
function describe(row) {
  if (!row || !row.auth_secret_ciphertext) return null;
  return {
    set: true,
    hint: row.auth_secret_hint ? `••••${row.auth_secret_hint}` : '••••',
    keyId: row.auth_secret_key_id || null,
    setAt: row.auth_secret_set_at || null,
    setBy: row.auth_secret_set_by || null,
  };
}

module.exports = { seal, open, describe, enabled, keyring, SecretError, ALGO };
