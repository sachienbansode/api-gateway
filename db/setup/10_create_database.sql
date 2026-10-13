-- ===========================================================================
-- STEP 1 of 2 — Create the `gateway` database
--
-- WHERE TO RUN
--   Connect to the server that will host it, click the **postgres** database
--   in the pgAdmin browser tree, then Tools -> Query Tool and paste this file.
--
--   ⚠ Not inside `gateway` — it does not exist yet. That is the point.
--   ⚠ Autocommit must stay ON (the pgAdmin default). CREATE DATABASE cannot
--     run inside a transaction block, and pgAdmin will report exactly that
--     if autocommit has been switched off.
--
-- No roles are created or referenced. The database is owned by whoever runs
-- this, and that login already has full access to it.
--
-- Safe to re-run: it reports and does nothing if the database already exists.
-- ===========================================================================

-- Guard: refuse to run from inside the database we are about to create.
DO $guard$
BEGIN
    IF current_database() = 'gateway' THEN
        RAISE EXCEPTION
          'You are already connected to "gateway". Click the `postgres` database '
          'in the pgAdmin tree and open a NEW Query Tool.';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'gateway') THEN
        RAISE NOTICE 'Database "gateway" already exists on this server — nothing to do.';
        RAISE NOTICE 'Go straight to step 2 (11_gateway_objects.sql), run INSIDE gateway.';
    END IF;
END
$guard$;

-- CREATE DATABASE cannot appear inside a DO block, so it is issued plainly.
-- If the database already exists this line errors harmlessly; the NOTICE above
-- has already told you that, and nothing is damaged.
-- Locale is deliberately NOT specified: it inherits the cluster default.
-- Naming one that is not installed on the server fails with
-- "invalid locale name", and the locale has no bearing on anything this
-- schema does.
CREATE DATABASE gateway WITH ENCODING 'UTF8';

COMMENT ON DATABASE gateway IS
    'Pravah API Gateway: vendor keys, quota counters, idempotency keys, audit log.';

-- ---------------------------------------------------------------------------
-- Report: confirm it is there, and on which server.
-- ---------------------------------------------------------------------------
SELECT d.datname                              AS database,
       pg_get_userbyid(d.datdba)              AS owner,
       pg_encoding_to_char(d.encoding)        AS encoding,
       inet_server_addr()                     AS server_ip,
       inet_server_port()                     AS server_port,
       current_user                           AS you_are
  FROM pg_database d
 WHERE d.datname = 'gateway';
