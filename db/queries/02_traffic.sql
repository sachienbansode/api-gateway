-- Calls, errors and latency per vendor and endpoint.
-- CLI equivalent: node scripts/gw.js usage [vendorId] [--since=DAYS]
--
-- Change the interval on the WHERE line to widen or narrow the window.

SELECT vendor_id                                              AS vendor,
       endpoint,
       count(*)                                               AS calls,
       count(*) FILTER (WHERE status >= 400)                   AS errors,
       round(100.0 * count(*) FILTER (WHERE status >= 400) / count(*), 1) AS error_pct,
       round(avg(total_ms))                                   AS avg_ms,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY total_ms)  AS p95_ms,
       max(total_ms)                                          AS worst_ms,
       round(avg(upstream_ms))                                AS avg_upstream_ms,
       max(occurred_at)                                       AS last_call
  FROM gateway.audit_log
 WHERE occurred_at >= now() - interval '24 hours'
 GROUP BY vendor_id, endpoint
 ORDER BY calls DESC;
