#!/usr/bin/env node
'use strict';

require('../src/util/dotenv').load();

const configLoader = require('../src/core/config');
const projection = require('../src/core/projection');

/**
 * Pre-flight check. Run this before every deploy and in CI:
 *   npm run validate
 *
 * It catches the whole class of mistakes that would otherwise surface as a
 * production incident — an undeclared upstream, a missing credential, a
 * whitelist typo, a vendor scope that no longer exists, an injected field the
 * vendor can override.
 */

let cfg;
try {
  cfg = configLoader.load();
} catch (err) {
  console.error(`\n  ✗ ${err.message}\n`);
  process.exit(1);
}

// Compiling every path list proves each path is syntactically valid.
let compileErrors = 0;
for (const ep of cfg.endpoints) {
  const where = `endpoint "${ep.name}" response`;
  try {
    if (ep.response.mode === 'whitelist') {
      projection.compile(ep.response.fields, ep.response.rename, where);
    } else if (ep.response.mode === 'redact') {
      projection.compileRedact(ep.response.exclude, where);
    }
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
    compileErrors++;
  }
}
if (compileErrors) {
  console.error(`\n  ${compileErrors} response-path error(s).\n`);
  process.exit(1);
}

console.log('\n  Configuration is valid.\n');
console.log(`  Upstreams (${Object.keys(cfg.upstreams).length}) — never visible to vendors:`);
for (const [id, u] of Object.entries(cfg.upstreams)) {
  console.log(`    ${id.padEnd(22)} ${u.baseUrl}  auth=${u.auth.type}  timeout=${u.timeoutMs}ms`);
}

console.log(`\n  Vendors (${cfg.vendors.length}):`);
for (const v of cfg.vendors) {
  console.log(`    ${v.id.padEnd(22)} ${[...v.scopes].join(', ')}`);
}

const MODE_LABEL = {
  whitelist: 'whitelist',
  redact: 'REDACT',
  passthrough: 'PASSTHROUGH',
};

console.log(`\n  Vendor-facing endpoints (${cfg.endpoints.length}):`);
for (const e of cfg.endpoints) {
  const exposure =
    e.response.mode === 'whitelist'
      ? `exposes ${e.response.fields.length} field(s)`
      : e.response.mode === 'redact'
        ? `ALL fields except ${e.response.exclude.length}`
        : `ALL fields, unfiltered`;
  console.log(
    `    ${(e.method + ' ' + e.path).padEnd(38)} -> ${e.upstream}${e.upstreamPath}\n` +
      `      ${MODE_LABEL[e.response.mode].padEnd(12)} ${exposure}` +
      (e.discover ? '  [discovery on]' : '')
  );
}

// ---------------------------------------------------------------------------
// Exposure report. The whole point of a wrapper is knowing what leaves, so the
// endpoints that are NOT strictly filtered get called out every single run,
// loudly, rather than being buried in the list above.
// ---------------------------------------------------------------------------
const unfiltered = cfg.endpoints.filter((e) => e.response.mode !== 'whitelist');

if (unfiltered.length === 0) {
  console.log(`\n  ✓ Every endpoint uses an explicit field whitelist.`);
} else {
  console.log(
    `\n  ⚠ ${unfiltered.length} of ${cfg.endpoints.length} endpoint(s) are NOT strictly filtered:\n`
  );
  for (const e of unfiltered) {
    console.log(`      ${e.name}  (${MODE_LABEL[e.response.mode]})`);
    if (e.response.mode === 'redact') {
      console.log(`        dropping: ${e.response.exclude.join(', ')}`);
    }
  }
  console.log(
    `\n    These forward fields you have not enumerated, so a column added upstream\n` +
      `    reaches the vendor without a code change. Discovery is recording what they\n` +
      `    actually return — run "npm run fields" to convert them to whitelists.`
  );
}

if (cfg.unreachable.length) {
  console.log(
    `\n  ! Unreachable by any enabled vendor: ${cfg.unreachable.join(', ')}` +
      `\n    (fine while staging an endpoint; a mistake otherwise)`
  );
}

console.log('');
