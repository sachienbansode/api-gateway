-- ===========================================================================
-- 011_brand_settings.sql — the product's name, owned by an administrator
--
-- The name on the login screen and in the sidebar came from ADMIN_TITLE or
-- API_TITLE in the env file, which meant renaming the product required SSH
-- access and a restart. That is the wrong permission for a decision that is
-- marketing, not operations — and it is why a box ended up reading
-- "Partner API" months after the product was called something else.
--
-- Two values rather than one, because the header renders them differently:
-- the name is the strong line, the tagline is the small caps under it. One
-- combined string was being split on a regex looking for "API Gateway" at the
-- end, which silently did the wrong thing for any name not ending that way —
-- "Ashika - Pravah" among them.
--
-- The env vars still work as the fallback, so a deployment that has not run
-- this migration, or has deliberately set ADMIN_TITLE, is unchanged.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

INSERT INTO gateway.settings (key, label, help, kind, value, sort_order) VALUES
  ('brand_name',
   'Product name',
   'The name on the sign-in screen, in the sidebar and in every browser tab. '
   'Shown to administrators only — a vendor never sees this console.',
   'text',
   'Ashika - Pravah',
   1),
  ('brand_tagline',
   'Product tagline',
   'The small line under the name, in capitals. Describes what the product is, '
   'rather than naming it again.',
   'text',
   'API Gateway',
   2)
ON CONFLICT (key) DO NOTHING;

-- An installation that already ran 008 and is on the default name gets the new
-- one; anything an administrator has actually typed is left alone. ON CONFLICT
-- DO NOTHING above covers the re-run case and would, on its own, leave an
-- earlier blank row blank — which would render an empty sidebar.
UPDATE gateway.settings
   SET value = 'Ashika - Pravah'
 WHERE key = 'brand_name' AND (value IS NULL OR value = '');

UPDATE gateway.settings
   SET value = 'API Gateway'
 WHERE key = 'brand_tagline' AND (value IS NULL OR value = '');

SELECT key, value, label FROM gateway.settings
 WHERE key IN ('brand_name', 'brand_tagline') ORDER BY sort_order;
