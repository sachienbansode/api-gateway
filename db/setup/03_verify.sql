-- ===========================================================================
-- STEP 3 of 3 — Verify
--
-- Run this AFTER the migrations have been applied (npm run migrate).
--
-- HOW TO RUN THIS IN pgAdmin
--   Connect to the "gateway" database as the SERVER ADMIN (or gw_owner) and
--   run the whole file. Each section returns a result grid; pgAdmin shows the
--   LAST one by default, so use the "Query History" pane or run each section
--   separately (select the text and press F5) to see them all.
--
-- The CLI equivalent, which checks more and is easier to read, is:
--     node scripts/gw.js db:check
-- That one connects AS gw_app and actually attempts the forbidden operations.
-- This file is the pgAdmin-friendly version for when you want to eyeball the
-- state directly.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Roles: neither should be a superuser or able to create databases/roles.
-- ---------------------------------------------------------------------------
SELECT '1. roles'    AS check,
       rolname       AS role,
       rolcanlogin   AS can_login,
       rolsuper      AS is_superuser,     -- expect false for both
       rolcreatedb   AS can_create_db,    -- expect false
       rolcreaterole AS can_create_role,  -- expect false
       rolconnlimit  AS conn_limit        -- expect 25 (app) and 5 (owner)
  FROM pg_roles
 WHERE rolname LIKE 'gw\_%'
 ORDER BY rolname;


-- ---------------------------------------------------------------------------
-- 2. Tables: all 8 should be present and owned by the owner role.
-- ---------------------------------------------------------------------------
SELECT '2. tables'  AS check,
       tablename    AS table,
       tableowner   AS owner          -- expect gw_owner, NOT gw_app
  FROM pg_tables
 WHERE schemaname = 'gateway'
 ORDER BY tablename;


-- ---------------------------------------------------------------------------
-- 3. The privileges the gateway NEEDS. Every row should say true.
-- ---------------------------------------------------------------------------
SELECT '3. required grants' AS check,
       t.tablename          AS table,
       has_table_privilege('gw_app', 'gateway.' || t.tablename, 'SELECT') AS can_select,
       has_table_privilege('gw_app', 'gateway.' || t.tablename, 'INSERT') AS can_insert,
       has_table_privilege('gw_app', 'gateway.' || t.tablename, 'UPDATE') AS can_update,
       has_table_privilege('gw_app', 'gateway.' || t.tablename, 'DELETE') AS can_delete
  FROM pg_tables t
 WHERE t.schemaname = 'gateway'
 ORDER BY t.tablename;


-- ---------------------------------------------------------------------------
-- 4. The privileges it must NOT have. Every row should say false.
--
-- TRUNCATE is the one that matters: with it, a compromised gateway could wipe
-- the audit log — the record of what it was used to do — in one statement.
-- ---------------------------------------------------------------------------
SELECT '4. forbidden grants' AS check,
       t.tablename           AS table,
       has_table_privilege('gw_app', 'gateway.' || t.tablename, 'TRUNCATE') AS can_truncate,
       has_table_privilege('gw_app', 'gateway.' || t.tablename, 'TRIGGER')  AS can_trigger,
       pg_catalog.pg_get_userbyid(c.relowner) = 'gw_app' AS app_owns_table
  FROM pg_tables t
  JOIN pg_class c ON c.relname = t.tablename
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
 WHERE t.schemaname = 'gateway'
 ORDER BY t.tablename;


-- ---------------------------------------------------------------------------
-- 5. Schema-level: gw_app must have USAGE but NOT CREATE.
-- ---------------------------------------------------------------------------
SELECT '5. schema privileges' AS check,
       has_schema_privilege('gw_app', 'gateway', 'USAGE')  AS usage_expect_true,
       has_schema_privilege('gw_app', 'gateway', 'CREATE') AS create_expect_false,
       has_database_privilege('gw_app', current_database(), 'CONNECT') AS connect_expect_true,
       has_database_privilege('gw_app', current_database(), 'TEMPORARY') AS temp_expect_false;


-- ---------------------------------------------------------------------------
-- 6. DEFAULT PRIVILEGES — the ones that apply to tables a FUTURE migration
--    creates. If this comes back empty, the next migration will create a table
--    the gateway cannot read, and the gateway will break after a deploy that
--    appeared to succeed. Re-run 02_schema_and_grants.sql to fix.
-- ---------------------------------------------------------------------------
SELECT '6. default privileges' AS check,
       n.nspname               AS schema,
       pg_get_userbyid(d.defaclrole) AS granted_by,
       d.defaclobjtype         AS obj_type,   -- 'r' = tables, 'S' = sequences
       d.defaclacl             AS acl         -- must mention gw_app
  FROM pg_default_acl d
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
 WHERE n.nspname = 'gateway';


-- ---------------------------------------------------------------------------
-- 7. Migrations applied.
-- ---------------------------------------------------------------------------
SELECT '7. migrations' AS check,
       file,
       applied_at,
       duration_ms
  FROM gateway.schema_migrations
 ORDER BY file;


-- ---------------------------------------------------------------------------
-- 8. TLS on THIS connection. On Azure this must be true.
--    If it is false you are talking to a local database, not Azure.
-- ---------------------------------------------------------------------------
SELECT '8. tls' AS check,
       s.ssl    AS encrypted,
       s.version AS tls_version,
       current_user AS connected_as,
       current_database() AS database
  FROM pg_stat_ssl s
 WHERE s.pid = pg_backend_pid();


-- ---------------------------------------------------------------------------
-- 9. Single-row summary. This is the one to screenshot.
--    Every column should read OK.
-- ---------------------------------------------------------------------------
SELECT
    CASE WHEN (SELECT count(*) FROM pg_tables WHERE schemaname = 'gateway') = 8
         THEN 'OK (8 tables)' ELSE 'FAIL — run the migrations' END          AS schema_state,
    CASE WHEN has_schema_privilege('gw_app', 'gateway', 'CREATE') = false
         THEN 'OK (cannot create)' ELSE 'FAIL — gw_app can create objects' END AS app_create,
    CASE WHEN (SELECT bool_or(has_table_privilege('gw_app', 'gateway.' || tablename, 'TRUNCATE'))
                 FROM pg_tables WHERE schemaname = 'gateway') = false
         THEN 'OK (cannot truncate)' ELSE 'FAIL — gw_app can TRUNCATE' END  AS app_truncate,
    CASE WHEN (SELECT count(*) FROM pg_default_acl d
                 JOIN pg_namespace n ON n.oid = d.defaclnamespace
                WHERE n.nspname = 'gateway') >= 2
         THEN 'OK' ELSE 'FAIL — re-run 02_schema_and_grants.sql' END        AS future_tables,
    CASE WHEN (SELECT bool_or(rolsuper) FROM pg_roles WHERE rolname LIKE 'gw\_%') = false
         THEN 'OK (no superuser)' ELSE 'FAIL — a gw_ role is superuser' END AS role_powers;
