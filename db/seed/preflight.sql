-- ===========================================================================
-- preflight.sql — is this database ready for the ACL seed?
--
-- WHY THIS EXISTS
--
-- acl_sms.sql runs inside a transaction, so the FIRST failure aborts it and
-- every statement after reports the same thing:
--
--   ERROR: current transaction is aborted, commands ignored until end of
--          transaction block   (SQLSTATE 25P02)
--
-- In pgAdmin that cascade is what fills the Messages pane, and the one error
-- that actually matters has scrolled out of view. This answers the question
-- directly instead: what does this database have, and what is missing.
--
-- WHY IT USES DYNAMIC SQL
--
-- A plain query cannot do this job. PostgreSQL resolves table and column
-- names when it PARSES a statement, not when it runs it — so a query that
-- mentions `endpoint_param_secrets` fails outright on a database that has not
-- had migration 019, which is exactly the database you need to diagnose. The
-- checks below are therefore built as strings and run only when their table
-- is known to exist.
--
-- Read-only. Safe to run anywhere, any number of times.
-- ===========================================================================

DROP TABLE IF EXISTS pg_temp.preflight;
CREATE TEMP TABLE preflight (step TEXT, state TEXT, detail TEXT);

DO $$
DECLARE
  has_col  BOOLEAN;
  has_tbl  BOOLEAN;
  has_row  BOOLEAN;

BEGIN
  -- ---- migration 018 ----------------------------------------------------
  has_col := EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='gateway' AND table_name='endpoints'
                        AND column_name='text_content_type');
  INSERT INTO preflight VALUES ('018  text responses',
    CASE WHEN has_col THEN 'ready' ELSE 'MISSING' END,
    'db/migrations/018_text_responses.sql');

  INSERT INTO preflight
  SELECT '018  response_mode allows "text"',
         CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
                            WHERE conname='endpoints_response_mode_check'
                              -- The QUOTED literal, not the ::text casts that
                              -- appear throughout every such constraint.
                              AND pg_get_constraintdef(oid) LIKE '%''text''%')
              THEN 'ready' ELSE 'MISSING' END,
         'db/migrations/018_text_responses.sql';

  -- ---- migration 019 ----------------------------------------------------
  INSERT INTO preflight
  SELECT '019  source allows "secret"',
         CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
                            WHERE conname='endpoint_params_source_check'
                              AND pg_get_constraintdef(oid) LIKE '%''secret''%')
              THEN 'ready' ELSE 'MISSING' END,
         'db/migrations/019_param_secrets.sql';

  has_tbl := EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_schema='gateway' AND table_name='endpoint_param_secrets');
  INSERT INTO preflight VALUES ('019  sealed parameter store',
    CASE WHEN has_tbl THEN 'ready' ELSE 'MISSING' END,
    'db/migrations/019_param_secrets.sql');

  -- ---- migration 020 ----------------------------------------------------
  INSERT INTO preflight
  SELECT '020  webhooks',
         CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables
                            WHERE table_schema='gateway' AND table_name='webhooks')
              THEN 'ready' ELSE 'MISSING' END,
         'db/migrations/020_webhooks.sql — FlipitMoney only, not needed for ACL';

  -- ---- the seed itself --------------------------------------------------
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM gateway.endpoints WHERE name=''acl_send_sms'')'
    INTO has_row;
  INSERT INTO preflight VALUES ('seed endpoint acl_send_sms',
    CASE WHEN has_row THEN 'ready' ELSE 'not yet' END,
    'created by db/seed/acl_sms.sql');

  -- Only meaningful once 019 exists; referencing it sooner would make this
  -- script fail on precisely the databases it is meant to explain.
  IF has_tbl THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM gateway.endpoint_param_secrets
                             WHERE endpoint=''acl_send_sms'' AND slot=''pass'')'
      INTO has_row;
    INSERT INTO preflight VALUES ('seed ACL password sealed',
      CASE WHEN has_row THEN 'ready' ELSE 'not yet' END,
      'paste it in the Studio — a SQL script cannot seal it');
  END IF;

  IF has_col THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM gateway.endpoints
                             WHERE name=''acl_send_sms'' AND text_failure_match IS NOT NULL)'
      INTO has_row;
    INSERT INTO preflight VALUES ('seed ACL failure match set',
      CASE WHEN has_row THEN 'ready' ELSE 'not yet' END,
      'until set, a send ACL REJECTED is recorded as a success');
  END IF;

  EXECUTE 'SELECT EXISTS (SELECT 1 FROM gateway.endpoints
                           WHERE name=''acl_send_sms'' AND status=''live'')'
    INTO has_row;
  INSERT INTO preflight VALUES ('seed ACL endpoint published',
    CASE WHEN has_row THEN 'ready' ELSE 'not yet' END,
    'a draft is never routed');
END $$;

SELECT step, state, detail FROM preflight ORDER BY step;
