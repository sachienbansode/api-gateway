'use strict';

/**
 * Administrator-facing errors.
 *
 * Deliberately NOT src/core/errors.js. Vendor errors are opaque on purpose —
 * `unauthorized()` there always says "Missing or invalid API key" regardless of
 * the real cause, because an outside party should learn nothing from a failure.
 *
 * An administrator is your own staff behind the NSG. Telling them exactly what
 * went wrong — token expired, role lacks the grant, platform unreachable — is
 * the difference between a one-minute fix and an afternoon. The audience is
 * different, so the vocabulary is different.
 *
 * These still never leak a credential, a connection string or an upstream body.
 */

class AdminError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
    this.admin = true;
  }

  toBody(requestId) {
    return { error: { code: this.code, message: this.message, requestId } };
  }
}

const unauthorized = (message) =>
  new AdminError(401, 'admin_unauthorized', message || 'Administrator authentication required.');

const forbidden = (message) =>
  new AdminError(403, 'admin_forbidden', message || 'Your role does not permit this.');

const serviceUnavailable = (message) =>
  new AdminError(503, 'admin_unavailable', message || 'A dependency is unavailable.');

const badRequest = (message) => new AdminError(400, 'admin_bad_request', message);

const notFound = (message) => new AdminError(404, 'admin_not_found', message || 'Not found.');

module.exports = { AdminError, unauthorized, forbidden, serviceUnavailable, badRequest, notFound };
