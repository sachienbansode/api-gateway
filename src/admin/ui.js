'use strict';

/**
 * Server-rendered admin screens.
 *
 * One stylesheet, no build step, no CDN. The VM's egress is locked down and a
 * console that depends on a third party is a console that breaks when that
 * third party does.
 *
 * Every value that reaches the page goes through `esc`. Vendor names, labels
 * and endpoint names are operator-supplied strings; one unescaped `<` in a
 * vendor name would be stored XSS against the person who can change what every
 * vendor sees.
 */

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

const STYLE = `
:root {
  --bg:#f4f5f7; --card:#fff; --fg:#1a1d23; --muted:#6b7280; --line:#dcdfe4;
  --accent:#1f3864; --accent-fg:#fff; --ok:#1a7f4b; --okbg:#e6f4ec;
  --warn:#8a5a00; --warnbg:#fdf3e0; --err:#a4231f; --errbg:#fdeaea;
  --focus:#2563eb; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#15171c; --card:#1d2026; --fg:#e8eaed; --muted:#9aa0a6; --line:#343842;
  --accent:#5b8def; --accent-fg:#0d1117; --ok:#5fd39b; --okbg:#143026;
  --warn:#e0b65c; --warnbg:#332a14; --err:#f1a9a6; --errbg:#3a1d1d;
  --focus:#7aa7ff;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
a{color:var(--accent)}
header{background:var(--card);border-bottom:1px solid var(--line);padding:0 20px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:13px 0;flex-wrap:wrap}
.brand{font-size:16px;font-weight:650;margin:0;letter-spacing:-.01em}
.who{color:var(--muted);font-size:13px}
nav{display:flex;gap:2px;flex-wrap:wrap}
nav a{display:block;padding:9px 14px;font-size:14px;text-decoration:none;
  color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px}
nav a:hover{color:var(--fg)}
nav a[aria-current="page"]{color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
main{max-width:1180px;margin:0 auto;padding:22px 16px 60px}
h2{font-size:17px;margin:0 0 3px}
.sub{color:var(--muted);font-size:13.5px;margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:18px;margin-bottom:18px}
.card>h3{margin:0 0 4px;font-size:14.5px}
.card>h3+p{margin:0 0 14px;color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-weight:600;color:var(--muted);font-size:12px;
  text-transform:uppercase;letter-spacing:.04em;padding:0 10px 8px;
  border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.mono{font-family:var(--mono);font-size:12.5px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;
  font-weight:600;white-space:nowrap}
.pill.ok{background:var(--okbg);color:var(--ok)}
.pill.off{background:var(--errbg);color:var(--err)}
.pill.warn{background:var(--warnbg);color:var(--warn)}
.pill.mute{background:var(--bg);color:var(--muted);border:1px solid var(--line)}
form.inline{display:inline}
button,.btn{font:inherit;font-size:13px;padding:7px 13px;border-radius:6px;
  border:1px solid var(--line);background:transparent;color:var(--fg);
  cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.btn:hover{border-color:var(--accent)}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);
  font-weight:600}
button.danger{color:var(--err);border-color:var(--line)}
button.danger:hover{border-color:var(--err)}
button:focus-visible,.btn:focus-visible,input:focus-visible,select:focus-visible{
  outline:2px solid var(--focus);outline-offset:1px}
label{display:block;font-size:12.5px;font-weight:600;margin:0 0 5px}
input[type=text],input[type=number],input[type=email],select{
  width:100%;padding:8px 10px;font:inherit;font-size:14px;color:var(--fg);
  background:var(--bg);border:1px solid var(--line);border-radius:6px}
.grid{display:grid;gap:13px;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
  align-items:end}
.hint{color:var(--muted);font-size:12px;margin:5px 0 0;font-weight:400}
.flash{padding:11px 14px;border-radius:8px;margin-bottom:16px;font-size:14px;
  border:1px solid}
.flash.ok{background:var(--okbg);color:var(--ok);border-color:var(--ok)}
.flash.err{background:var(--errbg);color:var(--err);border-color:var(--err)}
.key{font-family:var(--mono);font-size:13px;background:var(--bg);
  border:1px dashed var(--accent);border-radius:6px;padding:12px;
  word-break:break-all;margin:10px 0}
.empty{color:var(--muted);font-size:13.5px;padding:18px 2px}
.stats{display:grid;gap:13px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
  margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.stat .n{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.2}
.stat .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.ro{background:var(--warnbg);color:var(--warn);border:1px solid var(--warn);
  padding:9px 13px;border-radius:8px;font-size:13px;margin-bottom:16px}
@media(max-width:700px){.wrap{overflow-x:auto}}
`;

const TABS = [
  ['/admin', 'Overview'],
  ['/admin/vendors', 'Vendors'],
  ['/admin/endpoints', 'Endpoints'],
  ['/admin/activity', 'Activity'],
  ['/admin/health', 'Health'],
];

function layout({ title, admin, current, body, flash }) {
  const nav = TABS.map(
    ([href, label]) =>
      `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${esc(label)}</a>`
  ).join('');

  const flashHtml = flash
    ? `<div class="flash ${flash.kind === 'err' ? 'err' : 'ok'}">${esc(flash.text)}</div>`
    : '';

  const readOnly = admin.canEdit
    ? ''
    : `<div class="ro">You have read-only access. Changing anything needs the
       <strong>${esc(process.env.GATEWAY_PAGE_KEY || 'api-gateway')}:edit</strong> grant.</div>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${STYLE}</style>
</head><body>
<header>
  <div class="top">
    <h1 class="brand">${esc(process.env.ADMIN_TITLE || process.env.API_TITLE || 'Pravah API Gateway')}</h1>
    <div>
      <span class="who">${esc(admin.email)} · ${esc(admin.role || '')}</span>
      <form class="inline" method="post" action="/admin/logout" style="margin-left:10px">
        <button type="submit">Sign out</button>
      </form>
    </div>
  </div>
  <nav>${nav}</nav>
</header>
<main>${flashHtml}${readOnly}${body}</main>
</body></html>`;
}

const fmtDate = (d) =>
  d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '—';
const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));

module.exports = { esc, layout, fmtDate, fmtNum };
