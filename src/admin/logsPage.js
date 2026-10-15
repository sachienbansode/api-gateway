'use strict';

const { esc, layout, pageHead, panel, tablePanel, fmtDate, fmtNum } = require('./ui');

/**
 * Logs: what consumers called, and what administrators changed.
 *
 * Two screens rather than one, because they answer different questions at
 * different volumes. Traffic is thousands of rows a day and is read when
 * something is wrong RIGHT NOW. Changes is a handful a week and is read when
 * somebody asks who did something, often months later.
 *
 * Both default to the recent window rather than to everything. A log screen
 * that opens on "all time" spends its first query sorting a year of rows to
 * show twenty-five of them.
 */

const WINDOWS = [
  ['1h', 'Last hour'], ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'Everything'],
];

function qs(query, extra = {}) {
  const merged = { ...query, ...extra };
  const parts = Object.entries(merged)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? '?' + parts.join('&') : '';
}

function select(name, label, options, value, blank) {
  const opts = [`<option value="">${esc(blank)}</option>`].concat(
    options.map((o) =>
      `<option value="${esc(o.code)}"${String(o.code) === String(value || '') ? ' selected' : ''}>` +
      `${esc(o.label || o.code)}${o.n !== undefined ? ` (${fmtNum(o.n)})` : ''}</option>`)
  );
  return `<div class="f"><label for="f_${name}">${esc(label)}</label>
    <select id="f_${name}" name="${name}">${opts.join('')}</select></div>`;
}

/** Shared pager. Keeps every filter in the link, which is the whole point. */
function pager(base, query, p) {
  if (p.total === 0) return '';
  const from = (p.page - 1) * p.size + 1;
  const to = Math.min(p.total, p.page * p.size);
  const link = (n, label = String(n), cur = false) =>
    cur ? `<span class="cur">${label}</span>`
        : `<a href="${base}${qs(query, { page: n })}">${label}</a>`;
  const nums = [];
  const window = 2;
  for (let n = 1; n <= p.pages; n++) {
    if (n === 1 || n === p.pages || Math.abs(n - p.page) <= window) {
      nums.push(link(n, String(n), n === p.page));
    } else if (nums[nums.length - 1] !== '<span class="gap">…</span>') {
      nums.push('<span class="gap">…</span>');
    }
  }
  return `<div class="pager">
    <span class="n">${fmtNum(from)}–${fmtNum(to)} of ${fmtNum(p.total)}</span>
    <span class="pages">
      ${p.page > 1 ? link(p.page - 1, '‹') : ''}${nums.join('')}${p.page < p.pages ? link(p.page + 1, '›') : ''}
    </span></div>`;
}

function tabs(current) {
  const t = [['/admin/logs', 'Traffic'], ['/admin/logs/changes', 'Changes']];
  return `<div class="tabs">${t.map(([href, label]) =>
    `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${esc(label)}</a>`
  ).join('')}</div>`;
}

function statusCell(s) {
  if (s === null || s === undefined) return '<span class="t2">—</span>';
  const kind = s >= 500 ? 'off' : s >= 400 ? 'warn' : 'ok';
  return `<span class="badge ${kind}">${s}</span>`;
}

/** Latency, coloured only where it is worth a second look. */
function msCell(ms) {
  if (ms === null || ms === undefined) return '<span class="t2">—</span>';
  const slow = ms >= 3000;
  return `<span class="${slow ? 'slow' : ''}">${fmtNum(ms)} ms</span>`;
}

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------
function trafficPage({ admin, flash, page: p, summary, facets, query }) {
  const errRate = summary.calls
    ? ((summary.errors / summary.calls) * 100).toFixed(1) : '0.0';

  const rows = p.rows.map((r) => `
    <tr>
      <td class="t2 nowrap">${fmtDate(r.occurred_at)}</td>
      <td>${r.endpoint
        ? `<div class="t1">${esc(r.endpoint)}</div>`
        : '<div class="t2">no matching endpoint</div>'}
        <div class="t2 mono">${esc(r.method || '')} ${esc(r.path || '')}</div></td>
      <td class="t2">${esc(r.vendor_id || '—')}</td>
      <td>${statusCell(r.status)}${r.error_code
        ? `<div class="t2">${esc(r.error_code)}</div>` : ''}</td>
      <td class="num">${msCell(r.total_ms)}${r.upstream_ms !== null && r.upstream_ms !== undefined
        ? `<div class="t2">${fmtNum(r.upstream_ms)} ms upstream</div>` : ''}</td>
      <td class="t2 mono">${esc(r.client_ip || '—')}</td>
      <td class="actions">
        <a class="btn" href="/admin/logs?q=${encodeURIComponent(r.request_id)}"
           title="Every row for this request id">${esc(String(r.request_id).slice(0, 8))}</a></td>
    </tr>
    ${r.internal_reason ? `<tr class="why"><td colspan="7">
      <span class="t2">Why it failed, for your eyes — never sent to the consumer:</span>
      ${esc(r.internal_reason)}</td></tr>` : ''}`).join('')
    || `<tr><td colspan="7" class="empty">No calls in this window${
      query.q || query.consumer || query.endpoint || query.status ? ' matching these filters' : ''}.</td></tr>`;

  const body = `
${pageHead('Logs', 'Every call a consumer made, and everything an administrator changed.')}
${tabs('/admin/logs')}

<div class="sum">
  <div class="stat"><div class="l">Calls</div><div class="n">${fmtNum(summary.calls || 0)}</div></div>
  <div class="stat ${Number(errRate) > 5 ? 'alert' : ''}">
    <div class="l">Errors</div><div class="n">${errRate}<small>%</small></div></div>
  <div class="stat"><div class="l">Consumers</div><div class="n">${fmtNum(summary.consumers || 0)}</div></div>
  <div class="stat"><div class="l">Endpoints</div><div class="n">${fmtNum(summary.endpoints || 0)}</div></div>
  <div class="stat"><div class="l">Typical call</div><div class="n">${fmtNum(summary.p50_ms || 0)}<small> ms</small></div></div>
  <div class="stat ${Number(summary.p95_ms) >= 3000 ? 'alert' : ''}">
    <div class="l">1 in 20 took</div><div class="n">${fmtNum(summary.p95_ms || 0)}<small> ms or more</small></div></div>
  <div class="stat ${Number(summary.max_ms) >= 10000 ? 'alert' : ''}">
    <div class="l">Worst</div><div class="n">${fmtNum(summary.max_ms || 0)}<small> ms</small></div></div>
</div>

<form class="filters" method="get" action="/admin/logs">
  <div class="f"><label for="f_q">Search</label>
    <input id="f_q" name="q" type="search" value="${esc(query.q || '')}"
      placeholder="path, endpoint, or a request id"></div>
  ${select('since', 'Window', WINDOWS.map(([c, l]) => ({ code: c, label: l })), query.since || '24h', 'Last 24 hours')}
  ${select('consumer', 'Consumer', facets.consumers, query.consumer, 'All consumers')}
  ${select('endpoint', 'Endpoint', facets.endpoints, query.endpoint, 'All endpoints')}
  ${select('status', 'Outcome', [
    { code: 'ok', label: 'Succeeded' }, { code: 'error', label: 'Any error' },
    { code: 'client', label: 'Refused (4xx)' }, { code: 'server', label: 'Failed (5xx)' },
  ], query.status, 'Any outcome')}
  <div class="f acts"><button type="submit" class="primary">Filter</button>
    <a class="btn" href="/admin/logs">Clear</a></div>
</form>

<section class="panel">
  <div class="wrap"><table class="logs">
    <thead><tr>
      <th>When</th><th>Endpoint</th><th>Consumer</th><th>Status</th>
      <th class="num">Took</th><th>From</th><th class="actions">Request</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  ${pager('/admin/logs', query, p)}
</section>
<style>${CSS}</style>`;

  return layout({ title: 'Traffic', admin, current: '/admin/logs', body, flash });
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------
function changesPage({ admin, flash, page: p, facets, query }) {
  const areaBadge = (a) => {
    const kind = a === 'credential' ? 'warn' : a === 'settings' ? 'mute' : 'ok';
    return `<span class="badge ${kind}">${esc(a)}</span>`;
  };

  const rows = p.rows.map((r) => `
    <tr>
      <td class="t2 nowrap">${fmtDate(r.occurred_at)}</td>
      <td>${esc(r.actor)}</td>
      <td>${areaBadge(r.area)}</td>
      <td><div class="t1">${esc(r.action)}</div>
          <div class="t2">${esc(r.object_kind)}</div></td>
      <td class="mono">${esc(r.object || '—')}</td>
      <td class="t2">${r.detail ? esc(r.detail) : ''}</td>
      <td class="actions">${r.source === 'catalog_audit' && r.has_diff
        ? `<a class="btn" href="/admin/logs/changes/${r.source_id}">Diff</a>` : ''}</td>
    </tr>`).join('')
    || `<tr><td colspan="7" class="empty">${p.missing
      ? 'The change log view has not been created yet — run migration 013.'
      : 'Nothing was changed in this window.'}</td></tr>`;

  const body = `
${pageHead('Logs', 'Every call a consumer made, and everything an administrator changed.')}
${tabs('/admin/logs/changes')}

${panel('What this covers', '', `<p class="note" style="margin:0">
  Endpoints published or withdrawn, supplier APIs added or edited, credentials set,
  replaced, removed or <strong>read</strong>, and every change to Admin config —
  in one timeline. Reading a credential leaves no other trace, which is why it is
  recorded here beside the changes.</p>`)}

<form class="filters" method="get" action="/admin/logs/changes">
  <div class="f"><label for="f_q">Search</label>
    <input id="f_q" name="q" type="search" value="${esc(query.q || '')}"
      placeholder="who, what, or which object"></div>
  ${select('since', 'Window', WINDOWS.map(([c, l]) => ({ code: c, label: l })), query.since || '30d', 'Last 30 days')}
  ${select('actor', 'Who', facets.actors, query.actor, 'Anyone')}
  ${select('area', 'Area', facets.areas, query.area, 'Everything')}
  <div class="f acts"><button type="submit" class="primary">Filter</button>
    <a class="btn" href="/admin/logs/changes">Clear</a></div>
</form>

<section class="panel">
  <div class="wrap"><table class="logs">
    <thead><tr>
      <th>When</th><th>Who</th><th>Area</th><th>Action</th><th>Object</th>
      <th>Detail</th><th class="actions"></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  ${pager('/admin/logs/changes', query, p)}
</section>
<style>${CSS}</style>`;

  return layout({ title: 'Changes', admin, current: '/admin/logs', body, flash });
}

// ---------------------------------------------------------------------------
// One catalogue change, in full
// ---------------------------------------------------------------------------
function diffPage({ admin, flash, row }) {
  const fmt = (v) => (v ? esc(JSON.stringify(v, null, 2)) : '<em>nothing</em>');
  const body = `
${pageHead(`${row.action} · ${row.object_id}`,
  `${esc(row.actor)} · ${fmtDate(row.occurred_at)}`,
  '<a class="btn" href="/admin/logs/changes">← All changes</a>')}

<div class="split">
  ${panel('Before', '', `<pre>${fmt(row.before)}</pre>`)}
  ${panel('After', '', `<pre>${fmt(row.after)}</pre>`)}
</div>
<style>${CSS}
.split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.split pre{max-height:520px;overflow:auto;font-size:11px;margin:0}
@media(max-width:1000px){.split{grid-template-columns:1fr}}
</style>`;
  return layout({ title: 'Change', admin, current: '/admin/logs', body, flash });
}

const CSS = `
.filters{display:grid;gap:10px;grid-template-columns:2fr repeat(4,1fr) auto;align-items:end;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);
  padding:13px 15px;margin-bottom:14px}
@media(max-width:1100px){.filters{grid-template-columns:1fr 1fr}}
.filters .f{min-width:0}
.filters .acts{display:flex;gap:7px}
.tabs{display:flex;gap:2px;margin-bottom:14px;border-bottom:1px solid var(--border)}
.tabs a{padding:8px 14px;font-size:12.5px;color:var(--ink3);border-bottom:2px solid transparent;
  margin-bottom:-1px;text-decoration:none}
.tabs a:hover{color:var(--ink);text-decoration:none}
.tabs a[aria-current]{color:var(--ink);font-weight:600;border-bottom-color:var(--gold)}
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
.sum{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));margin-bottom:14px}

/* Fixed layout for the same reason as the catalogue: the automatic algorithm
   sizes to the longest path and pushes the last column off the edge. */
table.logs{table-layout:fixed;width:100%}
table.logs th:nth-child(1),table.logs td:nth-child(1){width:13%}
table.logs th:nth-child(3),table.logs td:nth-child(3){width:11%}
table.logs th:nth-child(4),table.logs td:nth-child(4){width:10%}
table.logs th:nth-child(5),table.logs td:nth-child(5){width:12%}
table.logs th:nth-child(6),table.logs td:nth-child(6){width:12%}
table.logs th:nth-child(7),table.logs td:nth-child(7){width:11%}
table.logs td{word-break:break-word}
table.logs td.actions{text-align:right;white-space:nowrap}
table.logs td.actions .btn{padding:3px 7px;font-size:11px;font-family:var(--mono)}
.nowrap{white-space:nowrap}
.slow{color:var(--red);font-weight:600}
tr.why td{background:var(--red-lt);font-size:11.5px;color:var(--ink);
  border-top:0;padding-top:0;padding-bottom:9px}
tr.why .t2{display:block;margin-bottom:2px}
`;

module.exports = { trafficPage, changesPage, diffPage, WINDOWS };
