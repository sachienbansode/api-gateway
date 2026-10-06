'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const ACME_KEY = 'vk_acme_test_key_do_not_use_in_prod';
const NARROW_KEY = 'vk_narrow_test_key';
const ADMIN_KEY = 'vk_admin_test_key';

let gateway;
let base;
let mock;
let builtObserver;
let builtApp;
let received = [];

/**
 * Mock upstream. Records every request it receives, so the tests can assert on
 * what the gateway actually sent — which is where the real guarantees live.
 */
function startMock() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    let body = '';
    for await (const chunk of req) body += chunk;

    received.push({
      method: req.method,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...req.headers },
      body: body ? JSON.parse(body) : undefined,
    });

    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-powered-by': 'Express' });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === '/internal/slow') {
      await new Promise((r) => setTimeout(r, 700));
      return json(200, { ok: true });
    }

    if (url.pathname === '/internal/boom') {
      // A realistically leaky internal 500.
      return json(500, {
        error: 'SequelizeConnectionError',
        message: 'connect ECONNREFUSED 10.0.1.55:5432',
        stack: 'at Database.connect (/srv/internal-api/src/db/pool.js:88:14)',
        host: 'orders-db-prod-01.internal.corp',
      });
    }

    if (url.pathname.startsWith('/internal/invoices/')) {
      return json(200, {
        invoice_id: 'inv_1',
        total: 1200,
        currency: 'INR',
        internal_margin: 0.42,
        cost_breakdown: { labour: 300, parts: 400 },
        created_by_user_id: 'u-77',
        line_items: [
          { sku: 'A', qty: 2, unit_cost: 150 },
          { sku: 'B', qty: 1, unit_cost: 300 },
        ],
      });
    }

    if (url.pathname === '/internal/reference') {
      return json(200, { countries: [{ code: 'IN', name: 'India' }], version: 3 });
    }

    if (url.pathname === '/internal/customers') {
      return json(200, {
        total: 2,
        internal_query_ms: 14,
        db_shard: 'shard-03',
        items: [
          { id: 1, display_name: 'Acme', margin_pct: 41.2, internal_notes: 'chase payment' },
          { id: 2, display_name: 'Globex', margin_pct: 12.0, internal_notes: 'vip' },
        ],
      });
    }

    if (url.pathname.startsWith('/internal/customers/')) {
      const id = Number(url.pathname.split('/').pop());
      if (id === 404) return json(404, { error: 'not found', table: 'customer_records' });
      return json(200, {
        id,
        display_name: 'Acme Ltd',
        status: 'active',
        credit_score: 780,
        internal_notes: 'DO NOT SHARE',
        cost_basis: 19.55,
        created_by_user_id: 'u-1099',
        address: { city: 'Pune', country: 'IN', internal_geo_id: 'GEO-X-991' },
      });
    }

    if (url.pathname === '/internal/shipments') {
      return json(201, {
        shipment_id: 'shp_1',
        state: 'created',
        internal_cost: 42.5,
        carrier_account: 'ACCT-SECRET-9',
      });
    }

    return json(404, { error: 'no route' });
  });

  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => ({
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  }));
}

before(async () => {
  mock = await startMock();

  process.env.CONFIG_DIR = path.join(__dirname, 'fixtures', 'config');
  process.env.MOCK_UPSTREAM_URL = mock.url;
  process.env.MOCK_UPSTREAM_TOKEN = 'upstream-secret-token-abc123';
  process.env.VENDOR_KEY_ACME = sha256(ACME_KEY);
  process.env.VENDOR_KEY_NARROW = sha256(NARROW_KEY);
  process.env.VENDOR_KEY_ADMIN = sha256(ADMIN_KEY);
  process.env.LOG_LEVEL = 'silent';
  // Keep the discovery snapshot out of the repo during tests.
  process.env.DISCOVERY_FILE = '/tmp/test-discovered-fields.json';

  // Required after env is in place, because config reads the environment at
  // module load and boot.
  const { createApp } = require('../src/app');
  const logger = require('../src/util/logger');
  const built = createApp({ logger });
  builtObserver = built.observer;
  builtApp = built;

  // No DATABASE_URL in this suite: the gateway must work fully without one, and
  // start() is what proves it degrades to config-backed vendors rather than
  // failing. The database-backed behaviour has its own suite in db.test.js.
  await built.start();

  gateway = built.app.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  gateway?.close();
  mock?.server?.close();
  await builtApp?.stop().catch(() => {});
  require('../src/middleware/rateLimit').store.stop();
  try {
    require('node:fs').unlinkSync('/tmp/test-discovered-fields.json');
  } catch {
    /* nothing to clean up */
  }
});

const call = (p, opts = {}) =>
  fetch(base + p, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });

const asAcme = (p, opts = {}) =>
  call(p, { ...opts, headers: { 'x-api-key': ACME_KEY, ...(opts.headers || {}) } });

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('rejects a request with no API key', async () => {
  const res = await call('/v1/customers/1');
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error.code, 'unauthorized');
  assert.ok(body.error.requestId, 'error carries a requestId for support');
});

test('rejects an invalid API key', async () => {
  const res = await call('/v1/customers/1', { headers: { 'x-api-key': 'wrong' } });
  assert.strictEqual(res.status, 401);
});

test('accepts the key as a bearer token too', async () => {
  const res = await call('/v1/customers/1', { headers: { authorization: `Bearer ${ACME_KEY}` } });
  assert.strictEqual(res.status, 200);
});

test('scope enforcement: a vendor cannot reach an endpoint outside its scopes', async () => {
  const res = await call('/v1/secret', { headers: { 'x-api-key': NARROW_KEY } });
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).error.code, 'forbidden');
});

test('an undeclared path 404s and never reaches an upstream', async () => {
  received = [];
  const res = await asAcme('/v1/../internal/customers/1');
  assert.ok([400, 404].includes(res.status));
  assert.strictEqual(received.length, 0, 'no upstream call was made');
});

// ---------------------------------------------------------------------------
// The core guarantee: nothing leaks
// ---------------------------------------------------------------------------

test('response contains ONLY whitelisted fields', async () => {
  const res = await asAcme('/v1/customers/1');
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.deepStrictEqual(body, {
    id: 1,
    name: 'Acme Ltd',
    address: { city: 'Pune' },
  });

  const raw = JSON.stringify(body);
  for (const secret of [
    'credit_score',
    'DO NOT SHARE',
    'cost_basis',
    'created_by_user_id',
    'GEO-X-991',
    'active',
  ]) {
    assert.ok(!raw.includes(secret), `leaked: ${secret}`);
  }
});

test('array responses are filtered element by element', async () => {
  const res = await asAcme('/v1/customers');
  const body = await res.json();
  assert.deepStrictEqual(body, {
    total: 2,
    items: [
      { id: 1, display_name: 'Acme' },
      { id: 2, display_name: 'Globex' },
    ],
  });
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('margin_pct'));
  assert.ok(!raw.includes('internal_notes'));
  assert.ok(!raw.includes('shard-03'));
});

test('our upstream credential is injected and the vendor key never travels upstream', async () => {
  received = [];
  await asAcme('/v1/customers/1');

  assert.strictEqual(received.length, 1);
  const up = received[0];

  assert.strictEqual(up.headers.authorization, 'Bearer upstream-secret-token-abc123');
  assert.strictEqual(up.headers['x-api-key'], undefined, 'vendor key must not be forwarded');
  assert.ok(up.headers['x-gateway-request-id'], 'correlation id is sent upstream');
});

test('vendor-supplied headers are not forwarded upstream', async () => {
  received = [];
  await asAcme('/v1/customers/1', {
    headers: {
      'x-forwarded-host': 'evil.example.com',
      'x-original-url': '/internal/admin/users',
      cookie: 'session=abc',
      'x-custom-smuggle': 'payload',
    },
  });

  const up = received[0];
  assert.strictEqual(up.headers['x-forwarded-host'], undefined);
  assert.strictEqual(up.headers['x-original-url'], undefined);
  assert.strictEqual(up.headers.cookie, undefined);
  assert.strictEqual(up.headers['x-custom-smuggle'], undefined);
});

test('upstream 500 is translated — no hostnames, stack traces or table names escape', async () => {
  const res = await asAcme('/v1/boom');
  assert.strictEqual(res.status, 503);
  const raw = JSON.stringify(await res.json());

  for (const leak of [
    'Sequelize',
    '10.0.1.55',
    'orders-db-prod-01',
    'internal.corp',
    '/srv/internal-api',
    'pool.js',
  ]) {
    assert.ok(!raw.includes(leak), `leaked: ${leak}`);
  }
});

test('upstream 404 becomes a clean 404 without upstream detail', async () => {
  const res = await asAcme('/v1/customers/404');
  assert.strictEqual(res.status, 404);
  const raw = JSON.stringify(await res.json());
  assert.ok(!raw.includes('customer_records'));
});

test('no upstream fingerprinting headers are passed to the vendor', async () => {
  const res = await asAcme('/v1/customers/1');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
  assert.strictEqual(res.headers.get('server'), null);
});

// ---------------------------------------------------------------------------
// Request-side controls
// ---------------------------------------------------------------------------

test('unknown query parameters are rejected, not silently dropped', async () => {
  received = [];
  const res = await asAcme('/v1/customers?page=1&include_internal=true');
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error.message, /include_internal/);
  assert.strictEqual(received.length, 0);
});

test('allowlisted query params pass through and injected values are forced', async () => {
  received = [];
  const res = await asAcme('/v1/customers?page=2');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(received[0].query.page, '2');
  assert.strictEqual(received[0].query.partner_scope, 'vendor');
});

test('unknown body fields are rejected on a write endpoint', async () => {
  received = [];
  const res = await asAcme('/v1/shipments', {
    method: 'POST',
    body: JSON.stringify({ order_id: 'o1', city: 'Pune', price_override: 0 }),
  });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error.message, /price_override/);
  assert.strictEqual(received.length, 0);
});

test('a vendor cannot override an injected body value', async () => {
  const res = await asAcme('/v1/shipments', {
    method: 'POST',
    body: JSON.stringify({ order_id: 'o1', city: 'Pune', allow_manual_price: true }),
  });
  assert.strictEqual(res.status, 400, 'attempt is rejected outright');
});

test('write endpoint requires an Idempotency-Key by default', async () => {
  received = [];
  const res = await asAcme('/v1/shipments', {
    method: 'POST',
    body: JSON.stringify({ order_id: 'o1', city: 'Pune' }),
  });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error.message, /Idempotency-Key/);
  assert.strictEqual(received.length, 0, 'no upstream call without the header');
});

test('write endpoint forwards only allowlisted fields plus injections', async () => {
  received = [];
  const res = await asAcme('/v1/shipments', {
    method: 'POST',
    headers: { 'idempotency-key': 'test-key-forward-1' },
    body: JSON.stringify({ order_id: 'o1', city: 'Pune' }),
  });
  assert.strictEqual(res.status, 201);

  assert.deepStrictEqual(received[0].body, {
    order_id: 'o1',
    city: 'Pune',
    source: 'vendor_api',
    allow_manual_price: false,
  });

  assert.deepStrictEqual(await res.json(), { shipment_id: 'shp_1', state: 'created' });
});

test('malformed JSON gets a clean 400', async () => {
  const res = await asAcme('/v1/shipments', {
    method: 'POST',
    headers: { 'idempotency-key': 'test-key-badjson' },
    body: '{not json',
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).error.code, 'bad_request');
});

test('path traversal in a path parameter is encoded, not honoured', async () => {
  received = [];
  await asAcme('/v1/customers/' + encodeURIComponent('../../internal/admin'));
  if (received.length) {
    assert.ok(
      !received[0].pathname.includes('/internal/admin/'),
      'traversal must not escape the mapped route'
    );
  }
});

// ---------------------------------------------------------------------------
// Response modes, end to end
// ---------------------------------------------------------------------------

test('redact mode forwards everything except the excluded fields', async () => {
  const res = await asAcme('/v1/invoices/inv_1');
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.deepStrictEqual(body, {
    invoice_id: 'inv_1',
    total: 1200,
    currency: 'INR',
    // created_by_user_id is NOT excluded in the fixture, so it is forwarded —
    // which is exactly the point about redact mode: you only lose what you name.
    created_by_user_id: 'u-77',
    line_items: [
      { sku: 'A', qty: 2 },
      { sku: 'B', qty: 1 },
    ],
  });

  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('internal_margin'));
  assert.ok(!raw.includes('cost_breakdown'));
  assert.ok(!raw.includes('unit_cost'));
});

test('passthrough mode forwards the upstream body verbatim', async () => {
  const res = await asAcme('/v1/reference');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), {
    countries: [{ code: 'IN', name: 'India' }],
    version: 3,
  });
});

test('even in passthrough mode, no upstream headers reach the vendor', async () => {
  const res = await asAcme('/v1/reference');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});

test('discovery recorded the field paths the upstreams actually returned', async () => {
  const snap = builtObserver.snapshot();

  assert.ok(snap.redacted_invoice, 'redact endpoint was observed');
  assert.ok(
    snap.redacted_invoice.includes('internal_margin'),
    'discovery sees pre-filter fields, which is how you learn what to exclude'
  );
  assert.ok(snap.redacted_invoice.includes('line_items[].unit_cost'));
  assert.ok(snap.reference_passthrough.includes('countries[].code'));

  // Whitelist endpoints do not have discovery on by default.
  assert.strictEqual(snap.get_customer, undefined);
});

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------

test('a slow upstream times out as a 504 instead of hanging', async () => {
  const res = await asAcme('/v1/slow');
  assert.strictEqual(res.status, 504);
  assert.strictEqual((await res.json()).error.code, 'upstream_timeout');
});

test('rate limit trips and returns Retry-After', async () => {
  // Uses a dedicated endpoint with max: 2, so it is not competing for an
  // allowance with the rest of the suite.
  let limited = null;
  for (let i = 0; i < 6 && !limited; i++) {
    const r = await asAcme('/v1/tight');
    if (r.status === 429) limited = r;
  }

  assert.ok(limited, 'limiter eventually rejected');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.strictEqual((await limited.json()).error.code, 'rate_limited');
});

// Runs last: tripping the breaker affects the shared mock upstream.
test('circuit breaker opens after repeated upstream failures', async () => {
  // failureThreshold is 2 in the fixture.
  await asAcme('/v1/boom');
  await asAcme('/v1/boom');

  const res = await asAcme('/v1/customers/1');
  assert.strictEqual(res.status, 503, 'breaker short-circuits without calling upstream');
  assert.strictEqual((await res.json()).error.code, 'service_unavailable');
});

test('readyz reports the degraded upstream', async () => {
  const res = await fetch(base + '/readyz');
  assert.strictEqual(res.status, 503);
  const body = await res.json();
  assert.strictEqual(body.upstreams.mock.state, 'open');
});
