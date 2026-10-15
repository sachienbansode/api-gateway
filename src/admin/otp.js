'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const smtp = require('../db/repos/platformSmtp');
const settings = require('../db/repos/settings');
const assets = require('./assets');

/**
 * The second factor for console sign-in.
 *
 * A platform role may be marked requires_mfa, and a user may have mfa_enabled.
 * Either one means a password is not enough here, exactly as it is not enough
 * in the platform itself. The alternative — honouring the flag in one
 * application and ignoring it in another — is worse than not having the flag.
 *
 * Shape of the flow:
 *
 *   1. password and page grant check out, but MFA is required
 *   2. a six-digit code is generated, HMAC'd, and stored in gateway.admin_otp
 *   3. the code is emailed through the PLATFORM's SMTP settings
 *   4. the browser is given a short-lived PENDING cookie — not a session —
 *      naming who is half-way through
 *   5. the code is verified, the row burnt, and only then is a session minted
 *
 * The pending cookie is the part worth being careful about. It is signed with
 * the same secret as a real session, so it carries a `gw_otp` claim and
 * src/middleware/adminAuth.js refuses any token that has it. Without that
 * refusal the cookie issued at step 4 would itself be a working session and
 * the second factor would be decorative.
 */

const PENDING_COOKIE = process.env.ADMIN_OTP_COOKIE || 'gw_otp';
const CODE_TTL_MS = Number(process.env.ADMIN_OTP_TTL_MS || 10 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.ADMIN_OTP_MAX_ATTEMPTS || 5);

/** Does this account need a second factor to sign in here? */
function required(user) {
  return user?.requires_mfa === true || user?.mfa_enabled === true;
}

/**
 * HMAC, not a digest.
 *
 * Six digits is a million possibilities. A SHA-256 of one is recovered from a
 * stolen table in about a second; an HMAC under a key that is not in the table
 * is not recoverable from the table at all.
 */
function hashCode(code, userId) {
  const key = process.env.JWT_SECRET;
  if (!key) throw new Error('JWT_SECRET is not set');
  return crypto.createHmac('sha256', key).update(`${userId}:${code}`).digest('hex');
}

/** Uniform over 000000–999999. Math.random would not be. */
function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// The pending ticket
// ---------------------------------------------------------------------------

function mintPending(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      id: user.id,
      email: user.email,
      gw_otp: true, // refused as a session by adminAuth. Load-bearing.
      jti: crypto.randomUUID(),
    },
    process.env.JWT_SECRET,
    { expiresIn: Math.ceil(CODE_TTL_MS / 1000) }
  );
}

function readPending(req) {
  const token = req.cookies && req.cookies[PENDING_COOKIE];
  if (!token) return null;
  try {
    const claims = jwt.verify(token, process.env.JWT_SECRET, { clockTolerance: 5 });
    if (claims.gw_otp !== true) return null;
    return { id: claims.id, email: claims.email };
  } catch {
    return null;
  }
}

function setPendingCookie(res, req, token, isSecure) {
  const parts = [
    `${PENDING_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/admin',
    `Max-Age=${Math.ceil(CODE_TTL_MS / 1000)}`,
  ];
  if (isSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearPendingCookie(res, isSecure) {
  const parts = [`${PENDING_COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/admin', 'Max-Age=0'];
  if (isSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

/**
 * Create a challenge and email it.
 *
 * Any previous unused challenge for this user is burnt first: two live codes
 * means the older one is still usable after the person asked for a new one,
 * which is the opposite of what asking for a new one means.
 *
 * Throws if the mail cannot be sent. The caller must NOT mint a pending cookie
 * in that case — a screen asking for a code that was never sent is worse than
 * an error that says the mail server is down.
 */
async function issue({ user, ip, logger }) {
  const code = generateCode();
  const expires = new Date(Date.now() + CODE_TTL_MS);

  await db.query(`UPDATE gateway.admin_otp SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
    [String(user.id)]);

  await db.query(
    `INSERT INTO gateway.admin_otp (user_id, email, code_hash, expires_at, ip)
     VALUES ($1,$2,$3,$4,$5)`,
    [String(user.id), user.email, hashCode(code, user.id), expires, ip || null]
  );

  // Send AFTER the row exists, so a code that reaches someone is always one we
  // can verify. The reverse order loses the race in the way that matters.
  await send(user, code, logger, ip);

  // Opportunistic tidy-up, and never a reason to fail a sign-in.
  db.query(`SELECT gateway.purge_admin_otp()`).catch(() => {});

  return { expiresAt: expires };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function send(user, code, logger, ip) {
  const nodemailer = require('nodemailer');
  const emailLog = require('../db/repos/emailLog');
  const minutes = Math.round(CODE_TTL_MS / 60000);
  // Two subjects on purpose. The one that goes OUT carries the code, because
  // it shows in a phone's notification preview and saves opening the mail. The
  // one that gets LOGGED does not: email_logs is a shared table that any
  // platform admin can read in Admin → Email & OTP Logs, and a six-digit code
  // sitting there in plain text for anyone to read is the second factor
  // handed to whoever has that screen.
  const subject = `${code} is your sign-in code — Ashika - Pravah`;
  const loggedSubject = 'Your sign-in code — Ashika - Pravah';

  // Logged into the PLATFORM's email_logs, so this appears in
  // Admin → Email & OTP Logs beside every other platform email rather than in
  // a private log nobody thinks to check. REUSE.md §3 makes that the rule;
  // OFS follows it and so does this.
  const base = {
    purpose: 'pravah_login_otp',
    to_email: user.email,
    user_id: Number.isFinite(Number(user.id)) ? Number(user.id) : null,
    subject: loggedSubject,
    triggered_by: user.email,
    ip_address: ip || null,
  };

  let transport;
  let from;
  try {
    ({ transport, from } = await smtp.transportConfig());
  } catch (err) {
    await emailLog.log({ ...base, status: 'failed', error_text: err.message });
    throw err;
  }

  const name = esc(user.first_name || user.email || '');

  // The console's own address, from Admin config. A code with no indication of
  // what it is FOR is the shape of a phishing mail; the link is what lets
  // somebody check they are signing in to the thing that sent this.
  let appUrl = '';
  try {
    appUrl = await settings.baseUrl();
  } catch { /* a missing base URL must not stop a sign-in */ }
  const safeUrl = /^https?:\/\//i.test(appUrl) ? appUrl : '';
  const consoleUrl = safeUrl ? `${safeUrl}/admin` : '';

  // The mark travels WITH the message as an inline attachment rather than as a
  // link. Mail clients block remote images by default, so a linked logo is a
  // broken box on first open — which is exactly the impression a sign-in mail
  // should not give.
  const logo = assets.bytes('logo.png');
  const attachments = logo
    ? [{ filename: 'ashika.png', content: logo, cid: 'ashikamark', contentDisposition: 'inline' }]
    : [];

  // Tables, inline styles, and no flexbox. Outlook renders with Word's engine:
  // a div with max-width is ignored there, which is why the first version of
  // this mail ran edge to edge with no margin.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your sign-in code</title></head>
<body style="margin:0;padding:0;background:#f4f3f0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#f4f3f0;padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="max-width:480px;width:100%;background:#ffffff;border:1px solid #e4e2dc;border-radius:10px;">

      <tr><td style="padding:26px 28px 0 28px;">
        ${logo ? `<img src="cid:ashikamark" width="44" height="44" alt="Ashika"
             style="display:block;border:0;outline:none;margin:0 0 14px 0;">` : ''}
        <div style="font:600 19px/1.3 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1816;
                    letter-spacing:-.2px;">Ashika - Pravah</div>
        <div style="font:600 9.5px/1.4 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#9e9b94;
                    text-transform:uppercase;letter-spacing:1px;margin-top:3px;">API Gateway</div>
        <div style="height:2px;width:34px;background:#b8860b;border-radius:2px;margin:15px 0 0 0;
                    font-size:0;line-height:0;">&nbsp;</div>
      </td></tr>

      <tr><td style="padding:19px 28px 0 28px;
                     font:400 13.5px/1.55 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1816;">
        <p style="margin:0 0 4px 0;font-size:16px;font-weight:600;">Your sign-in code</p>
        <p style="margin:0;color:#58554e;">Hello ${name}, use this code to finish signing in.</p>
      </td></tr>

      <tr><td style="padding:18px 28px 0 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="background:#f9f8f6;border:1px solid #e4e2dc;border-radius:8px;">
          <tr><td align="center" style="padding:18px 10px;
                 font:700 31px/1 'Courier New',Courier,monospace;letter-spacing:9px;color:#1a1816;">
            ${code}
          </td></tr>
        </table>
        <p style="margin:9px 0 0 0;font:400 12.5px/1.5 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                  color:#58554e;">Expires in ${minutes} minutes. It can be used once.</p>
      </td></tr>

      ${consoleUrl ? `<tr><td style="padding:18px 28px 0 28px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="background:#1a1816;border-radius:6px;">
            <a href="${esc(consoleUrl)}"
               style="display:inline-block;padding:10px 20px;color:#ffffff;text-decoration:none;
                      font:500 13px/1 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Open the console</a>
          </td></tr>
        </table>
        <p style="margin:9px 0 0 0;font:400 11.5px/1.5 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                  color:#9e9b94;">Or go to
          <a href="${esc(consoleUrl)}" style="color:#1a4fa0;">${esc(consoleUrl)}</a>
        </p>
      </td></tr>` : ''}

      <tr><td style="padding:18px 28px 24px 28px;">
        <div style="border-top:1px solid #e4e2dc;padding-top:14px;
                    font:400 11.5px/1.55 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#9e9b94;">
          <span style="color:#c0392b;">Did not try to sign in?</span> Tell your administrator —
          it means somebody else has your password. Nobody at Ashika will ever ask you for this code.
        </div>
      </td></tr>
    </table>

    <div style="max-width:480px;margin:13px auto 0;
                font:400 11px/1.5 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#9e9b94;
                text-align:center;">
      Ashika Group &middot; sent automatically, please do not reply
    </div>
  </td></tr>
</table>
</body></html>`;

  let info;
  try {
    info = await nodemailer.createTransport(transport).sendMail({
      from,
      to: user.email,
      subject,
      attachments,
      text:
        `Your sign-in code for the Ashika - Pravah console is ${code}.\n\n` +
        `It expires in ${minutes} minutes and can be used once.\n\n` +
        (consoleUrl ? `Sign in at ${consoleUrl}\n\n` : '') +
        `If you did not try to sign in, tell your administrator — somebody has your password. ` +
        `Nobody at Ashika will ever ask you for this code.`,
      html,
    });
  } catch (err) {
    await emailLog.log({ ...base, status: 'failed', error_text: err.message });
    throw err;
  }

  await emailLog.fromInfo(base, info);

  // The code is never logged. Not at debug, not in development, and not in
  // the shared email log — see loggedSubject above.
  logger?.info({ email: user.email }, 'admin sign-in: second-factor code sent');
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ok:true}|{ok:false, reason:string, message:string}>}
 *
 * Every failure consumes an attempt, including an expired code. Five wrong
 * guesses burn the challenge: the person starts again with a new code, which
 * costs them ten seconds and costs an attacker the whole key space.
 */
async function verify({ userId, code, logger }) {
  const clean = String(code || '').replace(/\D/g, '');
  const row = (
    await db.query(
      `SELECT id, code_hash, expires_at, attempts FROM gateway.admin_otp
        WHERE user_id = $1 AND used_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [String(userId)]
    )
  )?.rows?.[0];

  if (!row) return { ok: false, reason: 'no challenge', message: 'That code has expired. Sign in again to get a new one.' };

  if (row.attempts >= MAX_ATTEMPTS) {
    await db.query(`UPDATE gateway.admin_otp SET used_at = now() WHERE id = $1`, [row.id]);
    logger?.warn({ userId }, 'admin sign-in: second factor burnt after too many wrong codes');
    return { ok: false, reason: 'too many attempts', message: 'Too many wrong codes. Sign in again to get a new one.' };
  }

  await db.query(`UPDATE gateway.admin_otp SET attempts = attempts + 1 WHERE id = $1`, [row.id]);

  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired', message: 'That code has expired. Sign in again to get a new one.' };
  }

  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(hashCode(clean, userId), 'hex');
  const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!match) {
    return {
      ok: false,
      reason: 'wrong code',
      message: `That code is not right. ${MAX_ATTEMPTS - row.attempts - 1} attempt(s) left.`,
    };
  }

  await db.query(`UPDATE gateway.admin_otp SET used_at = now() WHERE id = $1`, [row.id]);
  return { ok: true };
}

module.exports = {
  required, issue, verify,
  mintPending, readPending, setPendingCookie, clearPendingCookie,
  PENDING_COOKIE, CODE_TTL_MS, MAX_ATTEMPTS,
  // exported for tests
  hashCode, generateCode,
};
