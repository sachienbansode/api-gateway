'use strict';

/**
 * The inbound path, end to end: a supplier posts, we verify, we answer, we
 * deliver.
 *
 * These are the tests that matter for a webhook, because every failure mode
 * here is silent. A webhook that rejects everything looks identical from our
 * side to a webhook nobody is calling. A webhook that accepts and never
 * delivers looks like a working integration until somebody asks why the news
 * feed is empty.
 *
 * So each test asserts on BOTH sides: what the supplier was told, and what
 * the internal application actually received.
 *
 * Needs a database. Set TEST_DATABASE_URL to run.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const http = require('node:http');
const { once } = require('node:events');

const HAVE_DB = Boolean(process.env.TEST_DATABASE_URL);
const skip = !HAVE_DB ? 'set TEST_DATABASE_URL to run' : false;

const SECRET = 'the-key-flipit-emailed-us';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const NEWS = {
  title: 'Kotak Mahindra Bank surges 6% on $690 million in MSCI inflows',
  slug: 'kotak-mahindra-bank-surges-6-on-690-million-in-msci-inflows',
  content: 'Kotak Mahindra Bank shares rose nearly 6% on Tuesday…',
  companies: [{ symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank Ltd.' }],
  tags: ['Stocks'],
  lang: 'en',
  created_at: '1681193106',
  updated_at: '1681193108',
};

function sign(body, secret = SECRET) {
  return crypto.createHmac('sha256', secret)
    .update(String(body.slug) + String(body.updated_at))
    .digest('hex');
}

describe('a supplier calling us', { skip }, () => {
  let db; let repo; let secrets; let deliverer;
  let app; let server; let base;
  let internal; let internalBase; let delivered; let attempts; let internalStatus;

  before(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.GW_SECRET_KEY = 'k1:' + Buffer.alloc(32, 7).toString('base64');

    db = require('../src/db/pool');
    db.init(quiet);
    repo = require('../src/db/repos/webhooks');
    secrets = require('../src/db/repos/secrets');
    const { buildWebhookRouter } = require('../src/core/webhookRouter');
    const { buildDeliverer } = require('../src/core/webhookDelivery');

    // The internal application the payload is handed to.
    delivered = [];
    attempts = [];
    internalStatus = 200;
    internal = express();
    internal.use(express.json());
    internal.post('/ingest', (req, res) => {
      // `delivered` means ACCEPTED, not merely received. An application
      // answering 503 still sees the request and still refuses it, so
      // counting arrivals would have made "the app is down" look like a
      // successful delivery.
      attempts.push({ body: req.body, status: internalStatus });
      if (internalStatus < 300) delivered.push({ body: req.body, headers: req.headers });
      res.status(internalStatus).json({ ok: internalStatus < 300 });
    });
    const isrv = http.createServer(internal);
    isrv.listen(0, '127.0.0.1');
    await once(isrv, 'listening');
    internalBase = `http://127.0.0.1:${isrv.address().port}`;
    internal.close = () => isrv.close();

    deliverer = buildDeliverer({ repo, logger: quiet, intervalMs: 50 });

    app = express();
    // trust proxy, as it runs behind nginx — otherwise every source address
    // is the proxy's and an allowlist is meaningless.
    app.set('trust proxy', true);
    app.use('/hooks', buildWebhookRouter({
      repo, secrets, logger: quiet, onAccepted: () => deliverer.nudge(),
    }));
    server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;

    await db.query(`INSERT INTO gateway.applications (code, name)
                    VALUES ('flipit','FlipitMoney') ON CONFLICT (code) DO NOTHING`);
    await repo.save({
      name: 'flipit_news', application: 'flipit', displayName: 'FlipitMoney news',
      path: '/flipit/news',
      signatureScheme: 'hmac_sha256_hex',
      signatureHeader: 'X-Flipit-Checksum',
      signatureMessage: '{slug}{updated_at}',
      forwardUrl: `${internalBase}/ingest`,
      eventKeyField: 'slug', eventVersionField: 'updated_at',
      status: 'live', enabled: true,
      plaintext: SECRET,
    }, 'admin@example.com');
  });

  after(async () => {
    try {
      await db.query(`DELETE FROM gateway.webhooks WHERE name = 'flipit_news'`);
      await db.query(`DELETE FROM gateway.applications WHERE code = 'flipit'`);
    } catch { /* cleanup must not fail the run */ }
    deliverer?.stop();
    server?.close();
    internal?.close();
    await db?.close?.();
  });

  beforeEach(async () => {
    delivered = [];
    attempts = [];
    internalStatus = 200;
    await db.query(`DELETE FROM gateway.webhook_deliveries WHERE webhook = 'flipit_news'`);
    await db.query(`DELETE FROM gateway.webhook_seen WHERE webhook = 'flipit_news'`);
  });

  const post = (body, headers = {}, path = '/hooks/flipit/news') =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  async function settle(ms = 400) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await deliverer.tick();
      if (delivered.length) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Wait for a condition rather than asserting the instant after an action.
   *
   * Accepting and delivering are deliberately separate, and the log write is
   * deliberately fire-and-forget so a failing audit cannot fail a live call.
   * Asserting immediately tests the scheduler's luck, not the behaviour — and
   * it is the kind of flake that gets a real failure dismissed later.
   */
  async function eventually(fn, ms = 1000) {
    const until = Date.now() + ms;
    let last;
    for (;;) {
      try { last = await fn(); if (last) return last; } catch (e) { last = e; }
      if (Date.now() > until) {
        throw last instanceof Error ? last : new Error('condition never became true');
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  test('a correctly signed call is accepted and delivered', async () => {
    const res = await post(NEWS, { 'X-Flipit-Checksum': sign(NEWS) });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { received: true, duplicate: false });

    await settle();
    assert.strictEqual(delivered.length, 1);
    assert.strictEqual(delivered[0].body.slug, NEWS.slug);
    assert.strictEqual(delivered[0].body.title, NEWS.title);
    assert.strictEqual(delivered[0].headers['x-pravah-webhook'], 'flipit_news');
  });

  test('an unsigned call is rejected and nothing is delivered', async () => {
    const res = await post(NEWS);
    assert.strictEqual(res.status, 401);
    await settle(150);
    assert.strictEqual(delivered.length, 0);
  });

  test('a call signed with the wrong key is rejected', async () => {
    const res = await post(NEWS, { 'X-Flipit-Checksum': sign(NEWS, 'not-our-key') });
    assert.strictEqual(res.status, 401);
    await settle(150);
    assert.strictEqual(delivered.length, 0);
  });

  test('the rejection says nothing about why', async () => {
    const res = await post(NEWS, { 'X-Flipit-Checksum': 'deadbeef' });
    const body = await res.json();
    assert.deepStrictEqual(body, { error: 'rejected' });
    assert.ok(!JSON.stringify(body).includes(SECRET));
  });

  test('a repeat is answered 200 and delivered ONCE', async () => {
    // They retry on any non-2xx, so a 409 would have them send it again and
    // again and then give up — having already delivered it successfully.
    const sig = { 'X-Flipit-Checksum': sign(NEWS) };
    const first = await post(NEWS, sig);
    await settle();
    const second = await post(NEWS, sig);

    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    assert.strictEqual((await second.json()).duplicate, true);

    await settle(200);
    assert.strictEqual(delivered.length, 1, 'the internal application saw it once');
  });

  test('an UPDATE to the same story is delivered again', async () => {
    // Same slug, new updated_at. Their documentation: an updated item is
    // pushed again with the same attributes. Treating it as a repeat would
    // silently drop every correction.
    await post(NEWS, { 'X-Flipit-Checksum': sign(NEWS) });
    await settle();

    const updated = { ...NEWS, title: 'Kotak Mahindra Bank surges 7%', updated_at: '1681199999' };
    const res = await post(updated, { 'X-Flipit-Checksum': sign(updated) });
    assert.strictEqual((await res.json()).duplicate, false);

    const until = Date.now() + 500;
    while (delivered.length < 2 && Date.now() < until) {
      await deliverer.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.strictEqual(delivered.length, 2);
    assert.strictEqual(delivered[1].body.title, 'Kotak Mahindra Bank surges 7%');
  });

  test('a DELETE arrives as the same story with deleted_at', async () => {
    const del = { ...NEWS, updated_at: '1681200000', deleted_at: '1681200000' };
    const res = await post(del, { 'X-Flipit-Checksum': sign(del) });
    assert.strictEqual(res.status, 200);
    await settle();
    assert.strictEqual(delivered[0].body.deleted_at, '1681200000');
  });

  test('the supplier is answered 200 even when the internal app is DOWN', async () => {
    // The whole reason the payload is written down first. They give up after
    // about a minute; an internal restart must not cost us the news.
    internalStatus = 503;
    const res = await post(NEWS, { 'X-Flipit-Checksum': sign(NEWS) });
    assert.strictEqual(res.status, 200, 'accepted regardless');

    await deliverer.tick();
    const rows = await db.query(
      `SELECT attempts, state, last_error FROM gateway.webhook_deliveries
        WHERE webhook = 'flipit_news'`);
    assert.strictEqual(rows.rows.length, 1, 'still queued, not lost');
    assert.ok(rows.rows[0].attempts >= 1);
    assert.match(rows.rows[0].last_error, /503/);
  });

  test('and it is delivered once the internal app comes back', async () => {
    internalStatus = 503;
    await post(NEWS, { 'X-Flipit-Checksum': sign(NEWS) });
    await eventually(async () => {
      await deliverer.tick();
      assert.ok(attempts.length >= 1, 'it was offered');
      return true;
    });
    assert.strictEqual(delivered.length, 0, 'and refused');

    internalStatus = 200;
    // Backoff puts it in the future, so bring it forward rather than waiting.
    await db.query(
      `UPDATE gateway.webhook_deliveries SET next_attempt_at = now()
        WHERE webhook = 'flipit_news'`);
    await deliverer.tick();

    assert.strictEqual(delivered.length, 1);
    await eventually(async () => {
      const left = await db.query(
        `SELECT 1 FROM gateway.webhook_deliveries WHERE webhook = 'flipit_news'`);
      assert.strictEqual(left.rows.length, 0, 'and the row is gone — a queue, not a store');
      return true;
    });
  });

  test('a delivered payload leaves NOTHING behind but an identifier', async () => {
    // The standing rule: the gateway does not hold supplier data. What
    // survives is a slug and a timestamp, with no content.
    await post(NEWS, { 'X-Flipit-Checksum': sign(NEWS) });
    await settle();

    const q = await db.query(
      `SELECT count(*)::int AS n FROM gateway.webhook_deliveries WHERE webhook='flipit_news'`);
    assert.strictEqual(q.rows[0].n, 0);

    const seen = await db.query(
      `SELECT * FROM gateway.webhook_seen WHERE webhook='flipit_news'`);
    assert.strictEqual(seen.rows.length, 1);
    assert.ok(!JSON.stringify(seen.rows[0]).includes('Kotak Mahindra Bank shares rose'),
      'no content is kept');
  });

  test('an unknown path is a 404 that reveals nothing', async () => {
    const res = await post(NEWS, { 'X-Flipit-Checksum': sign(NEWS) }, '/hooks/guessing');
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'not found' });
  });

  test('a draft webhook is not reachable', async () => {
    await db.query(`UPDATE gateway.webhooks SET status='draft' WHERE name='flipit_news'`);
    try {
      const res = await post(NEWS, { 'X-Flipit-Checksum': sign(NEWS) });
      assert.strictEqual(res.status, 404, 'unpublished means unroutable');
    } finally {
      await db.query(`UPDATE gateway.webhooks SET status='live' WHERE name='flipit_news'`);
    }
  });

  test('a source outside the allowlist is refused', async () => {
    await db.query(
      `UPDATE gateway.webhooks SET ip_allowlist='{52.66.1.2}' WHERE name='flipit_news'`);
    try {
      const res = await post(NEWS, { 'X-Flipit-Checksum': sign(NEWS) });
      assert.strictEqual(res.status, 403);
      await settle(150);
      assert.strictEqual(delivered.length, 0);
    } finally {
      await db.query(`UPDATE gateway.webhooks SET ip_allowlist='{}' WHERE name='flipit_news'`);
    }
  });

  test('a body that is not JSON is a 400, not a 500', async () => {
    const res = await post('this is not json', { 'X-Flipit-Checksum': 'x' });
    assert.strictEqual(res.status, 400);
  });

  test('every call is recorded, including the refused ones', async () => {
    // Without this a supplier signing with the wrong key is invisible: they
    // see failures, we see nothing, and the conversation starts with "your
    // webhook is broken" and no way to check.
    // Counting rows would be wrong: recentCalls has a LIMIT, so once enough
    // calls have accumulated the count stops rising and the test passes or
    // fails on how much history happens to be there.
    const before = (await repo.recentCalls('flipit_news', 1))[0]?.id || 0;
    await post(NEWS, { 'X-Flipit-Checksum': sign(NEWS, 'wrong') });
    // The log write is deliberately not awaited by the request path: a failing
    // audit table must not turn a live webhook call into a 500.
    await eventually(async () => {
      const rows = await repo.recentCalls('flipit_news', 1);
      assert.ok(rows[0] && Number(rows[0].id) > Number(before), 'a new row');
      assert.strictEqual(rows[0].outcome, 'bad_signature');
      assert.strictEqual(rows[0].status, 401);
      return true;
    });
  });

  test('the signing key is not in a database dump', async () => {
    const { execFileSync } = require('node:child_process');
    const dump = execFileSync('pg_dump', ['--no-owner', process.env.TEST_DATABASE_URL],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.ok(!dump.includes(SECRET), 'plaintext');
    assert.ok(!dump.includes(Buffer.from(SECRET).toString('base64')), 'base64');
  });

  test('the screen sees a mask, never the key', async () => {
    const rows = await repo.credentialStatus('flipit_news');
    assert.strictEqual(rows[0].is_set, true);
    assert.match(rows[0].masked, /^•+/);
    assert.ok(!JSON.stringify(rows).includes(SECRET));
  });
});
