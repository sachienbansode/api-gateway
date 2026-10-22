-- ===========================================================================
-- 019_param_secrets.sql — a credential that travels as a request parameter
--
-- WHY THIS EXISTS
--
-- Migration 004 sealed the supplier credential, and it covers every scheme
-- the gateway knew about: a bearer token, a custom header, ONE query
-- parameter, a basic auth pair. ACL does not fit any of them. Its push API
-- takes a user id AND a password as ordinary request parameters, so there is
-- no Authorization header to put anything in and `auth.type: query` holds a
-- single name/value pair.
--
-- With nowhere else to go, the only working place was
-- endpoint_params.fixed_value — a plain TEXT column, readable in any dump,
-- replica or screen-share. A password does not belong there, so this gives it
-- somewhere to go that is the same shape as the one the bearer token already
-- has.
--
-- ACL is not unusual. Most of the pre-JSON suppliers — SMS gateways, payment
-- gateways, the older exchange feeds — authenticate exactly this way, so this
-- is the normal case rather than an accommodation for one vendor.
--
-- WHAT IS AND IS NOT PROTECTED
--
--   Identical to 004, deliberately. AES-256-GCM, the key in GW_SECRET_KEY in
--   /etc/api-gateway/env and NEVER here, `aad` binding each row to the
--   endpoint and parameter it belongs to so a row copied elsewhere fails its
--   integrity check instead of quietly authenticating as something else.
--
--   It does not protect against someone holding both the database and the env
--   file. Nothing short of an HSM does.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

-- ---------------------------------------------------------------------------
-- 1. A fourth source
--
--   vendor  the consumer supplies it
--   fixed   a literal value, stored as written            (NOT for secrets)
--   env     a ${VAR} reference resolved from the env file
--   secret  sealed in endpoint_param_secrets below
--
-- `fixed` is kept as it is. It is the right answer for an account code, a
-- product id, a format flag — values that are ours but not sensitive, and
-- that an operator should be able to read back off the screen.
-- ---------------------------------------------------------------------------
ALTER TABLE endpoint_params DROP CONSTRAINT IF EXISTS endpoint_params_source_check;
ALTER TABLE endpoint_params ADD CONSTRAINT endpoint_params_source_check
  CHECK (source IN ('vendor', 'fixed', 'env', 'secret'));

-- A sealed parameter must NOT also carry a plaintext value. Without this the
-- obvious migration path — seal it, forget to blank the old column — leaves
-- the password in both places and the screen showing the safe one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'param_secret_has_no_plaintext') THEN
    ALTER TABLE endpoint_params ADD CONSTRAINT param_secret_has_no_plaintext
      CHECK (source <> 'secret' OR fixed_value IS NULL);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The sealed values
--
-- Same columns, same types and the same reasoning as upstream_secrets. BYTEA
-- rather than base64 text, because a column of readable-looking text invites
-- someone to "just look at it", and a column named *_hex gets indexed, logged
-- and exported.
-- ---------------------------------------------------------------------------
-- The key column is called `slot`, like the other two credential tables, and
-- holds the parameter's name. That is not cosmetic: db/repos/secrets.js is one
-- implementation serving every scope, and it keys on (subject, slot). Calling
-- this column `param` would have meant a second code path for sealing, audit
-- and rotation — and a fix applied to one and forgotten for the other.
CREATE TABLE IF NOT EXISTS gateway.endpoint_param_secrets (
    endpoint    TEXT NOT NULL,
    slot        TEXT NOT NULL,

    ciphertext  BYTEA NOT NULL CHECK (length(ciphertext) > 0),
    iv          BYTEA NOT NULL CHECK (length(iv) = 12),   -- GCM standard nonce
    tag         BYTEA NOT NULL CHECK (length(tag) = 16),  -- 128-bit auth tag
    key_id      TEXT  NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_]+$'),

    -- The last few characters, so an operator can confirm WHICH credential is
    -- in place without being shown it. Capped at 4: on a short secret that
    -- would be most of it, and the application stores nothing at all below
    -- twelve characters.
    hint        TEXT CHECK (hint IS NULL OR length(hint) <= 4),

    set_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    set_by      TEXT NOT NULL,
    rotated_at  TIMESTAMPTZ,

    PRIMARY KEY (endpoint, slot),
    FOREIGN KEY (endpoint, slot)
      REFERENCES gateway.endpoint_params(endpoint, name) ON DELETE CASCADE
);

COMMENT ON TABLE gateway.endpoint_param_secrets IS
  'AES-256-GCM sealed parameter credentials for suppliers that authenticate '
  'with ordinary request parameters. The key is GW_SECRET_KEY in the env file '
  'and is NEVER stored here. Do not add a column for it.';

CREATE INDEX IF NOT EXISTS endpoint_param_secrets_key_idx
  ON gateway.endpoint_param_secrets (key_id);

-- ---------------------------------------------------------------------------
-- 3. A view that is safe to SELECT * from
--
-- Someone will eventually run this during a screen-share. It should give them
-- what they actually wanted — is it set, who set it, when, which one — and
-- nothing else.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW gateway.endpoint_param_credentials AS
SELECT p.endpoint,
       p.name            AS param,
       p.location,
       p.source,
       (s.endpoint IS NOT NULL)                        AS is_set,
       CASE WHEN s.hint IS NULL THEN NULL
            ELSE '••••' || s.hint END                  AS masked,
       s.key_id,
       s.set_at,
       s.set_by,
       s.rotated_at
  FROM gateway.endpoint_params p
  LEFT JOIN gateway.endpoint_param_secrets s
         ON s.endpoint = p.endpoint AND s.slot = p.name
 WHERE p.source = 'secret';

COMMENT ON VIEW gateway.endpoint_param_credentials IS
  'Which parameter credentials are set, by whom and when. Contains no '
  'ciphertext and no plaintext — safe to read in front of other people.';
