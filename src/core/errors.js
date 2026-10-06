'use strict';

/**
 * Vendor-facing errors.
 *
 * Every error the vendor receives is constructed here, from a fixed
 * vocabulary. Upstream error bodies are NEVER forwarded, because they routinely
 * contain internal hostnames, SQL, file paths, stack traces and service names —
 * a free internal-architecture diagram for anyone who can trigger a 500.
 *
 * The vendor gets a stable code, a neutral message, and a requestId. The real
 * cause is written to the audit log against that same requestId, so your team
 * can diagnose it from the id the vendor quotes.
 */

class ApiError extends Error {
  constructor(status, code, message, meta = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.meta = meta;
    this.expose = true;
  }

  toBody(requestId) {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        ...(this.meta.retryAfter ? { retryAfter: this.meta.retryAfter } : {}),
      },
    };
  }
}

const unauthorized = (reason) =>
  Object.assign(
    new ApiError(401, 'unauthorized', 'Missing or invalid API key.'),
    { internalReason: reason }
  );

const forbidden = (reason) =>
  Object.assign(
    new ApiError(403, 'forbidden', 'This API key is not permitted to use this endpoint.'),
    { internalReason: reason }
  );

const notFound = () => new ApiError(404, 'not_found', 'No such endpoint.');

const badRequest = (message, reason) =>
  Object.assign(new ApiError(400, 'bad_request', message), { internalReason: reason });

const rateLimited = (retryAfter, reason) =>
  Object.assign(
    new ApiError(429, 'rate_limited', 'Rate limit exceeded. Slow down and retry.', {
      retryAfter,
    }),
    { internalReason: reason }
  );

const upstreamTimeout = (reason) =>
  Object.assign(
    new ApiError(504, 'upstream_timeout', 'The request could not be completed in time.'),
    { internalReason: reason }
  );

const upstreamUnavailable = (reason) =>
  Object.assign(
    new ApiError(503, 'service_unavailable', 'Temporarily unable to service this request.'),
    { internalReason: reason }
  );

const upstreamError = (reason) =>
  Object.assign(
    new ApiError(502, 'upstream_error', 'The request could not be completed.'),
    { internalReason: reason }
  );

const internal = (reason) =>
  Object.assign(
    new ApiError(500, 'internal_error', 'An unexpected error occurred.'),
    { internalReason: reason }
  );

/**
 * Map an upstream HTTP status onto something safe to tell the vendor.
 *
 * Note what is NOT passed through: upstream 401/403 become a generic 502.
 * If our credential to the upstream has expired that is our operational
 * problem, and telling the vendor "unauthorized" would have them retrying with
 * their own key forever, and would reveal that a second auth layer exists.
 */
function fromUpstreamStatus(status, bodyText) {
  const reason = `upstream responded ${status}: ${String(bodyText || '').slice(0, 500)}`;

  if (status === 404) return Object.assign(new ApiError(404, 'not_found', 'Resource not found.'), { internalReason: reason });
  if (status === 400 || status === 422) {
    return Object.assign(
      new ApiError(400, 'bad_request', 'The request was rejected as invalid.'),
      { internalReason: reason }
    );
  }
  if (status === 409) {
    return Object.assign(
      new ApiError(409, 'conflict', 'The request conflicts with the current state.'),
      { internalReason: reason }
    );
  }
  if (status === 429) return rateLimited(5, reason);
  if (status === 401 || status === 403) return upstreamError(reason);
  if (status >= 500) return upstreamUnavailable(reason);
  return upstreamError(reason);
}

module.exports = {
  ApiError,
  unauthorized,
  forbidden,
  notFound,
  badRequest,
  rateLimited,
  upstreamTimeout,
  upstreamUnavailable,
  upstreamError,
  internal,
  fromUpstreamStatus,
};
