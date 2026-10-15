'use strict';
/**
 * Run a .sql file through the APPLICATION'S OWN connection.
 *
 *   node --env-file=/etc/api-gateway/env scripts/runsql.js db/seed/001_cmots_assignment.sql
 *
 * Migrations have a runner; seeds and one-off scripts did not, which meant
 * pgAdmin — and pgAdmin connects to whatever server its saved connection
 * points at, which is how a seed ends up in a database the application has
 * never heard of. This removes the choice: it can only ever reach the database
 * in GW_DATABASE_URL.
 *
 * The whole file runs in ONE transaction. A file that fails halfway leaves
 * nothing behind, rather than the half-applied state that is so hard to
 * diagnose afterwards.
 */
const fs = require('fs');
const path = require('path');
const db = require('../src/db/pool');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const file = process.argv[2];
if (!file) {
  console.error('\nusage: node --env-file=/etc/api-gateway/env scripts/runsql.js <file.sql>\n');
  process.exit(2);
}
const full = path.resolve(file);
if (!fs.existsSync(full)) {
  console.error(`\nNo such file: ${full}\n`);
  process.exit(2);
}

(async () => {
  db.init(quiet);
  if (!db.isEnabled()) {
    console.error('\nGW_DATABASE_URL is not set in the env file given.\n');
    process.exit(1);
  }
  const sql = fs.readFileSync(full, 'utf8');
  const where = await db.query(
    `SELECT inet_server_addr()::text AS server, current_database() AS db, current_user AS usr`
  );
  const w = where.rows[0];
  console.log(`\nRunning ${path.basename(full)} (${Math.round(sql.length / 1024)} KB)`);
  console.log(`  against ${w.server || '(local socket)'} / ${w.db} as ${w.usr}\n`);

  const started = Date.now();
  try {
    const out = await db.transaction(async (client) => {
      // node-postgres returns an array of results for a multi-statement string.
      const res = await client.query(sql);
      return Array.isArray(res) ? res : [res];
    });
    // Show whatever the file's trailing SELECTs produced — the seed ends with
    // its own counts, and those are the point of running it.
    for (const r of out) {
      if (r && r.rows && r.rows.length && r.command === 'SELECT') {
        console.table(r.rows);
      }
    }
    console.log(`\nDone in ${Date.now() - started}ms. Committed.\n`);
  } catch (err) {
    console.error(`\nFAILED after ${Date.now() - started}ms — nothing was committed.`);
    console.error(`  ${err.message}`);
    if (err.position) console.error(`  at character ${err.position}`);
    if (err.hint) console.error(`  hint: ${err.hint}`);
    console.error('');
    process.exitCode = 1;
  }
  await db.close();
})();
