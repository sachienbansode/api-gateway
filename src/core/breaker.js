'use strict';

/**
 * Per-upstream circuit breaker.
 *
 * Why this matters more than usual here: the vendor is an outside party whose
 * retry behaviour you do not control. Without a breaker, a vendor hammering a
 * slow endpoint holds open hundreds of sockets against your internal API and
 * takes down the service for your own users too. The breaker converts an
 * upstream outage into a fast local 503 instead of a queue of stalled requests.
 *
 * States: closed -> (failureThreshold consecutive failures) -> open
 *         open -> (after resetMs) -> half_open
 *         half_open -> success -> closed | failure -> open
 */

class Breaker {
  constructor({ failureThreshold = 5, resetMs = 30000, now = () => Date.now() } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetMs = resetMs;
    this.now = now;
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.halfOpenInFlight = false;
  }

  /** Returns true if a request may proceed. */
  allow() {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      if (this.now() - this.openedAt >= this.resetMs) {
        this.state = 'half_open';
        this.halfOpenInFlight = false;
      } else {
        return false;
      }
    }

    if (this.state === 'half_open') {
      // Let exactly one probe through, so a recovering upstream is not
      // immediately flooded by everything that queued up while we were open.
      if (this.halfOpenInFlight) return false;
      this.halfOpenInFlight = true;
      return true;
    }

    return true;
  }

  onSuccess() {
    this.failures = 0;
    this.state = 'closed';
    this.halfOpenInFlight = false;
  }

  onFailure() {
    if (this.state === 'half_open') {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  trip() {
    this.state = 'open';
    this.openedAt = this.now();
    this.halfOpenInFlight = false;
  }

  /** Seconds until the breaker will next admit a probe. */
  retryAfterSeconds() {
    if (this.state !== 'open') return 1;
    const remaining = this.resetMs - (this.now() - this.openedAt);
    return Math.max(1, Math.ceil(remaining / 1000));
  }

  snapshot() {
    return { state: this.state, failures: this.failures };
  }
}

module.exports = { Breaker };
