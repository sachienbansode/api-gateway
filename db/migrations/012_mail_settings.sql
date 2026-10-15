-- ===========================================================================
-- 012_mail_settings.sql — mail configured from the console, not the env file
--
-- The sign-in code needs an SMTP server. Three places it could come from, and
-- this migration makes the first one possible:
--
--   1. this table, set on the Admin config screen        ← added here
--   2. SMTP_* in /etc/api-gateway/env                    (unchanged)
--   3. the platform's own smtp_settings row              (opt-in, unchanged)
--
-- Why a table rather than leaving it in the env file. Changing the mail server
-- is not a deployment act — it is the kind of thing that happens when a
-- mailbox password is rotated or a relay is replaced, by whoever owns mail,
-- and it should not need SSH, a text editor and a process restart. The
-- platform has had exactly this screen for a while and it is the right shape;
-- this is the same idea in this product's own database.
--
-- THE PASSWORD
--
-- Sealed with AES-256-GCM under GW_SECRET_KEY, the same mechanism and the same
-- key as the supplier credentials in 004 — so a dump, a replica or a stolen
-- disk decrypts to nothing without the env file, and the console can still
-- show whether a password is set without being able to put it on a screen.
--
-- Deliberately NOT the platform's API_KEY_SECRET: that secret also unlocks the
-- platform's saved ETL database passwords and partner API keys, and this
-- gateway has no business holding it.
--
-- Single row, id = 1, enforced by a check constraint. One mail configuration
-- per gateway; a second row would be two answers to one question.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

CREATE TABLE IF NOT EXISTS gateway.mail_settings (
    id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    host            TEXT,
    port            INTEGER NOT NULL DEFAULT 587 CHECK (port > 0 AND port < 65536),

    -- 465 is implicit TLS; 587 is STARTTLS, which nodemailer does with
    -- secure = false. The application defaults this from the port when it is
    -- NULL, because setting 465 and leaving secure off is the mistake that
    -- hangs until the timeout instead of failing with something readable.
    secure          BOOLEAN,

    -- Off means "accept any certificate the mail server presents", which
    -- defeats TLS against anyone who can get in the middle. Default TRUE, and
    -- the console says what unticking it costs.
    reject_unauthorized BOOLEAN NOT NULL DEFAULT true,

    username        TEXT,

    -- The password, sealed. Same shape as gateway.upstream_secrets: BYTEA, not
    -- base64 in a text column that invites someone to "just look at it".
    pass_ciphertext BYTEA,
    pass_iv         BYTEA CHECK (pass_iv IS NULL OR length(pass_iv) = 12),
    pass_tag        BYTEA CHECK (pass_tag IS NULL OR length(pass_tag) = 16),
    pass_key_id     TEXT  CHECK (pass_key_id IS NULL OR pass_key_id ~ '^[A-Za-z0-9_]+$'),
    pass_hint       TEXT  CHECK (pass_hint IS NULL OR length(pass_hint) <= 4),

    from_email      TEXT,
    from_name       TEXT DEFAULT 'Ashika - Pravah',

    -- What the last Test Connection did. Kept so the screen can show a state
    -- rather than making someone press the button to find out.
    test_status     TEXT CHECK (test_status IS NULL OR test_status IN ('ok','failed')),
    test_error      TEXT,
    last_tested_at  TIMESTAMPTZ,

    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,

    -- A password that is half-written is worse than one that is absent: it
    -- fails at the moment somebody is trying to sign in. All four parts or none.
    CONSTRAINT mail_pass_complete CHECK (
      (pass_ciphertext IS NULL AND pass_iv IS NULL AND pass_tag IS NULL AND pass_key_id IS NULL)
      OR
      (pass_ciphertext IS NOT NULL AND pass_iv IS NOT NULL AND pass_tag IS NOT NULL
       AND pass_key_id IS NOT NULL)
    )
);

COMMENT ON TABLE gateway.mail_settings IS
  'SMTP configuration for admin sign-in codes. The password is AES-256-GCM '
  'sealed under GW_SECRET_KEY, which lives in the env file and NEVER here.';

INSERT INTO gateway.mail_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Safe to SELECT * from in a screen-share: status, never the password.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW gateway.mail_config AS
SELECT id, host, port,
       COALESCE(secure, port = 465)            AS secure,
       reject_unauthorized,
       username,
       (pass_ciphertext IS NOT NULL)           AS password_stored,
       CASE WHEN pass_hint IS NOT NULL AND pass_hint <> ''
            THEN '****' || pass_hint END       AS password_hint,
       pass_key_id                             AS key_id,
       from_email, from_name,
       test_status, test_error, last_tested_at,
       updated_at, updated_by
  FROM gateway.mail_settings;

COMMENT ON VIEW gateway.mail_config IS
  'Mail STATUS, never the password. Safe to read, export and screen-share.';

SELECT host, port, username, from_email, password_stored, test_status
  FROM gateway.mail_config;
