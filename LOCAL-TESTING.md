# Running it locally

Every command below was run end to end against a real PostgreSQL 16 before being
written down. Expected output is shown so you can tell a working step from a
broken one.

About 20 minutes from a clean Windows machine.

---

## Prerequisites

| | |
|---|---|
| Node.js | 20 or newer — `node -v` |
| PostgreSQL | 16, the EnterpriseDB installer bundles pgAdmin |
| Terminal | PowerShell |

```powershell
cd "D:\sachin b\projects\API Gateway-Ashika\api-wrapper"
npm install
```

---

## 1. Create the database in pgAdmin

The same two scripts used for Azure work unchanged against a local server. They
are pure SQL with no psql meta-commands, which is what makes them paste-able into
the Query Tool.

**Script 1** — connect to your local server, click the **`postgres`** database,
*Tools → Query Tool*, paste `db/setup/01_roles_and_database.sql`.

Edit the three values at the top before running:

```sql
v_env_suffix  text := '';
v_owner_pw    text := 'LocalOwnerPw_2026_aB';
v_app_pw      text := 'LocalAppPw_2026_xY';
```

Any password of 16+ characters works locally. The script refuses to run with the
placeholders still in place, with anything shorter, or with both passwords the
same.

⚠ **Autocommit must stay ON** (the default). `CREATE DATABASE` cannot run inside
a transaction block.

Expected:

```
NOTICE:  created role gw_owner
NOTICE:  created role gw_app
NOTICE:  roles ready: gw_owner (DDL) and gw_app (gateway runtime)
CREATE DATABASE
Step 1 complete. Now connect to the "gateway" database and run 02_schema_and_grants.sql
```

**Script 2** — right-click **Databases → Refresh**, click the new **`gateway`**
database, open a **new** Query Tool, paste `db/setup/02_schema_and_grants.sql`.

⚠ It must run *inside* `gateway`. There is a guard that stops you otherwise.

Expected:

```
Step 2 complete. Now run the migrations (npm run migrate as gw_owner), then 03_verify.sql
```

---

## 2. Local environment file

```powershell
Copy-Item .env.example .env
notepad .env
```

Set these five. Note `DB_SSL=disable`, which is the one real difference from
Azure — a local server has no certificate.

```bash
DATABASE_URL=postgresql://gw_app:LocalAppPw_2026_xY@localhost:5432/gateway
DB_SSL=disable
DB_MIGRATE_ON_BOOT=false
CONFIG_DIR=test/local
INTERNAL_NODE_API_TOKEN=local-upstream-secret
```

`CONFIG_DIR=test/local` points the gateway at the throwaway manifests in
`test/local/` instead of the real ones in `config/`, so you can experiment
without touching production config.

---

## 3. Migrate and verify the privilege model

Migrations need DDL, which `gw_app` deliberately does not have, so supply the
owner credential just for this command:

```powershell
$env:MIGRATION_DATABASE_URL="postgresql://gw_owner:LocalOwnerPw_2026_aB@localhost:5432/gateway"
npm run migrate
node scripts/gw.js db:check
```

Expected — **14 of 15 pass**:

```
  ✓ schema             all 8 tables present
  ✓ grant              SELECT on vendors
  ✓ grant              INSERT on audit_log
  ...
  ✓ least privilege    CREATE in schema correctly refused
  ✓ least privilege    DROP a table correctly refused
  ✓ least privilege    TRUNCATE the audit log correctly refused
  ✗ tls                connection is NOT encrypted ... probably pointed at a local database
  ✓ connection limit   25
```

**The TLS failure is correct locally** and is the check telling you it noticed.
On Azure it must pass; if it fails there, you are not talking to Azure.

If a `least privilege` line fails, `DATABASE_URL` is using the owner or admin
role. Fix that before going further — it is the whole point of the two-role
setup.

---

## 4. Create a vendor and issue a key

```powershell
node scripts/gw.js vendor:add acme customers.read shipments.write --quota 1000 --name "Acme Logistics"
node scripts/gw.js key:issue acme local-test
```

The key prints **once**. Copy it:

```powershell
$KEY = "vk_acme_...paste it here..."
```

---

## 5. Start both processes

Two PowerShell windows.

**Window 1 — the mock upstream.** It stands in for your internal services and
returns secrets on purpose, so you can prove the whitelist works:

```powershell
node test/local/mock-upstream.js
```

**Window 2 — the gateway:**

```powershell
npm start
```

Expected last line: `vendor-api-wrapper listening`, with `endpoints: 2` and
`vendorStore: database`.

---

## 6. The checks that actually prove something

### Authentication

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:8080/v1/customers/1
```

→ `401`

### The response whitelist

```powershell
curl.exe -s -H "X-API-Key: $KEY" http://127.0.0.1:8080/v1/customers/1
```

→ exactly this, and nothing else:

```json
{ "id": 1, "name": "Acme Ltd", "address": { "city": "Pune", "country": "IN" } }
```

The upstream returned `credit_score`, `internal_notes`, `cost_basis`,
`created_by_user_id`, `status`, `postal_code` and `address.internal_geo_id`. None
of them appear. That is the core guarantee, visible in one command.

### Idempotency — the one most worth running

```powershell
$IK = "test-" + (Get-Random)
$body = '{"order_id":"o1","city":"Pune"}'
curl.exe -s -H "X-API-Key: $KEY" -H "Idempotency-Key: $IK" -H "content-type: application/json" -d $body http://127.0.0.1:8080/v1/shipments
curl.exe -s -H "X-API-Key: $KEY" -H "Idempotency-Key: $IK" -H "content-type: application/json" -d $body http://127.0.0.1:8080/v1/shipments
```

Both return the **same** `shipment_id`, and the mock upstream window shows only
**one** `POST /api/shipments`. The retry never reached it.

⚠ The JSON key *order* differs between the two — `shipment_id` and `state` may
swap places. That is not a bug: the replay comes back from Postgres JSONB, which
does not preserve key order. Compare the `shipment_id` value, not the raw string.

Now the same key with a different body:

```powershell
curl.exe -s -H "X-API-Key: $KEY" -H "Idempotency-Key: $IK" -H "content-type: application/json" -d '{"order_id":"o999","city":"Mumbai"}' http://127.0.0.1:8080/v1/shipments
```

→ `422 idempotency_key_reused`. A client bug, refused rather than silently
replayed.

And with no key at all:

```powershell
curl.exe -s -H "X-API-Key: $KEY" -H "content-type: application/json" -d $body http://127.0.0.1:8080/v1/shipments
```

→ `400`, naming the missing header.

### Metering

```powershell
curl.exe -s -D - -o NUL -H "X-API-Key: $KEY" http://127.0.0.1:8080/v1/customers/1 | Select-String "X-Quota|X-RateLimit|X-Request-Id"
```

→

```
X-Request-Id: ae04127b-1763-4080-b89e-66e50acb9f2c
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 590
X-Quota-Limit: 1000
X-Quota-Used: 10
X-Quota-Remaining: 990
X-Quota-Period: 2026-10-01
```

### The audit trail

Take the `X-Request-Id` from above — it is the id a vendor would quote at you:

```powershell
node scripts/gw.js audit:trace ae04127b-1763-4080-b89e-66e50acb9f2c
node scripts/gw.js usage
```

### The test suites

```powershell
npm test
$env:TEST_DATABASE_URL="postgresql://gw_owner:LocalOwnerPw_2026_aB@localhost:5432/gateway"
npm run test:db
```

→ `61 pass` and `26 pass`. The database suite skips rather than fails if
`TEST_DATABASE_URL` is unset.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `CREATE DATABASE cannot run inside a transaction block` | Autocommit is off in the pgAdmin Query Tool. Turn it back on |
| `You are connected to "postgres"` | Script 2 run against the wrong database. Click `gateway` in the tree first |
| `permission denied for schema gateway` on migrate | `MIGRATION_DATABASE_URL` is not set, so it tried as `gw_app` |
| `environment variable INTERNAL_NODE_API_TOKEN is referenced but not set` | Working as intended. An unresolved credential is a hard boot failure |
| Every key returns 401 | The vendor cache refreshes every 30s. Wait, or restart |
| `ECONNREFUSED 127.0.0.1:9910` | The mock upstream is not running in the other window |

---

## Cleaning up

```powershell
# in pgAdmin, or:
psql -U postgres -c "DROP DATABASE gateway;" -c "DROP ROLE gw_app;" -c "DROP ROLE gw_owner;"
Remove-Item .env
```

Nothing in `test/local/` touches the real manifests in `config/`, so there is
nothing else to undo.
