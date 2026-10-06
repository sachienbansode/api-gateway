'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const projection = require('../src/core/projection');

test('emits only whitelisted top-level fields', () => {
  const project = projection.compile(['id', 'status']);
  const out = project({
    id: 42,
    status: 'active',
    internal_notes: 'DO NOT SHARE',
    credit_score: 780,
    cost_price: 19.5,
  });
  assert.deepStrictEqual(out, { id: 42, status: 'active' });
});

test('a field added upstream later cannot appear in the output', () => {
  const project = projection.compile(['id']);
  // Simulates upstream adding a column next sprint.
  const out = project({ id: 1, brand_new_secret_column: 'oops' });
  assert.deepStrictEqual(out, { id: 1 });
});

test('projects nested paths and drops unlisted siblings', () => {
  const project = projection.compile(['id', 'address.city', 'address.country']);
  const out = project({
    id: 7,
    address: { city: 'Pune', country: 'IN', internal_geo_id: 'X-991', owner_email: 'a@b.c' },
  });
  assert.deepStrictEqual(out, { id: 7, address: { city: 'Pune', country: 'IN' } });
});

test('projects across arrays with []', () => {
  const project = projection.compile(['total', 'items[].id', 'items[].name']);
  const out = project({
    total: 2,
    internal_query_ms: 12,
    items: [
      { id: 1, name: 'A', margin: 0.4 },
      { id: 2, name: 'B', margin: 0.6 },
    ],
  });
  assert.deepStrictEqual(out, {
    total: 2,
    items: [
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ],
  });
});

test('handles a root-level array response', () => {
  const project = projection.compile(['[].id', '[].state']);
  const out = project([
    { id: 1, state: 'ok', secret: 'x' },
    { id: 2, state: 'bad', secret: 'y' },
  ]);
  assert.deepStrictEqual(out, [
    { id: 1, state: 'ok' },
    { id: 2, state: 'bad' },
  ]);
});

test('renames output fields without changing what is exposed', () => {
  const project = projection.compile(['display_name'], { display_name: 'name' });
  const out = project({ display_name: 'Acme', display_name_internal: 'nope' });
  assert.deepStrictEqual(out, { name: 'Acme' });
});

test('renames inside arrays', () => {
  const project = projection.compile(['items[].display_name'], {
    'items[].display_name': 'items[].name',
  });
  const out = project({ items: [{ display_name: 'A', secret: 1 }] });
  assert.deepStrictEqual(out, { items: [{ name: 'A' }] });
});

test('refuses to emit an object leaf, because that would leak its sub-fields', () => {
  const dropped = [];
  const project = projection.compile(['address']);
  const out = project(
    { address: { city: 'Pune', internal_geo_id: 'X-991' } },
    (path, kind) => dropped.push([path, kind])
  );
  // Nothing emitted, and the operator is told why.
  assert.deepStrictEqual(out, {});
  assert.deepStrictEqual(dropped, [['address', 'object']]);
});

test('allows an array of scalars but not an array of objects', () => {
  const okProject = projection.compile(['tags']);
  assert.deepStrictEqual(okProject({ tags: ['a', 'b'] }), { tags: ['a', 'b'] });

  const dropped = [];
  const badProject = projection.compile(['rows']);
  assert.deepStrictEqual(
    badProject({ rows: [{ a: 1 }] }, (p, k) => dropped.push([p, k])),
    {}
  );
  assert.deepStrictEqual(dropped, [['rows', 'array containing objects']]);
});

test('omits absent fields rather than emitting nulls', () => {
  const project = projection.compile(['id', 'missing_field']);
  assert.deepStrictEqual(project({ id: 1 }), { id: 1 });
});

test('preserves an explicit null', () => {
  const project = projection.compile(['id', 'deleted_at']);
  assert.deepStrictEqual(project({ id: 1, deleted_at: null }), { id: 1, deleted_at: null });
});

test('prototype pollution attempt in upstream body cannot poison the output', () => {
  const project = projection.compile(['id']);
  const hostile = JSON.parse('{"id":1,"__proto__":{"polluted":true}}');
  const out = project(hostile);
  assert.deepStrictEqual(out, { id: 1 });
  assert.strictEqual({}.polluted, undefined);
});

test('rejects a malformed whitelist path at compile time', () => {
  assert.throws(() => projection.compile(['bad path!']), /invalid segment/);
});

test('rejects a rename that changes the path shape', () => {
  assert.throws(
    () => projection.compile(['items[].id'], { 'items[].id': 'id' }),
    /same number of segments/
  );
});

test('rejects mixing root-array and object paths', () => {
  assert.throws(() => projection.compile(['[].id', 'total']), /cannot mix root-array/);
});
