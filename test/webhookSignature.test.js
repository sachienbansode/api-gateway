'use strict';

/**
 * Proving an inbound call came from the supplier.
 *
 * This is the only thing between the public internet and an endpoint that
 * writes into internal systems, so these tests spend most of their effort on
 * the ways a verifier passes something it should not.
 *
 * The payloads are FlipitMoney's own, from their documentation, including the
 * one where `youtube_link` is null and `share_asset_link` is null — nulls in a
 * signed field are exactly the kind of thing that turns into an exception at
 * 3am rather than a clean rejection.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { verifySignature, signedMessage, ipAllowed, normaliseIp, WebhookError } =
  require('../src/core/webhook');

const SECRET = 'a-key-flipit-would-have-emailed-us';

/** FlipitMoney's stocks sample, trimmed to the fields that matter here. */
const BODY = {
  title: 'Kotak Mahindra Bank surges 6% on $690 million in MSCI inflows',
  slug: 'kotak-mahindra-bank-surges-6-on-690-million-in-msci-inflows',
  youtube_link: null,
  companies: [{ symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank Ltd.' }],
  created_at: '1681193106',
  updated_at: '1681193108',
};

const RAW = JSON.stringify(BODY);

const HOOK = {
  name: 'flipit_news',
  signature_scheme: 'hmac_sha256_hex',
  signature_header: 'X-Flipit-Checksum',
  // Their documentation: "message = slug + updated_at".
  signature_message: '{slug}{updated_at}',
  ip_allowlist: [],
};

function checksum(message, secret = SECRET, encoding = 'hex') {
  return crypto.createHmac('sha256', secret).update(message).digest(encoding);
}

function call(hook, headers, { raw = RAW, parsed = BODY, secret = SECRET } = {}) {
  return verifySignature(hook, { rawBody: raw, parsed, headers, secret });
}

describe('webhook signature verification', () => {
  test('a correctly signed FlipitMoney call is accepted', () => {
    const sig = checksum(BODY.slug + BODY.updated_at);
    const r = call(HOOK, { 'x-flipit-checksum': sig });
    assert.strictEqual(r.verified, true);
  });

  test('the same body with a different key is rejected', () => {
    const sig = checksum(BODY.slug + BODY.updated_at, 'somebody-elses-key');
    assert.throws(() => call(HOOK, { 'x-flipit-checksum': sig }),
      (e) => e.outcome === 'bad_signature' && e.status === 401);
  });

  test('a changed updated_at invalidates the signature', () => {
    // Which is the part of their scheme that DOES work: an old payload cannot
    // be replayed as a newer version of itself.
    const sig = checksum(BODY.slug + BODY.updated_at);
    const tampered = { ...BODY, updated_at: '9999999999' };
    assert.throws(
      () => call(HOOK, { 'x-flipit-checksum': sig },
        { parsed: tampered, raw: JSON.stringify(tampered) }),
      /did not match/
    );
  });

  test('a changed CONTENT field does NOT invalidate it — a real limit', () => {
    // This is not a bug in the verifier; it is what signing two fields buys.
    // The test exists so the limitation is recorded and cannot be forgotten
    // the next time somebody asks whether the IP allowlist is worth filling
    // in. It is: this is what it protects against.
    const sig = checksum(BODY.slug + BODY.updated_at);
    const tampered = { ...BODY, title: 'Something they never published' };
    const r = call(HOOK, { 'x-flipit-checksum': sig },
      { parsed: tampered, raw: JSON.stringify(tampered) });
    assert.strictEqual(r.verified, true,
      'signing slug+updated_at says nothing about the other fields');
  });

  test('a missing header is rejected, not treated as unsigned', () => {
    assert.throws(() => call(HOOK, {}),
      (e) => e.outcome === 'bad_signature' && /no X-Flipit-Checksum/.test(e.message));
  });

  test('an empty string signature is rejected', () => {
    assert.throws(() => call(HOOK, { 'x-flipit-checksum': '' }),
      (e) => e.outcome === 'bad_signature');
  });

  test('hex case does not decide the outcome', () => {
    // Somebody reading a PDF will type it in whatever case their editor
    // produced, and base16 is base16.
    const sig = checksum(BODY.slug + BODY.updated_at).toUpperCase();
    assert.strictEqual(call(HOOK, { 'x-flipit-checksum': sig }).verified, true);
  });

  test('base64 case DOES decide the outcome', () => {
    const hook = { ...HOOK, signature_scheme: 'hmac_sha256_base64' };
    const good = checksum(BODY.slug + BODY.updated_at, SECRET, 'base64');
    assert.strictEqual(call(hook, { 'x-flipit-checksum': good }).verified, true);
    assert.throws(() => call(hook, { 'x-flipit-checksum': good.toUpperCase() }),
      /did not match/);
  });

  test('a supplier who signs the whole body is supported', () => {
    // An empty template means the raw bytes, which is what a supplier doing
    // this properly does.
    const hook = { ...HOOK, signature_message: null };
    const sig = checksum(RAW);
    assert.strictEqual(call(hook, { 'x-flipit-checksum': sig }).verified, true);
  });

  test('a whole-body signature is checked against the bytes that ARRIVED', () => {
    // Re-serialising changes key order and spacing, and the digest no longer
    // matches. Verifying against JSON.stringify(parsed) instead of the raw
    // body is the classic way to build a verifier that rejects every genuine
    // call — or, worse, accepts a body nobody sent.
    const hook = { ...HOOK, signature_message: null };
    const rawAsSent = '{ "slug":"x",  "updated_at":"1" }';
    const parsed = JSON.parse(rawAsSent);
    const sig = checksum(rawAsSent);
    assert.strictEqual(
      call(hook, { 'x-flipit-checksum': sig }, { raw: rawAsSent, parsed }).verified, true);
    assert.notStrictEqual(JSON.stringify(parsed), rawAsSent, 'the two really do differ');
  });

  test('a body missing a signed field is malformed, not a bad signature', () => {
    // Reporting this as "bad signature" sends somebody looking for a key
    // problem when the template is the thing that is wrong.
    const parsed = { title: 'no slug here' };
    assert.throws(
      () => call(HOOK, { 'x-flipit-checksum': 'anything' },
        { parsed, raw: JSON.stringify(parsed) }),
      (e) => e.outcome === 'malformed' && e.status === 400 && /slug/.test(e.message)
    );
  });

  test('a null in a signed field is reported, not stringified to "null"', () => {
    // Otherwise the message silently becomes the four characters n-u-l-l and
    // the mismatch looks like a key problem.
    const parsed = { ...BODY, updated_at: null };
    assert.throws(
      () => call(HOOK, { 'x-flipit-checksum': 'x' },
        { parsed, raw: JSON.stringify(parsed) }),
      (e) => e.outcome === 'malformed' && /updated_at/.test(e.message)
    );
  });

  test('a missing signing key is our fault, reported as 500 not 401', () => {
    // A 401 tells the supplier to check THEIR key when ours is the one
    // missing, and they would spend their three retries on it.
    assert.throws(
      () => call(HOOK, { 'x-flipit-checksum': 'x' }, { secret: null }),
      (e) => e.outcome === 'error' && e.status === 500
    );
  });

  test('scheme "none" verifies nothing and says so', () => {
    const hook = { ...HOOK, signature_scheme: 'none', signature_header: null };
    const r = call(hook, {});
    assert.strictEqual(r.verified, false);
  });

  test('the rejection message tells the caller nothing useful', () => {
    const sig = checksum(BODY.slug + BODY.updated_at, 'wrong');
    try {
      call(HOOK, { 'x-flipit-checksum': sig });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(!e.message.includes(SECRET));
      assert.ok(!/expected|computed/i.test(e.message),
        'never hand an attacker the digest we were looking for');
    }
  });
});

describe('the signed message template', () => {
  test('reproduces FlipitMoney\'s slug + updated_at exactly', () => {
    assert.strictEqual(
      signedMessage('{slug}{updated_at}', RAW, BODY),
      BODY.slug + BODY.updated_at
    );
  });

  test('passes the raw body through when there is no template', () => {
    assert.strictEqual(signedMessage('', RAW, BODY), RAW);
    assert.strictEqual(signedMessage(null, RAW, BODY), RAW);
  });

  test('keeps literal text around the placeholders', () => {
    // Several suppliers sign something like "POST\n/path\n<timestamp>".
    assert.strictEqual(signedMessage('v1:{slug}.{updated_at}', RAW, BODY),
      `v1:${BODY.slug}.${BODY.updated_at}`);
  });
});

describe('the source address allowlist', () => {
  test('an empty list allows anything — the signature is the guard', () => {
    assert.strictEqual(ipAllowed([], '8.8.8.8'), true);
    assert.strictEqual(ipAllowed(null, '8.8.8.8'), true);
  });

  test('an exact address matches and others do not', () => {
    assert.strictEqual(ipAllowed(['52.66.1.2'], '52.66.1.2'), true);
    assert.strictEqual(ipAllowed(['52.66.1.2'], '52.66.1.3'), false);
  });

  test('a CIDR block matches inside and not outside', () => {
    assert.strictEqual(ipAllowed(['52.66.0.0/16'], '52.66.200.9'), true);
    assert.strictEqual(ipAllowed(['52.66.0.0/16'], '52.67.0.1'), false);
  });

  test('an IPv4-mapped IPv6 address still matches', () => {
    // What Node reports behind nginx on a dual-stack socket. Without this
    // every rule fails to match in production and works in testing.
    assert.strictEqual(ipAllowed(['52.66.1.2'], '::ffff:52.66.1.2'), true);
    assert.strictEqual(normaliseIp('::ffff:52.66.1.2'), '52.66.1.2');
  });

  test('a nonsense rule does not accidentally allow everything', () => {
    assert.strictEqual(ipAllowed(['not-an-ip'], '8.8.8.8'), false);
    assert.strictEqual(ipAllowed(['52.66.0.0/99'], '52.66.0.1'), false);
    assert.strictEqual(ipAllowed([''], '8.8.8.8'), false);
  });

  test('several rules are an OR', () => {
    assert.strictEqual(ipAllowed(['1.1.1.1', '52.66.0.0/16'], '52.66.9.9'), true);
  });
});

void WebhookError;
