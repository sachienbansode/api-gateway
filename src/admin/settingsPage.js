'use strict';

const { esc, layout, pageHead, panel, tablePanel, fmtDate } = require('./ui');

/**
 * Admin config.
 *
 * Only values that are safe to hold in the database appear here. Anything
 * needed to READ the database, or to protect what is in it — the encryption
 * key, the connection strings, the JWT secret — stays in the env file and is
 * shown on this page only as a statement that it is elsewhere. An operator
 * looking for it should find out why, not hunt for a field that does not exist.
 */
function render({ admin, flash, settings, history }) {
  const list = Object.values(settings).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const sourceBadge = (s) => s.source === 'console'
    ? '<span class="badge ok">set here</span>'
    : s.source === 'environment'
      ? '<span class="badge mute">from the env file</span>'
      : '<span class="badge warn">not set</span>';

  const fields = list.map((s) => `
    <div class="f" style="grid-column:span 2">
      <label for="s_${esc(s.key)}">${esc(s.label || s.key)} ${sourceBadge(s)}</label>
      <input id="s_${esc(s.key)}" name="${esc(s.key)}" value="${esc(s.value || '')}"
             placeholder="${esc(s.fallback || '')}" spellcheck="false"
             ${s.kind === 'url' ? 'type="url"' : ''}>
      <p class="hint">${esc(s.help || '')}
        ${s.source === 'environment' && s.fallback
          ? `Currently using <code>${esc(s.fallback)}</code> from the environment; type here to override it.`
          : ''}
        ${s.updated_at ? `<br>Last changed ${fmtDate(s.updated_at)}${s.updated_by ? ' by ' + esc(s.updated_by) : ''}.` : ''}
      </p>
    </div>`).join('');

  const historyRows = history.map((h) => `
    <tr><td class="t2">${fmtDate(h.occurred_at)}</td>
        <td class="mono">${esc(h.key)}</td>
        <td class="t2">${h.old_value ? esc(h.old_value) : '<em>unset</em>'}</td>
        <td class="mono">${h.new_value ? esc(h.new_value) : '<em>unset</em>'}</td>
        <td class="t2">${esc(h.actor)}</td></tr>`).join('')
    || '<tr><td colspan="5" class="empty">Nothing has been changed yet.</td></tr>';

  const body = `
${pageHead('Admin config', 'Settings that belong to the product rather than to the machine it runs on.')}

<form method="post" action="/admin/settings">
  ${panel('Vendor-facing', '', `<div class="fields">${fields}</div>
    <div class="formfoot">
      <button type="submit" class="primary"
        data-confirm="Save these settings?"
        data-confirm-body="The public base URL appears in every Postman collection and in the API documentation partners work from. Changing it does not move the gateway — it changes what vendors are told to call.">Save</button>
      <p class="hint">A blank field falls back to the environment, which is what a fresh
        deployment uses.</p>
    </div>`)}
</form>

${panel('Kept in /etc/api-gateway/env, deliberately', '', `
  <dl class="cfg">
    <dt>GW_SECRET_KEY</dt>
      <dd>Decrypts every stored supplier credential. In the database it would be a lock
          taped to its own door — a dump would contain both.</dd>
    <dt>GW_DATABASE_URL · AUTH_DATABASE_URL</dt>
      <dd>How to reach this table. It cannot configure itself.</dd>
    <dt>JWT_SECRET</dt>
      <dd>What proves an admin session is genuine. An attacker who could edit it from a
          console could mint their own session.</dd>
    <dt>Supplier tokens</dt>
      <dd>In the database, but encrypted and never shown in full — see a supplier in the
          <a href="/admin/catalog/upstreams">catalogue</a>.</dd>
  </dl>`)}

${tablePanel('Change history', '',
  '<th>When</th><th>Setting</th><th>Was</th><th>Became</th><th>By</th>', historyRows)}

<style>
.cfg{display:grid;grid-template-columns:260px 1fr;gap:0;margin:0}
.cfg dt{padding:9px 0;font-family:var(--mono);font-size:11.5px;color:var(--ink);
  border-bottom:1px solid var(--border)}
.cfg dd{margin:0;padding:9px 0;font-size:12.5px;color:var(--ink2);
  border-bottom:1px solid var(--border)}
.cfg dt:last-of-type,.cfg dd:last-of-type{border-bottom:0}
@media(max-width:800px){.cfg{grid-template-columns:1fr}.cfg dd{padding-top:0;border-bottom:0}}
</style>`;

  return layout({ title: 'Admin config', admin, current: '/admin/settings', body, flash });
}

module.exports = { render };
