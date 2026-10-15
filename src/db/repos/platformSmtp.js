'use strict';

const crypto = require('crypto');
const adminDb = require('../adminPool');

/**
 * Where the sign-in code gets emailed from.
 *
 * TWO sources, and the first one is the one to use.
 *
 * 1. SMTP_* in this server's own env file. Its own mailbox credential,
 *    readable only by this application.
 *
 * 2. The platform's smtp_settings row, read (never written). Appealing at
 *    first glance — one mail configuration, rotated in one place — and the
 *    reason it is NOT the default is worth writing down, because it was the
 *    original design here and it was wrong.
 *
 *    The platform stores that password encrypted under sha256(API_KEY_SECRET).
 *    Reading it means putting API_KEY_SECRET on this VM. But in the platform
 *    that same secret also encrypts, at minimum:
 *
 *      * every saved ETL database connection password  (db/etlPool.js)
 *      * every partner API key, revealably             (routes/admin.js)
 *
 *    So sharing it to send one email would mean that anyone who reads this
 *    gateway's env file can decrypt the platform's stored database passwords
 *    and partner keys. That is an enormous grant bought for a very small
 *    convenience, and it quietly makes this VM as sensitive as the platform
 *    itself. Option 1 costs one more line in an env file.
 *
 * Option 2 remains available for a deployment that genuinely shares a trust
 * boundary with the platform, and has to be turned on deliberately.
 */

const CACHE_MS = Number(process.env.SMTP_CACHE_MS || 60000);
let cached = null; // { at, row }

/**
 * This server's own mail credential, if it has one.
 *
 * Variable names match the OFS app's lib/mailer.js exactly — SMTP_HOST,
 * SMTP_USER, SMTP_PASS and the rest — because an operator configuring mail on
 * a third box should not have to learn a third set of names. OFS reached this
 * same escape hatch for the same reason, and its comment says so: reading the
 * platform row needs API_KEY_SECRET to be byte-identical on a different host,
 * and MFA sitting behind that dependency locks everyone out when it is not.
 */
function localConfig() {
  const host = String(process.env.SMTP_HOST || '').trim();
  if (!host) return null;
  const user = String(process.env.SMTP_USER || '').trim();
  const port = Number(process.env.SMTP_PORT) || 587;
  return {
    host,
    port,
    // 465 is implicit TLS; 587 is STARTTLS, which nodemailer does with
    // secure:false. Defaulting from the port is what OFS does and it is right:
    // the common mistake is setting 465 and leaving secure false, which hangs
    // until the timeout rather than failing with anything readable.
    secure: process.env.SMTP_SECURE != null
      ? /^(1|true|yes)$/i.test(String(process.env.SMTP_SECURE).trim())
      : port === 465,
    user,
    // Plain text here on purpose: sealing it would need the very secret this
    // path exists to do without. Keep the env file 0600.
    pass: String(process.env.SMTP_PASS || ''),
    from: String(process.env.SMTP_FROM || user).trim(),
    fromName: String(process.env.SMTP_FROM_NAME || '').trim() || 'Ashika - Pravah',
  };
}

/** Has the operator opted in to borrowing the platform's mail credential? */
function platformAllowed() {
  return String(process.env.SMTP_FROM_PLATFORM || 'false').toLowerCase() === 'true';
}

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
  const local = localConfig();
  if (local) {
    if (!local.from) return { ok: false, reason: 'SMTP_FROM is not set' };
    return { ok: true, host: local.host, from: local.from, source: 'this server' };
  }
  if (!platformAllowed()) {
    return {
      ok: false,
      reason:
        'no mail is configured for this gateway. Set SMTP_HOST, SMTP_USER, ' +
        'SMTP_PASS and SMTP_FROM in /etc/api-gateway/env — the same names the ' +
        'OFS app uses. (Borrowing the ' +
        "platform's mail credential instead needs SMTP_FROM_PLATFORM=true and puts " +
        "the platform's API_KEY_SECRET on this server — read why that is a bad trade " +
        'in src/db/repos/platformSmtp.js before doing it.)',
    };
  }

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
  const state = await ready();
  if (!state.ok) throw new Error(state.reason);

  const local = localConfig();
  if (local) {
    return {
      transport: {
        host: local.host,
        port: local.port,
        secure: local.secure,
        // An internal relay that accepts mail from this subnet without a
        // login is a normal arrangement; sending `auth: {user:'',pass:''}`
        // makes nodemailer attempt AUTH and the relay refuse the message.
        ...(local.user ? { auth: { user: local.user, pass: local.pass } } : {}),
      },
      from: `"${local.fromName}" <${local.from}>`,
    };
  }

  const row = await settings();
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

module.exports = {
  settings, ready, transportConfig, invalidate, decryptPassword,
  localConfig, platformAllowed,
};
