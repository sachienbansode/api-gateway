'use strict';

const { esc, layout, fmtDate, fmtNum } = require('./ui');

/**
 * The admin screens.
 *
 * Read screens show what the gateway is actually doing. Write screens cover
 * the things that genuinely change day to day — vendors, their scopes, their
 * keys — because those are the operations that otherwise mean SSH and a CLI.
 *
 * Endpoints are deliberately READ-ONLY here. They are declared in
 * config/endpoints.yaml, reviewed in git, and validated by `npm run validate`
 * before a deploy restarts anything. That review gate is the security model:
 * a change to which fields a vendor can see should be a diff somebody
 * approved, not a form someone submitted at 6pm. The screen shows exactly what
 * is exposed so you can audit it without reading YAML.
 */

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function overview({ admin, flash, cfg, vendors, health, usage }) {
  const whitelisted = cfg.endpoints.filter((e) => e.response.mode === 'whitelist').length;
  const unfiltered = cfg.endpoints.length - whitelisted;
  const liveKeys = vendors.reduce((n, v) => n + Number(v.live_keys || 0), 0);
  const calls = usage.reduce((n, r) => n + Number(r.calls || 0), 0);
  const errors = usage.reduce((n, r) => n + Number(r.errors || 0), 0);

  const dbOk = health.database?.enabled
    ? health.database.ok
      ? `<span class="pill ok">connected ${esc(health.database.latencyMs)}ms</span>`
      : `<span class="pill off">unreachable</span>`
    : `<span class="pill warn">not configured</span>`;

  const body = `
<h2>Overview</h2>
<p class="sub">What this gateway is exposing right now.</p>

<div class="stats">
  <div class="stat"><div class="n">${cfg.endpoints.length}</div><div class="l">Endpoints</div></div>
  <div class="stat"><div class="n">${vendors.length}</div><div class="l">Vendors</div></div>
  <div class="stat"><div class="n">${liveKeys}</div><div class="l">Live keys</div></div>
  <div class="stat"><div class="n">${fmtNum(calls)}</div><div class="l">Calls (30d)</div></div>
  <div class="stat"><div class="n">${fmtNum(errors)}</div><div class="l">Errors (30d)</div></div>
</div>

<div class="card">
  <h3>Exposure</h3>
  <p>The one number that matters: how many endpoints build their response from an
     explicit field whitelist, rather than forwarding whatever the upstream returned.</p>
  <table><tbody>
    <tr><td>Whitelisted</td><td class="num">${whitelisted}</td>
        <td>${whitelisted === cfg.endpoints.length && cfg.endpoints.length > 0
              ? '<span class="pill ok">every endpoint is filtered</span>'
              : '<span class="pill mute">—</span>'}</td></tr>
    <tr><td>Redact or passthrough</td><td class="num">${unfiltered}</td>
        <td>${unfiltered > 0
              ? '<span class="pill warn">not protected against upstream schema change</span>'
              : '<span class="pill ok">none</span>'}</td></tr>
    <tr><td>Reachable by no vendor</td><td class="num">${cfg.unreachable.length}</td>
        <td>${cfg.unreachable.length
              ? `<span class="pill mute">${cfg.unreachable.map(esc).join(', ')}</span>`
              : '<span class="pill ok">none</span>'}</td></tr>
  </tbody></table>
</div>

<div class="card">
  <h3>Dependencies</h3>
  <table><tbody>
    <tr><td>Gateway database</td><td>${dbOk}</td></tr>
    <tr><td>Vendor keys</td><td><span class="pill mute">${esc(health.vendorStore?.source || 'unknown')}</span></td></tr>
    <tr><td>Audit queue</td><td>${
      Number(health.audit?.dropped || 0) > 0
        ? `<span class="pill off">${esc(health.audit.dropped)} dropped</span>`
        : `<span class="pill ok">${esc(health.audit?.written ?? 0)} written</span>`
    }</td></tr>
    ${Object.entries(health.upstreams || {})
      .map(
        ([name, b]) =>
          `<tr><td>Upstream <span class="mono">${esc(name)}</span></td><td>${
            b.state === 'open'
              ? '<span class="pill off">breaker open</span>'
              : `<span class="pill ok">${esc(b.state)}</span>`
          }</td></tr>`
      )
      .join('')}
  </tbody></table>
</div>`;

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
  <td><strong class="mono">${esc(v.id)}</strong><br><span class="who">${esc(v.name || '')}</span></td>
  <td>${v.enabled ? '<span class="pill ok">enabled</span>' : '<span class="pill off">disabled</span>'}</td>
  <td>${(v.scopes || []).length
        ? (v.scopes || []).map((s) => `<span class="pill mute">${esc(s)}</span>`).join(' ')
        : '<span class="who">none — cannot call anything</span>'}</td>
  <td class="num">${v.live_keys}</td>
  <td class="num">${v.monthly_quota ? fmtNum(v.monthly_quota) : '∞'}</td>
  <td class="who">${fmtDate(v.last_used_at)}</td>
  <td>
    <a class="btn" href="/admin/vendors/${encodeURIComponent(v.id)}">Keys</a>
    ${admin.canEdit
      ? `<form class="inline" method="post" action="/admin/vendors/${encodeURIComponent(v.id)}/toggle">
           <button type="submit">${v.enabled ? 'Disable' : 'Enable'}</button>
         </form>`
      : ''}
  </td>
</tr>`
        )
        .join('')
    : `<tr><td colspan="7" class="empty">No vendors yet. Add one below, then issue it a key.</td></tr>`;

  const addForm = admin.canEdit
    ? `
<div class="card">
  <h3>Add or update a vendor</h3>
  <p>Using an existing id updates that vendor instead of creating a second one.</p>
  <form method="post" action="/admin/vendors">
    <div class="grid">
      <div><label for="id">Vendor id</label>
        <input id="id" name="id" type="text" required pattern="[a-z0-9][a-z0-9_-]*"
               placeholder="acme">
        <p class="hint">Lower case, no spaces. Appears in the audit log.</p></div>
      <div><label for="name">Display name</label>
        <input id="name" name="name" type="text" placeholder="Acme Logistics"></div>
      <div><label for="quota">Monthly quota</label>
        <input id="quota" name="monthlyQuota" type="number" min="1" placeholder="blank = unlimited"></div>
      <div><label for="rateMax">Rate limit</label>
        <input id="rateMax" name="rateMax" type="number" min="1" placeholder="600">
        <p class="hint">Requests per minute.</p></div>
    </div>
    <div style="margin-top:14px">
      <label>Scopes</label>
      ${allScopes.length
        ? allScopes
            .map(
              (s) =>
                `<label style="display:inline-flex;align-items:center;gap:6px;font-weight:400;margin:0 14px 8px 0">
                   <input type="checkbox" name="scopes" value="${esc(s)}" style="width:auto"> <span class="mono">${esc(s)}</span>
                 </label>`
            )
            .join('')
        : '<p class="hint">No scopes declared yet — add endpoints to config/endpoints.yaml first.</p>'}
      <p class="hint">A vendor can only reach endpoints whose scopes it holds. No scopes means no access.</p>
    </div>
    <div style="margin-top:14px"><button class="primary" type="submit">Save vendor</button></div>
  </form>
</div>`
    : '';

  const keyBox = issuedKey
    ? `<div class="flash ok">
         <strong>API key issued for ${esc(issuedKey.vendorId)}.</strong>
         Copy it now — only its SHA-256 hash is stored, so it cannot be shown again.
         <div class="key">${esc(issuedKey.key)}</div>
       </div>`
    : '';

  const body = `
<h2>Vendors</h2>
<p class="sub">Who may call this gateway, what they may reach, and with which keys.</p>
${keyBox}
<div class="card">
  <h3>All vendors</h3>
  <div class="wrap"><table>
    <thead><tr><th>Vendor</th><th>Status</th><th>Scopes</th><th class="num">Live keys</th>
      <th class="num">Quota</th><th>Last used</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>
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
            ? '<span class="pill off">revoked</span>'
            : expired
              ? '<span class="pill warn">expired</span>'
              : '<span class="pill ok">live</span>';
          return `<tr>
  <td class="mono">${esc(String(k.key_hash).slice(0, 16))}…</td>
  <td>${esc(k.label || '—')}</td>
  <td>${state}</td>
  <td class="who">${fmtDate(k.created_at)}</td>
  <td class="who">${fmtDate(k.last_used_at)}</td>
  <td>${!revoked && admin.canEdit
    ? `<form class="inline" method="post" action="/admin/vendors/${encodeURIComponent(vendorId)}/keys/revoke">
         <input type="hidden" name="keyHash" value="${esc(k.key_hash)}">
         <button class="danger" type="submit">Revoke</button>
       </form>`
    : ''}</td>
</tr>`;
        })
        .join('')
    : `<tr><td colspan="6" class="empty">No keys issued yet.</td></tr>`;

  const keyBox = issuedKey
    ? `<div class="flash ok">
         <strong>New API key.</strong> Copy it now — only its SHA-256 hash is stored.
         <div class="key">${esc(issuedKey)}</div>
       </div>`
    : '';

  const body = `
<h2>Keys · <span class="mono">${esc(vendorId)}</span></h2>
<p class="sub">Only the SHA-256 hash of each key is stored, so a database dump yields nothing usable.</p>
${keyBox}
<div class="card">
  <h3>Keys</h3>
  <p>Revocation takes up to 30 seconds to apply — auth is kept off the database hot path.</p>
  <div class="wrap"><table>
    <thead><tr><th>Hash</th><th>Label</th><th>State</th><th>Issued</th><th>Last used</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>
${admin.canEdit
  ? `<div class="card">
       <h3>Issue a new key</h3>
       <p>Issue the new key, let the vendor cut over, then revoke the old one. No downtime.</p>
       <form method="post" action="/admin/vendors/${encodeURIComponent(vendorId)}/keys">
         <div class="grid">
           <div><label for="label">Label</label>
             <input id="label" name="label" type="text" placeholder="rotation 2026-10">
             <p class="hint">For your own records. Never sent to the vendor.</p></div>
           <div><button class="primary" type="submit">Issue key</button></div>
         </div>
       </form>
     </div>`
  : ''}
<p><a class="btn" href="/admin/vendors">← All vendors</a></p>`;

  return layout({ title: `Keys · ${vendorId}`, admin, current: '/admin/vendors', body, flash });
}

// ---------------------------------------------------------------------------
// Endpoints (read-only)
// ---------------------------------------------------------------------------

function endpointsPage({ admin, flash, cfg }) {
  const rows = cfg.endpoints.length
    ? cfg.endpoints
        .map((e) => {
          const mode =
            e.response.mode === 'whitelist'
              ? `<span class="pill ok">whitelist</span>`
              : e.response.mode === 'redact'
                ? `<span class="pill warn">redact</span>`
                : `<span class="pill off">passthrough</span>`;
          const fields =
            e.response.mode === 'whitelist'
              ? (e.response.fields || []).map((f) => `<span class="mono">${esc(f)}</span>`).join(', ')
              : e.response.mode === 'redact'
                ? `everything except ${(e.response.exclude || []).map((f) => `<span class="mono">${esc(f)}</span>`).join(', ')}`
                : '<span class="pill off">the entire upstream response</span>';
          return `<tr>
  <td><strong class="mono">${esc(e.method)} ${esc(e.path)}</strong><br>
      <span class="who">${esc(e.name)}</span></td>
  <td class="mono">${esc(e.upstream)}</td>
  <td>${(e.scopes || []).map((s) => `<span class="pill mute">${esc(s)}</span>`).join(' ')}</td>
  <td>${mode}</td>
  <td style="max-width:360px">${fields}</td>
</tr>`;
        })
        .join('')
    : `<tr><td colspan="5" class="empty">No endpoints configured. Add them to
         <span class="mono">config/endpoints.yaml</span> and deploy.</td></tr>`;

  const upstreams = Object.entries(cfg.upstreams || {})
    .map(
      ([name, u]) =>
        `<tr><td class="mono">${esc(name)}</td><td class="mono">${esc(u.baseUrl)}</td>
         <td>${esc(u.auth?.type || 'none')}</td><td class="num">${esc(u.timeoutMs)}ms</td></tr>`
    )
    .join('');

  const body = `
<h2>Endpoints</h2>
<p class="sub">Exactly what each vendor-facing route exposes, and which upstream it reaches.</p>

<div class="card">
  <h3>Vendor-facing routes</h3>
  <p>The <strong>Exposes</strong> column is the security boundary. On a whitelist endpoint the
     response is built field by field from this list — a column added upstream tomorrow
     cannot appear here by accident.</p>
  <div class="wrap"><table>
    <thead><tr><th>Route</th><th>Upstream</th><th>Scopes</th><th>Mode</th><th>Exposes</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>

<div class="card">
  <h3>Upstreams</h3>
  <p>Never visible to a vendor. Credentials are resolved from the environment at boot and
     are not shown here.</p>
  <div class="wrap"><table>
    <thead><tr><th>Name</th><th>Base URL</th><th>Auth</th><th class="num">Timeout</th></tr></thead>
    <tbody>${upstreams || '<tr><td colspan="4" class="empty">None configured.</td></tr>'}</tbody>
  </table></div>
</div>

<div class="card">
  <h3>Why this screen is read-only</h3>
  <p style="margin:0">Endpoints are declared in <span class="mono">config/endpoints.yaml</span>,
     reviewed as a git diff, and validated by <span class="mono">npm run validate</span> before a
     deploy restarts anything. That review step is the control: a change to which fields a vendor
     can see should be something a person approved, not something a form submitted. Editing them
     here would remove it.</p>
</div>`;

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
  <td class="mono">${esc(r.vendor_id || '—')}</td>
  <td class="mono">${esc(r.endpoint || '—')}</td>
  <td class="num">${fmtNum(r.calls)}</td>
  <td class="num">${Number(r.errors) > 0 ? `<span class="pill off">${fmtNum(r.errors)}</span>` : '0'}</td>
  <td class="num">${esc(r.avg_ms ?? '—')}</td>
  <td class="num">${esc(r.p95_ms ?? '—')}</td>
  <td class="who">${fmtDate(r.last_call)}</td>
</tr>`
        )
        .join('')
    : `<tr><td colspan="7" class="empty">No traffic recorded in the last ${days} days.</td></tr>`;

  const quotaRows = quota.length
    ? quota
        .map(
          (q) => `<tr>
  <td class="mono">${esc(q.vendor_id)}</td>
  <td class="who">${esc(q.period)}</td>
  <td class="num">${fmtNum(q.calls)}</td>
</tr>`
        )
        .join('')
    : `<tr><td colspan="3" class="empty">No quota consumed this month.</td></tr>`;

  const recentRows = recent.length
    ? recent
        .map(
          (r) => `<tr>
  <td class="who">${fmtDate(r.occurred_at)}</td>
  <td class="mono">${esc(r.vendor_id || '—')}</td>
  <td class="mono">${esc(r.method || '')} ${esc(r.path || '')}</td>
  <td class="num">${Number(r.status) >= 400
      ? `<span class="pill off">${esc(r.status)}</span>`
      : `<span class="pill ok">${esc(r.status)}</span>`}</td>
  <td class="num">${esc(r.total_ms ?? '—')}ms</td>
  <td class="mono who">${esc(String(r.request_id || '').slice(0, 8))}</td>
</tr>`
        )
        .join('')
    : `<tr><td colspan="6" class="empty">Nothing yet.</td></tr>`;

  const body = `
<h2>Activity</h2>
<p class="sub">Last ${days} days. The audit log records status codes and timings — never request
   or response bodies, and never header values.</p>

<div class="card">
  <h3>Usage by vendor and endpoint</h3>
  <div class="wrap"><table>
    <thead><tr><th>Vendor</th><th>Endpoint</th><th class="num">Calls</th><th class="num">Errors</th>
      <th class="num">Avg</th><th class="num">p95</th><th>Last call</th></tr></thead>
    <tbody>${usageRows}</tbody>
  </table></div>
</div>

<div class="card">
  <h3>Monthly quota consumed</h3>
  <div class="wrap"><table>
    <thead><tr><th>Vendor</th><th>Period</th><th class="num">Calls</th></tr></thead>
    <tbody>${quotaRows}</tbody>
  </table></div>
</div>

<div class="card">
  <h3>Recent requests</h3>
  <p>The request id is what a vendor quotes when something goes wrong — trace it with
     <span class="mono">node scripts/gw.js audit:trace &lt;id&gt;</span>.</p>
  <div class="wrap"><table>
    <thead><tr><th>When</th><th>Vendor</th><th>Request</th><th class="num">Status</th>
      <th class="num">Time</th><th>Request id</th></tr></thead>
    <tbody>${recentRows}</tbody>
  </table></div>
</div>`;

  return layout({ title: 'Activity', admin, current: '/admin/activity', body, flash });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

function healthPage({ admin, flash, health, cfg }) {
  const body = `
<h2>Health</h2>
<p class="sub">The same data <span class="mono">/readyz</span> serves to your load balancer.</p>

<div class="card">
  <h3>Live status</h3>
  <pre class="mono" style="margin:0;white-space:pre-wrap;word-break:break-word">${esc(
    JSON.stringify(health, null, 2)
  )}</pre>
</div>

<div class="card">
  <h3>Configuration source</h3>
  <table><tbody>
    <tr><td>Config directory</td><td class="mono">${esc(process.env.CONFIG_DIR || 'config/')}</td></tr>
    <tr><td>Endpoints loaded</td><td class="num">${cfg.endpoints.length}</td></tr>
    <tr><td>Upstreams loaded</td><td class="num">${Object.keys(cfg.upstreams || {}).length}</td></tr>
    <tr><td>Public base URL</td><td class="mono">${esc(process.env.PUBLIC_BASE_URL || 'not set')}</td></tr>
  </tbody></table>
</div>`;

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
