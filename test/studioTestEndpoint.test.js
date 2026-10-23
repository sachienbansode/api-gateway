'use strict';

/**
 * Step 4 must call the supplier the way the LIVE request will.
 *
 * It did not. The test sent baseUrl + path with the auth scheme and nothing
 * else — no fixed values, no sealed credential, no consumer arguments. For a
 * read endpoint whose parameters are optional that is a passable smoke test.
 * For an endpoint that authenticates with ordinary request parameters, which
 * is how ACL and most pre-JSON suppliers work, it calls the endpoint with no
 * credentials at all.
 *
 * The supplier then answers its "bad request" code with HTTP 200, and the
 * screen reports **HTTP 200, passed**, because the HTTP call itself worked.
 * That is the worst kind of green: it says the host is reachable while
 * implying the endpoint is configured. Observed live — ACL answered `-2` and
 * step 4 called it a pass.
 *
 * So these tests assert on what the SUPPLIER received, not on what the screen
 * said afterwards.
 *
 * Needs a database for the sealed-credential case. Set TEST_DATABASE_URL.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const { once } = require('node:events');

const HAVE_DB = Boolean(process.env.TEST_DATABASE_URL);
const skip = !HAVE_DB ? 'set TEST_DATABASE_URL to run' : false;

const PASSWORD = 'the-acl-password';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

describe('the Studio step 4 test', { skip }, () => {
  let db; let studio; let secrets; let app; let server; let base;
  let supplier; let supplierPort; let received;

  before(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.GW_SECRET_KEY = 'k1:' + Buffer.alloc(32, 7).toString('base64');

    db = require('../src/db/pool');
    db.init(quiet);
    studio = require('../src/db/repos/studio');
    secrets = require('../src/db/repos/secrets');
    const studioRoutes = require('../src/admin/studioRoutes');

    received = [];
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      received.push({
        method: req.method,
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        headers: req.headers,
      });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('1701|9820031724|OK');
    });
    s.listen(0, '127.0.0.1');
    await once(s, 'listening');
    supplier = s;
    supplierPort = s.address().port;

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.admin = { email: 'a@b.c', canEdit: true }; next(); });
    app.use('/admin/api', studioRoutes.json(quiet, {}));
    server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;

    await db.query(`INSERT INTO gateway.applications (code, name)
                    VALUES ('s4','Step 4 test') ON CONFLICT (code) DO NOTHING`);
    await db.query(
      `INSERT INTO gateway.upstreams (name, display_name, base_url, auth_type, application)
       VALUES ('s4up','S4','http://127.0.0.1:${supplierPort}','none','s4')
       ON CONFLICT (name) DO UPDATE SET base_url = EXCLUDED.base_url`);

    await studio.saveEndpoint({
      name: 's4_send', application: 's4', method: 'POST', path: '/v1/s4',
      upstream: 's4up', upstreamPath: '/send', upstreamMethod: 'GET',
      responseMode: 'text',
      params: [
        { name: 'appid', location: 'query', source: 'fixed', fixedValue: 'ashismbalt' },
        { name: 'pass', location: 'query', source: 'secret' },
        { name: 'mobile', location: 'query', source: 'vendor', forwardAs: 'to' },
      ],
      status: 'draft', enabled: true,
    }, 'a@b.c');
    await secrets.setForParam({
      endpoint: 's4_send', param: 'pass', plaintext: PASSWORD, actor: 'a@b.c' });
  });

  after(async () => {
    try {
      await db.query(`DELETE FROM gateway.endpoints WHERE name = 's4_send'`);
      await db.query(`DELETE FROM gateway.upstreams WHERE name = 's4up'`);
      await db.query(`DELETE FROM gateway.applications WHERE code = 's4'`);
    } catch { /* cleanup must not fail the run */ }
    server?.close();
    supplier?.close();
    await db?.close?.();
  });

  const run = (body) => fetch(base + '/admin/api/test-endpoint', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const PARAMS = [
    { name: 'appid', location: 'query', source: 'fixed', fixedValue: 'ashismbalt' },
    { name: 'pass', location: 'query', source: 'secret' },
    { name: 'mobile', location: 'query', source: 'vendor', forwardAs: 'to' },
  ];

  test('the configured parameters reach the supplier', async () => {
    received.length = 0;
    const res = await run({
      endpoint: 's4_send',
      upstream: { name: 's4up', baseUrl: `http://127.0.0.1:${supplierPort}`, authType: 'none' },
      upstreamPath: '/send',
      upstreamMethod: 'GET',
      values: { mobile: '9820031724' },
      params: PARAMS,
      mode: 'text',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(received.length, 1, 'the supplier was called once');

    const got = received[0];
    assert.strictEqual(got.query.appid, 'ashismbalt', 'the fixed value');
    assert.strictEqual(got.query.pass, PASSWORD, 'the SEALED value, resolved server-side');
    assert.strictEqual(got.query.to, '9820031724', 'renamed by forwardAs');
    assert.strictEqual(got.query.mobile, undefined, 'our own name is not sent');
  });

  test('the sealed value never travels to the browser', async () => {
    received.length = 0;
    const res = await run({
      endpoint: 's4_send',
      upstream: { name: 's4up', baseUrl: `http://127.0.0.1:${supplierPort}`, authType: 'none' },
      upstreamPath: '/send', upstreamMethod: 'GET',
      values: { mobile: '9820031724' }, params: PARAMS, mode: 'text',
    });
    const text = await res.text();
    assert.ok(!text.includes(PASSWORD), 'the response body is clean');
  });

  test('and it is not written to connection_tests either', async () => {
    // recordTest stores the request URL in a plain column that the Studio's
    // history panel reads back. Testing a sealed credential must not be the
    // act that writes it to the database in clear text.
    const rows = await db.query(
      `SELECT request_url FROM gateway.connection_tests WHERE endpoint = 's4_send'
        ORDER BY occurred_at DESC LIMIT 5`);
    assert.ok(rows.rows.length > 0, 'the test was recorded at all');
    for (const r of rows.rows) {
      assert.ok(!String(r.request_url || '').includes(PASSWORD),
        'the stored URL is scrubbed');
    }
    assert.ok(rows.rows.some((r) => String(r.request_url || '').includes('••••')),
      'and visibly so, rather than the parameter being dropped');
  });

  test('a test with no stored credential is REFUSED, not run', async () => {
    // Running it would call the supplier unauthenticated and come back with
    // their error code, which says nothing about this configuration — and
    // previously looked like a pass.
    received.length = 0;
    const res = await run({
      endpoint: 'no_such_endpoint',
      upstream: { name: 's4up', baseUrl: `http://127.0.0.1:${supplierPort}`, authType: 'none' },
      upstreamPath: '/send', upstreamMethod: 'GET',
      values: {}, params: [{ name: 'pass', location: 'query', source: 'secret' }],
      mode: 'text',
    });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /no value is stored for pass/);
    assert.strictEqual(received.length, 0, 'the supplier was NOT called');
  });

  test('a header parameter is sent as a header', async () => {
    received.length = 0;
    await run({
      endpoint: 's4_send',
      upstream: { name: 's4up', baseUrl: `http://127.0.0.1:${supplierPort}`, authType: 'none' },
      upstreamPath: '/send', upstreamMethod: 'GET', values: {},
      params: [{ name: 'X-Account', location: 'header', source: 'fixed', fixedValue: 'ashika-01' }],
      mode: 'text',
    });
    assert.strictEqual(received[0].headers['x-account'], 'ashika-01');
  });

  test('the upstream method is honoured', async () => {
    received.length = 0;
    await run({
      endpoint: 's4_send',
      upstream: { name: 's4up', baseUrl: `http://127.0.0.1:${supplierPort}`, authType: 'none' },
      upstreamPath: '/send', upstreamMethod: 'GET', values: {}, params: [], mode: 'text',
    });
    assert.strictEqual(received[0].method, 'GET');
  });

  test('the supplier\'s plain-text reply comes back to the screen', async () => {
    // Without this the screen has nothing to show for a text endpoint, and
    // reported "0 fields" — which reads as a failure on an endpoint working
    // exactly as configured.
    received.length = 0;
    const res = await run({
      endpoint: 's4_send',
      upstream: { name: 's4up', baseUrl: `http://127.0.0.1:${supplierPort}`, authType: 'none' },
      upstreamPath: '/send', upstreamMethod: 'GET',
      values: { mobile: '9820031724' }, params: PARAMS, mode: 'text',
    });
    const j = await res.json();
    assert.strictEqual(j.result.status, 200);
    assert.strictEqual(j.result.raw, '1701|9820031724|OK');
  });
});
