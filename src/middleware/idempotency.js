'use strict';

const repo = require('../db/repos/idempotency');
const errors = require('../core/errors');

/**
 * Idempotency middleware for write endpoints.
 *
 * Applied only to POST/PUT/PATCH. GETs are already idempotent and DELETEs are
 * usually idempotent at the upstream.
 *
 * Whether the header is REQUIRED is per-endpoint config (`idempotency: required
 * | optional | off`). Required is the right default for anything that creates a
 * resource or moves money: making it optional means a vendor who has not
 * implemented it gets silent duplicates, and they will not find out until it
 * matters.
 *
 * Implementation note on the replay path: we hook res.json rather than wrapping
 * the handler, so the stored body is exactly what the vendor received after
 * response-mode filtering — not the upstream body. Replaying an unfiltered body
 * would leak fields the whitelist had removed on the original call.
 */

function makeIdempotencyMiddleware(endpoint, logger) {
  const mode = endpoint.idempotency;

  return async function idempotency(req, res, next) {
    if (mode === 'off' || !['POST', 'PUT', 'PATCH'].includes(endpoint.method)) {
      return next();
    }

    const key = (req.get('idempotency-key') || '').trim();

    if (!key) {
      if (mode === 'required') {
        return next(
          errors.badRequest(
            'This endpoint requires an Idempotency-Key header. Send a unique value ' +
              'per logical operation and reuse it when retrying, so a retry cannot ' +
              'create a duplicate.',
            'missing idempotency key'
          )
        );
      }
      return next();
    }

    if (key.length > 255) {
      return next(
        errors.badRequest('Idempotency-Key must be 255 characters or fewer.', 'key too long')
      );
    }

    const requestHash = repo.hashRequest({
      method: req.method,
      path: req.route?.path || req.path,
      query: req.query,
      body: req.body,
    });

    let claim;
    try {
      claim = await repo.claim({
        vendorId: req.vendor.id,
        key,
        endpoint: endpoint.name,
        requestHash,
      });
    } catch (err) {
      // A failure here is genuinely ambiguous: we cannot tell whether this is a
      // first attempt or a retry. Failing closed is the only safe choice — the
      // alternative risks the duplicate write this whole mechanism exists to
      // prevent.
      logger.error(
        { requestId: req.requestId, endpoint: endpoint.name, err: err.message },
        'idempotency claim failed — rejecting rather than risking a duplicate write'
      );
      return next(
        errors.upstreamUnavailable(`idempotency store unavailable: ${err.message}`)
      );
    }

    if (claim.outcome === repo.OUTCOME.MISMATCH) {
      logger.warn(
        { requestId: req.requestId, vendor: req.vendor.id, endpoint: endpoint.name },
        'idempotency key reused with a different request body'
      );
      return next(
        Object.assign(
          new errors.ApiError(
            422,
            'idempotency_key_reused',
            'This Idempotency-Key was already used for a request with different ' +
              'parameters. Use a new key for a new operation.'
          ),
          { internalReason: 'request hash mismatch' }
        )
      );
    }

    if (claim.outcome === repo.OUTCOME.IN_PROGRESS) {
      res.set('Retry-After', '2');
      return next(
        Object.assign(
          new errors.ApiError(
            409,
            'request_in_progress',
            'A request with this Idempotency-Key is still being processed. Retry shortly.'
          ),
          { internalReason: 'concurrent request with same idempotency key' }
        )
      );
    }

    if (claim.outcome === repo.OUTCOME.REPLAY) {
      logger.info(
        {
          requestId: req.requestId,
          vendor: req.vendor.id,
          endpoint: endpoint.name,
          replayedStatus: claim.status,
        },
        'idempotent replay — upstream was not called'
      );
      res.set('Idempotency-Replayed', 'true');
      return res.status(claim.status || 200).json(claim.body);
    }

    // We hold the claim. Capture the filtered response on its way out.
    if (claim.persisted) {
      req.idempotency = { key, endpoint: endpoint.name };

      const originalJson = res.json.bind(res);
      res.json = (body) => {
        const status = res.statusCode;
        // Only successful responses are worth replaying. Storing a 4xx would
        // mean a vendor who fixed their request but kept the key gets the old
        // error back forever.
        if (status >= 200 && status < 300) {
          repo
            .complete({
              vendorId: req.vendor.id,
              key,
              endpoint: endpoint.name,
              status,
              body,
            })
            .catch((err) =>
              logger.error(
                { requestId: req.requestId, err: err.message },
                'could not store idempotent response — a retry will re-execute'
              )
            );
        }
        return originalJson(body);
      };
    }

    return next();
  };
}

/**
 * Release the claim when a request fails in a way that is safe to retry.
 *
 * "Safe" means we are confident the upstream did NOT apply the write: we were
 * rate limited, the request was rejected as invalid, or the circuit breaker
 * short-circuited before any call went out. A timeout is explicitly NOT safe —
 * the upstream may have processed it — so those claims are left to expire.
 */
async function releaseOnFailure(req, apiErr, logger) {
  if (!req.idempotency || !req.vendor) return;

  const safeToRetry =
    apiErr.status === 400 ||
    apiErr.status === 422 ||
    apiErr.status === 429 ||
    apiErr.code === 'service_unavailable';

  if (!safeToRetry) return;

  await repo
    .release({
      vendorId: req.vendor.id,
      key: req.idempotency.key,
      endpoint: req.idempotency.endpoint,
    })
    .catch((err) =>
      logger?.warn({ err: err.message }, 'could not release idempotency claim')
    );
}

module.exports = { makeIdempotencyMiddleware, releaseOnFailure };
