'use strict';

/**
 * Suppliers that do not answer in JSON.
 *
 * The bug being fixed is a DOUBLE-SEND, and it is worth stating because the
 * fix looks cosmetic otherwise. On an endpoint with a side effect:
 *
 *   the gateway calls the supplier → the SMS goes out → the body is
 *   `1701|9199…|OK` → JSON.parse throws → the error handler releases the
 *   idempotency claim → the consumer gets a 502 → the consumer retries →
 *   a SECOND SMS goes out
 *
 * The call succeeded. Only our reading of it failed, and the customer got two
 * messages. So the test below counts how many times the supplier was actually
 * called, which is the only number that matters here.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { once } = require('node:events');

const { buildRouter } = require('../src/core/router');
const { UpstreamClient } = require('../src/core/upstream');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** A supplier that behaves like ACL: plain text, outcome in the body. */
async function aclLike(reply) {
  let calls = 0;
  const srv = http.createServer((req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(typeof reply === 'function' ? reply(calls) : reply);
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  return { srv, port: srv.address().port, calls: () => calls };
}

function smsEndpoint(port, extra = {}) {
  return {
    name: 'send_sms',
    method: 'POST',
    path: '/v1/sms',
    upstream: 'acl',
    upstreamPath: '/send',
    upstreamMethod: 'POST',
    scopes: ['ep:send_sms'],
    rateLimit: { windowMs: 60000, max: 100 },
    idempotency: 'off',
    discover: false,
    request: { query: [], body: ['mobile', 'message'], inject: {} },
    response: {
      mode: 'text',
      fields: [],
      exclude: [],
      rename: {},
      acknowledgeUnfiltered: true,
      contentType: 'text/plain; charset=utf-8',
      failureMatch: null,
      ...extra,
    },
  };
}

async function callOnce(endpoint, port) {
  // Positional (upstreams, logger) — the constructor builds a breaker per
  // upstream from this map, so passing an options object leaves the breaker
  // map empty and every call dies on `breaker.allow()`.
  const client = new UpstreamClient(
    {
      acl: {
        id: 'acl',
        baseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 3000,
        auth: { type: 'none' },
      },
    },
    quiet
  );
  return client.call(endpoint, { params: {}, query: {}, body: { mobile: '9199', message: 'hi' },
    requestId: 'test-1' });
}

/**
 * Validation runs over the real YAML loader, so a fixture is three documents
 * keyed the way the files are named. Reaching for a `buildConfig` that does not
 * exist would have tested nothing.
 */
function loadWith(response) {
  const { loadFrom } = require('../src/core/config');
  // The loader insists a vendor's key be a SHA-256 hash, not a plaintext key.
  // Good rule; satisfy it with a real one rather than loosening it.
  process.env.GW_TEST_KEY = require('node:crypto')
    .createHash('sha256').update('test-key').digest('hex');
  return () => loadFrom({
    upstreams: { upstreams: { acl: { baseUrl: 'https://acl.example.com' } } },
    endpoints: {
      endpoints: [{
        name: 'send_sms', method: 'POST', path: '/v1/sms', upstream: 'acl',
        upstreamPath: '/send', scopes: ['ep:send_sms'], response,
      }],
    },
    // A real vendor rather than ALLOW_EMPTY_CONFIG, so the scope cross-check
    // runs too and these fixtures stay representative.
    vendors: { vendors: [{ id: 'test', scopes: ['ep:send_sms'], keyEnv: 'GW_TEST_KEY' }] },
  });
}

describe('a supplier that answers with plain text', () => {
  test('the call succeeds instead of throwing — the SMS is sent once', async () => {
    const sup = await aclLike('1701|919999999999|OK|submitted');
    try {
      const r = await callOnce(smsEndpoint(sup.port), sup.port);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body, null, 'nothing was parsed');
      assert.strictEqual(r.text, '1701|919999999999|OK|submitted');
      assert.strictEqual(r.textFailed, false);
      // The whole point: one call, one message.
      assert.strictEqual(sup.calls(), 1);
    } finally { sup.srv.close(); }
  });

  test('the same body still throws when the endpoint expects JSON', async () => {
    // The protection has to stay for read endpoints. A supplier quietly
    // switching to an HTML error page must not become a 200 full of HTML.
    const sup = await aclLike('1701|919999999999|OK');
    const json = smsEndpoint(sup.port);
    json.response.mode = 'whitelist';
    json.response.fields = ['a'];
    try {
      await assert.rejects(() => callOnce(json, sup.port), (err) => {
        // The vendor-facing message is deliberately scrubbed, so the reason
        // lives on internalReason. Asserting on both proves the rejection AND
        // that the supplier's body did not leak into the response.
        assert.strictEqual(err.status, 502);
        assert.match(err.internalReason, /not valid JSON/);
        assert.doesNotMatch(err.message, /1701/);
        return true;
      });
    } finally { sup.srv.close(); }
  });

  test('a failure hidden in a 200 body is reported as a failure', async () => {
    // ACL answers HTTP 200 and puts the outcome in the text. Without this the
    // gateway reports every send as a success and nobody finds out until a
    // customer complains.
    const sup = await aclLike('ERROR|INVALID_NUMBER');
    try {
      const r = await callOnce(smsEndpoint(sup.port, { failureMatch: 'ERROR' }), sup.port);
      assert.strictEqual(r.status, 200, 'the supplier really did say 200');
      assert.strictEqual(r.textFailed, true, 'and we know better');
    } finally { sup.srv.close(); }
  });

  test('the failure match is case-insensitive', async () => {
    // Somebody copying the word out of a supplier PDF will type Error, ERROR
    // or error, and the one they choose must not decide whether alerts fire.
    const sup = await aclLike('Error: handset unreachable');
    try {
      const r = await callOnce(smsEndpoint(sup.port, { failureMatch: 'ERROR' }), sup.port);
      assert.strictEqual(r.textFailed, true);
    } finally { sup.srv.close(); }
  });

  test('a success body is not mistaken for a failure', async () => {
    const sup = await aclLike('1701|919999999999|OK');
    try {
      const r = await callOnce(smsEndpoint(sup.port, { failureMatch: 'ERROR' }), sup.port);
      assert.strictEqual(r.textFailed, false);
    } finally { sup.srv.close(); }
  });

  test('an empty body is not a crash', async () => {
    const sup = await aclLike('');
    try {
      const r = await callOnce(smsEndpoint(sup.port), sup.port);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.text, '');
    } finally { sup.srv.close(); }
  });

  test('XML comes back whole — the same path covers SOAP', async () => {
    const xml = '<?xml version="1.0"?><soap:Envelope><soap:Body><ok>1</ok></soap:Body></soap:Envelope>';
    const sup = await aclLike(xml);
    try {
      const r = await callOnce(
        smsEndpoint(sup.port, { contentType: 'application/xml' }), sup.port);
      assert.strictEqual(r.text, xml, 'not parsed, not truncated, not altered');
    } finally { sup.srv.close(); }
  });

  test('config refuses text mode without the acknowledgement', () => {
    assert.throws(loadWith({ mode: 'text' }), /acknowledgeUnfiltered/);
  });

  test('config refuses response.fields on a text endpoint', () => {
    // Ticking fields on a response with no fields is a misunderstanding worth
    // catching at validation rather than letting it look configured.
    assert.throws(
      loadWith({ mode: 'text', acknowledgeUnfiltered: true, fields: ['a'] }),
      /no meaning for mode "text"/
    );
  });

  test('config accepts a text endpoint that acknowledges', () => {
    const cfg = loadWith({
      mode: 'text', acknowledgeUnfiltered: true, failureMatch: 'ERROR',
    })();
    const ep = cfg.endpoints.find((e) => e.name === 'send_sms');
    assert.strictEqual(ep.response.mode, 'text');
    assert.strictEqual(ep.response.failureMatch, 'ERROR');
  });
});

// Keep the linter honest about the unused import above.
void buildRouter;
