'use strict';

// Load .env without a dependency. Keeps the install surface tiny, which matters
// for something sitting on your network edge.
require('./util/dotenv').load();

const logger = require('./util/logger');
const { createApp } = require('./app');
const { ConfigError } = require('./core/config');

let server;
let built;

async function start() {
  try {
    built = createApp({ logger });
  } catch (err) {
    if (err instanceof ConfigError || err?.message?.includes('field whitelist')) {
      // Configuration problems get a clean message, not a stack trace. The
      // operator needs to know which line of YAML to fix.
      logger.error({ err: err.message }, 'configuration is invalid — refusing to start');
      process.exit(1);
    }
    throw err;
  }

  const { app, config, start: startDeps, stop: stopDeps } = built;

  // Bring up the database, vendor cache and audit writer BEFORE accepting
  // traffic. Listening first would mean serving requests with an empty vendor
  // cache, which rejects every legitimate key.
  try {
    await startDeps();
  } catch (err) {
    logger.error(
      { err: err.message },
      'could not initialise the database or vendor store — refusing to start. ' +
        'Check DATABASE_URL, the Azure firewall rule for this VM, and that migrations have run.'
    );
    process.exit(1);
  }

  const port = Number(process.env.PORT) || 8080;
  const host = process.env.BIND_HOST || '127.0.0.1';

  server = app.listen(port, host, () => {
    logger.info(
      {
        host,
        port,
        endpoints: config.endpoints.length,
        whitelisted: config.endpoints.filter((e) => e.response.mode === 'whitelist').length,
        redacted: config.endpoints.filter((e) => e.response.mode === 'redact').length,
        passthrough: config.endpoints.filter((e) => e.response.mode === 'passthrough').length,
        vendorStore: built.vendorStore.snapshot(),
        upstreams: Object.keys(config.upstreams),
      },
      'vendor-api-wrapper listening'
    );
  });

  // Generous but finite. Prevents a vendor holding sockets open indefinitely.
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 15000;

  const GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 5000;

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // Stop accepting new connections, then flush queued audit rows and close
    // the pool. Order matters: flush before closing the pool, pool before exit.
    server.close(async () => {
      try {
        await stopDeps();
      } catch (err) {
        logger.warn({ err: err.message }, 'error during shutdown');
      }
      logger.info('shutdown complete');
      process.exit(0);
    });

    // `server.close()` stops new connections but does NOT drop idle keep-alive
    // sockets, and its callback does not fire until every connection is gone.
    // Without this, one idle vendor connection holds the process open until the
    // hard timeout below and every deploy takes the full grace period.
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }

    // Give in-flight requests a moment to finish, then take the rest.
    setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') {
        logger.warn({ graceMs: GRACE_MS }, 'grace period over — closing remaining connections');
        server.closeAllConnections();
      }
    }, GRACE_MS).unref();

    // Last resort, so a wedged flush can never block a deploy forever.
    setTimeout(() => {
      logger.error('shutdown timed out — exiting without a clean flush');
      process.exit(1);
    }, GRACE_MS + 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err: err?.stack }, 'uncaught exception — exiting so systemd restarts us');
    process.exit(1);
  });

  return { server, built };
}

if (require.main === module) {
  start().catch((err) => {
    logger.error({ err: err?.stack || err?.message }, 'failed to start');
    process.exit(1);
  });
}

module.exports = { start };
