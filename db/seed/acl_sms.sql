-- ===========================================================================
-- acl_sms.sql — onboard the ACL SMS gateway
--
-- The live call this reproduces:
--
--   GET https://push3.aclgateway.com/servlet/com.aclwireless.pushconnectivity
--       .listeners.TextListener
--       ?appid=ashismbalt&userId=ashismbalt&pass=…&contenttype=1
--       &from=ASHIKA&to=9820031724&text=…&alert=1&selfid=true
--
-- Nine parameters. Seven are ours and fixed; two come from the consumer.
--
-- THE PASSWORD IS NOT IN THIS FILE, AND CANNOT BE.
--
-- `pass` is inserted with source = 'secret' and no value. Sealing needs
-- AES-256-GCM under GW_SECRET_KEY, which lives in the env file and not in the
-- database — so a SQL script cannot do it, and that is the point rather than
-- an inconvenience. Paste the password once in the Studio after running this,
-- and it is encrypted before it is stored. The CHECK constraint
-- `param_secret_has_no_plaintext` will reject this row if anyone later tries
-- to put the password in the plaintext column instead.
--
-- Run AFTER migrations 018, 019 and 020.
--
-- Idempotent: re-running updates in place and does not duplicate anything.
-- ===========================================================================

SET search_path TO gateway, public;

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The application and the supplier
--
-- base_url is scheme and host ONLY. The long servlet path belongs to the
-- endpoint, not the supplier — putting it here appends it to every endpoint
-- path and produces a 404 that looks like ACL being down.
--
-- auth_type is 'none' and that is correct, not a shortcut: ACL has no
-- Authorization header. Its credentials are ordinary request parameters, which
-- is what section 3 sets up.
-- ---------------------------------------------------------------------------
INSERT INTO applications (code, name, description, enabled)
VALUES ('acl', 'SMS Gateway - ACL',
        'ACL Wireless push gateway. Transactional SMS, DLT registered.', TRUE)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO upstreams (name, display_name, base_url, auth_type, application, timeout_ms)
VALUES ('acl', 'ACL Wireless', 'https://push3.aclgateway.com', 'none', 'acl', 15000)
ON CONFLICT (name) DO UPDATE SET
  base_url   = EXCLUDED.base_url,
  auth_type  = EXCLUDED.auth_type,
  application= EXCLUDED.application,
  timeout_ms = EXCLUDED.timeout_ms;

-- ---------------------------------------------------------------------------
-- 2. Our endpoint
--
-- method POST, upstream_method GET. The consumer is doing something with a
-- side effect, so POST is the honest verb for them even though ACL's listener
-- is a GET.
--
-- idempotency = 'required' is the whole reason to bother. The consumer must
-- send an Idempotency-Key header, so their retry after a timeout returns the
-- first result instead of sending a second message. On an endpoint that costs
-- money per call and that a customer can SEE duplicated, this is the setting
-- that matters most on the screen.
--
-- response_mode = 'text' because ACL answers with a status line, not JSON.
-- Without it the gateway rejects a SUCCESSFUL send as an unparseable response,
-- returns 502, and the consumer's retry sends a second message.
--
-- text_failure_match IS DELIBERATELY NULL — see the note at the bottom.
-- ---------------------------------------------------------------------------
INSERT INTO endpoints (
    name, application, display_name, description,
    method, path, upstream, upstream_path, upstream_method,
    response_mode, acknowledge_unfiltered, text_content_type, text_failure_match,
    request_query, request_body,
    rate_window_ms, rate_max, idempotency,
    api_type, status, enabled, updated_by)
VALUES (
    'acl_send_sms', 'acl', 'Send an SMS',
    'Sends one transactional SMS through ACL. Answers with ACL''s status line.',
    'POST', '/v1/sms', 'acl',
    '/servlet/com.aclwireless.pushconnectivity.listeners.TextListener', 'GET',
    'text', TRUE, 'text/plain; charset=utf-8', NULL,
    '{}', '{}',
    60000, 30, 'required',
    'transaction', 'draft', TRUE, 'sql-seed')
ON CONFLICT (name) DO UPDATE SET
  application      = EXCLUDED.application,
  display_name     = EXCLUDED.display_name,
  description      = EXCLUDED.description,
  method           = EXCLUDED.method,
  path             = EXCLUDED.path,
  upstream         = EXCLUDED.upstream,
  upstream_path    = EXCLUDED.upstream_path,
  upstream_method  = EXCLUDED.upstream_method,
  response_mode    = EXCLUDED.response_mode,
  acknowledge_unfiltered = EXCLUDED.acknowledge_unfiltered,
  text_content_type= EXCLUDED.text_content_type,
  rate_window_ms   = EXCLUDED.rate_window_ms,
  rate_max         = EXCLUDED.rate_max,
  idempotency      = EXCLUDED.idempotency,
  api_type         = EXCLUDED.api_type,
  updated_at       = now(),
  updated_by       = 'sql-seed';

-- ---------------------------------------------------------------------------
-- 3. The nine parameters
--
-- Replaced wholesale rather than merged, so re-running this file cannot leave
-- a renamed parameter behind still being sent.
--
-- `source` decides who supplies the value:
--   fixed   ours, stored as written. Right for an account id or a flag.
--   secret  ours, sealed. Right for the password and nothing else here.
--   vendor  the consumer supplies it.
--
-- `location` decides where it is placed on the wire — all query, because that
-- is what ACL reads, regardless of our endpoint being a POST.
--
-- `forward_as` is what ACL calls it. Our consumers send `mobile` and
-- `message`; ACL receives `to` and `text`. That indirection is the point of a
-- gateway: moving to Sinch later changes these two cells, not every partner's
-- integration.
-- ---------------------------------------------------------------------------
DELETE FROM endpoint_params WHERE endpoint = 'acl_send_sms';

INSERT INTO endpoint_params
  (endpoint, name, location, source, forward_as, data_type, required,
   fixed_value, example, description, sort_order)
VALUES
  -- Ours, fixed.
  ('acl_send_sms', 'appid',       'query', 'fixed',  NULL, 'string', TRUE,
   'ashismbalt', NULL, 'ACL application id.', 10),

  ('acl_send_sms', 'userId',      'query', 'fixed',  NULL, 'string', TRUE,
   'ashismbalt', NULL, 'ACL user id. Same value as appid on this account.', 20),

  -- Ours, sealed. No value here; set it in the Studio.
  ('acl_send_sms', 'pass',        'query', 'secret', NULL, 'string', TRUE,
   NULL, NULL, 'ACL password. Encrypted at rest; set it on the screen.', 30),

  ('acl_send_sms', 'contenttype', 'query', 'fixed',  NULL, 'string', TRUE,
   '1', NULL, 'ACL content type. 1 = plain text.', 40),

  ('acl_send_sms', 'from',        'query', 'fixed',  NULL, 'string', TRUE,
   'ASHIKA', NULL, 'Registered DLT sender id. Fixed — a consumer must not be '
   'able to send as somebody else.', 50),

  ('acl_send_sms', 'alert',       'query', 'fixed',  NULL, 'string', TRUE,
   '1', NULL, 'ACL alert flag.', 60),

  ('acl_send_sms', 'selfid',      'query', 'fixed',  NULL, 'string', TRUE,
   'true', NULL, 'ACL selfid flag.', 70),

  -- Theirs.
  ('acl_send_sms', 'mobile',      'query', 'vendor', 'to',   'string', TRUE,
   NULL, '9820031724', 'Destination mobile number. Sent to ACL as "to".', 80),

  ('acl_send_sms', 'message',     'query', 'vendor', 'text', 'string', TRUE,
   NULL, 'Your OTP is 12345. Regards Team Ashika',
   'Message text. Must match a registered DLT template. Sent to ACL as "text".', 90);

COMMIT;

-- ===========================================================================
-- AFTER RUNNING THIS — four things, in order
--
-- 1. SET THE PASSWORD.
--    Admin → API Studio → SMS Gateway - ACL → acl_send_sms → step 3. The
--    `pass` row shows an empty password box. Paste it once and save. It is
--    sealed under GW_SECRET_KEY before it is written, and shows afterwards as
--    four characters. Until this is done the endpoint CANNOT work — ACL will
--    answer 200 with an authentication error in the body.
--
-- 2. SET THE FAILURE MATCH. Left NULL on purpose, because guessing it is worse
--    than leaving it empty: a wrong word makes successful sends look failed,
--    and silence makes failed sends look successful. ACL answers HTTP 200 even
--    when it rejects a send, so until this is filled in, every send is
--    recorded as a success. Find the word ACL prints on failure — their
--    document, or send one deliberately broken message and read the reply in
--    step 4 — and put it in the Studio's "failure match" box.
--
-- 3. DECIDE ABOUT THE 91 PREFIX. Your example sends a bare 10-digit number and
--    the Ananta screen has "prepend 91" switched off, so ACL evidently accepts
--    10 digits on this account. Partners will eventually send +91… or 91… —
--    decide whether the contract says 10 digits only, and say so in the
--    endpoint description, or normalise before publishing.
--
-- 4. PUBLISH. The endpoint is created as a DRAFT and is not routed until you
--    publish it. Test it in step 4 first — to your own number — and confirm
--    ONE message arrives and the Overview shows ONE call.
--
-- NOT HANDLED HERE: the DLT template id (1707166306415746129 on the Ananta
-- screen) is not in your example URL, so this endpoint takes free text and
-- relies on the message matching a registered template. If ACL starts
-- rejecting sends for an unregistered template, that is the missing piece, and
-- it is another fixed parameter rather than a redesign.
-- ===========================================================================
