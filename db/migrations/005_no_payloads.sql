-- ===========================================================================
-- 005_no_payloads.sql — the gateway database holds no supplier data
--
-- The data from these APIs lands in the datalake (uat_ananta_staging.cmots),
-- pulled on a schedule. The gateway database holds the CATALOGUE — which
-- endpoints exist, which fields they expose, who may call them — and the
-- record of who called what. It is not a copy of anybody's data, and this
-- migration makes that true rather than merely intended.
--
-- WHERE A PAYLOAD COULD LAND, AND WHAT HAPPENS TO EACH
--
--   audit_log            already clean: status, latency, request id, field
--                        counts. No request body, no response body, no header
--                        values. Unchanged.
--
--   observed_fields      field NAMES only, for schema-drift detection. A path
--                        like "data[].pan_number" is a name, not a value.
--                        Unchanged.
--
--   connection_tests     ⚠ stored the projected body of every step-4 test,
--                        for ever. That is supplier data at rest in the wrong
--                        database. Now OFF by default: the test records the
--                        SHAPE (field paths and types) instead, which is what
--                        anyone reviewing a test actually needs. Existing
--                        samples are dropped by this script.
--
--   idempotency_keys     holds the projected response for a WRITE endpoint so
--                        a retried call replays rather than duplicating. This
--                        one has to keep the body — a replay with no body to
--                        replay is not a replay — but it is short-lived
--                        (IDEMPOTENCY_TTL_HOURS, default 24) and only ever
--                        touches POST/PUT/PATCH endpoints with idempotency
--                        switched on. Every CMOTS endpoint is a GET with
--                        idempotency off, so none of them reach this table.
--                        A retention guard is added below so an unpurged
--                        deployment cannot quietly accumulate.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

-- ---------------------------------------------------------------------------
-- connection_tests: shape, not content.
-- ---------------------------------------------------------------------------

-- The field paths the test saw, and their types. "data[].co_code: number" is
-- a statement about the API; "6" is a statement about Reliance Industries.
ALTER TABLE connection_tests ADD COLUMN IF NOT EXISTS response_shape JSONB;
ALTER TABLE connection_tests ADD COLUMN IF NOT EXISTS withheld_count INTEGER;

COMMENT ON COLUMN connection_tests.response_shape IS
  'Field paths and their types — never values. {"data[].co_code":"number",...}';

-- Drop what the old behaviour already captured. This is deliberate data loss:
-- the rows should not have existed.
UPDATE connection_tests SET response_sample = NULL WHERE response_sample IS NOT NULL;

COMMENT ON COLUMN connection_tests.response_sample IS
  'DEPRECATED and normally NULL. Kept only for a deployment that explicitly '
  'sets STUDIO_KEEP_TEST_SAMPLES=true, which it should not. Supplier data '
  'belongs in the datalake, not here.';

-- A test record is a diagnostic, not an archive. Six months is generous for
-- "did this endpoint work when we published it".
CREATE INDEX IF NOT EXISTS connection_tests_purge_idx ON connection_tests (occurred_at);

-- ---------------------------------------------------------------------------
-- Purge, for both tables.
--
-- A function rather than a note in a runbook: the cron entry calls one thing,
-- and what it deletes is reviewable in the database rather than in a shell
-- script somebody edited last year.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_payloads(
  p_test_days        INTEGER DEFAULT 180,
  p_idempotency_days INTEGER DEFAULT 7
) RETURNS TABLE (what TEXT, removed BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  n BIGINT;
BEGIN
  -- Any sample that slipped through, whatever its age.
  UPDATE gateway.connection_tests SET response_sample = NULL
   WHERE response_sample IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'test samples blanked'; removed := n; RETURN NEXT;

  DELETE FROM gateway.connection_tests
   WHERE occurred_at < now() - make_interval(days => p_test_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'old test records'; removed := n; RETURN NEXT;

  -- Expired idempotency rows are dead weight carrying a payload.
  DELETE FROM gateway.idempotency_keys
   WHERE expires_at < now()
      OR created_at < now() - make_interval(days => p_idempotency_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'expired idempotency rows'; removed := n; RETURN NEXT;
END $$;

COMMENT ON FUNCTION purge_payloads IS
  'Removes everything in this database that could resemble supplier data. '
  'Run nightly. SELECT * FROM gateway.purge_payloads();';

-- ---------------------------------------------------------------------------
-- A standing check, so "we hold no data" is something you can verify rather
-- than something you remember being told.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW payload_check AS
SELECT 'connection_tests.response_sample' AS location,
       count(*) FILTER (WHERE response_sample IS NOT NULL) AS rows_holding_payload,
       'should be 0 — supplier data belongs in the datalake'::text AS expectation
  FROM gateway.connection_tests
UNION ALL
SELECT 'idempotency_keys.response_body',
       count(*) FILTER (WHERE response_body IS NOT NULL),
       'short-lived replay bodies for WRITE endpoints only; purged after expiry'
  FROM gateway.idempotency_keys
UNION ALL
SELECT 'audit_log',
       0,
       'by construction: status, latency and ids only, never bodies'
UNION ALL
SELECT 'observed_fields',
       0,
       'field names only, never values';

COMMENT ON VIEW payload_check IS
  'Is any supplier data sitting in this database? Expect 0 on the first row.';
