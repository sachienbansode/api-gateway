'use strict';

/**
 * A credential that travels as a request parameter.
 *
 * ACL's push API takes a user id and a password as ordinary query parameters.
 * There is no Authorization header to seal, and `auth.type: query` holds one
 * name/value pair, so before this the only working place for the second one
 * was endpoint_params.fixed_value — a plain TEXT column.
 *
 * WHAT THESE TESTS ASSERT, AND WHY IT IS NOT THE OBVIOUS THING
 *
 * Asserting that seal() returns ciphertext proves seal() works. It does not
 * prove the password avoided every OTHER place a write could have left it: an
 * audit row, the change-log's before/after snapshot, a column somebody added
 * later. That is exactly how secrets escape, so the real test dumps the whole
 * database and greps it — in plaintext, base64 and hex, because something
 * helpfully encoding it on the way in would otherwise read as a pass.
 *
 * Needs a database. Set TEST_DATABASE_URL to run; skipped otherwise, rather
 * than quietly asserting nothing.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');

const HAVE_DB = Boolean(process.env.TEST_DATABASE_URL);
const skip = !HAVE_DB ? 'set TEST_DATABASE_URL to run' : false;

const PASSWORD = 'Tr0ub4dor-and-3-ACL-secret';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

describe('a credential that travels as a request parameter', { skip }, () => {
  let db; let studio; let catalog; let secrets; let loadFrom; let UpstreamClient;
  let srv; let port; let received = null;

  before(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.GW_SECRET_KEY = 'k1:' + Buffer.alloc(32, 7).toString('base64');
    process.env.ALLOW_EMPTY_CONFIG = 'true';

    db = require('../src/db/pool');
    db.init(quiet);
    studio = require('../src/db/repos/studio');
    catalog = require('../src/db/repos/catalog');
    secrets = require('../src/db/repos/secrets');
    ({ loadFrom } = require('../src/core/config'));
    ({ UpstreamClient } = require('../src/core/upstream'));

    srv = http.createServer((req, res) => {
      received = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('1701|919999999999|OK');
    });
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    port = srv.address().port;

    await db.query(`INSERT INTO gateway.applications (code, name)
                    VALUES ('tsec','Test supplier') ON CONFLICT (code) DO NOTHING`);
    await db.query(
      `INSERT INTO gateway.upstreams (name, display_name, base_url, auth_type, application)
       VALUES ('tsec','Test','http://127.0.0.1:${port}','none','tsec')
       ON CONFLICT (name) DO UPDATE SET base_url = EXCLUDED.base_url`);

    await studio.saveEndpoint({
      name: 'tsec_send', application: 'tsec', method: 'POST', path: '/v1/tsec',
      upstream: 'tsec', upstreamPath: '/send',
      responseMode: 'text', responseFailureMatch: 'ERROR',
      params: [
        { name: 'UserID', location: 'query', source: 'fixed',
          fixedValue: 'ashika', required: true },
        { name: 'Password', location: 'query', source: 'secret',
          plaintext: PASSWORD, required: true },
        { name: 'mobile', location: 'query', source: 'vendor',
          forwardAs: 'MobileNo', required: true },
      ],
      status: 'live', enabled: true,
    }, 'admin@example.com');
  });

  after(async () => {
    try {
      await db.query(`DELETE FROM gateway.endpoints WHERE name = 'tsec_send'`);
      await db.query(`DELETE FROM gateway.upstreams WHERE name = 'tsec'`);
      await db.query(`DELETE FROM gateway.applications WHERE code = 'tsec'`);
    } catch { /* a failed cleanup must not fail the run */ }
    srv?.close();
    await db?.close?.();
  });

  test('the screen is told it is set, and the last four characters only', async () => {
    const ep = await studio.endpoint('tsec_send');
    const pw = ep.params.find((p) => p.name === 'Password');
    assert.strictEqual(pw.source, 'secret');
    assert.strictEqual(pw.fixed_value, null, 'nothing in the plaintext column');
    assert.strictEqual(pw.secret_set, true);
    assert.match(pw.secret_masked, /^•+cret$/);
    assert.strictEqual(pw.secret_set_by, 'admin@example.com');
    assert.ok(!JSON.stringify(ep).includes(PASSWORD), 'the screen payload is clean');
  });

  test('the validated config holds a placeholder, not the password', async () => {
    // The credential must never pass through the validator or any
    // string-rewriting step — the rule migration 004 set for upstream
    // credentials, kept here for the same reason.
    const manifest = await catalog.toManifest();
    const cfg = loadFrom({
      upstreams: { upstreams: manifest.upstreams },
      endpoints: { endpoints: manifest.endpoints },
      vendors: { vendors: [] },
    });
    const ep = cfg.endpoints.find((e) => e.name === 'tsec_send');
    assert.ok(!JSON.stringify(ep.request).includes(PASSWORD));
  });

  test('the supplier receives the real password', async () => {
    const manifest = await catalog.toManifest();
    const cfg = loadFrom({
      upstreams: { upstreams: manifest.upstreams },
      endpoints: { endpoints: manifest.endpoints },
      vendors: { vendors: [] },
    });
    await catalog.applyVaultSecrets(cfg, { upstreams: [], endpoints: [] }, quiet);
    const ep = cfg.endpoints.find((e) => e.name === 'tsec_send');
    const client = new UpstreamClient(cfg.upstreams, quiet);
    await client.call(ep, {
      params: {}, query: { mobile: '919999999999' }, body: {}, requestId: 't1',
    });
    assert.strictEqual(received.Password, PASSWORD);
    assert.strictEqual(received.UserID, 'ashika');
    assert.strictEqual(received.MobileNo, '919999999999');
  });

  test('an endpoint whose credential cannot be read goes dark', async () => {
    // It does NOT call the supplier without it. ACL answers a credential-less
    // call with HTTP 200 and an error sentence, so "send it and see" would
    // look like a working endpoint producing failed sends.
    const manifest = await catalog.toManifest();
    const cfg = loadFrom({
      upstreams: { upstreams: manifest.upstreams },
      endpoints: { endpoints: manifest.endpoints },
      vendors: { vendors: [] },
    });
    const saved = process.env.GW_SECRET_KEY;
    process.env.GW_SECRET_KEY = 'k9:' + Buffer.alloc(32, 9).toString('base64');
    try {
      const failed = await catalog.applyVaultSecrets(
        cfg, { upstreams: [], endpoints: [] }, quiet);
      assert.ok(failed.some((f) => f.endpoint === 'tsec_send'));
      assert.ok(!cfg.endpoints.some((e) => e.name === 'tsec_send'),
        'the endpoint is not being served');
    } finally { process.env.GW_SECRET_KEY = saved; }
  });

  test('a save that cannot seal REPORTS it, and stores nothing in the clear', async () => {
    // The failure worth shouting about. Everything else about the endpoint
    // looks finished, so a generic error implies nothing was saved — when in
    // fact the endpoint IS saved and simply cannot call anybody.
    const saved = process.env.GW_SECRET_KEY;
    delete process.env.GW_SECRET_KEY;
    try {
      await assert.rejects(
        () => studio.saveEndpoint({
          name: 'tsec_nokey', application: 'tsec', method: 'POST', path: '/v1/tsec2',
          upstream: 'tsec', upstreamPath: '/send', responseMode: 'text',
          params: [{ name: 'pass', location: 'query', source: 'secret',
            plaintext: 'would-be-lost' }],
          status: 'draft', enabled: true,
        }, 'a@b.c'),
        (e) => {
          assert.match(e.message, /was NOT stored/);
          assert.match(e.message, /GW_SECRET_KEY/);
          assert.strictEqual(e.credentialFailed, 'pass');
          return true;
        }
      );
      const row = await db.query(
        `SELECT fixed_value FROM gateway.endpoint_params
          WHERE endpoint = 'tsec_nokey' AND name = 'pass'`);
      assert.strictEqual(row.rows[0]?.fixed_value ?? null, null,
        'and nothing landed in the plaintext column');
    } finally {
      process.env.GW_SECRET_KEY = saved;
      await db.query(`DELETE FROM gateway.endpoints WHERE name = 'tsec_nokey'`).catch(() => {});
    }
  });

  test('a successful save reports the mask back to the screen', async () => {
    // Without this the cell keeps showing an editable password box and there
    // is no way to tell a stored credential from a lost one.
    const ep = await studio.endpoint('tsec_send');
    const pw = ep.params.find((p) => p.name === 'Password');
    assert.strictEqual(pw.secret_set, true);
    assert.match(pw.secret_masked, /^•+/);
  });

  test('the password is not in a database dump — plain, base64 or hex', () => {
    const dump = execFileSync('pg_dump', ['--no-owner', process.env.TEST_DATABASE_URL],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.ok(!dump.includes(PASSWORD), 'plaintext');
    assert.ok(!dump.includes(Buffer.from(PASSWORD).toString('base64')), 'base64');
    assert.ok(!dump.includes(Buffer.from(PASSWORD).toString('hex')), 'hex');
  });

  test('someone entitled to it can still read it back', async () => {
    const value = await secrets.revealForParam({
      endpoint: 'tsec_send', param: 'Password',
      actor: 'superadmin@example.com', reason: 'test',
    });
    assert.strictEqual(value, PASSWORD);
  });

  test('the database refuses a sealed parameter that also has a plaintext', async () => {
    // Belt and braces for the application rule in studio.js. The obvious
    // migration path — seal it, forget to blank the old column — would leave
    // the password in both places and the screen showing the safe one.
    await assert.rejects(
      () => db.query(
        `INSERT INTO gateway.endpoint_params (endpoint, name, location, source, fixed_value)
         VALUES ('tsec_send','Rogue','query','secret','in-the-clear')`),
      /param_secret_has_no_plaintext/
    );
  });

  test('deleting the parameter takes its credential with it', async () => {
    await db.query(
      `INSERT INTO gateway.endpoint_params (endpoint, name, location, source)
       VALUES ('tsec_send','Temp','query','secret')`);
    await secrets.setForParam({
      endpoint: 'tsec_send', param: 'Temp', plaintext: 'short-lived', actor: 'a@b.c' });

    const before = await db.query(
      `SELECT 1 FROM gateway.endpoint_param_secrets WHERE endpoint='tsec_send' AND slot='Temp'`);
    assert.strictEqual(before.rows.length, 1);

    await db.query(
      `DELETE FROM gateway.endpoint_params WHERE endpoint='tsec_send' AND name='Temp'`);

    // A credential outliving the parameter it belonged to is a credential
    // nobody is looking after.
    const after = await db.query(
      `SELECT 1 FROM gateway.endpoint_param_secrets WHERE endpoint='tsec_send' AND slot='Temp'`);
    assert.strictEqual(after.rows.length, 0);
  });
});
