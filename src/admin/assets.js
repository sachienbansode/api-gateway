'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The brand mark, served as files rather than inlined.
 *
 * A base64 data URI would avoid a request, at the cost of ~31KB on every page
 * load for every admin, uncacheable, and unreadable in the source. These are
 * read once at boot and served with a long cache and a strong ETag, so a
 * browser fetches each one once and then stops asking.
 *
 * The ETag is the file's own content hash, so a redeploy with a new logo
 * invalidates it without anyone having to remember a version query string.
 */
const crypto = require('crypto');
const DIR = path.join(__dirname, 'assets');

const TYPES = {
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const CACHE = new Map();

function load(name) {
  if (CACHE.has(name)) return CACHE.get(name);
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) return null;
  const body = fs.readFileSync(file);
  const entry = {
    body,
    type: TYPES[path.extname(name)] || 'application/octet-stream',
    etag: '"' + crypto.createHash('sha1').update(body).digest('base64').slice(0, 22) + '"',
  };
  CACHE.set(name, entry);
  return entry;
}

/** Express handler for one asset. 404s rather than throwing if it is absent. */
function serve(name) {
  return (req, res) => {
    const a = load(name);
    if (!a) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.set('ETag', a.etag);
    if (req.headers['if-none-match'] === a.etag) return res.status(304).end();
    res.type(a.type).send(a.body);
  };
}

const has = (name) => load(name) !== null;

/**
 * The raw bytes, for a consumer that cannot make an HTTP request — the only
 * one today being the sign-in email, which attaches the mark inline rather
 * than linking to it. Mail clients block remote images by default, so a
 * linked logo is a broken box in most inboxes on first open.
 */
function bytes(name) {
  const a = load(name);
  return a ? a.body : null;
}

module.exports = { serve, has, bytes };
