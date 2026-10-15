'use strict';

const { esc, layout, pageHead, panel, tablePanel, fmtDate, fmtNum } = require('./ui');

/**
 * The catalogue: browse, filter, and read a record before changing it.
 *
 * Everything here is READ-ONLY. Editing happens in the Studio, which is the
 * one place that knows how to validate an endpoint, and a second editor would
 * eventually disagree with it. The Edit button is a link, not a mode.
 */

const CSS = `
.filters{display:grid;gap:10px;grid-template-columns:2fr repeat(4,1fr) auto;align-items:end;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);
  padding:13px 15px;margin-bottom:14px}
@media(max-width:1100px){.filters{grid-template-columns:1fr 1fr}}
.filters .f{min-width:0}
.filters .acts{display:flex;gap:7px}
.pager{display:flex;align-items:center;gap:10px;justify-content:space-between;
  padding:11px 15px;border-top:1px solid var(--border);background:var(--surface2);flex-wrap:wrap}
.pager .n{font-size:11.5px;color:var(--ink3)}
.pager .pages{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.pager a,.pager span.cur{display:inline-block;min-width:27px;text-align:center;padding:4px 7px;
  border:1px solid var(--border);border-radius:var(--r);font-size:11.5px;color:var(--ink2);
  background:var(--surface);text-decoration:none}
.pager a:hover{background:var(--surface2);color:var(--ink);text-decoration:none}
.pager span.cur{background:var(--ink);border-color:var(--ink);color:#fff;font-weight:600}
.pager span.gap{border:0;background:none;color:var(--ink3);min-width:14px}
tr.row{cursor:pointer}
.dl{display:grid;grid-template-columns:190px 1fr;gap:0}
.dl dt{padding:9px 0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;
  color:var(--ink3);border-bottom:1px solid var(--border)}
.dl dd{margin:0;padding:9px 0;font-size:12.5px;color:var(--ink);border-bottom:1px solid var(--border);
  word-break:break-word}
.dl dt:last-of-type,.dl dd:last-of-type{border-bottom:0}
.dl dd .mono{font-family:var(--mono);font-size:11.5px}
.tabs{display:flex;gap:2px;margin-bottom:14px;border-bottom:1px solid var(--border)}
.tabs a{padding:8px 14px;font-size:12.5px;color:var(--ink3);border-bottom:2px solid transparent;
  margin-bottom:-1px;text-decoration:none}
.tabs a:hover{color:var(--ink);text-decoration:none}
.tabs a[aria-current]{color:var(--ink);font-weight:600;border-bottom-color:var(--gold)}
.fullurl{display:flex;align-items:center;gap:10px;background:var(--surface2);
  border:1px solid var(--border);border-radius:var(--r);padding:11px 13px;flex-wrap:wrap}
.fullurl .m{font-size:10px;font-weight:700;letter-spacing:.6px;color:#fff;background:var(--ink);
  border-radius:3px;padding:3px 7px}
.fullurl code{font-family:var(--mono);font-size:12.5px;color:var(--ink);word-break:break-all}
.sum{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:16px}
`;

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined && v !== '') p.set(k, v);
  });
  const s = p.toString();
  return s ? '?' + s : '';
};

function statusBadge(s) {
  const kind = s === 'live' ? 'ok' : s === 'retired' ? 'off' : 'warn';
  return `<span class="badge ${kind}">${esc(s)}</span>`;
}
function modeBadge(m) {
  const kind = m === 'whitelist' ? 'ok' : m === 'redact' ? 'warn' : 'off';
  return `<span class="badge ${kind}">${esc(m)}</span>`;
}

/** Page numbers with gaps, so 14 pages does not become 14 links. */
function pager(base, q, p) {
  if (p.pages <= 1) {
    return `<div class="pager"><span class="n">${fmtNum(p.total)} record${p.total === 1 ? '' : 's'}</span></div>`;
  }
  const want = new Set([1, p.pages, p.page, p.page - 1, p.page + 1, p.page - 2, p.page + 2]);
  const nums = [...want].filter((n) => n >= 1 && n <= p.pages).sort((a, b) => a - b);
  let out = '';
  let last = 0;
  for (const n of nums) {
    if (n - last > 1) out += '<span class="gap">…</span>';
    out += n === p.page
      ? `<span class="cur">${n}</span>`
      : `<a href="${base}${qs({ ...q, page: n })}">${n}</a>`;
    last = n;
  }
  const prev = p.page > 1 ? `<a href="${base}${qs({ ...q, page: p.page - 1 })}">‹</a>` : '';
  const next = p.page < p.pages ? `<a href="${base}${qs({ ...q, page: p.page + 1 })}">›</a>` : '';
  return `<div class="pager">
    <span class="n">${fmtNum(p.from)}–${fmtNum(p.to)} of ${fmtNum(p.total)}</span>
    <span class="pages">${prev}${out}${next}</span>
  </div>`;
}

function select(name, label, options, value, allLabel) {
  const opts = [`<option value="">${esc(allLabel)}</option>`]
    .concat(options.map((o) =>
      `<option value="${esc(o.code)}"${String(o.code) === String(value || '') ? ' selected' : ''}>` +
      `${esc(o.label || o.name || o.code)}${o.n !== undefined ? ` (${o.n})` : ''}</option>`));
  return `<div class="f"><label for="f_${name}">${esc(label)}</label>
    <select id="f_${name}" name="${name}">${opts.join('')}</select></div>`;
}

// ---------------------------------------------------------------------------
// List: endpoints
// ---------------------------------------------------------------------------
function endpointList({ admin, flash, page: p, facets, query, baseUrl }) {
  const rows = p.rows.map((e) => `
    <tr>
      <td><div class="t1">${esc(e.display_name || e.name)}</div>
          <div class="t2 mono">${esc(e.name)}</div></td>
      <td>${esc(e.application || '—')}</td>
      <td><div class="mono"><span class="t2">${esc(baseUrl)}</span>${esc(e.path)}</div>
          <div class="t2">${esc(e.method)} · ${esc(e.category_label || e.category || 'uncategorised')}</div></td>
      <td>${statusBadge(e.status)}</td>
      <td>${modeBadge(e.response_mode)}</td>
      <td class="num">${e.response_mode === 'whitelist'
        ? `${fmtNum(e.exposed_count)}<span class="t2"> of ${fmtNum(e.field_count)}</span>`
        : '<span class="t2">all</span>'}</td>
      <td class="num">${fmtNum(e.param_count)}</td>
      <td class="actions">
        <a class="btn" href="/admin/catalog/endpoint/${esc(e.name)}">View</a>
        <a class="btn" href="/admin/studio?endpoint=${esc(e.name)}">Edit</a>
        <a class="btn" href="/admin/catalog/endpoint/${esc(e.name)}/postman"
           title="Download a Postman collection for this endpoint">Postman</a>
      </td>
    </tr>`).join('') || `<tr><td colspan="8" class="empty">
      Nothing matches. ${query.q || query.category || query.status || query.mode
        ? 'Try clearing a filter.' : 'Load a catalogue, or build an endpoint in the Studio.'}</td></tr>`;

  const body = `
${pageHead('Catalogue', 'Every endpoint and supplier API, as the gateway has them.',
  `<a class="btn" href="/admin/catalog/postman${qs(query)}">Postman collection</a>
   <a class="btn" href="/admin/studio">Open the Studio</a>`)}
<div class="tabs">
  <a href="/admin/catalog" aria-current="page">Endpoints</a>
  <a href="/admin/catalog/upstreams">Supplier APIs</a>
</div>
<form class="filters" method="get" action="/admin/catalog">
  <div class="f"><label for="f_q">Search</label>
    <input id="f_q" name="q" type="search" value="${esc(query.q || '')}"
      placeholder="name, path, or supplier path"></div>
  ${select('application', 'Application', facets.applications, query.application, 'All applications')}
  ${select('category', 'Category', facets.categories, query.category, 'All categories')}
  ${select('status', 'Status', facets.statuses, query.status, 'Any status')}
  ${select('mode', 'Response', facets.modes, query.mode, 'Any mode')}
  <div class="f acts"><button type="submit" class="primary">Filter</button>
    <a class="btn" href="/admin/catalog">Clear</a></div>
</form>
<section class="panel">
  <div class="wrap"><table>
    <thead><tr>
      <th>Endpoint</th><th>Application</th><th>Vendors call</th><th>Status</th><th>Response</th>
      <th class="num">Exposed</th><th class="num">Params</th><th class="actions">Actions</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  ${pager('/admin/catalog', query, p)}
</section>
<style>${CSS}</style>`;
  return layout({ title: 'Catalogue', admin, current: '/admin/catalog', body, flash });
}

// ---------------------------------------------------------------------------
// List: supplier APIs
// ---------------------------------------------------------------------------
function upstreamList({ admin, flash, page: p, facets, query }) {
  const rows = p.rows.map((u) => `
    <tr class="row" onclick="location.href='/admin/catalog/upstream/${esc(u.name)}'">
      <td><div class="t1">${esc(u.display_name || u.name)}</div>
          <div class="t2 mono">${esc(u.name)}</div></td>
      <td class="t2">${esc(u.vendor_name || '—')}</td>
      <td class="mono">${esc(u.base_url)}</td>
      <td>${u.auth_type === 'none'
        ? '<span class="badge off">none</span>'
        : `<span class="badge mute">${esc(u.auth_type)}</span>`}</td>
      <td>${u.secret_stored
        ? `<span class="badge ok">stored ••••${esc(u.secret_hint || '')}</span>`
        : u.auth_value_env
          ? '<span class="badge mute">env var</span>'
          : '<span class="badge warn">not set</span>'}</td>
      <td class="num">${fmtNum(u.endpoint_count)}<span class="t2"> (${fmtNum(u.live_count)} live)</span></td>
      <td>${u.last_test_status
        ? `<span class="badge ${u.last_test_status < 400 ? 'ok' : 'off'}">${esc(u.last_test_status)}</span>`
        : '<span class="badge mute">never tested</span>'}</td>
    </tr>`).join('') || `<tr><td colspan="7" class="empty">No supplier APIs yet.</td></tr>`;

  const body = `
${pageHead('Catalogue', 'Every endpoint and supplier API, as the gateway has them.',
  `<a class="btn" href="/admin/studio">Open the Studio</a>`)}
<div class="tabs">
  <a href="/admin/catalog">Endpoints</a>
  <a href="/admin/catalog/upstreams" aria-current="page">Supplier APIs</a>
</div>
<form class="filters" method="get" action="/admin/catalog/upstreams"
      style="grid-template-columns:2fr 1fr auto">
  <div class="f"><label for="f_q">Search</label>
    <input id="f_q" name="q" type="search" value="${esc(query.q || '')}"
      placeholder="name, supplier, or base URL"></div>
  ${select('application', 'Application', facets.applications, query.application, 'All applications')}
  <div class="f acts"><button type="submit" class="primary">Filter</button>
    <a class="btn" href="/admin/catalog/upstreams">Clear</a></div>
</form>
<section class="panel">
  <div class="wrap"><table>
    <thead><tr><th>Supplier API</th><th>Supplied by</th><th>Base URL</th><th>Auth</th>
      <th>Credential</th><th class="num">Endpoints</th><th>Last test</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  ${pager('/admin/catalog/upstreams', query, p)}
</section>
<style>${CSS}</style>`;
  return layout({ title: 'Supplier APIs', admin, current: '/admin/catalog', body, flash });
}

module.exports = { endpointList, upstreamList, CSS, qs, statusBadge, modeBadge, pager };

// ---------------------------------------------------------------------------
// Detail: one endpoint, read-only
//
// Read-only on purpose. Someone opening a record to answer a question should
// not be one stray keystroke from changing it, and "what does this endpoint
// expose?" is asked far more often than "change what it exposes".
// ---------------------------------------------------------------------------
function endpointDetail({ admin, flash, e, upstream, baseUrl }) {
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  const mono = (v) => `<span class="mono">${esc(v)}</span>`;

  const exposed = e.fields.filter((f) => f.exposed);
  const withheld = e.fields.filter((f) => !f.exposed);

  const fieldRows = (list, kind) => list.map((f) => `
    <tr><td class="mono">${esc(f.path)}</td>
        <td class="t2">${esc(f.data_type || '—')}</td>
        <td>${f.rename_to ? `<span class="mono">${esc(f.rename_to)}</span>` : '<span class="t2">—</span>'}</td>
        <td class="t2">${esc(f.description || '')}</td>
        <td class="actions">${f.discovered ? '<span class="badge warn">found in a test</span>' : ''}</td>
    </tr>`).join('') || `<tr><td colspan="5" class="empty">${kind}</td></tr>`;

  const paramRows = e.params.map((p) => `
    <tr><td class="mono">${esc(p.name)}</td>
        <td><span class="badge mute">${esc(p.location)}</span></td>
        <td>${p.source === 'vendor'
          ? '<span class="t2">the vendor</span>'
          : `<span class="badge warn">${esc(p.source === 'env' ? 'a variable' : 'fixed')}</span>`}</td>
        <td class="t2">${esc(p.data_type)}${p.required ? ' · required' : ''}</td>
        <td class="mono">${esc(p.example || p.fixed_value || '')}</td>
        <td class="t2">${esc(p.description || '')}${
          (p.allowed || []).length ? ` <span class="badge mute">${esc((p.allowed || []).join(' / '))}</span>` : ''}</td>
    </tr>`).join('') || `<tr><td colspan="6" class="empty">This endpoint takes no parameters.</td></tr>`;

  const testRows = (e.tests || []).map((t) => `
    <tr><td class="t2">${fmtDate(t.occurred_at)}</td>
        <td>${t.ok ? '<span class="badge ok">passed</span>' : '<span class="badge off">failed</span>'}</td>
        <td class="num">${t.status || '—'}</td>
        <td class="num">${t.latency_ms ? t.latency_ms + ' ms' : '—'}</td>
        <td class="num">${t.field_count === null || t.field_count === undefined ? '—' : fmtNum(t.field_count)}</td>
        <td class="t2">${esc(t.error || '')}</td></tr>`).join('')
    || `<tr><td colspan="6" class="empty">Never tested.</td></tr>`;

  const publishButton = e.status === 'live'
    ? `<button type="submit" name="status" value="draft" class="danger"
         data-confirm="Withdraw ${esc(e.display_name || e.name)}?"
         data-confirm-body="It stops answering within a few seconds. Vendors calling it will get 404 until it is published again.">Withdraw</button>`
    : `<button type="submit" name="status" value="live" class="primary"
         data-confirm="Publish ${esc(e.display_name || e.name)}?"
         data-confirm-body="It starts answering immediately for any vendor holding the scope ep:${esc(e.name)}. ${
           e.response_mode === 'whitelist'
             ? `Vendors will receive ${exposed.length} field(s) and nothing else.`
             : 'This endpoint does NOT filter the supplier response.'}">Publish</button>`;

  const body = `
${pageHead(e.display_name || e.name, esc(e.description || 'No description.'),
  `<a class="btn" href="/admin/catalog">← Catalogue</a>
   <a class="btn" href="/admin/catalog/endpoint/${esc(e.name)}/postman">Postman collection</a>
   <a class="btn" href="/admin/studio?endpoint=${esc(e.name)}">Edit in the Studio</a>`)}

${panel('The URL a vendor calls', '', `
  <div class="fullurl"><span class="m">${esc(e.method)}</span><code>${esc(baseUrl)}${esc(e.path)}</code></div>
  <p class="hint" style="margin:10px 0 0">The host comes from <a href="/admin/settings">Admin config</a>;
    the path is this endpoint's. Parameters written as <code>:name</code> are filled in by the caller.</p>`)}

<div class="sum">
  <div class="stat"><div class="l">Status</div><div class="n" style="font-size:15px;margin-top:8px">${statusBadge(e.status)}</div></div>
  <div class="stat"><div class="l">Response</div><div class="n" style="font-size:15px;margin-top:8px">${modeBadge(e.response_mode)}</div></div>
  <div class="stat ${e.response_mode === 'whitelist' && exposed.length === 0 ? 'alert' : ''}">
    <div class="l">Exposed fields</div><div class="n">${fmtNum(exposed.length)}<small> of ${fmtNum(e.fields.length)}</small></div></div>
  <div class="stat"><div class="l">Withheld</div><div class="n">${fmtNum(withheld.length)}</div></div>
  <div class="stat"><div class="l">Vendors granted</div><div class="n">${fmtNum(e.vendor_count || 0)}</div></div>
</div>

${panel('Routing', '', `<dl class="dl">
  ${row('Reference', mono(e.name))}
  ${row('Vendors call', mono(`${e.method} ${baseUrl}${e.path}`))}
  ${row('We forward to', mono(`${e.upstream_method || e.method} ${upstream ? upstream.base_url : ''}${e.upstream_path}`))}
  ${row('Supplier API', `<a href="/admin/catalog/upstream/${esc(e.upstream)}">${esc(upstream ? (upstream.display_name || upstream.name) : e.upstream)}</a>`)}
  ${row('Scope required', mono('ep:' + e.name))}
  ${row('Rate limit', `${fmtNum(e.rate_max)} calls per ${fmtNum(e.rate_window_ms / 1000)}s`)}
  ${row('Idempotency', esc(e.idempotency || 'off'))}
  ${row('Category', esc(e.category || '—'))}
  ${row('Type', esc(e.api_type || '—'))}
  ${row('Supplier refresh', esc([e.frequency, e.refresh_at].filter(Boolean).join(' at ') || '—'))}
  ${row('Last changed', `${fmtDate(e.updated_at)}${e.updated_by ? ' by ' + esc(e.updated_by) : ''}`)}
</dl>`)}

${tablePanel('Request parameters',
  'A parameter whose value comes from a <strong>fixed value</strong> or <strong>a variable</strong> is one the vendor cannot influence.',
  '<th>Name</th><th>In</th><th>Value from</th><th>Type</th><th>Example</th><th>Meaning</th>',
  paramRows, String(e.params.length))}

${e.response_mode === 'whitelist' ? tablePanel('Fields the vendor receives',
  `The response is built from these ${exposed.length} path(s) and nothing else.`,
  '<th>Field</th><th>Type</th><th>Renamed to</th><th>Meaning</th><th></th>',
  fieldRows(exposed, 'Nothing is exposed — this endpoint would return an empty object.'),
  String(exposed.length)) : ''}

${withheld.length ? tablePanel('Fields withheld',
  'Known to the supplier, deliberately not passed on.',
  '<th>Field</th><th>Type</th><th>Renamed to</th><th>Meaning</th><th></th>',
  fieldRows(withheld, ''), String(withheld.length)) : ''}

${e.response_mode !== 'whitelist' ? panel('Response filtering', '',
  `<div class="flash err" style="margin:0">This endpoint runs in <strong>${esc(e.response_mode)}</strong> mode.
   ${e.response_mode === 'passthrough'
     ? 'The supplier&rsquo;s body is forwarded exactly as it arrives, including any field they add in future.'
     : 'Everything except the excluded fields is forwarded, including any field they add in future.'}</div>`) : ''}

${tablePanel('Recent tests', '',
  '<th>When</th><th>Result</th><th class="num">Status</th><th class="num">Latency</th><th class="num">Fields</th><th>Error</th>',
  testRows)}

${admin.canEdit ? panel('Change its state', '', `
  <form method="post" action="/admin/catalog/endpoint/${esc(e.name)}/status" class="inline" id="stateForm">
    ${publishButton}
  </form>
  <p class="hint" style="margin-top:10px">A draft is never routed. Publishing is the moment it starts answering.</p>`) : ''}
<style>${CSS}</style>`;

  return layout({ title: e.display_name || e.name, admin, current: '/admin/catalog', body, flash });
}

// ---------------------------------------------------------------------------
// Detail: one supplier API, with everything built on it
// ---------------------------------------------------------------------------
function upstreamDetail({ admin, flash, u, endpoints: eps, baseUrl }) {
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  const mono = (v) => `<span class="mono">${esc(v)}</span>`;

  const epRows = eps.rows.map((e) => `
    <tr class="row" onclick="location.href='/admin/catalog/endpoint/${esc(e.name)}'">
      <td><div class="t1">${esc(e.display_name || e.name)}</div>
          <div class="t2 mono">${esc(e.name)}</div></td>
      <td class="mono"><span class="t2">${esc(baseUrl)}</span>${esc(e.path)}</td>
      <td class="mono t2">${esc(e.upstream_path)}</td>
      <td>${esc(e.category_label || '—')}</td>
      <td>${statusBadge(e.status)}</td>
      <td>${modeBadge(e.response_mode)}</td>
      <td class="num">${e.response_mode === 'whitelist' ? fmtNum(e.exposed_count) : '<span class="t2">all</span>'}</td>
    </tr>`).join('') || `<tr><td colspan="7" class="empty">No endpoints are built on this supplier yet.</td></tr>`;

  const testRows = (u.tests || []).map((t) => `
    <tr><td class="t2">${fmtDate(t.occurred_at)}</td>
        <td>${t.ok ? '<span class="badge ok">passed</span>' : '<span class="badge off">failed</span>'}</td>
        <td class="num">${t.status || '—'}</td>
        <td class="num">${t.latency_ms ? t.latency_ms + ' ms' : '—'}</td>
        <td class="t2">${esc(t.actor || '')}</td>
        <td class="t2">${esc(t.error || '')}</td></tr>`).join('')
    || `<tr><td colspan="6" class="empty">Never tested.</td></tr>`;

  const credential = u.secret_stored
    ? `<span class="badge ok">stored ••••${esc(u.secret_hint || '')}</span>
       <span class="badge mute">key ${esc(u.secret_key_id || '')}</span>
       <div class="t2" style="margin-top:4px">Encrypted ${fmtDate(u.secret_set_at)}${
         u.secret_set_by ? ' by ' + esc(u.secret_set_by) : ''}</div>`
    : u.auth_value_env
      ? `${mono(u.auth_value_env)} <div class="t2" style="margin-top:4px">Resolved from the environment at boot.</div>`
      : '<span class="badge warn">no credential configured</span>';

  const body = `
${pageHead(u.display_name || u.name, esc(u.notes || 'A supplier API. Never visible to a vendor.'),
  `<a class="btn" href="/admin/catalog/upstreams">← Supplier APIs</a>
   <a class="btn" href="/admin/catalog/upstream/${esc(u.name)}/postman">Postman collection</a>
   <a class="btn" href="/admin/studio">Open the Studio</a>`)}

<div class="sum">
  <div class="stat"><div class="l">Endpoints</div><div class="n">${fmtNum(u.counts.total || 0)}</div></div>
  <div class="stat good"><div class="l">Live</div><div class="n">${fmtNum(u.counts.live || 0)}</div></div>
  <div class="stat"><div class="l">Draft</div><div class="n">${fmtNum(u.counts.draft || 0)}</div></div>
  <div class="stat ${Number(u.counts.unfiltered) > 0 ? 'alert' : 'good'}">
    <div class="l">Unfiltered</div><div class="n">${fmtNum(u.counts.unfiltered || 0)}</div></div>
  <div class="stat"><div class="l">Last test</div>
    <div class="n" style="font-size:15px;margin-top:8px">${u.last_test_status
      ? `<span class="badge ${u.last_test_status < 400 ? 'ok' : 'off'}">${esc(u.last_test_status)} · ${esc(u.last_test_ms || '?')}ms</span>`
      : '<span class="badge mute">never</span>'}</div></div>
</div>

${panel('The supplier', '', `<dl class="dl">
  ${row('Reference', mono(u.name))}
  ${row('Supplied by', esc(u.vendor_name || '—'))}
  ${row('Base URL', mono(u.base_url))}
  ${row('Timeout', `${fmtNum(u.timeout_ms)} ms`)}
  ${row('Authentication', esc(u.auth_type))}
  ${row('Credential', credential)}
  ${row('Enabled', u.enabled ? '<span class="badge ok">yes</span>' : '<span class="badge off">no — its endpoints are not routed</span>')}
  ${row('Last changed', `${fmtDate(u.updated_at)}${u.updated_by ? ' by ' + esc(u.updated_by) : ''}`)}
</dl>`)}

${tablePanel('Endpoints built on this supplier',
  'Everything a vendor can reach through it. Click one to see exactly what it exposes.',
  '<th>Endpoint</th><th>Vendors call</th><th>We forward to</th><th>Category</th><th>Status</th><th>Response</th><th class="num">Exposed</th>',
  epRows, String(eps.total))}
${pager('/admin/catalog/upstream/' + u.name, {}, eps)}

${tablePanel('Recent tests', '',
  '<th>When</th><th>Result</th><th class="num">Status</th><th class="num">Latency</th><th>By</th><th>Error</th>',
  testRows)}
<style>${CSS}</style>`;

  return layout({ title: u.display_name || u.name, admin, current: '/admin/catalog', body, flash });
}

module.exports.endpointDetail = endpointDetail;
module.exports.upstreamDetail = upstreamDetail;
