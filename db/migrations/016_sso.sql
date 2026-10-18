-- ===========================================================================
-- 016_sso.sql — sign in through the Ashika Portal, and map its roles to ours
--
-- Two tables. Settings, and what a portal role means here.
--
-- Pravah already gets its roles from Ananta: adminAuth reads the users and
-- roles tables directly on uat_ananta_staging, live on every request behind a
-- 15-second cache. That works, and it couples this gateway to another
-- application's database schema — a column rename over there is an outage
-- over here. SSO replaces the coupling with a contract.
--
-- WHY A MAPPING TABLE RATHER THAN USING THE PORTAL'S ROLE DIRECTLY
--
--   The portal's model is a list of pages. Pravah's is finer: who may reveal
--   a supplier credential, who may deactivate an application and take its
--   endpoints out of service. Neither exists as a concept in the portal.
--
--   So the portal's role NAME arrives and this table says what it means here.
--   Offboarding still works from the portal alone, because a revoked account
--   cannot authenticate at all — this table only ever decides LEVEL, never
--   WHETHER.
--
--   This is not an assumption. The portal's External Applications screen has
--   an explicit Integration mode with exactly these two choices:
--
--     Managed    the portal imports our pages and owns the roles
--     Delegated  the app owns its own RBAC
--
--   Pravah is registered as DELEGATED, which is what this table implements.
--   If that is ever switched to Managed, this table stops being the authority
--   and the portal's imported page grants take over — so the mode is worth
--   checking before debugging a permissions problem here.
--
-- THE CLIENT SECRET IS SEALED, exactly like the SMTP password: AES-256-GCM
-- under GW_SECRET_KEY, which lives in /etc/api-gateway/env and never here.
-- This database is shared infrastructure and is backed up; a client secret in
-- a backup is a secret you cannot rotate confidently.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

CREATE TABLE IF NOT EXISTS gateway.sso_settings (
    id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    -- Off by default. Turning this on changes how everyone signs in, so it is
    -- a deliberate act after the Test button has passed, not a side effect of
    -- deploying a migration.
    enabled         BOOLEAN NOT NULL DEFAULT false,

    -- e.g. http://staging-api-uat.ashikagroup.com/api/sso
    -- The endpoints hang off this at their documented paths. Not configurable
    -- until one of them actually differs.
    base_url        TEXT,
    client_id       TEXT,

    -- PLAIN HTTP IS A DELIBERATE DECISION, NOT A DEFAULT.
    --
    -- The staging portal is http://. An authorization-code flow over plain
    -- HTTP puts the code and then the access token on the wire in clear, and
    -- anyone who can read that traffic becomes an administrator of this
    -- gateway. Tolerable on an internal UAT network; never in production. The
    -- application refuses a non-https base_url unless this is explicitly set,
    -- so the staging config cannot reach production by copy-paste.
    allow_insecure  BOOLEAN NOT NULL DEFAULT false,

    -- The client secret, sealed. Same shape as gateway.upstream_secrets:
    -- BYTEA, not base64 in a text column that invites someone to look.
    secret_ciphertext BYTEA,
    secret_iv         BYTEA CHECK (secret_iv IS NULL OR length(secret_iv) = 12),
    secret_tag        BYTEA CHECK (secret_tag IS NULL OR length(secret_tag) = 16),
    secret_key_id     TEXT  CHECK (secret_key_id IS NULL OR secret_key_id ~ '^[A-Za-z0-9_]+$'),
    secret_hint       TEXT  CHECK (secret_hint IS NULL OR length(secret_hint) <= 4),

    -- No client secret was issued with the credentials. A public client uses
    -- PKCE instead; which one the portal expects is still unconfirmed, so
    -- both are supported and this records the answer once it is known.
    use_pkce        BOOLEAN NOT NULL DEFAULT false,

    -- Where the portal sends people back. Stored rather than derived, because
    -- it must match what the portal registered EXACTLY — scheme, port and
    -- trailing slash included — and a mismatch is the single most common
    -- reason an SSO integration fails with an unhelpful error.
    redirect_uri    TEXT,

    -- What the last Test did, so the screen shows a state rather than making
    -- somebody press the button to find out. `test_detail` holds the shapes
    -- the portal returned — field names only, never values — which is how the
    -- response contract gets confirmed without guessing at it in code.
    test_status     TEXT CHECK (test_status IS NULL OR test_status IN ('ok','failed')),
    test_error      TEXT,
    test_detail     JSONB,
    last_tested_at  TIMESTAMPTZ,

    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,

    -- Half a sealed secret is worse than none: it fails at the moment somebody
    -- is trying to sign in. All four parts or none.
    CONSTRAINT sso_secret_complete CHECK (
      (secret_ciphertext IS NULL AND secret_iv IS NULL AND secret_tag IS NULL
       AND secret_key_id IS NULL)
      OR
      (secret_ciphertext IS NOT NULL AND secret_iv IS NOT NULL AND secret_tag IS NOT NULL
       AND secret_key_id IS NOT NULL)
    )
);

COMMENT ON TABLE gateway.sso_settings IS
  'Ashika Portal SSO. The client secret is AES-256-GCM sealed under '
  'GW_SECRET_KEY, which lives in the env file and NEVER here.';

INSERT INTO gateway.sso_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- What a portal role means here
--
-- Matched case-insensitively against whatever the portal returns. `level` is
-- Pravah's own vocabulary, deliberately small:
--
--   none    recognised, but not allowed into this console at all
--   view    may read every screen; may change nothing
--   edit    may change the catalogue, applications and settings
--   admin   edit, plus the audited credential reveal
--
-- A portal role with no row here gets `none` and is told so BY NAME, because
-- "access denied" that does not say which role was presented generates a
-- support ticket every single time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway.sso_role_map (
    portal_role     TEXT PRIMARY KEY,
    level           TEXT NOT NULL DEFAULT 'view'
                    CHECK (level IN ('none','view','edit','admin')),
    notes           TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS sso_role_map_lower_idx
    ON gateway.sso_role_map (lower(portal_role));

-- The roles db/platform/001_gateway_access.sql already created in the portal.
-- Seeded so SSO works the moment it is switched on, rather than denying
-- everyone until somebody populates a table they have not seen yet.
INSERT INTO gateway.sso_role_map (portal_role, level, notes) VALUES
  ('SuperAdmin', 'admin', 'Full access including the audited credential reveal.'),
  ('API Admin',  'edit',  'May build and publish endpoints and manage applications.'),
  ('API Viewer', 'view',  'May read every screen and change nothing.')
ON CONFLICT (portal_role) DO NOTHING;
