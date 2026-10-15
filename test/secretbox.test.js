'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const secretbox = require('../src/core/secretbox');

const KEY = () => crypto.randomBytes(32).toString('base64');

function withKey(value, fn) {
  const before = process.env.GW_SECRET_KEY;
  process.env.GW_SECRET_KEY = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.GW_SECRET_KEY;
    else process.env.GW_SECRET_KEY = before;
  }
}

test('secretbox', async (t) => {
  await t.test('is disabled when no key is configured', () => {
    withKey('', () => assert.equal(secretbox.enabled(), false));
  });

  await t.test('refuses to seal without a key, and says how to make one', () => {
    withKey('', () => {
      assert.throws(() => secretbox.seal('x'), /GW_SECRET_KEY is not set/);
      assert.throws(() => secretbox.seal('x'), /randomBytes\(32\)/);
    });
  });

  await t.test('round-trips', () => {
    withKey('v1:' + KEY(), () => {
      const sealed = secretbox.seal('a-supplier-token-1234', 'upstream:cmots:value');
      assert.equal(secretbox.open(sealed, 'upstream:cmots:value'), 'a-supplier-token-1234');
    });
  });

  await t.test('produces a different ciphertext every time', () => {
    withKey('v1:' + KEY(), () => {
      const a = secretbox.seal('same-value-every-time', 'aad');
      const b = secretbox.seal('same-value-every-time', 'aad');
      assert.notEqual(a.ciphertext.toString('hex'), b.ciphertext.toString('hex'));
      assert.notEqual(a.iv.toString('hex'), b.iv.toString('hex'));
    });
  });

  await t.test('the ciphertext does not contain the plaintext', () => {
    withKey('v1:' + KEY(), () => {
      const sealed = secretbox.seal('super-secret-cmots-token', 'aad');
      assert.equal(sealed.ciphertext.toString('utf8').includes('super-secret'), false);
      assert.equal(sealed.ciphertext.toString('hex').includes('super'), false);
    });
  });

  await t.test('a tampered ciphertext fails rather than decrypting to something else', () => {
    withKey('v1:' + KEY(), () => {
      const sealed = secretbox.seal('a-supplier-token-1234', 'aad');
      const flipped = Buffer.from(sealed.ciphertext);
      flipped[0] ^= 0xff;
      assert.throws(
        () => secretbox.open({ ...sealed, ciphertext: flipped }, 'aad'),
        /integrity check/
      );
    });
  });

  await t.test('a ciphertext moved to another upstream fails its integrity check', () => {
    // This is what the AAD is for: without it, a row copied from one supplier
    // to another would decrypt happily and authenticate as the wrong one.
    withKey('v1:' + KEY(), () => {
      const sealed = secretbox.seal('a-supplier-token-1234', 'upstream:cmots:value');
      assert.throws(
        () => secretbox.open(sealed, 'upstream:someone_else:value'),
        /integrity check/
      );
    });
  });

  await t.test('a different key cannot open it', () => {
    const sealed = withKey('v1:' + KEY(), () => secretbox.seal('a-supplier-token-1234', 'aad'));
    withKey('v1:' + KEY(), () => {
      assert.throws(() => secretbox.open(sealed, 'aad'), /integrity check/);
    });
  });

  await t.test('rotation: old rows still open, new rows use the newest key', () => {
    const oldKey = 'v1:' + KEY();
    const sealed = withKey(oldKey, () => secretbox.seal('a-supplier-token-1234', 'aad'));
    assert.equal(sealed.keyId, 'v1');

    withKey('v2:' + KEY() + ',' + oldKey, () => {
      assert.equal(secretbox.open(sealed, 'aad'), 'a-supplier-token-1234');
      assert.equal(secretbox.seal('new-one', 'aad').keyId, 'v2');
    });
  });

  await t.test('a row naming a key that is gone says so, clearly', () => {
    const sealed = withKey('v1:' + KEY(), () => secretbox.seal('a-supplier-token-1234', 'aad'));
    withKey('v7:' + KEY(), () => {
      assert.throws(() => secretbox.open(sealed, 'aad'), /key "v1".*not in GW_SECRET_KEY/s);
    });
  });

  await t.test('rejects a key of the wrong length, and says what is needed', () => {
    withKey('v1:' + crypto.randomBytes(16).toString('base64'), () => {
      assert.throws(() => secretbox.seal('x'), /16 bytes, needs 32/);
    });
  });

  await t.test('accepts hex as well as base64', () => {
    withKey('v1:' + crypto.randomBytes(32).toString('hex'), () => {
      const sealed = secretbox.seal('a-supplier-token-1234', 'aad');
      assert.equal(secretbox.open(sealed, 'aad'), 'a-supplier-token-1234');
    });
  });

  await t.test('a bare key with no id is treated as v1', () => {
    withKey(KEY(), () => {
      assert.equal(secretbox.seal('a-supplier-token-1234', 'aad').keyId, 'v1');
    });
  });

  await t.test('the hint is the last four characters, and nothing for a short secret', () => {
    withKey('v1:' + KEY(), () => {
      assert.equal(secretbox.seal('abcdefghijkl9f3a', 'aad').hint, '9f3a');
      // Four of eight characters is half the secret, so: none at all.
      assert.equal(secretbox.seal('short123', 'aad').hint, '');
    });
  });

  await t.test('describe() shows status and never the value', () => {
    const d = secretbox.describe({
      auth_secret_ciphertext: Buffer.from('anything'),
      auth_secret_hint: '9f3a',
      auth_secret_key_id: 'v1',
      auth_secret_set_by: 'admin@example.com',
    });
    assert.equal(d.hint, '••••9f3a');
    assert.equal(JSON.stringify(d).includes('anything'), false);
  });

  await t.test('picks up a key changed after the first call', () => {
    // The keyring is cached; it must be keyed on the env value, or rotating
    // GW_SECRET_KEY would do nothing until a restart.
    const k1 = 'v1:' + KEY();
    const sealed = withKey(k1, () => secretbox.seal('a-supplier-token-1234', 'aad'));
    withKey('v2:' + KEY(), () => {
      assert.throws(() => secretbox.open(sealed, 'aad'), /not in GW_SECRET_KEY/);
    });
    withKey(k1, () => {
      assert.equal(secretbox.open(sealed, 'aad'), 'a-supplier-token-1234');
    });
  });
});
