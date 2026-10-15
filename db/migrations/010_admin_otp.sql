-- ===========================================================================
-- 010_admin_otp.sql — the second factor for console sign-in
--
-- A platform role can be marked requires_mfa, and a user can have mfa_enabled.
-- Until now this console ignored both: a role deliberately marked as needing a
-- second factor got in with a password alone, and nothing said so. Weaker
-- authentication than the platform gives, silently, is the kind of gap that is
-- only discovered during an audit.
--
-- WHY THE CHALLENGE LIVES HERE AND NOT IN THE PLATFORM'S otp_tokens
--
-- The platform connection is READ-ONLY by intent — the gateway reads identity
-- and grants and writes nothing, so that a gateway compromise cannot become a
-- way to grant yourself a role on the platform. Writing OTP rows into
-- "admin-staging-api".otp_tokens would mean granting this application INSERT,
-- UPDATE and DELETE on the schema that holds users and roles, to support a
-- login screen. That trade is not worth making.
--
-- So the challenge is ours and lives in the gateway database. What we still
-- take from the platform is read-only and unchanged: whether the role requires
-- MFA, and the SMTP settings to send the mail with.
--
-- WHAT IS STORED
--
-- Never the code. An HMAC of it, keyed by a server-side secret, so the table
-- on its own is useless: a six-digit code has a million possibilities and a
-- plain hash of one is brute-forced instantly, which is why this is an HMAC
-- and not a digest.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

CREATE TABLE IF NOT EXISTS gateway.admin_otp (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- The platform user this challenge belongs to. Deliberately NOT a foreign
    -- key: that table is in another database.
    user_id      TEXT        NOT NULL,
    email        TEXT        NOT NULL,

    code_hash    TEXT        NOT NULL,   -- HMAC-SHA256, hex. Never the code.
    expires_at   TIMESTAMPTZ NOT NULL,

    -- Counted so a six-digit code cannot be walked through. The row is burnt
    -- at the limit rather than left for the next guess.
    attempts     INT         NOT NULL DEFAULT 0,
    used_at      TIMESTAMPTZ,

    ip           TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE gateway.admin_otp IS
  'Second-factor challenges for admin console sign-in. Holds an HMAC of the '
  'code, never the code. Rows are short-lived and purged after use.';

-- The verify path looks up the newest live challenge for one user.
CREATE INDEX IF NOT EXISTS admin_otp_live_idx
  ON gateway.admin_otp (user_id, created_at DESC)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS admin_otp_expiry_idx ON gateway.admin_otp (expires_at);

-- Housekeeping. Called by the application after each issue, so the table stays
-- small without a scheduled job: an unattended gateway with nobody signing in
-- is also one with nothing to clean up.
CREATE OR REPLACE FUNCTION gateway.purge_admin_otp(older_than INTERVAL DEFAULT INTERVAL '1 day')
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  DELETE FROM gateway.admin_otp
   WHERE created_at < now() - older_than
      OR (used_at IS NOT NULL AND used_at < now() - INTERVAL '1 hour');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

COMMENT ON FUNCTION gateway.purge_admin_otp(INTERVAL) IS
  'Delete spent and stale sign-in challenges. Safe to run at any time.';
