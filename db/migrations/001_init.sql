-- ---------------------------------------------------------------------------
-- 001_init — vendors, keys, audit, quota, idempotency
--
-- Everything lives in its own schema so this never collides with whatever else
-- shares the Azure Postgres server.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS gateway;

SET search_path TO gateway, public;

-- ---------------------------------------------------------------------------
-- Vendors and their keys
--
-- A vendor has many keys so rotation is possible with no downtime: issue the
-- new one, let the vendor cut over, revoke the old.
--
-- Only the SHA-256 hash of a key is stored. There is deliberately no column
-- that could hold the plaintext, so a database dump, a backup, or a SELECT by
-- a DBA yields nothing usable.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vendors (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    -- Burst limits. Sub-second enforcement stays in process; these are the
    -- configured values the gateway loads.
    rate_window_ms  INTEGER NOT NULL DEFAULT 60000 CHECK (rate_window_ms > 0),
    rate_max        INTEGER NOT NULL DEFAULT 600   CHECK (rate_max > 0),
    -- Durable monthly cap. NULL means uncapped.
    monthly_quota   BIGINT CHECK (monthly_quota IS NULL OR monthly_quota > 0),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vendor_scopes (
    vendor_id   TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    scope       TEXT NOT NULL,
    PRIMARY KEY (vendor_id, scope)
);

CREATE TABLE IF NOT EXISTS vendor_keys (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id   TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    -- SHA-256 hex of the API key. Unique across all vendors: two vendors must
    -- never be able to share a credential.
    key_hash    CHAR(64) NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    label       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS vendor_keys_vendor_idx ON vendor_keys (vendor_id);
-- The cache refresh reads only live keys, so index exactly that predicate.
CREATE INDEX IF NOT EXISTS vendor_keys_live_idx ON vendor_keys (key_hash)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Audit log
--
-- One row per vendor request. Written asynchronously in batches: a slow or
-- unavailable database must never add latency to, or fail, a vendor request.
--
-- Note what is NOT here: no request body, no response body, no header values.
-- Storing those would make this table a second copy of your customers' data,
-- with all the retention and breach exposure that implies. Field names and
-- status codes answer the questions an audit actually asks.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id      UUID NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    vendor_id       TEXT,
    endpoint        TEXT,
    method          TEXT,
    path            TEXT,
    status          INTEGER,
    error_code      TEXT,
    upstream        TEXT,
    upstream_status INTEGER,
    upstream_ms     INTEGER,
    total_ms        INTEGER,
    response_mode   TEXT,
    client_ip       INET,
    -- Why the request failed, for your eyes. Never sent to the vendor.
    internal_reason TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_vendor_time_idx ON audit_log (vendor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_time_idx        ON audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_request_idx     ON audit_log (request_id);
-- Partial index: failures are what you actually go looking for.
CREATE INDEX IF NOT EXISTS audit_log_errors_idx      ON audit_log (occurred_at DESC)
    WHERE status >= 400;

-- ---------------------------------------------------------------------------
-- Monthly quota counters
--
-- Durable and shared across instances, unlike the in-process burst limiter.
-- Keyed by calendar month in UTC.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS quota_usage (
    vendor_id   TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    period      DATE NOT NULL,          -- first day of the month, UTC
    endpoint    TEXT NOT NULL DEFAULT '*',
    calls       BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (vendor_id, period, endpoint)
);

-- ---------------------------------------------------------------------------
-- Idempotency
--
-- Without this, a vendor whose request times out and retries creates the
-- resource twice. This is the single most likely production bug in a write
-- endpoint fronted by a network you do not control.
--
-- request_hash lets us detect the dangerous case: the same Idempotency-Key
-- reused with a DIFFERENT body. That is a client bug, and silently returning
-- the first response would hide it, so we reject it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS idempotency_keys (
    vendor_id       TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    endpoint        TEXT NOT NULL,
    request_hash    CHAR(64) NOT NULL,
    -- in_progress -> completed. A row stuck in_progress past its lease is
    -- treated as abandoned and may be retried.
    state           TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (state IN ('in_progress', 'completed')),
    response_status INTEGER,
    response_body   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (vendor_id, idempotency_key, endpoint)
);

CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Schema drift observed on upstream responses (the discovery feature).
-- Field NAMES only, never values.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS observed_fields (
    endpoint    TEXT NOT NULL,
    field_path  TEXT NOT NULL,
    first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (endpoint, field_path)
);
