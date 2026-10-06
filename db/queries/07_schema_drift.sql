-- Fields your upstreams actually return, recorded by discovery.
-- Field NAMES only — no values are ever stored here.
--
-- This is how you convert a `redact` or `passthrough` endpoint to a strict
-- whitelist from observed reality rather than guesswork.
-- CLI equivalent (prints paste-ready YAML): npm run fields -- <endpoint>

SELECT endpoint,
       count(*)          AS fields_seen,
       min(first_seen)   AS watching_since,
       max(last_seen)    AS last_response
  FROM gateway.observed_fields
 GROUP BY endpoint
 ORDER BY endpoint;


-- Every path for one endpoint. ⚠ REPLACE the endpoint name.
SELECT field_path, first_seen, last_seen
  FROM gateway.observed_fields
 WHERE endpoint = 'get_invoice'
 ORDER BY field_path;


-- ⚠ THE IMPORTANT ONE: fields that appeared RECENTLY.
--
-- On a redact or passthrough endpoint, a newly appearing field is already
-- reaching your vendor. This is your review queue.
SELECT endpoint, field_path, first_seen
  FROM gateway.observed_fields
 WHERE first_seen >= now() - interval '30 days'
 ORDER BY first_seen DESC;
