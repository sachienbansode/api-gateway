'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const projection = require('../src/core/projection');
const { FieldObserver } = require('../src/core/discovery');

// ---------------------------------------------------------------------------
// Redact mode
// ---------------------------------------------------------------------------

test('redact drops the listed fields and forwards everything else', () => {
  const redact = projection.compileRedact(['internal_margin', 'created_by_user_id']);
  const out = redact({
    id: 5,
    total: 100,
    internal_margin: 0.42,
    created_by_user_id: 'u-1',
    customer: { name: 'Acme' },
  });
  assert.deepStrictEqual(out, { id: 5, total: 100, customer: { name: 'Acme' } });
});

test('redact drops a whole nested object when named', () => {
  const redact = projection.compileRedact(['cost_breakdown']);
  const out = redact({ id: 1, cost_breakdown: { labour: 10, parts: 5 }, total: 20 });
  assert.deepStrictEqual(out, { id: 1, total: 20 });
});

test('redact drops a nested leaf without touching its siblings', () => {
  const redact = projection.compileRedact(['address.internal_geo_id']);
  const out = redact({ address: { city: 'Pune', country: 'IN', internal_geo_id: 'X-1' } });
  assert.deepStrictEqual(out, { address: { city: 'Pune', country: 'IN' } });
});

test('redact drops one field from every element of an array', () => {
  const redact = projection.compileRedact(['line_items[].unit_cost']);
  const out = redact({
    line_items: [
      { sku: 'A', qty: 1, unit_cost: 5 },
      { sku: 'B', qty: 2, unit_cost: 7 },
    ],
  });
  assert.deepStrictEqual(out, {
    line_items: [
      { sku: 'A', qty: 1 },
      { sku: 'B', qty: 2 },
    ],
  });
});

test('redact does not mutate the upstream body it was given', () => {
  const original = { id: 1, secret: 'x' };
  const redact = projection.compileRedact(['secret']);
  redact(original);
  assert.strictEqual(original.secret, 'x', 'caller’s object is untouched');
});

test('redact is honest about its weakness: a NEW upstream field is forwarded', () => {
  const redact = projection.compileRedact(['known_secret']);
  const out = redact({ id: 1, known_secret: 'hidden', newly_added_by_upstream: 'LEAKED' });
  // This is the documented trade-off, asserted so nobody is surprised by it.
  assert.strictEqual(out.newly_added_by_upstream, 'LEAKED');
  assert.strictEqual(out.known_secret, undefined);
});

test('a whitelist on the same payload does NOT forward the new field', () => {
  const project = projection.compile(['id']);
  const out = project({ id: 1, known_secret: 'hidden', newly_added_by_upstream: 'LEAKED' });
  assert.deepStrictEqual(out, { id: 1 });
});

test('redact strips prototype-polluting keys', () => {
  const redact = projection.compileRedact(['secret']);
  const hostile = JSON.parse('{"id":1,"secret":2,"__proto__":{"polluted":true}}');
  const out = redact(hostile);
  assert.deepStrictEqual(out, { id: 1 });
  assert.strictEqual({}.polluted, undefined);
});

test('redact requires a non-empty exclusion list', () => {
  assert.throws(() => projection.compileRedact([]), /non-empty/);
});

// ---------------------------------------------------------------------------
// Passthrough mode
// ---------------------------------------------------------------------------

test('passthrough forwards the body verbatim', () => {
  const pass = projection.compilePassthrough();
  const body = { a: 1, b: { c: [1, 2, 3] }, d: null };
  assert.deepStrictEqual(pass(body), body);
});

test('passthrough still strips prototype-polluting keys', () => {
  const pass = projection.compilePassthrough();
  const hostile = JSON.parse('{"a":1,"__proto__":{"polluted":true}}');
  assert.deepStrictEqual(pass(hostile), { a: 1 });
  assert.strictEqual({}.polluted, undefined);
});

// ---------------------------------------------------------------------------
// Discovery — the no-UI field authoring path
// ---------------------------------------------------------------------------

test('enumeratePaths finds leaf paths in whitelist syntax', () => {
  const paths = projection.enumeratePaths({
    id: 1,
    address: { city: 'Pune', geo: { lat: 1.0 } },
    tags: ['a', 'b'],
    items: [{ sku: 'A', qty: 1 }],
  });
  assert.deepStrictEqual([...paths].sort(), [
    'address.city',
    'address.geo.lat',
    'id',
    'items[].qty',
    'items[].sku',
    'tags',
  ]);
});

test('enumeratePaths handles a root-level array', () => {
  const paths = projection.enumeratePaths([{ id: 1, name: 'a' }]);
  assert.deepStrictEqual([...paths].sort(), ['[].id', '[].name']);
});

test('enumeratePaths records names only — no values leak into discovery', () => {
  const paths = projection.enumeratePaths({ card_number: '4111111111111111' });
  assert.deepStrictEqual([...paths], ['card_number']);
  assert.ok(![...paths].some((p) => p.includes('4111')));
});

test('observer accumulates paths across responses with differing shapes', () => {
  const observer = new FieldObserver({ enabled: true, file: '/tmp/never-written.json' });
  observer.load = () => {};
  const endpoint = { name: 'ep1', response: { mode: 'redact' } };

  observer.observe(endpoint, { id: 1, a: 1 });
  observer.observe(endpoint, { id: 2, b: 2 }); // different shape, same endpoint

  assert.deepStrictEqual(observer.snapshot().ep1, ['a', 'b', 'id']);
  observer.stop = () => {};
});

test('observer warns when a never-before-seen field appears on an unfiltered endpoint', () => {
  const warnings = [];
  const logger = { warn: (o, m) => warnings.push({ o, m }), info: () => {} };
  const observer = new FieldObserver({ enabled: true, file: '/tmp/never-written2.json', logger });
  const endpoint = { name: 'ep2', response: { mode: 'passthrough' } };

  // First sighting establishes the baseline — no warning, nothing to compare to.
  observer.observe(endpoint, { id: 1 });
  assert.strictEqual(warnings.length, 0);

  // Upstream adds a column. This is now reaching the vendor.
  observer.observe(endpoint, { id: 2, newly_added: 'x' });
  assert.strictEqual(warnings.length, 1);
  assert.deepStrictEqual(warnings[0].o.newFields, ['newly_added']);
  assert.match(warnings[0].m, /reaching the vendor/);
});

test('observer does not warn for a new field on a whitelist endpoint', () => {
  const warnings = [];
  const logger = { warn: (o, m) => warnings.push({ o, m }), info: () => {} };
  const observer = new FieldObserver({ enabled: true, file: '/tmp/never-written3.json', logger });
  const endpoint = { name: 'ep3', response: { mode: 'whitelist' } };

  observer.observe(endpoint, { id: 1 });
  observer.observe(endpoint, { id: 2, newly_added: 'x' });
  // The projector already dropped it, so this is informational, not a warning.
  assert.strictEqual(warnings.length, 0);
});

test('a malformed body never breaks discovery', () => {
  const observer = new FieldObserver({ enabled: true, file: '/tmp/never-written4.json' });
  const endpoint = { name: 'ep4', response: { mode: 'redact' } };
  assert.doesNotThrow(() => observer.observe(endpoint, null));
  assert.doesNotThrow(() => observer.observe(endpoint, 'a string'));
});
