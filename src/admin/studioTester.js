'use strict';

const projection = require('../core/projection');

/**
 * The "Test" buttons behind steps 1 and 4.
 *
 * Step 1 asks: does the supplier answer us, with what, and how fast.
 * Step 4 asks: given that answer, what exactly would a vendor receive.
 *
 * Both run here, on the server, for the same reason the gateway exists: the
 * supplier's credential must never reach a browser. The admin's browser sends
 * a path and gets back a result; the token stays in this process.
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB — plenty for a sample, bounded for safety

/** Resolve "${VAR}" against the process environment. */
function resolveRef(ref) {
  if (!ref) return { value: null, varName: null, set: false };
  const m = /^\$\{([A-Z0-9_]+)\}$/.exec(String(ref).trim());
  if (!m) {
    // Not a reference. The schema forbids this, but a hand-edited row could
    // still get here, and silently sending it as a token would be worse.
    return { value: null, varName: null, set: false, invalid: true };
  }
  const varName = m[1];
  const value = process.env[varName];
  return { value: value || null, varName, set: Boolean(value) };
}

function authFor(up) {
  const type = up.auth_type || up.authType || 'none';
  const main = resolveRef(up.auth_value_env || up.authValueEnv);
  const user = resolveRef(up.auth_user_env || up.authUserEnv);
  const headers = {};
  const query = {};
  const missing = [];

  if (type !== 'none') {
    if (main.invalid) missing.push('auth value is not a ${VAR} reference');
    else if (!main.set && main.varName) missing.push(main.varName);
  }
  if (type === 'basic' && !user.set && user.varName) missing.push(user.varName);

  switch (type) {
    case 'bearer':
      if (main.value) headers.authorization = `Bearer ${main.value}`;
      break;
    case 'header':
      if (main.value) headers[String(up.auth_name || up.authName || '').toLowerCase()] = main.value;
      break;
    case 'query':
      if (main.value) query[up.auth_name || up.authName || 'key'] = main.value;
      break;
    case 'basic':
      if (main.value && user.value) {
        headers.authorization =
          'Basic ' + Buffer.from(`${user.value}:${main.value}`).toString('base64');
      }
      break;
    default:
      break;
  }
  return { headers, query, missing };
}

/**
 * Substitute :params in a path template from a value map.
 * Returns the filled path plus the names nobody supplied a value for.
 */
function fillPath(template, values = {}) {
  const missing = [];
  const path = String(template).replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    const v = values[name];
    if (v === undefined || v === null || v === '') {
      missing.push(name);
      return `:${name}`;
    }
    return encodeURIComponent(String(v));
  });
  return { path, missing };
}

/**
 * Issue the real call to the supplier.
 *
 * Only http and https. Private address space is deliberately NOT blocked —
 * half of what this gateway fronts lives on 10.0.0.0/8 — so this is not an
 * SSRF boundary and does not pretend to be one. The boundary is that only an
 * authenticated admin with edit rights reaches it, and every call is logged.
 */
async function callUpstream({ baseUrl, path, query = {}, method = 'GET', body = null,
                              upstream = {}, timeoutMs = 15000 }) {
  let url;
  try {
    url = new URL(String(path).replace(/^\/?/, '/'), baseUrl);
  } catch {
    return { ok: false, error: `"${baseUrl}" + "${path}" is not a usable URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `refusing to call ${url.protocol}// — http and https only` };
  }

  const auth = authFor(upstream);
  for (const [k, v] of Object.entries({ ...auth.query, ...query })) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  if (auth.missing.length) {
    return {
      ok: false,
      url: url.toString(),
      error:
        `the credential is not set on this server: ${auth.missing.join(', ')}. ` +
        `Add it to /etc/api-gateway/env and restart the service — it is deliberately ` +
        `not stored in the database.`,
      missingEnv: auth.missing,
    };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.min(Number(timeoutMs) || 15000, 60000));
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        accept: 'application/json',
        'user-agent': 'api-gateway-studio/1.0',
        ...auth.headers,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ms = Date.now() - started;
    const text = await readCapped(res);
    let parsed = null;
    let parseError = null;
    const ctype = res.headers.get('content-type') || '';
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (e) {
      parseError = e.message;
    }
    return {
      ok: res.ok && parsed !== null,
      status: res.status,
      ms,
      contentType: ctype,
      bytes: Buffer.byteLength(text || ''),
      body: parsed,
      raw: parsed === null ? (text || '').slice(0, 2000) : null,
      parseError,
      url: url.toString(),
      error: res.ok
        ? parsed === null
          ? `the supplier answered ${res.status} but the body is not JSON${parseError ? ` (${parseError})` : ''}`
          : null
        : `the supplier answered ${res.status}`,
    };
  } catch (err) {
    const ms = Date.now() - started;
    const aborted = err.name === 'AbortError';
    return {
      ok: false,
      ms,
      url: url.toString(),
      error: aborted
        ? `no answer within ${timeoutMs}ms`
        : `could not reach the supplier: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return await res.text();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* already finished */ }
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Every leaf path in a sample body, in the whitelist's own notation. */
function discover(body) {
  try {
    return [...projection.enumeratePaths(body)].sort();
  } catch {
    return [];
  }
}

/**
 * Apply the endpoint's response rules to a sample body — the step 4 answer to
 * "what does the vendor actually see".
 */
function project({ mode, fields = [], exclude = [], rename = {} }, body) {
  try {
    if (mode === 'passthrough') return { ok: true, result: body, note: 'nothing is filtered' };
    if (mode === 'redact') {
      const fn = projection.compileRedact(exclude, 'studio');
      return { ok: true, result: fn(body) };
    }
    const chosen = fields.filter(Boolean);
    if (!chosen.length) {
      return { ok: false, error: 'no field is ticked, so the vendor would receive an empty object' };
    }
    const fn = projection.compile(chosen, rename, 'studio');
    return { ok: true, result: fn(body) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { callUpstream, fillPath, discover, project, resolveRef, authFor };
