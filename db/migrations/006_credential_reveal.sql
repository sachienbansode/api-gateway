-- ===========================================================================
-- 006_credential_reveal.sql — a full-access admin may read a stored credential
--
-- The decision: a SuperAdmin can see the supplier token whenever they need it,
-- and it stays encrypted at rest.
--
-- That is a reasonable product call. Someone has to be able to answer "what
-- token are we actually sending?" at 2am without a redeploy, and the
-- alternative — keeping a copy in a spreadsheet — is worse in every way.
--
-- What encryption at rest still buys once reading is allowed:
--
--   * A database dump, backup, replica or stolen disk is useless on its own.
--     The key is GW_SECRET_KEY in /etc/api-gateway/env, and reading requires
--     the running application, which requires a signed admin session.
--   * Reading is an ACT, not a state. It goes through one code path, it is
--     attributable to a person, and this migration makes it recordable.
--
-- What it does not buy: protection from the people you gave full access to.
-- It was never going to. The control there is the log below.
--
-- Additive and guarded. Safe to re-run.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS gateway;
SET search_path TO gateway, public;

-- 'reveal' joins set / rotate / clear / decrypt_failed.
--
-- A reveal is the only one of these that changes nothing, which is exactly why
-- it has to be written down: without a record, reading a credential is the one
-- privileged action that leaves no trace at all.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_audit_action_check') THEN
    ALTER TABLE gateway.secret_audit DROP CONSTRAINT secret_audit_action_check;
  END IF;
  ALTER TABLE gateway.secret_audit ADD CONSTRAINT secret_audit_action_check
    CHECK (action IN ('set','rotate','clear','decrypt_failed','reveal'));
END $$;

-- Who looked at what, and why they said they needed it.
ALTER TABLE gateway.secret_audit ADD COLUMN IF NOT EXISTS reason TEXT;

COMMENT ON COLUMN gateway.secret_audit.reason IS
  'Free text the admin gave when revealing a credential. Not validated — its '
  'value is that it has to be typed, which makes an idle look a deliberate one.';

-- ---------------------------------------------------------------------------
-- Who has read a credential lately.
--
-- The question an auditor asks is never "is it encrypted" — it is "who has
-- seen it". This answers that in one SELECT.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW gateway.credential_access AS
SELECT occurred_at, actor, upstream, slot, action, reason, hint, key_id
  FROM gateway.secret_audit
 WHERE action IN ('reveal','set','rotate','clear')
 ORDER BY occurred_at DESC;

COMMENT ON VIEW gateway.credential_access IS
  'Every time a supplier credential was set, replaced, removed or READ, and by whom.';
