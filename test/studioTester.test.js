'use strict';

/**
 * Reading a supplier response that is bigger than the preview limit.
 *
 * This exists because of a real misdiagnosis. CMOTS CompanyMaster came back at
 * just over 2 MB, the preview cut it mid-string, JSON.parse failed on the
 * fragment, and the console reported "the supplier answered 200 but the body
 * is not JSON (Unterminated string in JSON at position 2096513)". The supplier
 * was fine. The position in that message was our own cap.
 *
 * An error that names the wrong party is worse than no error: somebody takes
 * it to the supplier, and the supplier correctly says their API is working.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const CAP = 4096;
process.env.STUDIO_MAX_BODY_BYTES = String(CAP);

delete require.cache[require.resolve('../src/admin/studioTester')];
const tester = require('../src/admin/studioTester');

/** A supplier that answers with a JSON array of roughly `bytes` bytes. */
function supplierOf(bytes, { contentType = 'application/json' } = {}) {
  return http.createServer((req, res) => {
    if (req.url === '/notjson') {
      res.writeHead(200, { 'content-type': contentType });
      return res.end('<html>a login page, which is what a bad token often gets you</html>');
    }
    const row = JSON.stringify({ co_code: 1, co_name: 'X'.repeat(40) });
    const n = Math.max(1, Math.ceil(bytes / (row.length + 1)));
    res.writeHead(200, { 'content-type': contentType });
    res.end('[' + Array.from({ length: n }, () => row).join(',') + ']');
  });
}

async function withSupplier(bytes, fn, opts) {
  const srv = supplierOf(bytes, opts);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  try {
    return await fn(baseUrl);
  } finally {
    srv.close();
  }
}

test('supplier responses larger than the preview limit', async (t) => {
  await t.test('a body UNDER the cap parses normally', async () => {
    const r = await withSupplier(CAP / 4, (baseUrl) =>
      tester.callUpstream({ baseUrl, path: '/x', upstream: { auth_type: 'none' } })
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.error, null);
    assert.ok(Array.isArray(r.body), 'the body should have been parsed');
  });

  await t.test('a body OVER the cap is reported as too large, never as invalid', async () => {
    const r = await withSupplier(CAP * 3, (baseUrl) =>
      tester.callUpstream({ baseUrl, path: '/x', upstream: { auth_type: 'none' } })
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.truncated, true);
    assert.match(r.error, /larger than/i);
    // The specific thing that went wrong in production: blaming the supplier.
    assert.doesNotMatch(r.error, /not JSON/i);
    assert.doesNotMatch(r.error, /Unterminated/i);
    assert.strictEqual(r.parseError, null, 'a truncated body must not be parsed at all');
  });

  await t.test('the message says the endpoint itself is not limited', async () => {
    // Otherwise the reasonable conclusion is that the endpoint cannot serve
    // this payload to a vendor either, which is false and would send someone
    // off to redesign a working endpoint.
    const r = await withSupplier(CAP * 3, (baseUrl) =>
      tester.callUpstream({ baseUrl, path: '/x', upstream: { auth_type: 'none' } })
    );
    assert.match(r.error, /endpoint itself is not limited|only affects testing/i);
  });

  await t.test('a genuinely non-JSON body is STILL reported as such', async () => {
    // The truncation fix must not swallow the real case it was confused with:
    // an HTML login page returned with a 200, which is what a bad token often
    // produces and is worth saying plainly.
    const r = await withSupplier(100, (baseUrl) =>
      tester.callUpstream({ baseUrl, path: '/notjson', upstream: { auth_type: 'none' } })
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.truncated, false);
    assert.match(r.error, /not JSON/i);
    assert.ok(r.raw && r.raw.includes('<html'), 'the first part of the body helps diagnose it');
  });
});

test('a timeout says WHICH timeout it was', async (t) => {
  // "No answer within 15000ms" covered two different faults with one sentence.
  // A supplier that never replied and a supplier whose body is too big to
  // finish arriving have different causes and different fixes, and the second
  // one additionally means live vendor calls are failing right now.
  await t.test('silent but reachable: blames the timeout, not the base URL', async () => {
    // The old message told people to check the base URL here. That advice was
    // wrong often enough to matter: a supplier whose master list takes 40s to
    // build looks exactly like this, on a base URL whose other endpoints are
    // answering in 300ms. Sending someone to re-check a URL that is correct
    // costs an afternoon.
    const srv = http.createServer(() => { /* accepts, never responds */ });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const r = await tester.callUpstream({
        baseUrl: `http://127.0.0.1:${srv.address().port}`,
        path: '/x', timeoutMs: 300, upstream: { auth_type: 'none' },
      });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.timedOutMidBody, false);
      assert.strictEqual(r.reachable, true);
      assert.match(r.error, /accepted the connection/i);
      assert.match(r.error, /raise the timeout/i);
      // The specific regression: never send someone to check a URL we have
      // just proved resolves, routes and accepts connections.
      assert.doesNotMatch(r.error, /check the base url/i);
    } finally { srv.close(); }
  });

  await t.test('the reachability probe tells connected from unreachable', async () => {
    const srv = http.createServer(() => {});
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      // Accepts connections but never answers: reachable is about the network,
      // not about whether the application replied.
      const up = await tester.probeOrigin(`http://127.0.0.1:${port}/Market/api/X`, 2000);
      assert.strictEqual(up.reachable, true);
    } finally { srv.close(); }

    // Now nothing is listening on that port at all.
    const down = await tester.probeOrigin(`http://127.0.0.1:${port}/Market/api/X`, 2000);
    assert.strictEqual(down.reachable, false);
    assert.match(String(down.why), /ECONNREFUSED|did not complete/);

    const bad = await tester.probeOrigin('not a url', 500);
    assert.strictEqual(bad.reachable, false);
  });

  await t.test('answered, then stalled mid-body: reported as too large, and as a live fault', async () => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('[{"a":1}');          // headers and a first chunk, then nothing
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const r = await tester.callUpstream({
        baseUrl: `http://127.0.0.1:${srv.address().port}`,
        path: '/x', timeoutMs: 400, upstream: { auth_type: 'none' },
      });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.timedOutMidBody, true);
      assert.match(r.error, /started answering/i);
      assert.match(r.error, /supplier is up/i);
      // The part that turns a test result into an incident.
      assert.match(r.error, /CONSUMER CALLING THIS ENDPOINT WOULD FAIL/);
      assert.doesNotMatch(r.error, /no answer/i);
    } finally { srv.close(); }
  });
});
