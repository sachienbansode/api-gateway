-- ===========================================================================
-- 017_application_is_the_supplier.sql — one application per supplier
--
-- Two tables have been describing the same thing, and the console showed both
-- under the same word.
--
--   gateway.applications  "the top of the tree" since 003. Drives the Studio's
--                         Application picker and the Catalogue's Application
--                         filter. Written in exactly one place: the wizard,
--                         as a side effect of onboarding an endpoint.
--
--   gateway.upstreams     the supplier API itself — base URL, timeout, auth,
--                         and the columns 014 added for ownership and alerts.
--
-- 014 built an "Applications" master on `upstreams`, which is why the
-- Catalogue dropdown kept showing "CMOTS Market Data" (an applications row)
-- while the Applications screen showed "CMOTS Stock APIs" (an upstreams row),
-- and why SMS Gateway - ACL appeared on one and not the other. Two screens,
-- the same word, different tables.
--
-- THE RULE, now stated: one application per supplier, internal applications
-- included. So the pair is 1:1 and the console treats it as one thing. The
-- tables stay separate because every endpoint, every FK and the whole audit
-- trail already point at them — merging them would be a rewrite to express a
-- rule a backfill can express.
--
-- WHAT THIS DOES
--   1. Gives every upstream an application, creating the row if missing.
--   2. Gives every endpoint the application of its upstream.
--   3. Rebuilds application_master as the JOIN, so one screen edits one thing
--      and the Catalogue dropdown reflects it immediately.
--
-- No column is dropped and nothing is deleted. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

-- ---------------------------------------------------------------------------
-- 1. Every supplier gets an application row
--
-- `code` matches the upstream's name deliberately. They are one thing now, and
-- a second identifier for it would be a second thing to keep in step.
-- ---------------------------------------------------------------------------
INSERT INTO gateway.applications (code, name, description, owner_email, created_by)
SELECT u.name,
       coalesce(nullif(u.display_name, ''), u.name),
       nullif(u.notes, ''),
       nullif(u.owner, ''),
       'migration 017'
  FROM gateway.upstreams u
 WHERE NOT EXISTS (SELECT 1 FROM gateway.applications a WHERE a.code = u.name)
   AND u.application IS NULL
ON CONFLICT (code) DO NOTHING;

-- Link the ones that were not linked. An upstream already pointing at an
-- application is left exactly as it is — cmots has pointed at its own row
-- since the wizard created it, and that row's name is the one people chose.
UPDATE gateway.upstreams u
   SET application = u.name
 WHERE u.application IS NULL
   AND EXISTS (SELECT 1 FROM gateway.applications a WHERE a.code = u.name);

-- ---------------------------------------------------------------------------
-- 2. Every endpoint inherits its supplier's application
--
-- endpoints.application drives the Catalogue's filter. An endpoint with a null
-- one is invisible to that filter while being perfectly live — which reads as
-- "the filter is broken" rather than "this row was never tagged".
-- ---------------------------------------------------------------------------
UPDATE gateway.endpoints e
   SET application = u.application
  FROM gateway.upstreams u
 WHERE e.upstream = u.name
   AND e.application IS NULL
   AND u.application IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. One row per application, with its supplier alongside
--
-- Dropped and recreated rather than replaced: CREATE OR REPLACE VIEW can only
-- append columns, and this changes what the view IS.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS gateway.application_master;

CREATE VIEW application_master AS
SELECT a.code                                             AS name,
       a.name                                             AS display_name,
       a.description,
       coalesce(nullif(a.owner_email, ''), u.owner)       AS owner,
       a.enabled,
       a.sort_order,
       -- The supplier side. NULL when an application has no upstream yet,
       -- which is a state the screen has to render rather than crash on.
       u.name                                             AS upstream,
       u.base_url,
       u.timeout_ms,
       u.auth_type,
       u.auth_name,
       u.vendor_name,
       u.notes,
       u.alert_emails,
       u.alerts_enabled,
       u.enabled                                          AS upstream_enabled,
       u.deactivated_at,
       u.deactivated_by,
       u.deactivated_reason,
       a.created_at,
       u.updated_at,
       u.updated_by,
       coalesce(e.total, 0)::int                          AS endpoints,
       coalesce(e.live, 0)::int                           AS live_endpoints,
       coalesce(e.draft, 0)::int                          AS draft_endpoints,
       -- Whether a credential exists at all. Never the value, never the hint:
       -- a list screen has no business holding anything derived from a secret.
       EXISTS (SELECT 1 FROM gateway.upstream_secrets s WHERE s.upstream = u.name)
         AS has_credential,
       -- Alerts can be configured and still reach nobody. The screen says so
       -- rather than showing a tick beside an empty list.
       (coalesce(u.alerts_enabled, false)
        AND coalesce(cardinality(u.alert_emails), 0) > 0) AS alerts_deliverable
  FROM gateway.applications a
  LEFT JOIN gateway.upstreams u ON u.application = a.code
  LEFT JOIN (
    SELECT application,
           count(*)                                            AS total,
           count(*) FILTER (WHERE status = 'live' AND enabled)  AS live,
           count(*) FILTER (WHERE status = 'draft')             AS draft
      FROM gateway.endpoints WHERE application IS NOT NULL GROUP BY application
  ) e ON e.application = a.code;

COMMENT ON VIEW application_master IS
  'One row per application, with its supplier API joined on. One application '
  'per supplier — see 017. Deleting is not supported; deactivate, which '
  'withdraws every endpoint underneath at the next config reload.';
