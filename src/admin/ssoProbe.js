'use strict';

const sso = require('../db/repos/sso');

/**
 * Find out what the portal actually does, from the VM that has to talk to it.
 *
 * The SSO credentials arrived as a list of URLs in an email: no discovery
 * document, no client secret, no statement of whether it is OIDC or something
 * shaped like it, and no example of what `/profile` returns. Neither this
 * container nor a developer laptop can reach that host — it is internal — so
 * the only machine that can answer these questions is the gateway itself.
 *
 * Hence a probe rather than a guess. It reports what came back so the
 * remaining decisions are made from evidence: whether a secret or PKCE is
 * wanted, and which field in the profile response holds the role.
 *
 * NAMES ONLY, NEVER VALUES. The shape report walks the JSON and records the
 * keys and the TYPE of each leaf. A profile response contains somebody's email
 * and may contain far more; writing that into test_detail would put personal
 * data in the settings table and on the screen, to answer a question that only
 * needs the field names.
 */

const TIMEOUT_MS = Number(process.env.SSO_PROBE_TIMEOUT_MS) || 8000;

/** Keys and leaf types, to a sane depth. Never a value. */
function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return depth >= 4 ? 'array' : [value.length ? shapeOf(value[0], depth + 1) : 'empty'];
  }
  if (typeof value === 'object') {
    if (depth >= 4) return 'object';
    const out = {};
    for (const k of Object.keys(value).slice(0, 40)) out[k] = shapeOf(value[k], depth + 1);
    return out;
  }
  return typeof value;
}

async function fetchJson(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      ...opts,
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': 'pravah-gateway/1.0', ...(opts.headers || {}) },
    });
    const text = (await res.text()).slice(0, 4000);
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON, which is itself a finding */ }
    return {
      status: res.status,
      ms: Date.now() - started,
      contentType: res.headers.get('content-type') || '',
      location: res.headers.get('location') || null,
      wwwAuthenticate: res.headers.get('www-authenticate') || null,
      json: body !== null,
      shape: body === null ? null : shapeOf(body),
      // Only when it is NOT JSON, and only the first line — an HTML error page
      // tells you it is a reverse proxy talking, not the portal.
      snippet: body === null ? text.split('\n')[0].slice(0, 180) : null,
    };
  } catch (err) {
    return {
      error: err.name === 'AbortError'
        ? `no answer within ${TIMEOUT_MS} ms`
        : (err.cause?.code || err.message),
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe every endpoint and say what it means.
 *
 * Unauthenticated calls, deliberately: a 401 with a WWW-Authenticate header
 * from /userinfo is a GOOD result — it proves the endpoint exists, is reachable
 * from this VM and challenges properly. An HTML page or a 404 means something
 * else is answering, which is the thing worth knowing before anybody debugs a
 * redirect loop.
 */
async function probe(settings) {
  const s = settings || (await sso.status());
  if (!s || !s.base_url) throw new Error('Set the portal URL first.');

  const ep = sso.endpoints(s.base_url);
  const notes = [];
  const insecure = !/^https:/i.test(s.base_url);
  if (insecure) {
    notes.push(
      'This portal is plain HTTP. The authorization code and the access token ' +
      'cross the network in clear, and anyone who can read that traffic can ' +
      'become an administrator of this gateway. Acceptable on an internal ' +
      'staging network; it must not reach production.'
    );
  }

  const [authorize, token, userinfo, profile, introspect, discovery] = await Promise.all([
    // HEAD-like: we only want to know it answers and whether it redirects.
    fetchJson(`${ep.authorize}?client_id=${encodeURIComponent(s.client_id || '')}` +
      `&redirect_uri=${encodeURIComponent(s.redirect_uri || '')}&state=probe&response_type=code`),
    fetchJson(ep.token, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=probe' }),
    fetchJson(ep.userinfo),
    fetchJson(ep.profile),
    fetchJson(ep.introspect, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=probe' }),
    fetchJson(`${String(s.base_url).replace(/\/+$/, '')}/.well-known/openid-configuration`),
  ]);

  const reached = [authorize, token, userinfo, profile, introspect]
    .filter((r) => !r.error).length;

  if (!reached) {
    notes.push(
      'Nothing answered. From this VM the portal is unreachable — check the ' +
      'hostname resolves here, and that any network rule between this VM and ' +
      'the portal allows it.'
    );
  }

  if (discovery.json) {
    notes.push('The portal publishes an OpenID discovery document, so it is standard OIDC.');
  }

  // The two questions that actually gate the build.
  if (token.json && token.shape && typeof token.shape === 'object') {
    const keys = Object.keys(token.shape);
    if (keys.includes('error')) {
      notes.push(
        `The token endpoint answered ${token.status} with an \`error\` field, which is ` +
        'the standard OAuth2 shape — the exchange will work once a real code is sent.'
      );
    }
  }
  if (userinfo.wwwAuthenticate) {
    notes.push(
      `/userinfo challenges with: ${userinfo.wwwAuthenticate} — it expects a bearer token, ` +
      'as expected.'
    );
  }
  if (profile.json && profile.shape && typeof profile.shape === 'object') {
    const keys = Object.keys(profile.shape);
    const roleish = keys.filter((k) => /role|permission|page|access|group/i.test(k));
    if (roleish.length) {
      notes.push(`/profile returned field(s) that look like a role: ${roleish.join(', ')}.`);
    }
  }

  const ok = reached > 0;
  const detail = {
    at: new Date().toISOString(),
    baseUrl: s.base_url,
    insecure,
    endpoints: { authorize, token, userinfo, profile, introspect },
    discovery: discovery.json ? discovery.shape : { reached: !discovery.error, status: discovery.status },
    notes,
  };
  return { ok, detail, notes };
}

module.exports = { probe, shapeOf };
