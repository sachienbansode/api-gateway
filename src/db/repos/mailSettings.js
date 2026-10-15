'use strict';

const db = require('../pool');
const secretbox = require('../../core/secretbox');

/**
 * Mail settings an administrator owns, in this gateway's own database.
 *
 * The password is sealed with AES-256-GCM under GW_SECRET_KEY — the same
 * mechanism and the same key as the supplier credentials, so there is one
 * thing to protect and one thing to rotate. `open()` is called at the moment a
 * message is about to be sent and nowhere else; everything that renders goes
 * through `status()`, which cannot return a password because it does not read
 * the ciphertext columns at all.
 */

const AAD = 'mail:smtp:password';

/** Status only. This is what the console and the health screen read. */
async function status() {
  try {
    const r = await db.query(`SELECT * FROM gateway.mail_config WHERE id = 1`);
    return r?.rows?.[0] || null;
  } catch {
    // Before 012 is applied. Not an error: the env and platform sources still
    // work, and the caller falls through to them.
    return null;
  }
}

/**
 * Everything needed to build a transport, password included.
 *
 * Returns null when no host is configured here, which is the signal to the
 * caller to try the next source rather than to fail.
 */
async function resolve() {
  const row = await status();
  if (!row || !row.host) return null;

  let pass = '';
  if (row.password_stored) {
    const r = await db.query(
      `SELECT pass_ciphertext, pass_iv, pass_tag, pass_key_id
         FROM gateway.mail_settings WHERE id = 1`
    );
    const s = r?.rows?.[0];
    if (s && s.pass_ciphertext) {
      pass = secretbox.open(
        { ciphertext: s.pass_ciphertext, iv: s.pass_iv, tag: s.pass_tag, keyId: s.pass_key_id },
        AAD
      );
    }
  }

  return {
    host: row.host,
    port: row.port || 587,
    secure: row.secure === true,
    rejectUnauthorized: row.reject_unauthorized !== false,
    user: row.username || '',
    pass,
    from: row.from_email || row.username || '',
    fromName: row.from_name || 'Ashika - Pravah',
  };
}

/**
 * Save what an administrator typed.
 *
 * `password` is only written when something was typed. An empty box means
 * "keep what is stored" — which is what the placeholder on the form says, and
 * is the behaviour that lets someone change the from-address without having
 * to go and find the mailbox password again.
 */
async function save(input, actor) {
  const host = String(input.host || '').trim();
  const port = Number(input.port) || 587;
  const fromEmail = String(input.fromEmail || '').trim();

  if (host && !fromEmail) {
    throw new Error('A from-address is required: a mail server will refuse a message with no sender.');
  }
  if (port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');

  // NULL rather than false, so the column keeps meaning "derive from the port"
  // until someone makes an explicit choice on the form.
  const secure = input.secure === undefined ? null : input.secure === true;

  const sets = [
    'host = $1', 'port = $2', 'secure = $3', 'reject_unauthorized = $4',
    'username = $5', 'from_email = $6', 'from_name = $7',
    'updated_at = now()', 'updated_by = $8',
  ];
  const vals = [
    host || null, port, secure, input.rejectUnauthorized !== false,
    String(input.username || '').trim() || null,
    fromEmail || null,
    String(input.fromName || '').trim() || 'Ashika - Pravah',
    actor,
  ];

  if (typeof input.password === 'string' && input.password.length) {
    if (!secretbox.enabled()) {
      throw new Error(
        'GW_SECRET_KEY is not set on this server, so the mail password cannot be ' +
          'encrypted. Set it in /etc/api-gateway/env and restart.'
      );
    }
    const sealed = secretbox.seal(input.password, AAD);
    sets.push(
      `pass_ciphertext = $${vals.length + 1}`, `pass_iv = $${vals.length + 2}`,
      `pass_tag = $${vals.length + 3}`, `pass_key_id = $${vals.length + 4}`,
      `pass_hint = $${vals.length + 5}`
    );
    vals.push(sealed.ciphertext, sealed.iv, sealed.tag, sealed.keyId, sealed.hint || null);
  } else if (input.clearPassword === true) {
    sets.push('pass_ciphertext = NULL', 'pass_iv = NULL', 'pass_tag = NULL',
              'pass_key_id = NULL', 'pass_hint = NULL');
  }

  // A settings change invalidates the last test result: it was a statement
  // about a configuration that no longer exists, and leaving a green tick on
  // untested settings is worse than showing nothing.
  sets.push('test_status = NULL', 'test_error = NULL', 'last_tested_at = NULL');

  await db.query(
    `INSERT INTO gateway.mail_settings (id) VALUES (1) ON CONFLICT DO NOTHING`
  );
  await db.query(`UPDATE gateway.mail_settings SET ${sets.join(', ')} WHERE id = 1`, vals);
  return status();
}

/** Record what a Test Connection did, so the screen can show a state. */
async function recordTest({ ok, error = null }) {
  await db.query(
    `UPDATE gateway.mail_settings
        SET test_status = $1, test_error = $2, last_tested_at = now()
      WHERE id = 1`,
    [ok ? 'ok' : 'failed', ok ? null : String(error || '').slice(0, 500)]
  );
  return status();
}

module.exports = { status, resolve, save, recordTest, AAD };
