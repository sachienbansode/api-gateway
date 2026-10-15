'use strict';

const { esc } = require('./loginPage');

/**
 * The second-factor screen.
 *
 * Deliberately the same card, type and colours as the login page: this is step
 * two of one action, not a different place. A screen that looks unfamiliar at
 * the moment someone is asked to type a code from an email is a screen people
 * are right to be suspicious of.
 *
 * `error` and `email` are the only interpolated values and both are escaped.
 */
function render({ error = '', title = '', email = '', minutes = 10, brand: b = null } = {}) {
  const brand = (b && b.name) || title || 'Ashika - Pravah';
  const kicker = b ? b.tagline || '' : 'API Gateway';
  const full = kicker ? `${brand} ${kicker}` : brand;

  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Enter your code · ${esc(full)}</title>
<link rel="icon" href="/admin/favicon.ico" sizes="any">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#f4f3f0; --surface:#fff; --surface2:#f9f8f6;
    --border:#e4e2dc; --ink:#1a1816; --ink2:#58554e; --ink3:#9e9b94;
    --gold:#b8860b; --red:#c0392b; --red-lt:#fdf0ee; --blue:#1a4fa0;
    --sans:'Sora',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,'JetBrains Mono',Menlo,monospace;
    --r:6px; --r-lg:10px;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --bg:#111214; --surface:#1c1e21; --surface2:#242629;
    --border:#2e3035; --ink:#e8e9ea; --ink2:#9ca3af; --ink3:#6b7280;
    --red-lt:rgba(239,68,68,.14);
  }}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    padding:24px 16px;background:var(--bg);color:var(--ink);font-family:var(--sans);
    font-size:13px;line-height:1.55;-webkit-font-smoothing:antialiased}
  .card{width:100%;max-width:382px;background:var(--surface);border:1px solid var(--border);
    border-radius:var(--r-lg);padding:30px 28px 26px}
  .mark{display:block;width:52px;height:52px;margin:0 0 14px}
  .brand{display:block;font-size:19px;font-weight:600;letter-spacing:-.015em}
  .kicker{display:block;margin-top:3px;font-size:9.5px;font-weight:600;color:var(--ink3);
    text-transform:uppercase;letter-spacing:1px}
  .rule{height:2px;width:34px;background:var(--gold);border-radius:2px;margin:15px 0 19px}
  .sub{margin:0 0 4px;color:var(--ink2);font-size:12.5px}
  .who{margin:0 0 22px;font-size:12.5px;font-weight:500}
  label{display:block;font-size:10px;font-weight:700;text-transform:uppercase;
    letter-spacing:.6px;color:var(--ink3);margin:0 0 5px}
  input[type=text]{width:100%;padding:12px;margin-bottom:15px;font-size:24px;font-family:var(--mono);
    letter-spacing:10px;text-align:center;color:var(--ink);background:var(--surface2);
    border:1px solid var(--border);border-radius:var(--r);outline:none}
  input:focus{border-color:var(--blue)}
  button{width:100%;padding:10px;font-size:13px;font-weight:500;font-family:inherit;
    color:#fff;background:var(--ink);border:1px solid var(--ink);border-radius:var(--r);
    cursor:pointer;margin-top:3px}
  button:hover{background:#2d2b27}
  .err{background:var(--red-lt);color:var(--red);border:1px solid var(--red);
    border-radius:var(--r);padding:10px 12px;margin-bottom:17px;font-size:12.5px}
  .foot{margin:21px 0 0;padding-top:15px;border-top:1px solid var(--border);
    color:var(--ink3);font-size:11px;text-align:center}
  .foot a{color:var(--ink2)}
</style>
</head>
<body>
  <main class="card">
    <img class="mark" src="/admin/logo.png" alt="" width="52" height="52">
    <h1 style="margin:0"><span class="brand">${esc(brand)}</span>${
      kicker ? `<span class="kicker">${esc(kicker)}</span>` : ''
    }</h1>
    <div class="rule"></div>
    <p class="sub">Your role requires a second factor. We have emailed a six-digit code to</p>
    <p class="who">${esc(email)}</p>

    ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}

    <form method="post" action="/admin/login/otp" autocomplete="off">
      <label for="code">Code</label>
      <input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]*"
             maxlength="6" required autofocus autocomplete="one-time-code"
             spellcheck="false" placeholder="——————">
      <button type="submit">Sign in</button>
    </form>

    <p class="foot">The code expires in ${Number(minutes) || 10} minutes and can be used once.<br>
      <a href="/admin/login">Start again</a></p>
  </main>
</body>
</html>`;
}

module.exports = { render };
