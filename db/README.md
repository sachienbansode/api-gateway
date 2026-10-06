# db/

All SQL for the gateway. Nothing here runs automatically except `migrations/`.

```
db/
  migrations/     applied by `npm run migrate` — checksummed, forward-only
  setup/          one-time role and database creation
  queries/        read-only ops queries to paste into pgAdmin
```

---

## Which setup script do I use?

**Two paths to the same result.** Pick by the tool you have:

| Tool | Use | Why |
|---|---|---|
| **pgAdmin** | `setup/01_…`, `02_…`, `03_…` in order | pgAdmin's Query Tool does **not** support psql meta-commands |
| **psql** | `setup/azure-postgres-setup.psql.sql` | One run, no editing — passwords come in as `-v` variables |

That distinction is not pedantry. The psql version uses `\set`, `\gexec` and
`\connect`, and pasting it into pgAdmin fails with `syntax error at or near "\"`.
The numbered scripts are pure SQL and work in either.

---

## pgAdmin walkthrough

### Connect to the Azure server

Right-click **Servers → Register → Server**:

- **General → Name:** anything, e.g. `azure-gateway-prod`
- **Connection → Host:** `YOURSERVER.postgres.database.azure.com`
- **Connection → Port:** `5432`
- **Connection → Maintenance database:** `postgres`
- **Connection → Username:** your server admin
- **Connection → Password:** save it if you like
- **Parameters → SSL mode:** `require` ← **must set this**, Azure rejects
  plaintext. For full verification set `verify-full` and point **Root
  certificate** at the DigiCert root (`install.sh` downloads it to
  `/etc/vendor-api-wrapper/azure-root.pem`).

If it hangs then times out rather than refusing, it's the **firewall**, not
pgAdmin — add your client IP under *Networking → Firewall rules* on the Postgres
server.

### Run the scripts

**Script 01** — click the **`postgres`** database → *Tools → Query Tool* → paste
`setup/01_roles_and_database.sql`.

Edit the three values at the top first (two passwords, and the env suffix — leave
it `''` for production). The script refuses to run with placeholders still in
place, with passwords under 16 characters, or with both passwords the same.

⚠ **Autocommit must be ON** (the default). `CREATE DATABASE` cannot run inside a
transaction block, so if you've turned autocommit off via the toolbar dropdown
you'll get `CREATE DATABASE cannot run inside a transaction block`.

**Script 02** — right-click **Databases → Refresh**, then click the new
**`gateway`** database → a **new** Query Tool → paste
`setup/02_schema_and_grants.sql`.

⚠ This must run *inside* `gateway`. Running it against `postgres` is the most
common mistake, and it creates the schema in the wrong database. There's a guard
at the top that stops you, but check the tree anyway.

**Then the migrations**, which pgAdmin does not run — they go through the app so
the checksum ledger stays correct:

```bash
MIGRATION_DATABASE_URL='postgresql://gw_owner:PW@HOST:5432/gateway?sslmode=require' \
  npm run migrate
```

**Script 03** — `setup/03_verify.sql`, against `gateway`. Nine result grids;
pgAdmin shows the last by default, so select a section and press F5 to see it
alone. Section 9 is a single-row summary where every column should read `OK`.

Better still, the CLI version connects **as `gw_app`** and actually attempts the
forbidden operations rather than reading the catalog:

```bash
node scripts/gw.js db:check
```

---

## Ongoing operations

`queries/` holds read-only queries for pgAdmin — traffic, errors, quota, key
inventory, schema drift, table growth. See `queries/00_README.md`.

Most have a quicker CLI equivalent (`gw.js usage`, `audit:trace`, `vendor:list`).
Use whichever you're already in.

---

## Adding UAT later

Decided up front so nothing needs renaming:

| | Production | UAT |
|---|---|---|
| Database | `gateway` | `gateway_uat` |
| Owner role | `gw_owner` | `gw_owner_uat` |
| App role | `gw_app` | `gw_app_uat` |

Re-run `01_roles_and_database.sql` with `v_env_suffix := '_uat'` and new
passwords, change the two identifiers in the `CREATE DATABASE`/`GRANT` block to
match, then find-and-replace `gw_owner`→`gw_owner_uat` and `gw_app`→`gw_app_uat`
in `02_schema_and_grants.sql` before running it against `gateway_uat`.

**A separate database, not a separate schema.** A shared database means a UAT
misconfiguration can write into production's tables, and `TRUNCATE` in UAT is one
typo away from production. Separate databases make that impossible. Same server
is fine — the isolation you need is at the database and role level, not the
hardware.

If your UAT vendor traffic will be meaningful in volume, put it on its own server
instead, so a UAT load test cannot exhaust production's connection pool.

---

## Migrations

Forward-only, applied in filename order, each inside a transaction, recorded with
a SHA-256 checksum.

**Editing an applied migration makes the runner refuse to start.** That's
deliberate — a changed migration means your environments have silently diverged.
Write a new one:

```
db/migrations/002_whatever.sql
```

An advisory lock means two instances booting together cannot both migrate.

```bash
npm run migrate                    # apply pending
node scripts/gw.js migrate:status  # what's applied, what's pending
```

`MIGRATIONS_DIR` overrides the location if you need it to.
