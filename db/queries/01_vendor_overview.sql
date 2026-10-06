-- Who has access, to what, and with how many live keys.
-- CLI equivalent: node scripts/gw.js vendor:list

SELECT v.id                                            AS vendor,
       v.name,
       v.enabled,
       COALESCE(
         (SELECT string_agg(s.scope, ', ' ORDER BY s.scope)
            FROM gateway.vendor_scopes s WHERE s.vendor_id = v.id),
         '(none — cannot reach any endpoint)')          AS scopes,
       (SELECT count(*) FROM gateway.vendor_keys k
         WHERE k.vendor_id = v.id
           AND k.revoked_at IS NULL
           AND (k.expires_at IS NULL OR k.expires_at > now()))  AS live_keys,
       v.monthly_quota                                 AS quota,
       v.rate_max || ' / ' || (v.rate_window_ms / 1000) || 's'  AS burst_limit,
       (SELECT max(k.last_used_at) FROM gateway.vendor_keys k
         WHERE k.vendor_id = v.id)                      AS last_seen,
       v.created_at
  FROM gateway.vendors v
 ORDER BY v.enabled DESC, v.id;
