-- Key inventory. Only hashes are stored — the plaintext is unrecoverable by
-- design, including by you.
-- CLI equivalent: node scripts/gw.js key:list <vendorId>

SELECT k.vendor_id                          AS vendor,
       left(k.key_hash, 12) || '…'          AS hash_prefix,
       k.key_hash                           AS full_hash_for_revoke,
       k.label,
       k.created_at,
       k.last_used_at,
       k.expires_at,
       k.revoked_at,
       CASE
         WHEN k.revoked_at IS NOT NULL                    THEN 'revoked'
         WHEN k.expires_at IS NOT NULL
              AND k.expires_at <= now()                   THEN 'expired'
         WHEN k.last_used_at IS NULL                      THEN 'never used'
         WHEN k.last_used_at < now() - interval '30 days'  THEN 'stale (30d+)'
         ELSE 'active'
       END                                  AS state
  FROM gateway.vendor_keys k
 ORDER BY k.vendor_id, k.created_at DESC;


-- Keys worth chasing: issued but never used (vendor never onboarded?), or
-- unused for 90 days (candidate for revocation).
SELECT vendor_id AS vendor, left(key_hash, 12) || '…' AS hash_prefix, label,
       created_at, last_used_at
  FROM gateway.vendor_keys
 WHERE revoked_at IS NULL
   AND (last_used_at IS NULL OR last_used_at < now() - interval '90 days')
 ORDER BY created_at;
