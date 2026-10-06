-- ===========================================================================
-- OPTIONAL — only if the gateway connects as a different, restricted role
--
-- Skip this entirely if the gateway will connect as the same user that created
-- the tables. Everything already works in that case.
--
-- Use it when you want the running gateway on a least-privilege login: one that
-- can read and write rows but cannot DROP or TRUNCATE the audit log. That
-- boundary matters because the audit log is the record of what a compromised
-- gateway was used to do.
--
-- HOW TO RUN IN pgAdmin
--   1. Create the login first, e.g.
--        CREATE ROLE my_app_user LOGIN PASSWORD 'a-strong-password';
--   2. Replace the role name on the next line.
--   3. Run this file against the `gateway` database.
-- ===========================================================================

DO $grants$
DECLARE
    -- ↓↓↓ EDIT THIS to your gateway login ↓↓↓
    v_app_role text := 'my_app_user';
    -- ↑↑↑ EDIT THIS ↑↑↑
    v_owner    text := current_user;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_app_role) THEN
        RAISE EXCEPTION 'Role "%" does not exist. Create it first, or edit the name above.', v_app_role;
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA gateway TO %I', v_app_role);
    EXECUTE format('REVOKE CREATE ON SCHEMA gateway FROM %I', v_app_role);

    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gateway TO %I', v_app_role);
    EXECUTE format(
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway TO %I', v_app_role);

    -- The step people miss: a GRANT only covers tables that exist right now.
    -- Without this, the NEXT migration creates a table the gateway cannot read
    -- and it breaks after a deploy that looked completely clean.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA gateway '
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', v_owner, v_app_role);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA gateway '
      'GRANT USAGE, SELECT ON SEQUENCES TO %I', v_owner, v_app_role);

    RAISE NOTICE 'granted read/write on gateway schema to %, without DROP or TRUNCATE', v_app_role;
END
$grants$;

-- TRUNCATE is deliberately never granted.
