-- ===========================================================================
-- 002_catalog.sql — the API catalogue, managed from the admin console
--
-- Until now upstreams and endpoints lived only in YAML. These tables let them
-- be onboarded through the UI instead, alongside per-vendor endpoint grants
-- and IP allowlists.
--
-- ⚠ NO CREDENTIAL IS STORED HERE.
--   An upstream's auth value holds the NAME of an environment variable, as
--   "${INTERNAL_NODE_API_TOKEN}", never the secret itself. The secret stays in
--   /etc/api-gateway/env on the VM. This database is shared infrastructure and
--   is backed up; a token in a backup is a token you cannot rotate confidently.
--   A CHECK constraint enforces the reference form.
--
-- Additive and guarded, like every migration here.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

-- ---------------------------------------------------------------------------
-- Upstreams — the real APIs. Never visible to a vendor.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS upstreams (
    name            TEXT PRIMARY KEY
                    CHECK (name ~ '^[a-z0-9][a-z0-9_]*$'),
    base_url        TEXT NOT NULL CHECK (base_url ~ '^https?://'),
    timeout_ms      INTEGER NOT NULL DEFAULT 5000
                    CHECK (timeout_ms BETWEEN 100 AND 120000),
    auth_type       TEXT NOT NULL DEFAULT 'none'
                    CHECK (auth_type IN ('none','bearer','header','basic','query')),
    -- For header/query: the header or parameter name. Unused for bearer/basic.
    auth_name       TEXT,
    -- ${ENV_VAR} reference, never a literal secret. NULL when auth_type='none'.
    auth_value_env  TEXT CHECK (auth_value_env IS NULL OR auth_value_env ~ '^\$\{[A-Z0-9_]+\}$'),
    -- basic auth needs two references.
    auth_user_env   TEXT CHECK (auth_user_env IS NULL OR auth_user_env ~ '^\$\{[A-Z0-9_]+\}$'),
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT
);

COMMENT ON COLUMN upstreams.auth_value_env IS
  'Environment variable REFERENCE such as ${INTERNAL_NODE_API_TOKEN}. Never a secret.';

-- ---------------------------------------------------------------------------
-- Endpoints — the vendor-facing wrappers.
--
-- response_mode is the security boundary:
--   whitelist   build the response field by field from response_fields
--   redact      forward everything except response_exclude
--   passthrough forward verbatim (requires acknowledge_unfiltered)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS endpoints (
    name            TEXT PRIMARY KEY
                    CHECK (name ~ '^[a-z0-9][a-z0-9_]*$'),
    method          TEXT NOT NULL DEFAULT 'GET'
                    CHECK (method IN ('GET','POST','PUT','PATCH','DELETE')),
    path            TEXT NOT NULL CHECK (path LIKE '/%'),
    upstream        TEXT NOT NULL REFERENCES upstreams(name) ON DELETE RESTRICT,
    upstream_path   TEXT NOT NULL CHECK (upstream_path LIKE '/%'),
    upstream_method TEXT CHECK (upstream_method IS NULL OR
                                upstream_method IN ('GET','POST','PUT','PATCH','DELETE')),

    response_mode   TEXT NOT NULL DEFAULT 'whitelist'
                    CHECK (response_mode IN ('whitelist','redact','passthrough')),
    response_fields  TEXT[] NOT NULL DEFAULT '{}',
    response_exclude TEXT[] NOT NULL DEFAULT '{}',
    acknowledge_unfiltered BOOLEAN NOT NULL DEFAULT FALSE,

    request_query   TEXT[] NOT NULL DEFAULT '{}',
    request_body    TEXT[] NOT NULL DEFAULT '{}',

    rate_window_ms  INTEGER NOT NULL DEFAULT 60000 CHECK (rate_window_ms > 0),
    rate_max        INTEGER NOT NULL DEFAULT 60    CHECK (rate_max > 0),
    idempotency     TEXT,

    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,

    -- A whitelist endpoint with no fields would emit {} for every request;
    -- that is a configuration mistake, not a design.
    CONSTRAINT whitelist_needs_fields
      CHECK (response_mode <> 'whitelist' OR cardinality(response_fields) > 0),
    CONSTRAINT redact_needs_exclude
      CHECK (response_mode <> 'redact' OR cardinality(response_exclude) > 0),
    -- Forwarding an upstream body verbatim has to be a deliberate act.
    CONSTRAINT passthrough_needs_ack
      CHECK (response_mode <> 'passthrough' OR acknowledge_unfiltered = TRUE)
);

CREATE UNIQUE INDEX IF NOT EXISTS endpoints_route_idx ON endpoints (method, path);
CREATE INDEX IF NOT EXISTS endpoints_upstream_idx ON endpoints (upstream);

-- Values the gateway FORCES on the upstream call, such as a tenant id the
-- vendor must not be able to choose. Separate table so a value can be an
-- ${ENV_VAR} reference or a literal.
CREATE TABLE IF NOT EXISTS endpoint_inject (
    endpoint   TEXT NOT NULL REFERENCES endpoints(name) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    PRIMARY KEY (endpoint, key)
);

-- ---------------------------------------------------------------------------
-- Which endpoints a vendor may call.
--
-- Scopes still exist and still work. This is the direct mapping the console
-- uses: tick the endpoints a vendor gets. Under the hood each endpoint is
-- given a scope of its own named "ep:<endpoint>", so the runtime authorisation
-- path is unchanged — one mechanism, not two.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_endpoints (
    vendor_id  TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL REFERENCES endpoints(name) ON DELETE CASCADE,
    PRIMARY KEY (vendor_id, endpoint)
);

-- ---------------------------------------------------------------------------
-- Per-vendor IP allowlist.
--
-- Checked in the application as well as at the NSG. The NSG protects the port;
-- this protects the KEY — with it, a leaked credential is useless from
-- anywhere but the vendor's own network, even if someone opens the firewall
-- wider later.
--
-- No rows for a vendor means no IP restriction, which is the existing
-- behaviour and so is safe to migrate into.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_ips (
    vendor_id  TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    cidr       CIDR NOT NULL,
    label      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    PRIMARY KEY (vendor_id, cidr)
);

-- ---------------------------------------------------------------------------
-- Change log.
--
-- Moving the catalogue out of git removes the diff that used to be the review
-- trail. This replaces it: who changed which object, when, and what it looked
-- like before and after. Without it, "who exposed that field?" has no answer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog_audit (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id   TEXT NOT NULL,
    before      JSONB,
    after       JSONB
);

CREATE INDEX IF NOT EXISTS catalog_audit_time_idx ON catalog_audit (occurred_at DESC);
CREATE INDEX IF NOT EXISTS catalog_audit_object_idx ON catalog_audit (object_type, object_id);
