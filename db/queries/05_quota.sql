-- Monthly usage against each vendor's cap, current period.

SELECT q.vendor_id                                    AS vendor,
       q.calls                                        AS used,
       v.monthly_quota                                AS quota,
       CASE WHEN v.monthly_quota IS NULL THEN 'uncapped'
            ELSE round(100.0 * q.calls / v.monthly_quota, 1) || '%' END AS consumed,
       CASE WHEN v.monthly_quota IS NULL THEN NULL
            ELSE greatest(0, v.monthly_quota - q.calls) END             AS remaining,
       q.updated_at                                   AS last_call
  FROM gateway.quota_usage q
  JOIN gateway.vendors v ON v.id = q.vendor_id
 WHERE q.period = date_trunc('month', now() AT TIME ZONE 'UTC')::date
   AND q.endpoint = '*'
 ORDER BY consumed DESC NULLS LAST;


-- Which endpoints a vendor is actually spending their quota on.
SELECT vendor_id AS vendor, endpoint, calls
  FROM gateway.quota_usage
 WHERE period = date_trunc('month', now() AT TIME ZONE 'UTC')::date
   AND endpoint <> '*'
 ORDER BY vendor_id, calls DESC;


-- Six-month trend, to spot a vendor ramping up before they hit the cap.
SELECT period, vendor_id AS vendor, calls
  FROM gateway.quota_usage
 WHERE endpoint = '*' AND period >= (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '5 months')::date
 ORDER BY period DESC, calls DESC;
