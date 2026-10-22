'use strict';

/**
 * Telling somebody what kind of API they are looking at.
 *
 * Every case below is one that actually caused trouble on this project, which
 * is the only reason it is in here. The test is not that a label is produced
 * — it is that the CONSEQUENCE is stated, because a label nobody can act on
 * is what makes people stop reading the panel.
 */

const { test, describe: suite } = require('node:test');
const assert = require('node:assert');

const { classify, duplicateSamples } = require('../src/admin/apiShape');
const { describe } = require('../src/admin/studioTester');

const run = (result, opts) => {
  const d = result.body === undefined || result.body === null ? [] : describe(result.body);
  return classify(result, d, opts || {});
};
const text = (c) => c.findings.map((f) => `${f.level}:${f.title} ${f.text}`).join('\n');
const levels = (c) => c.findings.map((f) => f.level);

suite('what kind of API is this', () => {
  test('a list of records says the fields repeat', () => {
    const c = run({ status: 200, ms: 100, body: {
      status: 'ok', count: 2,
      data: [{ dpId: '12034500', poa: 'Y' }, { dpId: 'IN302679', poa: 'N' }],
    } });
    assert.match(c.kind, /list of 2 record/i);
    assert.match(c.kind, /data/);
    // The point of saying so: ticking one field yields one per item.
    assert.match(text(c), /for each of the 2 item/i);
  });

  test('a one-item list is flagged, because it looks like a single record', () => {
    const c = run({ status: 200, body: { rows: [{ id: 1 }] } });
    assert.match(text(c), /Only one item came back/);
    assert.match(text(c), /until the day it does not/);
  });

  test('an empty list is a dead end and says so', () => {
    const c = run({ status: 200, body: [] });
    assert.match(c.kind, /list of 0/);
    assert.match(text(c), /no fields to discover/i);
  });

  test('a non-JSON response stops the whitelist, and explains why', () => {
    // The ACL SMS gateway: answers "1701|9199...|OK" and the gateway currently
    // cannot wrap it at all.
    const c = run({ status: 200, ms: 280, body: null, raw: '1701|919999999999|OK',
      parseError: 'Unexpected token 1' }, { method: 'POST', authType: 'query' });
    assert.strictEqual(c.kind, 'Not JSON');
    assert.ok(levels(c).includes('stop'), 'this is a blocker, not a note');
    assert.match(text(c), /no fields to build from/i);
    // Named so somebody recognises their own case rather than wondering.
    assert.match(text(c), /SMS and payment gateways/i);
  });

  test('a write API warns that a retry does it twice', () => {
    const c = run({ status: 200, body: { ok: true } }, { method: 'POST' });
    assert.match(text(c), /retries would do it a second time/i);
    assert.match(text(c), /idempotency/i);
    // The reason it matters, in terms somebody cares about.
    assert.match(text(c), /an SMS, a payment, an order/i);
  });

  test('a read API does not warn about retries', () => {
    const c = run({ status: 200, body: { ok: true } }, { method: 'GET' });
    assert.doesNotMatch(text(c), /second time/i);
  });

  test('slow against its own timeout quotes the timeout', () => {
    // CompanyMaster: 15,003 ms against a 15,000 ms limit. The consumer fails
    // identically, which is the part the Studio used not to say.
    const c = run({ status: 200, ms: 15003, bytes: 4_100_000, truncated: true,
      body: { data: [{ a: 1 }] } }, { timeoutMs: 15000 });
    assert.match(text(c), /15003 ms/);
    assert.match(text(c), /close to this supplier's 15000 ms timeout/i);
    assert.match(text(c), /consumer calling this would fail the same way/i);
  });

  test('a paged response warns that consumers would get page one and stop', () => {
    const c = run({ status: 200, body: { page: 1, totalPages: 34, rows: [{ id: 1 }] } });
    assert.match(text(c), /paged/i);
    assert.match(text(c), /only the first page and believe it is everything/i);
  });

  test('a credential in the URL is called out as logged by the supplier', () => {
    const c = run({ status: 200, body: { ok: 1 } }, { authType: 'query' });
    assert.match(text(c), /credential travels in the URL/i);
    assert.match(text(c), /the supplier logs it/i);
  });

  test('a failed call refuses to guess anything else', () => {
    const c = run({ error: 'no answer within 15000 ms' });
    assert.strictEqual(c.kind, 'Not known yet');
    assert.strictEqual(c.findings.length, 1, 'one instruction, not a page of speculation');
    assert.ok(levels(c).includes('stop'));
  });

  test('an error status says the fields describe the error, not the data', () => {
    const c = run({ status: 401, body: { error: 'unauthorized' } });
    assert.match(text(c), /describe the error, not the data/i);
  });

  test('fields sharing a value are surfaced — the demat case', () => {
    // dpAccount and dpCode both hold 00061535; dpName and depository both
    // hold CDSL. Indistinguishable by name, and both pairs would otherwise be
    // exposed to consumers forever.
    const c = run({ status: 200, body: { data: [
      { dpId: '12034500', dpName: 'CDSL', dpAccount: '00061535',
        dpCode: '00061535', depository: 'CDSL' }] } });
    const t = text(c);
    assert.match(t, /dpAccount and data\[\]\.dpCode held the same value/);
    assert.match(t, /00061535/);
    assert.match(t, /the supplier repeating itself/i);
  });

  test('coincidental short values are not reported as duplicates', () => {
    // 'Y'/'N' flags, nulls and empty strings collide constantly and mean
    // nothing. Reporting them would bury the one pair that matters.
    const dup = duplicateSamples([
      { path: 'a.poa', sample: 'Y' }, { path: 'a.active', sample: 'Y' },
      { path: 'a.x', sample: null }, { path: 'a.y', sample: null },
      { path: 'a.z', sample: '' }, { path: 'a.w', sample: '' },
      { path: 'a.acc', sample: '00061535' }, { path: 'a.code', sample: '00061535' },
    ]);
    assert.strictEqual(dup.length, 1, 'only the long shared value');
    assert.strictEqual(dup[0].sample, '00061535');
  });

  test('every finding carries a consequence, not just a label', () => {
    const cases = [
      run({ status: 200, body: { data: [{ a: 1 }, { a: 2 }] } }, { method: 'POST', authType: 'query' }),
      run({ status: 200, ms: 9000, body: [] }),
      run({ status: 200, body: null, raw: 'x' }),
    ];
    for (const c of cases) {
      for (const f of c.findings) {
        assert.ok(f.title && f.text, 'both halves present');
        // A one-clause note is a label. The threshold is crude on purpose:
        // it catches the "Returns an array." style of uselessness.
        assert.ok(f.text.length > 40, `too thin to act on: "${f.text}"`);
        assert.ok(['info', 'warn', 'stop'].includes(f.level));
      }
    }
  });
});
