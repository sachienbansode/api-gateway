'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const adminDb = require('../src/db/adminPool');

// bcrypt cost 4: fast enough for a test suite, and the hash FORMAT is what the
// config guard checks, not the cost.
const PASSWORD = 'break-glass-pw-2026';
const HASH = bcrypt.hashSync(PASSWORD, 4);
const SECRET = 'test-jwt-secret-value';

const silent = { info() {}, warn() {}, error() {} };

/** Load the module fresh so PAGE_KEY picks up the current env. */
function loadAuth() {
  delete require.cache[require.resolve('../src/middleware/adminAuth')];
  return require('../src/middleware/adminAuth');
}

function resetEnv() {
  delete process.env.SUPERADMIN_ENABLED;
  delete process.env.SUPERADMIN_EMAIL;
  delete process.env.SUPERADMIN_PASSWORD_HASH;
  delete process.env.GATEWAY_PAGE_KEY;
  process.env.JWT_SECRET = SECRET;
  delete process.env.JWT_ISSUER;
}

/** Drive the middleware without an HTTP server. */
async function run(mw, { method = 'GET', headers = {}, path = '/admin/vendors' } = {}) {
  const req = { method, headers, path, ip: '10.0.0.1', id: 'req-1' };
  const res = { headers: {}, set(k, v) { this.headers[k] = v; } };
  return new Promise((resolve) => {
    mw(req, res, (err) => resolve({ err, req, res }));
  });
}

/** Replace the platform lookup with a fixture. */
function stubPlatform(rowByIdOrError) {
  adminDb.isEnabled = () => true;
  adminDb.one = async (_sql, params) => {
    if (typeof rowByIdOrError === 'function') return rowByIdOrError(params[0]);
    throw rowByIdOrError;
  };
}

function token(payload) {
  return jwt.sign(payload, SECRET);
}

// ---------------------------------------------------------------------------
// Configuration guard
// ---------------------------------------------------------------------------

test('superadmin config: enabled without a hash is refused at boot', () => {
  resetEnv();
  process.env.SUPERADMIN_ENABLED = 'true';
  process.env.SUPERADMIN_EMAIL = 'ops@example.com';
  const { checkSuperadminConfig } = loadAuth();
  assert.throws(() => checkSuperadminConfig(), /SUPERADMIN_PASSWORD_HASH is not set/);
});

test('superadmin config: a PLAINTEXT password is refused, not silently accepted', () => {
  resetEnv();
  process.env.SUPERADMIN_ENABLED = 'true';
  process.env.SUPERADMIN_EMAIL = 'ops@example.com';
  process.env.SUPERADMIN_PASSWORD_HASH = 'hunter2';
  const { checkSuperadminConfig } = loadAuth();
  assert.throws(() => checkSuperadminConfig(), /not a bcrypt hash/);
});

test('superadmin config: disabled needs nothing else set', () => {
  resetEnv();
  const { checkSuperadminConfig } = loadAuth();
  assert.deepStrictEqual(checkSuperadminConfig(), { enabled: false });
});

// ---------------------------------------------------------------------------
// Break-glass superadmin
// ---------------------------------------------------------------------------

function basic(user, pass) {
  return { authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') };
}

test('superadmin is OFF by default — correct credentials still do not authenticate', async () => {
  resetEnv();
  process.env.SUPERADMIN_EMAIL = 'ops@example.com';
  process.env.SUPERADMIN_PASSWORD_HASH = HASH;
  adminDb.isEnabled = () => false;
  const { makeAdminAuth } = loadAuth();
  const { err } = await run(makeAdminAuth(silent), { headers: basic('ops@example.com', PASSWORD) });
  assert.strictEqual(err.status, 401);
});

test('superadmin: correct credentials grant full access', async () => {
  resetEnv();
  process.env.SUPERADMIN_ENABLED = 'true';
  process.env.SUPERADMIN_EMAIL = 'ops@example.com';
  process.env.SUPERADMIN_PASSWORD_HASH = HASH;
  const { makeAdminAuth } = loadAuth();
  const { err, req } = await run(makeAdminAuth(silent), {
    headers: basic('ops@example.com', PASSWORD),
  });
  assert.strictEqual(err, undefined);
  assert.strictEqual(req.admin.source, 'env');
  assert.strictEqual(req.admin.canEdit, true);
});

test('superadmin: wrong password is refused', async () => {
  resetEnv();
  process.env.SUPERADMIN_ENABLED = 'true';
  process.env.SUPERADMIN_EMAIL = 'ops@example.com';
  process.env.SUPERADMIN_PASSWORD_HASH = HASH;
  const { makeAdminAuth } = loadAuth();
  const { err, res } = await run(makeAdminAuth(silent), {
    headers: basic('ops@example.com', 'wrong'),
  });
  assert.strictEqual(err.status, 401);
  assert.strictEqual(res.headers['WWW-Authenticate'], 'Basic realm="gateway-admin"');
});

test('superadmin: right password under the wrong email is refused', async () => {
  resetEnv();
  process.env.SUPERADMIN_ENABLED = 'true';
  process.env.SUPERADMIN_EMAIL = 'ops@example.com';
  process.env.SUPERADMIN_PASSWORD_HASH = HASH;
  const { makeAdminAuth } = loadAuth();
  const { err } = await run(makeAdminAuth(silent), {
    headers: basic('someone-else@example.com', PASSWORD),
  });
  assert.strictEqual(err.status, 401);
});

test('superadmin works even when the platform database is unreachable', async () => {
  resetEnv();
  process.env.SUPERADMIN_ENABLED = 'true';
  process.env.SUPERADMIN_EMAIL = 'ops@example.com';
  process.env.SUPERADMIN_PASSWORD_HASH = HASH;
  stubPlatform(new Error('ECONNREFUSED'));
  const { makeAdminAuth } = loadAuth();
  const { err, req } = await run(makeAdminAuth(silent), {
    headers: basic('ops@example.com', PASSWORD),
  });
  assert.strictEqual(err, undefined, 'break-glass must not depend on the platform');
  assert.strictEqual(req.admin.source, 'env');
});

// ---------------------------------------------------------------------------
// Platform JWT
// ---------------------------------------------------------------------------

test('no credentials at all is 401', async () => {
  resetEnv();
  const { makeAdminAuth } = loadAuth();
  const { err } = await run(makeAdminAuth(silent));
  assert.strictEqual(err.status, 401);
});

test('a token signed with the wrong secret is refused', async () => {
  resetEnv();
  stubPlatform(() => ({ id: 1, email: 'a@b.c', roleId: 1, role: 'Admin', permissions: { pages: ['*'] } }));
  const { makeAdminAuth } = loadAuth();
  const bad = jwt.sign({ id: 1 }, 'a-different-secret');
  const { err } = await run(makeAdminAuth(silent), { headers: { authorization: `Bearer ${bad}` } });
  assert.strictEqual(err.status, 401);
});

test('an EXPIRED token is refused', async () => {
  resetEnv();
  stubPlatform(() => ({ id: 1, email: 'a@b.c', roleId: 1, role: 'Admin', permissions: { pages: ['*'] } }));
  const { makeAdminAuth } = loadAuth();
  const expired = jwt.sign({ id: 1, exp: Math.floor(Date.now() / 1000) - 3600 }, SECRET);
  const { err } = await run(makeAdminAuth(silent), {
    headers: { authorization: `Bearer ${expired}` },
  });
  assert.strictEqual(err.status, 401);
});

test('a valid token for an account with NO gateway grant is 403, not 401', async () => {
  resetEnv();
  stubPlatform(() => ({
    id: 7, email: 'etl@example.com', roleId: 3, role: 'ETL Operator',
    permissions: { pages: ['ofs-desk', 'uploader'] },
  }));
  const { makeAdminAuth } = loadAuth();
  const { err } = await run(makeAdminAuth(silent), {
    headers: { authorization: `Bearer ${token({ id: 7 })}` },
  });
  assert.strictEqual(err.status, 403);
});

test('an inactive account is refused even with a valid token', async () => {
  resetEnv();
  // The SQL filters on is_active, so an inactive user simply returns no row.
  stubPlatform(() => null);
  const { makeAdminAuth } = loadAuth();
  const { err } = await run(makeAdminAuth(silent), {
    headers: { authorization: `Bearer ${token({ id: 9 })}` },
  });
  assert.strictEqual(err.status, 401);
});

test('a bare page grant is READ-ONLY: GET passes, POST is 403', async () => {
  resetEnv();
  stubPlatform(() => ({
    id: 2, email: 'viewer@example.com', roleId: 4, role: 'Viewer',
    permissions: { pages: ['api-gateway'] },
  }));
  const { makeAdminAuth } = loadAuth();
  const mw = makeAdminAuth(silent);

  const get = await run(mw, { headers: { authorization: `Bearer ${token({ id: 2 })}` } });
  assert.strictEqual(get.err, undefined);
  assert.strictEqual(get.req.admin.canEdit, false);

  const post = await run(mw, {
    method: 'POST',
    headers: { authorization: `Bearer ${token({ id: 2 })}` },
  });
  assert.strictEqual(post.err.status, 403);
  assert.match(post.err.message, /api-gateway:edit/);
});

test('an :edit grant may write', async () => {
  resetEnv();
  stubPlatform(() => ({
    id: 3, email: 'editor@example.com', roleId: 5, role: 'Gateway Admin',
    permissions: { pages: ['api-gateway:edit'] },
  }));
  const { makeAdminAuth } = loadAuth();
  const { err, req } = await run(makeAdminAuth(silent), {
    method: 'POST',
    headers: { authorization: `Bearer ${token({ id: 3 })}` },
  });
  assert.strictEqual(err, undefined);
  assert.strictEqual(req.admin.canEdit, true);
});

test("'*' grants everything", async () => {
  resetEnv();
  stubPlatform(() => ({
    id: 4, email: 'sa@example.com', roleId: 1, role: 'SuperAdmin',
    permissions: { pages: ['*'] },
  }));
  const { makeAdminAuth } = loadAuth();
  const { err, req } = await run(makeAdminAuth(silent), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token({ id: 4 })}` },
  });
  assert.strictEqual(err, undefined);
  assert.strictEqual(req.admin.role, 'SuperAdmin');
});

test('permissions stored as a TEXT column parse the same as JSONB', async () => {
  resetEnv();
  stubPlatform(() => ({
    id: 5, email: 'text@example.com', roleId: 6, role: 'Gateway Admin',
    permissions: JSON.stringify({ pages: ['api-gateway:edit'] }),
  }));
  const { makeAdminAuth } = loadAuth();
  const { err, req } = await run(makeAdminAuth(silent), {
    method: 'POST',
    headers: { authorization: `Bearer ${token({ id: 5 })}` },
  });
  assert.strictEqual(err, undefined);
  assert.strictEqual(req.admin.canEdit, true);
});

test('an unreachable platform fails CLOSED with 503, never open', async () => {
  resetEnv();
  stubPlatform(new Error('ECONNREFUSED 13.234.135.5:5432'));
  const { makeAdminAuth } = loadAuth();
  const { err } = await run(makeAdminAuth(silent), {
    headers: { authorization: `Bearer ${token({ id: 1 })}` },
  });
  assert.strictEqual(err.status, 503);
});

test('an unconfigured platform directory is 503, not an open door', async () => {
  resetEnv();
  adminDb.isEnabled = () => false;
  const { makeAdminAuth } = loadAuth();
  const { err } = await run(makeAdminAuth(silent), {
    headers: { authorization: `Bearer ${token({ id: 1 })}` },
  });
  assert.strictEqual(err.status, 503);
});

test('JWT_ISSUER is enforced when set', async () => {
  resetEnv();
  process.env.JWT_ISSUER = 'omnenest-staging-api';
  stubPlatform(() => ({ id: 1, email: 'a@b.c', roleId: 1, role: 'SuperAdmin', permissions: { pages: ['*'] } }));
  const { makeAdminAuth } = loadAuth();

  const wrong = jwt.sign({ id: 1 }, SECRET, { issuer: 'somewhere-else' });
  const bad = await run(makeAdminAuth(silent), { headers: { authorization: `Bearer ${wrong}` } });
  assert.strictEqual(bad.err.status, 401);

  const right = jwt.sign({ id: 1 }, SECRET, { issuer: 'omnenest-staging-api' });
  const ok = await run(makeAdminAuth(silent), { headers: { authorization: `Bearer ${right}` } });
  assert.strictEqual(ok.err, undefined);
});

test('a custom GATEWAY_PAGE_KEY is honoured', async () => {
  resetEnv();
  process.env.GATEWAY_PAGE_KEY = 'vendor-gateway';
  stubPlatform(() => ({
    id: 8, email: 'x@y.z', roleId: 2, role: 'Ops',
    permissions: { pages: ['vendor-gateway:edit'] },
  }));
  const { makeAdminAuth, PAGE_KEY } = loadAuth();
  assert.strictEqual(PAGE_KEY, 'vendor-gateway');
  const { err } = await run(makeAdminAuth(silent), {
    method: 'POST',
    headers: { authorization: `Bearer ${token({ id: 8 })}` },
  });
  assert.strictEqual(err, undefined);
});

test('a vendor API key is NOT an admin credential', async () => {
  resetEnv();
  process.env.SUPERADMIN_ENABLED = 'true';
  process.env.SUPERADMIN_EMAIL = 'ops@example.com';
  process.env.SUPERADMIN_PASSWORD_HASH = HASH;
  adminDb.isEnabled = () => false;
  const { makeAdminAuth } = loadAuth();
  const { err } = await run(makeAdminAuth(silent), {
    headers: { 'x-api-key': 'vk_acme_whatever' },
  });
  assert.strictEqual(err.status, 401);
});
