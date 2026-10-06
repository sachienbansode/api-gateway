-- ===========================================================================
-- STEP 1 of 3 — Roles and database
--
-- HOW TO RUN THIS IN pgAdmin
--   1. Connect to your Azure server as the SERVER ADMIN.
--   2. In the browser tree, click the "postgres" database (NOT "gateway" —
--      it does not exist yet).
--   3. Tools → Query Tool.
--   4. Paste this whole file.
--   5. ⚠ REPLACE the three placeholders below before running.
--   6. Press F5 (Execute).
--
-- ⚠ pgAdmin note: CREATE DATABASE cannot run inside a transaction block. The
--   Query Tool is in autocommit mode by default, which is what you want. If you
--   have turned autocommit OFF (the ⚡ dropdown in the toolbar), turn it back on
--   or step 2 below fails with:
--     "CREATE DATABASE cannot run inside a transaction block"
--
-- ⚠ This file contains passwords while you are editing it. Do not save it with
--   real values, and do not commit it. Everything here is idempotent — safe to
--   re-run, and re-running resets the two passwords to whatever is in the file.
--
-- psql alternative (if you prefer the command line):
--   there is a single-shot version at db/setup/azure-postgres-setup.psql.sql
--   which takes the passwords as -v variables and needs no editing.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- ⚠ REPLACE THESE THREE VALUES
--
-- Generate each password with:  openssl rand -base64 30
-- (or any password manager — 30+ random characters, no spaces or quotes)
--
--   ENV SUFFIX: leave as '' for production.
--               For UAT later, use '_uat' and re-run all three scripts.
--               That gives you gateway_uat / gw_owner_uat / gw_app_uat with no
--               renaming of anything that already exists.
-- ---------------------------------------------------------------------------

DO $setup$
DECLARE
    -- ↓↓↓ EDIT THESE ↓↓↓
    v_env_suffix  text := '';                      -- '' for prod, '_uat' for UAT
    v_owner_pw    text := 'REPLACE-WITH-PASSWORD-1';
    v_app_pw      text := 'REPLACE-WITH-PASSWORD-2';
    -- ↑↑↑ EDIT THESE ↑↑↑

    v_owner       text := 'gw_owner' || v_env_suffix;
    v_app         text := 'gw_app'   || v_env_suffix;
BEGIN
    IF v_owner_pw LIKE 'REPLACE-WITH%' OR v_app_pw LIKE 'REPLACE-WITH%' THEN
        RAISE EXCEPTION
          'You have not replaced the placeholder passwords at the top of this script.';
    END IF;

    IF length(v_owner_pw) < 16 OR length(v_app_pw) < 16 THEN
        RAISE EXCEPTION
          'Passwords must be at least 16 characters. Use: openssl rand -base64 30';
    END IF;

    IF v_owner_pw = v_app_pw THEN
        RAISE EXCEPTION
          'The two roles must have DIFFERENT passwords — the whole point is that the '
          'gateway credential is less powerful than the migration credential.';
    END IF;

    -- --- owner: holds DDL, owns the schema ---------------------------------
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_owner) THEN
        EXECUTE format('ALTER ROLE %I PASSWORD %L', v_owner, v_owner_pw);
        RAISE NOTICE 'role % already existed — password reset', v_owner;
    ELSE
        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', v_owner, v_owner_pw);
        RAISE NOTICE 'created role %', v_owner;
    END IF;

    -- --- app: what the running gateway connects as -------------------------
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_app) THEN
        EXECUTE format('ALTER ROLE %I PASSWORD %L', v_app, v_app_pw);
        RAISE NOTICE 'role % already existed — password reset', v_app;
    ELSE
        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', v_app, v_app_pw);
        RAISE NOTICE 'created role %', v_app;
    END IF;

    -- Neither role may create databases or other roles.
    EXECUTE format('ALTER ROLE %I NOCREATEDB NOCREATEROLE NOSUPERUSER', v_owner);
    EXECUTE format('ALTER ROLE %I NOCREATEDB NOCREATEROLE NOSUPERUSER', v_app);

    -- Connection caps. A leak in the gateway must not exhaust the server and
    -- take down anything else sharing it.
    EXECUTE format('ALTER ROLE %I CONNECTION LIMIT 25', v_app);
    EXECUTE format('ALTER ROLE %I CONNECTION LIMIT 5',  v_owner);

    -- Role-level timeouts, so they apply even to a session someone opens by
    -- hand in pgAdmin.
    EXECUTE format('ALTER ROLE %I SET statement_timeout = ''5s''', v_app);
    EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = ''30s''', v_app);
    EXECUTE format('ALTER ROLE %I SET statement_timeout = ''300s''', v_owner);

    RAISE NOTICE 'roles ready: % (DDL) and % (gateway runtime)', v_owner, v_app;
END
$setup$;


-- ---------------------------------------------------------------------------
-- The database itself.
--
-- This cannot go inside the DO block above, because CREATE DATABASE is not
-- allowed in a function or a transaction. Run as written.
--
-- ⚠ If you changed v_env_suffix above, change BOTH names here to match
--   (e.g. gateway_uat / gw_owner_uat).
-- ---------------------------------------------------------------------------

CREATE DATABASE gateway OWNER gw_owner ENCODING 'UTF8';


-- ---------------------------------------------------------------------------
-- Lock down who may connect.
--
-- PUBLIC has CONNECT on a new database by default, which means every role on
-- the server can reach it. Revoke that and grant explicitly.
-- ---------------------------------------------------------------------------

REVOKE ALL ON DATABASE gateway FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE gateway TO gw_owner;
GRANT CONNECT ON DATABASE gateway TO gw_app;


-- ---------------------------------------------------------------------------
-- NEXT: refresh the Databases node in the pgAdmin tree (right-click →
-- Refresh), click the new "gateway" database, open a NEW Query Tool against
-- it, and run 02_schema_and_grants.sql.
--
-- The connection matters: script 02 must run INSIDE the gateway database, not
-- in postgres. Running it in the wrong database is the most common mistake
-- here, and it creates a gateway schema in the wrong place.
-- ---------------------------------------------------------------------------

SELECT 'Step 1 complete. Now connect to the "gateway" database and run 02_schema_and_grants.sql'
       AS next_step;
