'use strict';

/**
 * The admin session's two clocks.
 *
 * "Session timeout" means two things and a console that implements only one is
 * either annoying or insecure:
 *
 *   IDLE      time since the last request, reset by activity. The 4 hours
 *             people actually mean.
 *   ABSOLUTE  wall clock since sign-in, reset by nothing. Without it a tab
 *             that polls — or a person who clicks something every 29 minutes —
 *             holds a session forever and the idle timeout protects nobody.
 *
 * These run with a 4-second window and a 10-second ceiling so both clocks can
 * actually be watched firing, rather than asserted about in the abstract.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (t) => jwt.decode(t);

let session;
const saved = {};

before(() => {
  for (const k of ['JWT_SECRET', 'ADMIN_IDLE_MINUTES', 'ADMIN_SESSION_HOURS']) {
    saved[k] = process.env[k];
  }
  process.env.JWT_SECRET = 'test-secret-for-session-timing';
  process.env.ADMIN_IDLE_MINUTES = String(4 / 60);   // 4 seconds
  process.env.ADMIN_SESSION_HOURS = String(10 / 3600); // 10 seconds
  delete require.cache[require.resolve('../src/admin/session')];
  session = require('../src/admin/session');
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve('../src/admin/session')];
});

describe('admin session timeout', () => {
  test('the token lives for the idle window and carries the absolute ceiling', () => {
    const c = read(session.mint({ id: 7, email: 'a@b.com' }));
    assert.strictEqual(c.exp - c.iat, 4,
      'the JWT exp is the IDLE window — a leaked token is worth the idle window, not 8 hours');
    assert.strictEqual(c.gw_abs - c.iat, 10, 'and the ceiling rides along separately');
  });

  test('defaults are 4 hours idle, 8 hours absolute', () => {
    // The idle window was 30 minutes and is now 4 hours, because onboarding an
    // API is not a 30-minute job: the Studio's steps involve reading a
    // supplier's PDF, chasing a credential and waiting on somebody else, and
    // being signed out mid-way loses the form.
    //
    // The ABSOLUTE ceiling is deliberately unchanged. It is the clock that
    // actually bounds a stolen session — a laptop taken at lunchtime is
    // signed out by evening regardless of the idle window — so the two are
    // asserted separately rather than as one "timeout".
    const prevIdle = process.env.ADMIN_IDLE_MINUTES;
    const prevHours = process.env.ADMIN_SESSION_HOURS;
    delete process.env.ADMIN_IDLE_MINUTES;
    delete process.env.ADMIN_SESSION_HOURS;
    delete require.cache[require.resolve('../src/admin/session')];
    const fresh = require('../src/admin/session');
    try {
      assert.strictEqual(fresh.idleMinutes(), 240);
      assert.strictEqual(fresh.idleSeconds(), 14400);
      assert.strictEqual(fresh.hours(), 8, 'the ceiling is unchanged');
      const c = read(fresh.mint({ id: 1, email: 'a@b.com' }));
      assert.strictEqual(c.exp - c.iat, 14400);
      assert.strictEqual(c.gw_abs - c.iat, 8 * 3600);
    } finally {
      process.env.ADMIN_IDLE_MINUTES = prevIdle;
      process.env.ADMIN_SESSION_HOURS = prevHours;
      delete require.cache[require.resolve('../src/admin/session')];
      session = require('../src/admin/session');
    }
  });

  test('a burst of requests does not mint a token per request', () => {
    const c = read(session.mint({ id: 7, email: 'a@b.com' }));
    assert.strictEqual(session.renew(c), null,
      'renewing on every request would set a cookie on every image and poll');
  });

  test('activity slides the idle window and never the ceiling', async () => {
    const first = read(session.mint({ id: 7, email: 'a@b.com' }));
    await sleep(1600);                        // past 25% of a 4s window
    const next = session.renew(first);
    assert.ok(next, 'renewed once the threshold passed');
    const c = read(next);
    assert.ok(c.exp > first.exp, 'idle window moved forward');
    assert.strictEqual(c.gw_abs, first.gw_abs,
      'the ceiling did not move — a window that slid both ways would be no ceiling');
  });

  test('continuous activity still ends at the absolute cap', async () => {
    const first = read(session.mint({ id: 7, email: 'a@b.com' }));
    let cur = first;
    for (let i = 0; i < 12; i += 1) {
      await sleep(1100);
      const nxt = session.renew(cur);
      if (!nxt) break;
      cur = read(nxt);
      assert.strictEqual(cur.gw_abs, first.gw_abs, `ceiling held at renewal ${i}`);
    }
    assert.ok(Math.floor(Date.now() / 1000) >= first.gw_abs - 5, 'reached the ceiling');
    assert.strictEqual(session.renew(cur), null, 'renewal refused at the ceiling');
    assert.ok(cur.exp <= first.gw_abs + 5, 'the final token cannot outlive the ceiling');
  });

  test('a half-finished sign-in is never slid into a session', () => {
    // The MFA ticket is signed with the same secret because it has to survive
    // a round trip through a browser. Renewing it would hand a full session to
    // someone who never entered the second factor.
    const abs = Math.floor(Date.now() / 1000) + 600;
    assert.strictEqual(session.renew({ gw_otp: true, gw_abs: abs, iat: 0 }), null);
  });

  test('a token minted by the platform keeps the life the platform gave it', () => {
    assert.strictEqual(session.renew({ id: 1, email: 'x@y.z', iat: 0 }), null,
      'no gw_abs means it is not ours to extend');
  });

  test('the cookie outlives the token only long enough to explain itself', () => {
    const res = { out: [], append(_k, v) { this.out.push(v); } };
    session.setCookie(res, { secure: true, headers: {} },
      session.mint({ id: 7, email: 'a@b.com' }));
    const cookie = res.out[0];
    // Found by driving a real browser, not by reading the code: with the
    // cookie expiring at the same instant as the token, the browser simply
    // stopped sending it, the server saw an anonymous request, and every
    // timed-out administrator got a bare sign-in page instead of "signed out
    // after 30 minutes of inactivity". The grace buys that one message; the
    // token it carries is expired and rejected regardless.
    assert.match(cookie, /Max-Age=304\b/, cookie);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Path=\/admin/);
  });

  test('an expired token is rejected, and flagged as a timeout rather than a forgery', async () => {
    delete require.cache[require.resolve('../src/middleware/adminAuth')];
    const { makeAdminAuth } = require('../src/middleware/adminAuth');
    const auth = makeAdminAuth(null);

    // Signed already-expired rather than slept for. adminAuth verifies with
    // `clockTolerance: 5`, so a token with a 4-second life is still accepted
    // nine seconds later — sleeping past that is slow and, worse, a test that
    // passes for the wrong reason the day the tolerance changes.
    const token = jwt.sign(
      { id: 7, sub: '7', email: 'a@b.com', gw_abs: Math.floor(Date.now() / 1000) + 600 },
      process.env.JWT_SECRET,
      { expiresIn: '-60s' }
    );

    const err = await new Promise((resolve) => {
      auth(
        { headers: {}, cookies: { gw_admin: token }, method: 'GET', path: '/admin' },
        { set() {} },
        resolve
      );
    });
    assert.strictEqual(err.status, 401);
    assert.strictEqual(err.expiredSession, true,
      'so the sign-in page can say "signed out after 30 minutes" rather than ' +
      'implying something is wrong with the account');
    // The message sent to the caller is identical either way — an attacker
    // learns nothing from the distinction.
    assert.match(err.message, /Invalid or expired token/);
  });

  test('the absolute ceiling is enforced on the way in, not only when minting', async () => {
    delete require.cache[require.resolve('../src/middleware/adminAuth')];
    const { makeAdminAuth } = require('../src/middleware/adminAuth');
    const auth = makeAdminAuth(null);

    // A token whose own exp is comfortably in the future but whose ceiling has
    // passed: what a re-signed or clock-skewed token looks like. A ceiling only
    // enforced by the code that mints tokens is not a ceiling.
    const token = jwt.sign(
      { id: 7, sub: '7', email: 'a@b.com', gw_abs: Math.floor(Date.now() / 1000) - 1 },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const err = await new Promise((resolve) => {
      auth(
        { headers: {}, cookies: { gw_admin: token }, method: 'GET', path: '/admin' },
        { set() {} },
        resolve
      );
    });
    assert.strictEqual(err.status, 401);
    assert.strictEqual(err.expiredSession, true);
  });
});
