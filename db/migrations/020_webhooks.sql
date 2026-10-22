-- ===========================================================================
-- 020_webhooks.sql — APIs that call US
--
-- Everything in Pravah so far points one way: a consumer calls us, we call a
-- supplier, we shape what comes back. A webhook is the opposite. FlipitMoney
-- calls us, unprompted, whenever a news item is published, updated or deleted.
--
-- That inverts every assumption the gateway is built on:
--
--   there is no consumer         nobody asked for this; it just arrives
--   there is no API key          the caller is a supplier, not a vendor
--   the path must be PUBLIC      their server has to reach it
--   we cannot retry              THEY retry, and only 3 times over ~60s
--
-- SO WHY DOES IT TOUCH THE DATABASE AT ALL
--
-- Because of that last line. FlipitMoney retry three times with a 20 second
-- backoff and then give up, and the news item is gone — there is no endpoint
-- to go and fetch it from afterwards. A relay that forwards straight through
-- turns any internal restart longer than about a minute into permanently lost
-- news.
--
-- So a verified item is written down, answered 200 immediately, and forwarded
-- afterwards on our own schedule, with our own retries. Once the internal
-- application has accepted it the row is DELETED. The gateway is not becoming
-- a store of supplier data: `webhook_deliveries` is a queue that is empty when
-- everything is working, not a cache that fills up.
--
-- What outlives delivery is `webhook_seen`, which holds an identifier and a
-- timestamp and no payload — just enough to recognise the same event arriving
-- twice.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

-- ---------------------------------------------------------------------------
-- 1. The webhooks we expose
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway.webhooks (
    name            TEXT PRIMARY KEY
                    CHECK (name ~ '^[a-z0-9][a-z0-9_]*$'),
    application     TEXT REFERENCES gateway.applications(code),
    display_name    TEXT,
    description     TEXT,

    -- The public path their server posts to, under /hooks.
    path            TEXT NOT NULL UNIQUE
                    CHECK (path ~ '^/[A-Za-z0-9._~/-]*$'),

    -- How the caller proves it is them.
    --   hmac_sha256_hex     base16 HMAC, as FlipitMoney use
    --   hmac_sha256_base64  the same thing, differently encoded
    --   none                nothing but the IP allowlist stands between the
    --                       internet and this endpoint — allowed, because
    --                       some suppliers genuinely offer nothing, but it
    --                       has to be chosen deliberately
    signature_scheme TEXT NOT NULL DEFAULT 'hmac_sha256_hex'
                     CHECK (signature_scheme IN
                            ('hmac_sha256_hex', 'hmac_sha256_base64', 'none')),

    -- Which header carries it. FlipitMoney use X-Flipit-Checksum.
    signature_header TEXT,

    -- WHAT IS SIGNED, as a template over the body: '{slug}{updated_at}'
    -- reproduces FlipitMoney's "message = slug + updated_at". Empty means the
    -- raw request body, which is what a supplier who signs properly does.
    --
    -- This is stored per webhook rather than assumed, because every supplier
    -- picks something different and getting it wrong means either rejecting
    -- every real call or accepting every forged one.
    signature_message TEXT,

    -- Where a verified payload is delivered. The internal application.
    forward_url      TEXT
                     CHECK (forward_url IS NULL OR forward_url ~ '^https?://'),
    forward_timeout_ms INTEGER NOT NULL DEFAULT 8000
                     CHECK (forward_timeout_ms BETWEEN 1000 AND 60000),
    forward_max_attempts INTEGER NOT NULL DEFAULT 8
                     CHECK (forward_max_attempts BETWEEN 1 AND 50),

    -- Optional, and empty by default. The supplier sends from a static address
    -- and recommends allowlisting it, but a webhook that cannot be tested
    -- until someone emails you an IP is a webhook nobody finishes setting up.
    -- Empty means any source; the signature is what actually guards it.
    ip_allowlist     TEXT[] NOT NULL DEFAULT '{}',

    -- Which field identifies the event, for recognising a repeat.
    -- FlipitMoney re-push the same `slug` on update and on delete.
    event_key_field   TEXT NOT NULL DEFAULT 'slug',
    event_version_field TEXT DEFAULT 'updated_at',

    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'live', 'retired')),
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT
);

-- A signed scheme without a header to read is not configured, it is broken,
-- and it would reject every call at runtime with a puzzling message.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_signed_needs_header') THEN
    ALTER TABLE gateway.webhooks ADD CONSTRAINT webhook_signed_needs_header
      CHECK (signature_scheme = 'none' OR signature_header IS NOT NULL);
  END IF;
END $$;

-- Going live without somewhere to deliver to means accepting news and
-- dropping it, which looks exactly like working.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_live_needs_target') THEN
    ALTER TABLE gateway.webhooks ADD CONSTRAINT webhook_live_needs_target
      CHECK (status <> 'live' OR forward_url IS NOT NULL);
  END IF;
END $$;

COMMENT ON COLUMN gateway.webhooks.signature_message IS
  'Template over the body for what the supplier signed, e.g. "{slug}{updated_at}". '
  'Empty means the raw request body.';

-- ---------------------------------------------------------------------------
-- 2. The shared secret, sealed
--
-- Same shape as upstream_secrets and endpoint_param_secrets, so
-- db/repos/secrets.js serves this scope with the implementation it already
-- has. `slot` is 'value' for the single signing key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway.webhook_secrets (
    webhook     TEXT NOT NULL REFERENCES gateway.webhooks(name) ON DELETE CASCADE,
    slot        TEXT NOT NULL DEFAULT 'value' CHECK (slot IN ('value')),

    ciphertext  BYTEA NOT NULL CHECK (length(ciphertext) > 0),
    iv          BYTEA NOT NULL CHECK (length(iv) = 12),
    tag         BYTEA NOT NULL CHECK (length(tag) = 16),
    key_id      TEXT  NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_]+$'),
    hint        TEXT  CHECK (hint IS NULL OR length(hint) <= 4),

    set_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    set_by      TEXT NOT NULL,
    rotated_at  TIMESTAMPTZ,

    PRIMARY KEY (webhook, slot)
);

COMMENT ON TABLE gateway.webhook_secrets IS
  'AES-256-GCM sealed webhook signing keys. The key is GW_SECRET_KEY in the '
  'env file and is NEVER stored here. Do not add a column for it.';

CREATE INDEX IF NOT EXISTS webhook_secrets_key_idx ON gateway.webhook_secrets (key_id);

-- The audit table records every credential write. It had a column per subject
-- kind and a CHECK requiring one of them; a webhook secret needs its own or
-- every write to it would fail.
ALTER TABLE gateway.secret_audit ADD COLUMN IF NOT EXISTS webhook TEXT;
ALTER TABLE gateway.secret_audit DROP CONSTRAINT IF EXISTS secret_audit_scope_chk;
ALTER TABLE gateway.secret_audit ADD CONSTRAINT secret_audit_scope_chk
  CHECK (upstream IS NOT NULL OR endpoint IS NOT NULL OR webhook IS NOT NULL);

CREATE OR REPLACE VIEW gateway.webhook_credentials AS
SELECT w.name                                   AS webhook,
       w.display_name,
       w.signature_scheme,
       (s.webhook IS NOT NULL)                  AS is_set,
       CASE WHEN s.hint IS NULL THEN NULL
            ELSE '••••' || s.hint END            AS masked,
       s.key_id, s.set_at, s.set_by, s.rotated_at
  FROM gateway.webhooks w
  LEFT JOIN gateway.webhook_secrets s ON s.webhook = w.name AND s.slot = 'value';

COMMENT ON VIEW gateway.webhook_credentials IS
  'Which webhook signing keys are set, by whom and when. No ciphertext and no '
  'plaintext — safe to read in front of other people.';

-- ---------------------------------------------------------------------------
-- 3. The queue
--
-- A row exists between "we said 200" and "the internal application accepted
-- it", and is deleted after. When everything is working this table is empty.
-- A row that is still here an hour later is the alert worth having.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway.webhook_deliveries (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    webhook       TEXT NOT NULL REFERENCES gateway.webhooks(name) ON DELETE CASCADE,

    event_key     TEXT,
    event_version TEXT,

    payload       JSONB NOT NULL,
    headers       JSONB NOT NULL DEFAULT '{}'::jsonb,

    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts      INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error    TEXT,

    -- 'pending' is in flight. 'failed' has run out of attempts and is kept,
    -- deliberately, because the alternative is losing it silently; it is the
    -- one state a person has to look at.
    state         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'failed'))
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON gateway.webhook_deliveries (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_hook_idx
  ON gateway.webhook_deliveries (webhook, received_at DESC);

COMMENT ON TABLE gateway.webhook_deliveries IS
  'A queue, not a cache. A row lives between accepting a payload and the '
  'internal application taking it, and is deleted on success. Rows in state '
  'failed are kept for a person to look at.';

-- ---------------------------------------------------------------------------
-- 4. What we have already seen
--
-- No payload. An identifier, a version and a time — enough to recognise the
-- same event twice and answer 200 without delivering it again.
--
-- FlipitMoney retry on any non-2xx, and re-push the same slug when a story is
-- updated or deleted. A retry of something we already took must not become a
-- second copy downstream; a genuine update, which carries a new updated_at,
-- must.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway.webhook_seen (
    webhook       TEXT NOT NULL REFERENCES gateway.webhooks(name) ON DELETE CASCADE,
    event_key     TEXT NOT NULL,
    event_version TEXT NOT NULL DEFAULT '',
    seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (webhook, event_key, event_version)
);

CREATE INDEX IF NOT EXISTS webhook_seen_age_idx ON gateway.webhook_seen (seen_at);

COMMENT ON TABLE gateway.webhook_seen IS
  'Identifiers of events already accepted, with no payload. Used to recognise '
  'a supplier retry. Pruned on a retention window.';

-- ---------------------------------------------------------------------------
-- 5. What arrived, whether or not it was accepted
--
-- A rejected call leaves no delivery row and no seen row, so without this a
-- supplier signing with the wrong key would be invisible: they would see
-- failures, we would see nothing at all, and the conversation would start
-- with "your webhook is broken" and no way to check.
--
-- No payload here either. Enough to answer "did they call, and what did we
-- say" without the table becoming a copy of their content.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway.webhook_log (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    webhook       TEXT,
    path          TEXT NOT NULL,
    source_ip     TEXT,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    status        INTEGER NOT NULL,
    outcome       TEXT NOT NULL
                  CHECK (outcome IN ('accepted', 'duplicate', 'bad_signature',
                                     'ip_blocked', 'unknown_hook', 'disabled',
                                     'malformed', 'error')),
    event_key     TEXT,
    bytes         INTEGER,
    detail        TEXT
);

CREATE INDEX IF NOT EXISTS webhook_log_time_idx ON gateway.webhook_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS webhook_log_hook_idx ON gateway.webhook_log (webhook, occurred_at DESC);
