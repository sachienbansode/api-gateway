-- ===========================================================================
-- STEP 2 of 3 — Schema and grants
--
-- HOW TO RUN THIS IN pgAdmin
--   1. Right-click "Databases" in the tree → Refresh, so "gateway" appears.
--   2. ⚠ CLICK THE "gateway" DATABASE. This script must run INSIDE it.
--      Running it against "postgres" is the most common mistake here and
--      creates the schema in the wrong database.
--   3. Tools → Query Tool.
--   4. Paste this whole file and press F5.
--
-- Nothing to edit unless you are setting up UAT — see the note at the bottom.
-- Safe to re-run at any time; re-running is how you repair grants after
-- someone changes them by hand.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Guard: refuse to run in the wrong database.
--
-- Cheap insurance. Without it, a misclick silently creates a gateway schema
-- inside `postgres` and the real database is left without one — which then
-- surfaces much later as a confusing permissions error.
-- ---------------------------------------------------------------------------

DO $guard$
BEGIN
    IF current_database() NOT LIKE 'gateway%' THEN
        RAISE EXCEPTION
          'You are connected to "%" — this script must run inside the gateway '
          'database. In pgAdmin, click the "gateway" database in the tree, then '
          'open a NEW Query Tool.', current_database();
    END IF;
END
$guard$;


-- ---------------------------------------------------------------------------
-- The `public` schema is a historical foot-gun: before PG15, every role can
-- create objects in it. We do not use it at all.
-- ---------------------------------------------------------------------------

REVOKE ALL ON SCHEMA public FROM PUBLIC;


-- ---------------------------------------------------------------------------
-- Our schema, owned by the owner role from the start.
-- The migration runner also does CREATE SCHEMA IF NOT EXISTS, which then
-- becomes a harmless no-op.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS gateway AUTHORIZATION gw_owner;

-- The app role may look inside the schema but not add to it.
GRANT USAGE ON SCHEMA gateway TO gw_app;
REVOKE CREATE ON SCHEMA gateway FROM gw_app;


-- ---------------------------------------------------------------------------
-- Privileges on tables that DO NOT EXIST YET.
--
-- This is the step people miss. A GRANT applies only to tables that exist when
-- you run it. Without DEFAULT PRIVILEGES, the next migration creates a table
-- gw_app cannot read, and the gateway breaks after a deploy that looked
-- completely clean.
-- ---------------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES FOR ROLE gw_owner IN SCHEMA gateway
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gw_app;

ALTER DEFAULT PRIVILEGES FOR ROLE gw_owner IN SCHEMA gateway
    GRANT USAGE, SELECT ON SEQUENCES TO gw_app;

-- Deliberately NOT granted to gw_app:
--   TRUNCATE   — would let a compromised gateway wipe the audit log in one
--                statement. This is the privilege that matters most here.
--   REFERENCES, TRIGGER, and anything on FUNCTIONS — not needed.


-- ---------------------------------------------------------------------------
-- Cover anything that already exists, so this script also repairs grants when
-- re-run after migrations have created tables.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA gateway TO gw_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA gateway TO gw_app;


-- ---------------------------------------------------------------------------
-- search_path.
--
-- The application always fully qualifies its tables as gateway.x, so this is
-- belt and braces. It also means a pgAdmin session lands somewhere sensible,
-- and stops an unqualified table reference silently resolving into public.
-- ---------------------------------------------------------------------------

DO $sp$
DECLARE
    v_db text := current_database();
BEGIN
    EXECUTE format('ALTER ROLE gw_app   IN DATABASE %I SET search_path = gateway', v_db);
    EXECUTE format('ALTER ROLE gw_owner IN DATABASE %I SET search_path = gateway', v_db);
END
$sp$;


-- ---------------------------------------------------------------------------
-- FOR UAT (later): if you ran script 01 with v_env_suffix = '_uat', then
-- before running this file, find-and-replace in this editor:
--     gw_owner  →  gw_owner_uat
--     gw_app    →  gw_app_uat
-- and make sure you are connected to the gateway_uat database. The guard at
-- the top allows any database whose name starts with "gateway".
-- ---------------------------------------------------------------------------


SELECT 'Step 2 complete. Now run the migrations (npm run migrate as gw_owner), '
       'then 03_verify.sql' AS next_step;
