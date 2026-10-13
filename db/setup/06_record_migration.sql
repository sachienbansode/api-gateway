-- ===========================================================================
-- Record migration 001_init.sql in the ledger
--
-- WHAT THIS IS FOR
--   You created the schema by running 04_objects_only.sql in pgAdmin rather
--   than by running `npm run migrate`. The tables exist, but the migration
--   ledger is empty, so the migration runner still believes the database is
--   blank and would lose its place for every future migration.
--
--   This writes the one missing ledger row. It creates no tables and changes
--   no data.
--
-- PREFER `npm run migrate` IF YOU CAN RUN IT. That computes the checksum from
-- your own copy of the file instead of trusting the value pasted below.
-- Use this script only when you have no Node.js on the machine with database
-- access.
--
-- HOW TO RUN IN pgAdmin
--   1. Click the `gateway` database in the browser tree.
--   2. Tools -> Query Tool, paste this whole file, press F5.
--
-- Safe to re-run: it does nothing if the row is already there.
--
-- ⚠ THE CHECKSUM BELOW IS TIED TO ONE EXACT FILE
--   sha256 of db/migrations/001_init.sql, 6890 bytes, LF line endings, no BOM.
--   Verified on 13 Oct 2026 against the copy in your project folder.
--
--   If that file is ever edited, or re-checked-out by git on Windows with CRLF
--   line endings, its checksum changes and the runner will refuse to proceed
--   with a tampering error. Confirm the value first:
--       PowerShell:  Get-FileHash .\db\migrations\001_init.sql -Algorithm SHA256
--       Linux/macOS: sha256sum db/migrations/001_init.sql
--   It must equal the value in v_checksum below, in lower case.
-- ===========================================================================

DO $record$
DECLARE
    v_file     text := '001_init.sql';
    v_checksum text := 'bcef39b9598cc661469cea3960fdecfb40421e69ec15b932acece846c5320835';
    v_expected text[] := ARRAY[
        'vendors', 'vendor_scopes', 'vendor_keys', 'audit_log',
        'quota_usage', 'idempotency_keys', 'observed_fields'
    ];
    v_missing  text[];
    v_prior    text;
BEGIN
    -- Guard 1: right database.
    IF current_database() NOT LIKE 'gateway%' THEN
        RAISE EXCEPTION
          'You are connected to "%" — this script must run inside the gateway '
          'database. Click it in the pgAdmin tree, then open a NEW Query Tool.',
          current_database();
    END IF;

    -- Guard 2: the ledger table itself must exist.
    IF to_regclass('gateway.schema_migrations') IS NULL THEN
        RAISE EXCEPTION
          'gateway.schema_migrations does not exist. Run 04_objects_only.sql first.';
    END IF;

    -- Guard 3: do not claim a migration was applied unless its objects are
    -- actually present. A ledger row is an assertion about reality; recording
    -- one for a schema that was never created is worse than an empty ledger,
    -- because the runner will then skip 001_init.sql forever.
    SELECT array_agg(t)
      INTO v_missing
      FROM unnest(v_expected) AS t
     WHERE to_regclass('gateway.' || quote_ident(t)) IS NULL;

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
          'Refusing to record the migration: these tables are missing: %. '
          'Run 04_objects_only.sql first.', array_to_string(v_missing, ', ');
    END IF;

    -- Already recorded?
    SELECT checksum INTO v_prior
      FROM gateway.schema_migrations
     WHERE file = v_file;

    IF v_prior IS NOT NULL THEN
        IF v_prior = v_checksum THEN
            RAISE NOTICE 'Already recorded with a matching checksum. Nothing to do.';
        ELSE
            RAISE WARNING
              'Already recorded, but with a DIFFERENT checksum (recorded %…, '
              'this script has %…). Someone edited 001_init.sql after it was '
              'applied, or the file has CRLF line endings. Do not overwrite '
              'this row — investigate which copy is correct first.',
              left(v_prior, 12), left(v_checksum, 12);
        END IF;
        RETURN;
    END IF;

    INSERT INTO gateway.schema_migrations (file, checksum, applied_at, duration_ms)
    VALUES (v_file, v_checksum, now(), 0);

    RAISE NOTICE 'Recorded % (checksum %…). The migration runner is now in sync.',
                 v_file, left(v_checksum, 12);
END
$record$;

-- ---------------------------------------------------------------------------
-- Report: what the ledger now holds.
-- duration_ms is 0 because nothing was executed — the objects already existed.
-- ---------------------------------------------------------------------------

SELECT file,
       left(checksum, 16) || '…' AS checksum_prefix,
       applied_at,
       duration_ms
  FROM gateway.schema_migrations
 ORDER BY file;
