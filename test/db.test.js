'use strict';

/**
 * Database-backed behaviour, against a REAL Postgres.
 *
 * Set TEST_DATABASE_URL to run these. Without it the suite skips rather than
 * failing, so `npm test` works on a laptop with no database.
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@host/db npm run test:db
 *
 * These are the tests worth having: idempotency and quota correctness depend on
 * atomic SQL semantics, and a mocked database would only prove that the mock
 * behaves as I imagined it does.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

const HAVE_DB = Boolean(process.env.TEST_DATABASE_URL);

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

let db;
let vendorRepo;
let quotaRepo;
let auditRepo;
let idemRepo;
let migrate;
let gateway;
let base;
let mock;
let built;
let ACME_KEY;
let TINY_KEY;
let received = [];

function startMock() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    let body = '';
    for await (const c of req) body += c;
    received.push({ pathname: url.pathname, body: body ? JSON.parse(body) : undefined });

    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === '/internal/shipments') {
      // A new id per call, so a replay returning the FIRST id proves the upstream
      // was not called again.
      return json(201, {
        shipment_id: `shp_${received.length}`,
        state: 'created',
        internal_cost: 42,
      });
    }
    if (url.pathname.startsWith('/internal/customers/')) {
      return json(200, { id: 1, display_name: 'Acme', address: { city: 'Pune' } });
    }
    if (url.pathname === '/internal/customers') {
      return json(200, { total: 0, items: [] });
    }
    if (url.pathname === '/internal/invoices/x') {
      return json(200, { invoice_id: 'x', total: 1, internal_margin: 9 });
    }
    if (url.pathname === '/internal/reference') return json(200, { ok: true });
    return json(404, { error: 'no route' });
  });
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => ({
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  }));
}

before(async () => {
  if (!HAVE_DB) return;

  db = require('../src/db/pool');
  vendorRepo = require('../src/db/repos/vendors');
  quotaRepo = require('../src/db/repos/quota');
  auditRepo = require('../src/db/repos/audit');
  idemRepo = require('../src/db/repos/idempotency');
  migrate = require('../src/db/migrate').migrate;

  mock = await startMock();

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.CONFIG_DIR = path.join(__dirname, 'fixtures', 'config');
  process.env.MOCK_UPSTREAM_URL = mock.url;
  process.env.MOCK_UPSTREAM_TOKEN = 'upstream-token';
  process.env.VENDOR_KEY_ACME = sha256('unused-config-key');
  process.env.VENDOR_KEY_NARROW = sha256('unused-2');
  process.env.VENDOR_KEY_ADMIN = sha256('unused-3');
  process.env.LOG_LEVEL = 'silent';
  process.env.DISCOVERY_FILE = '/tmp/db-test-discovery.json';
  process.env.AUDIT_FLUSH_MS = '100';
  process.env.VENDOR_CACHE_REFRESH_MS = '500';

  const logger = require('../src/util/logger');
  db.init(logger);

  // Clean slate, then migrate.
  await db.query('DROP SCHEMA IF EXISTS gateway CASCADE');
  await migrate(logger);

  // The main test vendor gets a generous quota — otherwise the quota tests
  // would starve every other test in the file.
  await vendorRepo.upsertVendor({
    id: 'acme',
    name: 'Acme Test',
    scopes: ['customers.read', 'shipments.write'],
    rateWindowMs: 60000,
    rateMax: 10000,
    monthlyQuota: 1000000,
  });
  ACME_KEY = (await vendorRepo.issueKey({ vendorId: 'acme', label: 'test' })).key;

  // A separate vendor with a deliberately tiny quota, used only by the quota
  // tests so the cap is reachable without affecting anything else.
  await vendorRepo.upsertVendor({
    id: 'tiny',
    name: 'Tiny Quota Vendor',
    scopes: ['customers.read'],
    rateWindowMs: 60000,
    rateMax: 10000,
    monthlyQuota: 5,
  });
  TINY_KEY = (await vendorRepo.issueKey({ vendorId: 'tiny', label: 'quota-test' })).key;

  const { createApp } = require('../src/app');
  built = createApp({ logger });
  await built.start();
  gateway = built.app.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  if (!HAVE_DB) return;
  gateway?.close();
  mock?.server?.close();
  await built?.stop().catch(() => {});
  require('../src/middleware/rateLimit').store.stop();
});

const call = (p, opts = {}) =>
  fetch(base + p, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-api-key': ACME_KEY, ...(opts.headers || {}) },
  });

const post = (key, body) =>
  call('/v1/shipments', {
    method: 'POST',
    headers: { 'idempotency-key': key },
    body: JSON.stringify(body),
  });

/** The tiny-quota vendor, used only by the quota tests. */
const callTiny = (p = '/v1/customers/1') =>
  fetch(base + p, { headers: { 'x-api-key': TINY_KEY } });

describe('database-backed gateway', { skip: !HAVE_DB ? 'set TEST_DATABASE_URL to run' : false }, () => {
  // -------------------------------------------------------------------------
  // Keys issued into the DB actually work
  // -------------------------------------------------------------------------

  test('a key issued via the repo authenticates', async () => {
    const res = await call('/v1/customers/1');
    assert.strictEqual(res.status, 200);
  });

  test('the plaintext key is nowhere in the database', async () => {
    const res = await db.query(
      `SELECT count(*)::int AS n FROM gateway.vendor_keys WHERE key_hash = $1`,
      [sha256(ACME_KEY)]
    );
    assert.strictEqual(res.rows[0].n, 1, 'the hash is stored');

    // Prove no column anywhere holds the plaintext.
    const scan = await db.query(
      `SELECT count(*)::int AS n FROM gateway.vendor_keys
        WHERE key_hash LIKE '%' || $1 || '%' OR COALESCE(label,'') LIKE '%' || $1 || '%'`,
      [ACME_KEY]
    );
    assert.strictEqual(scan.rows[0].n, 0, 'plaintext appears nowhere');
  });

  test('revoking a key stops it working after the cache refresh', async () => {
    const extra = await vendorRepo.issueKey({ vendorId: 'acme', label: 'short-lived' });

    await built.vendorStore.refresh();
    let res = await fetch(base + '/v1/customers/1', { headers: { 'x-api-key': extra.key } });
    assert.strictEqual(res.status, 200, 'works before revocation');

    await vendorRepo.revokeKey({ vendorId: 'acme', keyHash: extra.hash });
    await built.vendorStore.refresh();

    res = await fetch(base + '/v1/customers/1', { headers: { 'x-api-key': extra.key } });
    assert.strictEqual(res.status, 401, 'rejected after revocation');
  });

  test('a disabled vendor loses access entirely', async () => {
    await vendorRepo.upsertVendor({ id: 'temp', name: 'Temp', scopes: ['customers.read'] });
    const k = await vendorRepo.issueKey({ vendorId: 'temp' });
    await built.vendorStore.refresh();

    let res = await fetch(base + '/v1/customers/1', { headers: { 'x-api-key': k.key } });
    assert.strictEqual(res.status, 200);

    await vendorRepo.setEnabled('temp', false);
    await built.vendorStore.refresh();

    res = await fetch(base + '/v1/customers/1', { headers: { 'x-api-key': k.key } });
    assert.strictEqual(res.status, 401);
  });

  test('vendor store keeps serving from cache when the database errors', async () => {
    // Point the store at a query that will fail, then confirm traffic still flows.
    const realQuery = db.query;
    db.query = async () => {
      throw new Error('simulated database outage');
    };
    try {
      await built.vendorStore.refresh();
      const res = await call('/v1/customers/1');
      assert.strictEqual(res.status, 200, 'requests still served from the last good cache');
      assert.match(built.vendorStore.snapshot().lastRefreshError, /simulated/);
    } finally {
      db.query = realQuery;
      await built.vendorStore.refresh();
    }
  });

  // -------------------------------------------------------------------------
  // Idempotency — the reason this layer exists
  // -------------------------------------------------------------------------

  test('replaying the same Idempotency-Key does NOT call the upstream again', async () => {
    received = [];
    const key = `idem-${Date.now()}`;
    const body = { order_id: 'o-100', city: 'Pune' };

    const first = await post(key, body);
    assert.strictEqual(first.status, 201);
    const firstBody = await first.json();
    const upstreamCallsAfterFirst = received.length;

    const second = await post(key, body);
    assert.strictEqual(second.status, 201);
    assert.strictEqual(second.headers.get('idempotency-replayed'), 'true');
    assert.deepStrictEqual(await second.json(), firstBody, 'identical response replayed');
    assert.strictEqual(
      received.length,
      upstreamCallsAfterFirst,
      'the upstream was NOT called a second time — no duplicate shipment'
    );
  });

  test('the replayed body is the FILTERED response, not the upstream body', async () => {
    const key = `idem-filter-${Date.now()}`;
    await post(key, { order_id: 'o-101', city: 'Pune' });
    const replay = await post(key, { order_id: 'o-101', city: 'Pune' });
    const body = await replay.json();

    // internal_cost is in the upstream response but not the whitelist. If we had
    // stored the upstream body, it would resurface here on replay.
    assert.strictEqual(body.internal_cost, undefined);
    assert.deepStrictEqual(Object.keys(body).sort(), ['shipment_id', 'state']);
  });

  test('the same key with a DIFFERENT body is rejected, not silently replayed', async () => {
    const key = `idem-mismatch-${Date.now()}`;
    await post(key, { order_id: 'o-200', city: 'Pune' });

    const res = await post(key, { order_id: 'o-999', city: 'Mumbai' });
    assert.strictEqual(res.status, 422);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'idempotency_key_reused');
  });

  test('key ordering in the body does not change the request hash', async () => {
    const key = `idem-order-${Date.now()}`;
    const a = await post(key, { order_id: 'o-300', city: 'Pune' });
    assert.strictEqual(a.status, 201);
    // Same fields, different JSON key order — must be treated as the same request.
    const b = await post(key, { city: 'Pune', order_id: 'o-300' });
    assert.strictEqual(b.status, 201);
    assert.strictEqual(b.headers.get('idempotency-replayed'), 'true');
  });

  test('a concurrent retry with the same key never double-writes', async () => {
    received = [];
    const key = `idem-concurrent-${Date.now()}`;
    const body = { order_id: 'o-400', city: 'Pune' };

    // Fire both at once.
    const [r1, r2] = await Promise.all([post(key, body), post(key, body)]);

    // THE guarantee: the upstream was called once. Everything else is detail.
    assert.strictEqual(received.length, 1, 'the upstream saw exactly one call');

    // Two legitimate outcomes for the loser, depending on whether the winner
    // had already finished when the loser claimed:
    //   - still in flight  -> 409, retry shortly
    //   - already complete -> 201 replay of the stored response
    // Asserting only one of these would make this test flaky for no reason,
    // since both are correct.
    const loser = r1.status === 201 && r1.headers.get('idempotency-replayed') !== 'true' ? r2 : r1;
    const acceptable =
      loser.status === 409 ||
      (loser.status === 201 && loser.headers.get('idempotency-replayed') === 'true');

    assert.ok(
      acceptable,
      `loser should be 409 or a replayed 201, got ${loser.status} ` +
        `replayed=${loser.headers.get('idempotency-replayed')}`
    );
  });

  test('concurrent claims never both win — 100 races, one winner each', async () => {
    // The assertion above proves the HTTP behaviour; this proves the underlying
    // SQL is atomic, which is where a subtle bug would actually live.
    const outcomes = new Map();

    for (let i = 0; i < 100; i++) {
      const key = `race-${i}-${Date.now()}`;
      const requestHash = idemRepo.hashRequest({
        method: 'POST',
        path: '/v1/shipments',
        query: {},
        body: { n: i },
      });
      const args = { vendorId: 'acme', key, endpoint: 'create_shipment', requestHash };
      const [a, b] = await Promise.all([idemRepo.claim(args), idemRepo.claim(args)]);

      const proceeds = [a, b].filter((r) => r.outcome === idemRepo.OUTCOME.PROCEED).length;
      outcomes.set(proceeds, (outcomes.get(proceeds) || 0) + 1);
    }

    assert.deepStrictEqual(
      [...outcomes.entries()],
      [[1, 100]],
      'every race produced exactly one winner — never zero, never two'
    );
  });

  test('a lapsed in_progress claim can be retaken', async () => {
    const key = `idem-lease-${Date.now()}`;
    const hash = idemRepo.hashRequest({ method: 'POST', path: '/x', query: {}, body: { a: 1 } });

    let claim = await idemRepo.claim({
      vendorId: 'acme',
      key,
      endpoint: 'create_shipment',
      requestHash: hash,
    });
    assert.strictEqual(claim.outcome, idemRepo.OUTCOME.PROCEED);

    // Still in flight → a second attempt must not proceed.
    claim = await idemRepo.claim({
      vendorId: 'acme',
      key,
      endpoint: 'create_shipment',
      requestHash: hash,
    });
    assert.strictEqual(claim.outcome, idemRepo.OUTCOME.IN_PROGRESS);

    // Simulate the original request dying: age the claim past its lease.
    await db.query(
      `UPDATE gateway.idempotency_keys SET created_at = now() - interval '10 minutes'
        WHERE idempotency_key = $1`,
      [key]
    );

    claim = await idemRepo.claim({
      vendorId: 'acme',
      key,
      endpoint: 'create_shipment',
      requestHash: hash,
    });
    assert.strictEqual(
      claim.outcome,
      idemRepo.OUTCOME.PROCEED,
      'an abandoned claim does not block the key forever'
    );
  });

  test('a 4xx response is not stored for replay', async () => {
    const key = `idem-4xx-${Date.now()}`;
    // Unknown body field → rejected by the body guard.
    const bad = await call('/v1/shipments', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify({ order_id: 'o1', city: 'Pune', price_override: 0 }),
    });
    assert.strictEqual(bad.status, 400);

    // Same key, now with a valid body, must be allowed to proceed.
    const good = await post(key, { order_id: 'o-500', city: 'Pune' });
    assert.strictEqual(good.status, 201, 'a fixed request is not blocked by the earlier failure');
  });

  // -------------------------------------------------------------------------
  // Quotas
  // -------------------------------------------------------------------------

  test('quota headers are returned and the counter increments', async () => {
    await quotaRepo.reset({ vendorId: 'tiny' });

    const res = await callTiny();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-quota-limit'), '5');
    assert.strictEqual(res.headers.get('x-quota-used'), '1');
    assert.strictEqual(res.headers.get('x-quota-remaining'), '4');
  });

  test('quota is enforced once the monthly cap is reached', async () => {
    await quotaRepo.reset({ vendorId: 'tiny' });

    const codes = [];
    for (let i = 0; i < 7; i++) {
      const r = await callTiny();
      codes.push(r.status);
    }

    // Limit is 5, so the first five pass and the rest are refused.
    assert.deepStrictEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  });

  test('quota rejection names the reset time', async () => {
    await quotaRepo.reset({ vendorId: 'tiny' });
    for (let i = 0; i < 5; i++) await callTiny();

    const res = await callTiny();
    assert.strictEqual(res.status, 429);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'quota_exceeded');
    assert.ok(Number(res.headers.get('retry-after')) > 0);
    assert.match(body.error.message, /resets at the start of next month/);
  });

  test('per-endpoint usage is tracked alongside the vendor total', async () => {
    await quotaRepo.reset({ vendorId: 'tiny' });
    await callTiny();
    await callTiny();

    const rows = await quotaRepo.usageFor({ vendorId: 'tiny' });
    const total = rows.find((r) => r.endpoint === '*');
    const perEndpoint = rows.find((r) => r.endpoint === 'get_customer');

    assert.strictEqual(Number(total.calls), 2);
    assert.strictEqual(Number(perEndpoint.calls), 2);
  });

  test('quota fails OPEN when the database is unreachable', async () => {
    const realQuery = db.query;
    db.query = async () => {
      throw new Error('simulated outage');
    };
    try {
      const result = await quotaRepo.consume({
        vendorId: 'acme',
        endpoint: 'x',
        limit: 1,
        logger: { error: () => {} },
      });
      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.degraded, true);
    } finally {
      db.query = realQuery;
    }
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  test('successful requests land in the audit log', async () => {
    const res = await call('/v1/customers/1');
    const requestId = res.headers.get('x-request-id');

    await built.audit.flush();

    const row = await auditRepo.findByRequestId(requestId);
    assert.ok(row, 'audit row exists for the request id the vendor was given');
    assert.strictEqual(row.vendor_id, 'acme');
    assert.strictEqual(row.endpoint, 'get_customer');
    assert.strictEqual(row.status, 200);
    assert.ok(row.total_ms !== null);
  });

  test('failures are audited with the internal reason the vendor never sees', async () => {
    const res = await call('/v1/customers?bogus=1');
    assert.strictEqual(res.status, 400);
    const requestId = res.headers.get('x-request-id');
    const vendorSaw = JSON.stringify(await res.json());

    await built.audit.flush();
    const row = await auditRepo.findByRequestId(requestId);

    assert.strictEqual(row.status, 400);
    assert.strictEqual(row.error_code, 'bad_request');
    assert.ok(row.internal_reason, 'we recorded why');
    assert.ok(
      !vendorSaw.includes(row.internal_reason),
      'the internal reason was not in the vendor response'
    );
  });

  test('audit rows contain no request or response bodies', async () => {
    const key = `idem-audit-${Date.now()}`;
    const res = await post(key, { order_id: 'SENSITIVE-ORDER-REF', city: 'Pune' });
    const requestId = res.headers.get('x-request-id');

    await built.audit.flush();
    const row = await auditRepo.findByRequestId(requestId);
    const serialised = JSON.stringify(row);

    assert.ok(
      !serialised.includes('SENSITIVE-ORDER-REF'),
      'the audit table is not a second copy of vendor payloads'
    );
  });

  test('audit queue is bounded and drops rather than growing without limit', async () => {
    const { AuditWriter } = require('../src/db/repos/audit');
    process.env.AUDIT_QUEUE_MAX = '10';
    // Re-require to pick up the new bound.
    const mod = requireFresh('../src/db/repos/audit');
    const writer = new mod.AuditWriter({ logger: { error: () => {}, info: () => {} } });
    for (let i = 0; i < 25; i++) {
      writer.record({ requestId: crypto.randomUUID(), status: 200 });
    }
    assert.ok(writer.stats().queued <= 10, 'queue respected its bound');
    assert.ok(writer.stats().dropped >= 15, 'excess was dropped and counted');
    void AuditWriter;
    delete process.env.AUDIT_QUEUE_MAX;
  });

  test('a malformed client IP does not poison a whole audit batch', async () => {
    assert.strictEqual(auditRepo.normaliseIp('::ffff:10.0.0.5'), '10.0.0.5');
    assert.strictEqual(auditRepo.normaliseIp('not-an-ip'), null);
    assert.strictEqual(auditRepo.normaliseIp(undefined), null);

    // And it really inserts.
    await built.audit.record({ requestId: crypto.randomUUID(), status: 200, clientIp: 'garbage' });
    await built.audit.flush();
    assert.strictEqual(built.audit.stats().failures, 0);
  });

  // -------------------------------------------------------------------------
  // Health and housekeeping
  // -------------------------------------------------------------------------

  test('readyz reports database health and vendor store state', async () => {
    const res = await fetch(base + '/readyz');
    const body = await res.json();

    assert.strictEqual(body.database.enabled, true);
    assert.strictEqual(body.database.ok, true);
    assert.ok(body.database.latencyMs >= 0);
    assert.strictEqual(body.vendorStore.source, 'database');
    assert.ok(body.vendorStore.liveKeys >= 1);
  });

  test('purge removes expired idempotency records', async () => {
    await db.query(
      `INSERT INTO gateway.idempotency_keys
         (vendor_id, idempotency_key, endpoint, request_hash, state, expires_at)
       VALUES ('acme', 'expired-key', 'create_shipment', repeat('a',64), 'completed',
               now() - interval '1 day')`
    );
    const n = await idemRepo.purgeExpired();
    assert.ok(n >= 1);
  });

  test('migrations are idempotent and detect tampering', async () => {
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const again = await migrate(logger);
    assert.strictEqual(again.applied.length, 0, 'second run applies nothing');

    // Fake a modified migration and confirm it refuses to proceed.
    await db.query(
      `UPDATE gateway.schema_migrations SET checksum = repeat('f', 64) WHERE file = '001_init.sql'`
    );
    await assert.rejects(() => migrate(logger), /has been modified since it was applied/);

    // Put it back so later runs are clean.
    const { listMigrations } = require('../src/db/migrate');
    const real = listMigrations().find((m) => m.file === '001_init.sql');
    await db.query(`UPDATE gateway.schema_migrations SET checksum = $1 WHERE file = '001_init.sql'`, [
      real.checksum,
    ]);
  });
});

/** Re-require a module with current env, bypassing the cache. */
function requireFresh(p) {
  const resolved = require.resolve(p);
  delete require.cache[resolved];
  return require(p);
}
