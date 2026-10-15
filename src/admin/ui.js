'use strict';

/**
 * Admin console chrome.
 *
 * Styled to match the OmneNEST staging-api console, so the two read as one
 * product rather than two tools that happen to share a login. The tokens below
 * are lifted from that application's stylesheet — cream surface, near-black
 * primary, gold active state, Sora + JetBrains Mono, 6px/10px radii.
 *
 * Fonts come from Google Fonts, which the BROWSER fetches, not the VM — the
 * VM's restricted egress is irrelevant here. The stack still degrades to system
 * fonts if the request is blocked at the viewer's end.
 *
 * Everything that reaches the page goes through `esc`. Vendor names and labels
 * are operator-supplied; one unescaped `<` is stored XSS against the person who
 * can change what every vendor sees.
 */

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

const STYLE = `
:root{
  --bg:#f4f3f0; --surface:#fff; --surface2:#f9f8f6;
  --border:#e4e2dc; --border2:#ccc9c0;
  --ink:#1a1816; --ink2:#58554e; --ink3:#9e9b94;
  --gold:#b8860b; --gold-lt:#f7f0dc; --gold-md:#e8d49a;
  --red:#c0392b; --red-lt:#fdf0ee;
  --green:#1a6b3c; --green-lt:#eaf4ee;
  --blue:#1a4fa0; --blue-lt:#eef3fc;
  --sans:'Sora',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --r:6px; --r-lg:10px;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#111214; --surface:#1c1e21; --surface2:#242629;
  --border:#2e3035; --border2:#3a3d44;
  --ink:#e8e9ea; --ink2:#9ca3af; --ink3:#6b7280;
  --gold-lt:rgba(234,179,8,.14); --gold-md:rgba(234,179,8,.3);
  --red-lt:rgba(239,68,68,.14); --green-lt:rgba(34,197,94,.14);
  --blue-lt:rgba(59,130,246,.18);
}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
  font-size:13px;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}

/* ---------- shell ---------- */
.shell{display:grid;grid-template-columns:234px 1fr;min-height:100vh}
/* The aside itself STRETCHES to the full height of the grid row, so its
   background and border run the whole length of the page. Only its contents
   stick. Making the aside itself sticky with height:100vh left the column
   blank below the fold on any page taller than the viewport — which is most
   of them. */
aside{background:var(--surface);border-right:1px solid var(--border)}
aside>.inner{position:sticky;top:0;height:100vh;display:flex;flex-direction:column}
.logo{padding:16px 18px 14px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:11px}
.logo img{width:34px;height:34px;flex:none;display:block}
.logo .t{min-width:0}
.logo b{display:block;font-size:15px;font-weight:600;letter-spacing:-.01em;color:var(--ink);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.logo span{display:block;color:var(--ink3);font-size:9.5px;margin-top:2px;
  text-transform:uppercase;letter-spacing:.9px;font-weight:600}
.navsec{padding:14px 14px 6px;font-size:9.5px;font-weight:700;color:var(--ink3);
  text-transform:uppercase;letter-spacing:.9px}
aside nav{padding:6px 8px;flex:1}
aside nav a{display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:var(--r);
  color:var(--ink2);font-size:12.5px;font-weight:500;margin-bottom:1px}
aside nav a:hover{background:var(--surface2);color:var(--ink);text-decoration:none}
aside nav a[aria-current="page"]{background:var(--gold-lt);color:var(--ink);font-weight:600}
aside nav a[aria-current="page"] svg{color:var(--gold)}
aside nav a svg{width:15px;height:15px;flex:none;color:var(--ink3)}
aside nav a .tag{margin-left:auto;font-size:8.5px;font-weight:700;letter-spacing:.5px;
  color:var(--ink3);background:var(--surface2);border:1px solid var(--border);
  padding:1px 5px;border-radius:3px}
.who{padding:13px 16px;border-top:1px solid var(--border);font-size:11.5px}
.who .em{display:block;color:var(--ink);font-weight:500;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.who .rl{display:block;color:var(--ink3);margin-top:1px}
.who form{margin-top:9px}
.who button{width:100%;font-size:11.5px;padding:6px}

main{min-width:0;padding:22px 26px 60px;max-width:1500px}

/* ---------- page head ---------- */
.pg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;
  flex-wrap:wrap;margin-bottom:18px}
.pg-title{font-size:18px;font-weight:600;color:var(--ink);margin:0 0 4px;letter-spacing:-.01em}
.pg-sub{font-size:12px;color:var(--ink3);margin:0;max-width:78ch}
.pg-actions{display:flex;gap:8px;flex-wrap:wrap}

/* ---------- panels ---------- */
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);
  overflow:hidden;margin-bottom:14px}
.panel>.ph{padding:11px 15px;border-bottom:1px solid var(--border);
  background:var(--surface2);display:flex;align-items:center;justify-content:space-between;gap:12px}
.panel>.ph h3{margin:0;font-size:10.5px;font-weight:700;text-transform:uppercase;
  letter-spacing:.7px;color:var(--ink3)}
.panel>.ph .count{font-size:10.5px;color:var(--ink3);background:var(--surface);
  border:1px solid var(--border);border-radius:999px;padding:1px 9px;font-weight:600}
.panel>.pd{padding:15px}
.panel>.pd>:first-child{margin-top:0}
.panel>.pd>:last-child{margin-bottom:0}
.panel .note{margin:0;padding:11px 15px;border-bottom:1px solid var(--border);
  font-size:11.5px;color:var(--ink3);background:var(--surface)}

/* ---------- stats ---------- */
.stats{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));
  margin-bottom:16px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);
  padding:13px 15px}
.stat .l{color:var(--ink3);font-size:9.5px;text-transform:uppercase;letter-spacing:.8px;
  font-weight:700}
.stat .n{font-size:24px;font-weight:600;line-height:1.2;margin-top:5px;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.stat .n small{font-size:13px;color:var(--ink3);font-weight:400}
.stat.alert .n{color:var(--red)}
.stat.good .n{color:var(--green)}

/* ---------- tables ---------- */
.wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:8px 14px;border-bottom:2px solid var(--border);font-size:10px;
  font-weight:700;color:var(--ink3);text-transform:uppercase;letter-spacing:.6px;
  white-space:nowrap;background:var(--surface2)}
td{padding:10px 14px;border-bottom:1px solid var(--border);font-size:12px;vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--surface2)}
.num{text-align:right;font-variant-numeric:tabular-nums}
th.num{text-align:right}
.mono{font-family:var(--mono);font-size:11.5px}
.t1{font-weight:600;color:var(--ink)}
.t2{color:var(--ink3);font-size:11px;margin-top:1px}
.actions{text-align:right;white-space:nowrap}
.actions>*{margin-left:5px}

/* ---------- badges ---------- */
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10.5px;
  font-weight:600;white-space:nowrap;border:1px solid transparent;line-height:1.6}
.badge.ok{background:var(--green-lt);color:var(--green)}
.badge.off{background:var(--red-lt);color:var(--red)}
.badge.warn{background:var(--gold-lt);color:var(--gold)}
.badge.info{background:var(--blue-lt);color:var(--blue)}
.badge.mute{background:var(--surface2);color:var(--ink3);border-color:var(--border)}
.badges{display:flex;flex-wrap:wrap;gap:4px}

/* ---------- controls ---------- */
button,.btn{font-family:var(--sans);font-size:11.5px;padding:6px 12px;border-radius:var(--r);
  border:1px solid var(--border);background:var(--surface);color:var(--ink2);cursor:pointer;
  display:inline-block;font-weight:500;line-height:1.5;transition:background .15s,border-color .15s}
button:hover,.btn:hover{background:var(--surface2);color:var(--ink);text-decoration:none}
button.primary{background:var(--ink);color:#fff;border-color:var(--ink);font-weight:500;
  padding:7px 15px;font-size:12px}
button.primary:hover{background:#2d2b27;color:#fff}
button.danger{color:var(--red);border-color:var(--border)}
button.danger:hover{border-color:var(--red);background:var(--red-lt)}
button:focus-visible,.btn:focus-visible,input:focus-visible,select:focus-visible{
  outline:2px solid var(--blue);outline-offset:1px}
form.inline{display:inline}

/* Label + input + hint as one block, so a hint under one field can never
   knock its neighbours out of vertical alignment. */
.fields{display:grid;gap:14px 16px;grid-template-columns:repeat(auto-fit,minmax(205px,1fr))}
.f{display:flex;flex-direction:column;min-width:0}
.f label{display:block;font-size:10px;font-weight:700;text-transform:uppercase;
  letter-spacing:.6px;color:var(--ink3);margin-bottom:5px}
.f input,.f select{width:100%;border:1px solid var(--border);border-radius:var(--r);
  padding:7px 10px;font-size:12px;color:var(--ink);background:var(--surface2);
  outline:none;font-family:var(--sans);transition:border-color .15s}
.f input:focus,.f select:focus{border-color:var(--blue)}
.f .hint{color:var(--ink3);font-size:10.5px;margin-top:5px;line-height:1.45}
.f .hint:empty{display:none}
fieldset{border:0;padding:0;margin:18px 0 0;min-width:0}
fieldset legend{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;
  color:var(--ink3);padding:0;margin-bottom:8px}
.checks{display:flex;flex-wrap:wrap;gap:7px}
.checks label{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;
  border:1px solid var(--border);border-radius:var(--r);padding:6px 10px;cursor:pointer;
  background:var(--surface2);color:var(--ink2)}
.checks label:hover{border-color:var(--blue);color:var(--ink)}
.checks input{width:auto;margin:0;accent-color:var(--blue)}
.formfoot{margin-top:18px;padding-top:14px;border-top:1px solid var(--border);
  display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.formfoot .hint{color:var(--ink3);font-size:11px;margin:0}

/* ---------- messages ---------- */
.flash{padding:11px 14px;border-radius:var(--r);margin-bottom:16px;font-size:12.5px;
  border:1px solid}
.flash.ok{background:var(--green-lt);color:var(--green);border-color:var(--green)}
.flash.err{background:var(--red-lt);color:var(--red);border-color:var(--red)}
.flash strong{font-weight:600}
.key{font-family:var(--mono);font-size:12px;background:var(--surface2);color:var(--ink);
  border:1px dashed var(--gold);border-radius:var(--r);padding:11px 13px;
  word-break:break-all;margin:10px 0 0}
.empty{color:var(--ink3);font-size:12px;padding:30px 14px;text-align:center}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:var(--mono);
  font-size:11.5px;background:var(--surface2);border:1px solid var(--border);
  border-radius:var(--r);padding:13px;max-height:440px;overflow:auto;color:var(--ink2)}

/* ---------- confirmation ---------- */
.confirm-ovl{position:fixed;inset:0;background:rgba(26,24,22,.42);display:flex;
  align-items:center;justify-content:center;z-index:120;padding:20px}
.confirm-ovl[hidden]{display:none}
.confirm-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);
  width:100%;max-width:440px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.18)}
.confirm-card .ch{padding:13px 17px;border-bottom:1px solid var(--border);background:var(--surface2)}
.confirm-card .ch h3{margin:0;font-size:13px;font-weight:600;color:var(--ink)}
.confirm-card .cb{padding:16px 17px}
.confirm-card .cb p{margin:0;font-size:12.5px;color:var(--ink2);line-height:1.55}
.confirm-card .cf{padding:12px 17px;border-top:1px solid var(--border);display:flex;
  justify-content:flex-end;gap:8px;background:var(--surface2)}

@media(max-width:900px){
  .shell{grid-template-columns:1fr}
  aside>.inner{position:static;height:auto}
  aside nav{display:flex;overflow-x:auto;padding:6px}
  aside nav a{white-space:nowrap}
  .navsec{display:none}
  .who{display:flex;align-items:center;gap:12px;justify-content:space-between}
  .who form{margin:0}.who button{width:auto;padding:6px 13px}
  main{padding:18px 14px 44px}
}
`;

const ICON = {
  overview:
    '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z"/>',
  vendors:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
  endpoints:
    '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  studio:
    '<path d="M12 2 4 6v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6z" opacity=".25"/>' +
    '<path d="M9.5 12.5 11 14l3.5-3.5"/>',
  catalog:
    '<path d="M4 5h16v14H4z" opacity=".25"/><path d="M4 9h16M9 9v10"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  health:
    '<circle cx="12" cy="12" r="9" opacity=".3"/><path d="M8 12h2l1.5 4 2-8L15 12h2"/>',
};

const TABS = [
  ['/admin', 'Overview', 'overview', 'LIVE'],
  ['/admin/studio', 'API Studio', 'studio', 'BUILD'],
  ['/admin/catalog', 'Catalogue', 'catalog', 'DATA'],
  ['/admin/vendors', 'Vendors', 'vendors', 'MGMT'],
  ['/admin/endpoints', 'Endpoints', 'endpoints', 'CFG'],
  ['/admin/activity', 'Activity', 'activity', 'LOGS'],
  ['/admin/health', 'Health', 'health', ''],
];

function svg(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
}

function layout({ title, admin, current, body, flash }) {
  const nav = TABS.map(
    ([href, label, icon, tag]) =>
      `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${svg(icon)}` +
      `<span>${esc(label)}</span>${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</a>`
  ).join('');

  const flashHtml = flash
    ? `<div class="flash ${flash.kind === 'err' ? 'err' : 'ok'}">${esc(flash.text)}</div>`
    : '';

  const readOnly = admin.canEdit
    ? ''
    : `<div class="flash err">Read-only access. Changing anything needs the
       <strong>${esc(process.env.GATEWAY_PAGE_KEY || 'api-gateway')}:edit</strong> grant.</div>`;

  const full = process.env.ADMIN_TITLE || process.env.API_TITLE || 'Pravah API Gateway';
  const brand = esc(full.replace(/\s*API\s*Gateway\s*$/i, '').trim() || full);

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · ${esc(full)}</title>
<link rel="icon" href="/admin/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head><body>
<div class="shell">
  <aside><div class="inner">
    <div class="logo">
      <img src="/admin/logo.png" alt="" width="34" height="34">
      <div class="t"><b>${brand}</b><span>API Gateway</span></div>
    </div>
    <div class="navsec">Gateway</div>
    <nav>${nav}</nav>
    <div class="who">
      <span class="em" title="${esc(admin.email)}">${esc(admin.email)}</span>
      <span class="rl">${esc(admin.role || '')}${admin.canEdit ? '' : ' · read only'}</span>
      <form method="post" action="/admin/logout"><button type="submit">Sign out</button></form>
    </div>
  </div></aside>
  <main>${flashHtml}${readOnly}${body}</main>
</div>
<script>
/* Any submit button carrying data-confirm asks first, in the console's own
   dialog rather than the browser's. The question names the consequence — what
   publishing exposes, what withdrawing stops — because "Are you sure?" is a
   question nobody can answer usefully. */
(function () {
  var ovl = document.createElement('div');
  ovl.className = 'confirm-ovl';
  ovl.hidden = true;
  ovl.innerHTML = '<div class="confirm-card" role="dialog" aria-modal="true">' +
    '<div class="ch"><h3></h3></div><div class="cb"><p></p></div>' +
    '<div class="cf"><button type="button" class="no">Cancel</button>' +
    '<button type="button" class="yes primary">Confirm</button></div></div>';
  document.body.appendChild(ovl);
  var title = ovl.querySelector('h3'), body = ovl.querySelector('.cb p');
  var yes = ovl.querySelector('.yes'), no = ovl.querySelector('.no');
  var pending = null;

  function close() { ovl.hidden = true; pending = null; }
  no.addEventListener('click', close);
  ovl.addEventListener('mousedown', function (e) { if (e.target === ovl) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !ovl.hidden) close();
  });
  yes.addEventListener('click', function () {
    if (!pending) return;
    var btn = pending; pending = null; ovl.hidden = true;
    btn.dataset.confirmed = '1';
    btn.click();
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-confirm]') : null;
    if (!btn || btn.dataset.confirmed) return;
    e.preventDefault();
    e.stopPropagation();
    title.textContent = btn.getAttribute('data-confirm');
    body.textContent = btn.getAttribute('data-confirm-body') || '';
    yes.textContent = btn.getAttribute('data-confirm-ok') || 'Confirm';
    yes.className = btn.classList.contains('danger') ? 'yes danger' : 'yes primary';
    pending = btn;
    ovl.hidden = false;
    yes.focus();
  }, true);
})();
</script>
</body></html>`;
}

/** Page title block. `actions` is optional right-aligned HTML. */
function pageHead(title, sub, actions = '') {
  return `<div class="pg-head"><div>
      <h2 class="pg-title">${esc(title)}</h2><p class="pg-sub">${sub}</p>
    </div>${actions ? `<div class="pg-actions">${actions}</div>` : ''}</div>`;
}

function panel(heading, note, bodyHtml, count = '') {
  return `<section class="panel">
    ${heading
      ? `<div class="ph"><h3>${esc(heading)}</h3>${count ? `<span class="count">${esc(count)}</span>` : ''}</div>`
      : ''}
    ${note ? `<p class="note">${note}</p>` : ''}
    <div class="pd">${bodyHtml}</div>
  </section>`;
}

/** A table that fills its panel edge to edge, with no double padding. */
function tablePanel(heading, note, head, rowsHtml, count = '') {
  return `<section class="panel">
    ${heading
      ? `<div class="ph"><h3>${esc(heading)}</h3>${count ? `<span class="count">${esc(count)}</span>` : ''}</div>`
      : ''}
    ${note ? `<p class="note">${note}</p>` : ''}
    <div class="wrap"><table><thead><tr>${head}</tr></thead><tbody>${rowsHtml}</tbody></table></div>
  </section>`;
}

const fmtDate = (d) => {
  if (!d) return '—';
  const x = new Date(d);
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][x.getUTCMonth()];
  const p = (n) => String(n).padStart(2, '0');
  return `${p(x.getUTCDate())}-${m}-${x.getUTCFullYear()} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}`;
};
const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));

module.exports = { esc, layout, pageHead, panel, tablePanel, fmtDate, fmtNum };
