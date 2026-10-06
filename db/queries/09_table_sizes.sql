-- Growth, and whether retention is actually running.

SELECT relname                                            AS table,
       to_char(n_live_tup, 'FM999,999,999')               AS approx_rows,
       pg_size_pretty(pg_total_relation_size(relid))       AS total_size,
       pg_size_pretty(pg_indexes_size(relid))              AS index_size
  FROM pg_stat_user_tables
 WHERE schemaname = 'gateway'
 ORDER BY pg_total_relation_size(relid) DESC;


-- ⚠ Retention check. If `oldest_row` is older than your configured
-- --audit-days, the nightly purge in /etc/cron.d/vendor-api-wrapper is not
-- running. Audit and idempotency tables grow forever without it.
SELECT min(occurred_at)                                     AS oldest_row,
       max(occurred_at)                                     AS newest_row,
       round(extract(epoch FROM max(occurred_at) - min(occurred_at)) / 86400) AS span_days,
       count(*)                                             AS total_rows
  FROM gateway.audit_log;


-- Daily volume, to project storage.
SELECT occurred_at::date AS day, count(*) AS rows
  FROM gateway.audit_log
 WHERE occurred_at >= now() - interval '30 days'
 GROUP BY 1
 ORDER BY 1 DESC;
