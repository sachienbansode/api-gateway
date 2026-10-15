'use strict';

/**
 * Who reaches the gateway console, and who may change what they see.
 *
 * The grant is written by the platform's Roles screen, so this file is really
 * a test of agreement with another application. Two conventions exist for the
 * access level and both have to work; the failure mode when they do not is not
 * a crash but silence — every role grants read-only, and nobody can tell why.
 */

const test = require('node:test');
const assert = require('node:assert');

const { pagesOf, accessOf, hasGatewayGrant, canEdit, PAGE_KEY } =
  require('../src/middleware/adminAuth');

const grant = (permissions) => {
  const pages = pagesOf(permissions);
  return { reaches: hasGatewayGrant(pages), edits: canEdit(pages, accessOf(permissions)) };
};

test('platform grants', async (t) => {
  await t.test('the page key is the one the platform registers', () => {
    assert.equal(PAGE_KEY, 'api-gateway');
  });

  await t.test('SuperAdmin reaches everything and may edit', () => {
    assert.deepEqual(grant({ pages: ['*'], actions: ['*'] }), { reaches: true, edits: true });
  });

  await t.test('a role with other pages but not ours does not reach it', () => {
    assert.deepEqual(
      grant({ pages: ['dashboard', 'users', 'roles'] }),
      { reaches: false, edits: false }
    );
  });

  await t.test("the platform's convention: plain entry, no access map, means edit", () => {
    // This is the shape the Roles screen writes when the level is left at its
    // default. Reading it as view-only would make every grant made in that UI
    // read-only, which is the bug this test exists to prevent.
    assert.deepEqual(grant({ pages: ['api-gateway'] }), { reaches: true, edits: true });
  });

  await t.test("the platform's convention: access 'view' means view", () => {
    assert.deepEqual(
      grant({ pages: ['api-gateway'], access: { 'api-gateway': 'view' } }),
      { reaches: true, edits: false }
    );
  });

  await t.test("the platform's convention: access 'edit' means edit", () => {
    assert.deepEqual(
      grant({ pages: ['api-gateway'], access: { 'api-gateway': 'edit' } }),
      { reaches: true, edits: true }
    );
  });

  await t.test("another page's view level does not affect ours", () => {
    assert.deepEqual(
      grant({ pages: ['api-gateway', 'dashboard'], access: { dashboard: 'view' } }),
      { reaches: true, edits: true }
    );
  });

  await t.test("the gateway's own convention: an explicit suffix still works", () => {
    assert.deepEqual(grant({ pages: ['api-gateway:edit'] }), { reaches: true, edits: true });
    assert.deepEqual(grant({ pages: ['api-gateway:view'] }), { reaches: true, edits: false });
  });

  await t.test('an explicit suffix beats the access map', () => {
    // A suffix is a deliberate statement about this one page; the access map
    // is a default. When they disagree, the specific one wins.
    assert.deepEqual(
      grant({ pages: ['api-gateway:edit'], access: { 'api-gateway': 'view' } }),
      { reaches: true, edits: true }
    );
  });

  await t.test('permissions as a JSON string, which some drivers return', () => {
    assert.deepEqual(
      grant('{"pages":["api-gateway"],"access":{"api-gateway":"view"}}'),
      { reaches: true, edits: false }
    );
  });

  await t.test('junk is refused rather than guessed at', () => {
    for (const bad of [null, undefined, '', 'not json', {}, { pages: 'api-gateway' }, { pages: null }]) {
      assert.deepEqual(grant(bad), { reaches: false, edits: false }, `input: ${JSON.stringify(bad)}`);
    }
  });

  await t.test('a page merely CONTAINING the key is not the key', () => {
    // "api-gateway-admin" is a different page. Substring matching here would
    // hand the console to whoever named a page carelessly.
    assert.deepEqual(
      grant({ pages: ['api-gateway-admin', 'my-api-gateway'] }),
      { reaches: false, edits: false }
    );
  });
});
