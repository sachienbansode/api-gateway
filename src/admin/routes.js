'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');

const adminDb = require('../db/adminPool');
const session = require('./session');
const attempts = require('./loginAttempts');
const loginPage = require('./loginPage');
const { makeAdminAuth } = require('../middleware/adminAuth');

/**
 * The admin surface: a login page, a session, and a landing page behind it.
 *
 * Two identities can sign in, and they are deliberately different doors:
 *
 *   platform account   the real one. The password is checked against the SAME
 *                      users table the rest of the platform uses, so there is
 *                      no second password to rotate or leak. Accounts that are
 *                      inactive, or that sign in with M365 and therefore have
 *                      no password here, are refused rather than waved through.
 *
 *   .env superadmin    break-glass. Works when the platform directory is down,
 *                      which is exactly when you need to get in. Every use is
 *                      logged at warn.
 *
 * Failures are deliberately indistinguishable: wrong password, unknown email,
 * disabled account and "no gateway grant" all produce the same message and
 * cost the same time. Anything else is a way to enumerate who works here.
 */

const GENERIC = 'Invalid email or password.';

function clientIp(req) {
  return String(req.ip || '').replace(/^::ffff:/, '');
}

/**
 * Look up a platform account by email, including its password hash.
 *
 * Wrapped because the column set varies between platform versions: an older
 * schema may have no `use_m365` or no `password_hash` at all. Rather than
 * crashing the login page, we detect that once and report it clearly.
 */
let platformLoginUsable = null; // null = untried, true/false once known

async function findPlatformUser(email, logger) {
  if (platformLoginUsable === false) return null;
  try {
    const row = await adminDb.one(
      `SELECT u.id, u.email, u.password_hash, u.role_id AS "roleId",
              COALESCE(u.is_active, true) AS is_active,
              r.name AS role, r.permissions
         FROM ${adminDb.T('users')} u
         LEFT JOIN ${adminDb.T('roles')} r ON r.id = u.role_id
        WHERE lower(u.email) = lower($1)`,
      [email]
    );
    platformLoginUsable = true;
    return row;
  } catch (err) {
    if (/column .* does not exist/i.test(err.message)) {
      platformLoginUsable = false;
      logger?.error(
        { err: err.message },
        'platform password login is unavailable: the users table lacks a column this ' +
          'query needs. Sign-in falls back to the .env superadmin. Platform-issued ' +
          'bearer tokens are unaffected.'
      );
      return null;
    }
    throw err;
  }
}

function superadminConfigured() {
  return (
    String(process.env.SUPERADMIN_ENABLED || 'false').toLowerCase() === 'true' &&
    !!process.env.SUPERADMIN_EMAIL &&
    !!process.env.SUPERADMIN_PASSWORD_HASH
  );
}

function buildAdminRouter(logger) {
  const router = express.Router();

  router.use(session.cookieParser);
  router.use(express.urlencoded({ extended: false, limit: '8kb' }));

  // A login page must never be cached — a shared machine would otherwise serve
  // the previous person's filled-in form from the back button.
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    next();
  });

  const title = process.env.ADMIN_TITLE || process.env.API_TITLE || 'API Gateway';

  // -------------------------------------------------------------------------
  // GET /admin/login
  // -------------------------------------------------------------------------
  router.get('/login', (req, res) => {
    res.type('html').send(loginPage.render({ title }));
  });

  // -------------------------------------------------------------------------
  // POST /admin/login
  // -------------------------------------------------------------------------
  router.post('/login', async (req, res) => {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const ip = clientIp(req);
    const keys = [`ip:${ip}`, `em:${email.toLowerCase()}`];

    const fail = (reason, status = 401, message = GENERIC) => {
      attempts.recordFailure(keys);
      logger?.warn({ ip, email, reason, requestId: req.id }, 'admin sign-in failed');
      res.status(status).type('html').send(loginPage.render({ title, error: message, email }));
    };

    if (!email || !password) {
      return fail('missing fields', 400, 'Enter both your email and your password.');
    }

    const limit = attempts.check(keys);
    if (limit.blocked) {
      logger?.warn({ ip, email, retryAfter: limit.retryAfter }, 'admin sign-in rate limited');
      res.set('Retry-After', String(limit.retryAfter));
      return res
        .status(429)
        .type('html')
        .send(
          loginPage.render({
            title,
            email,
            error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfter / 60)} minute(s).`,
          })
        );
    }

    try {
      // --- Door 1: break-glass superadmin -----------------------------------
      if (superadminConfigured() && email.toLowerCase() === String(process.env.SUPERADMIN_EMAIL).toLowerCase()) {
        const ok = await bcrypt.compare(password, process.env.SUPERADMIN_PASSWORD_HASH).catch(() => false);
        if (!ok) return fail('superadmin bad password');

        logger?.warn(
          { ip, email, requestId: req.id },
          'BREAK-GLASS: superadmin signed in. Set SUPERADMIN_ENABLED=false once ' +
            'platform accounts carry the gateway page grant.'
        );
        attempts.recordSuccess(keys);
        session.setCookie(res, req, session.mint({ id: 'superadmin', email, superadmin: true }));
        return res.redirect(303, '/admin');
      }

      // --- Door 2: platform account -----------------------------------------
      if (!adminDb.isEnabled()) return fail('platform directory not configured');

      const user = await findPlatformUser(email, logger);

      // Hash a dummy even when the user does not exist, so an unknown email and
      // a wrong password take the same time. Otherwise response timing tells an
      // attacker which emails are real.
      const hash =
        (user && user.password_hash) ||
        '$2a$12$0000000000000000000000000000000000000000000000000000';
      const passwordOk = await bcrypt.compare(password, hash).catch(() => false);

      if (!user) return fail('unknown email');
      if (user.is_active === false) return fail('inactive account');
      if (!user.password_hash) return fail('account has no local password (SSO only)');
      if (!passwordOk) return fail('bad password');

      attempts.recordSuccess(keys);
      logger?.info({ ip, email, role: user.role, requestId: req.id }, 'admin signed in');
      session.setCookie(res, req, session.mint({ id: user.id, email: user.email }));
      return res.redirect(303, '/admin');
    } catch (err) {
      logger?.error({ err: err.message, ip, email }, 'admin sign-in error');
      return res
        .status(503)
        .type('html')
        .send(
          loginPage.render({
            title,
            email,
            error: 'Sign-in is temporarily unavailable. Try again shortly.',
          })
        );
    }
  });

  // -------------------------------------------------------------------------
  // POST /admin/logout
  // -------------------------------------------------------------------------
  router.post('/logout', (req, res) => {
    session.clearCookie(res, req);
    res.redirect(303, '/admin/login');
  });

  // -------------------------------------------------------------------------
  // Everything below requires a session.
  //
  // A browser that is not signed in gets the login page, not a JSON 401 — an
  // API client still gets JSON, because it did not ask for HTML.
  // -------------------------------------------------------------------------
  const auth = makeAdminAuth(logger);

  router.use((req, res, next) => {
    auth(req, res, (err) => {
      if (!err) return next();
      const wantsHtml = String(req.headers.accept || '').includes('text/html');
      if (wantsHtml && (err.status === 401 || err.status === 403)) {
        return res.redirect(303, '/admin/login');
      }
      return next(err);
    });
  });

  router.get('/', (req, res) => {
    res.type('html').send(dashboard(req.admin, title));
  });

  router.get('/me', (req, res) => {
    res.json({
      email: req.admin.email,
      role: req.admin.role,
      canEdit: req.admin.canEdit,
      source: req.admin.source,
    });
  });

  return router;
}

/** Minimal landing page. The management screens come next. */
function dashboard(admin, title) {
  const e = loginPage.esc;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${e(title)}</title>
<style>
  :root { --bg:#f4f5f7; --card:#fff; --fg:#1a1d23; --muted:#6b7280; --line:#d9dce1; --accent:#1f3864; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg:#15171c; --card:#1d2026; --fg:#e8eaed; --muted:#9aa0a6; --line:#343842; --accent:#5b8def; } }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
  header{display:flex;align-items:center;justify-content:space-between;gap:16px;
    padding:14px 20px;background:var(--card);border-bottom:1px solid var(--line);flex-wrap:wrap}
  h1{margin:0;font-size:16px}
  .who{color:var(--muted);font-size:13px}
  button{font:inherit;font-size:13px;padding:7px 12px;border:1px solid var(--line);
    border-radius:6px;background:transparent;color:var(--fg);cursor:pointer}
  main{max-width:720px;margin:0 auto;padding:24px 16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:16px}
  h2{margin:0 0 8px;font-size:15px}
  p{margin:0 0 10px;color:var(--muted);font-size:14px}
  code{background:var(--bg);padding:1px 5px;border-radius:4px;font-size:13px}
  .ro{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;
    background:var(--bg);border:1px solid var(--line);font-size:11px;color:var(--muted)}
</style></head>
<body>
<header>
  <h1>${e(title)}</h1>
  <div>
    <span class="who">${e(admin.email)} · ${e(admin.role || 'unknown role')}${
      admin.canEdit ? '' : '<span class="ro">read only</span>'
    }</span>
    <form method="post" action="/admin/logout" style="display:inline;margin-left:10px">
      <button type="submit">Sign out</button>
    </form>
  </div>
</header>
<main>
  <div class="card">
    <h2>Signed in</h2>
    <p>Identity: <strong>${e(admin.source === 'env' ? 'break-glass superadmin' : 'platform account')}</strong>.
       Role and permissions are read live from the platform on every request, so a change there
       takes effect within seconds.</p>
    ${
      admin.source === 'env'
        ? '<p>⚠ This is the break-glass credential. Set <code>SUPERADMIN_ENABLED=false</code> once platform accounts carry the gateway page grant.</p>'
        : ''
    }
  </div>
  <div class="card">
    <h2>Next</h2>
    <p>Upstream and endpoint management screens are not built yet. Until they are,
       configuration lives in <code>config/</code> and is applied with <code>deploy.sh</code>.</p>
  </div>
</main>
</body></html>`;
}

module.exports = { buildAdminRouter };
