'use strict';

const express = require('express');
const helmet = require('helmet');

const configLoader = require('./core/config');
const { UpstreamClient } = require('./core/upstream');
const { buildRouter } = require('./core/router');
const { FieldObserver } = require('./core/discovery');
const openapi = require('./core/openapi');
const errors = require('./core/errors');
const requestId = require('./middleware/requestId');
const makeErrorHandler = require('./middleware/errorHandler');
const { makeAuthMiddleware } = require('./middleware/auth');

const db = require('./db/pool');
const adminDb = require('./db/adminPool');
const { VendorStore } = require('./db/repos/vendors');
const { AuditWriter } = require('./db/repos/audit');

/**
 * Compose the application.
 *
 * `createApp` is synchronous so the object graph is easy to reason about, but
 * the database-backed pieces need async startup. `start()` on the returned
 * object does that, and the server should not listen until it resolves.
 */
function createApp({ logger, config } = {}) {
  const cfg = config || configLoader.load();
  const app = express();

  if (cfg.unreachable.length) {
    logger.warn(
      { endpoints: cfg.unreachable },
      'these endpoints are not reachable by any enabled vendor — no vendor holds their scopes'
    );
  }

  const unfiltered = cfg.endpoints.filter((e) => e.response.mode !== 'whitelist');
  if (unfiltered.length) {
    logger.warn(
      {
        count: unfiltered.length,
        endpoints: unfiltered.map((e) => `${e.name} (${e.response.mode})`),
      },
      'endpoints are serving unfiltered or partially filtered responses — these are not ' +
        'protected against upstream schema change'
    );
  }

  app.disable('x-powered-by');
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));

  app.use(
    helmet({
      // This is a JSON API, not a website; the HTML-oriented policies are noise
      // but the header-stripping and nosniff behaviour are worth having.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(requestId);

  // Modest body cap. A vendor should not be able to make you buffer megabytes.
  app.use(express.json({ limit: process.env.MAX_BODY || '64kb', strict: true }));

  // Malformed JSON arrives here as a SyntaxError from body-parser; convert it
  // before it reaches the generic handler and becomes an opaque 500.
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return next(errors.badRequest('Request body is not valid JSON.', 'json parse failed'));
    }
    if (err && err.type === 'entity.too.large') {
      return next(errors.badRequest('Request body too large.', 'body too large'));
    }
    return next(err);
  });

  const client = new UpstreamClient(cfg.upstreams, logger);

  const audit = new AuditWriter({ logger });

  const vendorStore = new VendorStore({
    logger,
    // Used only when DATABASE_URL is unset, so the gateway still runs locally
    // and before the database exists.
    fallback: { vendors: cfg.vendors, vendorsByKeyHash: cfg.vendorsByKeyHash },
  });

  const observer = new FieldObserver({
    logger,
    enabled: cfg.endpoints.some((e) => e.discover),
  });

  // -------------------------------------------------------------------------
  // Unauthenticated operational endpoints. These expose nothing about
  // upstreams beyond breaker state, and are intended to be bound to the VNet
  // or blocked at nginx — see deploy/nginx.conf.
  // -------------------------------------------------------------------------
  // Browsers request /favicon.ico on every page load. Without this it falls
  // through to the vendor router, is refused as an unauthenticated call, and
  // writes an audit row — so the audit log fills with 401s that have nothing
  // to do with any vendor, burying the traffic you actually care about.
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.get('/readyz', async (req, res) => {
    const breakers = client.health();
    const database = await db.health();
    const auditStats = audit.stats();

    // Degraded, not dead. An open breaker or a sick database means take this
    // instance out of rotation if you have another; it does not mean the
    // gateway is refusing traffic.
    const degraded =
      Object.values(breakers).some((b) => b.state === 'open') ||
      (database.enabled && database.ok === false) ||
      auditStats.dropped > 0;

    res.status(degraded ? 503 : 200).json({
      ok: !degraded,
      upstreams: breakers,
      database,
      audit: auditStats,
      vendorStore: vendorStore.snapshot(),
    });
  });

  // -------------------------------------------------------------------------
  // Admin surface. Mounted BEFORE the vendor auth middleware, because an
  // administrator signs in with a password or a platform token — never with a
  // vendor API key. The two identities never meet.
  // -------------------------------------------------------------------------
  if (String(process.env.ADMIN_UI_ENABLED || 'true').toLowerCase() === 'true') {
    const { buildAdminRouter } = require('./admin/routes');
    app.use(
      '/admin',
      buildAdminRouter(logger, {
        // A getter, not a snapshot: the console must show what the process is
        // serving right now, which changes when the Studio publishes.
        get config() { return live.cfg; },
        client, audit, vendorStore,
        reloadCatalog: () => reloadCatalog(),
      })
    );
    logger.info({ path: '/admin' }, 'admin UI mounted');
  }

  // -------------------------------------------------------------------------
  // Vendor-facing surface. Auth applies to everything below this line.
  // -------------------------------------------------------------------------
  app.use(makeAuthMiddleware(vendorStore, logger));

  // The spec a vendor sees is filtered to the endpoints their scopes allow, so
  // one vendor cannot discover another partner's endpoints from the docs.
  app.get('/openapi.json', (req, res) => {
    const visible = live.cfg.endpoints.filter((e) => e.scopes.some((s) => req.vendor.scopes.has(s)));
    res.json(
      openapi.build({
        endpoints: visible,
        info: {
          title: process.env.API_TITLE || 'Partner API',
          version: process.env.API_VERSION || '1.0.0',
          servers: [{ url: process.env.PUBLIC_BASE_URL || 'https://partner-api.example.com' }],
        },
      })
    );
  });

  // ---------------------------------------------------------------------
  // The routed catalogue, which can change while the process runs.
  //
  // Endpoints come from two places: the YAML files in config/, and the
  // database tables the API Studio writes. Both go through the SAME validator
  // before anything is mounted — one definition of a valid endpoint, so a
  // whitelist mistake made in a form fails exactly as one committed to a file
  // would.
  //
  // The swap is a single assignment of `live`, so a request is served either
  // entirely by the old catalogue or entirely by the new one. If a reload
  // fails validation the old catalogue stays mounted and the error is logged:
  // a bad edit must not be able to take the gateway down.
  // ---------------------------------------------------------------------
  const live = {
    cfg,
    router: buildRouter({ endpoints: cfg.endpoints, client, logger, observer, audit }),
  };

  async function reloadCatalog() {
    if (!db.isEnabled()) return { changed: false, reason: 'no database' };
    const catalog = require('./db/repos/catalog');
    const merged = await catalog.mergeWithFiles(configLoader.rawSources());
    const next = configLoader.loadFrom(merged);
    // One client throughout, with its upstream set swapped in place, so the
    // health screen and the request path never disagree about breaker state.
    client.replace(next.upstreams);
    live.cfg = next;
    live.router = buildRouter({ endpoints: next.endpoints, client, logger, observer, audit });
    logger.info(
      { endpoints: next.endpoints.length, upstreams: Object.keys(next.upstreams).length },
      'catalogue reloaded'
    );
    return { changed: true, endpoints: next.endpoints.length };
  }

  app.use((req, res, next) => live.router(req, res, next));

  // Anything not declared in the manifest ends here.
  app.use((req, res, next) => next(errors.notFound()));

  app.use(makeErrorHandler(logger, audit));

  /** Bring up the database-backed pieces. Call before listening. */
  async function start() {
    db.init(logger);
    adminDb.init(logger);

    if (db.isEnabled() && String(process.env.GW_MIGRATE_ON_BOOT || process.env.DB_MIGRATE_ON_BOOT) === 'true') {
      const { migrate } = require('./db/migrate');
      const result = await migrate(logger);
      if (result.applied.length) {
        logger.info({ applied: result.applied }, 'migrations applied at boot');
      }
    }

    // Fold in whatever the Studio has published. A failure here is logged and
    // survived: the YAML catalogue is already mounted, and refusing to boot
    // because one database row is malformed would take down endpoints that
    // have nothing to do with it.
    if (db.isEnabled()) {
      try {
        await reloadCatalog();
      } catch (err) {
        logger.error(
          { err: err.message },
          'the database catalogue could not be loaded — serving the YAML endpoints only'
        );
      }
    }

    await vendorStore.start();
    audit.start();
  }

  async function stop() {
    await vendorStore.stop();
    // Flush and persist discovery before the pool closes — it writes through it.
    await observer.stop();
    await audit.stop();
    await adminDb.close();
    await db.close();
  }

  return { app, config: cfg, client, observer, audit, vendorStore, start, stop };
}

module.exports = { createApp };
