-- ===========================================================================
-- 013_admin_audit.sql — one view over everything an administrator changed
--
-- Three tables already record changes, and that is the right shape for
-- writing: catalog_audit keeps a before/after of an endpoint, secret_audit
-- keeps who read a credential and why, settings_audit keeps old and new
-- values. Each is specific, and none should be merged into a general "events"
-- table that holds a JSON blob and means nothing on its own.
--
-- But nobody asks "what changed in the catalogue" — they ask "what did
-- somebody change on Tuesday", or "what has this person done". Answering that
-- across three tables means three queries and a mental merge, which is exactly
-- the sort of thing people skip when they are busy. So the TABLES stay as they
-- are and this view puts them in one timeline.
--
-- Deliberately a view, not a table. A copy would need writing to from three
-- places and would disagree with its sources the first time one of those
-- writes failed.
--
-- NOT merged in: gateway.audit_log. That is a different question — every call
-- a consumer made, thousands a day, which is traffic rather than change. It
-- has its own screen.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

DROP VIEW IF EXISTS gateway.admin_audit;

CREATE VIEW gateway.admin_audit AS

-- Endpoints and supplier APIs: created, changed, published, withdrawn.
SELECT occurred_at,
       actor,
       'catalogue'::text                       AS area,
       action,
       object_type                             AS object_kind,
       object_id                               AS object,
       -- A whole before/after would be unreadable in a list. The fields that
       -- actually change, and that people search for, are pulled out.
       nullif(concat_ws(' → ',
         nullif(before->>'status', ''), nullif(after->>'status', '')), '') AS detail,
       (before IS NOT NULL OR after IS NOT NULL) AS has_diff,
       id                                      AS source_id,
       'catalog_audit'::text                   AS source
  FROM gateway.catalog_audit

UNION ALL

-- Credentials: set, rotated, cleared — and READ, which is the one that
-- matters most and the one that leaves no other trace.
SELECT occurred_at,
       actor,
       'credential'::text                      AS area,
       action,
       CASE WHEN endpoint IS NOT NULL THEN 'endpoint' ELSE 'supplier' END AS object_kind,
       coalesce(endpoint, upstream)            AS object,
       nullif(concat_ws(' · ',
         nullif(slot, 'value'),
         CASE WHEN hint IS NOT NULL AND hint <> '' THEN '****' || hint END,
         reason, note), '')                    AS detail,
       false                                   AS has_diff,
       id                                      AS source_id,
       'secret_audit'::text                    AS source
  FROM gateway.secret_audit

UNION ALL

-- Console settings, including the product name and the public base URL.
SELECT occurred_at,
       actor,
       'settings'::text                        AS area,
       'change'::text                          AS action,
       'setting'::text                         AS object_kind,
       key                                     AS object,
       concat_ws(' → ', coalesce(nullif(old_value, ''), '(unset)'),
                        coalesce(nullif(new_value, ''), '(unset)')) AS detail,
       false                                   AS has_diff,
       id                                      AS source_id,
       'settings_audit'::text                  AS source
  FROM gateway.settings_audit;

COMMENT ON VIEW gateway.admin_audit IS
  'Every change an administrator made, across the catalogue, credentials and '
  'settings, in one timeline. Consumer TRAFFIC is gateway.audit_log, not this.';

-- The three source tables are each indexed on occurred_at already, which is
-- what this view sorts and filters by.
SELECT area, count(*) AS entries FROM gateway.admin_audit GROUP BY area ORDER BY area;
