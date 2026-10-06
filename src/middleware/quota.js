'use strict';

const repo = require('../db/repos/quota');
const errors = require('../core/errors');

/**
 * Monthly quota enforcement.
 *
 * Runs after the rate limiter, so a vendor hammering the endpoint burns their
 * burst allowance rather than their monthly quota. That ordering matters
 * commercially: a retry storm should be rejected as a rate limit, not silently
 * consume the allowance they are paying for.
 *
 * Usage headers are sent on every response so the vendor can see where they
 * stand without asking you.
 */
function makeQuotaMiddleware(endpoint, logger) {
  return async function quota(req, res, next) {
    const limit = req.vendor.monthlyQuota;

    // No quota configured for this vendor: nothing to enforce or report.
    if (limit === null || limit === undefined) return next();

    const result = await repo.consume({
      vendorId: req.vendor.id,
      endpoint: endpoint.name,
      limit,
      logger,
    });

    if (result.tracked) {
      res.set('X-Quota-Limit', String(result.limit));
      res.set('X-Quota-Used', String(result.used));
      res.set('X-Quota-Remaining', String(Math.max(0, result.limit - result.used)));
      res.set('X-Quota-Period', result.period);
    }

    if (!result.allowed) {
      logger.warn(
        {
          requestId: req.requestId,
          vendor: req.vendor.id,
          endpoint: endpoint.name,
          used: result.used,
          limit: result.limit,
          period: result.period,
        },
        'monthly quota exceeded'
      );

      // Seconds until the first of next month, so the vendor knows when their
      // allowance resets rather than retrying blindly.
      const now = new Date();
      const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
      const retryAfter = Math.max(1, Math.ceil((nextMonth - now.getTime()) / 1000));
      res.set('Retry-After', String(retryAfter));

      return next(
        Object.assign(
          new errors.ApiError(
            429,
            'quota_exceeded',
            `Monthly call quota of ${result.limit} has been reached. It resets at the ` +
              `start of next month.`,
            { retryAfter }
          ),
          { internalReason: `quota ${result.used}/${result.limit} for ${result.period}` }
        )
      );
    }

    return next();
  };
}

module.exports = { makeQuotaMiddleware };
