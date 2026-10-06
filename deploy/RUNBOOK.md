# Deployment runbook

From an empty Azure VM to the first vendor call. Ordered — each step assumes the
one before it worked. Roughly 2–3 hours the first time, most of it waiting for
Azure to provision things.

Anything marked **⚠** is a step people skip and then spend an afternoon
debugging.

---

## Part 1 — Create the database

### 1.1 Provision the server

If you already have an Azure Database for PostgreSQL Flexible Server, skip to
1.2 and just create the database on it.

| Setting | Value | Why |
|---|---|---|
| Type | **Flexible Server** (not Single Server) | Single Server is retired |
| PostgreSQL version | **16** | What this was built and tested against |
| Compute | **Burstable B1ms** (1 vCore, 2 GiB) to start | The gateway's load is tiny — a few writes per request. Scale up if audit volume grows |
| Storage | **32 GiB** | Audit rows are small; 90-day retention on moderate traffic is well under this |
| Backup retention | **7 days minimum**, 30 if you can | The audit log may be the evidence in a vendor dispute |
| High availability | Off initially | Doubles the cost. The gateway degrades gracefully when the DB is unavailable — see the README |
| Region | **Same region as the VM** | This is the whole reason the DB can sit on the request path. Cross-region would add 20–80ms to every call |

⚠ **Same region matters.** The design assumes single-digit millisecond latency.
Put the database in another region or another cloud and you should revisit
whether quota checks belong on the hot path.

### 1.2 Networking

Two options. Pick one:

- **Private access (VNet integration)** — preferred. The database gets no public
  endpoint at all. Requires the VM and the database to share a VNet, and must be
  chosen at creation time; it cannot be switched later.
- **Public access + firewall rules** — simpler. Then you must add a firewall
  rule for the VM's public IP.

⚠ If you choose public access and forget the firewall rule, the connection
**times out with no useful error message**. This is the single most common
setup failure. Add the rule:

```
Azure Portal → your Postgres server → Networking → Firewall rules
  → Add current client IP  (for your laptop, to run setup)
  → Add a rule for the VM's public IP
```

Also tick **"Allow public access from any Azure service within Azure"** only if
you understand it — it permits every Azure tenant, not just yours. Prefer an
explicit IP rule.

### 1.3 Create the database and roles

This is the answer to "what database should I create":

- **One database, named `gateway`.**
- Inside it, everything lives in a **`gateway` schema** — so it will not collide
  with anything else that shares the server.
- **Two roles**, not one: `gw_owner` (owns the schema, holds DDL) and `gw_app`
  (what the running gateway connects as, DML only).
- **No extensions required.** Nothing here needs `pgcrypto`, `uuid-ossp` or
  anything else — UUIDs are generated in Node. So there is no extension
  allowlisting to arrange on Azure.

Generate two strong passwords first:

```bash
openssl rand -base64 30   # gw_owner
openssl rand -base64 30   # gw_app
```

**If you use pgAdmin** (see `db/README.md` for the full walkthrough):

1. Register the server — ⚠ set **Parameters → SSL mode: `require`**, Azure
   rejects plaintext. A hang-then-timeout means the firewall, not pgAdmin.
2. Click the **`postgres`** database → *Tools → Query Tool* → paste
   `db/setup/01_roles_and_database.sql`. Edit the two passwords and the env
   suffix (`''` for prod) at the top. ⚠ Leave **autocommit ON** — `CREATE
   DATABASE` cannot run in a transaction block.
3. Right-click **Databases → Refresh**, click the new **`gateway`** database,
   open a **new** Query Tool, paste `db/setup/02_schema_and_grants.sql`.
   ⚠ It must run inside `gateway`; there is a guard that stops you otherwise.

**If you use psql**, one command, no editing:

```bash
psql "host=YOURSERVER.postgres.database.azure.com port=5432 dbname=postgres \
      user=pgadmin sslmode=require" \
  -v gw_owner_pw="'PASTE-PASSWORD-1'" \
  -v gw_app_pw="'PASTE-PASSWORD-2'" \
  -f db/setup/azure-postgres-setup.psql.sql
```

⚠ Do **not** paste the psql version into pgAdmin — it uses `\set`, `\gexec` and
`\connect`, which the Query Tool does not support. That is why there are two
variants.

⚠ **Why two roles.** The gateway is the one process on your network an outside
party can reach. If it is compromised, the damage is bounded by what its
database credential can do. Running it as an owner or admin means an attacker
can `DROP` or `TRUNCATE` the audit log — the record of what they did. With
`gw_app`, that is refused by Postgres. Verified in step 2.3.

---

## Part 2 — Deploy the gateway

### 2.1 Install

On the VM, with the source in place:

```bash
sudo bash deploy/install.sh
```

Creates the `apigw` service account, installs production dependencies, lays out
`/opt/vendor-api-wrapper`, `/etc/vendor-api-wrapper`,
`/var/log/vendor-api-wrapper`, `/var/lib/vendor-api-wrapper`, downloads the
Azure root certificate, and installs the systemd unit and the housekeeping cron.

### 2.2 Configure

```bash
sudoedit /etc/vendor-api-wrapper/env
```

The two connection strings are deliberately different:

```bash
# What the RUNNING gateway uses — the restricted role.
DATABASE_URL=postgresql://gw_app:PASSWORD-2@YOURSERVER.postgres.database.azure.com:5432/gateway?sslmode=require

# Verify TLS properly rather than trusting the VM's CA bundle.
DB_CA_CERT_PATH=/etc/vendor-api-wrapper/azure-root.pem

# Migrations run as the OWNER. Do NOT put this in the VM env file — pass it on
# the command line when migrating, or set it in your deploy pipeline only.
# MIGRATION_DATABASE_URL=postgresql://gw_owner:PASSWORD-1@...

# Turn OFF automatic migration at boot, since the app role cannot do DDL.
DB_MIGRATE_ON_BOOT=false
```

Then your upstream credentials (`INTERNAL_NODE_API_TOKEN`, etc.). An unresolved
`${VAR}` referenced from `upstreams.yaml` is a hard boot failure by design.

### 2.3 Create the schema, then verify the privileges

```bash
cd /opt/vendor-api-wrapper
set -a && . /etc/vendor-api-wrapper/env && set +a

# As the owner — note the URL is supplied here, not stored in the env file.
MIGRATION_DATABASE_URL='postgresql://gw_owner:PASSWORD-1@...:5432/gateway?sslmode=require' \
  npm run migrate

node scripts/gw.js migrate:status
node scripts/gw.js db:check
```

In pgAdmin you can also run `db/setup/03_verify.sql` against `gateway` — nine
result grids, the last of which is a single-row summary where every column should
read `OK`. The CLI `db:check` is stronger though: it connects **as `gw_app`** and
actually attempts `DROP`, `ALTER` and `TRUNCATE` rather than reading the
catalog.

`db:check` does not take anyone's word for the setup. It confirms the grants the
gateway needs, then **actually attempts** `CREATE`, `DROP`, `ALTER` and
`TRUNCATE` inside a rolled-back transaction and checks each one is refused. All
15 checks should pass. Expected output:

```
  ✓ schema             all 8 tables present
  ✓ grant              SELECT on vendors
  ...
  ✓ least privilege    DROP a table correctly refused
  ✓ least privilege    TRUNCATE the audit log correctly refused
  ✓ tls                encrypted (TLSv1.3)
  ✓ connection limit   25
```

If `tls` fails, you are not talking to Azure. If a `least privilege` check
fails, `DATABASE_URL` is using the owner or admin role — fix it before going
further.

### 2.4 Declare your API surface

This is the part only you can do.

```bash
sudoedit /opt/vendor-api-wrapper/config/upstreams.yaml   # your real hosts
sudoedit /opt/vendor-api-wrapper/config/endpoints.yaml   # the vendor contract
```

For each endpoint decide the response mode:

- **`whitelist`** if you know which fields the vendor needs. Always prefer this.
- **`redact`** if you need it live today and only know which fields must *not*
  leave. Discovery will tell you the rest.

Then:

```bash
npm run validate
```

Read the **exposure report** at the bottom. It lists every endpoint that is not
strictly filtered. If that list is longer than you expected, fix it now.

### 2.5 Onboard the vendor

```bash
node scripts/gw.js vendor:seed                # import config/vendors.yaml
node scripts/gw.js vendor:list
node scripts/gw.js key:issue acme production
```

⚠ The key prints **once**. Only its hash is stored — nobody, including you, can
read it back out of the database. Send it over a channel you trust; if it is
lost, issue a new one and revoke the old.

### 2.6 Start

```bash
sudo systemctl start vendor-api-wrapper
sudo systemctl status vendor-api-wrapper
journalctl -u vendor-api-wrapper -f

curl -s localhost:8080/readyz | jq
```

`readyz` should show `ok: true`, `database.ok: true`,
`vendorStore.source: "database"`, and `audit.dropped: 0`.

### 2.7 TLS and the public door

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/vendor-api-wrapper
sudo ln -sf /etc/nginx/sites-available/vendor-api-wrapper /etc/nginx/sites-enabled/
sudoedit /etc/nginx/sites-available/vendor-api-wrapper    # set server_name
sudo certbot --nginx -d partner-api.yourdomain.com
sudo nginx -t && sudo systemctl reload nginx
```

### 2.8 Lock the front door ⚠

```
Azure Portal → VM → Networking → NSG
  Inbound: allow 443 from the vendor's egress IPs ONLY
  Inbound: deny everything else
```

Optionally mirror it in the nginx `allow`/`deny` block, which is already there
commented out.

This is the strongest single control you have. With it, a leaked API key is
useless from anywhere but the vendor's own network. **You need to ask the vendor
for their egress IPs** — do that early, it is often the slowest thing to obtain.

---

## Part 3 — Hand over and verify

### 3.1 Give the vendor their spec

```bash
node scripts/gw.js usage                       # confirm nothing yet
npm run openapi -- acme vendor-spec.json
```

Filtered to their scopes, generated from the same whitelist that enforces the
filtering — so it cannot describe a field you do not actually expose, and cannot
name an upstream.

Tell them:

- Base URL, and the key, sent as `X-API-Key`
- Writes **require** an `Idempotency-Key` header: a unique value per logical
  operation, reused on retry. Without it they get a 400.
- Rate limits and monthly quota, visible in `X-RateLimit-*` and `X-Quota-*`
- Every error carries a `requestId` — quoting it lets you find the exact call

### 3.2 Watch the first real traffic

```bash
node scripts/gw.js usage acme --since=1
node scripts/gw.js audit:trace <requestId>
journalctl -u vendor-api-wrapper -f | grep -i 'never seen before'
```

That last one matters if you shipped anything in `redact` or `passthrough` mode:
it fires the first time an upstream returns a field it has not returned before,
which means a new field is now reaching the vendor.

### 3.3 Tighten within the first fortnight

```bash
npm run fields -- get_invoice
```

Prints the field paths the upstream **actually** returned, accumulated across
every response seen. Uncomment what the vendor should get, paste into
`endpoints.yaml`, set `mode: whitelist`, run `npm run validate`, restart. The
endpoint is then immune to upstream schema change.

Re-run `npm run validate` and aim for **"✓ Every endpoint uses an explicit field
whitelist."**


---

## Going straight to production (no UAT yet)

This is a reasonable choice for a limited first release, and the gateway's design
supports it — an allowlist with two endpoints exposes exactly two endpoints. But
you lose your rehearsal space, so replace it with three specific habits.

### 1. Start with reads only

Ship **2–3 `GET` endpoints in `whitelist` mode** first. No writes on day one.

Reads are idempotent by nature, so a mistake shows up as a wrong response you can
fix in config, not as a duplicated shipment you have to unpick from your own
database. Once the read path is proven end to end with real vendor traffic, add
the writes — idempotency is already built and tested, you just want the
authentication, filtering and networking proven before you add operations that
change state.

### 2. Use the NSG as your staging gate ⚠

This is the substitute for having a UAT environment, and it costs nothing.

Deploy with the NSG allowing **443 from your own office IP only**. The service is
live, TLS-terminated, reachable over the real hostname with the real database —
but the vendor cannot reach it yet. Run your own smoke tests against production
exactly as the vendor will:

```bash
curl -H "X-API-Key: $KEY" https://partner-api.yourdomain.com/v1/customers/123
```

Check the response contains only what you intended, then:

```bash
node scripts/gw.js usage
node scripts/gw.js audit:trace <requestId>
```

**Only then** add the vendor's egress IPs to the NSG. You have had a staging
environment; it just happened to be production with the door shut.

### 3. Give yourself a test vendor

```bash
node scripts/gw.js vendor:add smoke customers.read --quota 500 --name "Internal smoke test"
node scripts/gw.js key:issue smoke
```

A second vendor with a narrow scope set and its own key, for your own checks.
It keeps your test traffic out of the real vendor's quota and audit history, and
`gw.js usage` shows them separately. Costs one row.

### 4. Watch the first week properly

```bash
# Anything the vendor is failing on
node scripts/gw.js usage acme --since=1

# New upstream fields reaching the vendor (matters if anything is in redact mode)
journalctl -u vendor-api-wrapper -f | grep -i 'never seen before'

# Is the gateway healthy
watch -n 60 'curl -s localhost:8080/readyz | jq "{ok, database: .database.ok, dropped: .audit.dropped}"'
```

### What you give up, honestly

Without UAT you cannot rehearse **schema changes or upgrades**. Adding a migration
or a Node version bump goes straight to the thing your vendor depends on. Two
mitigations until UAT exists:

- **Migrations are transactional and checksummed.** A failed migration rolls back
  completely rather than half-applying. `migrate:status` tells you where you are.
- **`npm run validate` before every restart.** It catches bad config without
  touching the running service — a malformed whitelist, a missing credential, an
  endpoint exposed wider than you meant.

And take a backup before the first migration on a database that has real data:

```
Azure Portal → your Postgres server → Backup and restore → Backup now
```

### When you do add UAT

The naming is already chosen so nothing needs renaming — `gateway_uat`,
`gw_owner_uat`, `gw_app_uat`, created by re-running the setup scripts with
`v_env_suffix := '_uat'`. `db/README.md` has the steps and explains why it is a
separate **database** rather than a separate schema.

The UAT VM then runs the same code with a different `.env`. Nothing in the
application is environment-aware, which is deliberate: there is no
`if (env === 'prod')` branch that can behave differently in the place it matters.

---

## What you still owe this project

Not optional, just not blocking today:

- [ ] The vendor's egress IPs, for the NSG rule (ask now — slowest to get, and
      it is your staging gate as well as your security control)
- [ ] A decision per endpoint: whitelist or redact on day one
- [ ] Confirm your upstreams honour the `inject` parameters. The gateway forces
      them, but only the upstream can enforce row-level access — this gateway
      cannot do that on your behalf
- [ ] Decide audit retention and set `--audit-days` in
      `/etc/cron.d/vendor-api-wrapper` to match
- [ ] Alerting on `readyz` returning 503 and on `audit.dropped > 0`
- [ ] Put the source in git. It is the change-review mechanism the whole
      config-as-code design depends on

---

## Honest limits

Worth knowing before someone asks:

- **Revocation takes up to 30s** (`VENDOR_CACHE_REFRESH_MS`) to apply, because
  auth is deliberately kept off the database hot path.
- **Burst rate limiting is per-instance.** The monthly quota is shared via
  Postgres; the sub-second limiter is in memory. For one or two instances, set
  the limit to `total / instance_count`.
- **Quota fails open** if Postgres is unreachable. Idempotency fails *closed*.
  Both are deliberate and explained in the README.
- **`gw_app` can write to the `vendors` and `vendor_keys` tables**, because the
  CLI uses the same credential. So a compromised gateway could mint itself a
  vendor key. That is not much of an escalation — it already holds your upstream
  credentials — and the boundary that matters, protecting the audit log from
  being dropped or truncated, is enforced. If you want to close it anyway, move
  vendor management to a third role and grant `gw_app` only `SELECT` on those two
  tables.
