#!/usr/bin/env node
'use strict';

const crypto = require('crypto');

/**
 * Generate a vendor API key and print the hash to store.
 *
 * Usage:  npm run genkey -- acme
 *
 * The plaintext is printed once and never persisted anywhere by this tool.
 * Send it to the vendor over a channel you trust, then store only the hash.
 */

const vendorId = (process.argv[2] || '').replace(/[^A-Za-z0-9_-]/g, '');
if (!vendorId) {
  console.error('Usage: npm run genkey -- <vendorId>\n  e.g. npm run genkey -- acme');
  process.exit(1);
}

// 32 random bytes, base64url. Prefixed so a leaked key is identifiable in logs
// and searchable in a secret scanner.
const secret = crypto.randomBytes(32).toString('base64url');
const key = `vk_${vendorId}_${secret}`;
const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
const envName = `VENDOR_KEY_${vendorId.toUpperCase().replace(/-/g, '_')}`;

console.log(`
──────────────────────────────────────────────────────────────────────────────
 Vendor:  ${vendorId}

 1. Give this key to the vendor. It is shown ONCE and cannot be recovered:

      ${key}

 2. Put this line in your .env on the gateway server:

      ${envName}=${hash}

 3. Reference it from config/vendors.yaml:

      - id: ${vendorId}
        keyEnv: [${envName}]
        enabled: true
        scopes: [ ... ]

 4. Restart the service:  sudo systemctl restart vendor-api-wrapper

 To rotate later: run this again, add the NEW hash alongside the old in
 keyEnv, let the vendor cut over, then remove the old hash and restart.
──────────────────────────────────────────────────────────────────────────────
`);
