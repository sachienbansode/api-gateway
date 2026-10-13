'use strict';

/**
 * The login page, rendered server-side as one self-contained document.
 *
 * No build step, no CDN, no external font — the page must load on a VM whose
 * NSG blocks nearly everything outbound, and a login screen that depends on a
 * third party is a login screen that fails when that third party does.
 *
 * `error` is the only interpolated value and it is escaped. It is also chosen
 * from a fixed set by the caller, never built from user input.
 */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function render({ error = '', title = 'API Gateway', email = '' } = {}) {
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in · ${esc(title)}</title>
<style>
  :root {
    --bg: #f4f5f7; --card: #ffffff; --fg: #1a1d23; --muted: #6b7280;
    --line: #d9dce1; --accent: #1f3864; --accent-fg: #ffffff;
    --err-bg: #fdeaea; --err-fg: #a4231f; --err-line: #f0b6b4;
    --focus: #2563eb;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #15171c; --card: #1d2026; --fg: #e8eaed; --muted: #9aa0a6;
      --line: #343842; --accent: #5b8def; --accent-fg: #0d1117;
      --err-bg: #3a1d1d; --err-fg: #f1a9a6; --err-line: #6b2b29;
      --focus: #7aa7ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 24px 16px; background: var(--bg);
    color: var(--fg);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  }
  .card {
    width: 100%; max-width: 380px; background: var(--card);
    border: 1px solid var(--line); border-radius: 10px; padding: 32px 28px;
    box-shadow: 0 1px 2px rgba(0,0,0,.05), 0 8px 24px rgba(0,0,0,.06);
  }
  h1 { margin: 0 0 4px; font-size: 19px; letter-spacing: -.01em; }
  .sub { margin: 0 0 24px; color: var(--muted); font-size: 13px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 0 0 6px; }
  input[type=email], input[type=password] {
    width: 100%; padding: 10px 12px; margin-bottom: 16px; font-size: 15px;
    color: var(--fg); background: var(--bg); border: 1px solid var(--line);
    border-radius: 6px; font-family: inherit;
  }
  input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; border-color: var(--focus); }
  button {
    width: 100%; padding: 11px; font-size: 15px; font-weight: 600;
    font-family: inherit; color: var(--accent-fg); background: var(--accent);
    border: 0; border-radius: 6px; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .err {
    background: var(--err-bg); color: var(--err-fg);
    border: 1px solid var(--err-line); border-radius: 6px;
    padding: 10px 12px; margin-bottom: 18px; font-size: 13.5px;
  }
  .foot { margin: 22px 0 0; padding-top: 16px; border-top: 1px solid var(--line);
          color: var(--muted); font-size: 12px; text-align: center; }
</style>
</head>
<body>
  <main class="card">
    <h1>${esc(title)}</h1>
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
