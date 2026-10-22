'use strict';

/**
 * Parameters configured on the screen must reach the supplier.
 *
 * They did not. The Studio wrote its parameter table to `endpoint_params` and
 * the router read forced values from `endpoint_inject`; nothing copied between
 * them, so every fixed value, every ${VARIABLE} and every consumer query
 * parameter published from the console was dropped at request time. The screen
 * showed a configured endpoint and the call went out bare.
 *
 * It was invisible for two reasons. The test button in step 1 builds its own
 * request and does not go through this path, so the console said the supplier
 * was reachable. And an endpoint whose credential is missing usually gets a
 * 200 back with an error sentence in it — which, before the text mode existed,
 * was reported as an upstream parse failure rather than "you sent no key".
 *
 * So these tests assert on what the SUPPLIER received, not on what the config
 * object looks like afterwards. A unit test of the config shape would have
 * passed throughout the period the bug existed.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { once } = require('node:events');

const { UpstreamClient } = require('../src/core/upstream');
const { loadFrom } = require('../src/core/config');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** Records exactly what arrived, which is the only thing worth asserting on. */
async function recorder() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      seen.push({
        method: req.method,
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  return { srv, port: srv.address().port, seen, last: () => seen[seen.length - 1] };
}

/** Build the endpoint through the real validator, as both config paths do. */
function build(params, overrides = {}) {
  const cfg = loadFrom({
    upstreams: { upstreams: { acl: { baseUrl: 'https://replaced.example.com' } } },
    endpoints: {
      endpoints: [{
        name: 'send_sms', method: 'POST', path: '/v1/sms', upstream: 'acl',
        upstreamPath: '/send', scopes: ['ep:send_sms'], idempotency: 'off',
        response: { mode: 'text', acknowledgeUnfiltered: true },
        request: { params },
        ...overrides,
      }],
    },
    vendors: { vendors: [{ id: 'test', scopes: ['ep:send_sms'], keyEnv: 'GW_TEST_KEY' }] },
  });
  return cfg.endpoints.find((e) => e.name === 'send_sms');
}

function client(port) {
  return new UpstreamClient(
    { acl: { id: 'acl', baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 3000,
      auth: { type: 'none' } } },
    quiet
  );
}

process.env.GW_TEST_KEY = require('node:crypto')
  .createHash('sha256').update('test-key').digest('hex');

describe('request parameters reach the supplier', () => {
  test('a fixed credential on a POST is sent in the QUERY STRING', async () => {
    // The case that could not be expressed at all. ACL is a POST and its
    // credentials go in the query string; the old rule placed every forced
    // value by method, so on a POST they could only land in the body, where
    // ACL never looks. The call went out unauthenticated.
    const sup = await recorder();
    try {
      const ep = build([
        { name: 'UserID', location: 'query', source: 'fixed', value: 'ashika' },
        { name: 'Password', location: 'query', source: 'fixed', value: 's3cret' },
        { name: 'MobileNo', location: 'query', source: 'vendor' },
      ]);
      await client(sup.port).call(ep, {
        params: {}, query: { MobileNo: '919999999999' }, body: {}, requestId: 'r1',
      });
      const got = sup.last();
      assert.strictEqual(got.query.UserID, 'ashika');
      assert.strictEqual(got.query.Password, 's3cret');
      assert.strictEqual(got.query.MobileNo, '919999999999');
      // And NOT duplicated into the payload, where it would reach the logs.
      assert.deepStrictEqual(got.body, {});
    } finally { sup.srv.close(); }
  });

  test('a consumer cannot overwrite a value we fix', async () => {
    // The whole point of a fixed parameter: an account code stays ours. If the
    // consumer could set it by sending the same name, the endpoint would be a
    // way to bill somebody else.
    const sup = await recorder();
    try {
      const ep = build([
        { name: 'UserID', location: 'query', source: 'fixed', value: 'ashika' },
      ]);
      await client(sup.port).call(ep, {
        params: {}, query: { UserID: 'attacker' }, body: {}, requestId: 'r2',
      });
      assert.strictEqual(sup.last().query.UserID, 'ashika');
    } finally { sup.srv.close(); }
  });

  test('a ${VARIABLE} parameter is resolved, not sent literally', async () => {
    process.env.ACL_PASSWORD = 'from-the-env-file';
    const sup = await recorder();
    try {
      const ep = build([
        { name: 'Password', location: 'query', source: 'env', value: '${ACL_PASSWORD}' },
      ]);
      await client(sup.port).call(ep, { params: {}, query: {}, body: {}, requestId: 'r3' });
      assert.strictEqual(sup.last().query.Password, 'from-the-env-file');
    } finally { sup.srv.close(); delete process.env.ACL_PASSWORD; }
  });

  test('a missing ${VARIABLE} fails at startup, not at 3am', () => {
    delete process.env.ACL_MISSING;
    assert.throws(
      () => build([
        { name: 'Password', location: 'query', source: 'env', value: '${ACL_MISSING}' },
      ]),
      /ACL_MISSING/
    );
  });

  test('a header parameter becomes a header', async () => {
    const sup = await recorder();
    try {
      const ep = build([
        { name: 'X-Account', location: 'header', source: 'fixed', value: 'ashika-01' },
      ]);
      await client(sup.port).call(ep, { params: {}, query: {}, body: {}, requestId: 'r4' });
      assert.strictEqual(sup.last().headers['x-account'], 'ashika-01');
    } finally { sup.srv.close(); }
  });

  test('a parameter cannot displace our own Authorization header', async () => {
    // Otherwise anyone who can add a parameter can replace the gateway's
    // credential with one of their choosing.
    const sup = await recorder();
    try {
      const ep = build([
        { name: 'Authorization', location: 'header', source: 'fixed', value: 'Bearer theirs' },
      ]);
      const c = new UpstreamClient(
        { acl: { id: 'acl', baseUrl: `http://127.0.0.1:${sup.port}`, timeoutMs: 3000,
          auth: { type: 'bearer', token: 'ours' } } },
        quiet
      );
      await c.call(ep, { params: {}, query: {}, body: {}, requestId: 'r5' });
      assert.strictEqual(sup.last().headers.authorization, 'Bearer ours');
    } finally { sup.srv.close(); }
  });

  test('a body parameter goes in the body and nowhere else', async () => {
    const sup = await recorder();
    try {
      const ep = build([
        { name: 'sender', location: 'body', source: 'fixed', value: 'ASHIKA' },
        { name: 'message', location: 'body', source: 'vendor' },
      ]);
      await client(sup.port).call(ep, {
        params: {}, query: {}, body: { message: 'hello' }, requestId: 'r6',
      });
      const got = sup.last();
      assert.deepStrictEqual(got.body, { message: 'hello', sender: 'ASHIKA' });
      assert.deepStrictEqual(got.query, {});
    } finally { sup.srv.close(); }
  });

  test('forwardAs renames a parameter for the supplier', async () => {
    // Our consumers should not have to learn a supplier's spelling, and a
    // supplier renaming a field should not break every consumer.
    const sup = await recorder();
    try {
      const ep = build([
        { name: 'mobile', location: 'query', source: 'vendor', forwardAs: 'MobileNo' },
      ]);
      await client(sup.port).call(ep, {
        params: {}, query: { mobile: '919999999999' }, body: {}, requestId: 'r7',
      });
      const got = sup.last();
      assert.strictEqual(got.query.MobileNo, '919999999999');
      assert.strictEqual(got.query.mobile, undefined, 'our name is not also sent');
    } finally { sup.srv.close(); }
  });

  test('a parameter the consumer did not send is simply absent', async () => {
    const sup = await recorder();
    try {
      const ep = build([
        { name: 'MobileNo', location: 'query', source: 'vendor' },
      ]);
      await client(sup.port).call(ep, { params: {}, query: {}, body: {}, requestId: 'r8' });
      assert.deepStrictEqual(sup.last().query, {});
    } finally { sup.srv.close(); }
  });

  test('config refuses a fixed parameter with no value', () => {
    // It would look configured on screen and send nothing.
    assert.throws(
      () => build([{ name: 'UserID', location: 'query', source: 'fixed' }]),
      /no value/
    );
  });

  test('config refuses an unknown location', () => {
    assert.throws(
      () => build([{ name: 'UserID', location: 'cookie', source: 'fixed', value: 'x' }]),
      /not one of/
    );
  });

  test('config refuses the same name twice in one place', () => {
    assert.throws(
      () => build([
        { name: 'UserID', location: 'query', source: 'fixed', value: 'a' },
        { name: 'UserID', location: 'query', source: 'fixed', value: 'b' },
      ]),
      /declared twice/
    );
  });

  test('the legacy inject shape still places by method', async () => {
    // Nothing published before this change may alter its behaviour. A GET with
    // request.inject must still put the value in the query string with no
    // params list present at all.
    const sup = await recorder();
    try {
      const cfg = loadFrom({
        upstreams: { upstreams: { acl: { baseUrl: 'https://replaced.example.com' } } },
        endpoints: {
          endpoints: [{
            name: 'get_co', method: 'GET', path: '/v1/co', upstream: 'acl',
            upstreamPath: '/co', scopes: ['ep:get_co'],
            request: { query: ['code'], inject: { tenant: 'ashika' } },
            response: { mode: 'whitelist', fields: ['ok'] },
          }],
        },
        vendors: { vendors: [{ id: 'test', scopes: ['ep:get_co'], keyEnv: 'GW_TEST_KEY' }] },
      });
      const ep = cfg.endpoints.find((e) => e.name === 'get_co');
      assert.deepStrictEqual(ep.request.params, [], 'no typed list');
      await client(sup.port).call(ep, {
        params: {}, query: { code: '6' }, body: {}, requestId: 'r9',
      });
      assert.deepStrictEqual(sup.last().query, { code: '6', tenant: 'ashika' });
    } finally { sup.srv.close(); }
  });
});
