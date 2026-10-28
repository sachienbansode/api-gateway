'use strict';

/**
 * "Can we reach the supplier at all?" — answered separately, and always.
 *
 * It used to be answered only when a call timed out. That is the one moment
 * it is least useful: you have already waited the full timeout to learn
 * something a handshake could have told you in milliseconds.
 *
 * It matters because a DNS failure, a firewall, an expired certificate and a
 * wrong path are indistinguishable from a request that never returns, and
 * they have four different fixes.
 *
 * A handshake and nothing more — no HTTP request — so it is safe to run
 * against an endpoint that sends an SMS.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { once } = require('node:events');

const { probeOrigin } = require('../src/admin/studioTester');

describe('the reachability probe', () => {
  let srv; let port;

  before(async () => {
    srv = http.createServer((_req, res) => { res.end('ok'); });
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    port = srv.address().port;
  });

  after(() => { srv?.close(); });

  test('a listening host is reachable, with a timing', async () => {
    const r = await probeOrigin(`http://127.0.0.1:${port}`);
    assert.strictEqual(r.reachable, true);
    assert.ok(typeof r.ms === 'number' && r.ms >= 0);
  });

  test('it does NOT make an HTTP request', async () => {
    // The whole point: safe against an endpoint with a side effect. If this
    // issued a GET, probing an SMS endpoint would send a message.
    let hits = 0;
    const counting = http.createServer((_req, res) => { hits += 1; res.end('x'); });
    counting.listen(0, '127.0.0.1');
    await once(counting, 'listening');
    try {
      const r = await probeOrigin(`http://127.0.0.1:${counting.address().port}`);
      assert.strictEqual(r.reachable, true);
      assert.strictEqual(hits, 0, 'the server saw no request');
    } finally { counting.close(); }
  });

  test('a closed port is not reachable, and says why', async () => {
    const dead = http.createServer();
    dead.listen(0, '127.0.0.1');
    await once(dead, 'listening');
    const deadPort = dead.address().port;
    await new Promise((r) => dead.close(r));

    const res = await probeOrigin(`http://127.0.0.1:${deadPort}`);
    assert.strictEqual(res.reachable, false);
    assert.ok(res.why, 'a reason is given');
  });

  test('a hostname that does not resolve is not reachable', async () => {
    const r = await probeOrigin('https://no-such-host.invalid');
    assert.strictEqual(r.reachable, false);
    assert.ok(res_why(r), 'a reason is given');
    function res_why(x) { return x.why && String(x.why).length > 0; }
  });

  test('a malformed base URL is reported, not thrown', async () => {
    // Somebody pastes a path into the base URL field. That should read as a
    // configuration mistake, not a crash.
    const r = await probeOrigin('not a url');
    assert.strictEqual(r.reachable, false);
    assert.match(r.why, /not a valid URL/);
  });

  test('it gives up rather than hanging', async () => {
    // A socket that is accepted and then ignored: the TCP connect succeeds,
    // the TLS handshake never completes. That is the shape of a host behind
    // a firewall that drops rather than refuses, and it is the case that
    // hangs if the probe has no timeout of its own.
    //
    // Built from a real silent socket rather than a reserved IP, because a
    // sandboxed network can answer for an address nobody routes.
    const net = require('node:net');
    const silent = net.createServer(() => { /* accept, then say nothing */ });
    silent.listen(0, '127.0.0.1');
    await once(silent, 'listening');
    try {
      const started = Date.now();
      const r = await probeOrigin(`https://127.0.0.1:${silent.address().port}`, 600);
      const took = Date.now() - started;
      assert.strictEqual(r.reachable, false, 'a handshake that never finishes is not reachable');
      assert.ok(took >= 500 && took < 5000, `gave up in ${took}ms`);
      assert.match(String(r.why), /did not complete/);
    } finally { silent.close(); }
  });
});
