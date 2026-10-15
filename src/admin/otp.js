'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const smtp = require('../db/repos/platformSmtp');

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
  let info;
  try {
    info = await nodemailer.createTransport(transport).sendMail({
      from,
      to: user.email,
      subject,
      text:
        `Your sign-in code for the Ashika - Pravah console is ${code}.\n\n` +
        `It expires in ${minutes} minutes and can be used once.\n\n` +
        `If you did not try to sign in, tell your administrator — somebody has your password.`,
      html: `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:480px;color:#1a1816">
  <p style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9e9b94;margin:0">Ashika &middot; Pravah</p>
  <h2 style="margin:6px 0 14px;font-size:19px;font-weight:600">Your sign-in code</h2>
  <p style="margin:0 0 6px">Hello ${name},</p>
  <div style="font-size:30px;font-weight:700;letter-spacing:9px;padding:18px 0;margin:16px 0;
              background:#f9f8f6;border:1px solid #e4e2dc;border-radius:8px;text-align:center;
              font-family:ui-monospace,'JetBrains Mono',monospace">${code}</div>
  <p style="margin:0;color:#58554e;font-size:13px">It expires in ${minutes} minutes and can be used once.</p>
  <p style="margin:14px 0 0;color:#c0392b;font-size:12px">If you did not try to sign in, tell your
    administrator — it means somebody else has your password.</p>
</div>`,
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
