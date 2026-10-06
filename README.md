# Vendor API Wrapper

A facade gateway that gives an external vendor its own API, its own credentials,
and its own rate limits — while your real endpoints, your upstream credentials,
and the fields you don't want shared never leave your server.

Built for a Linux Azure VM. Node.js 20+, Express, four dependencies.

---

## The idea in one paragraph

You declare each vendor-facing endpoint in `config/endpoints.yaml`. Each
declaration says which upstream to call, which request fields to forward, and —
critically — an explicit **whitelist** of response fields. The gateway builds the
vendor's response from nothing, copying only the whitelisted fields across. The
upstream body is never spread, merged, or passed through, so a column someone
adds upstream next sprint cannot appear in a vendor response. There is no
catch-all proxy route anywhere in the codebase: an endpoint that isn't declared
doesn't exist.

Adding endpoint number 11 is a six-line config entry. No code change.

---

## Why an allowlist and not a proxy

The obvious way to build this is a generic reverse proxy with a path prefix. Do
not. A generic proxy forwards whatever path the vendor sends, so the vendor can
reach any upstream route they can guess or discover — which is the exact exposure
you built the wrapper to prevent. Every route here is declared, mapped to one
upstream call, and filtered.

---

## What it protects against

| Risk | Control |
|---|---|
| Vendor learns your internal hostnames, ports, service names | Upstream config is never rendered into any response, error, or the generated docs |
| Vendor obtains your upstream / third-party API credentials | Credentials live in env vars, injected server-side per call; the vendor's request never carries them |
| Response leaks fields you didn't intend (`internal_notes`, `cost_basis`, `credit_score`) | Explicit field whitelist, built up rather than filtered down |
| A new upstream field leaks the day it ships | Whitelist, not blacklist — unnamed fields are structurally unreachable. On `redact`/`passthrough` endpoints, discovery warns on first sighting instead |
| Vendor smuggles extra body fields (`price_override`) upstream | Body allowlist, plus forced `inject` values the vendor cannot override |
| Vendor reaches undeclared upstream routes | No passthrough route exists; undeclared paths 404 before any upstream call |
| 500 leaks a stack trace, SQL, or an internal DB hostname | Every error is reconstructed from a fixed vocabulary; upstream bodies are never forwarded |
| Vendor's retry loop takes down your internal API | Per-key rate limits, per-upstream timeouts, circuit breaker, nginx IP rate limit |
| Leaked API key used from elsewhere | Azure NSG + nginx IP allowlist pinned to the vendor's egress IPs |
| Config or database dump hands over a working credential | Only SHA-256 hashes are stored, in env or Postgres; there is no column that could hold plaintext |
| A vendor retry creates the resource twice | `Idempotency-Key`, required on writes by default, with atomic claim in Postgres |
| A vendor exceeds what they are contracted for | Durable monthly quota, enforced atomically across instances |
| Audit trail lost to log rotation during a dispute | Rows persisted to Postgres, batched so they never add request latency |
| Path traversal in a path parameter | Parameters are URI-encoded into the mapped upstream path |
| Vendor header smuggling (`X-Original-URL`, `X-Forwarded-Host`) | Upstream headers are constructed from scratch; no vendor header is forwarded |

Each row has a test in `test/gateway.test.js`.

---

## Layout

```
config/
  upstreams.yaml     real APIs + how WE authenticate to them. Never vendor-visible.
  endpoints.yaml     the vendor-facing allowlist. The whole contract lives here.
  vendors.yaml       who may call, and which scopes they hold.
src/
  server.js          process lifecycle, signals, graceful shutdown
  app.js             middleware chain, health endpoints, OpenAPI route
  core/
    config.js        loads + validates all three manifests, fails fast at boot
    router.js        turns the manifest into Express routes
    upstream.js      credential injection, timeouts, header construction
    projection.js    whitelist / redact / passthrough engine — the security core
    discovery.js     records which field paths upstreams actually return
    errors.js        the only place a vendor-visible error is constructed
    breaker.js       per-upstream circuit breaker
    openapi.js       generates vendor docs from the same whitelist that enforces
  db/
    pool.js          pg pool, Azure TLS handling, health
    migrate.js       checksummed forward-only migration runner
    repos/           vendors, audit, quota, idempotency
  middleware/        auth, rate limiting, quota, idempotency, request id, errors
scripts/
  genkey.js          generate a vendor key, print the hash to store
  validate-config.js pre-flight check + exposure report — CI and pre-deploy
  dump-openapi.js    write the vendor's spec to a file
  fields-to-yaml.js  turn discovered field paths into a paste-ready whitelist
  gw.js              operator CLI: migrations, vendors, keys, usage, purge
db/                  ALL SQL lives here
  migrations/        applied by `npm run migrate`
  setup/             one-time roles + database (pgAdmin and psql variants)
  queries/           read-only ops queries to paste into pgAdmin
deploy/
  install.sh         first-time VM setup
  RUNBOOK.md         ordered path from Azure portal to first vendor call
  vendor-api-wrapper.service   hardened systemd unit
  nginx.conf         TLS termination, IP allowlist, edge rate limiting
  vendor-api-wrapper.cron  nightly retention + discovery report
test/                87 tests (61 without a DB, 26 against real Postgres)
```

---

## Quick start locally

```bash
npm install
cp .env.example .env

# Generate a key for your vendor. Prints the key (give to vendor) and the
# hash (put in .env).
npm run genkey -- acme

# Point config/upstreams.yaml at your real services, declare your endpoints,
# then check everything before you run it:
npm run validate

npm start
```

`npm run validate` is worth making a habit. It refuses to pass on an undeclared
upstream, a missing credential, a whitelist typo, a vendor scope no endpoint
uses, or an injected field the vendor could override. All of those are otherwise
production incidents.

---

## Declaring an endpoint

```yaml
- name: get_order_status
  path: /v1/orders/:orderId/status      # YOUR naming, not the upstream's
  method: GET
  upstream: internal_py                 # from upstreams.yaml
  upstreamPath: /orders/:orderId        # the real path
  scopes: [orders.read]
  rateLimit: { windowMs: 60000, max: 300 }
  request:
    query: [include_history]            # allowlist; anything else is a 400
    inject:
      partner_scope: vendor             # forced; vendor cannot override
  response:
    fields:                             # WHITELIST — this is the contract
      - order_id
      - state
      - shipment.carrier
      - shipment.tracking_number
    rename:
      order_id: reference               # decouple your names from upstream's
```

---

## The database layer (Azure Postgres)

The gateway runs **with or without** a database. Leave `DATABASE_URL` unset and
everything still works — vendor keys come from env, and audit/quota/idempotency
are disabled. That is the local-development path. Set it, and five things become
real:

| Feature | Without a DB | With Azure Postgres |
|---|---|---|
| Vendor keys | hashes in `.env`, restart to change | rows in Postgres, issue/revoke live |
| Audit trail | journald only, rotates away | durable, queryable, retention-managed |
| Monthly quotas | not enforced | atomic, survives restart, shared across instances |
| Idempotency | header validated, not enforced | genuine replay protection |
| Schema drift | in-memory + a JSON file | recorded per endpoint |

### Setup

**One database named `gateway`, one `gateway` schema inside it, and two roles.**
No extensions needed — nothing here requires `pgcrypto` or `uuid-ossp`, so there
is no Azure extension allowlisting to arrange.

`db/setup/` creates all of it — numbered pure-SQL scripts for pgAdmin, or a
single psql one-shot. See `db/README.md`; the two variants exist because
pgAdmin's Query Tool does not support psql meta-commands. Run once as the server
admin, then:

```bash
# 1. Create the schema, as the OWNER role
MIGRATION_DATABASE_URL='postgresql://gw_owner:...' npm run migrate
node scripts/gw.js migrate:status

# 2. Verify the privilege boundary actually holds
node scripts/gw.js db:check

# 3. Import vendors from config/vendors.yaml
node scripts/gw.js vendor:seed

# 4. Issue a key — prints the plaintext ONCE
node scripts/gw.js key:issue acme
```

`deploy/RUNBOOK.md` has the full ordered path from Azure portal to first vendor
call.

### Two roles, not one

`gw_owner` owns the schema and holds DDL — used only by `npm run migrate`, and its
password should never sit on the gateway VM. `gw_app` is what the running gateway
connects as: `SELECT`/`INSERT`/`UPDATE`/`DELETE` and nothing else.

The reason is blast radius. The gateway is the one process an outside party can
reach; if it is compromised, the damage is bounded by what its database
credential can do. As an owner or admin, an attacker can `DROP` or `TRUNCATE` the
audit log — the record of what they just did. As `gw_app`, Postgres refuses.

`db:check` doesn't ask you to trust that. It confirms the grants the gateway
needs, then **actually attempts** `CREATE`, `DROP`, `ALTER` and `TRUNCATE` inside
a rolled-back transaction and asserts each is refused:

```
  ✓ grant              INSERT on audit_log
  ✓ least privilege    DROP a table correctly refused
  ✓ least privilege    TRUNCATE the audit log correctly refused
  ✓ tls                encrypted (TLSv1.3)
  ✓ connection limit   25
```

The gateway also warns at boot if `DATABASE_URL` looks like an owner or admin
credential, since that is easy to do by accident when copying the migration URL.

One honest caveat: `gw_app` *can* write to `vendors` and `vendor_keys`, because
the operator CLI shares the credential — so a compromised gateway could mint
itself a key. That is barely an escalation when it already holds your upstream
credentials, and the boundary that matters (the audit log cannot be destroyed) is
enforced. Close it if you want by moving vendor management to a third role and
granting `gw_app` only `SELECT` on those two tables.

Migrations are forward-only, applied inside a transaction, and checksummed. Edit
an already-applied migration and the runner **refuses to start** rather than
leaving your environments silently diverged — write a new migration instead. An
advisory lock means two instances booting together cannot both migrate.

### Azure specifics that catch people out

- **TLS is mandatory.** Flexible Server rejects plaintext. Best option is to
  verify properly against the Azure root: `install.sh` downloads it, then set
  `DB_CA_CERT_PATH`. `DB_SSL_INSECURE=true` works as a stopgap and warns on every
  boot so nobody forgets it is on.
- **Add a firewall rule** on the Postgres server for the VM's IP, or the
  connection just times out with no useful error.
- **Connections are capped by SKU.** A Burstable B1ms allows ~50, so the pool
  defaults to 10 — leaving room for migrations, your CLI, and a second instance.
- **Flexible Server fails over for maintenance,** roughly monthly. Everything
  below is designed around that rather than pretending it won't happen.

### Auth never touches the database on the request path

The vendor/key set is small, so it is cached in memory and refreshed every
`VENDOR_CACHE_REFRESH_MS` (default 30s). Two consequences, stated plainly:

- **Revocation takes up to 30s** to apply across instances. Verified end to end:
  revoke a key, wait for the refresh, the next call gets 401 — no restart.
- **A refresh failure keeps serving from the last good cache.** A database blip
  degrades key *management*, not traffic. Failing auth closed on a DB hiccup
  would turn a 30-second Azure failover into a vendor-visible outage, which is
  strictly worse. There's a test that simulates the outage and asserts requests
  still succeed.

### Audit writes never block a request

Rows are queued in memory and flushed in batches. The request path does one array
push. The queue is **bounded** (`AUDIT_QUEUE_MAX`, default 5000): if Postgres is
down and it fills, the oldest rows are dropped and counted rather than growing
until the process dies. Losing audit rows during an outage is bad; taking the
gateway down because the audit table is unavailable is worse. Drops surface on
`/readyz` and in the logs, so the loss is never silent.

What the audit table deliberately does **not** store: request bodies, response
bodies, header values. Storing those would make it a second copy of your
customers' data with all the retention and breach exposure that implies. There's
a test asserting a sensitive order reference does not appear in the row.

```bash
node scripts/gw.js usage                    # calls, errors, latency, quota
node scripts/gw.js usage acme --since=30
node scripts/gw.js audit:trace <requestId>  # the id the vendor quotes you
```

### Idempotency — the bug this was really for

Your vendor POSTs a shipment, the response is lost to a timeout, their client
retries, and you have created two shipments. You do not control their retry logic
or the network, so this *will* happen.

`Idempotency-Key` is **required on writes by default** (`idempotency: required |
optional | off` per endpoint). Required is the right default precisely because
the failure is silent — make it optional and a vendor who hasn't implemented it
gets duplicates and won't find out until it costs something.

Four cases, all tested against real Postgres:

- **Same key, same body** → the stored response is replayed, upstream is not
  called. Asserted by the upstream seeing exactly one call.
- **Same key, different body** → `422`. That's a client bug, and replaying the
  first response would hide it while they believe their second request worked.
- **Same key, still in flight** → `409`, retry shortly. 100 concurrent races
  produce exactly one winner every time — never zero, never two.
- **Claim abandoned** (process killed mid-request) → the lease lapses and the key
  becomes usable again, rather than being blocked forever.

One subtlety worth knowing: the replayed body is the **filtered** response, not
the upstream one. Storing the upstream body would resurface whitelisted-out
fields on replay. There's a test for exactly that.

### Quotas vs rate limits

Both exist because they solve different problems:

- **Rate limit** protects your infrastructure from a burst. Enforced in memory in
  microseconds; resets on restart, which is fine — a restart also ends the burst.
- **Quota** is a commercial commitment. Enforced with one atomic UPSERT that
  increments and returns the count, so two instances cannot both let the
  100,000th call through.

The rate limiter runs **first**, deliberately: a retry storm should be rejected as
a rate limit, not silently consume allowance the vendor is paying for.

Quota **fails open** if the database is unreachable, and logs an error. Blocking a
paying vendor because your counter table is down causes more damage than letting a
few hundred extra calls through — and the rate limiter still protects the
infrastructure meanwhile. Vendors get `X-Quota-Limit`, `X-Quota-Used`,
`X-Quota-Remaining` and `X-Quota-Period` on every response.

### Housekeeping

`deploy/vendor-api-wrapper.cron` runs nightly. Without it, `audit_log` and
`idempotency_keys` grow forever.

```bash
node scripts/gw.js purge --audit-days=90
```

---

## Response modes: passthrough, redact, whitelist

Phase 1 reality is that you can't always enumerate every field on day one. Three
modes, declared per endpoint:

| Mode | Behaviour | Safe against upstream adding a column? |
|---|---|---|
| `whitelist` (default) | Emit only the named fields | **Yes** — new fields are structurally unreachable |
| `redact` | Forward everything except `exclude` | **No** — a new field goes straight to the vendor |
| `passthrough` | Forward verbatim | **No** |

```yaml
# Ship-today pattern: you don't have the full field list, but you know the
# three things that must not leave.
response:
  mode: redact
  exclude:
    - internal_margin
    - cost_breakdown          # drops the whole nested object
    - line_items[].unit_cost  # drops one field from every array element
```

```yaml
# Fully unfiltered. The acknowledgement is required, so this cannot be added
# by accident and shows up in a code review.
response:
  mode: passthrough
  acknowledgeUnfiltered: true
```

Guardrails, because `redact` and `passthrough` are load-bearing risk:

- `npm run validate` prints an **exposure report** every run, listing every
  endpoint that isn't strictly filtered. It's not buried in a log line.
- Boot logs a warning per unfiltered endpoint, and the startup line counts them.
- OpenAPI declares those endpoints `additionalProperties: true` with a note that
  the shape may change — rather than publishing a schema that becomes wrong the
  moment upstream ships a field.
- Discovery (below) warns the first time a never-before-seen field appears on an
  unfiltered endpoint. That's your early signal that upstream added a column and
  it is now reaching the vendor.

`rename` is whitelist-only. Renaming under `redact` is phase-2 transformation
work and the config loader rejects it rather than half-supporting it.

---

## Field discovery — authoring whitelists without a UI

This is the intended migration path, and the reason you don't need a field-picker
frontend.

```
1. Ship the endpoint in  mode: redact  (discovery turns on automatically)
2. Let real vendor traffic flow for a day
3. npm run fields -- get_invoice
4. Uncomment the paths the vendor should see, paste in, set mode: whitelist
```

Step 3 prints the field paths the upstream **actually returned**, accumulated
across every response seen — so optional fields that only appear sometimes are
caught too, which is exactly what you'd miss reading the upstream source:

```yaml
# ── get_invoice — 15 path(s) observed ──
# response:
#   mode: whitelist
#   fields:
#     # customer
#     - customer.gstin
#     - customer.internal_rating
#     - customer.name
#     - invoice_id
#     - paid_at            # only present on paid invoices
#     - total
```

Paths come out **commented** on purpose. Converting an endpoint should be a
deliberate act of picking fields, not a blanket copy of everything upstream
happens to return. `--all` emits them uncommented if you really want that.

Two properties worth knowing: only field **names** are recorded, never values —
so `discovered-fields.json` is safe to read, commit, and paste into a ticket. And
discovery never breaks a response; if it throws, the request still serves.

Set `DISCOVERY_FILE` to control where the snapshot lands. Add
`response.discover: true` to watch a whitelist endpoint's upstream too — useful
for noticing that upstream grew a field you might now want.

---

**Field path syntax**

| Path | Meaning |
|---|---|
| `id` | top-level scalar |
| `address.city` | nested scalar |
| `items[].id` | scalar inside every element of an array |
| `[].id` | scalar inside every element of a root-level array |

A whitelisted path must resolve to a **leaf** — a scalar, `null`, or an array of
scalars. If it resolves to an object, the value is dropped and an error is
logged. That restriction is deliberate: emitting an object wholesale would
forward its unknown sub-fields and silently defeat the whole mechanism. Name the
sub-fields you want.

---

## Naming your routes

Don't mirror upstream paths. If your vendor endpoint is
`/v1/internal/customer-records/:id`, you have told them your internal service
layout for free, and the next thing they try is
`/v1/internal/customer-records/:id/audit`. Pick names that describe the business
object — `/v1/customers/:id` — and let the mapping live in config.

---

## Vendor authentication

The vendor sends `X-API-Key` (or `Authorization: Bearer <key>` — same key, same
validation, offered because some HTTP clients make custom headers awkward).

Only the SHA-256 hash is stored, in an env var referenced from `vendors.yaml`. A
config or database dump therefore hands an attacker nothing usable. Hashing the
input before lookup also removes the timing side-channel from comparing secrets
directly: every request costs one hash and one hash-table lookup regardless of
whether the key was right, wrong, or nearly right.

**Rotation without downtime:** `keyEnv` takes a list. Generate a new key, add its
hash alongside the old, restart, let the vendor cut over, then remove the old
hash and restart again.

**Revocation:** delete the hash from the env file and restart. Immediate.

Pair this with an IP allowlist — Azure NSG and/or the nginx block in
`deploy/nginx.conf`. It is five minutes of work and it means a leaked key is
useless from anywhere but the vendor's own egress addresses. That is the single
strongest control available to you here.

---

## Scopes

Each endpoint requires a scope; each vendor holds a set of them. With one vendor
today this feels like ceremony, but it is what makes the second vendor a config
change instead of a second deployment — and it makes the generated OpenAPI spec
per-vendor, so one partner cannot discover another's endpoints from your docs.

---

## Errors

The vendor always receives:

```json
{ "error": { "code": "upstream_error", "message": "The request could not be completed.", "requestId": "..." } }
```

Nothing more. The real cause — upstream status, body, stack — is written to your
audit log against that same `requestId`, so when the vendor quotes an id your
team can find the exact line.

Note one deliberate choice: an upstream `401`/`403` becomes a generic `502` to
the vendor, not a `401`. If your credential to your own upstream has expired,
that is your operational problem; telling the vendor "unauthorized" would have
them retrying with their own key forever and would reveal that a second auth
layer exists.

---

## Audit logging

Every request produces one structured JSON line: `requestId`, vendor, endpoint,
method, status, upstream, and upstream latency. Failures add the internal reason.
Credentials are redacted at the logger, by path, so a future code change cannot
accidentally write one to disk. Rejected keys log the first six characters of the
*digest* — enough to distinguish "same wrong key repeatedly" from credential
stuffing, without writing any part of a real secret anywhere.

Goes to journald by default (`journalctl -u vendor-api-wrapper -f`). Set
`AUDIT_LOG=/var/log/vendor-api-wrapper/audit.log` for a file sink.

---

## Rate limiting and resilience

Three independent layers, because the vendor's retry behaviour is not yours to
control:

1. **nginx**, per IP — absorbs a flood before it costs a Node event-loop tick.
2. **The gateway**, per API key — a per-endpoint limit plus a global per-vendor
   ceiling, so a vendor can't multiply their allowance by spraying across every
   endpoint they hold.
3. **Circuit breaker**, per upstream — converts an upstream outage into a fast
   local 503 instead of a queue of stalled sockets against your internal API.
   Only 5xx counts toward tripping it; a vendor sending bad input cannot knock
   the endpoint offline for everyone.

The in-process limiter is per-instance. For one or two instances, set the limit
to `total / instance_count`. If you scale out properly, move the counters to
Redis — `src/middleware/rateLimit.js` has a deliberately narrow interface so
that's a one-file change.

---

## Vendor documentation

```bash
npm run openapi -- acme vendor-spec.json
```

Generated from the same whitelist that enforces the filtering, so the docs cannot
drift into describing a field you don't actually expose, and cannot name an
upstream. The live endpoint `GET /openapi.json` returns the spec filtered to the
calling vendor's scopes.

---

## Deploying to the Azure VM

```bash
sudo bash deploy/install.sh
```

Then follow the printed steps. In summary: fill `/etc/vendor-api-wrapper/env`,
point `upstreams.yaml` at your real hosts, `npm run validate`, start the service,
install the nginx config, run certbot, and lock the NSG to the vendor's IPs.

The Node process binds `127.0.0.1` only — nginx is the single public door. The
systemd unit runs as an unprivileged account with an empty capability set,
read-only filesystem, and a syscall filter, because this process holds
credentials to every upstream you own and is the one thing on the box an outside
party can talk to.

---

## Tests

```bash
npm test
```

**87 tests.** `npm test` runs the 61 that need no database. `npm run test:db`
runs 26 more against a real Postgres — set `TEST_DATABASE_URL` or they skip
rather than fail:

```bash
npm test
TEST_DATABASE_URL=postgresql://... npm run test:db
```

The database tests use a real instance on purpose. Idempotency and quota
correctness depend on atomic SQL semantics, and a mocked database would only
prove that the mock behaves the way I imagined it does.

The ones worth reading
first assert the guarantees rather than the plumbing: that secrets are absent
from responses, that the vendor's key never travels upstream, that vendor headers
aren't forwarded, that a leaky upstream 500 is scrubbed, and that a smuggled body
field is rejected.

---

## Operational notes

- `GET /healthz` — liveness. `GET /readyz` — 503 when any breaker is open.
  Both unauthenticated, so the nginx config restricts them to your VNet.
- Config is read at boot. Changing YAML requires a restart; that's intentional,
  so a half-edited manifest can't take effect mid-request.
- The service refuses to start on an invalid config rather than starting
  degraded. An unresolved `${ENV_VAR}` is a hard failure — a gateway that boots
  with an empty upstream credential fails confusingly at 3am instead of loudly
  at deploy time.
- `MAX_BODY` defaults to 64kb. Keep the nginx `client_max_body_size` in step.

---

## What this does not do

Worth being clear, so nobody assumes otherwise:

- **No admin UI.** Deliberate, for now. `endpoints.yaml` as code means a change
  diffs in a pull request — a colleague can see you just exposed `credit_score`
  before it ships — and rolls back with git. `scripts/gw.js` covers day-to-day
  operations. The thing a UI would genuinely help with is *discovering* which
  fields exist, and `npm run fields` does that already.
- **No response caching.** If the vendor polls a slow upstream hard, you'll feel
  it. Add caching per endpoint if the traffic pattern warrants it.
- **No request signing / replay protection.** HTTPS plus an API key is the model.
  If the vendor handles payment instructions or anything where replay matters,
  add HMAC request signing.
- **No per-vendor data partitioning beyond `inject`.** The `inject` mechanism
  forces a parameter, but it's your upstream that must honour it. Verify that it
  does — this gateway cannot enforce row-level access on your behalf.
- **No OAuth2.** API keys with rotation. Graduating to OAuth2 later doesn't
  change the endpoint surface.
- **Burst rate limiting is per-instance.** The monthly quota is shared via
  Postgres, but the sub-second limiter is in-process. For one or two instances set
  the limit to `total / instance_count`. Redis is the right answer beyond that;
  `src/middleware/rateLimit.js` has a narrow interface so it's a one-file change.
- **Revocation is eventually consistent,** up to `VENDOR_CACHE_REFRESH_MS`
  (30s default). That's the deliberate cost of keeping auth off the database hot
  path.
