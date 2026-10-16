'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/**
 * Admin browser sessions.
 *
 * The token is the same shape the platform issues, signed with the same
 * JWT_SECRET, so a session minted here and a token minted by the platform are
 * both accepted by src/middleware/adminAuth.js. One verification path, not two.
 *
 * The cookie is httpOnly (JavaScript on the page cannot read it, so an XSS bug
 * cannot exfiltrate it), SameSite=Strict (a form on another site cannot make an
 * authenticated request as you), Secure whenever the request arrived over TLS,
 * and scoped to /admin so it is never attached to a vendor API call.
 */

const COOKIE = process.env.ADMIN_SESSION_COOKIE || 'gw_admin';

/**
 * TWO clocks, because "session timeout" means two different things and a
 * console that implements only one of them is annoying or insecure.
 *
 *   IDLE (30 minutes).  Time since the last request. Resets every time you do
 *                       anything, so it only fires on a console left open and
 *                       forgotten — the laptop on a desk, the tab behind forty
 *                       others. This is the one people mean.
 *
 *   ABSOLUTE (8 hours). Wall-clock time since sign-in, which nothing resets.
 *                       Without it a session kept warm by a background tab, a
 *                       polling dashboard or an open browser lives forever, and
 *                       "30 minute timeout" protects nobody.
 *
 * The JWT's own `exp` carries the idle window, so a token that leaks is only
 * worth 30 minutes even to someone replaying it outside this process. The
 * absolute deadline rides along as `gw_abs` and is carried forward unchanged
 * through every renewal — a sliding window that also slid the ceiling would be
 * no ceiling at all.
 */
function idleMinutes() {
  const n = Number(process.env.ADMIN_IDLE_MINUTES || 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function hours() {
  const n = Number(process.env.ADMIN_SESSION_HOURS || 8);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

/** Seconds of the idle window — the token's own lifetime. */
function idleSeconds() {
  return Math.round(idleMinutes() * 60);
}

/**
 * Renew when more than a quarter of the window has passed.
 *
 * Re-signing on every request would mint a token per image and per poll, and
 * set a cookie on responses that have no business carrying one. Renewing only
 * in the last three quarters keeps a working session alive indefinitely while
 * doing the work a handful of times an hour.
 */
function renewAfterMs() {
  return idleSeconds() * 1000 * 0.25;
}

/**
 * How long the COOKIE outlives the token inside it.
 *
 * Only so the server can explain the sign-out. See setCookie.
 */
const EXPLAIN_GRACE_SECONDS = 300;

/** Parse the Cookie header. No dependency, and it never throws on junk. */
function parse(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** Express middleware: populate req.cookies. */
function cookieParser(req, _res, next) {
  req.cookies = parse(req.headers.cookie);
  next();
}

/**
 * @param {{id:*, email:string, superadmin?:boolean}} user
 *        `superadmin: true` stamps a `gw_sa` claim so the verifier knows not to
 *        look this identity up in the platform directory — the break-glass
 *        account does not exist there, and must keep working when that
 *        directory is down.
 *
 *        The claim is only trusted together with SUPERADMIN_ENABLED and a
 *        matching SUPERADMIN_EMAIL. It is not a privilege by itself: anyone who
 *        can sign a token with JWT_SECRET can already impersonate any user, so
 *        this adds no new trust.
 * @returns {string} a signed JWT
 */
function mint(user, { absoluteDeadline = null } = {}) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');

  // Set once at sign-in and carried forward by every renewal, never recomputed.
  const abs = absoluteDeadline || Math.floor(Date.now() / 1000) + hours() * 3600;

  return jwt.sign(
    {
      id: user.id,
      sub: String(user.id),
      email: user.email,
      ...(user.superadmin ? { gw_sa: true } : {}),
      gw_abs: abs,
      jti: crypto.randomUUID(),
    },
    process.env.JWT_SECRET,
    {
      // The IDLE window, not the session's full life. A renewal extends this;
      // nothing extends gw_abs.
      expiresIn: idleSeconds(),
      ...(process.env.JWT_ISSUER ? { issuer: process.env.JWT_ISSUER } : {}),
    }
  );
}

/**
 * Should this request's token be re-issued, and may it be?
 *
 * Returns the new token, or null to leave the session alone. Null covers three
 * cases that must not be confused: nothing to do yet, a token minted by the
 * platform rather than by us, and a session that has hit its absolute ceiling.
 * The last is what stops a renewal loop from outliving the 8-hour cap.
 */
function renew(claims) {
  if (!claims || typeof claims !== 'object') return null;
  // A pending MFA ticket is not a session and must never be extended into one.
  if (claims.gw_otp === true) return null;

  const now = Math.floor(Date.now() / 1000);

  // Past the absolute ceiling: let it expire. A token minted elsewhere carries
  // no gw_abs — treat a missing ceiling as "not ours to slide", so a platform
  // token keeps exactly the lifetime the platform gave it.
  if (!claims.gw_abs) return null;
  if (now >= Number(claims.gw_abs)) return null;

  const issuedMsAgo = (now - Number(claims.iat || now)) * 1000;
  if (issuedMsAgo < renewAfterMs()) return null;

  // Don't mint a token that outlives the ceiling it is supposed to respect.
  if (now + idleSeconds() > Number(claims.gw_abs) + 5) {
    // Inside the final idle window: keep serving, stop renewing. The session
    // ends when this token expires, which is at or before the ceiling.
    return null;
  }

  return mint(
    {
      id: claims.id != null ? claims.id : claims.sub,
      email: claims.email,
      superadmin: claims.gw_sa === true,
    },
    { absoluteDeadline: Number(claims.gw_abs) }
  );
}

function isSecure(req) {
  // `trust proxy` is set in app.js, so req.secure reflects X-Forwarded-Proto
  // when nginx terminates TLS.
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setCookie(res, req, token) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/admin',
    // Outlives the TOKEN by a short grace, on purpose.
    //
    // The first version matched the idle window exactly, on the reasoning
    // that a cookie should not outlive its credential. Driving it in a browser
    // showed the cost: the browser dropped the cookie at the same instant the
    // token expired, so the server never saw an expired token and could not
    // tell "signed out after 30 minutes" from "never signed in". Everyone who
    // timed out got a bare sign-in page with no explanation — the one message
    // this whole change exists to deliver.
    //
    // The grace gives up nothing. The cookie carries a token the server
    // rejects either way; all it buys is the chance to say why before clearing
    // it. Past the grace the browser drops it and the plain sign-in page is
    // the right answer anyway.
    `Max-Age=${idleSeconds() + EXPLAIN_GRACE_SECONDS}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, req) {
  const parts = [`${COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/admin', 'Max-Age=0'];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

module.exports = {
  COOKIE, hours, idleMinutes, idleSeconds, parse, cookieParser,
  mint, renew, setCookie, clearCookie, isSecure,
};
