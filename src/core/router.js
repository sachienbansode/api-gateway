'use strict';

const express = require('express');
const projection = require('./projection');
const errors = require('./errors');
const { makeScopeMiddleware } = require('../middleware/auth');
const { makeRateLimitMiddleware } = require('../middleware/rateLimit');
const { makeQuotaMiddleware } = require('../middleware/quota');
const { makeIdempotencyMiddleware } = require('../middleware/idempotency');

/**
 * Turn the endpoint manifest into Express routes.
 *
 * One route per declared endpoint. No catch-all, no wildcard, no
 * `app.use('/v1', proxy)`. If it is not in endpoints.yaml, the vendor gets a
 * 404 from the not-found handler and nothing touches an upstream.
 */

/** Reject unknown query params rather than silently dropping them. */
function makeQueryGuard(endpoint) {
  const allowed = new Set(endpoint.request.query);
  return function guardQuery(req, res, next) {
    const unknown = Object.keys(req.query).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      // Loud rejection beats silent dropping: a vendor who thinks
      // `?include_internal=true` worked will build on that assumption.
      return next(
        errors.badRequest(
          `Unsupported query parameter(s): ${unknown.sort().join(', ')}.`,
          'unknown query params'
        )
      );
    }
    return next();
  };
}

/** Same for the body on write endpoints. */
function makeBodyGuard(endpoint) {
  const allowed = new Set(endpoint.request.body);
  const injected = new Set(Object.keys(endpoint.request.inject));
  return function guardBody(req, res, next) {
    if (!['POST', 'PUT', 'PATCH'].includes(endpoint.method)) return next();

    const body = req.body;
    if (body === undefined || body === null) return next();
    if (typeof body !== 'object' || Array.isArray(body)) {
      return next(errors.badRequest('Request body must be a JSON object.', 'body not an object'));
    }

    const keys = Object.keys(body);
    const unknown = keys.filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      const smuggled = unknown.filter((k) => injected.has(k));
      if (smuggled.length > 0) {
        // Worth its own log line — this is someone probing, not a typo.
        req.log?.warn(
          { requestId: req.requestId, fields: smuggled },
          'vendor attempted to override an injected field'
        );
      }
      return next(
        errors.badRequest(
          `Unsupported body field(s): ${unknown.sort().join(', ')}.`,
          `unknown body fields: ${unknown.join(',')}`
        )
      );
    }
    return next();
  };
}

/**
 * Build the response transformer for an endpoint, once, at boot.
 * A malformed path therefore fails startup rather than a request.
 */
function compileResponseHandler(endpoint, logger) {
  const where = `endpoint "${endpoint.name}" response`;

  if (endpoint.response.mode === 'whitelist') {
    return projection.compile(endpoint.response.fields, endpoint.response.rename, where);
  }

  if (endpoint.response.mode === 'redact') {
    logger.warn(
      {
        endpoint: endpoint.name,
        excluded: endpoint.response.exclude.length,
      },
      'endpoint runs in REDACT mode — every field except the excluded ones reaches the ' +
        'vendor, including fields upstream adds in future. Convert to whitelist when you can.'
    );
    const redact = projection.compileRedact(endpoint.response.exclude, where);
    return (body) => redact(body);
  }

  logger.warn(
    { endpoint: endpoint.name },
    'endpoint runs in PASSTHROUGH mode — the upstream body is forwarded verbatim. ' +
      'Nothing is filtered.'
  );
  const pass = projection.compilePassthrough();
  return (body) => pass(body);
}

function buildRouter({ endpoints, client, logger, observer, audit }) {
  const router = express.Router();

  for (const endpoint of endpoints) {
    const project = compileResponseHandler(endpoint, logger);

    const tag = (req, res, next) => {
      req.endpointName = endpoint.name;
      req.endpointConfig = endpoint;
      req.log = logger;
      next();
    };

    // Async middleware need their rejections converted into next(err), or an
    // unhandled rejection kills the process instead of returning a 500.
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

    const handler = async (req, res, next) => {
      try {
        const { status, body, durationMs } = await client.call(endpoint, {
          params: req.params,
          query: req.query,
          body: req.body,
          requestId: req.requestId,
        });

        // Record which field paths the upstream actually produced, before
        // filtering. Names only, never values.
        if (endpoint.discover && observer) observer.observe(endpoint, body);

        // Apply the endpoint's response mode. In whitelist mode, anything the
        // whitelist does not name never exists in the object we serialise.
        const safe = project(body, (path, kind) => {
          logger.error(
            { requestId: req.requestId, endpoint: endpoint.name, path, kind },
            'whitelist path resolved to a non-leaf value and was dropped — ' +
              'name the sub-fields you want instead'
          );
        });

        const outStatus = status === 201 ? 201 : 200;
        const totalMs = req.startedAt
          ? Math.round(Number(process.hrtime.bigint() - req.startedAt) / 1e6)
          : null;

        logger.info(
          {
            requestId: req.requestId,
            vendor: req.vendor.id,
            endpoint: endpoint.name,
            method: req.method,
            status: outStatus,
            mode: endpoint.response.mode,
            upstream: endpoint.upstream,
            upstreamMs: durationMs,
            totalMs,
          },
          'ok'
        );

        // Durable audit row. Queued, never awaited — see AuditWriter.
        audit?.record({
          requestId: req.requestId,
          vendorId: req.vendor.id,
          endpoint: endpoint.name,
          method: req.method,
          path: req.originalUrl?.split('?')[0],
          status: outStatus,
          upstream: endpoint.upstream,
          upstreamStatus: status,
          upstreamMs: durationMs,
          totalMs,
          responseMode: endpoint.response.mode,
          clientIp: req.ip,
        });

        res.status(outStatus).json(safe);
      } catch (err) {
        next(err);
      }
    };

    // Order is deliberate:
    //   scope      cheapest rejection first, and no point metering a call the
    //              vendor is not allowed to make at all
    //   rateLimit  protects infrastructure; burns burst allowance, not quota
    //   quota      commercial cap, after the technical one
    //   guards     reject malformed input before claiming an idempotency key
    //   idempotency last, so a claim is only taken for a request we will act on
    const method = endpoint.method.toLowerCase();
    router[method](
      endpoint.path,
      tag,
      makeScopeMiddleware(endpoint, logger),
      makeRateLimitMiddleware(endpoint, logger),
      wrap(makeQuotaMiddleware(endpoint, logger)),
      makeQueryGuard(endpoint),
      makeBodyGuard(endpoint),
      wrap(makeIdempotencyMiddleware(endpoint, logger)),
      wrap(handler)
    );

    logger.info(
      {
        endpoint: endpoint.name,
        route: `${endpoint.method} ${endpoint.path}`,
        upstream: endpoint.upstream,
        scopes: endpoint.scopes,
        mode: endpoint.response.mode,
        exposedFields:
          endpoint.response.mode === 'whitelist' ? endpoint.response.fields.length : 'all',
        excludedFields: endpoint.response.mode === 'redact' ? endpoint.response.exclude.length : 0,
        idempotency: endpoint.idempotency,
      },
      'route registered'
    );
  }

  return router;
}

module.exports = { buildRouter, makeQueryGuard, makeBodyGuard };
