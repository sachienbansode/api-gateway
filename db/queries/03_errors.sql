-- Recent failures, including the internal reason the vendor never sees.
--
-- `internal_reason` is the whole point of this table: the vendor got a generic
-- message and a requestId, and this is where the real cause lives.

SELECT occurred_at,
       request_id,          -- the id the vendor can quote at you
       vendor_id            AS vendor,
       endpoint,
       status,
       error_code,
       upstream_status,
       total_ms,
       internal_reason
  FROM gateway.audit_log
 WHERE status >= 400
   AND occurred_at >= now() - interval '24 hours'
 ORDER BY occurred_at DESC
 LIMIT 100;


-- Failure shape, to tell a broken vendor apart from a broken upstream.
-- Lots of 401/403 = their problem. Lots of 502/503/504 = yours.
SELECT error_code,
       status,
       count(*) AS occurrences,
       min(occurred_at) AS first_seen,
       max(occurred_at) AS last_seen
  FROM gateway.audit_log
 WHERE status >= 400
   AND occurred_at >= now() - interval '7 days'
 GROUP BY error_code, status
 ORDER BY occurrences DESC;
