#!/usr/bin/env node
'use strict';

require('../src/util/dotenv').load();

const db = require('../src/db/pool');
const vendorRepo = require('../src/db/repos/vendors');
const quotaRepo = require('../src/db/repos/quota');
const auditRepo = require('../src/db/repos/audit');
const idemRepo = require('../src/db/repos/idempotency');
const { migrate, status } = require('../src/db/migrate');
const configLoader = require('../src/core/config');

/**
 * Operator CLI — the command-line equivalent of the admin console we decided
 * not to build yet.
 *
 *   node scripts/gw.js <command> [args]
 *
 * Every command that changes something prints what it did. Key issuance prints
 * the plaintext exactly once, because it is never stored.
 */

const logger = {
  info: (o, m) => process.env.GW_VERBOSE && console.error('  ·', m || '', JSON.stringify(o || {})),
  warn: (o, m) => console.error('  !', typeof o === 'string' ? o : m || '', typeof o === 'string' ? '' : JSON.stringify(o || {})),
  error: (o, m) => console.error('  ✗', typeof o === 'string' ? o : m || '', typeof o === 'string' ? '' : JSON.stringify(o || {})),
};

const [, , command, ...args] = process.argv;

function requireDb() {
  if (!db.isEnabled()) {
    console.error(`
  This command needs a database. DATABASE_URL is not set.

  For Azure Database for PostgreSQL Flexible Server it looks like:
    DATABASE_URL=postgresql://USER:PASSWORD@SERVER.postgres.database.azure.com:5432/DBNAME

  Also make sure the Azure firewall allows this VM's IP, and that TLS is
  configured (DB_CA_CERT_PATH, or DB_SSL_INSECURE=true as a stopgap).
`);
    process.exit(1);
  }
}

function table(rows, columns) {
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  const widths = columns.map((c) =>
    Math.max(c.label.length, ...rows.map((r) => String(fmt(r[c.key]) ?? '').length))
  );
  console.log('  ' + columns.map((c, i) => c.label.padEnd(widths[i])).join('  '));
  console.log('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) {
    console.log('  ' + columns.map((c, i) => String(fmt(r[c.key]) ?? '').padEnd(widths[i])).join('  '));
  }
}

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
  if (Array.isArray(v)) return v.join(', ');
  return v;
}

/** Commands that perform DDL and therefore want the owner credential. */
const OWNER_COMMANDS = new Set(['migrate']);

const commands = {
  // -------------------------------------------------------------------------
  async migrate() {
    requireDb();
    const result = await migrate({
      info: (o, m) => console.log('  ·', typeof o === 'string' ? o : m, (o && o.migration) || ''),
      warn: () => {},
    });
    if (result.applied.length === 0) {
      console.log(`\n  Nothing to apply. ${result.skipped.length} migration(s) already in place.\n`);
    } else {
      console.log(`\n  Applied: ${result.applied.join(', ')}\n`);
    }
  },

  async 'migrate:status'() {
    const s = await status();
    if (!s.enabled) {
      console.log(`\n  No database configured. Pending: ${s.pending.join(', ')}\n`);
      return;
    }
    console.log('\n  Applied:');
    table(s.applied, [
      { key: 'file', label: 'MIGRATION' },
      { key: 'applied_at', label: 'APPLIED' },
      { key: 'duration_ms', label: 'MS' },
    ]);
    console.log(`\n  Pending: ${s.pending.length ? s.pending.join(', ') : '(none)'}\n`);
  },

  // -------------------------------------------------------------------------
  /**
   * Verify the database is set up the way we think it is.
   *
   * Run this after setup and after any change to roles or grants. It does not
   * take anyone's word for it: it actually attempts the forbidden operations
   * and checks they are refused.
   */
  async 'db:check'() {
    requireDb();
    const results = [];
    const pass = (name, detail) => results.push({ ok: true, name, detail });
    const fail = (name, detail) => results.push({ ok: false, name, detail });

    const who = await db.query(
      `SELECT current_user, current_database(),
              pg_backend_pid() AS pid,
              version() AS version`
    );
    const me = who.rows[0];
    console.log(`\n  Connected as "${me.current_user}" to "${me.current_database}"`);
    console.log(`  ${me.version.split(',')[0]}\n`);

    // --- schema and tables present -----------------------------------------
    const tables = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'gateway' ORDER BY table_name`
    );
    const names = tables.rows.map((r) => r.table_name);
    const expected = [
      'audit_log',
      'idempotency_keys',
      'observed_fields',
      'quota_usage',
      'schema_migrations',
      'vendor_keys',
      'vendor_scopes',
      'vendors',
    ];
    const missing = expected.filter((t) => !names.includes(t));
    if (missing.length === 0) pass('schema', `all ${expected.length} tables present`);
    else fail('schema', `missing: ${missing.join(', ')} — run "gw.js migrate"`);

    // --- the privileges the gateway NEEDS ----------------------------------
    for (const [priv, table] of [
      ['SELECT', 'vendors'],
      ['SELECT', 'vendor_keys'],
      ['INSERT', 'audit_log'],
      ['INSERT', 'quota_usage'],
      ['UPDATE', 'quota_usage'],
      ['INSERT', 'idempotency_keys'],
      ['UPDATE', 'idempotency_keys'],
      ['DELETE', 'idempotency_keys'],
    ]) {
      if (!names.includes(table)) continue;
      const r = await db.query(
        `SELECT has_table_privilege(current_user, 'gateway.' || $1, $2) AS ok`,
        [table, priv]
      );
      if (r.rows[0].ok) pass(`grant`, `${priv} on ${table}`);
      else fail(`grant`, `MISSING ${priv} on ${table} — the gateway will fail at runtime`);
    }

    // --- the privileges it must NOT have -----------------------------------
    // Actually attempt them, inside a transaction we roll back. has_*_privilege
    // can disagree with reality once role inheritance is involved; a real
    // attempt cannot.
    const forbidden = [
      ['CREATE in schema', `CREATE TABLE gateway.__privcheck (x int)`],
      ['DROP a table', `DROP TABLE gateway.audit_log`],
      ['ALTER a table', `ALTER TABLE gateway.audit_log ADD COLUMN __x int`],
      ['TRUNCATE the audit log', `TRUNCATE gateway.audit_log`],
    ];

    for (const [label, sql] of forbidden) {
      if (label !== 'CREATE in schema' && !names.includes('audit_log')) continue;
      let refused = false;
      let detail = '';
      try {
        await db.transaction(async (client) => {
          await client.query(sql);
          throw new Error('__rollback_after_success');
        });
      } catch (err) {
        if (err.message === '__rollback_after_success') {
          refused = false;
        } else if (/permission denied|must be owner/i.test(err.message)) {
          refused = true;
          detail = err.message.split('\n')[0];
        } else {
          refused = true;
          detail = err.message.split('\n')[0];
        }
      }

      if (refused) pass('least privilege', `${label} correctly refused`);
      else
        fail(
          'least privilege',
          `${label} was ALLOWED. This role has more power than the gateway needs — ` +
            `see db/setup/ for the setup scripts`
        );
    }

    // --- connection and TLS -------------------------------------------------
    const ssl = await db
      .query(`SELECT ssl, version AS tls FROM pg_stat_ssl WHERE pid = pg_backend_pid()`)
      .catch(() => null);
    if (ssl?.rows?.[0]) {
      const row = ssl.rows[0];
      if (row.ssl) pass('tls', `encrypted (${row.tls})`);
      else
        fail(
          'tls',
          'connection is NOT encrypted. Azure normally refuses this, so you are ' +
            'probably pointed at a local database.'
        );
    }

    const limit = await db.query(
      `SELECT rolconnlimit FROM pg_roles WHERE rolname = current_user`
    );
    const cl = limit.rows[0]?.rolconnlimit;
    if (cl === -1)
      fail(
        'connection limit',
        'unlimited — a connection leak here could exhaust the whole server'
      );
    else pass('connection limit', `${cl}`);

    // --- report ------------------------------------------------------------
    const failures = results.filter((r) => !r.ok);
    for (const r of results) {
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(18)} ${r.detail}`);
    }
    console.log('');
    if (failures.length === 0) {
      console.log(`  All ${results.length} checks passed.\n`);
    } else {
      console.log(`  ${failures.length} of ${results.length} checks FAILED.\n`);
      process.exitCode = 1;
    }
  },

  // -------------------------------------------------------------------------
  /** Import vendors from config/vendors.yaml into the database. */
  async 'vendor:seed'() {
    requireDb();
    const cfg = configLoader.load();
    console.log('');
    for (const v of cfg.vendors) {
      await vendorRepo.upsertVendor({
        id: v.id,
        name: v.name,
        scopes: [...v.scopes],
        rateWindowMs: v.rateLimit.windowMs,
        rateMax: v.rateLimit.max,
        monthlyQuota: v.monthlyQuota,
      });
      console.log(`  ✓ ${v.id} — ${[...v.scopes].join(', ')}`);
    }
    console.log(`
  ${cfg.vendors.length} vendor(s) seeded. Note that KEYS were not imported —
  hashes in .env stay where they are, and the database is now the source of
  truth. Issue a fresh key per vendor:

      node scripts/gw.js key:issue <vendorId>
`);
  },

  async 'vendor:list'() {
    requireDb();
    const rows = await vendorRepo.listVendorsWithKeys();
    console.log('');
    table(rows, [
      { key: 'id', label: 'VENDOR' },
      { key: 'enabled', label: 'ON' },
      { key: 'live_keys', label: 'KEYS' },
      { key: 'monthly_quota', label: 'QUOTA' },
      { key: 'rate_max', label: 'RATE' },
      { key: 'last_used_at', label: 'LAST USED' },
      { key: 'scopes', label: 'SCOPES' },
    ]);
    console.log('');
  },

  async 'vendor:add'() {
    requireDb();
    const [id, ...scopes] = args;
    if (!id) return usage('vendor:add <vendorId> <scope> [scope...] [--quota N] [--name "Full Name"]');

    const quotaIdx = scopes.indexOf('--quota');
    const quota = quotaIdx >= 0 ? Number(scopes[quotaIdx + 1]) : null;
    const nameIdx = scopes.indexOf('--name');
    const name = nameIdx >= 0 ? scopes[nameIdx + 1] : id;
    const cleanScopes = scopes.filter(
      (s, i) =>
        !s.startsWith('--') &&
        scopes[i - 1] !== '--quota' &&
        scopes[i - 1] !== '--name'
    );

    await vendorRepo.upsertVendor({ id, name, scopes: cleanScopes, monthlyQuota: quota });
    console.log(`\n  ✓ ${id} saved with scopes: ${cleanScopes.join(', ') || '(none)'}`);
    console.log(`    Now issue a key:  node scripts/gw.js key:issue ${id}\n`);
  },

  async 'vendor:disable'() {
    requireDb();
    const [id] = args;
    if (!id) return usage('vendor:disable <vendorId>');
    const n = await vendorRepo.setEnabled(id, false);
    console.log(
      n
        ? `\n  ✓ ${id} disabled. Takes effect within the vendor cache refresh window (~30s).\n`
        : `\n  ✗ No vendor "${id}".\n`
    );
  },

  async 'vendor:enable'() {
    requireDb();
    const [id] = args;
    if (!id) return usage('vendor:enable <vendorId>');
    const n = await vendorRepo.setEnabled(id, true);
    console.log(n ? `\n  ✓ ${id} enabled.\n` : `\n  ✗ No vendor "${id}".\n`);
  },

  // -------------------------------------------------------------------------
  async 'key:issue'() {
    requireDb();
    const [vendorId, label] = args;
    if (!vendorId) return usage('key:issue <vendorId> [label]');

    const vendor = (await vendorRepo.listVendorsWithKeys()).find((v) => v.id === vendorId);
    if (!vendor) {
      console.error(`\n  ✗ No vendor "${vendorId}". Create it first with vendor:add.\n`);
      process.exit(1);
    }

    const { key, hash } = await vendorRepo.issueKey({ vendorId, label: label || null });

    console.log(`
──────────────────────────────────────────────────────────────────────────────
  Key issued for ${vendorId}${label ? ` (${label})` : ''}

  Give this to the vendor. It is shown ONCE and cannot be recovered — only its
  hash is stored, so nobody, including you, can read it back out of the database.

      ${key}

  They send it as:   X-API-Key: <the key above>

  Stored hash (for your records / to revoke later):
      ${hash}

  Live within ~30s on every running instance, no restart needed.
──────────────────────────────────────────────────────────────────────────────
`);
  },

  async 'key:list'() {
    requireDb();
    const [vendorId] = args;
    if (!vendorId) return usage('key:list <vendorId>');
    const rows = await vendorRepo.listKeys(vendorId);
    console.log('');
    table(rows, [
      { key: 'key_hash', label: 'HASH' },
      { key: 'label', label: 'LABEL' },
      { key: 'created_at', label: 'CREATED' },
      { key: 'last_used_at', label: 'LAST USED' },
      { key: 'revoked_at', label: 'REVOKED' },
    ]);
    console.log('');
  },

  async 'key:revoke'() {
    requireDb();
    const [vendorId, keyHash] = args;
    if (!vendorId || !keyHash) return usage('key:revoke <vendorId> <keyHash>');
    const n = await vendorRepo.revokeKey({ vendorId, keyHash });
    console.log(
      n
        ? `\n  ✓ Revoked. Effective within the cache refresh window (~30s) on every instance.\n`
        : `\n  ✗ No live key with that hash for ${vendorId}.\n`
    );
  },

  // -------------------------------------------------------------------------
  async usage() {
    requireDb();
    const [vendorId] = args;
    const sinceArg = args.find((a) => a.startsWith('--since='));
    const days = sinceArg ? Number(sinceArg.split('=')[1]) : 7;
    const since = new Date(Date.now() - days * 86400000);

    console.log(`\n  Traffic, last ${days} day(s)${vendorId ? ` for ${vendorId}` : ''}:`);
    const rows = await auditRepo.usageSummary({ since, vendorId: vendorId || null });
    table(rows, [
      { key: 'vendor_id', label: 'VENDOR' },
      { key: 'endpoint', label: 'ENDPOINT' },
      { key: 'calls', label: 'CALLS' },
      { key: 'errors', label: 'ERRORS' },
      { key: 'avg_ms', label: 'AVG MS' },
      { key: 'p95_ms', label: 'P95 MS' },
      { key: 'last_call', label: 'LAST' },
    ]);

    console.log(`\n  Monthly quota (${quotaRepo.currentPeriod()}):`);
    const q = await quotaRepo.allUsage();
    table(q, [
      { key: 'vendor_id', label: 'VENDOR' },
      { key: 'used', label: 'USED' },
      { key: 'limit', label: 'LIMIT' },
    ]);
    console.log('');
  },

  async 'audit:trace'() {
    requireDb();
    const [requestId] = args;
    if (!requestId) return usage('audit:trace <requestId>');
    const row = await auditRepo.findByRequestId(requestId);
    if (!row) {
      console.log(`\n  No audit row for ${requestId}.\n`);
      return;
    }
    console.log('');
    for (const [k, v] of Object.entries(row)) {
      console.log(`  ${k.padEnd(18)} ${fmt(v)}`);
    }
    console.log('');
  },

  async 'quota:reset'() {
    requireDb();
    const [vendorId] = args;
    if (!vendorId) return usage('quota:reset <vendorId>');
    const n = await quotaRepo.reset({ vendorId });
    console.log(`\n  ✓ Cleared ${n} quota row(s) for ${vendorId} this period.\n`);
  },

  // -------------------------------------------------------------------------
  /** Housekeeping — run from cron. */
  async purge() {
    requireDb();
    const daysArg = args.find((a) => a.startsWith('--audit-days='));
    const days = daysArg ? Number(daysArg.split('=')[1]) : 90;

    const idem = await idemRepo.purgeExpired();
    let audit = 0;
    let batch;
    // Chunked, so a big backlog does not hold a long lock.
    do {
      batch = await auditRepo.purgeOlderThan(days);
      audit += batch;
    } while (batch > 0);

    console.log(
      `\n  ✓ Removed ${idem} expired idempotency record(s) and ${audit} audit row(s) older than ${days} days.\n`
    );
  },
};

function usage(line) {
  console.error(`\n  Usage: node scripts/gw.js ${line}\n`);
  process.exit(1);
}

function help() {
  console.log(`
  Gateway operator CLI

  Schema
    migrate                              apply pending migrations
                                         (uses MIGRATION_DATABASE_URL if set)
    migrate:status                       what is applied, what is pending
    db:check                             verify grants AND that the app role is
                                         genuinely refused DDL — run after setup

  Vendors
    vendor:seed                          import config/vendors.yaml into the DB
    vendor:list                          all vendors, key counts, quotas, scopes
    vendor:add <id> <scope...>           create or update a vendor
                                         [--quota N] [--name "Full Name"]
    vendor:enable  <id>
    vendor:disable <id>                  blocks all their keys (~30s to take effect)

  Keys
    key:issue  <vendorId> [label]        issue a key; prints plaintext ONCE
    key:list   <vendorId>                hashes, labels, last-used, revocations
    key:revoke <vendorId> <keyHash>      revoke one key

  Reporting
    usage [vendorId] [--since=DAYS]      calls, errors, latency, quota
    audit:trace <requestId>              full record for one request

  Housekeeping
    quota:reset <vendorId>               clear this period's counter
    purge [--audit-days=90]              drop expired idempotency + old audit rows

  Every command needs DATABASE_URL, except migrate:status.
`);
}

(async () => {
  if (!command || command === 'help' || command === '--help') {
    help();
    return;
  }
  if (!commands[command]) {
    console.error(`\n  Unknown command "${command}". Run without arguments for help.\n`);
    process.exit(1);
  }

  db.init(logger, { forMigration: OWNER_COMMANDS.has(command) });
  try {
    await commands[command]();
  } finally {
    await db.close();
  }
})().catch((err) => {
  console.error(`\n  ✗ ${err.message}\n`);
  process.exit(1);
});
