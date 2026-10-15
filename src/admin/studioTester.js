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

/**
 * How much of a supplier response this preview will read.
 *
 * Raised from 2 MB after CMOTS CompanyMaster — a full company master list —
 * came back at just over it. The old code cut the body mid-string and then ran
 * JSON.parse on the fragment, which failed with "Unterminated string at
 * position 2096513" and was reported as "the supplier answered 200 but the
 * body is not JSON". The supplier was fine. We truncated it and blamed them,
 * and the position in the message was our own cap, which is the sort of error
 * that sends somebody to the wrong team for an afternoon.
 *
 * This is an admin-only preview on a box with plenty of memory, so the limit
 * exists to stop a runaway response, not to be thrifty. Beyond it the response
 * is reported as too large to preview — never as invalid.
 */
const MAX_BODY_BYTES = Number(process.env.STUDIO_MAX_BODY_BYTES) || 16 * 1024 * 1024;

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

/**
 * Build the auth material for a call.
 *
 * Two sources, and the caller decides which: a ${VAR} reference resolved from
 * this process's environment, or a credential already decrypted from the
 * database and handed in as `secrets`. The second never arrives from the
 * browser — the Studio posts only a path, and the token is fetched server-side.
 */
function authFor(up, secrets = null) {
  const type = up.auth_type || up.authType || 'none';
  const fromVault = secrets && typeof secrets.value === 'string' && secrets.value.length > 0;
  const main = fromVault
    ? { value: secrets.value, varName: null, set: true }
    : resolveRef(up.auth_value_env || up.authValueEnv);
  const user = fromVault && secrets.username
    ? { value: secrets.username, varName: null, set: true }
    : resolveRef(up.auth_user_env || up.authUserEnv);
  const headers = {};
  const query = {};
  const missing = [];

  if (type !== 'none') {
    if (main.invalid) missing.push('auth value is neither a stored credential nor a ${VAR} reference');
    else if (!main.set && main.varName) missing.push(main.varName);
    else if (!main.set && !main.varName) missing.push('no credential has been saved for this supplier');
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
                              upstream = {}, secrets = null, timeoutMs = 15000 }) {
  let url;
  try {
    url = new URL(String(path).replace(/^\/?/, '/'), baseUrl);
  } catch {
    return { ok: false, error: `"${baseUrl}" + "${path}" is not a usable URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `refusing to call ${url.protocol}// — http and https only` };
  }

  const auth = authFor(upstream, secrets);
  for (const [k, v] of Object.entries({ ...auth.query, ...query })) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  if (auth.missing.length) {
    return {
      ok: false,
      url: url.toString(),
      error:
        `the credential is not available: ${auth.missing.join(', ')}. ` +
        `Either save the token in step 1 — it is encrypted before it is stored — ` +
        `or set the environment variable in /etc/api-gateway/env and restart.`,
      missingEnv: auth.missing,
    };
  }

  const ctl = new AbortController();
  const limit = Math.min(Number(timeoutMs) || 15000, 60000);
  const timer = setTimeout(() => ctl.abort(), limit);
  const started = Date.now();

  // "No answer within 15000ms" covers two different faults with one sentence:
  // a supplier that never replied, and a supplier that replied promptly with a
  // body too large to finish arriving. They have different causes and
  // different fixes, so the progress is tracked and reported.
  const progress = { headersAt: null, bytes: 0 };
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
    progress.headersAt = Date.now() - started;
    const ms = Date.now() - started;
    const { text, truncated, bytes } = await readCapped(res, progress);
    let parsed = null;
    let parseError = null;
    const ctype = res.headers.get('content-type') || '';
    // Not parsed when truncated. Parsing a fragment can only fail, and the
    // failure would describe our cut rather than their response.
    if (!truncated) {
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (e) {
        parseError = e.message;
      }
    }
    return {
      ok: res.ok && parsed !== null,
      status: res.status,
      ms,
      contentType: ctype,
      bytes,
      truncated,
      body: parsed,
      raw: parsed === null ? (text || '').slice(0, 2000) : null,
      parseError,
      url: url.toString(),
      error: res.ok
        ? truncated
          ? `the supplier answered ${res.status} and the response is larger than ` +
            `${mb(MAX_BODY_BYTES)}, which is as much as this preview reads. The endpoint ` +
            'itself is not limited — this only affects testing here. Call a narrower path ' +
            'if you need to see the shape, or raise STUDIO_MAX_BODY_BYTES.'
          : parsed === null
            ? `the supplier answered ${res.status} but the body is not JSON${parseError ? ` (${parseError})` : ''}`
            : null
        : `the supplier answered ${res.status}`,
    };
  } catch (err) {
    const ms = Date.now() - started;
    const aborted = err.name === 'AbortError';
    // Timed out AFTER the headers arrived: the supplier is answering, the body
    // is simply bigger than it can deliver in the time allowed. Saying "no
    // answer" here points at the wrong thing — the supplier is up.
    const midBody = aborted && progress.headersAt !== null;
    return {
      ok: false,
      ms,
      url: url.toString(),
      bytes: progress.bytes,
      timedOutMidBody: midBody,
      error: midBody
        ? `the supplier started answering in ${progress.headersAt} ms, but only ` +
          `${mb(progress.bytes)} had arrived when the ${limit} ms timeout fired. The supplier ` +
          'is up — this response is too large to finish in that time. A VENDOR CALLING THIS ' +
          'ENDPOINT WOULD FAIL THE SAME WAY, because the gateway uses the same timeout. ' +
          'Raise the timeout on the supplier API in the Studio (step 1), or narrow what this ' +
          'endpoint asks for.'
        : aborted
        ? `no answer within ${limit} ms — the supplier did not send any response at all. ` +
          'Check the base URL and that this server can reach it.'
        : `could not reach the supplier: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {{text:string, truncated:boolean, bytes:number}}
 *
 * `truncated` is the point of this function. A caller that cannot tell the
 * difference between "this is the whole body" and "this is the first N bytes
 * of it" will parse the fragment and misattribute the failure.
 */
async function readCapped(res, progress = null) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (progress) progress.bytes = Buffer.byteLength(text);
    return { text, truncated: false, bytes: Buffer.byteLength(text) };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (progress) progress.bytes = total;
    if (total > MAX_BODY_BYTES) {
      truncated = true;
      try { await reader.cancel(); } catch { /* already finished */ }
      break;
    }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return { text, truncated, bytes: truncated ? total : Buffer.byteLength(text) };
}

const mb = (n) => (n / (1024 * 1024)).toFixed(1) + ' MB';

/** Every leaf path in a sample body, in the whitelist's own notation. */
function discover(body) {
  try {
    return [...projection.enumeratePaths(body)].sort();
  } catch {
    return [];
  }
}

/**
 * The SHAPE of a body: which paths it has and what type each one is.
 *
 * This is what gets written down after a test. "data[].co_code: number" is a
 * statement about the API; "6" is a statement about Reliance Industries, and
 * that belongs in the datalake, not in the gateway's own database.
 */
function shapeOf(body) {
  const shape = {};
  for (const path of discover(body)) {
    shape[path] = typeAt(body, path);
  }
  return shape;
}

/** Walk a dotted/[]-suffixed path far enough to name the type at its leaf. */
function typeAt(node, path) {
  let cur = node;
  for (const seg of String(path).split('.')) {
    if (cur === null || cur === undefined) return 'null';
    const key = seg.replace(/\[\]$/, '');
    if (key) {
      if (Array.isArray(cur)) cur = cur.length ? cur[0] : undefined;
      if (cur === null || typeof cur !== 'object') return typeName(cur);
      cur = cur[key];
    }
    if (seg.endsWith('[]') && Array.isArray(cur)) cur = cur.length ? cur[0] : undefined;
  }
  return typeName(cur);
}

function typeName(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'absent';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string') {
    // Worth distinguishing: a date column and a name column are both strings,
    // and the difference is the whole of a schema review.
    if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(v)) return 'date';
    return 'string';
  }
  return t;
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

module.exports = { callUpstream, fillPath, discover, shapeOf, project, resolveRef, authFor };
