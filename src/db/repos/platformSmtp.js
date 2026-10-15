'use strict';

const crypto = require('crypto');
const adminDb = require('../adminPool');

/**
 * The platform's SMTP settings, read (never written) from its admin schema.
 *
 * One mail configuration for the whole platform is the point. The gateway does
 * not get its own SMTP host, its own credential and its own from-address to
 * drift out of date — when someone rotates the mail password in the platform's
 * Settings screen, this console follows automatically.
 *
 * The stored password is AES-256-GCM, in the platform's own format:
 *
 *     ivHex : authTagHex : ciphertextHex
 *
 * with the key being sha256(API_KEY_SECRET). That is the platform's scheme,
 * reimplemented here rather than imported, because the two applications do not
 * share a codebase. If the platform ever changes it, this is the one function
 * that has to change with it — hence the explicit shape check and a message
 * that says what to look at.
 *
 * API_KEY_SECRET must therefore be byte-identical to the platform's. It is NOT
 * the gateway's GW_SECRET_KEY and must not be set to it: GW_SECRET_KEY protects
 * supplier credentials and has no business being shared with another system.
 */

const CACHE_MS = Number(process.env.SMTP_CACHE_MS || 60000);
let cached = null; // { at, row }

function decryptPassword(encrypted) {
  const secret = process.env.API_KEY_SECRET;
  if (!secret) {
    throw new Error(
      'API_KEY_SECRET is not set, so the platform SMTP password cannot be decrypted. ' +
        'It must be the same value the platform uses.'
    );
  }
  const parts = String(encrypted).split(':');
  if (parts.length !== 3) {
    throw new Error(
      'The stored SMTP password is not in the expected iv:tag:ciphertext form. ' +
        'Re-save the SMTP settings in the platform.'
    );
  }
  const [ivHex, tagHex, encHex] = parts;
  const key = crypto.createHash('sha256').update(secret).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/** Raw row, cached briefly. Contains the ENCRYPTED password; safe to hold. */
async function settings() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.row;
  if (!adminDb.isEnabled()) throw new Error('the platform directory is not configured');
  const row = await adminDb.one(`SELECT * FROM ${adminDb.T('smtp_settings')} WHERE id = 1`);
  cached = { at: Date.now(), row };
  return row;
}

function invalidate() {
  cached = null;
}

/**
 * Is mail actually usable right now?
 *
 * Answered without sending anything, so the login screen can say "a code
 * cannot be sent" instead of accepting a password and then failing silently
 * with the person staring at a screen that asks for a code they will never
 * receive.
 */
async function ready() {
  let row;
  try {
    row = await settings();
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!row) return { ok: false, reason: 'the platform has no SMTP settings row' };
  // '1' is what the platform's own code treats as "not configured" — a
  // placeholder somebody typed to get past a required field.
  if (!row.host || row.host === '1') return { ok: false, reason: 'no SMTP host is configured in the platform' };
  if (!row.username || !row.password_encrypted) {
    return { ok: false, reason: 'the platform SMTP credentials are incomplete' };
  }
  if (!row.from_email) return { ok: false, reason: 'the platform SMTP settings have no from-address' };
  if (!process.env.API_KEY_SECRET) {
    return { ok: false, reason: 'API_KEY_SECRET is not set on this server' };
  }
  try {
    decryptPassword(row.password_encrypted);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  return { ok: true, host: row.host, from: row.from_email };
}

/** Everything nodemailer needs, with the password decrypted. Never logged. */
async function transportConfig() {
  const row = await settings();
  const state = await ready();
  if (!state.ok) throw new Error(state.reason);
  return {
    transport: {
      host: row.host,
      port: row.port || 587,
      secure: row.secure === true,
      auth: { user: row.username, pass: decryptPassword(row.password_encrypted) },
    },
    from: `"${row.from_name || 'Ashika API Portal'}" <${row.from_email}>`,
  };
}

module.exports = { settings, ready, transportConfig, invalidate, decryptPassword };
