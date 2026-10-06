#!/usr/bin/env node
'use strict';

require('../src/util/dotenv').load();

const fs = require('fs');
const yaml = require('js-yaml');
const { DEFAULT_FILE } = require('../src/core/discovery');

/**
 * Turn discovered field paths into a ready-to-paste whitelist.
 *
 *   npm run fields                 all endpoints
 *   npm run fields -- get_customer one endpoint
 *
 * This is the no-UI answer to "which fields does this upstream actually
 * return?". Run the endpoint in redact or passthrough mode, let real traffic
 * flow, then paste the output below into endpoints.yaml and flip the mode to
 * whitelist. You are then filtering against observed reality rather than a
 * guess, and the endpoint becomes immune to upstream schema change.
 *
 * Paths are printed COMMENTED OUT by default, so converting an endpoint is a
 * deliberate act of uncommenting the fields the vendor should see — not a
 * blanket copy of everything the upstream happens to return. Use --all to emit
 * them uncommented.
 */

const file = process.env.DISCOVERY_FILE || DEFAULT_FILE;

if (!fs.existsSync(file)) {
  console.error(`
  No discovery file at ${file}

  Discovery records field names while the gateway serves traffic. To collect some:
    1. Set an endpoint to  response.mode: redact  (or passthrough), which turns
       discovery on automatically — or add  response.discover: true  to a
       whitelist endpoint.
    2. Run the gateway and let the vendor (or a smoke test) hit it.
    3. Run this command again.
`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const uncommented = process.argv.includes('--all');

const entries = Object.entries(data.endpoints || {}).filter(
  ([name]) => only.length === 0 || only.includes(name)
);

if (entries.length === 0) {
  console.error(`No discovered fields for: ${only.join(', ') || '(any endpoint)'}`);
  process.exit(1);
}

console.log(`# Discovered field paths — observed in real upstream responses.`);
console.log(`# Source: ${file}`);
console.log(`# Last updated: ${data.updatedAt || 'unknown'}`);
if (!uncommented) {
  console.log(`#`);
  console.log(`# Every path is commented out. Uncomment the ones the vendor should see,`);
  console.log(`# paste into the endpoint's response.fields, and set response.mode: whitelist.`);
  console.log(`# Re-run with --all to emit them uncommented.`);
}
console.log('');

for (const [name, entry] of entries) {
  const fields = entry.fields || [];
  console.log(`# ── ${name} — ${fields.length} path(s) observed ──`);

  // Group by top-level key so related fields sit together and it is obvious
  // when a whole nested object is about to be exposed.
  const groups = new Map();
  for (const f of fields) {
    const head = f.split('.')[0].replace('[]', '');
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(f);
  }

  const block = yaml.dump({ fields }, { lineWidth: 120 }).trimEnd();
  if (uncommented) {
    console.log(`response:`);
    console.log(`  mode: whitelist`);
    console.log(
      block
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n')
    );
  } else {
    console.log(`# response:`);
    console.log(`#   mode: whitelist`);
    console.log(`#   fields:`);
    for (const [head, members] of groups) {
      if (members.length > 1) console.log(`#     # ${head}`);
      for (const f of members) console.log(`#     - ${f}`);
    }
  }
  console.log('');
}

console.log(`# ${entries.length} endpoint(s). Remember: a whitelist is immune to upstream`);
console.log(`# adding a column; a redact list is not. Convert when you can.`);
