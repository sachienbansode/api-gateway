'use strict';

const { ApiError } = require('../core/errors');
const errors = require('../core/errors');
const { releaseOnFailure } = require('./idempotency');

/**
 * The single exit point for every failure.
 *
 * Any error that is not an ApiError is treated as a bug and becomes a generic
 * 500. That default matters: it means a future code change that throws an
 * unexpected error cannot accidentally leak a stack trace or an internal
 * message to the vendor. To show the vendor something specific, you must
 * deliberately construct an ApiError.
 *
 * It also does two things that have to happen on every failure path, which is
 * why they live here rather than being sprinkled through the handlers:
 *   - writes the audit row, so failures are as well recorded as successes
 *   - releases an idempotency claim when the failure is safe to retry
 */
module.exports = function makeErrorHandler(logger, audit) {
  // eslint-disable-next-line no-unused-vars
  return function errorHandler(err, req, res, next) {
    const apiErr = err instanceof ApiError ? err : errors.internal(err?.message || 'unknown');

    const durationMs = req.startedAt
      ? Math.round(Number(process.hrtime.bigint() - req.startedAt) / 1e6)
      : undefined;

    logger[apiErr.status >= 500 ? 'error' : 'warn'](
      {
        requestId: req.requestId,
        vendor: req.vendor?.id,
        endpoint: req.endpointName,
        method: req.method,
        path: req.originalUrl?.split('?')[0],
        status: apiErr.status,
        code: apiErr.code,
        // The real cause lives here, in YOUR log, never in the response.
        reason: apiErr.internalReason,
        stack: apiErr.status >= 500 && !(err instanceof ApiError) ? err?.stack : undefined,
        durationMs,
      },
      'request failed'
    );

    audit?.record({
      requestId: req.requestId,
      vendorId: req.vendor?.id,
      endpoint: req.endpointName,
      method: req.method,
      path: req.originalUrl?.split('?')[0],
      status: apiErr.status,
      errorCode: apiErr.code,
      upstream: req.endpointConfig?.upstream,
      totalMs: durationMs,
      responseMode: req.endpointConfig?.response?.mode,
      clientIp: req.ip,
      internalReason: apiErr.internalReason,
    });

    // Fire and forget: the vendor's response must not wait on this, and a
    // failure to release only means they wait out the lease.
    releaseOnFailure(req, apiErr, logger).catch(() => {});

    if (res.headersSent) return;
    res.status(apiErr.status).json(apiErr.toBody(req.requestId));
  };
};
