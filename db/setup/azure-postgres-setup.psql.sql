-- ===========================================================================
-- One-time database setup for the vendor API wrapper
-- Azure Database for PostgreSQL — Flexible Server
--
-- This is the psql ONE-SHOT version: it does everything in a single run and
-- needs no editing, because the passwords come in as -v variables.
--
-- ⚠ It uses psql meta-commands (\set, \gexec, \connect) which pgAdmin's Query
--   Tool does NOT support. If you are working in pgAdmin, use the numbered
--   scripts in this folder instead:
--       01_roles_and_database.sql   (run against "postgres")
--       02_schema_and_grants.sql    (run against "gateway")
--       03_verify.sql               (run after migrations)
--
-- Run this ONCE, connected as the server admin, against the `postgres`
-- database:
--
--   psql "host=YOURSERVER.postgres.database.azure.com port=5432 \
--         dbname=postgres user=pgadmin sslmode=require" \
--        -v gw_owner_pw="'STRONG-PASSWORD-1'" \
--        -v gw_app_pw="'STRONG-PASSWORD-2'" \
--        -f db/setup/azure-postgres-setup.psql.sql
--
-- Generate the two passwords with something like:
--   openssl rand -base64 30
--
-- For UAT later, re-run with different names by editing the three identifiers
-- (gateway → gateway_uat, gw_owner → gw_owner_uat, gw_app → gw_app_uat), or use
-- the numbered scripts which take an env suffix.
--
-- ---------------------------------------------------------------------------
-- WHY TWO ROLES
--
-- The gateway is the one process on your network that an outside party can
-- talk to. If it is ever compromised, the blast radius is whatever its
-- database credential can do. Running it as the server admin — or as the
-- owner of its own tables — means an attacker can DROP the audit log, which
-- is precisely the evidence you would need afterwards.
--
--   gw_owner   owns the schema and every object in it. Holds DDL. Used ONLY
--              by `npm run migrate` (MIGRATION_DATABASE_URL), from your deploy
--              pipeline or by hand.
--              Its password does not belong on the gateway VM at all.
--
--   gw_app     what the running gateway connects as. SELECT/INSERT/UPDATE/
--              DELETE on the tables, and nothing else. Cannot CREATE, cannot
--              ALTER, cannot DROP, cannot TRUNCATE. Cannot read other
--              databases on the server.
--
-- The cost of this is one extra password and remembering which URL runs
-- migrations. The gateway supports that directly via MIGRATION_DATABASE_URL.
-- ===========================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------------

-- Azure's admin is not a true superuser, so it cannot use CREATE ROLE IF NOT
-- EXISTS semantics in older versions; do it defensively.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gw_owner') THEN
    EXECUTE format('CREATE ROLE gw_owner LOGIN PASSWORD %L', :'gw_owner_pw');
  ELSE
    EXECUTE format('ALTER ROLE gw_owner PASSWORD %L', :'gw_owner_pw');
    RAISE NOTICE 'gw_owner already existed — password reset';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gw_app') THEN
    EXECUTE format('CREATE ROLE gw_app LOGIN PASSWORD %L', :'gw_app_pw');
  ELSE
    EXECUTE format('ALTER ROLE gw_app PASSWORD %L', :'gw_app_pw');
    RAISE NOTICE 'gw_app already existed — password reset';
  END IF;
END
$$;

-- Neither role may create databases or roles.
ALTER ROLE gw_owner NOCREATEDB NOCREATEROLE NOSUPERUSER;
ALTER ROLE gw_app   NOCREATEDB NOCREATEROLE NOSUPERUSER;

-- The gateway opens at most DB_POOL_MAX connections plus a little headroom.
-- A cap means a connection leak in the gateway cannot exhaust the server and
-- take down anything else sharing it.
ALTER ROLE gw_app   CONNECTION LIMIT 25;
ALTER ROLE gw_owner CONNECTION LIMIT 5;

-- Statement timeouts at the role level, so they apply even to a psql session
-- somebody opens by hand.
ALTER ROLE gw_app   SET statement_timeout = '5s';
ALTER ROLE gw_app   SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE gw_owner SET statement_timeout = '300s';   -- migrations may be slow

-- ---------------------------------------------------------------------------
-- 2. Database
-- ---------------------------------------------------------------------------
-- Owned by gw_owner, so migrations do not need the server admin.
-- UTF8 and a deterministic collation; the gateway stores only ASCII
-- identifiers but vendor-facing names can be anything.

SELECT 'CREATE DATABASE gateway OWNER gw_owner ENCODING ''UTF8'''
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'gateway')
\gexec

-- Nobody but our two roles gets in. PUBLIC has CONNECT on new databases by
-- default, which means every role on the server could connect to this one.
REVOKE ALL ON DATABASE gateway FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE gateway TO gw_owner;
GRANT CONNECT ON DATABASE gateway TO gw_app;

-- ===========================================================================
-- Everything below runs inside the new database.
-- ===========================================================================
\connect gateway

-- The `public` schema is a historical foot-gun: pre-PG15 every role can create
-- objects in it. We do not use it at all.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 3. Schema
-- ---------------------------------------------------------------------------
-- Created here so gw_owner owns it from the start. The migration runner also
-- does CREATE SCHEMA IF NOT EXISTS, which then becomes a no-op.

CREATE SCHEMA IF NOT EXISTS gateway AUTHORIZATION gw_owner;

-- gw_app may look inside the schema but not add to it.
GRANT USAGE ON SCHEMA gateway TO gw_app;
REVOKE CREATE ON SCHEMA gateway FROM gw_app;

-- ---------------------------------------------------------------------------
-- 4. Privileges on objects that do not exist yet
--
-- This is the part people forget. Grants apply only to tables that exist at
-- the time you run them, so without DEFAULT PRIVILEGES the next migration
-- creates a table gw_app cannot read, and the gateway breaks after a deploy
-- that looked fine.
-- ---------------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES FOR ROLE gw_owner IN SCHEMA gateway
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gw_app;

ALTER DEFAULT PRIVILEGES FOR ROLE gw_owner IN SCHEMA gateway
  GRANT USAGE, SELECT ON SEQUENCES TO gw_app;

-- Deliberately NOT granted to gw_app: TRUNCATE (bulk-wipes the audit log),
-- REFERENCES, TRIGGER, and anything on FUNCTIONS.

-- Cover anything that already exists, for a re-run after migrations.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gateway TO gw_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway TO gw_app;

-- ---------------------------------------------------------------------------
-- 5. search_path
-- ---------------------------------------------------------------------------
-- The application always qualifies its tables as gateway.x, so this is belt
-- and braces — but it also means a psql session lands somewhere sensible, and
-- it stops an unqualified reference silently resolving into public.

ALTER ROLE gw_app   IN DATABASE gateway SET search_path = gateway;
ALTER ROLE gw_owner IN DATABASE gateway SET search_path = gateway;

-- ---------------------------------------------------------------------------
-- 6. Report
-- ---------------------------------------------------------------------------

\echo ''
\echo '  Database and roles created.'
\echo ''
\echo '  Migrations (deploy pipeline / by hand — NOT stored on the VM):'
\echo '    MIGRATION_DATABASE_URL=postgresql://gw_owner:PW1@SERVER.postgres.database.azure.com:5432/gateway?sslmode=require'
\echo ''
\echo '  The running gateway (this is what goes in /etc/vendor-api-wrapper/env):'
\echo '    DATABASE_URL=postgresql://gw_app:PW2@SERVER.postgres.database.azure.com:5432/gateway?sslmode=require'
\echo ''
\echo '  Next:  npm run migrate     (uses MIGRATION_DATABASE_URL if set)'
\echo '         node scripts/gw.js db:check   (confirms least privilege holds)'
\echo ''

SELECT r.rolname,
       r.rolcanlogin  AS can_login,
       r.rolcreatedb  AS can_create_db,
       r.rolcreaterole AS can_create_role,
       r.rolsuper     AS is_superuser,
       r.rolconnlimit AS conn_limit
  FROM pg_roles r
 WHERE r.rolname IN ('gw_owner', 'gw_app')
 ORDER BY r.rolname;
