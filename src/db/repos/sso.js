'use strict';

const db = require('../pool');
const secretbox = require('../../core/secretbox');

/**
 * Ashika Portal SSO: settings, and what a portal role means here.
 *
 * The client secret is sealed with AES-256-GCM under GW_SECRET_KEY — the same
 * mechanism and the same key as the supplier credentials and the SMTP
 * password, so there is one thing to protect and one thing to rotate.
 *
 * `openSecret()` is called at the moment a token is about to be exchanged and
 * nowhere else. Everything that renders goes through `status()`, which cannot
 * return a secret because it does not select the ciphertext columns at all —
 * the screen is structurally incapable of leaking it, rather than merely
 * careful not to.
 */

const AAD = 'sso:portal:client_secret';

const LEVELS = ['none', 'view', 'edit', 'admin'];

/** Status only. Safe for any screen; never touches the sealed columns. */
async function status() {
  try {
    const r = await db.query(
      `SELECT id, enabled, base_url, client_id, allow_insecure, use_pkce,
              redirect_uri, test_status, test_error, test_detail, last_tested_at,
              updated_at, updated_by,
              (secret_ciphertext IS NOT NULL) AS secret_stored,
              secret_hint
         FROM gateway.sso_settings WHERE id = 1`
    );
    return r?.rows?.[0] || null;
  } catch {
    // Before 016 is applied. Not an error — SSO is simply not available yet,
    // and the caller falls through to password sign-in.
    return null;
  }
}

/**
 * Is SSO actually usable, and if not, why not?
 *
 * Returns a reason rather than a boolean because every caller — the sign-in
 * page deciding whether to show the button, the settings screen, the health
 * page — needs to say WHY, and recomputing that in three places is how three
 * screens end up disagreeing.
 */
async function ready() {
  const s = await status();
  if (!s) return { ok: false, reason: 'the SSO tables are not installed yet' };
  if (!s.enabled) return { ok: false, reason: 'SSO is switched off', settings: s };
  if (!s.base_url) return { ok: false, reason: 'no portal URL is set', settings: s };
  if (!s.client_id) return { ok: false, reason: 'no client id is set', settings: s };
  if (!s.redirect_uri) return { ok: false, reason: 'no redirect URI is set', settings: s };

  // The one check worth failing a sign-in over. An authorization-code flow
  // over plain HTTP puts the code and then the token on the wire in clear;
  // anyone who can read that traffic becomes an administrator here. Allowed
  // only when somebody has ticked the box that says so.
  if (!/^https:/i.test(s.base_url) && !s.allow_insecure) {
    return {
      ok: false,
      reason: 'the portal URL is not https, and insecure transport has not been allowed',
      settings: s,
    };
  }

  if (!s.use_pkce && !s.secret_stored) {
    return {
      ok: false,
      reason: 'no client secret is stored and PKCE is not enabled — the token ' +
        'exchange cannot authenticate this client',
      settings: s,
    };
  }
  return { ok: true, settings: s };
}

/**
 * The endpoints, derived from base_url rather than stored separately.
 *
 * The portal's own External Applications screen lists four — authorize, token,
 * introspect, userinfo. `/profile` came in the credentials email but does not
 * appear there, so it is probed as a maybe and nothing depends on it:
 * `userinfo` is the documented one.
 */
function endpoints(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return {
    authorize: `${base}/authorize`,
    token: `${base}/token`,
    introspect: `${base}/introspect`,
    userinfo: `${base}/userinfo`,
    profile: `${base}/profile`,
  };
}

/** The client secret, unsealed. Called only at a token exchange. */
async function openSecret() {
  const r = await db.query(
    `SELECT secret_ciphertext, secret_iv, secret_tag, secret_key_id
       FROM gateway.sso_settings WHERE id = 1`
  );
  const s = r?.rows?.[0];
  if (!s || !s.secret_ciphertext) return null;
  return secretbox.open(
    {
      ciphertext: s.secret_ciphertext,
      iv: s.secret_iv,
      tag: s.secret_tag,
      keyId: s.secret_key_id,
    },
    AAD
  );
}

/**
 * Save the settings.
 *
 * An EMPTY secret box means "leave the stored one alone", not "clear it" —
 * the form cannot show the current value, so treating blank as a deletion
 * would wipe the secret every time somebody corrected a typo in the client id.
 * Clearing is an explicit separate action.
 */
async function save(input, actor) {
  const base = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  if (base && !/^https?:\/\//i.test(base)) {
    throw new Error('The portal URL must start with http:// or https://');
  }
  const redirect = String(input.redirectUri || '').trim();
  if (redirect && !/^https?:\/\//i.test(redirect)) {
    throw new Error('The redirect URI must be a full URL starting http:// or https://');
  }
  // Refuse the dangerous combination at the point of writing it, not at the
  // point of using it. A setting that saves cleanly and fails at sign-in is a
  // setting somebody will turn on at 5pm on a Friday.
  if (base && !/^https:/i.test(base) && input.enabled && !input.allowInsecure) {
    throw new Error(
      'That portal URL is plain HTTP. An authorization code and access token ' +
      'would cross the network in clear. Tick "allow insecure transport" if ' +
      'this is a staging portal on an internal network.'
    );
  }

  const secret = String(input.clientSecret || '');
  const sealed = secret ? secretbox.seal(secret, AAD) : null;

  await db.query(
    `UPDATE gateway.sso_settings SET
       enabled        = $1,
       base_url       = nullif($2,''),
       client_id      = nullif($3,''),
       allow_insecure = $4,
       use_pkce       = $5,
       redirect_uri   = nullif($6,''),
       secret_ciphertext = COALESCE($7, secret_ciphertext),
       secret_iv         = COALESCE($8, secret_iv),
       secret_tag        = COALESCE($9, secret_tag),
       secret_key_id     = COALESCE($10, secret_key_id),
       secret_hint       = COALESCE($11, secret_hint),
       -- Any settings change invalidates the last test result. Showing a green
       -- tick next to a URL that has since been edited is worse than showing
       -- nothing, because somebody will trust it.
       test_status = NULL, test_error = NULL, test_detail = NULL, last_tested_at = NULL,
       updated_at = now(), updated_by = $12
     WHERE id = 1`,
    [
      input.enabled === true,
      base,
      String(input.clientId || '').trim(),
      input.allowInsecure === true,
      input.usePkce === true,
      redirect,
      sealed ? sealed.ciphertext : null,
      sealed ? sealed.iv : null,
      sealed ? sealed.tag : null,
      sealed ? sealed.keyId : null,
      // seal() decides the hint, and gives none for a secret under 12
      // characters — four of eight characters is half the secret. Computing
      // it here instead would quietly reintroduce that leak.
      sealed ? (sealed.hint || null) : null,
      actor,
    ]
  );
  await logSetting(actor, 'sso settings changed');
}

/** Forget the stored secret. Explicit, because blank means "keep". */
async function clearSecret(actor) {
  await db.query(
    `UPDATE gateway.sso_settings
        SET secret_ciphertext = NULL, secret_iv = NULL, secret_tag = NULL,
            secret_key_id = NULL, secret_hint = NULL,
            test_status = NULL, test_error = NULL, test_detail = NULL,
            updated_at = now(), updated_by = $1
      WHERE id = 1`,
    [actor]
  );
  await logSetting(actor, 'sso client secret cleared');
}

async function recordTest({ ok, error = null, detail = null }) {
  await db.query(
    `UPDATE gateway.sso_settings
        SET test_status = $1, test_error = $2, test_detail = $3, last_tested_at = now()
      WHERE id = 1`,
    [ok ? 'ok' : 'failed', ok ? null : String(error || '').slice(0, 2000), detail]
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Role mapping
// ---------------------------------------------------------------------------

async function roles() {
  try {
    const r = await db.query(
      `SELECT * FROM gateway.sso_role_map ORDER BY
         CASE level WHEN 'admin' THEN 0 WHEN 'edit' THEN 1
                    WHEN 'view' THEN 2 ELSE 3 END, portal_role`
    );
    return r?.rows || [];
  } catch {
    return [];
  }
}

/**
 * What this portal role means here.
 *
 * An unmapped role resolves to 'none' AND reports the name, so the sign-in
 * page can say "your portal role \"Finance Admin\" has no access here" rather
 * than "access denied" — which is the version that generates a support ticket
 * every single time, because nobody can act on it.
 */
async function levelFor(portalRole) {
  const name = String(portalRole || '').trim();
  if (!name) return { level: 'none', role: null, mapped: false };
  const r = await db.query(
    `SELECT portal_role, level FROM gateway.sso_role_map WHERE lower(portal_role) = lower($1)`,
    [name]
  );
  const row = r?.rows?.[0];
  return row
    ? { level: row.level, role: row.portal_role, mapped: true }
    : { level: 'none', role: name, mapped: false };
}

async function setRole({ portalRole, level, notes }, actor) {
  const name = String(portalRole || '').trim();
  if (!name) throw new Error('A portal role name is required.');
  if (!LEVELS.includes(level)) throw new Error(`Level must be one of ${LEVELS.join(', ')}.`);
  await db.query(
    `INSERT INTO gateway.sso_role_map (portal_role, level, notes, updated_by)
     VALUES ($1,$2,nullif($3,''),$4)
     ON CONFLICT (portal_role) DO UPDATE SET
       level = EXCLUDED.level, notes = EXCLUDED.notes,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [name, level, String(notes || '').trim(), actor]
  );
  await logSetting(actor, `sso role "${name}" mapped to ${level}`);
}

async function removeRole(portalRole, actor) {
  await db.query('DELETE FROM gateway.sso_role_map WHERE lower(portal_role) = lower($1)',
    [String(portalRole || '')]);
  await logSetting(actor, `sso role "${portalRole}" unmapped`);
}

/** Into the existing settings trail, so SSO changes appear in one timeline. */
async function logSetting(actor, what) {
  await db.query(
    `INSERT INTO gateway.settings_audit (actor, key, old_value, new_value)
     VALUES ($1, 'sso', NULL, $2)`,
    [actor, what]
  ).catch(() => {});
}

module.exports = {
  LEVELS, AAD,
  status, ready, endpoints, openSecret, save, clearSecret, recordTest,
  roles, levelFor, setRole, removeRole,
};
