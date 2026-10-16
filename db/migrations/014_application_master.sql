-- ===========================================================================
-- 014_application_master.sql — supplier applications as a managed master
--
-- `gateway.upstreams` already holds the supplier APIs. Until now they could
-- only be created by walking the Studio wizard, which is the right tool for
-- building an endpoint and the wrong one for answering "who owns this, who do
-- we tell when it breaks, and is it still in use". So this adds the columns a
-- master list needs and nothing else — one table, not a second one shadowing
-- it, because two tables describing the same supplier disagree the first time
-- somebody edits the wrong one.
--
-- DELETE IS NOT OFFERED. Not hidden in the UI — not offered.
--
--   An application's name is the foreign key in `endpoints`, the scope string
--   baked into every credential's AAD, and the `upstream` column on every
--   audit row ever written about it. Deleting the row does not delete any of
--   that; it just detaches the meaning from it, and a year of audit rows
--   saying "cmots" with nothing to resolve it against is worse than a row
--   marked inactive. The FK is ON DELETE RESTRICT, which already blocks the
--   case with endpoints attached — this covers the case without, where the
--   delete would have succeeded and quietly thrown away the credential and
--   change history.
--
-- DEACTIVATION IS A PRODUCTION ACTION.
--
--   The config loader already does `if (!u.enabled) continue`, and then drops
--   every endpoint whose upstream is missing from the map. So clearing this
--   flag withdraws every live endpoint under the application at the next
--   reload. That is the intended behaviour and the reason the screen has to
--   say so in words and name the endpoints before it happens.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

-- ---------------------------------------------------------------------------
-- Who this application is, in human terms
-- ---------------------------------------------------------------------------

-- `name` stays the machine key: lowercase, underscored, referenced everywhere.
-- A label is what people actually call it, and the two drift on purpose —
-- renaming "cmots" would break every foreign key and every audit row, while
-- renaming "CMOTS Market Data" costs nothing.
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS owner TEXT;
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS vendor_contact TEXT;

-- The audit trail of the one destructive-ish action that IS allowed.
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS deactivated_by TEXT;
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS deactivated_reason TEXT;

-- ---------------------------------------------------------------------------
-- Where alerts about this application go
--
-- Per application rather than one global list, because the people who care
-- that CMOTS is timing out are not the people who care that some future
-- supplier is. A global list gets muted by everyone on it within a month.
--
-- Infrastructure faults — the gateway's own database, its audit queue — are
-- not any one application's problem, so those fall back to the console-level
-- list in gateway.settings. Both are needed; neither replaces the other.
-- ---------------------------------------------------------------------------
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS alert_emails TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE upstreams ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Validate on the way in. A typo'd address in this column is a silent failure
-- during exactly the incident the alert existed for, so it is refused at write
-- time rather than discovered at send time.
--
-- Via a function because a CHECK cannot contain a subquery, and checking an
-- array element-wise needs one. The function touches no table, which is what
-- makes it legal here and genuinely IMMUTABLE rather than merely declared so.
CREATE OR REPLACE FUNCTION gateway.all_emails_valid(addrs TEXT[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $fn$
  SELECT coalesce(
    bool_and(a ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    true)                        -- an empty list is valid: alerts are optional
    FROM unnest(addrs) AS a
$fn$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upstreams_alert_emails_shape') THEN
    ALTER TABLE upstreams ADD CONSTRAINT upstreams_alert_emails_shape
      CHECK (gateway.all_emails_valid(alert_emails));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The master list, as one row per application with what the screen needs
--
-- A view rather than six queries on the page: the endpoint counts are the
-- whole reason the list is worth reading, and fetching them per row turns a
-- ten-row screen into twenty-one round trips.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW application_master AS
SELECT u.name,
       coalesce(nullif(u.label, ''), u.name)                 AS display_name,
       u.label,
       u.base_url,
       u.timeout_ms,
       u.auth_type,
       u.auth_name,
       u.enabled,
       u.owner,
       u.vendor_contact,
       u.notes,
       u.alert_emails,
       u.alerts_enabled,
       u.deactivated_at,
       u.deactivated_by,
       u.deactivated_reason,
       u.created_at,
       u.updated_at,
       u.updated_by,
       coalesce(e.total, 0)::int  AS endpoints,
       coalesce(e.live, 0)::int   AS live_endpoints,
       coalesce(e.draft, 0)::int  AS draft_endpoints,
       -- Whether a credential exists at all. Never the value, and never the
       -- hint: this view is read by a list screen, and a list screen has no
       -- business holding anything derived from a secret.
       EXISTS (SELECT 1 FROM gateway.upstream_secrets s WHERE s.upstream = u.name)
         AS has_credential
  FROM gateway.upstreams u
  LEFT JOIN (
    SELECT upstream,
           count(*)                                              AS total,
           count(*) FILTER (WHERE status = 'live' AND enabled)    AS live,
           count(*) FILTER (WHERE status = 'draft')               AS draft
      FROM gateway.endpoints GROUP BY upstream
  ) e ON e.upstream = u.name;

COMMENT ON VIEW application_master IS
  'One row per supplier application, with endpoint counts and alert routing. '
  'Deleting an application is not supported — deactivate it instead, which '
  'withdraws every endpoint underneath it at the next config reload.';

-- Seed a readable label for anything already onboarded, so the new screen is
-- not a list of lowercase codes on first open.
UPDATE upstreams SET label = upper(name) WHERE label IS NULL OR label = '';
