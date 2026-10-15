-- ===========================================================================
-- 009_endpoint_secrets.sql — a credential that belongs to ONE endpoint
--
-- 004 put the supplier's credential on the upstream, which is where it
-- usually belongs: one account with CMOTS, one token, every endpoint behind
-- it. But that is not the only shape a supplier sells.
--
-- Three cases that need a credential narrower than the upstream:
--
--   * Metered products. The same host serves the free quote feed and the
--     paid fundamentals feed on separate subscriptions, and the second token
--     must not be reachable from an endpoint that only needed the first.
--   * Staged migration. The supplier issues a new token for one product
--     first. You want to move one endpoint across and watch it, not all
--     sixty-eight at once.
--   * Blast radius. If a token is going to leak, it should take the smallest
--     possible number of endpoints with it when it is revoked.
--
-- HOW IT RESOLVES
--
--   auth_mode = 'inherit'   (the default, and what every existing row gets)
--       the endpoint uses the upstream's credential. Unchanged behaviour.
--   auth_mode = 'override'
--       the endpoint carries its own, sealed in endpoint_secrets. It may also
--       carry its own SCHEME: an upstream on bearer can have one endpoint
--       that the supplier insists on serving with ?apikey=.
--
-- The same encryption as 004 — AES-256-GCM, GW_SECRET_KEY from the env file,
-- never in this database. The AAD is 'endpoint:<name>:<slot>' rather than
-- 'upstream:...', so a row lifted from the upstream table into this one fails
-- its integrity check instead of silently authenticating.
--
-- An override with no stored secret is REFUSED at save time and, if one ever
-- gets here by hand, the endpoint is dropped from the served catalogue rather
-- than called with the upstream's token. Falling back would defeat the point:
-- the reason to narrow a credential is that the wider one must not be used.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

-- ---------------------------------------------------------------------------
-- Which credential an endpoint calls with.
-- ---------------------------------------------------------------------------
ALTER TABLE gateway.endpoints ADD COLUMN IF NOT EXISTS auth_mode TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE gateway.endpoints ADD COLUMN IF NOT EXISTS auth_type TEXT;
ALTER TABLE gateway.endpoints ADD COLUMN IF NOT EXISTS auth_name TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'endpoints_auth_mode_chk') THEN
    ALTER TABLE gateway.endpoints ADD CONSTRAINT endpoints_auth_mode_chk
      CHECK (auth_mode IN ('inherit','override'));
  END IF;

  -- An override has to say which scheme, and a header/query scheme has to say
  -- which header or parameter. Enforced here as well as in the application,
  -- because a half-specified override is a call made with no credential at
  -- all, and that fails as a 401 from the supplier hours later.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'endpoints_auth_shape_chk') THEN
    ALTER TABLE gateway.endpoints ADD CONSTRAINT endpoints_auth_shape_chk
      CHECK (
        auth_mode <> 'override'
        OR (
          auth_type IN ('bearer','header','query','basic','none')
          AND (auth_type NOT IN ('header','query') OR coalesce(auth_name,'') <> '')
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN gateway.endpoints.auth_mode IS
  'inherit = use the upstream credential (default). override = this endpoint '
  'has its own, sealed in endpoint_secrets.';

-- ---------------------------------------------------------------------------
-- The sealed per-endpoint credentials. Same column shape as upstream_secrets
-- on purpose: one mental model, one rotation routine, one audit table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway.endpoint_secrets (
    endpoint    TEXT NOT NULL REFERENCES gateway.endpoints(name) ON DELETE CASCADE,
    slot        TEXT NOT NULL DEFAULT 'value'
                CHECK (slot IN ('value','username')),

    ciphertext  BYTEA NOT NULL CHECK (length(ciphertext) > 0),
    iv          BYTEA NOT NULL CHECK (length(iv) = 12),
    tag         BYTEA NOT NULL CHECK (length(tag) = 16),
    key_id      TEXT  NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_]+$'),

    hint        TEXT CHECK (hint IS NULL OR length(hint) <= 4),

    set_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    set_by      TEXT NOT NULL,
    rotated_at  TIMESTAMPTZ,

    PRIMARY KEY (endpoint, slot)
);

COMMENT ON TABLE gateway.endpoint_secrets IS
  'AES-256-GCM sealed credentials scoped to a single endpoint. The key is '
  'GW_SECRET_KEY in the env file and is NEVER stored here.';

CREATE INDEX IF NOT EXISTS endpoint_secrets_key_idx ON gateway.endpoint_secrets (key_id);

-- ---------------------------------------------------------------------------
-- The audit table now covers both scopes.
--
-- `upstream` becomes nullable and `endpoint` joins it. One table rather than
-- two, because the question people ask is "who touched a credential", not
-- "who touched an upstream credential".
-- ---------------------------------------------------------------------------
ALTER TABLE gateway.secret_audit ADD COLUMN IF NOT EXISTS endpoint TEXT;
ALTER TABLE gateway.secret_audit ALTER COLUMN upstream DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_audit_scope_chk') THEN
    ALTER TABLE gateway.secret_audit ADD CONSTRAINT secret_audit_scope_chk
      CHECK (upstream IS NOT NULL OR endpoint IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS secret_audit_endpoint_idx
  ON gateway.secret_audit (endpoint, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Status, never the value. The sibling of gateway.upstream_credentials.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW gateway.endpoint_credentials AS
SELECT e.name                                         AS endpoint,
       e.upstream,
       e.auth_mode,
       e.auth_type,
       e.auth_name,
       (s.endpoint IS NOT NULL)                       AS secret_stored,
       CASE WHEN s.hint IS NOT NULL AND s.hint <> ''
            THEN '****' || s.hint END                 AS secret_hint,
       s.key_id,
       s.set_at,
       s.set_by,
       s.rotated_at,
       -- The thing an operator actually wants to know at a glance: is this
       -- endpoint configured to use a credential that does not exist?
       -- An override of 'none' is the deliberate "call this one with no
       -- credential at all" case and needs no secret, so it is not broken.
       (e.auth_mode = 'override' AND coalesce(e.auth_type,'') <> 'none'
          AND s.endpoint IS NULL)                     AS broken
  FROM gateway.endpoints e
  LEFT JOIN gateway.endpoint_secrets s
         ON s.endpoint = e.name AND s.slot = 'value';

COMMENT ON VIEW gateway.endpoint_credentials IS
  'Per-endpoint credential STATUS. Safe to read, export and screen-share. '
  '"broken" means an override was configured and then its secret removed.';

-- ---------------------------------------------------------------------------
-- Rebuilt so the access log answers for both scopes in one SELECT.
--
-- DROP then CREATE, not CREATE OR REPLACE: replacing a view can only append
-- columns, and this one gains `subject` and `scope` in the middle. Nothing
-- depends on it but the admin console, which reads it by name.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS gateway.credential_access;

CREATE VIEW gateway.credential_access AS
SELECT occurred_at, actor,
       coalesce(upstream, endpoint)                  AS subject,
       CASE WHEN endpoint IS NOT NULL THEN 'endpoint' ELSE 'upstream' END AS scope,
       upstream, endpoint, slot, action, reason, hint, key_id
  FROM gateway.secret_audit
 WHERE action IN ('reveal','set','rotate','clear')
 ORDER BY occurred_at DESC;

COMMENT ON VIEW gateway.credential_access IS
  'Every time a credential — supplier-wide or endpoint-scoped — was set, '
  'replaced, removed or READ, and by whom.';
