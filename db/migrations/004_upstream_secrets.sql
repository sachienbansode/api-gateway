-- ===========================================================================
-- 004_upstream_secrets.sql — supplier credentials, encrypted, in the database
--
-- Until now an upstream could only reference an environment variable. That
-- works, but it means onboarding an API is a two-person job: someone fills in
-- the form, someone else SSHes into the VM and edits /etc/api-gateway/env.
-- This makes the credential part of onboarding, which is what it should be.
--
-- WHAT IS AND IS NOT PROTECTED
--
--   The ciphertext is AES-256-GCM. The KEY is NOT here — it lives in
--   GW_SECRET_KEY in /etc/api-gateway/env. That separation is the whole
--   mechanism: a backup, a replica, a dump handed to a DBA, a stolen disk
--   decrypt to nothing on their own. A key stored next to the ciphertext it
--   protects is decoration, so if you ever find yourself putting
--   GW_SECRET_KEY in a table, stop.
--
--   It does NOT protect against someone who has both the database and the env
--   file — which is to say, against the application itself being compromised.
--   Nothing short of an HSM does.
--
--   `aad` binds each ciphertext to the upstream it belongs to. A row copied
--   from one supplier to another fails its integrity check instead of quietly
--   authenticating as the wrong one.
--
-- ROTATION
--   Each row records the key id it was sealed with. GW_SECRET_KEY may list
--   several keys, newest first, so rotation is re-encrypting rows in the
--   background rather than an outage.
--
-- The ${VAR} path still works and is unchanged. The internal upstreams keep
-- using it; nothing is migrated by this script.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

-- Where an upstream's credential comes from.
--   env    auth_value_env holds ${VAR}, resolved from the environment
--   vault  upstream_secrets holds it, encrypted
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS auth_source TEXT NOT NULL DEFAULT 'env';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upstreams_auth_source_chk') THEN
    ALTER TABLE upstreams ADD CONSTRAINT upstreams_auth_source_chk
      CHECK (auth_source IN ('env','vault'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The sealed credentials.
--
-- A table rather than seven more columns on `upstreams`, because basic auth
-- needs two secrets and the next scheme will want its own. `slot` says which
-- one: 'value' is the token, key or password; 'username' is the other half of
-- basic auth.
--
-- BYTEA, not text. Base64 in a text column invites someone to "just look at
-- it", and a column named *_hex gets indexed, logged and exported.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS upstream_secrets (
    upstream    TEXT NOT NULL REFERENCES upstreams(name) ON DELETE CASCADE,
    slot        TEXT NOT NULL DEFAULT 'value'
                CHECK (slot IN ('value','username')),

    ciphertext  BYTEA NOT NULL CHECK (length(ciphertext) > 0),
    iv          BYTEA NOT NULL CHECK (length(iv) = 12),   -- GCM standard nonce
    tag         BYTEA NOT NULL CHECK (length(tag) = 16),  -- 128-bit auth tag
    key_id      TEXT  NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_]+$'),

    -- The last few characters, so an operator can tell which credential is in
    -- place without being shown it. Capped at 4: on a short secret that would
    -- be most of it, so the application stores nothing at all in that case.
    hint        TEXT CHECK (hint IS NULL OR length(hint) <= 4),

    set_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    set_by      TEXT NOT NULL,
    rotated_at  TIMESTAMPTZ,

    PRIMARY KEY (upstream, slot)
);

COMMENT ON TABLE upstream_secrets IS
  'AES-256-GCM sealed supplier credentials. The key is GW_SECRET_KEY in the '
  'env file and is NEVER stored here. Do not add a column for it.';
COMMENT ON COLUMN upstream_secrets.key_id IS
  'Which GW_SECRET_KEY entry sealed this row, so keys can be rotated without '
  'an outage.';

CREATE INDEX IF NOT EXISTS upstream_secrets_key_idx ON upstream_secrets (key_id);

-- ---------------------------------------------------------------------------
-- A view that is safe to SELECT * from.
--
-- Someone will eventually run `select * from upstreams` in a screen-share.
-- This gives them the thing they actually wanted — is the credential set, who
-- set it, when — with nothing sensitive in it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW upstream_credentials AS
SELECT u.name               AS upstream,
       u.display_name,
       u.auth_type,
       u.auth_source,
       u.auth_value_env,
       (s.upstream IS NOT NULL)                       AS secret_stored,
       CASE WHEN s.hint IS NOT NULL AND s.hint <> ''
            THEN '****' || s.hint END                 AS secret_hint,
       s.key_id,
       s.set_at,
       s.set_by,
       s.rotated_at
  FROM gateway.upstreams u
  LEFT JOIN gateway.upstream_secrets s
         ON s.upstream = u.name AND s.slot = 'value';

COMMENT ON VIEW upstream_credentials IS
  'Credential STATUS, never the credential. Safe to read, export and screen-share.';

-- ---------------------------------------------------------------------------
-- Changing a credential is a security event. Record it — without it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS secret_audit (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    upstream    TEXT NOT NULL,
    slot        TEXT NOT NULL,
    action      TEXT NOT NULL CHECK (action IN ('set','rotate','clear','decrypt_failed')),
    actor       TEXT NOT NULL,
    key_id      TEXT,
    hint        TEXT CHECK (hint IS NULL OR length(hint) <= 4),
    note        TEXT
);

CREATE INDEX IF NOT EXISTS secret_audit_time_idx ON secret_audit (occurred_at DESC);
CREATE INDEX IF NOT EXISTS secret_audit_upstream_idx ON secret_audit (upstream, occurred_at DESC);
