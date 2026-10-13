'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const adminDb = require('../db/adminPool');
const errors = require('../core/adminErrors');

/**
 * Admin authentication for the gateway's own management surface.
 *
 * This is NOT the vendor path. A vendor presents `X-API-Key` and reaches the
 * wrapped endpoints (src/middleware/auth.js). An administrator presents a
 * platform JWT and reaches /admin/*. The two never overlap: an API key cannot
 * administer the gateway, and an admin token cannot call a vendor endpoint.
 *
 * Identity model, mirroring the platform (OFS REUSE.md §2):
 *
 *   The JWT proves IDENTITY ONLY. Role and page grants are loaded live from
 *   the platform's users/roles tables on every request, behind a 15-second
 *   cache. This is what makes a withdrawn grant or a disabled account take
 *   effect within seconds rather than at the next token expiry — someone
 *   removed from the platform at 14:00 cannot still be administering the
 *   vendor gateway at 18:00 on a token minted that morning.
 *
 *   Authorization is the page grant. '*' means full access (SuperAdmin).
 *   Otherwise an entry for GATEWAY_PAGE_KEY grants access, with or without a
 *   ':view' / ':edit' suffix. ':edit' (or '*') is required for anything that
 *   changes state.
 *
 * Two doors, deliberately different:
 *
 *   platform JWT   the real one. Accounts, passwords, MFA and revocation all
 *                  stay with the platform. The gateway keeps no password.
 *
 *   .env superadmin  a break-glass account for bootstrapping, so you can
 *                  configure wrappers before the platform integration is
 *                  finished. HTTP Basic against a bcrypt hash. Off unless
 *                  SUPERADMIN_ENABLED=true, and every use is logged at warn.
 *                  It is not meant to stay on.
 */

const PAGE_KEY = process.env.GATEWAY_PAGE_KEY || 'api-gateway';
const CACHE_TTL_MS = Number(process.env.ADMIN_PERM_CACHE_MS || 15000);

/** id -> { at, user } */
const permCache = new Map();

function invalidate(userId) {
  if (userId == null) permCache.clear();
  else permCache.delete(String(userId));
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/** permissions.pages arrives as JSONB or as text depending on the driver. */
function pagesOf(permissions) {
  let p = permissions;
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p);
    } catch {
      p = null;
    }
  }
  const pages = p && p.pages;
  return Array.isArray(pages) ? pages.map(String) : [];
}

/** Does this role reach the gateway's admin surface at all? */
function hasGatewayGrant(pages) {
  return pages.some((e) => e === '*' || e.split(':')[0] === PAGE_KEY);
}

/**
 * May this role CHANGE things, as opposed to look at them?
 *
 * Read is the default and write must be granted explicitly. A bare
 * 'api-gateway' entry is view-only: the surface that decides which fields a
 * vendor sees is not something to hand out by accident.
 */
function canEdit(pages) {
  return pages.some((e) => {
    if (e === '*') return true;
    const [key, level] = e.split(':');
    return key === PAGE_KEY && level === 'edit';
  });
}

// ---------------------------------------------------------------------------
// Platform lookup
// ---------------------------------------------------------------------------

async function loadUser(id) {
  const hit = permCache.get(String(id));
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.user;

  const row = await adminDb.one(
    `SELECT u.id, u.email, u.role_id AS "roleId",
            r.name AS role, r.permissions
       FROM ${adminDb.T('users')} u
       JOIN ${adminDb.T('roles')} r ON r.id = u.role_id
      WHERE u.id = $1 AND COALESCE(u.is_active, true) = true`,
    [id]
  );
  if (!row) return null;

  const pages = pagesOf(row.permissions);
  const user = {
    id: row.id,
    email: row.email,
    roleId: row.roleId,
    role: row.role,
    pages,
    canEdit: canEdit(pages),
    source: 'platform',
  };

  permCache.set(String(id), { at: Date.now(), user });
  return user;
}

// ---------------------------------------------------------------------------
// Break-glass superadmin
// ---------------------------------------------------------------------------

function superadminEnabled() {
  return String(process.env.SUPERADMIN_ENABLED || 'false').toLowerCase() === 'true';
}

/**
 * Validate the superadmin configuration at boot rather than on first use.
 * A half-configured break-glass account that fails at 2am is worse than one
 * that refuses to start.
 */
function checkSuperadminConfig() {
  if (!superadminEnabled()) return { enabled: false };

  const email = process.env.SUPERADMIN_EMAIL;
  const hash = process.env.SUPERADMIN_PASSWORD_HASH;

  if (!email) throw new Error('SUPERADMIN_ENABLED=true but SUPERADMIN_EMAIL is not set');
  if (!hash) {
    throw new Error(
      'SUPERADMIN_ENABLED=true but SUPERADMIN_PASSWORD_HASH is not set. ' +
        'Generate one with: node scripts/gw.js admin:hash'
    );
  }
  if (!/^\$2[aby]\$\d{2}\$/.test(hash)) {
    throw new Error(
      'SUPERADMIN_PASSWORD_HASH is not a bcrypt hash. It must start with $2a$, ' +
        '$2b$ or $2y$. Did you paste the plaintext password by mistake?'
    );
  }
  return { enabled: true, email };
}

/** Constant-time string compare that does not leak length through throwing. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Still do the work, so a wrong-length guess costs the same as a
    // right-length one.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function parseBasic(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  let decoded;
  try {
    decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

async function trySuperadmin(req, logger) {
  if (!superadminEnabled()) return null;

  const creds = parseBasic(req);
  if (!creds) return null;

  const email = String(process.env.SUPERADMIN_EMAIL || '').toLowerCase();
  const emailOk = safeEqual(String(creds.user || '').toLowerCase(), email);

  // Always run bcrypt, even when the email is wrong, so a wrong username and a
  // wrong password take the same time. Otherwise the response time tells an
  // attacker which half they got right.
  const passOk = await bcrypt
    .compare(String(creds.pass || ''), process.env.SUPERADMIN_PASSWORD_HASH)
    .catch(() => false);

  if (!emailOk || !passOk) {
    logger?.warn(
      { ip: req.ip, requestId: req.id },
      'superadmin authentication FAILED'
    );
    return false;
  }

  logger?.warn(
    { ip: req.ip, requestId: req.id, method: req.method, path: req.path },
    'BREAK-GLASS: superadmin credential used. Switch SUPERADMIN_ENABLED to false ' +
      'once platform accounts are granted the gateway page.'
  );

  return {
    id: 'superadmin',
    email: process.env.SUPERADMIN_EMAIL,
    role: 'SuperAdmin (.env)',
    pages: ['*'],
    canEdit: true,
    source: 'env',
  };
}

// ---------------------------------------------------------------------------
// Bearer token
// ---------------------------------------------------------------------------

function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  // Same default as src/admin/session.js, which SETS the cookie. These two
  // defaults disagreeing means a successful sign-in followed by an immediate
  // bounce back to the login page, with nothing in the logs to say why.
  const cookieName = process.env.ADMIN_SESSION_COOKIE || 'gw_admin';
  if (req.cookies && req.cookies[cookieName]) return req.cookies[cookieName];
  return null;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

function makeAdminAuth(logger) {
  return async function adminAuth(req, res, next) {
    // 1. Break-glass first — it must work even when the platform is unreachable.
    //    That is the whole point of having it.
    let user;
    try {
      const sa = await trySuperadmin(req, logger);
      if (sa === false) {
        res.set('WWW-Authenticate', 'Basic realm="gateway-admin"');
        return next(errors.unauthorized('Invalid administrator credentials.'));
      }
      if (sa) user = sa;
    } catch (err) {
      return next(err);
    }

    // 2. Otherwise a platform JWT.
    if (!user) {
      const token = bearer(req);
      if (!token) {
        return next(
          errors.unauthorized(
            'Administrator authentication required: send a platform bearer token.'
          )
        );
      }

      if (!process.env.JWT_SECRET) {
        logger?.error('JWT_SECRET is not set — no platform token can be verified');
        return next(errors.serviceUnavailable('Administrator authentication is not configured.'));
      }

      let claims;
      try {
        claims = jwt.verify(token, process.env.JWT_SECRET, {
          issuer: process.env.JWT_ISSUER || undefined,
          clockTolerance: 5,
        });
      } catch {
        return next(errors.unauthorized('Invalid or expired token.'));
      }

      // A break-glass session. Recognised here so it never touches the
      // platform directory — that account does not exist there, and the whole
      // point of break-glass is that it works when the directory is down.
      if (
        claims.gw_sa === true &&
        superadminEnabled() &&
        String(claims.email || '').toLowerCase() ===
          String(process.env.SUPERADMIN_EMAIL || '').toLowerCase()
      ) {
        user = {
          id: 'superadmin',
          email: claims.email,
          role: 'SuperAdmin (.env)',
          pages: ['*'],
          canEdit: true,
          source: 'env',
        };
      }

      if (!user && !adminDb.isEnabled()) {
        return next(
          errors.serviceUnavailable(
            'The platform directory is not configured, so grants cannot be checked.'
          )
        );
      }

      const id = claims.id != null ? claims.id : claims.sub;
      try {
        if (!user) user = await loadUser(id);
      } catch (err) {
        // Fail CLOSED. An unreachable platform must not mean "let them in" —
        // this is the surface that controls what a vendor can see.
        logger?.error({ err: err.message }, 'platform grant lookup failed');
        return next(
          errors.serviceUnavailable('Cannot reach the platform directory to check your access.')
        );
      }

      if (!user) return next(errors.unauthorized('Account not found or inactive.'));

      if (!hasGatewayGrant(user.pages)) {
        logger?.warn(
          { email: user.email, role: user.role, requestId: req.id },
          'authenticated but not granted the gateway page'
        );
        return next(
          errors.forbidden(`Your role does not grant access to "${PAGE_KEY}".`)
        );
      }
    }

    // 3. Write operations need an explicit edit grant.
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating && !user.canEdit) {
      return next(
        errors.forbidden(`Read-only access. Changing the gateway needs "${PAGE_KEY}:edit".`)
      );
    }

    req.admin = user;
    logger?.info(
      {
        requestId: req.id,
        admin: user.email,
        role: user.role,
        source: user.source,
        method: req.method,
        path: req.path,
      },
      'admin request'
    );
    next();
  };
}

module.exports = {
  makeAdminAuth,
  checkSuperadminConfig,
  superadminEnabled,
  invalidate,
  pagesOf,
  hasGatewayGrant,
  canEdit,
  PAGE_KEY,
};
