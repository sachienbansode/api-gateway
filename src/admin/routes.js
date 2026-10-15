'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');

const adminDb = require('../db/adminPool');
const session = require('./session');
const attempts = require('./loginAttempts');
const loginPage = require('./loginPage');
const otpPage = require('./otpPage');
const otp = require('./otp');
const pages = require('./pages');
const {
  makeAdminAuth, pagesOf, hasGatewayGrant, PAGE_KEY,
} = require('../middleware/adminAuth');
const db = require('../db/pool');
const vendorRepo = require('../db/repos/vendors');
const auditRepo = require('../db/repos/audit');
const quotaRepo = require('../db/repos/quota');

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
      `SELECT u.id, u.email, u.first_name, u.password_hash, u.role_id AS "roleId",
              COALESCE(u.is_active, true) AS is_active,
              COALESCE(u.mfa_enabled, false) AS mfa_enabled,
              r.name AS role, r.permissions,
              COALESCE(r.requires_mfa, false) AS requires_mfa
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

function buildAdminRouter(logger, deps = {}) {
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

  // Before the session check on purpose: the login page shows the mark, and a
  // logo behind authentication means a broken image on the one screen every
  // person sees first.
  const assets = require('./assets');
  router.get('/logo.png', assets.serve('logo.png'));
  router.get('/favicon.ico', assets.serve('favicon.ico'));

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

      // The grant is checked HERE as well as on every request.
      //
      // Not for security — adminAuth enforces it on each request and is the
      // real control. For honesty: without this, an Ananta user with a correct
      // password signs in, is bounced by adminAuth, and lands back on the login
      // page with no explanation. They retype the password, it happens again,
      // and they open a ticket saying the portal is broken. The password was
      // never the problem.
      //
      // Saying "your role does not have access" is safe at this point and only
      // at this point: they have already proved the password, so it tells them
      // nothing they could not have learnt by signing in.
      const pages = pagesOf(user.permissions);
      if (!hasGatewayGrant(pages)) {
        attempts.recordSuccess(keys); // the password was right; do not lock them out
        logger?.warn(
          { ip, email, role: user.role, pages, requestId: req.id },
          'admin sign-in refused: correct password, but the role does not grant ' +
            `"${PAGE_KEY}". Grant it on the role in the platform's Roles screen.`
        );
        return res.status(403).type('html').send(
          loginPage.render({
            title,
            email,
            error:
              'Your account is valid, but your role does not have access to this portal. ' +
              'Ask a SuperAdmin to grant your role the API Gateway page.',
          })
        );
      }

      attempts.recordSuccess(keys);

      // --- Second factor, when the platform says so --------------------------
      //
      // requires_mfa on the role, or mfa_enabled on the person. The flag is
      // the platform's; honouring it here is what stops this console from
      // being the weakest way in to the same account.
      if (otp.required(user)) {
        try {
          await otp.issue({ user, ip, logger });
        } catch (err) {
          // No pending cookie on failure: a code screen with no code behind it
          // is a dead end that looks like the person's fault.
          logger?.error(
            { err: err.message, email, requestId: req.id },
            'admin sign-in: could not send the second-factor code'
          );
          return res.status(503).type('html').send(
            loginPage.render({
              title, email,
              error:
                'Your role needs a second factor, but the code could not be emailed. ' +
                'Tell your administrator — the platform mail settings need attention.',
            })
          );
        }
        otp.setPendingCookie(res, req, otp.mintPending(user), session.isSecure(req));
        logger?.info({ ip, email, role: user.role, requestId: req.id },
          'admin sign-in: password accepted, awaiting second factor');
        return res.redirect(303, '/admin/login/otp');
      }

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
  // GET / POST /admin/login/otp — the second factor
  //
  // Both are OUTSIDE the session gate below, because the person holding a
  // pending ticket is by definition not signed in yet. The ticket is the only
  // thing that identifies them here, and adminAuth refuses it as a session.
  // -------------------------------------------------------------------------
  router.get('/login/otp', (req, res) => {
    const pending = otp.readPending(req);
    if (!pending) return res.redirect(303, '/admin/login');
    res.type('html').send(
      otpPage.render({ title, email: pending.email, minutes: Math.round(otp.CODE_TTL_MS / 60000) })
    );
  });

  router.post('/login/otp', async (req, res) => {
    const pending = otp.readPending(req);
    const ip = clientIp(req);
    if (!pending) {
      // Expired, tampered with, or someone came straight here. All three mean
      // the same thing: start again.
      return res.redirect(303, '/admin/login');
    }

    // Rate limited on the same counters as the password step, so a code cannot
    // be ground down from a thousand connections while the password door is
    // the only one being watched.
    const keys = [`ip:${ip}`, `otp:${String(pending.id)}`];
    const limit = attempts.check(keys);
    if (limit.blocked) {
      res.set('Retry-After', String(limit.retryAfter));
      return res.status(429).type('html').send(
        otpPage.render({
          title, email: pending.email, minutes: Math.round(otp.CODE_TTL_MS / 60000),
          error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfter / 60)} minute(s).`,
        })
      );
    }

    try {
      const result = await otp.verify({ userId: pending.id, code: req.body?.code, logger });
      if (!result.ok) {
        attempts.recordFailure(keys);
        logger?.warn(
          { ip, email: pending.email, reason: result.reason, requestId: req.id },
          'admin second factor failed'
        );
        // A burnt or expired challenge cannot be retried on this screen —
        // send them back rather than letting them type into a dead form.
        if (result.reason !== 'wrong code') {
          otp.clearPendingCookie(res, session.isSecure(req));
          return res.status(401).type('html').send(
            loginPage.render({ title, email: pending.email, error: result.message })
          );
        }
        return res.status(401).type('html').send(
          otpPage.render({
            title, email: pending.email,
            minutes: Math.round(otp.CODE_TTL_MS / 60000), error: result.message,
          })
        );
      }

      attempts.recordSuccess(keys);
      otp.clearPendingCookie(res, session.isSecure(req));
      logger?.info({ ip, email: pending.email, requestId: req.id },
        'admin signed in (second factor)');
      session.setCookie(res, req, session.mint({ id: pending.id, email: pending.email }));
      return res.redirect(303, '/admin');
    } catch (err) {
      logger?.error({ err: err.message, ip, requestId: req.id }, 'admin second factor error');
      return res.status(503).type('html').send(
        otpPage.render({
          title, email: pending.email, minutes: Math.round(otp.CODE_TTL_MS / 60000),
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

  // -------------------------------------------------------------------------
  // Screens
  //
  // `deps` carries the live objects the app already built — the parsed config,
  // the upstream client, the audit writer, the vendor store. Reading them here
  // means the console shows what the PROCESS is actually serving, not what the
  // files on disk say. Those differ whenever someone edited YAML without
  // deploying, which is exactly when you want to know.
  // -------------------------------------------------------------------------
  const cfg = () => deps.config || { endpoints: [], upstreams: {}, unreachable: [] };

  async function liveHealth() {
    const out = {
      upstreams: deps.client ? deps.client.health() : {},
      database: await db.health(),
      audit: deps.audit ? deps.audit.stats() : {},
      vendorStore: deps.vendorStore ? deps.vendorStore.snapshot() : {},
    };
    return out;
  }

  const flashOf = (req) => {
    if (req.query.ok) return { kind: 'ok', text: String(req.query.ok).slice(0, 300) };
    if (req.query.err) return { kind: 'err', text: String(req.query.err).slice(0, 300) };
    return null;
  };

  /** Everything below needs the database; say so plainly rather than crashing. */
  function requireDb(res) {
    if (db.isEnabled()) return true;
    res
      .status(503)
      .type('html')
      .send(
        pages.overview({
          admin: { email: '', role: '', canEdit: false },
          flash: { kind: 'err', text: 'No database configured — vendor management is unavailable.' },
          cfg: cfg(),
          vendors: [],
          health: {},
          usage: [],
        })
      );
    return false;
  }

  router.get('/', async (req, res, next) => {
    try {
      const since = new Date(Date.now() - 30 * 864e5);
      const [vendors, health, usage] = await Promise.all([
        db.isEnabled() ? vendorRepo.listVendorsWithKeys() : [],
        liveHealth(),
        db.isEnabled() ? auditRepo.usageSummary({ since }) : [],
      ]);
      res.type('html').send(
        pages.overview({ admin: req.admin, flash: flashOf(req), cfg: cfg(), vendors, health, usage })
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/vendors', async (req, res, next) => {
    try {
      const vendors = db.isEnabled() ? await vendorRepo.listVendorsWithKeys() : [];
      const scopes = new Set();
      for (const e of cfg().endpoints) for (const s of e.scopes || []) scopes.add(s);
      res.type('html').send(
        pages.vendorsPage({ admin: req.admin, flash: flashOf(req), vendors, cfg: cfg(), scopes })
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/vendors', async (req, res, next) => {
    if (!requireDb(res)) return;
    try {
      const id = String(req.body.id || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
        return res.redirect(303, '/admin/vendors?err=' + encodeURIComponent('Invalid vendor id.'));
      }
      let scopes = req.body.scopes || [];
      if (!Array.isArray(scopes)) scopes = [scopes];

      await vendorRepo.upsertVendor({
        id,
        name: String(req.body.name || '').trim() || id,
        scopes: scopes.map(String),
        rateMax: req.body.rateMax ? Number(req.body.rateMax) : undefined,
        rateWindowMs: req.body.rateMax ? 60000 : undefined,
        monthlyQuota: req.body.monthlyQuota ? Number(req.body.monthlyQuota) : null,
      });
      logger?.warn({ admin: req.admin.email, vendor: id, scopes }, 'admin saved vendor');
      await deps.vendorStore?.refresh?.().catch(() => {});
      res.redirect(303, '/admin/vendors?ok=' + encodeURIComponent(`Vendor "${id}" saved.`));
    } catch (err) {
      next(err);
    }
  });

  router.get('/vendors/:id', async (req, res, next) => {
    if (!requireDb(res)) return;
    try {
      const keys = await vendorRepo.listKeys(req.params.id);
      res.type('html').send(
        pages.vendorKeysPage({
          admin: req.admin,
          flash: flashOf(req),
          vendorId: req.params.id,
          keys,
          issuedKey: null,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/vendors/:id/toggle', async (req, res, next) => {
    if (!requireDb(res)) return;
    try {
      const list = await vendorRepo.listVendorsWithKeys();
      const v = list.find((x) => x.id === req.params.id);
      if (!v) return res.redirect(303, '/admin/vendors?err=' + encodeURIComponent('No such vendor.'));
      await vendorRepo.setEnabled(req.params.id, !v.enabled);
      logger?.warn(
        { admin: req.admin.email, vendor: req.params.id, enabled: !v.enabled },
        'admin toggled vendor'
      );
      await deps.vendorStore?.refresh?.().catch(() => {});
      res.redirect(
        303,
        '/admin/vendors?ok=' +
          encodeURIComponent(`Vendor "${req.params.id}" ${v.enabled ? 'disabled' : 'enabled'}.`)
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/vendors/:id/keys', async (req, res, next) => {
    if (!requireDb(res)) return;
    try {
      const out = await vendorRepo.issueKey({
        vendorId: req.params.id,
        label: String(req.body.label || '').trim() || null,
      });
      logger?.warn({ admin: req.admin.email, vendor: req.params.id }, 'admin issued an API key');
      await deps.vendorStore?.refresh?.().catch(() => {});
      const keys = await vendorRepo.listKeys(req.params.id);
      // The plaintext key is rendered once, here, and never stored or logged.
      res.type('html').send(
        pages.vendorKeysPage({
          admin: req.admin,
          flash: null,
          vendorId: req.params.id,
          keys,
          issuedKey: out.key || out,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/vendors/:id/keys/revoke', async (req, res, next) => {
    if (!requireDb(res)) return;
    try {
      await vendorRepo.revokeKey({ vendorId: req.params.id, keyHash: String(req.body.keyHash) });
      logger?.warn({ admin: req.admin.email, vendor: req.params.id }, 'admin revoked an API key');
      await deps.vendorStore?.refresh?.().catch(() => {});
      res.redirect(
        303,
        `/admin/vendors/${encodeURIComponent(req.params.id)}?ok=` +
          encodeURIComponent('Key revoked. Takes up to 30s to apply.')
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/endpoints', (req, res) => {
    res.type('html').send(pages.endpointsPage({ admin: req.admin, flash: flashOf(req), cfg: cfg() }));
  });

  router.get('/activity', async (req, res, next) => {
    try {
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
      const since = new Date(Date.now() - days * 864e5);
      const [usage, recent, quota] = await Promise.all([
        db.isEnabled() ? auditRepo.usageSummary({ since }) : [],
        db.isEnabled() ? auditRepo.recent(50).catch(() => []) : [],
        db.isEnabled() ? quotaRepo.allUsage().catch(() => []) : [],
      ]);
      res.type('html').send(
        pages.activityPage({ admin: req.admin, flash: flashOf(req), usage, recent, quota, days })
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/health', async (req, res, next) => {
    try {
      res.type('html').send(
        pages.healthPage({ admin: req.admin, flash: flashOf(req), health: await liveHealth(), cfg: cfg() })
      );
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // API Studio
  //
  // The page is HTML; everything it does afterwards is JSON over fetch. The
  // JSON routes require `x-requested-with`, which a cross-origin HTML form
  // cannot set — the session cookie is SameSite=Strict as well, so this is a
  // second lock on the same door rather than the only one.
  // -------------------------------------------------------------------------
  const studioJson = express.json({ limit: '1mb' });

  function studioGuard(req, res, next) {
    if (!db.isEnabled()) {
      return res.status(503).json({ error: 'No database configured — the Studio needs one.' });
    }
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'studio') {
      return res.status(400).json({ error: 'missing x-requested-with' });
    }
    if (req.method !== 'GET' && !req.admin.canEdit) {
      return res.status(403).json({ error: 'Your role is read-only here.' });
    }
    next();
  }

  // --- Admin config -------------------------------------------------------
  const settingsRepo = require('../db/repos/settings');
  const settingsPage = require('./settingsPage');

  router.get('/settings', async (req, res, next) => {
    try {
      const [settings, history] = await Promise.all([
        settingsRepo.all(), settingsRepo.history(20),
      ]);
      res.type('html').send(
        settingsPage.render({ admin: req.admin, flash: flashOf(req), settings, history })
      );
    } catch (err) { next(err); }
  });

  router.post('/settings', async (req, res) => {
    if (!req.admin.canEdit) {
      return res.redirect(303, '/admin/settings?err=' + encodeURIComponent('Your role is read-only here.'));
    }
    try {
      const known = await settingsRepo.all();
      const changed = [];
      for (const key of Object.keys(known)) {
        if (!(key in (req.body || {}))) continue;
        const next = String(req.body[key] || '').trim();
        const current = known[key].value || '';
        if (next === current) continue;
        await settingsRepo.set(key, next, req.admin.email);
        changed.push(key);
      }
      logger.info({ actor: req.admin.email, changed }, 'admin config changed');
      res.redirect(303, '/admin/settings?ok=' + encodeURIComponent(
        changed.length ? `Saved ${changed.join(', ')}.` : 'Nothing changed.'));
    } catch (err) {
      res.redirect(303, '/admin/settings?err=' + encodeURIComponent(err.message));
    }
  });

  const catalogRoutes = require('./catalogRoutes');
  router.use('/catalog', catalogRoutes.build(logger, { flashOf, deps }));

  const studioRoutes = require('./studioRoutes');
  router.use('/api', studioJson, studioGuard, studioRoutes.json(logger, deps));
  router.get('/studio.js', studioRoutes.script());
  router.get('/studio', studioRoutes.page(logger, { flashOf }));

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

module.exports = { buildAdminRouter };
