'use strict';

const db = require('../pool');

/**
 * The supplier application master.
 *
 * The same rows the Studio writes — gateway.upstreams — read and edited as a
 * register rather than as step 1 of a wizard. The Studio answers "how do I
 * wrap this endpoint"; this answers "what have we onboarded, who owns it, who
 * do we tell when it breaks, and is it still in use".
 *
 * Sharing the table is the point. A separate master would be a second place to
 * change a base URL, and the two would disagree the first time somebody
 * changed the wrong one — with the gateway quietly following whichever one the
 * config loader happens to read.
 *
 * NO DELETE. There is deliberately no function here that removes a row, and
 * the admin routes expose none. An application's name is the foreign key in
 * `endpoints`, the scope baked into every credential's AAD, and the `upstream`
 * column on every audit row ever written about it; removing the row detaches
 * the meaning from all of that without removing any of it. `deactivate` is the
 * operation people actually want, and it is reversible.
 */

/** Audit, via the catalogue's own trail so changes appear in one timeline. */
async function logChange({ actor, action, objectId, before = null, after = null }) {
  await db
    .query(
      `INSERT INTO gateway.catalog_audit (actor, action, object_type, object_id, before, after)
       VALUES ($1,$2,'upstream',$3,$4,$5)`,
      [actor, action, objectId, before, after]
    )
    .catch(() => {});
}

async function list({ includeInactive = true } = {}) {
  const r = await db.query(
    `SELECT * FROM gateway.application_master
      ${includeInactive ? '' : 'WHERE enabled'}
      ORDER BY enabled DESC, display_name`
  );
  return r?.rows || [];
}

async function get(name) {
  const r = await db.query('SELECT * FROM gateway.application_master WHERE name = $1', [name]);
  return r?.rows?.[0] || null;
}

/**
 * The endpoints that stop being served if this is deactivated.
 *
 * Fetched so the confirmation can name them. "Deactivate cmots?" is a question
 * nobody can answer; "this withdraws company_master and company_history, which
 * 2 consumers called 1,807 times yesterday" is a question with an answer.
 */
async function endpointsUnder(name) {
  const r = await db.query(
    `SELECT name, coalesce(nullif(display_name,''), name) AS display_name,
            method, path, status, enabled
       FROM gateway.endpoints WHERE upstream = $1
      -- Live first. Sorting on status alphabetically put drafts at the top,
      -- which is backwards: the live ones are what deactivating this would
      -- take out of service, and they are what somebody is here to look at.
      ORDER BY (status = 'live' AND enabled) DESC, status, name`,
    [name]
  );
  return r?.rows || [];
}

/**
 * Create or update the master fields.
 *
 * Deliberately NOT the credential, and deliberately not `enabled`. The
 * credential belongs to the vault and has its own audited path; `enabled` is a
 * production action with consequences this form does not show, so it goes
 * through `setActive` and its own confirmation. A form that can do everything
 * is a form where the dangerous thing is one tab-press from the safe ones.
 */
async function save(row, actor) {
  const name = String(row.name || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_]*$/.test(name)) {
    throw new Error('Reference must be lowercase letters, digits and underscores.');
  }
  const emails = normaliseEmails(row.alertEmails);
  const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad) throw new Error(`"${bad}" is not an email address.`);

  const before = await rawRow(name);

  // An update must not blank the columns this form does not carry, so a
  // create path and an update path rather than one upsert listing every
  // column — the upsert is how a screen silently wipes a field it never knew
  // about.
  const res = before
    ? await db.query(
        `UPDATE gateway.upstreams
            SET display_name=$2, vendor_name=$3, owner=$4, notes=$5,
                base_url=coalesce($6, base_url), timeout_ms=coalesce($7, timeout_ms),
                alert_emails=$8, alerts_enabled=$9,
                updated_at=now(), updated_by=$10
          WHERE name=$1 RETURNING *`,
        [name, nz(row.displayName), nz(row.vendorName), nz(row.owner), nz(row.notes),
         nz(row.baseUrl), row.timeoutMs ? Number(row.timeoutMs) : null,
         emails, row.alertsEnabled !== false, actor]
      )
    : await db.query(
        `INSERT INTO gateway.upstreams
           (name, base_url, timeout_ms, display_name, vendor_name, owner, notes,
            alert_emails, alerts_enabled, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [name, String(row.baseUrl || '').trim(), Number(row.timeoutMs) || 15000,
         nz(row.displayName), nz(row.vendorName), nz(row.owner), nz(row.notes),
         emails, row.alertsEnabled !== false, actor]
      );

  await logChange({
    actor, action: before ? 'update' : 'create', objectId: name,
    before, after: res.rows[0],
  });
  return res.rows[0];
}

/**
 * Deactivate or reactivate.
 *
 * The config loader does `if (!u.enabled) continue` and then drops every
 * endpoint whose upstream is absent, so clearing this withdraws everything
 * underneath at the next reload. That is the intent — it is the only way to
 * stop serving a supplier without deleting anything — but it is why the route
 * names the affected endpoints first and why the reason is recorded.
 */
async function setActive(name, active, actor, reason) {
  const before = await rawRow(name);
  if (!before) throw new Error(`No application called "${name}".`);

  const res = await db.query(
    `UPDATE gateway.upstreams
        SET enabled = $2,
            deactivated_at     = CASE WHEN $2 THEN NULL ELSE now() END,
            deactivated_by     = CASE WHEN $2 THEN NULL ELSE $3 END,
            deactivated_reason = CASE WHEN $2 THEN NULL ELSE $4 END,
            updated_at = now(), updated_by = $3
      WHERE name = $1 RETURNING *`,
    [name, active, actor, reason ? String(reason).slice(0, 500) : null]
  );
  await logChange({
    actor, action: active ? 'enable' : 'disable', objectId: name,
    before, after: res.rows[0],
  });
  return res.rows[0];
}

/** Where an alert about this application should go, with its fallback. */
async function alertRecipients(name) {
  const r = await db.query(
    `SELECT alert_emails, alerts_enabled FROM gateway.upstreams WHERE name = $1`,
    [name]
  );
  const row = r?.rows?.[0];
  if (!row || !row.alerts_enabled) return [];
  return row.alert_emails || [];
}

async function rawRow(name) {
  const r = await db.query('SELECT * FROM gateway.upstreams WHERE name = $1', [name]);
  return r?.rows?.[0] || null;
}

const nz = (v) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s === '' ? null : s;
};

/**
 * One textarea, any of comma, semicolon, newline or space between addresses.
 *
 * People paste from Outlook, which uses semicolons, and from a spreadsheet,
 * which uses newlines. Accepting one separator and silently keeping the rest
 * as part of the address produces a list that validates, saves, and delivers
 * nothing.
 */
function normaliseEmails(input) {
  if (Array.isArray(input)) input = input.join(',');
  return String(input || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    // Case-insensitively unique, first spelling wins.
    .filter((e, i, a) => a.findIndex((x) => x.toLowerCase() === e.toLowerCase()) === i);
}

module.exports = {
  list, get, endpointsUnder, save, setActive, alertRecipients, normaliseEmails,
};
