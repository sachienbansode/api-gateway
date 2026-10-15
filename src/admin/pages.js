'use strict';

const { esc, layout, pageHead, panel, tablePanel, fmtDate, fmtNum } = require('./ui');

/**
 * The admin screens.
 *
 * Endpoints are deliberately READ-ONLY. They are declared in
 * config/endpoints.yaml, reviewed as a git diff, and validated by
 * `npm run validate` before a deploy restarts anything. That review step is the
 * security model: a change to which fields a vendor can see should be
 * something a person approved, not something a form submitted. The screen
 * shows exactly what is exposed so it can be audited without reading YAML.
 */

const EMPTY = (cols, text) => `<tr><td colspan="${cols}" class="empty">${text}</td></tr>`;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function overview({ admin, flash, cfg, vendors, health, usage }) {
  const whitelisted = cfg.endpoints.filter((e) => e.response.mode === 'whitelist').length;
  const unfiltered = cfg.endpoints.length - whitelisted;
  const liveKeys = vendors.reduce((n, v) => n + Number(v.live_keys || 0), 0);
  const calls = usage.reduce((n, r) => n + Number(r.calls || 0), 0);
  const errors = usage.reduce((n, r) => n + Number(r.errors || 0), 0);
  const active = vendors.filter((v) => v.enabled).length;

  const stat = (label, value, cls = '') =>
    `<div class="stat ${cls}"><div class="l">${esc(label)}</div><div class="n">${value}</div></div>`;

  const db = health.database || {};
  const dbPill = !db.enabled
    ? '<span class="badge warn">not configured</span>'
    : db.ok
      ? `<span class="badge ok">connected · ${esc(db.latencyMs)}ms</span>`
      : '<span class="badge off">unreachable</span>';

  const dropped = Number(health.audit?.dropped || 0);

  const breakerRows = Object.entries(health.upstreams || {})
    .map(
      ([name, b]) =>
        `<tr><td>Upstream <span class="mono">${esc(name)}</span></td>
         <td class="actions">${
           b.state === 'open'
             ? '<span class="badge off">breaker open</span>'
             : `<span class="badge ok">${esc(b.state)}</span>`
         }</td></tr>`
    )
    .join('');

  const exposure = `
<table>
  <tbody>
    <tr><td><strong>Whitelisted</strong><div class="t2">Response built field by field from an explicit list</div></td>
        <td class="num">${whitelisted}</td>
        <td class="actions">${
          cfg.endpoints.length > 0 && whitelisted === cfg.endpoints.length
            ? '<span class="badge ok">every endpoint filtered</span>'
            : '<span class="badge mute">—</span>'
        }</td></tr>
    <tr><td><strong>Redact or passthrough</strong><div class="t2">Forwards what the upstream returned, minus exclusions</div></td>
        <td class="num">${unfiltered}</td>
        <td class="actions">${
          unfiltered > 0
            ? '<span class="badge warn">not protected against upstream change</span>'
            : '<span class="badge ok">none</span>'
        }</td></tr>
    <tr><td><strong>Reachable by no vendor</strong><div class="t2">No enabled vendor holds the required scopes</div></td>
        <td class="num">${cfg.unreachable.length}</td>
        <td class="actions">${
          cfg.unreachable.length
            ? `<span class="badge warn">${cfg.unreachable.map(esc).join(', ')}</span>`
            : '<span class="badge ok">none</span>'
        }</td></tr>
  </tbody>
</table>`;

  const deps = `
<table>
  <tbody>
    <tr><td><strong>Gateway database</strong></td><td class="actions">${dbPill}</td></tr>
    <tr><td><strong>Vendor keys</strong></td>
        <td class="actions"><span class="badge mute">${esc(health.vendorStore?.source || 'unknown')}</span></td></tr>
    <tr><td><strong>Audit queue</strong></td>
        <td class="actions">${
          dropped > 0
            ? `<span class="badge off">${fmtNum(dropped)} dropped</span>`
            : `<span class="badge ok">${fmtNum(health.audit?.written ?? 0)} written</span>`
        }</td></tr>
    ${breakerRows}
  </tbody>
</table>`;

  const body = `
${pageHead('Overview', 'What this gateway is exposing right now.')}
<div class="stats">
  ${stat('Endpoints', cfg.endpoints.length)}
  ${stat('Vendors', `${active}<small> / ${vendors.length}</small>`)}
  ${stat('Live keys', liveKeys)}
  ${stat('Calls · 30d', fmtNum(calls))}
  ${stat('Errors · 30d', fmtNum(errors), errors > 0 ? 'alert' : 'good')}
</div>
<section class="panel">
  <div class="ph"><h3>Exposure</h3></div>
  <p class="note">The number that matters: how many endpoints build their response from an
    explicit field whitelist, rather than forwarding whatever the upstream returned.</p>
  <div class="wrap">${exposure}</div>
</section>
<section class="panel">
  <div class="ph"><h3>Dependencies</h3></div>
  <div class="wrap">${deps}</div>
</section>`;

  return layout({ title: 'Overview', admin, current: '/admin', body, flash });
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

function vendorsPage({ admin, flash, vendors, cfg, issuedKey, scopes }) {
  const allScopes = [...scopes].sort();

  const rows = vendors.length
    ? vendors
        .map(
          (v) => `<tr>
  <td><div class="t1 mono">${esc(v.id)}</div><div class="t2">${esc(v.name || '')}</div></td>
  <td>${v.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge off">disabled</span>'}</td>
  <td><div class="badges">${
    (v.scopes || []).length
      ? (v.scopes || []).map((s) => `<span class="badge mute mono">${esc(s)}</span>`).join('')
      : '<span class="badge warn">no scopes — cannot call anything</span>'
  }</div></td>
  <td class="num">${v.live_keys}</td>
  <td class="num">${v.monthly_quota ? fmtNum(v.monthly_quota) : '∞'}</td>
  <td class="t2">${fmtDate(v.last_used_at)}</td>
  <td class="actions">
    <a class="btn" href="/admin/vendors/${encodeURIComponent(v.id)}">Keys</a>
    ${
      admin.canEdit
        ? `<form class="inline" method="post" action="/admin/vendors/${encodeURIComponent(v.id)}/toggle">
             <button type="submit">${v.enabled ? 'Disable' : 'Enable'}</button></form>`
        : ''
    }
  </td>
</tr>`
        )
        .join('')
    : EMPTY(7, 'No vendors yet. Add one below, then issue it a key.');

  const scopeChecks = allScopes.length
    ? `<div class="checks">${allScopes
        .map(
          (s) =>
            `<label><input type="checkbox" name="scopes" value="${esc(s)}"><span class="mono">${esc(s)}</span></label>`
        )
        .join('')}</div>`
    : `<p class="note" style="margin:0">No scopes declared yet. Add endpoints to
       <strong>config/endpoints.yaml</strong> and deploy — their scopes appear here.</p>`;

  const addForm = admin.canEdit
    ? panel(
        'Add or update a vendor',
        'Using an existing id updates that vendor rather than creating a second one.',
        `<form method="post" action="/admin/vendors">
  <div class="fields">
    <div class="f"><label for="id">Vendor id</label>
      <input id="id" name="id" type="text" required pattern="[a-z0-9][a-z0-9_-]*" placeholder="acme">
      <p class="hint">Lower case, no spaces. Appears in the audit log.</p></div>
    <div class="f"><label for="name">Display name</label>
      <input id="name" name="name" type="text" placeholder="Acme Logistics">
      <p class="hint">For your reference only.</p></div>
    <div class="f"><label for="quota">Monthly quota</label>
      <input id="quota" name="monthlyQuota" type="number" min="1" placeholder="unlimited">
      <p class="hint">Calls per calendar month, UTC.</p></div>
    <div class="f"><label for="rateMax">Rate limit</label>
      <input id="rateMax" name="rateMax" type="number" min="1" placeholder="600">
      <p class="hint">Requests per minute.</p></div>
  </div>
  <fieldset>
    <legend>Scopes</legend>
    ${scopeChecks}
    <p class="hint" style="color:var(--muted);font-size:12.5px;margin-top:10px">
      A vendor reaches only the endpoints whose scopes it holds. No scopes means no access.</p>
  </fieldset>
  <div class="formfoot">
    <button class="primary" type="submit">Save vendor</button>
    <span class="hint">Takes effect within 30 seconds — auth is kept off the database hot path.</span>
  </div>
</form>`
      )
    : '';

  const keyBox = issuedKey
    ? `<div class="flash ok"><strong>API key issued for ${esc(issuedKey.vendorId)}.</strong>
       Copy it now — only the SHA-256 hash is stored, so it cannot be shown again.
       <div class="key">${esc(issuedKey.key)}</div></div>`
    : '';

  const body = `
${pageHead('Vendors', 'Who may call this gateway, what they may reach, and with which keys.')}
${keyBox}
${tablePanel(
  'All vendors',
  '',
  `<th>Vendor</th><th>Status</th><th>Scopes</th><th class="num">Keys</th>
   <th class="num">Quota</th><th>Last used</th><th></th>`,
  rows
)}
${addForm}`;

  return layout({ title: 'Vendors', admin, current: '/admin/vendors', body, flash });
}

function vendorKeysPage({ admin, flash, vendorId, keys, issuedKey }) {
  const now = Date.now();
  const rows = keys.length
    ? keys
        .map((k) => {
          const revoked = !!k.revoked_at;
          const expired = k.expires_at && new Date(k.expires_at).getTime() < now;
          const state = revoked
            ? '<span class="badge off">revoked</span>'
            : expired
              ? '<span class="badge warn">expired</span>'
              : '<span class="badge ok">live</span>';
          return `<tr>
  <td class="mono">${esc(String(k.key_hash).slice(0, 20))}…</td>
  <td>${esc(k.label || '—')}</td>
  <td>${state}</td>
  <td class="t2">${fmtDate(k.created_at)}</td>
  <td class="t2">${fmtDate(k.last_used_at)}</td>
  <td class="actions">${
    !revoked && admin.canEdit
      ? `<form class="inline" method="post" action="/admin/vendors/${encodeURIComponent(vendorId)}/keys/revoke">
           <input type="hidden" name="keyHash" value="${esc(k.key_hash)}">
           <button class="danger" type="submit">Revoke</button></form>`
      : ''
  }</td>
</tr>`;
        })
        .join('')
    : EMPTY(6, 'No keys issued yet.');

  const keyBox = issuedKey
    ? `<div class="flash ok"><strong>New API key.</strong> Copy it now — only the SHA-256 hash
       is stored, so it cannot be shown again.<div class="key">${esc(issuedKey)}</div></div>`
    : '';

  const issueForm = admin.canEdit
    ? panel(
        'Issue a new key',
        'Issue the new key, let the vendor cut over, then revoke the old one. No downtime.',
        `<form method="post" action="/admin/vendors/${encodeURIComponent(vendorId)}/keys">
  <div class="fields">
    <div class="f"><label for="label">Label</label>
      <input id="label" name="label" type="text" placeholder="rotation 2026-10">
      <p class="hint">For your records. Never sent to the vendor.</p></div>
  </div>
  <div class="formfoot"><button class="primary" type="submit">Issue key</button>
    <span class="hint">Shown once, then only its hash is kept.</span></div>
</form>`
      )
    : '';

  const body = `
${pageHead(
  `Keys · ${esc(vendorId)}`,
  'Only the SHA-256 hash of each key is stored, so a database dump yields nothing usable.',
  '<a class="btn" href="/admin/vendors">← All vendors</a>'
)}
${keyBox}
${tablePanel(
  'Keys',
  'Revocation takes up to 30 seconds to apply.',
  '<th>Hash</th><th>Label</th><th>State</th><th>Issued</th><th>Last used</th><th></th>',
  rows
)}
${issueForm}`;

  return layout({ title: `Keys · ${vendorId}`, admin, current: '/admin/vendors', body, flash });
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

function endpointsPage({ admin, flash, cfg }) {
  const rows = cfg.endpoints.length
    ? cfg.endpoints
        .map((e) => {
          const mode =
            e.response.mode === 'whitelist'
              ? '<span class="badge ok">whitelist</span>'
              : e.response.mode === 'redact'
                ? '<span class="badge warn">redact</span>'
                : '<span class="badge off">passthrough</span>';
          const fields =
            e.response.mode === 'whitelist'
              ? `<div class="badges">${(e.response.fields || [])
                  .map((f) => `<span class="badge mute mono">${esc(f)}</span>`)
                  .join('')}</div>`
              : e.response.mode === 'redact'
                ? `<div class="t2">everything except</div><div class="badges">${(e.response.exclude || [])
                    .map((f) => `<span class="badge warn mono">${esc(f)}</span>`)
                    .join('')}</div>`
                : '<span class="badge off">the entire upstream response</span>';
          return `<tr>
  <td><div class="t1 mono">${esc(e.method)} ${esc(e.path)}</div><div class="t2">${esc(e.name)}</div></td>
  <td class="mono">${esc(e.upstream)}</td>
  <td><div class="badges">${(e.scopes || [])
    .map((s) => `<span class="badge mute mono">${esc(s)}</span>`)
    .join('')}</div></td>
  <td>${mode}</td>
  <td style="max-width:420px">${fields}</td>
</tr>`;
        })
        .join('')
    : EMPTY(
        5,
        'No endpoints configured. Add them to <span class="mono">config/endpoints.yaml</span> and deploy.'
      );

  const upstreams = Object.entries(cfg.upstreams || {})
    .map(
      ([name, u]) =>
        `<tr><td class="t1 mono">${esc(name)}</td><td class="mono">${esc(u.baseUrl)}</td>
         <td><span class="badge mute">${esc(u.auth?.type || 'none')}</span></td>
         <td class="num">${esc(u.timeoutMs)}ms</td></tr>`
    )
    .join('');

  const body = `
${pageHead('Endpoints', 'Exactly what each vendor-facing route exposes, and which upstream it reaches.')}
${tablePanel(
  'Vendor-facing routes',
  'The <strong>Exposes</strong> column is the security boundary. On a whitelist endpoint the response is built field by field from that list — a column added upstream tomorrow cannot appear here by accident.',
  '<th>Route</th><th>Upstream</th><th>Scopes</th><th>Mode</th><th>Exposes</th>',
  rows
)}
${tablePanel(
  'Upstreams',
  'Never visible to a vendor. A credential comes either from the environment file or from the ' +
    'database sealed with AES-256-GCM, and neither is shown here — the API Studio is where a ' +
    'credential is set, replaced or read, and every one of those is written to the access log.',
  '<th>Name</th><th>Base URL</th><th>Auth</th><th class="num">Timeout</th>',
  upstreams || EMPTY(4, 'None configured.')
)}
${panel(
  'Why this screen is read-only',
  '',
  `<p class="note" style="margin:0">Endpoints are declared in <strong>config/endpoints.yaml</strong>,
   reviewed as a git diff, and validated by <strong>npm run validate</strong> before a deploy restarts
   anything. That review step is the control: a change to which fields a vendor can see should be
   something a person approved, not something a form submitted. Editing them here would remove it.</p>`
)}`;

  return layout({ title: 'Endpoints', admin, current: '/admin/endpoints', body, flash });
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function activityPage({ admin, flash, usage, recent, quota, days }) {
  const usageRows = usage.length
    ? usage
        .map(
          (r) => `<tr>
  <td class="t1 mono">${esc(r.vendor_id || '—')}</td>
  <td class="mono">${esc(r.endpoint || '—')}</td>
  <td class="num">${fmtNum(r.calls)}</td>
  <td class="num">${
    Number(r.errors) > 0 ? `<span class="badge off">${fmtNum(r.errors)}</span>` : '0'
  }</td>
  <td class="num">${esc(r.avg_ms ?? '—')}ms</td>
  <td class="num">${esc(r.p95_ms ?? '—')}ms</td>
  <td class="t2">${fmtDate(r.last_call)}</td>
</tr>`
        )
        .join('')
    : EMPTY(7, `No traffic recorded in the last ${days} days.`);

  const quotaRows = quota.length
    ? quota
        .map((q) => {
          const used = Number(q.used || 0);
          const cap = q.limit === null || q.limit === undefined ? null : Number(q.limit);
          const pct = cap ? Math.round((used / cap) * 100) : null;
          const pill =
            pct === null
              ? '<span class="badge mute">uncapped</span>'
              : pct >= 90
                ? `<span class="badge off">${pct}% used</span>`
                : pct >= 70
                  ? `<span class="badge warn">${pct}% used</span>`
                  : `<span class="badge ok">${pct}% used</span>`;
          return `<tr><td class="t1 mono">${esc(q.vendor_id)}</td>
            <td class="num">${fmtNum(used)}</td>
            <td class="num">${cap === null ? '∞' : fmtNum(cap)}</td>
            <td class="actions">${pill}</td></tr>`;
        })
        .join('')
    : EMPTY(4, 'No quota consumed this month.');

  const recentRows = recent.length
    ? recent
        .map(
          (r) => `<tr>
  <td class="t2">${fmtDate(r.occurred_at)}</td>
  <td class="mono">${esc(r.vendor_id || '—')}</td>
  <td class="mono">${esc(r.method || '')} ${esc(r.path || '')}</td>
  <td class="num">${
    Number(r.status) >= 400
      ? `<span class="badge off">${esc(r.status)}</span>`
      : `<span class="badge ok">${esc(r.status)}</span>`
  }</td>
  <td class="num">${esc(r.total_ms ?? '—')}ms</td>
  <td class="mono t2">${esc(String(r.request_id || '').slice(0, 8))}</td>
</tr>`
        )
        .join('')
    : EMPTY(6, 'Nothing yet.');

  const body = `
${pageHead(
  'Activity',
  `Last ${days} days. The audit log records status codes and timings — never request or response bodies, and never header values.`
)}
${tablePanel(
  'Usage by vendor and endpoint',
  '',
  `<th>Vendor</th><th>Endpoint</th><th class="num">Calls</th><th class="num">Errors</th>
   <th class="num">Avg</th><th class="num">p95</th><th>Last call</th>`,
  usageRows
)}
${tablePanel(
  'Monthly quota',
  'Calendar month in UTC. Quota fails <strong>open</strong> if the database is unreachable — billing accuracy is not worth refusing a vendor request.',
  '<th>Vendor</th><th class="num">Used</th><th class="num">Limit</th><th></th>',
  quotaRows
)}
${tablePanel(
  'Recent requests',
  'The request id is what a vendor quotes when something goes wrong — trace it with <span class="mono">node scripts/gw.js audit:trace &lt;id&gt;</span>.',
  `<th>When</th><th>Vendor</th><th>Request</th><th class="num">Status</th>
   <th class="num">Time</th><th>Request id</th>`,
  recentRows
)}`;

  return layout({ title: 'Activity', admin, current: '/admin/activity', body, flash });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

function healthPage({ admin, flash, health, cfg }) {
  const body = `
${pageHead('Health', 'The same data <span class="mono">/readyz</span> serves to your load balancer.')}
${panel('Live status', '', `<pre>${esc(JSON.stringify(health, null, 2))}</pre>`)}
${tablePanel(
  'Configuration source',
  '',
  '<th>Setting</th><th>Value</th>',
  `<tr><td><strong>Config directory</strong></td><td class="mono">${esc(process.env.CONFIG_DIR || 'config/')}</td></tr>
   <tr><td><strong>Endpoints loaded</strong></td><td class="num">${cfg.endpoints.length}</td></tr>
   <tr><td><strong>Upstreams loaded</strong></td><td class="num">${Object.keys(cfg.upstreams || {}).length}</td></tr>
   <tr><td><strong>Public base URL</strong></td><td class="mono">${esc(process.env.PUBLIC_BASE_URL || 'not set')}</td></tr>`
)}`;

  return layout({ title: 'Health', admin, current: '/admin/health', body, flash });
}

module.exports = {
  overview,
  vendorsPage,
  vendorKeysPage,
  endpointsPage,
  activityPage,
  healthPage,
};
