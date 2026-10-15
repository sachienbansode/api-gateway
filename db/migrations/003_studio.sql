-- ===========================================================================
-- 003_studio.sql — everything the API Studio wizard needs.
--
-- 002 gave us upstreams, endpoints and per-vendor grants. This adds the layer
-- the console works in:
--
--   applications      the product an API belongs to (CMOTS Market Data, …).
--                     Matches the "application" column the OmneNEST key
--                     permissions already use, so one key can be scoped to an
--                     application here and there.
--   api_types         dropdown, admin-configurable. NOT the HTTP method —
--                     what KIND of API it is (master data, report, calculator…)
--   api_categories    dropdown, admin-configurable, scoped to an application.
--                     "Company Financial", "Mutual Fund (EOD)" …
--   endpoint_params   request parameters, one row each, with where they go
--                     (path/query/header/body) and whether the vendor may set
--                     them. 002 carried these as two TEXT[] columns, which
--                     cannot say "path param, required, integer, co_code".
--   endpoint_fields   the response field catalogue: name, datatype, meaning,
--                     and `exposed` — the tick box in step 3. This is the
--                     documentation AND the source of the whitelist.
--   connection_tests  every step-1 and step-4 test, with status and latency.
--                     A test nobody recorded is a test nobody can show the
--                     auditor.
--
-- ⚠ STILL NO CREDENTIAL IS STORED. Step 1 collects an auth value and writes
--   the ENV VAR NAME; the value goes to /etc/api-gateway/env. The CHECK
--   constraint from 002 is unchanged and still enforces that.
--
-- Additive and guarded, like every migration here. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

-- ---------------------------------------------------------------------------
-- Applications — the top of the tree. "Select Application" in the wizard.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applications (
    code        TEXT PRIMARY KEY CHECK (code ~ '^[a-z0-9][a-z0-9_]*$'),
    name        TEXT NOT NULL,
    description TEXT,
    owner_email TEXT,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INTEGER NOT NULL DEFAULT 100,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  TEXT
);

-- ---------------------------------------------------------------------------
-- API type — admin-configurable dropdown, step 2.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_types (
    code        TEXT PRIMARY KEY CHECK (code ~ '^[a-z0-9][a-z0-9_]*$'),
    label       TEXT NOT NULL,
    description TEXT,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INTEGER NOT NULL DEFAULT 100
);

-- ---------------------------------------------------------------------------
-- Category — admin-configurable dropdown, step 2. Scoped to an application so
-- "Mutual Fund (EOD)" does not turn up in an unrelated product's list.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_categories (
    code        TEXT NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_]*$'),
    application TEXT NOT NULL REFERENCES applications(code) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    description TEXT,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INTEGER NOT NULL DEFAULT 100,
    PRIMARY KEY (application, code)
);

-- ---------------------------------------------------------------------------
-- Columns the wizard adds to what 002 created.
-- ---------------------------------------------------------------------------
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS application  TEXT REFERENCES applications(code);
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS vendor_name  TEXT;   -- who supplies it
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS health_path  TEXT;   -- cheap GET for step 1
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS last_test_at     TIMESTAMPTZ;
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS last_test_status INTEGER;
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS last_test_ms     INTEGER;

ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS application  TEXT REFERENCES applications(code);
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS category     TEXT;
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS api_type     TEXT REFERENCES api_types(code);
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS description  TEXT;
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS frequency    TEXT;   -- EOD, intraday …
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS refresh_at   TEXT;   -- "23:30:00"
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS sample_path  TEXT;   -- a real URL that works
-- Added with DEFAULT 'live', then the default is changed to 'draft': any
-- endpoint that already existed was being served before this migration and
-- must keep being served, while everything created from here on starts as a
-- draft.
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'live';
ALTER TABLE endpoints ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS last_test_at     TIMESTAMPTZ;
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS last_test_status INTEGER;

-- A draft is an endpoint someone is still building in the wizard; it is not
-- served. Only 'live' is routed. Separating them means a half-finished
-- endpoint can be saved without being exposed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'endpoints_status_chk') THEN
    ALTER TABLE endpoints ADD CONSTRAINT endpoints_status_chk
      CHECK (status IN ('draft','live','retired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'endpoints_category_fk') THEN
    ALTER TABLE endpoints ADD CONSTRAINT endpoints_category_fk
      FOREIGN KEY (application, category) REFERENCES api_categories(application, code);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS endpoints_app_idx      ON endpoints (application, category);
CREATE INDEX IF NOT EXISTS endpoints_status_idx   ON endpoints (status);
CREATE INDEX IF NOT EXISTS upstreams_app_idx      ON upstreams (application);

-- ---------------------------------------------------------------------------
-- Request parameters — step 3, the "+/- request parameters" half.
--
-- `location`   where it travels: path, query, header or body
-- `source`     where the VALUE comes from:
--                vendor   the caller supplies it
--                fixed    we force a value (fixed_value)
--                env      we force an ${ENV_VAR} value
--              A 'fixed' or 'env' parameter is one the vendor cannot influence
--              — that is how a tenant id or an account code stays ours.
-- `forward_as` the name the UPSTREAM expects, when it differs from ours. This
--              is the rename half of the transformation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS endpoint_params (
    endpoint    TEXT NOT NULL REFERENCES endpoints(name) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    location    TEXT NOT NULL DEFAULT 'query'
                CHECK (location IN ('path','query','header','body')),
    source      TEXT NOT NULL DEFAULT 'vendor'
                CHECK (source IN ('vendor','fixed','env')),
    forward_as  TEXT,
    data_type   TEXT NOT NULL DEFAULT 'string'
                CHECK (data_type IN ('string','int','number','bool','date','enum')),
    required    BOOLEAN NOT NULL DEFAULT FALSE,
    fixed_value TEXT,
    allowed     TEXT[] NOT NULL DEFAULT '{}',   -- enum whitelist, e.g. {S,C}
    example     TEXT,
    description TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 100,
    PRIMARY KEY (endpoint, name),

    -- A fixed parameter with nothing to put there is a silent no-op.
    CONSTRAINT param_fixed_needs_value
      CHECK (source <> 'fixed' OR fixed_value IS NOT NULL),
    -- An env-sourced parameter must be a REFERENCE, never the secret itself.
    CONSTRAINT param_env_is_reference
      CHECK (source <> 'env' OR fixed_value ~ '^\$\{[A-Z0-9_]+\}$'),
    -- A path parameter the vendor does not supply cannot be filled at all.
    CONSTRAINT param_path_is_required
      CHECK (location <> 'path' OR required = TRUE OR source <> 'vendor')
);

CREATE INDEX IF NOT EXISTS endpoint_params_ep_idx ON endpoint_params (endpoint);

-- ---------------------------------------------------------------------------
-- Response fields — step 3, the "+/- response parameters" half.
--
-- Every field the upstream is known to return, whether or not we pass it on.
-- `exposed` is the tick box. The endpoint's response_fields[] array stays the
-- runtime source of truth (the projection code reads it on boot); this table
-- is what the console edits and what documents the API. sync_endpoint_fields()
-- below copies one into the other so they cannot drift.
--
-- `discovered` marks a field the gateway SAW in a live response but that
-- nobody has decided about yet — the thing that tells you an upstream started
-- returning a PAN number last Tuesday.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS endpoint_fields (
    endpoint    TEXT NOT NULL REFERENCES endpoints(name) ON DELETE CASCADE,
    path        TEXT NOT NULL,                 -- "data.co_code", dotted
    data_type   TEXT,                          -- as documented by the supplier
    description TEXT,
    exposed     BOOLEAN NOT NULL DEFAULT FALSE,
    rename_to   TEXT,                          -- our name for it, if different
    sensitive   BOOLEAN NOT NULL DEFAULT FALSE,
    discovered  BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen  TIMESTAMPTZ,
    sort_order  INTEGER NOT NULL DEFAULT 100,
    PRIMARY KEY (endpoint, path)
);

CREATE INDEX IF NOT EXISTS endpoint_fields_ep_idx  ON endpoint_fields (endpoint);
CREATE INDEX IF NOT EXISTS endpoint_fields_new_idx ON endpoint_fields (endpoint)
  WHERE discovered AND NOT exposed;

-- A draft may have no fields chosen yet — that is what a draft IS. The
-- constraint from 002 forbade it outright, which made it impossible to create
-- an endpoint in step 2 and tick its fields in step 3. Re-state it so the rule
-- bites where it matters: nothing goes LIVE on an empty whitelist.
ALTER TABLE endpoints DROP CONSTRAINT IF EXISTS whitelist_needs_fields;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whitelist_needs_fields') THEN
    ALTER TABLE endpoints ADD CONSTRAINT whitelist_needs_fields CHECK (
      response_mode <> 'whitelist'
      OR status <> 'live'
      OR cardinality(response_fields) > 0
    );
  END IF;
END $$;

-- Keep endpoints.response_fields in step with the tick boxes.
--
-- A trigger rather than application code on purpose: this array is what the
-- gateway actually projects with. If someone fixes a field list in pgAdmin at
-- 2am — and someone will — the runtime must follow. One source of truth, kept
-- by the database that owns it.
--
-- Statement-level with transition tables, not FOR EACH ROW: loading an
-- endpoint's 163 fields would otherwise rewrite the same array 163 times, and
-- the intermediate states are not states anyone wants a CHECK evaluated
-- against.
CREATE OR REPLACE FUNCTION sync_endpoint_fields(p_endpoints TEXT[]) RETURNS void
LANGUAGE sql AS $$
  UPDATE gateway.endpoints e SET
    response_fields = COALESCE((
      SELECT array_agg(f.path ORDER BY f.sort_order, f.path)
        FROM gateway.endpoint_fields f
       WHERE f.endpoint = e.name AND f.exposed
    ), '{}'),
    updated_at = now()
   WHERE e.name = ANY (p_endpoints)
     AND e.response_mode = 'whitelist';
$$;

CREATE OR REPLACE FUNCTION trg_fields_ins() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM gateway.sync_endpoint_fields(
    ARRAY(SELECT DISTINCT endpoint FROM newtab));
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION trg_fields_upd() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM gateway.sync_endpoint_fields(
    ARRAY(SELECT endpoint FROM newtab UNION SELECT endpoint FROM oldtab));
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION trg_fields_del() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM gateway.sync_endpoint_fields(
    ARRAY(SELECT DISTINCT endpoint FROM oldtab));
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS endpoint_fields_sync     ON endpoint_fields;
DROP TRIGGER IF EXISTS endpoint_fields_sync_ins ON endpoint_fields;
DROP TRIGGER IF EXISTS endpoint_fields_sync_upd ON endpoint_fields;
DROP TRIGGER IF EXISTS endpoint_fields_sync_del ON endpoint_fields;

CREATE TRIGGER endpoint_fields_sync_ins AFTER INSERT ON endpoint_fields
  REFERENCING NEW TABLE AS newtab
  FOR EACH STATEMENT EXECUTE FUNCTION trg_fields_ins();

CREATE TRIGGER endpoint_fields_sync_upd AFTER UPDATE ON endpoint_fields
  REFERENCING OLD TABLE AS oldtab NEW TABLE AS newtab
  FOR EACH STATEMENT EXECUTE FUNCTION trg_fields_upd();

CREATE TRIGGER endpoint_fields_sync_del AFTER DELETE ON endpoint_fields
  REFERENCING OLD TABLE AS oldtab
  FOR EACH STATEMENT EXECUTE FUNCTION trg_fields_del();

-- ---------------------------------------------------------------------------
-- Test log — step 1 ("does the supplier answer us?") and step 4 ("does our
-- wrapper answer, and what exactly does the vendor see?").
--
-- response_sample is the projected body, which by construction holds only
-- fields we chose to expose. The raw upstream body is NOT stored: it is the
-- thing we are protecting.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connection_tests (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind        TEXT NOT NULL CHECK (kind IN ('upstream','endpoint')),
    upstream    TEXT,
    endpoint    TEXT,
    actor       TEXT NOT NULL,
    request_url TEXT,
    status      INTEGER,
    latency_ms  INTEGER,
    ok          BOOLEAN NOT NULL DEFAULT FALSE,
    error       TEXT,
    field_count INTEGER,
    response_sample JSONB
);

CREATE INDEX IF NOT EXISTS connection_tests_time_idx ON connection_tests (occurred_at DESC);
CREATE INDEX IF NOT EXISTS connection_tests_ep_idx   ON connection_tests (endpoint, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Starter dropdown values. The console can add more; these make the wizard
-- usable the minute the migration lands.
-- ---------------------------------------------------------------------------
INSERT INTO api_types (code, label, description, sort_order) VALUES
  ('master',      'Master / Reference', 'Slow-moving reference data — codes, names, mappings', 10),
  ('fundamental', 'Fundamental',        'Reported financials and ratios',                        20),
  ('market',      'Market Data',        'Prices, volumes, technical indicators',                 30),
  ('news',        'News & Announcements','Narrative and corporate disclosure feeds',             40),
  ('calculator',  'Calculator',         'Computes a result from supplied inputs',                50),
  ('report',      'Report',             'Pre-built aggregate for a screen or download',          60),
  ('transaction', 'Transactional',      'Changes state upstream — orders, bookings, payments',   70)
ON CONFLICT (code) DO NOTHING;
