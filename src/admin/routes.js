'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');

const adminDb = require('../db/adminPool');
const session = require('./session');
const attempts = require('./loginAttempts');
const loginPage = require('./loginPage');
const otpPage = require('./otpPage');
const ui = require('./ui');
const settings = require('../db/repos/settings');
const otp = require('./otp');
const pages = require('./pages');
const {
  makeAdminAuth, pagesOf, hasGatewayGrant, PAGE_KEY,
} = require('../middleware/adminAuth');
const db = require('../db/pool');
const vendorRepo = require('../db/repos/vendors');
const appRepo = require('../db/repos/applications');
const ssoRepo = require('../db/repos/sso');
const ssoProbe = require('./ssoProbe');
const applicationsPage = require('./applicationsPage');
const onboardPage = require('./onboardPage');
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

  // The product's name, refreshed once per request from the settings an
  // administrator owns. Cached for fifteen seconds in the repo, so this is a
  // query every fifteen seconds rather than one per page.
  //
  // Set on `ui` as well as on the request because layout() is called by a
  // dozen page functions with a dozen signatures, and threading the name
  // through all of them to deliver the same value everywhere would be churn
  // without clarity. See the note next to setBrand().
  router.use(async (req, _res, next) => {
    try {
      req.brand = await settings.brand();
      ui.setBrand(req.brand);
    } catch {
      // Never block a page, least of all the login page, because a name
      // could not be read. The env fallback already holds a usable value.
      req.brand = ui.currentBrand();
    }
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
  /**
   * Where to send someone after a successful sign-in.
   *
   * Only a path on this console, and only one that looks like a path. An
   * unvalidated `next` on a sign-in form is an open redirect, which is how a
   * convincing phishing link gets built out of a domain people trust: the host
   * is genuinely pravah.ashikagroup.com, the sign-in is genuine, and the
   * landing page is not. A leading `//` or a `\` is enough for a browser to
   * read what follows as a host, so both are refused along with anything that
   * does not start /admin/.
   */
  function safeNext(value) {
    const s = String(value || '');
    if (!s.startsWith('/admin/')) return '';
    if (s.startsWith('//') || s.includes('\\')) return '';
    if (s.startsWith('/admin/login')) return '';   // never bounce back to here
    return s.slice(0, 500);
  }

  router.get('/login', (req, res) => {
    res.type('html').send(loginPage.render({
      title,
      brand: req.brand,
      notice: req.query.timeout
        ? `You were signed out after ${session.idleMinutes()} ` +
          `minute${session.idleMinutes() === 1 ? '' : 's'} without activity. ` +
          'Sign in again to carry on.'
        : '',
      next: safeNext(req.query.next),
    }));
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
      res.status(status).type('html').send(loginPage.render({ title, brand: req.brand, error: message, email }));
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
        return res.redirect(303, safeNext(req.body?.next) || '/admin');
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
              title, brand: req.brand, email,
              error:
                'Your role needs a second factor, but the code could not be emailed. ' +
                'Tell your administrator — the platform mail settings need attention.',
            })
          );
        }
        otp.setPendingCookie(res, req, otp.mintPending(user), session.isSecure(req));
        logger?.info({ ip, email, role: user.role, requestId: req.id },
          'admin sign-in: password accepted, awaiting second factor');
        return res.redirect(303, '/admin/login/otp' +
          (safeNext(req.body?.next) ? '?next=' + encodeURIComponent(safeNext(req.body.next)) : ''));
      }

      logger?.info({ ip, email, role: user.role, requestId: req.id }, 'admin signed in');
      session.setCookie(res, req, session.mint({ id: user.id, email: user.email }));
      return res.redirect(303, safeNext(req.body?.next) || '/admin');
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
      otpPage.render({ title, brand: req.brand, email: pending.email,
        minutes: Math.round(otp.CODE_TTL_MS / 60000), next: safeNext(req.query.next) })
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
          title, brand: req.brand, email: pending.email,
          minutes: Math.round(otp.CODE_TTL_MS / 60000),
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
            loginPage.render({ title, brand: req.brand, email: pending.email, error: result.message })
          );
        }
        return res.status(401).type('html').send(
          otpPage.render({
            title, brand: req.brand, email: pending.email,
            minutes: Math.round(otp.CODE_TTL_MS / 60000), error: result.message,
          })
        );
      }

      attempts.recordSuccess(keys);
      otp.clearPendingCookie(res, session.isSecure(req));
      logger?.info({ ip, email: pending.email, requestId: req.id },
        'admin signed in (second factor)');
      session.setCookie(res, req, session.mint({ id: pending.id, email: pending.email }));
      const after = safeNext(req.body?.next) || safeNext(req.query?.next);
      return res.redirect(303, after || '/admin');
    } catch (err) {
      logger?.error({ err: err.message, ip, requestId: req.id }, 'admin second factor error');
      return res.status(503).type('html').send(
        otpPage.render({
          title, brand: req.brand, email: pending.email,
          minutes: Math.round(otp.CODE_TTL_MS / 60000),
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
      if (!err) {
        // Sliding idle window. Every request the administrator makes pushes
        // the 30-minute clock forward; nothing pushes the 8-hour ceiling,
        // which renew() carries through unchanged.
        //
        // Guarded by headersSent because a handler further down may already
        // have streamed — appending Set-Cookie then throws and turns a
        // successful page into a 500.
        try {
          const fresh = session.renew(req.adminClaims);
          if (fresh && !res.headersSent) session.setCookie(res, req, fresh);
        } catch (e) {
          // A session that cannot be renewed is not a request that should
          // fail; it simply expires on schedule.
          logger.warn({ err: e.message }, 'could not renew the admin session cookie');
        }
        return next();
      }

      const wantsHtml = String(req.headers.accept || '').includes('text/html');
      if (wantsHtml && (err.status === 401 || err.status === 403)) {
        // Clear the dead cookie on the way out. Without this the browser keeps
        // presenting an expired token on every subsequent request, and the
        // sign-in page is reached carrying a credential that cannot work.
        // Remember where they were headed, whether they timed out or simply
        // arrived on a bookmarked deep link while signed out. Both end at the
        // sign-in page, and in both cases dumping them on the Overview
        // afterwards makes them navigate back by hand.
        const back = req.originalUrl && req.method === 'GET' && req.originalUrl !== '/admin'
          ? 'next=' + encodeURIComponent(req.originalUrl)
          : '';
        if (err.expiredSession) {
          // Clear the dead cookie on the way out. Without this the browser
          // keeps presenting an expired token on every later request, and the
          // sign-in page is reached carrying a credential that cannot work.
          session.clearCookie(res, req);
          return res.redirect(303, '/admin/login?timeout=1' + (back ? '&' + back : ''));
        }
        return res.redirect(303, '/admin/login' + (back ? '?' + back : ''));
      }
      return next(err);
    });
  });

  // -------------------------------------------------------------------------
  // Screens
  //
  // `deps` carries the live objects the app already built — the parsed config,
  // the upstream client, the audit writer, the consumer store. Reading them here
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
          flash: { kind: 'err', text: 'No database configured — consumer management is unavailable.' },
          cfg: cfg(),
          vendors: [],
          health: {},
          usage: [],
        })
      );
    return false;
  }

  const dashboardPage = require('./dashboardPage');

  /** What the live catalogue exposes, counted from what is actually mounted. */
  function exposureOf(config) {
    const eps = config.endpoints || [];
    const whitelisted = eps.filter((e) => e.response.mode === 'whitelist').length;
    return {
      live: eps.length,
      whitelisted,
      unfiltered: eps.length - whitelisted,
      draft: 0, // filled from the database below when there is one
    };
  }

  router.get('/', async (req, res, next) => {
    try {
      const since = ['1h', '24h', '7d', '30d'].includes(String(req.query.since))
        ? String(req.query.since) : '24h';
      const exposure = exposureOf(cfg());

      // Without a database there is no traffic to show. The page still renders
      // — the catalogue and the breakers are in memory — rather than erroring,
      // because "no database" is a configuration state, not a failure.
      const empty = {
        requests: 0, calls: 0, turned_away: 0, errors: 0,
        consumers: 0, endpoints: 0, p50_ms: 0, p95_ms: 0,
      };
      const [summary, series, topEndpoints, slowest, topConsumers, errors, turnedAway,
             health, draft] =
        db.isEnabled()
          ? await Promise.all([
              logsRepo.trafficSummary({ since }),
              logsRepo.series({ since }),
              logsRepo.topEndpoints({ since }),
              logsRepo.slowest({ since }),
              logsRepo.topConsumers({ since }),
              logsRepo.errorBreakdown({ since }),
              logsRepo.turnedAwayBreakdown({ since }),
              liveHealth(),
              db.query(`SELECT count(*)::int n FROM gateway.endpoints WHERE status = 'draft'`)
                .then((r) => r?.rows?.[0]?.n || 0).catch(() => 0),
            ])
          : [empty, [], [], [], [], [], [], await liveHealth(), 0];
      exposure.draft = draft;

      res.type('html').send(
        dashboardPage.overviewPage({
          admin: req.admin, flash: flashOf(req), since, summary, series,
          topEndpoints, slowest, topConsumers, errors, turnedAway, health, exposure,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  // Old links keep working. These paths were /admin/vendors until the word
  // changed, and a bookmark or a pasted link is not a reason to see a 404.
  router.get(/^\/vendors(\/.*)?$/, (req, res) => {
    res.redirect(301, '/admin/consumers' + (req.params[0] || ''));
  });

  /**
   * Keepalive for the "Stay signed in" button.
   *
   * It does nothing itself. Reaching this handler at all means the request
   * already passed admin auth, and the middleware above slid the idle window
   * on the way through — so the renewal is a side effect of being
   * authenticated, not a privilege this route grants. There is deliberately no
   * second code path that can extend a session.
   *
   * It cannot outlive the absolute ceiling either: renew() refuses once
   * gw_abs is reached, so a tab pinging every 29 minutes still ends at 8 hours.
   */
  // -------------------------------------------------------------------------
  // Single sign-on settings
  //
  // Save, test, and the role mapping. The sign-in FLOW is separate and comes
  // once the portal's contract is confirmed — the probe below is what
  // confirms it, from the only machine that can reach the portal.
  // -------------------------------------------------------------------------
  const ssoBack = (msg, kind = 'ok') =>
    '/admin/settings?' + kind + '=' + encodeURIComponent(msg) + '#sso';

  const ssoInput = (b) => ({
    enabled: b.enabled === '1',
    baseUrl: b.base_url,
    clientId: b.client_id,
    clientSecret: b.client_secret,
    redirectUri: b.redirect_uri,
    usePkce: b.use_pkce === '1',
    allowInsecure: b.allow_insecure === '1',
  });

  router.post('/settings/sso', async (req, res) => {
    if (!req.admin.canEdit) return res.redirect(303, ssoBack('Your role is read-only here.', 'err'));
    try {
      await ssoRepo.save(ssoInput(req.body || {}), req.admin.email);
      logger.info({ actor: req.admin.email }, 'sso settings changed');
      res.redirect(303, ssoBack('Saved. Press "Test the portal" before switching it on.'));
    } catch (err) {
      res.redirect(303, ssoBack(err.message, 'err'));
    }
  });

  router.post('/settings/sso/secret/clear', async (req, res) => {
    if (!req.admin.canEdit) return res.redirect(303, ssoBack('Your role is read-only here.', 'err'));
    try {
      await ssoRepo.clearSecret(req.admin.email);
      logger.warn({ actor: req.admin.email }, 'sso client secret cleared');
      res.redirect(303, ssoBack('Forgotten. Portal sign-in will not work until a new one is saved.'));
    } catch (err) {
      res.redirect(303, ssoBack(err.message, 'err'));
    }
  });

  router.post('/settings/sso/test', async (req, res) => {
    if (!req.admin.canEdit) return res.redirect(303, ssoBack('Your role is read-only here.', 'err'));
    try {
      // Save first: testing what is on screen rather than what is stored is
      // how somebody ends up with a green tick against settings they never
      // saved, then wonders why sign-in fails after a restart.
      await ssoRepo.save(ssoInput(req.body || {}), req.admin.email);
      const { ok, detail, notes } = await ssoProbe.probe();
      await ssoRepo.recordTest({ ok, error: ok ? null : 'the portal could not be reached', detail });
      logger.info({ actor: req.admin.email, ok }, 'sso portal probed');
      res.redirect(303, ssoBack(ok
        ? `The portal answered. ${notes.length ? notes[0] : 'See what it returned below.'}`
        : 'Nothing answered from this server. Check the URL and the network path.',
        ok ? 'ok' : 'err'));
    } catch (err) {
      await ssoRepo.recordTest({ ok: false, error: err.message }).catch(() => {});
      res.redirect(303, ssoBack(err.message, 'err'));
    }
  });

  router.post('/settings/sso/role', async (req, res) => {
    if (!req.admin.canEdit) return res.redirect(303, ssoBack('Your role is read-only here.', 'err'));
    try {
      const b = req.body || {};
      await ssoRepo.setRole(
        { portalRole: b.portal_role, level: b.level, notes: b.notes }, req.admin.email);
      res.redirect(303, ssoBack(`"${b.portal_role}" now grants ${b.level} here.`));
    } catch (err) {
      res.redirect(303, ssoBack(err.message, 'err'));
    }
  });

  router.post('/settings/sso/role/remove', async (req, res) => {
    if (!req.admin.canEdit) return res.redirect(303, ssoBack('Your role is read-only here.', 'err'));
    try {
      await ssoRepo.removeRole((req.body || {}).portal_role, req.admin.email);
      res.redirect(303, ssoBack('Unmapped. Anyone with that portal role will now be refused.'));
    } catch (err) {
      res.redirect(303, ssoBack(err.message, 'err'));
    }
  });

  router.get('/session/ping', (req, res) => {
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      idleSeconds: session.idleSeconds(),
      // So the client can show the real remaining life rather than assuming a
      // full window it may not get near the ceiling.
      expiresIn: req.adminClaims?.gw_abs
        ? Math.max(0, Number(req.adminClaims.gw_abs) - Math.floor(Date.now() / 1000))
        : null,
    });
  });

  // -------------------------------------------------------------------------
  // Applications — the supplier application master
  //
  // There is no DELETE route here, and that is not an oversight to be tidied
  // up later. The reference is the foreign key in `endpoints`, the scope baked
  // into every credential's AAD and the `upstream` column on every audit row
  // ever written about it. Deactivation is the reversible operation people
  // actually want, and it has its own confirmation naming what stops serving.
  // -------------------------------------------------------------------------

  const appsBack = (msg, kind = 'ok', at = '') =>
    `/admin/applications${at}?${kind}=` + encodeURIComponent(msg);

  router.get('/applications', async (req, res, next) => {
    try {
      const rows = db.isEnabled() ? await appRepo.list() : [];
      res.type('html').send(applicationsPage.applicationsPage({
        admin: req.admin, flash: flashOf(req), rows, canEdit: req.admin.canEdit,
      }));
    } catch (err) { next(err); }
  });

  router.get('/applications/new', (req, res) => {
    if (!req.admin.canEdit) return res.redirect(303, appsBack('Your role is read-only here.', 'err'));
    res.type('html').send(applicationsPage.applicationPage({
      admin: req.admin, flash: flashOf(req), app: null, endpoints: [],
      canEdit: true, isNew: true,
    }));
  });

  router.get('/applications/:name', async (req, res, next) => {
    try {
      const app = await appRepo.get(req.params.name);
      if (!app) return res.redirect(303, appsBack(`No application called "${req.params.name}".`, 'err'));
      const endpoints = await appRepo.endpointsUnder(app.name);
      res.type('html').send(applicationsPage.applicationPage({
        admin: req.admin, flash: flashOf(req), app, endpoints, canEdit: req.admin.canEdit,
      }));
    } catch (err) { next(err); }
  });

  const appInput = (b) => ({
    name: b.name,
    displayName: b.display_name,
    vendorName: b.vendor_name,
    owner: b.owner,
    baseUrl: b.base_url,
    timeoutMs: b.timeout_ms,
    notes: b.notes,
    alertEmails: b.alert_emails,
    // An unchecked box sends nothing at all, so absence is false rather than
    // "leave it alone" — which is exactly what the form means here.
    alertsEnabled: b.alerts_enabled === '1',
  });

  router.post('/applications/new', async (req, res) => {
    if (!req.admin.canEdit) return res.redirect(303, appsBack('Your role is read-only here.', 'err'));
    try {
      const saved = await appRepo.save(appInput(req.body || {}), req.admin.email);
      logger.info({ actor: req.admin.email, application: saved.name }, 'application created');
      if (deps.reloadCatalog) await deps.reloadCatalog().catch(() => {});
      res.redirect(303, `/admin/applications/${saved.name}?ok=` + encodeURIComponent(
        'Added. Build its endpoints in the Studio.'));
    } catch (err) {
      res.redirect(303, '/admin/applications/new?err=' + encodeURIComponent(err.message));
    }
  });

  router.post('/applications/:name', async (req, res) => {
    if (!req.admin.canEdit) return res.redirect(303, appsBack('Your role is read-only here.', 'err'));
    try {
      const body = { ...(req.body || {}), name: req.params.name };
      await appRepo.save(appInput(body), req.admin.email);
      logger.info({ actor: req.admin.email, application: req.params.name }, 'application updated');
      if (deps.reloadCatalog) await deps.reloadCatalog().catch(() => {});
      res.redirect(303, `/admin/applications/${req.params.name}?ok=` + encodeURIComponent('Saved.'));
    } catch (err) {
      res.redirect(303, `/admin/applications/${req.params.name}?err=` + encodeURIComponent(err.message));
    }
  });

  router.post('/applications/:name/deactivate', async (req, res) => {
    if (!req.admin.canEdit) return res.redirect(303, appsBack('Your role is read-only here.', 'err'));
    try {
      const app = await appRepo.setActive(req.params.name, false, req.admin.email,
        (req.body || {}).reason);
      const held = await appRepo.endpointsUnder(app.name);
      // Logged at warn: this takes endpoints out of service, and the person
      // reading journald during an incident should find it without filtering.
      logger.warn({
        actor: req.admin.email, application: app.name,
        endpointsHeld: held.length, reason: app.deactivated_reason,
      }, 'application deactivated — its endpoints are no longer served');
      if (deps.reloadCatalog) await deps.reloadCatalog().catch(() => {});
      res.redirect(303, `/admin/applications/${app.name}?ok=` + encodeURIComponent(
        `Deactivated. ${held.length} endpoint(s) held — nothing was deleted.`));
    } catch (err) {
      res.redirect(303, `/admin/applications/${req.params.name}?err=` + encodeURIComponent(err.message));
    }
  });

  router.post('/applications/:name/activate', async (req, res) => {
    if (!req.admin.canEdit) return res.redirect(303, appsBack('Your role is read-only here.', 'err'));
    try {
      const app = await appRepo.setActive(req.params.name, true, req.admin.email, null);
      logger.info({ actor: req.admin.email, application: app.name }, 'application reactivated');
      if (deps.reloadCatalog) await deps.reloadCatalog().catch(() => {});
      res.redirect(303, `/admin/applications/${app.name}?ok=` + encodeURIComponent(
        'Reactivated. Endpoints that were live are answering again.'));
    } catch (err) {
      res.redirect(303, `/admin/applications/${req.params.name}?err=` + encodeURIComponent(err.message));
    }
  });

  router.get('/consumers', async (req, res, next) => {
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

  router.post('/consumers', async (req, res, next) => {
    if (!requireDb(res)) return;
    try {
      const id = String(req.body.id || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
        return res.redirect(303, '/admin/consumers?err=' + encodeURIComponent('Invalid consumer id.'));
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
      logger?.warn({ admin: req.admin.email, vendor: id, scopes }, 'admin saved consumer');
      await deps.vendorStore?.refresh?.().catch(() => {});
      res.redirect(303, '/admin/consumers?ok=' + encodeURIComponent(`Consumer "${id}" saved.`));
    } catch (err) {
      next(err);
    }
  });

  router.get('/consumers/:id', async (req, res, next) => {
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

  router.post('/consumers/:id/toggle', async (req, res, next) => {
    if (!requireDb(res)) return;
    try {
      const list = await vendorRepo.listVendorsWithKeys();
      const v = list.find((x) => x.id === req.params.id);
      if (!v) return res.redirect(303, '/admin/consumers?err=' + encodeURIComponent('No such consumer.'));
      await vendorRepo.setEnabled(req.params.id, !v.enabled);
      logger?.warn(
        { admin: req.admin.email, vendor: req.params.id, enabled: !v.enabled },
        'admin toggled consumer'
      );
      await deps.vendorStore?.refresh?.().catch(() => {});
      res.redirect(
        303,
        '/admin/consumers?ok=' +
          encodeURIComponent(`Consumer "${req.params.id}" ${v.enabled ? 'disabled' : 'enabled'}.`)
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/consumers/:id/keys', async (req, res, next) => {
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

  router.post('/consumers/:id/keys/revoke', async (req, res, next) => {
    if (!requireDb(res)) return;
    try {
      await vendorRepo.revokeKey({ vendorId: req.params.id, keyHash: String(req.body.keyHash) });
      logger?.warn({ admin: req.admin.email, vendor: req.params.id }, 'admin revoked an API key');
      await deps.vendorStore?.refresh?.().catch(() => {});
      res.redirect(
        303,
        `/admin/consumers/${encodeURIComponent(req.params.id)}?ok=` +
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
      const smtp = require('../db/repos/platformSmtp');
      const [health, mail, baseUrl] = await Promise.all([
        liveHealth(),
        smtp.ready().catch((e) => ({ ok: false, reason: e.message })),
        settingsRepo.baseUrl().catch(() => ''),
      ]);
      const up = process.uptime();
      const d = Math.floor(up / 86400);
      const h = Math.floor((up % 86400) / 3600);
      const m = Math.floor((up % 3600) / 60);
      res.type('html').send(
        dashboardPage.healthPage({
          admin: req.admin, flash: flashOf(req), health, cfg: cfg(), mail,
          process: {
            uptime: d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`,
            rssMb: Math.round(process.memoryUsage().rss / 1048576),
            node: process.version,
          },
          settingsSource: { baseUrl },
        })
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

  const mailRepo = require('../db/repos/mailSettings');

  // -------------------------------------------------------------------------
  // Logs
  // -------------------------------------------------------------------------
  const logsRepo = require('../db/repos/logs');
  const logsPage = require('./logsPage');

  /** Empty query string means "no filter", not a filter on the empty string. */
  const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));

  const logQuery = (req) => ({
    q: str(req.query.q), since: str(req.query.since), page: req.query.page,
    consumer: str(req.query.consumer), endpoint: str(req.query.endpoint),
    status: str(req.query.status), actor: str(req.query.actor), area: str(req.query.area),
  });

  router.get('/logs', async (req, res, next) => {
    try {
      const query = logQuery(req);
      const since = query.since || '24h';
      const [page, summary, facets] = await Promise.all([
        logsRepo.traffic({ ...query, since }),
        logsRepo.trafficSummary({ since, consumer: query.consumer, endpoint: query.endpoint }),
        logsRepo.trafficFacets({ since }),
      ]);
      res.type('html').send(
        logsPage.trafficPage({ admin: req.admin, flash: flashOf(req), page, summary, facets, query })
      );
    } catch (err) { next(err); }
  });

  router.get('/logs/changes', async (req, res, next) => {
    try {
      const query = logQuery(req);
      const since = query.since || '30d';
      const [page, facets] = await Promise.all([
        logsRepo.changes({ ...query, since }),
        logsRepo.changeFacets(),
      ]);
      res.type('html').send(
        logsPage.changesPage({ admin: req.admin, flash: flashOf(req), page, facets, query })
      );
    } catch (err) { next(err); }
  });

  router.get('/logs/changes/:id', async (req, res, next) => {
    try {
      const row = await logsRepo.catalogDiff(req.params.id);
      if (!row) return next();
      res.type('html').send(logsPage.diffPage({ admin: req.admin, flash: flashOf(req), row }));
    } catch (err) { next(err); }
  });

  /**
   * How it works. Static, but rendered rather than a file, because it reads
   * the public base URL so the diagram names THIS deployment's host rather
   * than an example someone has to translate.
   */
  router.get('/how', async (req, res, next) => {
    try {
      const howPage = require('./howPage');
      const baseUrl = await settingsRepo.baseUrl().catch(() => '');
      res.type('html').send(
        howPage.render({ admin: req.admin, flash: flashOf(req), baseUrl })
      );
    } catch (err) { next(err); }
  });

  router.get('/settings', async (req, res, next) => {
    try {
      const [settings, history, mail, sso, ssoRoles] = await Promise.all([
        settingsRepo.all(), settingsRepo.history(20),
        mailRepo.status().catch(() => null),
        ssoRepo.status().catch(() => null),
        ssoRepo.roles().catch(() => []),
      ]);
      res.type('html').send(
        settingsPage.render({
          admin: req.admin, flash: flashOf(req), settings, history, mail, sso, ssoRoles,
        })
      );
    } catch (err) { next(err); }
  });

  /**
   * Mail settings.
   *
   * Separate from the settings POST above because this is a different shape:
   * a password that must not be echoed, two checkboxes whose absence is
   * meaningful, and a Test button that is a second submit of the same form.
   */
  function mailInput(body) {
    return {
      host: body.host,
      port: body.port,
      username: body.username,
      // An empty box means "keep what is stored" — which is what the
      // placeholder says and what lets someone change the from-address without
      // going to find the mailbox password again.
      password: typeof body.password === 'string' && body.password.length ? body.password : undefined,
      fromEmail: body.fromEmail,
      fromName: body.fromName,
      // An unticked checkbox is ABSENT from a form post, not false. Reading it
      // as undefined would mean every save silently re-enabled whatever the
      // person just turned off.
      secure: body.secure === '1',
      rejectUnauthorized: body.rejectUnauthorized === '1',
    };
  }

  router.post('/settings/mail', async (req, res) => {
    if (!req.admin.canEdit) {
      return res.redirect(303, '/admin/settings?err=' + encodeURIComponent('Your role is read-only here.'));
    }
    try {
      await mailRepo.save(mailInput(req.body || {}), req.admin.email);
      logger.info({ actor: req.admin.email, host: (req.body || {}).host }, 'mail settings changed');
      res.redirect(303, '/admin/settings?ok=' + encodeURIComponent(
        'Saved. Press Test connection to check it before anyone needs it.') + '#mail');
    } catch (err) {
      res.redirect(303, '/admin/settings?err=' + encodeURIComponent(err.message));
    }
  });

  /**
   * Open the connection, authenticate, hang up. Sends no message.
   *
   * Saves first, so the thing tested is the thing on screen. Testing the
   * previously saved settings while showing someone the new ones is how a
   * green tick ends up describing a configuration nobody is using.
   */
  router.post('/settings/mail/test', async (req, res) => {
    if (!req.admin.canEdit) {
      return res.redirect(303, '/admin/settings?err=' + encodeURIComponent('Your role is read-only here.'));
    }
    try {
      await mailRepo.save(mailInput(req.body || {}), req.admin.email);
      const smtp = require('../db/repos/platformSmtp');
      const state = await smtp.ready();
      if (!state.ok) throw new Error(state.reason);

      const { transport } = await smtp.transportConfig();
      const nodemailer = require('nodemailer');
      await nodemailer.createTransport(transport).verify();

      await mailRepo.recordTest({ ok: true });
      logger.info({ actor: req.admin.email, host: state.host }, 'mail test succeeded');
      res.redirect(303, '/admin/settings?ok=' + encodeURIComponent(
        `Connected to ${state.host}. Sign-in codes can be sent.`) + '#mail');
    } catch (err) {
      // Recorded as well as shown: the next person to open this screen should
      // see that it is broken without having to press the button themselves.
      await mailRepo.recordTest({ ok: false, error: err.message }).catch(() => {});
      logger.warn({ actor: req.admin.email, err: err.message }, 'mail test failed');
      res.redirect(303, '/admin/settings?err=' + encodeURIComponent(
        `Could not connect: ${err.message}`) + '#mail');
    }
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
  // The chooser sits in front of the wizard: what you are onboarding decides
  // which questions are the right ones. /admin/studio keeps working on its own
  // so every existing link and bookmark still lands where it did.
  router.get('/onboard', (req, res) => {
    res.type('html').send(onboardPage.render({ admin: req.admin, flash: flashOf(req) }));
  });

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
