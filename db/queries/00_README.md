# Ops queries for pgAdmin

Paste any of these into a pgAdmin Query Tool connected to the `gateway`
database. All read-only — none of them write or delete anything.

Connect as the **server admin** or `gw_owner` to run them by hand. `gw_app`
can also read these tables, but keep its credential for the gateway.

| File | Answers |
|---|---|
| `01_vendor_overview.sql` | Who has access, to what, with how many live keys |
| `02_traffic.sql` | Calls, errors, latency per vendor and endpoint |
| `03_errors.sql` | Recent failures, with the internal reason the vendor never saw |
| `04_trace_request.sql` | Everything about one request the vendor is asking about |
| `05_quota.sql` | Monthly usage against each vendor's cap |
| `06_keys.sql` | Key inventory — issued, last used, revoked, stale |
| `07_schema_drift.sql` | Fields upstreams return that you have not whitelisted |
| `08_idempotency.sql` | Replay protection health, stuck claims |
| `09_table_sizes.sql` | Growth and whether retention is actually running |

Each file has an equivalent in the CLI (`node scripts/gw.js usage`,
`audit:trace`, `vendor:list`, …) which is usually quicker. These exist for when
you are already in pgAdmin, or want to adapt the SQL.
