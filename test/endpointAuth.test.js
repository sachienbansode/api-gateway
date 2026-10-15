'use strict';

/**
 * Endpoint-scoped credentials.
 *
 * The property under test is narrow and worth stating plainly: when an
 * endpoint carries its own credential, the supplier's must not appear on that
 * call in ANY form — not as a second header, not as a query parameter, not as
 * a fallback. The reason to scope a credential to one endpoint is that the
 * wider one is not allowed to be used there, and a quiet fallback would undo
 * the whole feature while looking like it worked.
 */

const test = require('node:test');
const assert = require('node:assert');

const { authFor, buildUpstreamHeaders } = require('../src/core/upstream');

const UP = {
  baseUrl: 'https://supplier.example.com',
  auth: { type: 'bearer', token: 'SUPPLIER-WIDE' },
};

test('endpoint credential override', async (t) => {
  await t.test('an endpoint with no auth block uses the upstream credential', () => {
    const h = buildUpstreamHeaders(UP, {
      requestId: 'r1', hasBody: false, auth: authFor(UP, { name: 'plain' }),
    });
    assert.equal(h.authorization, 'Bearer SUPPLIER-WIDE');
  });

  await t.test('an endpoint with its own bearer sends that one instead', () => {
    const ep = { name: 'metered', auth: { type: 'bearer', token: 'ENDPOINT-ONLY' } };
    const h = buildUpstreamHeaders(UP, { requestId: 'r1', hasBody: false, auth: authFor(UP, ep) });
    assert.equal(h.authorization, 'Bearer ENDPOINT-ONLY');
  });

  await t.test('the supplier credential appears nowhere on an overridden call', () => {
    const ep = { name: 'metered', auth: { type: 'header', name: 'X-Key', value: 'ENDPOINT-ONLY' } };
    const h = buildUpstreamHeaders(UP, { requestId: 'r1', hasBody: true, auth: authFor(UP, ep) });
    assert.equal(h['x-key'], 'ENDPOINT-ONLY');
    assert.equal(h.authorization, undefined);
    assert.ok(
      !JSON.stringify(h).includes('SUPPLIER-WIDE'),
      'the supplier credential leaked into an overridden request'
    );
  });

  await t.test('an override may use a different scheme from its upstream', () => {
    const ep = { name: 'basicish', auth: { type: 'basic', username: 'u', password: 'p' } };
    const h = buildUpstreamHeaders(UP, { requestId: 'r1', hasBody: false, auth: authFor(UP, ep) });
    assert.equal(h.authorization, 'Basic ' + Buffer.from('u:p').toString('base64'));
  });

  await t.test('an override of "none" sends no credential at all', () => {
    const ep = { name: 'public', auth: { type: 'none' } };
    const h = buildUpstreamHeaders(UP, { requestId: 'r1', hasBody: false, auth: authFor(UP, ep) });
    assert.equal(h.authorization, undefined);
    assert.ok(!JSON.stringify(h).includes('SUPPLIER-WIDE'));
  });

  await t.test('authFor is total: it never merges the two', () => {
    const ep = { name: 'x', auth: { type: 'bearer', token: 'OWN' } };
    assert.deepEqual(authFor(UP, ep), { type: 'bearer', token: 'OWN' });
    assert.deepEqual(authFor(UP, { name: 'y' }), UP.auth);
    assert.deepEqual(authFor(UP, null), UP.auth);
    assert.deepEqual(authFor({ baseUrl: 'x' }, null), { type: 'none' });
  });
});
