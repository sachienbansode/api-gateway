-- ===========================================================================
-- 018_text_responses.sql — suppliers that do not answer in JSON
--
-- THE BUG THIS FIXES IS A DOUBLE-SEND.
--
-- src/core/upstream.js parses every response as JSON and throws
-- `upstream body was not valid JSON` when it cannot. For a read endpoint that
-- is a clean failure. For a SEND endpoint it is the worst outcome available:
--
--   1. the gateway calls the supplier
--   2. the SMS goes out
--   3. the body is `1701|919999999999|OK` — not JSON
--   4. the gateway throws, the error handler releases the idempotency claim
--   5. the consumer gets a 502 and retries
--   6. a second SMS goes out
--
-- The message was sent and the consumer was told it failed. ACL, Sinch and
-- most payment gateways answer this way, so this is not an edge case; it is
-- the normal shape of the half of the world that predates JSON.
--
-- A FOURTH RESPONSE MODE: `text`.
--
--   whitelist    build the response field by field          (unchanged, default)
--   redact       forward everything except the named fields  (unchanged)
--   passthrough  forward the JSON body verbatim              (unchanged)
--   text         the supplier does not answer in JSON
--
-- `text` carries the same acknowledgement requirement as passthrough, because
-- it is the same bargain: nothing can be filtered out of a status line, so
-- whatever the supplier says reaches the consumer. The existing CHECK is
-- widened rather than a second one added, so there is one rule, in one place,
-- about which modes are unfiltered.
--
-- WHY A FAILURE RULE IS PART OF THIS
--
-- These suppliers answer HTTP 200 and put the outcome in the body. ACL returns
-- `ERROR|INVALID_NUMBER` with a 200. Without a rule the gateway reports every
-- call as a success, the consumer believes the message went, and nobody finds
-- out until a customer complains. The Ananta SMS screen already models this
-- exactly — "FAILURE MATCH (SUBSTRING IN RESPONSE = FAILED)" — so this is the
-- same idea in the same words, where the call actually happens.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

-- ---------------------------------------------------------------------------
-- 1. Allow the new mode
-- ---------------------------------------------------------------------------
ALTER TABLE endpoints DROP CONSTRAINT IF EXISTS endpoints_response_mode_check;
ALTER TABLE endpoints ADD CONSTRAINT endpoints_response_mode_check
  CHECK (response_mode IN ('whitelist', 'redact', 'passthrough', 'text'));

-- The acknowledgement covers both unfiltered modes. Replacing the old
-- constraint rather than adding a sibling keeps one statement of the rule.
ALTER TABLE endpoints DROP CONSTRAINT IF EXISTS endpoints_passthrough_ack;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'endpoints_unfiltered_ack') THEN
    ALTER TABLE endpoints ADD CONSTRAINT endpoints_unfiltered_ack
      CHECK (response_mode NOT IN ('passthrough', 'text') OR acknowledge_unfiltered = TRUE);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. How to tell a failure that arrived as HTTP 200
--
-- A plain substring, matched case-insensitively, not a regular expression.
-- The person filling this in is reading a supplier's PDF and copying the word
-- it prints on failure; a regex would invite a mistake that only shows up
-- during an incident, and `ERROR` is what they actually need to type.
-- ---------------------------------------------------------------------------
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS text_failure_match TEXT;

COMMENT ON COLUMN endpoints.text_failure_match IS
  'For response_mode = text: if the supplier body contains this substring '
  '(case-insensitive), the call is reported as failed even though the HTTP '
  'status was a success. Blank means trust the status code.';

-- Only meaningful for text responses, and a value set on a JSON endpoint would
-- sit there looking as though it did something.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'endpoints_failure_match_text_only') THEN
    ALTER TABLE endpoints ADD CONSTRAINT endpoints_failure_match_text_only
      CHECK (text_failure_match IS NULL OR response_mode = 'text');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. The content type to answer the consumer with
--
-- Defaults to text/plain. A supplier returning XML or CSV is the same problem
-- with a different label, and the consumer should be told which it is rather
-- than having to sniff it.
-- ---------------------------------------------------------------------------
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS text_content_type TEXT;

COMMENT ON COLUMN endpoints.text_content_type IS
  'For response_mode = text: the Content-Type sent to the consumer. '
  'Defaults to text/plain; charset=utf-8.';
