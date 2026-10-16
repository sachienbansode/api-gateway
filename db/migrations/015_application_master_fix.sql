-- ===========================================================================
-- 015_application_master_fix.sql — undo two columns 014 should never have added
--
-- 014 added `label` and `vendor_contact` to gateway.upstreams. Both already
-- existed, under the names migration 003 gave them: `display_name` and
-- `vendor_name`. The Studio has been writing to those all along — "CMOTS Stock
-- APIs", supplied by "Capital Market Online" — and I added a second pair
-- beside them without looking.
--
-- Left alone this is worse than clutter. 014's view aliased
-- `coalesce(label, name) AS display_name`, which SHADOWS the real column: the
-- application master screen would have shown "CMOTS", the Studio would have
-- gone on showing "CMOTS Stock APIs", and the two screens would have disagreed
-- about the name of the same thing with no clue as to which was right. 014
-- also seeded `label = upper(name)` for every row, so the shadowed value was
-- guaranteed to be the worse of the two.
--
-- Corrected forward rather than by editing 014, because 014 has already been
-- applied and the runner records a checksum — editing an applied migration
-- makes the next deploy refuse to run at all.
--
-- Nothing here can lose data: `display_name` was never written by 014, and the
-- backfill below only fills it where it is empty.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

-- The view must go first: it depends on the columns being dropped. Dropped
-- rather than replaced because CREATE OR REPLACE VIEW can only append columns,
-- never remove one.
DROP VIEW IF EXISTS gateway.application_master;

-- Carry across anything that only ever landed in `label` — an application
-- created between 014 and 015 on a machine that deployed both. Only where
-- display_name is empty: "CMOTS Stock APIs" must not be overwritten by the
-- "CMOTS" that 014 seeded.
UPDATE upstreams
   SET display_name = label
 WHERE (display_name IS NULL OR display_name = '')
   AND label IS NOT NULL AND label <> '';

UPDATE upstreams
   SET vendor_name = vendor_contact
 WHERE (vendor_name IS NULL OR vendor_name = '')
   AND vendor_contact IS NOT NULL AND vendor_contact <> '';

ALTER TABLE upstreams DROP COLUMN IF EXISTS label;
ALTER TABLE upstreams DROP COLUMN IF EXISTS vendor_contact;

-- Rebuilt on the columns that were there all along.
CREATE VIEW application_master AS
SELECT u.name,
       coalesce(nullif(u.display_name, ''), u.name)          AS display_name,
       u.vendor_name,
       u.base_url,
       u.timeout_ms,
       u.auth_type,
       u.auth_name,
       u.enabled,
       u.owner,
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
       -- hint: this view feeds a list screen, and a list screen has no
       -- business holding anything derived from a secret.
       EXISTS (SELECT 1 FROM gateway.upstream_secrets s WHERE s.upstream = u.name)
         AS has_credential,
       -- Alerts can be configured and still go nowhere. The screen needs to
       -- say so plainly rather than showing a tick beside an empty list.
       (u.alerts_enabled AND cardinality(u.alert_emails) > 0) AS alerts_deliverable
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
  'display_name and vendor_name are the Studio''s own columns from migration '
  '003 — do not add a second pair. Deleting an application is not supported; '
  'deactivate it, which withdraws every endpoint underneath at the next reload.';
