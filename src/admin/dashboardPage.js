'use strict';

const { esc, layout, pageHead, panel, tablePanel, fmtNum } = require('./ui');
const charts = require('./charts');

/**
 * Overview, and Health.
 *
 * Both were replacing a page that dumped a JSON blob, which is a way of saying
 * "the data is here somewhere" rather than answering anything. The test for
 * every tile below is whether somebody could act on it: a number nobody would
 * do anything about is decoration, however impressive it looks.
 *
 * The order is deliberate — what is broken, then what is happening, then what
 * is exposed. Somebody opening this at 2am is looking for the first of those.
 */

const WINDOWS = [['1h', 'Last hour'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']];

function windowPicker(base, since) {
  return `<div class="winpick">${WINDOWS.map(([c, l]) =>
    `<a href="${base}?since=${c}"${c === since ? ' aria-current="page"' : ''}>${esc(l)}</a>`
  ).join('')}</div>`;
}

/** good | warning | critical — status, never a series colour. */
function pill(state, text) {
  return `<span class="pill ${state}"><span class="dot"></span>${esc(text)}</span>`;
}

function stat(label, value, { sub = '', alert = false, href = null } = {}) {
  const inner = `<div class="l">${esc(label)}</div>
    <div class="n">${value}${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  return href
    ? `<a class="stat ${alert ? 'alert' : ''}" href="${href}">${inner}</a>`
    : `<div class="stat ${alert ? 'alert' : ''}">${inner}</div>`;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
function overviewPage({
  admin, flash, since, summary, series, topEndpoints, slowest, topConsumers,
  errors, health, exposure, consumers,
}) {
  const errRate = summary.calls ? (summary.errors / summary.calls) * 100 : 0;
  const breakers = Object.entries(health.upstreams || {});
  const open = breakers.filter(([, b]) => b.state === 'open');
  const dbOk = !health.database || health.database.ok !== false;
  const dropped = Number(health.audit?.dropped || 0);

  // Only shown when there IS something wrong. A permanent green "all good"
  // banner trains people to stop reading the top of the page.
  const problems = [];
  if (open.length) {
    problems.push(`${open.length} supplier API ${open.length === 1 ? 'is' : 'are'} being skipped —
      <a href="/admin/health">${esc(open.map(([n]) => n).join(', '))}</a>`);
  }
  if (!dbOk) problems.push('The gateway database is not answering.');
  if (dropped > 0) {
    problems.push(`${fmtNum(dropped)} audit row(s) were dropped — calls are being served but not
      fully recorded.`);
  }
  if (errRate >= 10 && summary.calls >= 20) {
    problems.push(`${errRate.toFixed(1)}% of calls failed in this window —
      <a href="/admin/logs?status=error&since=${esc(since)}">see which</a>.`);
  }
  if (exposure.unfiltered > 0) {
    problems.push(`${exposure.unfiltered} live endpoint(s) forward the supplier response without a
      whitelist, so a field added upstream reaches consumers the day it appears.`);
  }

  const body = `
${pageHead('Overview', 'What this gateway is doing, and anything that needs attention.',
  windowPicker('/admin', since))}

${problems.length ? `<div class="alerts">${problems.map((p) =>
  `<div class="al"><span class="dot critical"></span><div>${p}</div></div>`).join('')}</div>` : ''}

<div class="sum">
  ${stat('Calls', fmtNum(summary.calls || 0), { href: `/admin/logs?since=${since}` })}
  ${stat('Failed', `${errRate.toFixed(1)}`, {
    sub: '%', alert: errRate >= 5 && summary.calls >= 20,
    href: `/admin/logs?status=error&since=${since}`,
  })}
  ${stat('Typical call', fmtNum(summary.p50_ms || 0), { sub: ' ms' })}
  ${stat('1 in 20 took', fmtNum(summary.p95_ms || 0), {
    sub: ' ms or more', alert: Number(summary.p95_ms) >= 3000 })}
  ${stat('Consumers calling', fmtNum(summary.consumers || 0), { href: '/admin/consumers' })}
  ${stat('Live endpoints', fmtNum(exposure.live || 0), { href: '/admin/catalog?status=live' })}
</div>

${panel('Calls over time', '', charts.callsOverTime(series, { since }))}

<div class="two">
  ${panel('Busiest endpoints', '', charts.rankedBars(topEndpoints, {
    labelKey: 'endpoint', valueKey: 'calls',
    secondary: (r) => (r.errors ? `${fmtNum(r.errors)} failed` : ''),
  }))}
  ${panel('Slowest endpoints', '95th percentile — the unlucky one call in twenty.',
    charts.rankedBars(slowest, {
      labelKey: 'endpoint', valueKey: 'p95_ms', unit: ' ms', tone: 'bad',
      secondary: (r) => `median ${fmtNum(r.p50_ms)} ms`,
    }))}
</div>

<div class="two">
  ${tablePanel('What went wrong',
    errors.length ? '' : 'Nothing failed in this window.',
    '<th>Reason</th><th class="num">Calls</th><th></th>',
    errors.map((e) => `<tr>
      <td class="mono">${esc(e.code)}</td>
      <td class="num">${fmtNum(e.n)}</td>
      <td class="actions"><a class="btn" href="/admin/logs?status=error&since=${esc(since)}">Look</a></td>
    </tr>`).join('') || '<tr><td colspan="3" class="empty">No failures.</td></tr>')}

  ${tablePanel('Who is calling', '',
    '<th>Consumer</th><th class="num">Calls</th><th class="num">Endpoints</th><th class="num">Failed</th>',
    topConsumers.map((c) => `<tr>
      <td class="t1">${esc(c.consumer)}</td>
      <td class="num">${fmtNum(c.calls)}</td>
      <td class="num">${fmtNum(c.endpoints)}</td>
      <td class="num">${c.errors ? `<span class="bad-n">${fmtNum(c.errors)}</span>` : '0'}</td>
    </tr>`).join('') || `<tr><td colspan="4" class="empty">Nobody has called in this window.</td></tr>`)}
</div>

${tablePanel('Supplier APIs',
  'A breaker opens when a supplier keeps failing, so the gateway stops calling it rather than making every consumer wait for a timeout.',
  '<th>Supplier</th><th>State</th><th class="num">Recent failures</th><th></th>',
  breakers.map(([name, b]) => `<tr>
    <td class="t1 mono">${esc(name)}</td>
    <td>${b.state === 'open' ? pill('critical', 'skipping calls')
      : b.state === 'half-open' ? pill('warning', 'trying again')
      : pill('good', 'healthy')}</td>
    <td class="num">${fmtNum(b.failures || 0)}</td>
    <td class="actions"><a class="btn" href="/admin/catalog/upstream/${esc(name)}">Open</a></td>
  </tr>`).join('') || '<tr><td colspan="4" class="empty">No supplier APIs configured.</td></tr>')}

${panel('What consumers can see', '', `
  <div class="expo">
    <div><div class="l">Built field by field</div>
      <div class="n">${fmtNum(exposure.whitelisted)}<small> of ${fmtNum(exposure.live)} live</small></div>
      <p class="hint">A field added upstream cannot appear, because nothing copies it.</p></div>
    <div class="${exposure.unfiltered ? 'alert' : ''}"><div class="l">Forwarded unfiltered</div>
      <div class="n">${fmtNum(exposure.unfiltered)}</div>
      <p class="hint">${exposure.unfiltered
        ? 'These are not protected against a supplier adding a field.'
        : 'Nothing forwards a supplier response as-is.'}</p></div>
    <div><div class="l">Drafts</div>
      <div class="n">${fmtNum(exposure.draft)}</div>
      <p class="hint">Built but deliberately not routed, so nobody can reach them.</p></div>
  </div>`)}

<style>${charts.PALETTE}${CSS}</style>`;

  return layout({ title: 'Overview', admin, current: '/admin', body, flash });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
function healthPage({ admin, flash, health, cfg, mail, process: proc, settingsSource }) {
  const breakers = Object.entries(health.upstreams || {});
  const open = breakers.filter(([, b]) => b.state === 'open');
  const dbOk = health.database && health.database.ok !== false;
  const dropped = Number(health.audit?.dropped || 0);
  const serving = !open.length && dbOk !== false && dropped === 0;

  const row = (name, state, text, detail) => `<tr>
    <td class="t1">${esc(name)}</td>
    <td>${pill(state, text)}</td>
    <td class="t2">${detail}</td></tr>`;

  const dep = [
    row('Gateway database',
      health.database?.enabled === false ? 'warning' : dbOk ? 'good' : 'critical',
      health.database?.enabled === false ? 'not configured' : dbOk ? 'connected' : 'not answering',
      health.database?.enabled === false
        ? 'Running on the files in <span class="mono">config/</span> alone — nothing built in the Studio is being served.'
        : dbOk ? `Answered in ${fmtNum(health.database.ms || 0)} ms.`
        : esc(health.database?.error || 'The gateway cannot reach its own database.')),
    row('Consumer keys',
      health.vendorStore?.source === 'database' ? 'good' : 'warning',
      health.vendorStore?.source === 'database' ? 'from the database' : 'from files',
      health.vendorStore?.lastRefreshError
        ? `<span class="bad-n">${esc(health.vendorStore.lastRefreshError)}</span> — serving the last good copy.`
        : `${fmtNum(health.vendorStore?.vendors || 0)} consumer(s), ${fmtNum(health.vendorStore?.liveKeys || 0)} live key(s).`),
    row('Audit queue', dropped ? 'critical' : 'good',
      dropped ? `${fmtNum(dropped)} dropped` : 'keeping up',
      dropped
        ? 'Calls are being served but not fully recorded. The log is incomplete for this period.'
        : `${fmtNum(health.audit?.written || 0)} row(s) written.`),
    row('Mail', mail.ok ? 'good' : 'warning',
      mail.ok ? 'working' : 'not usable',
      mail.ok
        ? `Sign-in codes go out through <span class="mono">${esc(mail.host || '')}</span>${
            mail.source ? ` (${esc(mail.source)})` : ''}.`
        : `${esc(mail.reason || 'not configured')} — <a href="/admin/settings#mail">set it up</a>. Only accounts whose role needs a second factor are affected.`),
  ].join('');

  const body = `
${pageHead('Health', 'Whether this gateway can do its job right now, and what is in its way.')}

<div class="hero ${serving ? 'good' : 'bad'}">
  <div class="hero-state">${serving ? 'Serving normally' : 'Degraded'}</div>
  <p class="hero-why">${serving
    ? `All supplier APIs are answering, the database is connected and every call is being recorded.`
    : [
        open.length ? `${open.length} supplier API ${open.length === 1 ? 'is' : 'are'} being skipped` : '',
        dbOk === false ? 'the database is not answering' : '',
        dropped ? 'audit rows are being dropped' : '',
      ].filter(Boolean).join(', ') + '.'}</p>
  <p class="hero-sub">This is the same judgement <span class="mono">/readyz</span> gives your load
    balancer, which answers 503 while this says degraded.</p>
</div>

${tablePanel('Supplier APIs',
  'Closed is the healthy state: the gateway is calling the supplier normally. Open means it has stopped, on purpose, because the supplier kept failing.',
  '<th>Supplier</th><th>State</th><th class="num">Failures</th><th>What it means</th>',
  breakers.map(([name, b]) => `<tr>
    <td class="t1 mono">${esc(name)}</td>
    <td>${b.state === 'open' ? pill('critical', 'open')
      : b.state === 'half-open' ? pill('warning', 'half-open') : pill('good', 'closed')}</td>
    <td class="num">${fmtNum(b.failures || 0)}</td>
    <td class="t2">${b.state === 'open'
      ? 'Calls are failing fast rather than waiting for a timeout. It will try one call again shortly.'
      : b.state === 'half-open'
        ? 'Letting one call through to see whether the supplier has recovered.'
        : 'Calls are going through normally.'}</td>
  </tr>`).join('') || '<tr><td colspan="4" class="empty">No supplier APIs configured.</td></tr>')}

${tablePanel('What this gateway depends on', '',
  '<th>Thing</th><th>State</th><th>Detail</th>', dep)}

${tablePanel('This process', '',
  '<th>Thing</th><th>Value</th>', `
  <tr><td class="t1">Serving</td><td>${fmtNum(cfg.endpoints.length)} endpoint(s) from
    ${fmtNum(Object.keys(cfg.upstreams || {}).length)} supplier API(s)</td></tr>
  <tr><td class="t1">Running for</td><td>${esc(proc.uptime)}</td></tr>
  <tr><td class="t1">Memory</td><td>${fmtNum(proc.rssMb)} MB resident</td></tr>
  <tr><td class="t1">Node</td><td class="mono">${esc(proc.node)}</td></tr>
  <tr><td class="t1">Public base URL</td><td class="mono">${esc(settingsSource.baseUrl || 'not set')}
    ${settingsSource.baseUrl ? '' : '— <a href="/admin/settings">set one</a>'}</td></tr>`)}

<details class="raw">
  <summary>The raw <span class="mono">/readyz</span> payload</summary>
  <pre>${esc(JSON.stringify(health, null, 2))}</pre>
</details>

<style>${CSS}</style>`;

  return layout({ title: 'Health', admin, current: '/admin/health', body, flash });
}

const CSS = `
.winpick{display:flex;gap:2px}
.winpick a{padding:5px 11px;font-size:11.5px;color:var(--ink3);border:1px solid var(--border);
  background:var(--surface);text-decoration:none;border-radius:var(--r)}
.winpick a:hover{color:var(--ink);background:var(--surface2);text-decoration:none}
.winpick a[aria-current]{background:var(--ink);border-color:var(--ink);color:#fff;font-weight:600}

/* Status, with a dot AND a word — never colour alone. */
.pill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:500;
  border:1px solid var(--border);border-radius:999px;padding:2px 10px 2px 8px;color:var(--ink2);
  background:var(--surface2);white-space:nowrap}
.pill .dot{width:7px;height:7px;border-radius:50%;flex:none}
.pill.good .dot{background:#0ca30c}
.pill.warning .dot{background:#fab219}
.pill.critical .dot{background:#d03b3b}
.pill.critical{color:var(--red);border-color:var(--red)}
.dot.critical{display:inline-block;width:7px;height:7px;border-radius:50%;background:#d03b3b;
  flex:none;margin-top:6px}

.alerts{display:grid;gap:8px;margin-bottom:14px}
.al{display:flex;gap:10px;align-items:flex-start;background:var(--red-lt);
  border:1px solid var(--red);border-radius:var(--r);padding:10px 13px;
  font-size:12.5px;color:var(--ink);line-height:1.55}

.sum{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:14px}
a.stat{text-decoration:none;display:block;transition:border-color .15s}
a.stat:hover{border-color:var(--ink3);text-decoration:none}

.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:1100px){.two{grid-template-columns:1fr}}

.hero{border:1px solid var(--border);border-radius:var(--r-lg);padding:20px 22px;
  margin-bottom:14px;background:var(--surface)}
.hero.good{border-left:3px solid #0ca30c}
.hero.bad{border-left:3px solid #d03b3b;background:var(--red-lt)}
.hero-state{font-size:21px;font-weight:600;letter-spacing:-.015em;color:var(--ink)}
.hero-why{margin:5px 0 0;font-size:13px;color:var(--ink2)}
.hero-sub{margin:9px 0 0;font-size:11.5px;color:var(--ink3)}

.expo{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
.expo .l{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--ink3)}
.expo .n{font-size:25px;font-weight:600;color:var(--ink);margin-top:3px;letter-spacing:-.02em}
.expo .n small{font-size:12px;font-weight:400;color:var(--ink3);margin-left:4px}
.expo .hint{margin:4px 0 0}
.expo .alert .n{color:var(--red)}

.bad-n{color:var(--red);font-weight:600}
.raw{margin-top:14px}
.raw summary{font-size:11.5px;color:var(--ink3);cursor:pointer}
.raw pre{margin-top:9px;max-height:340px;overflow:auto;font-size:11px}
`;

module.exports = { overviewPage, healthPage, WINDOWS };
