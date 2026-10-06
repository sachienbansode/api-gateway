-- Replay protection health.

SELECT state,
       count(*)           AS records,
       min(created_at)    AS oldest,
       max(created_at)    AS newest
  FROM gateway.idempotency_keys
 GROUP BY state;


-- ⚠ Claims stuck in_progress well past the lease (default 60s).
--
-- A few at any moment is normal — those are requests in flight. A growing
-- population means requests are dying mid-flight: check for upstream timeouts
-- or a crash-looping gateway.
SELECT vendor_id AS vendor, endpoint, idempotency_key, created_at,
       round(extract(epoch FROM now() - created_at)) AS age_seconds
  FROM gateway.idempotency_keys
 WHERE state = 'in_progress'
   AND created_at < now() - interval '5 minutes'
 ORDER BY created_at;


-- Write volume per endpoint, and how much of it is protected.
SELECT endpoint,
       count(*)                                        AS keys_seen,
       count(*) FILTER (WHERE state = 'completed')      AS completed,
       count(DISTINCT vendor_id)                        AS vendors
  FROM gateway.idempotency_keys
 GROUP BY endpoint
 ORDER BY keys_seen DESC;


-- Expired rows still present = the nightly purge cron is not running.
SELECT count(*) AS expired_not_yet_purged,
       min(expires_at) AS oldest_expiry
  FROM gateway.idempotency_keys
 WHERE expires_at < now();
