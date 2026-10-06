'use strict';

const { Breaker } = require('./breaker');
const errors = require('./errors');

/**
 * Upstream caller.
 *
 * Responsibilities, in order of importance:
 *   1. Inject OUR credential server-side. The vendor's request never carries it
 *      and never sees it.
 *   2. Send only allowlisted query params and body fields, plus forced
 *      injections the vendor cannot override.
 *   3. Never forward a vendor-supplied header upstream. Vendors have been known
 *      to send an Authorization header, an X-Forwarded-Host, or an
 *      X-Original-URL that an upstream framework will happily act on.
 *   4. Enforce a hard timeout and a circuit breaker.
 */

/** Headers we are willing to construct ourselves. Nothing else travels. */
function buildUpstreamHeaders(upstream, { requestId, hasBody }) {
  const headers = {
    accept: 'application/json',
    'user-agent': 'vendor-api-wrapper/1.0',
    // Lets your internal services correlate a call with the gateway audit log.
    'x-gateway-request-id': requestId,
  };
  if (hasBody) headers['content-type'] = 'application/json';

  const auth = upstream.auth || { type: 'none' };
  switch (auth.type) {
    case 'bearer':
      headers.authorization = `Bearer ${auth.token}`;
      break;
    case 'header':
      headers[String(auth.name).toLowerCase()] = auth.value;
      break;
    case 'basic':
      headers.authorization =
        'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      break;
    case 'query':
    case 'none':
    default:
      break;
  }
  return headers;
}

/**
 * Substitute :params into an upstream path.
 * Values are URI-encoded, which is what stops a path parameter of
 * "../../admin/users" from walking out of the intended route.
 */
function buildUpstreamPath(template, params) {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    const v = params[name];
    if (v === undefined || v === null || v === '') {
      throw errors.badRequest(`Missing path parameter "${name}".`, 'path param absent');
    }
    return encodeURIComponent(String(v));
  });
}

class UpstreamClient {
  constructor(upstreams, logger) {
    this.upstreams = upstreams;
    this.logger = logger;
    this.breakers = new Map();
    for (const [id, u] of Object.entries(upstreams)) {
      this.breakers.set(id, new Breaker(u.breaker));
    }
  }

  breakerFor(id) {
    return this.breakers.get(id);
  }

  health() {
    const out = {};
    for (const [id, b] of this.breakers) out[id] = b.snapshot();
    return out;
  }

  /**
   * @returns {Promise<{status:number, body:any}>}
   * @throws  {ApiError} already safe to show a vendor
   */
  async call(endpoint, { params, query, body, requestId }) {
    const upstream = this.upstreams[endpoint.upstream];
    const breaker = this.breakers.get(endpoint.upstream);

    if (!breaker.allow()) {
      throw errors.upstreamUnavailable(
        `breaker open for upstream "${endpoint.upstream}"`
      );
    }

    const url = new URL(upstream.baseUrl + buildUpstreamPath(endpoint.upstreamPath, params));

    // Allowlisted query params from the vendor.
    for (const key of endpoint.request.query) {
      const v = query[key];
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(key, String(x)));
      else url.searchParams.set(key, String(v));
    }

    // Forced values. Set last so they win over anything above.
    for (const [k, v] of Object.entries(endpoint.request.inject)) {
      if (endpoint.method === 'GET' || endpoint.method === 'DELETE') {
        url.searchParams.set(k, String(v));
      }
    }

    // Upstream's own credential as a query param, if that is its scheme.
    if (upstream.auth?.type === 'query') {
      url.searchParams.set(upstream.auth.name, upstream.auth.value);
    }

    // Allowlisted body fields plus forced injections.
    let payload;
    if (['POST', 'PUT', 'PATCH'].includes(endpoint.upstreamMethod)) {
      payload = {};
      for (const key of endpoint.request.body) {
        if (body && Object.prototype.hasOwnProperty.call(body, key)) payload[key] = body[key];
      }
      Object.assign(payload, endpoint.request.inject);
    }

    const headers = buildUpstreamHeaders(upstream, {
      requestId,
      hasBody: payload !== undefined,
    });

    const started = Date.now();
    let res;
    try {
      res = await fetch(url, {
        method: endpoint.upstreamMethod,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(upstream.timeoutMs),
        redirect: 'manual', // never chase an upstream redirect; it can leave the allowlist
      });
    } catch (err) {
      breaker.onFailure();
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      this.logger.warn(
        {
          requestId,
          upstream: endpoint.upstream,
          endpoint: endpoint.name,
          durationMs: Date.now() - started,
          err: err?.message,
        },
        timedOut ? 'upstream timeout' : 'upstream transport error'
      );
      throw timedOut
        ? errors.upstreamTimeout(`timeout after ${upstream.timeoutMs}ms`)
        : errors.upstreamUnavailable(`transport error: ${err?.message}`);
    }

    const durationMs = Date.now() - started;

    if (res.status >= 300 && res.status < 400) {
      breaker.onFailure();
      throw errors.upstreamError(`upstream returned redirect ${res.status}`);
    }

    if (!res.ok) {
      // 4xx is the caller's fault, not an upstream health signal — only count
      // 5xx toward tripping the breaker, or a vendor sending bad input could
      // knock the endpoint offline for everyone.
      if (res.status >= 500) breaker.onFailure();
      else breaker.onSuccess();

      const text = await res.text().catch(() => '');
      this.logger.warn(
        {
          requestId,
          upstream: endpoint.upstream,
          endpoint: endpoint.name,
          upstreamStatus: res.status,
          durationMs,
        },
        'upstream error status'
      );
      throw errors.fromUpstreamStatus(res.status, text);
    }

    breaker.onSuccess();

    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        this.logger.error(
          { requestId, upstream: endpoint.upstream, endpoint: endpoint.name },
          'upstream returned non-JSON body'
        );
        throw errors.upstreamError('upstream body was not valid JSON');
      }
    }

    return { status: res.status, body: parsed, durationMs };
  }
}

module.exports = { UpstreamClient, buildUpstreamPath, buildUpstreamHeaders };
