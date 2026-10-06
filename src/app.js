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
  // Vendor-facing surface. Auth applies to everything below this line.
  // -------------------------------------------------------------------------
  app.use(makeAuthMiddleware(vendorStore, logger));

  // The spec a vendor sees is filtered to the endpoints their scopes allow, so
  // one vendor cannot discover another partner's endpoints from the docs.
  app.get('/openapi.json', (req, res) => {
    const visible = cfg.endpoints.filter((e) => e.scopes.some((s) => req.vendor.scopes.has(s)));
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

  app.use(buildRouter({ endpoints: cfg.endpoints, client, logger, observer, audit }));

  // Anything not declared in the manifest ends here.
  app.use((req, res, next) => next(errors.notFound()));

  app.use(makeErrorHandler(logger, audit));

  /** Bring up the database-backed pieces. Call before listening. */
  async function start() {
    db.init(logger);

    if (db.isEnabled() && String(process.env.DB_MIGRATE_ON_BOOT) === 'true') {
      const { migrate } = require('./db/migrate');
      const result = await migrate(logger);
      if (result.applied.length) {
        logger.info({ applied: result.applied }, 'migrations applied at boot');
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
    await db.close();
  }

  return { app, config: cfg, client, observer, audit, vendorStore, start, stop };
}

module.exports = { createApp };
