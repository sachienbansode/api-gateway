'use strict';

const { esc, layout, pageHead, panel, tablePanel, fmtDate, fmtNum } = require('./ui');

/**
 * The supplier application master.
 *
 * A register, which is a different job from the Studio wizard that creates
 * these rows. The wizard asks what you need to build one endpoint; this asks
 * what we have onboarded and whether it is still true — so the columns are
 * ownership, reach and alert routing rather than auth type and base path.
 *
 * Two things this screen refuses to do, both deliberate:
 *
 *   It never offers delete. Not greyed out, not behind a confirmation — the
 *   button does not exist, because the row's name is the foreign key in
 *   `endpoints`, the scope baked into every credential and the `upstream`
 *   column on every audit row ever written about it.
 *
 *   It never shows a credential, not even a masked hint. The vault has its own
 *   audited reveal path with a reason attached to it, and a list screen that
 *   renders "****a93f" has quietly turned a credential read into something
 *   that leaves no trace.
 */

function pill(state, text) {
  return `<span class="pill ${state}"><span class="dot"></span>${esc(text)}</span>`;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
function applicationsPage({ admin, flash, rows, canEdit }) {
  const live = rows.filter((r) => r.enabled);
  const off = rows.filter((r) => !r.enabled);
  const noAlerts = live.filter((r) => !r.alerts_deliverable);

  const body = `
${pageHead('Applications',
  'The supplier APIs this gateway wraps. Endpoints belong to one of these, and so does the credential used to call it.',
  canEdit ? `<a class="btn primary" href="/admin/applications/new">Add an application</a>` : '')}

${noAlerts.length ? `<div class="alerts"><div class="al notice">
  <span class="dot warning"></span>
  <div>${noAlerts.length === 1
    ? `<strong>${esc(noAlerts[0].display_name)}</strong> has no alert recipients`
    : `${noAlerts.length} active applications have no alert recipients`} —
    nobody is told when ${noAlerts.length === 1 ? 'it starts' : 'they start'} failing.
    ${noAlerts.map((r) => `<a href="/admin/applications/${esc(r.name)}#alerts">${esc(r.display_name)}</a>`)
      .join(', ')}</div></div></div>` : ''}

${tablePanel('Active', '',
  `<th class="num">#</th><th>Application</th><th>Supplied by</th><th>Owner</th>
   <th class="num">Endpoints</th><th>Credential</th><th>Alerts</th><th></th>`,
  live.map((r, i) => row(r, i + 1, canEdit)).join('') ||
  '<tr><td colspan="8" class="empty">Nothing onboarded yet. The Studio creates these, or add one here.</td></tr>',
  live.length)}

${off.length ? tablePanel('Deactivated',
  'Not served. Every endpoint underneath is withdrawn until the application is reactivated — nothing has been deleted.',
  `<th class="num">#</th><th>Application</th><th>Deactivated</th><th>By</th><th>Why</th>
   <th class="num">Endpoints held</th><th></th>`,
  off.map((r, i) => `<tr class="off">
    <td class="num t2">${i + 1}</td>
    <td><div class="t1">${esc(r.display_name)}</div><div class="t2 mono">${esc(r.name)}</div></td>
    <td class="t2">${esc(fmtDate(r.deactivated_at) || '—')}</td>
    <td class="t2">${esc(r.deactivated_by || '—')}</td>
    <td class="t2">${esc(r.deactivated_reason || '—')}</td>
    <td class="num">${fmtNum(r.endpoints)}</td>
    <td class="actions"><a class="btn" href="/admin/applications/${esc(r.name)}">Open</a></td>
  </tr>`).join(''), off.length) : ''}

<style>${CSS}</style>`;

  return layout({ title: 'Applications', admin, current: '/admin/applications', body, flash });
}

function row(r, n, canEdit) {
  return `<tr>
    <td class="num t2">${n}</td>
    <td><div class="t1">${esc(r.display_name)}</div>
        <div class="t2 mono">${esc(r.name)} · ${esc(r.base_url)}</div></td>
    <td class="t2">${esc(r.vendor_name || '—')}</td>
    <td class="t2">${esc(r.owner || '<unassigned>') === '<unassigned>'
      ? '<span class="t3">unassigned</span>' : esc(r.owner)}</td>
    <td class="num">${fmtNum(r.live_endpoints)}${r.draft_endpoints
      ? `<div class="t2">+${fmtNum(r.draft_endpoints)} draft</div>` : ''}</td>
    <td>${r.has_credential ? pill('good', 'set') : pill('warning', 'none')}</td>
    <td>${r.alerts_deliverable
      ? `<span class="t2">${fmtNum(r.alert_emails.length)} recipient${r.alert_emails.length === 1 ? '' : 's'}</span>`
      : pill('warning', 'nobody')}</td>
    <td class="actions"><a class="btn" href="/admin/applications/${esc(r.name)}">${
      canEdit ? 'Edit' : 'View'}</a></td>
  </tr>`;
}

// ---------------------------------------------------------------------------
// One application
// ---------------------------------------------------------------------------
function applicationPage({ admin, flash, app, endpoints, canEdit, isNew = false }) {
  const a = app || {};
  const liveEps = endpoints.filter((e) => e.status === 'live' && e.enabled);
  const emails = (a.alert_emails || []).join('\n');

  const body = `
${pageHead(isNew ? 'Add an application' : a.display_name,
  isNew
    ? 'A supplier API this gateway will wrap. You can add endpoints to it in the Studio afterwards.'
    : `Supplier application <span class="mono">${esc(a.name)}</span>${
        a.enabled ? '' : ' — <strong>deactivated</strong>, serving nothing'}.`,
  isNew ? '' : `<a class="btn" href="/admin/applications">All applications</a>`)}

${!isNew && !a.enabled ? `<div class="alerts"><div class="al notice">
  <span class="dot warning"></span><div>Deactivated ${esc(fmtDate(a.deactivated_at) || '')} by
  ${esc(a.deactivated_by || 'someone')}${a.deactivated_reason
    ? ` — ${esc(a.deactivated_reason)}` : ''}.
  ${fmtNum(a.endpoints)} endpoint(s) are held and not served.</div></div></div>` : ''}

<form method="post" action="/admin/applications/${isNew ? 'new' : esc(a.name)}" class="appform">
  ${panel('What this is', '', `
  <div class="grid">
    <div class="f"><label for="display_name">Display name</label>
      <input id="display_name" name="display_name" value="${esc(a.display_name === a.name ? '' : (a.display_name || ''))}"
        placeholder="CMOTS Stock APIs" ${canEdit ? '' : 'disabled'}>
      <p class="hint">What people call it. Safe to change at any time.</p></div>

    <div class="f"><label for="name">Reference</label>
      <input id="name" name="name" value="${esc(a.name || '')}"
        pattern="[a-z0-9][a-z0-9_]*" ${isNew ? 'required' : 'readonly'}
        placeholder="cmots" ${canEdit ? '' : 'disabled'}>
      <p class="hint">${isNew
        ? 'Lowercase, no spaces. Never shown to a consumer.'
        : 'Fixed. It is the key every endpoint, credential and audit row points at.'}</p></div>

    <div class="f"><label for="vendor_name">Supplied by</label>
      <input id="vendor_name" name="vendor_name" value="${esc(a.vendor_name || '')}"
        placeholder="Capital Market Online" ${canEdit ? '' : 'disabled'}>
      <p class="hint">The company behind the API.</p></div>

    <div class="f"><label for="owner">Owner</label>
      <input id="owner" name="owner" value="${esc(a.owner || '')}"
        placeholder="Market Data Team" ${canEdit ? '' : 'disabled'}>
      <p class="hint">Who here is answerable for it.</p></div>

    <div class="f"><label for="base_url">Base URL</label>
      <input id="base_url" name="base_url" value="${esc(a.base_url || '')}"
        placeholder="https://ashikastockapis.cmots.com" ${isNew ? 'required' : ''}
        ${canEdit ? '' : 'disabled'}>
      <p class="hint">Scheme and host only. Each endpoint adds its own path.</p></div>

    <div class="f"><label for="timeout_ms">Timeout (ms)</label>
      <input id="timeout_ms" name="timeout_ms" type="number" min="100" max="120000"
        value="${esc(String(a.timeout_ms || 15000))}" ${canEdit ? '' : 'disabled'}>
      <p class="hint">How long the gateway waits for this supplier. A large master
        list commonly needs 60000; a consumer's call fails at this limit too.</p></div>
  </div>
  <div class="f"><label for="notes">Notes</label>
    <textarea id="notes" name="notes" rows="2" ${canEdit ? '' : 'disabled'}
      placeholder="Contract reference, rate limits agreed, anything the next person needs.">${esc(a.notes || '')}</textarea></div>`)}

  ${panel('Who to tell when it breaks',
    'Alerts about this application go to these addresses. Faults with the gateway itself — its database, its audit queue — belong to no application and go to the console-level list in Admin config instead.', `
  <div class="f" id="alerts">
    <label for="alert_emails">Alert recipients</label>
    <textarea id="alert_emails" name="alert_emails" rows="3" ${canEdit ? '' : 'disabled'}
      placeholder="ops@ashikagroup.com&#10;marketdata@ashikagroup.com">${esc(emails)}</textarea>
    <p class="hint">One per line, or separated by commas or semicolons — paste from
      Outlook or a spreadsheet and it will sort itself out. Each address is checked
      before saving, because a typo here fails silently during the incident it
      existed for.</p>
  </div>
  <label class="chk"><input type="checkbox" name="alerts_enabled" value="1"
    ${a.alerts_enabled === false ? '' : 'checked'} ${canEdit ? '' : 'disabled'}>
    <span>Send alerts for this application</span></label>
  <p class="hint">Unticking keeps the list but stops the mail — for a supplier in
    planned maintenance, so nobody deletes the recipients and forgets to put them back.</p>`)}

  ${canEdit ? `<div class="formacts">
    <button type="submit" class="primary">${isNew ? 'Add application' : 'Save changes'}</button>
    <a class="btn" href="/admin/applications">Cancel</a>
  </div>` : ''}
</form>

${isNew ? '' : `
${tablePanel('Endpoints served from this application',
  'Built in the Studio. Deactivating the application withdraws every live one here.',
  '<th class="num">#</th><th>Endpoint</th><th>Path</th><th>Status</th><th></th>',
  endpoints.map((e, i) => `<tr>
    <td class="num t2">${i + 1}</td>
    <td><div class="t1">${esc(e.display_name)}</div><div class="t2 mono">${esc(e.name)}</div></td>
    <td class="mono t2">${esc(e.method)} ${esc(e.path)}</td>
    <td>${e.status === 'live' && e.enabled ? pill('good', 'live')
      : e.status === 'draft' ? pill('warning', 'draft') : pill('warning', 'withdrawn')}</td>
    <td class="actions"><a class="btn" href="/admin/catalog/${esc(e.name)}">Open</a></td>
  </tr>`).join('') ||
  '<tr><td colspan="5" class="empty">No endpoints yet. Build one in the Studio.</td></tr>',
  endpoints.length)}

${canEdit ? panel(a.enabled ? 'Stop serving this application' : 'Resume serving this application',
  '', a.enabled ? `
  <p class="danger-why">Deactivating withdraws <strong>${fmtNum(liveEps.length)} live
    endpoint${liveEps.length === 1 ? '' : 's'}</strong> at the next config reload${
      liveEps.length ? ` — ${liveEps.slice(0, 6).map((e) => `<span class="mono">${esc(e.name)}</span>`).join(', ')}${
        liveEps.length > 6 ? ` and ${liveEps.length - 6} more` : ''}` : ''}.
    Consumers calling ${liveEps.length === 1 ? 'it' : 'them'} will get a 404.</p>
  <p class="danger-why">Nothing is deleted. The endpoints, the credential and the
    whole audit trail stay exactly as they are, and reactivating restores service.
    <strong>There is no delete</strong> — this reference is the key every endpoint,
    credential and audit row points at, so removing the row would orphan them rather
    than clean anything up.</p>
  <form method="post" action="/admin/applications/${esc(a.name)}/deactivate" class="deact">
    <div class="f"><label for="reason">Why (recorded in the change log)</label>
      <input id="reason" name="reason" required
        placeholder="Contract ended 31 Mar — replaced by direct feed"></div>
    <button type="submit" class="danger"
      data-confirm="Deactivate ${esc(a.display_name)}? This withdraws ${fmtNum(liveEps.length)} live endpoint(s) and consumers calling them will get a 404. Nothing is deleted and you can reactivate at any time.">
      Deactivate</button>
  </form>` : `
  <p class="danger-why">Reactivating restores ${fmtNum(a.endpoints)} endpoint(s) to
    whatever status they held. Anything that was live will start answering again at
    the next config reload.</p>
  <form method="post" action="/admin/applications/${esc(a.name)}/activate">
    <button type="submit" class="primary"
      data-confirm="Reactivate ${esc(a.display_name)}? Endpoints that were live will start answering again.">
      Reactivate</button>
  </form>`) : ''}
`}

<style>${CSS}</style>`;

  return layout({
    title: isNew ? 'Add an application' : a.display_name,
    admin, current: '/admin/applications', body, flash,
  });
}

const CSS = `
.appform{margin:0}
.appform .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.appform .f{margin-bottom:12px}
.appform label{display:block;font-size:11px;font-weight:600;color:var(--ink2);margin-bottom:4px}
.appform input,.appform textarea{width:100%;font:inherit;font-size:12.5px;padding:7px 9px;
  border:1px solid var(--border);border-radius:var(--r);background:var(--surface);
  color:var(--ink)}
.appform input:disabled,.appform textarea:disabled{background:var(--surface2);color:var(--ink3)}
.appform input[readonly]{background:var(--surface2);color:var(--ink2)}
.appform textarea{resize:vertical;font-family:var(--mono);font-size:12px}
.appform .hint{margin:4px 0 0;font-size:11px;color:var(--ink3);line-height:1.45}
.chk{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink);margin-top:4px}
.chk input{width:auto}
.formacts{display:flex;gap:9px;margin:14px 0 18px}
.danger-why{font-size:12.5px;color:var(--ink2);line-height:1.6;margin:0 0 10px;max-width:80ch}
.deact .f{max-width:520px;margin-bottom:10px}
.deact label{display:block;font-size:11px;font-weight:600;color:var(--ink2);margin-bottom:4px}
.deact input{width:100%;font:inherit;font-size:12.5px;padding:7px 9px;
  border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--ink)}
button.danger{background:var(--red);border-color:var(--red);color:#fff;font-weight:600}
button.danger:hover{filter:brightness(1.08)}
tr.off td{opacity:.72}
.t3{color:var(--ink3)}
.alerts{display:grid;gap:8px;margin-bottom:14px}
.al{display:flex;gap:10px;align-items:flex-start;background:var(--surface2);
  border:1px solid var(--border);border-radius:var(--r);padding:10px 13px;
  font-size:12.5px;color:var(--ink);line-height:1.55}
.dot.warning{display:inline-block;width:7px;height:7px;border-radius:50%;background:#fab219;
  flex:none;margin-top:6px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:500;
  border:1px solid var(--border);border-radius:999px;padding:2px 10px 2px 8px;color:var(--ink2);
  background:var(--surface2);white-space:nowrap}
.pill .dot{width:7px;height:7px;border-radius:50%;flex:none}
.pill.good .dot{background:#0ca30c}
.pill.warning .dot{background:#fab219}
`;

module.exports = { applicationsPage, applicationPage };
