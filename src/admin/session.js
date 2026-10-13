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

function hours() {
  const n = Number(process.env.ADMIN_SESSION_HOURS || 8);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

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
function mint(user) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');
  return jwt.sign(
    {
      id: user.id,
      sub: String(user.id),
      email: user.email,
      ...(user.superadmin ? { gw_sa: true } : {}),
      jti: crypto.randomUUID(),
    },
    process.env.JWT_SECRET,
    {
      expiresIn: `${hours()}h`,
      ...(process.env.JWT_ISSUER ? { issuer: process.env.JWT_ISSUER } : {}),
    }
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
    `Max-Age=${hours() * 3600}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, req) {
  const parts = [`${COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/admin', 'Max-Age=0'];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

module.exports = { COOKIE, hours, parse, cookieParser, mint, setCookie, clearCookie, isSecure };
