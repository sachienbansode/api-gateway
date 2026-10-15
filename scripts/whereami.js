'use strict';
/**
 * What database is this application actually talking to, and what can it see?
 *
 * Uses the app's own pool and env, so there is no chance of answering for a
 * different connection than the one that serves requests. Written because a
 * schema that "is definitely applied" and an application that cannot find it
 * turned out to be two different connections, twice.
 *
 *   node --env-file=/etc/api-gateway/env scripts/whereami.js
 */
const db = require('../src/db/pool');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const EXPECTED = {
  '001_init': ['vendors', 'vendor_keys', 'vendor_scopes', 'audit_log', 'quota_usage',
               'idempotency_keys', 'observed_fields'],
  '002_catalog': ['upstreams', 'endpoints', 'endpoint_inject', 'vendor_endpoints',
                  'vendor_ips', 'catalog_audit'],
  '003_studio': ['applications', 'api_types', 'api_categories', 'endpoint_params',
                 'endpoint_fields', 'connection_tests'],
  '004_upstream_secrets': ['upstream_secrets', 'secret_audit'],
  '005_no_payloads': [],
  '006_credential_reveal': [],
};

(async () => {
  db.init(quiet);
  if (!db.isEnabled()) {
    console.error('No database configured — GW_DATABASE_URL is not set in the env file given.');
    process.exit(1);
  }
  const who = await db.query(
    `SELECT inet_server_addr()::text AS server, inet_server_port() AS port,
            current_database() AS db, current_user AS usr, version() AS version`
  );
  const w = who.rows[0];
  console.log('\nTHE APPLICATION IS CONNECTED TO');
  console.log(`  server   ${w.server || '(local socket)'}:${w.port}`);
  console.log(`  database ${w.db}`);
  console.log(`  user     ${w.usr}`);
  console.log(`  ${String(w.version).split(',')[0]}`);
  console.log(`  from     ${process.env.GW_DATABASE_URL}`);

  console.log('\nWHAT IT CAN SEE IN THE gateway SCHEMA');
  let missingAny = false;
  for (const [file, tables] of Object.entries(EXPECTED)) {
    if (!tables.length) { console.log(`  ${file}: (no new tables)`); continue; }
    const r = await db.query(
      `SELECT t AS name, to_regclass('gateway.' || t) IS NOT NULL AS present
         FROM unnest($1::text[]) AS t`,
      [tables]
    );
    const missing = r.rows.filter((x) => !x.present).map((x) => x.name);
    if (missing.length) missingAny = true;
    console.log(`  ${file}: ${missing.length ? 'MISSING ' + missing.join(', ') : 'all present'}`);
  }

  // The ledger, if the runner has ever been used here.
  const led = await db.query(
    `SELECT file, applied_at FROM gateway.schema_migrations ORDER BY file`
  ).catch(() => null);
  console.log('\nMIGRATION LEDGER');
  if (!led) console.log('  none — migrations here have been applied by hand');
  else if (!led.rows.length) console.log('  empty');
  else led.rows.forEach((r) => console.log(`  ${r.file}  ${r.applied_at.toISOString().slice(0, 16)}`));

  console.log(missingAny
    ? '\nSomething is missing on THIS connection. Apply the migrations against the server above.\n'
    : '\nThe schema this application sees is complete.\n');
  await db.close();
})().catch((e) => { console.error('\nFAILED:', e.message, '\n'); process.exit(1); });
