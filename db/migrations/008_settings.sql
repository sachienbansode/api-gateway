-- ===========================================================================
-- 008_settings.sql — console-managed configuration
--
-- Some values belong to the PRODUCT, not to the deployment. The public base
-- URL is the clearest case: it is what vendors are told to call, it appears in
-- documentation and Postman collections, and changing it is an ordinary
-- administrative act — not a reason to SSH into a VM, edit an env file and
-- restart.
--
-- What does NOT belong here, and must stay in /etc/api-gateway/env:
--
--   GW_SECRET_KEY        the key that decrypts everything else
--   *_DATABASE_URL       how to reach this table in the first place
--   JWT_SECRET           what proves an admin is an admin
--
-- The rule: anything needed to READ this table, or to protect what is in it,
-- cannot live in it. Everything else is fair game.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

CREATE TABLE IF NOT EXISTS gateway.settings (
    key         TEXT PRIMARY KEY CHECK (key ~ '^[a-z0-9_]+$'),
    value       TEXT,
    label       TEXT NOT NULL,
    help        TEXT,
    kind        TEXT NOT NULL DEFAULT 'text'
                CHECK (kind IN ('text','url','number','bool')),
    sort_order  INTEGER NOT NULL DEFAULT 100,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  TEXT
);

-- Who changed a setting, from what, to what. Short of this, "who pointed the
-- documentation at the wrong host?" has no answer.
CREATE TABLE IF NOT EXISTS gateway.settings_audit (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    key         TEXT NOT NULL,
    old_value   TEXT,
    new_value   TEXT,
    actor       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS settings_audit_time_idx ON gateway.settings_audit (occurred_at DESC);

INSERT INTO gateway.settings (key, label, help, kind, sort_order) VALUES
  ('public_base_url',
   'Public base URL',
   'What vendors call. Every endpoint path is appended to this, and it is what '
   'appears in the Postman collections and the OpenAPI document. No trailing slash.',
   'url', 10),
  ('docs_contact',
   'Support contact',
   'Shown to vendors in generated documentation — an address a partner can write to '
   'when an endpoint misbehaves.',
   'text', 20),
  ('vendor_key_header',
   'API key header',
   'The header vendors send their key in. Changing it breaks every live integration, '
   'so it is here to be READ more than written.',
   'text', 30)
ON CONFLICT (key) DO NOTHING;
