'use strict';

const errors = require('../core/errors');

/**
 * Sliding-window rate limiter, keyed per vendor and per (vendor, endpoint).
 *
 * In-process and therefore per-instance: if you scale to several instances
 * behind a load balancer, each enforces its own share. That is fine for one or
 * two instances (set the limit to your_total / instance_count) but if you scale
 * out properly, move the counters to Redis. The interface below is deliberately
 * narrow so that swap is a single file change.
 *
 * A sliding window rather than a fixed one, because a fixed window lets a vendor
 * send 2x the limit across a window boundary — which is exactly when you get
 * paged.
 */

class SlidingWindow {
  constructor({ sweepEveryMs = 60000 } = {}) {
    this.buckets = new Map();
    this.timer = setInterval(() => this.sweep(), sweepEveryMs);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * @returns {{allowed:boolean, remaining:number, retryAfter:number, limit:number}}
   */
  hit(key, windowMs, max, now = Date.now()) {
    const cutoff = now - windowMs;
    let times = this.buckets.get(key);
    if (!times) {
      times = [];
      this.buckets.set(key, times);
    }

    // Drop timestamps that have aged out of the window.
    while (times.length && times[0] <= cutoff) times.shift();

    if (times.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((times[0] + windowMs - now) / 1000));
      return { allowed: false, remaining: 0, retryAfter, limit: max };
    }

    times.push(now);
    return { allowed: true, remaining: max - times.length, retryAfter: 0, limit: max };
  }

  sweep() {
    const now = Date.now();
    for (const [key, times] of this.buckets) {
      // Anything untouched for an hour cannot matter to any live window.
      if (times.length === 0 || now - times[times.length - 1] > 3600000) {
        this.buckets.delete(key);
      }
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

const store = new SlidingWindow();

/**
 * Per-endpoint limit, then the vendor's global ceiling. Both must pass.
 * The global ceiling is what stops a vendor from multiplying their allowance by
 * spraying across every endpoint they have access to.
 */
function makeRateLimitMiddleware(endpoint, logger) {
  return function rateLimit(req, res, next) {
    const vendor = req.vendor;

    const perEndpoint = store.hit(
      `e:${vendor.id}:${endpoint.name}`,
      endpoint.rateLimit.windowMs,
      endpoint.rateLimit.max
    );

    const global = perEndpoint.allowed
      ? store.hit(`v:${vendor.id}`, vendor.rateLimit.windowMs, vendor.rateLimit.max)
      : null;

    const decision = !perEndpoint.allowed ? perEndpoint : global;
    const scope = !perEndpoint.allowed ? 'endpoint' : 'vendor';

    res.set('X-RateLimit-Limit', String(decision.limit));
    res.set('X-RateLimit-Remaining', String(decision.remaining));

    if (!decision.allowed) {
      res.set('Retry-After', String(decision.retryAfter));
      logger.warn(
        {
          requestId: req.requestId,
          vendor: vendor.id,
          endpoint: endpoint.name,
          scope,
          limit: decision.limit,
        },
        'rate limit exceeded'
      );
      return next(errors.rateLimited(decision.retryAfter, `${scope} limit exceeded`));
    }

    return next();
  };
}

module.exports = { makeRateLimitMiddleware, SlidingWindow, store };
