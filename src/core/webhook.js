'use strict';

const crypto = require('crypto');

/**
 * Proving an inbound call really came from the supplier.
 *
 * This is the only thing standing between the public internet and an endpoint
 * that writes into your systems, so the whole file is about being careful in
 * three specific places.
 *
 * 1. TIMING. Comparing two digests with === leaks, through how long the
 *    comparison takes, how many leading characters an attacker guessed right.
 *    That is enough to recover a valid signature a character at a time.
 *    crypto.timingSafeEqual is used everywhere a secret is compared.
 *
 * 2. THE EXACT BYTES. An HMAC is over bytes, so the signature must be checked
 *    against the body as it ARRIVED. Parsing to JSON and re-serialising
 *    changes key order, spacing and unicode escapes, and the digest no longer
 *    matches — or worse, matches something the supplier did not send.
 *
 * 3. WHAT IS ACTUALLY SIGNED. Every supplier picks something different.
 *    FlipitMoney sign `slug + updated_at`, not the body. Assuming the body
 *    would reject every genuine call; assuming their scheme for a supplier
 *    who signs properly would accept forged ones. So it is configured per
 *    webhook and never guessed.
 *
 * WHAT A SIGNATURE OVER TWO FIELDS DOES NOT PROVE — worth stating plainly,
 * because it is a real limit of FlipitMoney's scheme rather than of this code.
 * If the signed message is `{slug}{updated_at}`, then the signature says those
 * two values came from someone holding the key. It says NOTHING about the
 * other twenty fields. Somebody who captured one request could alter `content`
 * or `banner_link` and the checksum would still verify.
 *
 * Their IP allowlist is the answer to that, which is why it is offered — and
 * why, for this particular supplier, it is worth actually filling in.
 */

const SCHEMES = {
  hmac_sha256_hex: { algo: 'sha256', encoding: 'hex' },
  hmac_sha256_base64: { algo: 'sha256', encoding: 'base64' },
};

class WebhookError extends Error {
  constructor(outcome, message, status = 401) {
    super(message);
    this.outcome = outcome;
    this.status = status;
  }
}

/**
 * Build the string the supplier signed.
 *
 * A template of `{field}` placeholders over the parsed body. Empty means the
 * raw body bytes, which is what a supplier signing properly does.
 *
 * Only top-level fields, deliberately. A path expression would invite
 * `{more_info.source_name}` and a quiet mismatch when a supplier reorganises
 * their payload; every scheme seen in the wild signs top-level values.
 */
function signedMessage(template, rawBody, parsed) {
  if (!template) return rawBody;

  const missing = [];
  const out = String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_, field) => {
    const v = parsed ? parsed[field] : undefined;
    if (v === undefined || v === null) { missing.push(field); return ''; }
    return String(v);
  });

  if (missing.length) {
    // Not a signature failure. The supplier sent a body that does not contain
    // what we were told they sign, and reporting it as "bad signature" would
    // send somebody looking for the wrong problem for an afternoon.
    throw new WebhookError(
      'malformed',
      `the body has no ${missing.join(', ')} — the signature is built from ` +
        `"${template}", so either that template is wrong or this is not the ` +
        `payload it was written for`,
      400
    );
  }
  return out;
}

/** Constant-time comparison that does not leak the length either. */
function sameDigest(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  // timingSafeEqual throws on a length mismatch, and the throw is itself a
  // timing signal. Hash both to a fixed width first, then compare.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * @param {object}  hook     the webhook row
 * @param {Buffer|string} rawBody  the body exactly as it arrived
 * @param {object}  parsed   the same body as an object, for the template
 * @param {object}  headers  lower-cased request headers
 * @param {string}  secret   the shared signing key, already decrypted
 * @throws {WebhookError}
 */
function verifySignature(hook, { rawBody, parsed, headers, secret }) {
  const scheme = hook.signature_scheme || 'hmac_sha256_hex';
  if (scheme === 'none') return { verified: false, scheme };

  const spec = SCHEMES[scheme];
  if (!spec) throw new WebhookError('error', `unknown signature scheme "${scheme}"`, 500);

  const headerName = String(hook.signature_header || '').toLowerCase();
  const presented = headers[headerName];
  if (!presented) {
    throw new WebhookError(
      'bad_signature',
      `no ${hook.signature_header} header was sent`
    );
  }
  if (!secret) {
    // Not the caller's fault, and not something to answer 401 to: a 401 tells
    // them to check THEIR key when ours is the one missing, and they would
    // burn their three retries on it.
    throw new WebhookError(
      'error', 'no signing key is stored for this webhook', 500
    );
  }

  const message = signedMessage(hook.signature_message, rawBody, parsed);
  const expected = crypto.createHmac(spec.algo, secret)
    .update(message)
    .digest(spec.encoding);

  // Hex is case-insensitive; base64 is not.
  const a = spec.encoding === 'hex' ? String(presented).toLowerCase() : String(presented);
  const b = spec.encoding === 'hex' ? expected.toLowerCase() : expected;

  if (!sameDigest(a, b)) {
    // The message is deliberately vague to the caller and specific in the log.
    // Telling an attacker which part failed is free help.
    throw new WebhookError('bad_signature', 'the signature did not match');
  }
  return { verified: true, scheme };
}

/**
 * Is this source address allowed?
 *
 * Empty list means any source — the signature is what guards the endpoint,
 * and a webhook that cannot be tested until someone emails you an address is
 * a webhook nobody finishes setting up.
 *
 * Supports a bare address or a CIDR block. IPv4-mapped IPv6 (::ffff:1.2.3.4),
 * which is what Node reports behind nginx on a dual-stack socket, is reduced
 * to its IPv4 form first — without that, every rule would fail to match in
 * production while working perfectly in testing.
 */
function normaliseIp(ip) {
  const s = String(ip || '').trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
}

function ipToLong(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n;
}

function ipAllowed(allowlist, ip) {
  if (!allowlist || !allowlist.length) return true;
  const addr = normaliseIp(ip);
  const addrLong = ipToLong(addr);

  for (const ruleRaw of allowlist) {
    const rule = String(ruleRaw || '').trim();
    if (!rule) continue;
    if (rule === addr) return true;

    const slash = rule.indexOf('/');
    if (slash === -1) continue;

    const base = ipToLong(rule.slice(0, slash));
    const bits = Number(rule.slice(slash + 1));
    if (base === null || addrLong === null) continue;
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    if (bits === 0) return true;
    const mask = (-1 << (32 - bits)) >>> 0;
    if (((base & mask) >>> 0) === ((addrLong & mask) >>> 0)) return true;
  }
  return false;
}

module.exports = { verifySignature, signedMessage, ipAllowed, normaliseIp, WebhookError };
