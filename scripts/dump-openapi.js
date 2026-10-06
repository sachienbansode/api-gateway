#!/usr/bin/env node
'use strict';

require('../src/util/dotenv').load();

const fs = require('fs');
const path = require('path');
const configLoader = require('../src/core/config');
const openapi = require('../src/core/openapi');

/**
 * Write the vendor-facing spec to a file, for handing over or publishing.
 *   npm run openapi -- [vendorId] [outFile]
 *
 * With a vendorId, the spec is filtered to that vendor's scopes — which is what
 * you should actually send them.
 */

const cfg = configLoader.load();
const vendorId = process.argv[2];
const out = process.argv[3] || path.join(process.cwd(), 'openapi.json');

let endpoints = cfg.endpoints;
if (vendorId) {
  const vendor = cfg.vendors.find((v) => v.id === vendorId);
  if (!vendor) {
    console.error(`No enabled vendor "${vendorId}". Known: ${cfg.vendors.map((v) => v.id).join(', ')}`);
    process.exit(1);
  }
  endpoints = cfg.endpoints.filter((e) => e.scopes.some((s) => vendor.scopes.has(s)));
}

const spec = openapi.build({
  endpoints,
  info: {
    title: process.env.API_TITLE || 'Partner API',
    version: process.env.API_VERSION || '1.0.0',
    servers: [{ url: process.env.PUBLIC_BASE_URL || 'https://partner-api.example.com' }],
  },
});

fs.writeFileSync(out, JSON.stringify(spec, null, 2));
console.log(
  `Wrote ${out} — ${endpoints.length} endpoint(s)${vendorId ? ` visible to "${vendorId}"` : ''}.`
);
