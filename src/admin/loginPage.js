'use strict';

/**
 * The login page, rendered server-side as one self-contained document.
 *
 * Styled to match the OmneNEST staging-api console and the rest of this admin
 * UI — cream surface, near-black primary, gold rule, Sora + JetBrains Mono.
 *
 * The font is the one external reference, and the BROWSER fetches it, not the
 * VM, so the VM's restricted egress does not come into it. If the viewer's
 * network blocks Google Fonts the page still renders in the system stack; no
 * layout depends on the webfont loading.
 *
 * `error` is the only interpolated value and it is escaped. It is also chosen
 * from a fixed set by the caller, never built from user input.
 */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function render({ error = '', title = '', email = '', brand: b = null } = {}) {
  // Name and tagline arrive as two values, from the settings an administrator
  // owns. They used to be one string that this function split by stripping a
  // trailing "API Gateway" — which produced the right answer only for names
  // ending that way, and quietly mangled every other one.
  const brand = (b && b.name) || title || 'Ashika - Pravah';
  const kicker = b ? b.tagline || '' : 'API Gateway';
  const full = kicker ? `${brand} ${kicker}` : brand;

  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in · ${esc(full)}</title>
<link rel="icon" href="/admin/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#f4f3f0; --surface:#fff; --surface2:#f9f8f6;
    --border:#e4e2dc; --ink:#1a1816; --ink2:#58554e; --ink3:#9e9b94;
    --gold:#b8860b; --gold-lt:#f7f0dc;
    --red:#c0392b; --red-lt:#fdf0ee;
    --blue:#1a4fa0;
    --sans:'Sora',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --r:6px; --r-lg:10px;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --bg:#111214; --surface:#1c1e21; --surface2:#242629;
    --border:#2e3035; --ink:#e8e9ea; --ink2:#9ca3af; --ink3:#6b7280;
    --gold-lt:rgba(234,179,8,.14); --red-lt:rgba(239,68,68,.14);
  }}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    padding:24px 16px;background:var(--bg);color:var(--ink);font-family:var(--sans);
    font-size:13px;line-height:1.55;-webkit-font-smoothing:antialiased}
  .card{width:100%;max-width:382px;background:var(--surface);border:1px solid var(--border);
    border-radius:var(--r-lg);padding:30px 28px 26px;overflow:hidden}
  .mark{display:block;width:52px;height:52px;margin:0 0 14px}
  .brand{display:block;font-size:19px;font-weight:600;letter-spacing:-.015em;color:var(--ink)}
  .kicker{display:block;margin-top:3px;font-size:9.5px;font-weight:600;color:var(--ink3);
    text-transform:uppercase;letter-spacing:1px}
  .rule{height:2px;width:34px;background:var(--gold);border-radius:2px;margin:15px 0 19px}
  .sub{margin:0 0 22px;color:var(--ink3);font-size:12px}
  label{display:block;font-size:10px;font-weight:700;text-transform:uppercase;
    letter-spacing:.6px;color:var(--ink3);margin:0 0 5px}
  input[type=email],input[type=password]{width:100%;padding:9px 11px;margin-bottom:15px;
    font-size:13px;font-family:inherit;color:var(--ink);background:var(--surface2);
    border:1px solid var(--border);border-radius:var(--r);outline:none;transition:border-color .15s}
  input:focus{border-color:var(--blue)}
  input:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
  button{width:100%;padding:10px;font-size:13px;font-weight:500;font-family:inherit;
    color:#fff;background:var(--ink);border:1px solid var(--ink);border-radius:var(--r);
    cursor:pointer;margin-top:3px;transition:background .15s}
  button:hover{background:#2d2b27}
  button:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
  .err{background:var(--red-lt);color:var(--red);border:1px solid var(--red);
    border-radius:var(--r);padding:10px 12px;margin-bottom:17px;font-size:12.5px}
  .foot{margin:21px 0 0;padding-top:15px;border-top:1px solid var(--border);
    color:var(--ink3);font-size:11px;text-align:center}
</style>
</head>
<body>
  <main class="card">
    <img class="mark" src="/admin/logo.png" alt="" width="52" height="52">
    <h1 style="margin:0"><span class="brand">${esc(brand)}</span>${
      kicker ? `<span class="kicker">${esc(kicker)}</span>` : ''
    }</h1>
    <div class="rule"></div>
    <p class="sub">Sign in to manage vendors and endpoints.</p>

    ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}

    <form method="post" action="/admin/login" autocomplete="on">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autofocus
             autocomplete="username" value="${esc(email)}" spellcheck="false">

      <label for="password">Password</label>
      <input id="password" name="password" type="password" required
             autocomplete="current-password">

      <button type="submit">Sign in</button>
    </form>

    <p class="foot">Access is restricted and every sign-in is logged.</p>
  </main>
</body>
</html>`;
}

module.exports = { render, esc };
