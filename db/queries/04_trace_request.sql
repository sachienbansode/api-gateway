-- Everything recorded about ONE request.
--
-- Use this when a vendor says "call abc-123 failed" — the requestId in the
-- error body they received is this row's request_id.
--
-- ⚠ REPLACE the UUID below.
-- CLI equivalent: node scripts/gw.js audit:trace <requestId>

SELECT *
  FROM gateway.audit_log
 WHERE request_id = '00000000-0000-0000-0000-000000000000'::uuid;


-- What else that vendor was doing either side of it, for context.
-- ⚠ REPLACE the UUID here too.
SELECT occurred_at, request_id, endpoint, method, status, error_code, total_ms
  FROM gateway.audit_log
 WHERE vendor_id = (SELECT vendor_id FROM gateway.audit_log
                     WHERE request_id = '00000000-0000-0000-0000-000000000000'::uuid)
   AND occurred_at BETWEEN
       (SELECT occurred_at - interval '5 minutes' FROM gateway.audit_log
         WHERE request_id = '00000000-0000-0000-0000-000000000000'::uuid)
   AND (SELECT occurred_at + interval '5 minutes' FROM gateway.audit_log
         WHERE request_id = '00000000-0000-0000-0000-000000000000'::uuid)
 ORDER BY occurred_at;
