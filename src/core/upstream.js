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

/**
 * The credential a call should actually carry.
 *
 * An endpoint may override its upstream's — see 009_endpoint_secrets.sql for
 * why. The override is total, not a merge: if an endpoint says bearer, it
 * sends its own bearer token and nothing of the upstream's. A half-inherited
 * credential would be the worst of both, and impossible to reason about from
 * the console.
 */
function authFor(upstream, endpoint) {
  return (endpoint && endpoint.auth) || upstream.auth || { type: 'none' };
}

/** Headers we are willing to construct ourselves. Nothing else travels. */
function buildUpstreamHeaders(upstream, { requestId, hasBody, auth: override }) {
  const headers = {
    accept: 'application/json',
    'user-agent': 'api-gateway/1.0',
    // Lets your internal services correlate a call with the gateway audit log.
    'x-gateway-request-id': requestId,
  };
  if (hasBody) headers['content-type'] = 'application/json';

  const auth = override || upstream.auth || { type: 'none' };
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

  /**
   * Swap in a new set of upstreams without replacing the client.
   *
   * Breakers for upstreams that survive the change are KEPT: an upstream that
   * was failing a second ago is still failing, and resetting its breaker
   * because an unrelated endpoint was published would send a burst of traffic
   * at something known to be down.
   */
  replace(upstreams) {
    this.upstreams = upstreams;
    for (const id of [...this.breakers.keys()]) {
      if (!upstreams[id]) this.breakers.delete(id);
    }
    for (const [id, u] of Object.entries(upstreams)) {
      if (!this.breakers.has(id)) this.breakers.set(id, new Breaker(u.breaker));
    }
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

    // -------------------------------------------------------------------
    // Forced values. Set last so they win over anything above.
    //
    // Where they go depends on how the endpoint was configured.
    //
    //   typed     by the parameter's own location. A POST may carry a forced
    //             value in the query string, which is how ACL and most of the
    //             pre-JSON suppliers take their credentials.
    //   legacy    by method, as before — query on GET/DELETE, body otherwise.
    //
    // Both branches still read from `request.inject`, so there is one source
    // of forced values and no way for the two to disagree about what is being
    // sent; the typed list only decides placement.
    // -------------------------------------------------------------------
    const typedParams = endpoint.request.params || [];
    const headerInjections = {};

    if (typedParams.length) {
      for (const p of typedParams) {
        if (p.source === 'vendor' || p.location === 'path') continue;
        const name = p.forwardAs || p.name;
        const v = endpoint.request.inject[p.name];
        if (v === undefined) continue;
        if (p.location === 'query') url.searchParams.set(name, String(v));
        else if (p.location === 'header') headerInjections[name] = String(v);
      }
    } else {
      for (const [k, v] of Object.entries(endpoint.request.inject)) {
        if (endpoint.method === 'GET' || endpoint.method === 'DELETE') {
          url.searchParams.set(k, String(v));
        }
      }
    }

    // Vendor-supplied query parameters the supplier knows under another name.
    for (const p of typedParams) {
      if (p.source !== 'vendor' || p.location !== 'query' || !p.forwardAs) continue;
      const v = query[p.name];
      if (v === undefined) continue;
      url.searchParams.delete(p.name);
      url.searchParams.set(p.forwardAs, String(v));
    }

    // Our own credential as a query param, if that is the scheme. Set after
    // the vendor's allowlisted params and after the forced injections, so
    // neither can displace it.
    const auth = authFor(upstream, endpoint);
    if (auth.type === 'query') {
      url.searchParams.set(auth.name, auth.value);
    }

    // Allowlisted body fields plus forced injections.
    let payload;
    if (['POST', 'PUT', 'PATCH'].includes(endpoint.upstreamMethod)) {
      payload = {};
      for (const key of endpoint.request.body) {
        if (body && Object.prototype.hasOwnProperty.call(body, key)) payload[key] = body[key];
      }
      if (typedParams.length) {
        // Only the ones that asked to be in the body. A credential configured
        // as a query parameter must not also appear in the payload — that
        // would put it somewhere the supplier never looks and the logs might.
        for (const p of typedParams) {
          if (p.source === 'vendor' || p.location !== 'body') continue;
          const v = endpoint.request.inject[p.name];
          if (v !== undefined) payload[p.forwardAs || p.name] = v;
        }
      } else {
        Object.assign(payload, endpoint.request.inject);
      }
    }

    const headers = buildUpstreamHeaders(upstream, {
      requestId,
      hasBody: payload !== undefined,
      auth,
    });

    // Applied after, but the auth header is written back over anything that
    // collides: a parameter named Authorization must not be able to displace
    // our own credential.
    for (const [k, v] of Object.entries(headerInjections)) {
      if (k.toLowerCase() === 'authorization') continue;
      headers[k] = v;
    }

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

    // A supplier that never answers in JSON.
    //
    // Parsing here and throwing was a DOUBLE-SEND on any endpoint with a side
    // effect: the SMS went out, the body came back as `1701|9199…|OK`, the
    // parse failed, the error handler released the idempotency claim, the
    // consumer got a 502 and retried — and a second message was sent. The
    // call succeeded; only our reading of it failed.
    if (endpoint.response?.mode === 'text') {
      const failure = endpoint.response.failureMatch;
      // These suppliers answer 200 and put the outcome in the body. Without
      // this the gateway reports every send as a success and nobody finds out
      // until a customer complains.
      const failed = failure
        ? text.toLowerCase().includes(String(failure).toLowerCase())
        : false;
      return { status: res.status, body: null, text, textFailed: failed, durationMs };
    }

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

module.exports = { UpstreamClient, buildUpstreamPath, buildUpstreamHeaders, authFor };
