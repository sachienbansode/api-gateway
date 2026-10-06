'use strict';

const crypto = require('crypto');
const errors = require('../core/errors');

/**
 * Vendor authentication.
 *
 * The key arrives as `X-API-Key`. We SHA-256 it and look the digest up in a map
 * built at boot from vendors.yaml + .env. The plaintext key is never stored on
 * this server, so a database or config dump does not hand an attacker a working
 * credential.
 *
 * Hashing the input before lookup also removes the timing side-channel you get
 * from comparing secrets directly: every request does one fixed-cost hash and
 * one hash-table lookup, regardless of whether the key is right, wrong, or
 * nearly right.
 */

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function extractKey(req) {
  const header = req.get('x-api-key');
  if (header) return header.trim();

  // Also accept `Authorization: Bearer <key>`, because some vendor HTTP
  // clients make custom headers awkward. Same key, same validation.
  const auth = req.get('authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();

  return null;
}

/**
 * @param {{lookupByKey:(key:string)=>object|undefined}} vendorStore
 *        The DB-backed VendorStore, or — with no database configured — a
 *        config-backed one. Both expose lookupByKey, so this middleware is
 *        indifferent to which is in play, and auth never touches the database
 *        on the request path either way.
 */
function makeAuthMiddleware(vendorStore, logger) {
  return function authenticate(req, res, next) {
    const key = extractKey(req);

    if (!key) {
      logger.warn({ requestId: req.requestId, ip: req.ip }, 'auth: no key presented');
      return next(errors.unauthorized('no key presented'));
    }

    const vendor = vendorStore.lookupByKey(key);
    if (!vendor) {
      logger.warn(
        {
          requestId: req.requestId,
          ip: req.ip,
          // The first 6 chars of the DIGEST, not the key. Enough to tell
          // "same wrong key repeatedly" from "credential stuffing", without
          // writing any part of a real secret to disk.
          keyDigestPrefix: sha256Hex(key).slice(0, 6),
        },
        'auth: unrecognised key'
      );
      return next(errors.unauthorized('unrecognised key'));
    }

    req.vendor = vendor;
    return next();
  };
}

/** Enforce that the vendor holds at least one scope the endpoint requires. */
function makeScopeMiddleware(endpoint, logger) {
  return function checkScope(req, res, next) {
    const ok = endpoint.scopes.some((s) => req.vendor.scopes.has(s));
    if (!ok) {
      logger.warn(
        {
          requestId: req.requestId,
          vendor: req.vendor.id,
          endpoint: endpoint.name,
          required: endpoint.scopes,
        },
        'authz: scope denied'
      );
      return next(errors.forbidden(`vendor lacks scopes ${endpoint.scopes.join('|')}`));
    }
    return next();
  };
}

module.exports = { makeAuthMiddleware, makeScopeMiddleware, sha256Hex, extractKey };
