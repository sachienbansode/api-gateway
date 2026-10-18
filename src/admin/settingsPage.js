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
/**
 * The Mail panel.
 *
 * Modelled on the platform's own Settings → Email (SMTP) screen, deliberately:
 * the same quick-setup chips, the same "leave blank to keep existing" on the
 * password, the same Test Connection beside Save. Somebody who configures mail
 * on the platform should not have to work out a different screen here.
 *
 * Two differences, both on purpose. The certificate checkbox is phrased as
 * what it costs rather than as a neutral toggle, because unticking it silently
 * removes the protection TLS was there to give. And the test result is shown
 * as a state with a timestamp, so the screen can answer "does this work"
 * without anyone pressing anything.
 */
/**
 * Single sign-on through the Ashika Portal.
 *
 * Two panels, because they answer two different questions: where the portal
 * is, and what its roles mean here. Keeping them in one form would mean a
 * typo in a role mapping blocks a URL correction from saving.
 *
 * The client secret is write-only. There is no reveal here and no masked
 * value — the box is blank, blank means keep, and clearing is its own button.
 * A settings screen that can show a secret is a settings screen that leaks one
 * the first time somebody screenshots it for a ticket.
 */
function ssoPanel(sso, roles, canEdit) {
  const s = sso || {};
  const insecure = s.base_url && !/^https:/i.test(s.base_url);

  const state = !s.enabled
    ? `<span class="badge mute">off</span>`
    : s.test_status === 'ok'
      ? `<span class="badge ok">on, portal reachable</span>`
      : s.test_status === 'failed'
        ? `<span class="badge off">on, last test failed</span>`
        : `<span class="badge warn">on, not tested</span>`;

  const secretState = s.secret_stored
    ? `<span class="badge ok">stored <span style="text-transform:none">${
        esc('••••' + String(s.secret_hint || ''))}</span></span>`
    : s.use_pkce
      ? `<span class="badge ok">not needed — using PKCE</span>`
      : `<span class="badge warn">not set</span>`;

  const settings = panel(
    'Ashika Portal',
    'Where people sign in. The portal proves who somebody is; the role mapping below decides what they may do here.',
    `<form method="post" action="/admin/settings/sso">
  <p class="hint" style="margin:0 0 12px">${state}
    ${s.last_tested_at ? ` Last tested ${fmtDate(s.last_tested_at)}.` : ''}
    ${s.test_status === 'failed' && s.test_error
      ? `<br><span style="color:var(--red)">${esc(s.test_error)}</span>` : ''}</p>

  ${insecure ? `<p class="warnbox">This portal URL is plain <span class="mono">http://</span>.
    The authorization code and the access token cross the network in clear, and anyone who can
    read that traffic can become an administrator of this gateway. Acceptable for a staging
    portal on an internal network — it must not reach production.</p>` : ''}

  <div class="fields">
    <div class="f"><label for="sso_base">Portal URL</label>
      <input id="sso_base" name="base_url" value="${esc(s.base_url || '')}"
        placeholder="https://portal.ashikagroup.com/api/sso" ${canEdit ? '' : 'disabled'}>
      <p class="hint">The base. <span class="mono">/authorize</span>,
        <span class="mono">/token</span>, <span class="mono">/userinfo</span> and
        <span class="mono">/profile</span> hang off it.</p></div>

    <div class="f"><label for="sso_client">Client ID</label>
      <input id="sso_client" name="client_id" value="${esc(s.client_id || '')}"
        placeholder="pravah-api-gateway" ${canEdit ? '' : 'disabled'}>
      <p class="hint">As registered with the portal.</p></div>

    <div class="f"><label for="sso_redirect">Redirect URI</label>
      <input id="sso_redirect" name="redirect_uri" value="${esc(s.redirect_uri || '')}"
        placeholder="https://pravah.ashikagroup.com/api/auth/central/callback"
        ${canEdit ? '' : 'disabled'}>
      <p class="hint">Must match what the portal registered <strong>exactly</strong> —
        scheme, port and trailing slash included. A mismatch here is the most common
        reason an SSO integration fails, usually with an unhelpful error. The portal's
        External Applications screen shows the registered value; copy it from there
        rather than typing it.</p></div>

    <div class="f"><label for="sso_secret">Client secret ${secretState}</label>
      <input id="sso_secret" name="client_secret" type="password" autocomplete="new-password"
        placeholder="${s.secret_stored ? 'leave blank to keep the stored one' : 'paste it here'}"
        ${canEdit ? '' : 'disabled'}>
      <p class="hint">Sealed with the same key as the supplier credentials and never
        shown again. Blank means keep.
        ${s.secret_stored && canEdit
          ? ` <button type="submit" formaction="/admin/settings/sso/secret/clear"
                class="linkbtn" data-confirm="Forget the stored client secret?"
                data-confirm-body="Sign-in through the portal will stop working until a new one is saved.">Forget it</button>`
          : ''}</p></div>
  </div>

  <label class="chk"><input type="checkbox" name="use_pkce" value="1"
    ${s.use_pkce ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
    <span>This is a public client — use PKCE instead of a secret</span></label>

  <label class="chk"><input type="checkbox" name="allow_insecure" value="1"
    ${s.allow_insecure ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
    <span>Allow a plain <span class="mono">http://</span> portal (staging only)</span></label>

  <label class="chk"><input type="checkbox" name="enabled" value="1"
    ${s.enabled ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
    <span>Offer "Sign in with Ashika Portal" on the sign-in page</span></label>
  <p class="hint">Password sign-in keeps working either way. Leave it on until the
    portal has signed somebody in successfully — if SSO is the only door and the
    portal is misconfigured, nobody can reach this screen to fix it.</p>

  <div class="formfoot">
    <button type="submit" class="primary"${canEdit ? '' : ' disabled'}>Save</button>
    <button type="submit" formaction="/admin/settings/sso/test"
      ${canEdit ? '' : 'disabled'}>Test the portal</button>
    <p class="hint">Test saves first, then calls the portal <strong>from this
      server</strong> — the only machine that can reach it — and reports what each
      endpoint returned. Field names only, never values.</p>
  </div>
</form>`
  );

  const rows = roles.map((r) => `<tr>
    <td class="t1">${esc(r.portal_role)}</td>
    <td><span class="badge ${r.level === 'none' ? 'off' : r.level === 'view' ? 'mute' : 'ok'}">${esc(r.level)}</span></td>
    <td class="t2">${esc(r.notes || '')}</td>
    <td class="actions">${canEdit ? `<form method="post" action="/admin/settings/sso/role/remove" class="inline">
      <input type="hidden" name="portal_role" value="${esc(r.portal_role)}">
      <button type="submit" class="linkbtn"
        data-confirm="Unmap ${esc(r.portal_role)}?"
        data-confirm-body="Anyone whose portal role is ${esc(r.portal_role)} will be refused, and told that their role has no access here.">Remove</button>
    </form>` : ''}</td></tr>`).join('');

  const mapping = panel(
    'What a portal role means here',
    'The portal says who somebody is. This says what they may do. A role with no row here is refused and told so by name.',
    `<div class="wrap"><table>
  <thead><tr><th>Portal role</th><th>Access here</th><th>Notes</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4" class="empty">No roles mapped. Nobody could sign in through the portal.</td></tr>'}</tbody>
</table></div>
${canEdit ? `<form method="post" action="/admin/settings/sso/role" class="addrole">
  <div class="f"><label for="pr">Portal role</label>
    <input id="pr" name="portal_role" required placeholder="API Admin"></div>
  <div class="f"><label for="pl">Access here</label>
    <select id="pl" name="level">
      <option value="view">view — read every screen, change nothing</option>
      <option value="edit">edit — change the catalogue, applications and settings</option>
      <option value="admin">admin — edit, plus the audited credential reveal</option>
      <option value="none">none — recognised, but refused</option>
    </select></div>
  <div class="f"><label for="pn">Notes</label>
    <input id="pn" name="notes" placeholder="optional"></div>
  <div class="f acts"><button type="submit" class="primary">Add or update</button></div>
</form>` : ''}`
  );

  const probe = s.test_detail
    ? panel('What the portal returned', 'From the last test. Field names and types only — never a value.',
        `<pre class="probe">${esc(JSON.stringify(s.test_detail, null, 2))}</pre>`)
    : '';

  return settings + mapping + probe;
}

function mailPanel(mail, canEdit) {
  const m = mail || {};
  const tested = m.test_status === 'ok'
    ? `<span class="badge ok">connected</span>`
    : m.test_status === 'failed'
      ? `<span class="badge off">last test failed</span>`
      : `<span class="badge mute">not tested</span>`;

  // text-transform:none on the hint: labels on this screen are uppercased, and
  // a hint is the last four characters of a real password. Shown in capitals
  // it is not the hint — it is four different characters, and someone checking
  // which password is in place would be comparing against the wrong thing.
  const pwState = m.password_stored
    ? `<span class="badge ok">stored <span style="text-transform:none">${
        esc(String(m.password_hint || '••••').replace(/^\*{4}/, '••••'))}</span></span>`
    : `<span class="badge warn">not set</span>`;

  return panel(
    'Mail',
    'Where sign-in codes are sent from. Only needed for accounts whose role requires a second factor.',
    `<form method="post" action="/admin/settings/mail">
  <p class="hint" style="margin:0 0 12px">${tested}
    ${m.last_tested_at ? ` Last tested ${fmtDate(m.last_tested_at)}.` : ''}
    ${m.test_status === 'failed' && m.test_error ? `<br><span style="color:var(--red)">${esc(m.test_error)}</span>` : ''}
  </p>

  <div class="tools" style="margin-bottom:12px">
    <span class="n">Quick setup:</span>
    ${[
      ['Microsoft 365', 'smtp.office365.com', 587],
      ['Gmail', 'smtp.gmail.com', 587],
      ['SendGrid', 'smtp.sendgrid.net', 587],
      ['AWS SES', 'email-smtp.ap-south-1.amazonaws.com', 587],
    ].map(([label, host, port]) =>
      `<button type="button" class="preset" data-host="${esc(host)}" data-port="${port}">${esc(label)}</button>`
    ).join('')}
  </div>

  <div class="fields">
    <div class="f"><label for="m_host">SMTP host</label>
      <input id="m_host" name="host" value="${esc(m.host || '')}" spellcheck="false"
             placeholder="smtp.office365.com"></div>
    <div class="f"><label for="m_port">Port</label>
      <input id="m_port" name="port" type="number" min="1" max="65535"
             value="${esc(m.port || 587)}"></div>

    <div class="f"><label for="m_user">Username</label>
      <input id="m_user" name="username" value="${esc(m.username || '')}" spellcheck="false"
             placeholder="it.notifications@ashikagroup.com">
      <p class="hint">Leave blank for a relay that accepts this server without a login.</p></div>
    <div class="f"><label for="m_pass">Password ${pwState}</label>
      <input id="m_pass" name="password" type="password" autocomplete="new-password"
             placeholder="Leave blank to keep existing" spellcheck="false">
      <p class="hint">Encrypted with the same key as the supplier credentials. Never shown again.</p></div>

    <div class="f"><label for="m_from">From address</label>
      <input id="m_from" name="fromEmail" type="email" value="${esc(m.from_email || '')}"
             spellcheck="false" placeholder="no-reply@ashikagroup.com"></div>
    <div class="f"><label for="m_fromname">From name</label>
      <input id="m_fromname" name="fromName" value="${esc(m.from_name || 'Ashika - Pravah')}"></div>

    <div class="f" style="grid-column:span 2">
      <label class="chk"><input type="checkbox" name="secure" value="1"
        ${m.secure ? 'checked' : ''}> Implicit TLS (port 465)</label>
      <p class="hint">Leave off for port 587, which upgrades the connection with STARTTLS.
        Setting 465 without this hangs until the timeout rather than failing clearly.</p>
    </div>

    <div class="f" style="grid-column:span 2">
      <label class="chk"><input type="checkbox" name="rejectUnauthorized" value="1"
        ${m.reject_unauthorized === false ? '' : 'checked'}> Verify the mail server's certificate</label>
      <p class="hint">Leave this on. Unticking it means any certificate is accepted, so the
        connection is encrypted but not authenticated — which is exactly what someone in the
        middle needs. Only turn it off for an internal relay with a self-signed certificate,
        and prefer trusting that certificate instead.</p>
    </div>
  </div>

  <div class="formfoot">
    <button type="submit" class="primary"${canEdit ? '' : ' disabled'}
      data-confirm="Save the mail settings?"
      data-confirm-body="Sign-in codes will be sent through this server. The last test result is cleared, because it described the settings you are replacing.">Save</button>
    <button type="submit" formaction="/admin/settings/mail/test"${canEdit ? '' : ' disabled'}>Test connection</button>
    <p class="hint">Test sends nothing — it opens the connection, authenticates and hangs up.</p>
  </div>
</form>`
  );
}

function render({ admin, flash, settings, history, mail, sso, ssoRoles }) {
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

<div class="tabs" role="tablist">
  <button type="button" role="tab" data-tab="general" aria-selected="true">General</button>
  <button type="button" role="tab" data-tab="mail" aria-selected="false">Mail</button>
  <button type="button" role="tab" data-tab="sso" aria-selected="false">Single sign-on</button>
  <button type="button" role="tab" data-tab="secrets" aria-selected="false">Kept in the env file</button>
  <button type="button" role="tab" data-tab="history" aria-selected="false">Change history</button>
</div>

<section class="tabpane" id="tab-general">
<form method="post" action="/admin/settings">
  ${panel('Consumer-facing', '', `<div class="fields">${fields}</div>
    <div class="formfoot">
      <button type="submit" class="primary"${admin.canEdit ? '' : ' disabled'}
        data-confirm="Save these settings?"
        data-confirm-body="The public base URL appears in every Postman collection and in the API documentation partners work from. Changing it does not move the gateway — it changes what consumers are told to call.">Save</button>
      <p class="hint">A blank field falls back to the environment, which is what a fresh
        deployment uses.</p>
    </div>`)}
</form>
</section>

<section class="tabpane hidden" id="tab-mail">
${mailPanel(mail, admin.canEdit)}
</section>

<section class="tabpane hidden" id="tab-sso">
${ssoPanel(sso, ssoRoles || [], admin.canEdit)}
</section>

<section class="tabpane hidden" id="tab-secrets">
${panel('Kept in /etc/api-gateway/env, deliberately', '', `
  <dl class="cfg">
    <dt>GW_SECRET_KEY</dt>
      <dd>Decrypts every stored supplier credential, and the mail password. In the database
          it would be a lock taped to its own door — a dump would contain both.</dd>
    <dt>GW_DATABASE_URL · AUTH_DATABASE_URL</dt>
      <dd>How to reach this table. It cannot configure itself.</dd>
    <dt>JWT_SECRET</dt>
      <dd>What proves an admin session is genuine. An attacker who could edit it from a
          console could mint their own session.</dd>
    <dt>Supplier tokens</dt>
      <dd>In the database, but encrypted and never shown in full — see a supplier in the
          <a href="/admin/catalog/upstreams">catalogue</a>.</dd>
  </dl>`)}
</section>

<section class="tabpane hidden" id="tab-history">
${tablePanel('Change history', 'Every settings change, who made it, and what it was before.',
  '<th>When</th><th>Setting</th><th>Was</th><th>Became</th><th>By</th>', historyRows)}
</section>

<script>
// Quick setup only fills the host and port. It deliberately does not touch the
// username or the from-address: those are this organisation's, not the
// provider's, and overwriting what somebody typed would be rude.
/* Tabs.
   The chosen tab goes in the URL hash, so a link to Admin config can land
   somebody on Mail directly and a reload after saving does not throw them back
   to General — which is exactly when they want to look at what they just
   changed. */
(function () {
  var tabs = document.querySelectorAll('[role=tab]');
  function show(name, push) {
    var found = false;
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === name;
      if (on) found = true;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      var pane = document.getElementById('tab-' + t.getAttribute('data-tab'));
      if (pane) pane.classList[on ? 'remove' : 'add']('hidden');
    });
    if (found && push && history.replaceState) history.replaceState(null, '', '#' + name);
    return found;
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { show(t.getAttribute('data-tab'), true); });
  });
  // A flash message always belongs to a save, and every save here is a form in
  // one specific tab. Landing on General with a green bar about mail settings
  // is confusing, so the hash wins and the default is General.
  function fromHash() {
    var want = (location.hash || '').replace('#', '');
    if (!want || !show(want, false)) show('general', false);
  }
  fromHash();
  // Moving between hashes on the same page is NOT a page load, so without
  // this the back button leaves the URL saying one tab and the screen showing
  // another — and a link to #mail from somewhere already on this page does
  // nothing at all.
  window.addEventListener('hashchange', fromHash);
})();

document.querySelectorAll('.preset').forEach(function (b) {
  b.addEventListener('click', function () {
    document.getElementById('m_host').value = b.getAttribute('data-host');
    document.getElementById('m_port').value = b.getAttribute('data-port');
    document.querySelector('input[name=secure]').checked = b.getAttribute('data-port') === '465';
  });
});
</script>

<style>
.tabs{display:flex;gap:2px;margin-bottom:14px;border-bottom:1px solid var(--border);
  flex-wrap:wrap}
.tabs button{padding:8px 14px;font-size:12.5px;font-family:inherit;color:var(--ink3);
  background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;
  cursor:pointer;border-radius:0}
.tabs button:hover{color:var(--ink);background:none}
.tabs button[aria-selected=true]{color:var(--ink);font-weight:600;border-bottom-color:var(--gold)}
.tabpane.hidden{display:none}
.chk{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:400;
  text-transform:none;letter-spacing:0;color:var(--ink);cursor:pointer}
.chk input{width:auto;margin:0}
.preset{font-size:11.5px;padding:5px 10px}

/* ---------- single sign-on ---------- */
/* Amber, not red: a staging portal on plain HTTP is a decision somebody made,
   not a fault. Red here would be indistinguishable from a real failure. */
.warnbox{background:var(--surface2);border:1px solid var(--border);
  border-left:3px solid #fab219;border-radius:var(--r);padding:10px 13px;
  margin:0 0 14px;font-size:12px;color:var(--ink2);line-height:1.55;
  text-transform:none;letter-spacing:0;font-weight:400}
.linkbtn{background:none;border:0;padding:0;color:var(--blue);font-size:inherit;
  font-family:inherit;cursor:pointer;text-decoration:underline;width:auto}
.linkbtn:hover{background:none;color:var(--ink)}
form.inline{display:inline;margin:0}
.addrole{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-top:14px;
  padding-top:14px;border-top:1px solid var(--border)}
.addrole .f{margin:0;flex:1;min-width:150px}
.addrole .acts{flex:none}
.probe{max-height:420px;overflow:auto;font-size:11px;line-height:1.5;margin:0}
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
