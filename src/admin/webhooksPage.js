'use strict';

const { esc, layout, pageHead, panel, tablePanel, fmtDate, fmtNum } = require('./ui');

/**
 * Webhooks — the APIs that call us.
 *
 * A separate screen from the Catalogue, not a tab on it, because almost
 * nothing transfers. There is no consumer, no API key, no response to shape
 * and no field whitelist; the questions are who is allowed to call, how we
 * know it is really them, and where the payload goes afterwards.
 *
 * WHAT THIS SCREEN IS ACTUALLY FOR
 *
 * Setting one up takes a few minutes once. Then it runs unattended for months
 * and the only thing anyone comes back for is "did it work" — which, for an
 * inbound integration, is a question nothing else can answer. If a supplier
 * starts signing with a rotated key, no alert fires on our side and no
 * consumer complains: they see failures, we see silence. So the call log is
 * the main body of the page and the configuration is above it.
 */

const SCHEMES = [
  ['hmac_sha256_hex', 'HMAC SHA-256, hex'],
  ['hmac_sha256_base64', 'HMAC SHA-256, base64'],
  ['none', 'No signature'],
];

const OUTCOME = {
  accepted: ['ok', 'accepted'],
  duplicate: ['mute', 'repeat'],
  bad_signature: ['off', 'bad signature'],
  ip_blocked: ['off', 'blocked'],
  unknown_hook: ['warn', 'unknown path'],
  disabled: ['warn', 'disabled'],
  malformed: ['warn', 'malformed'],
  error: ['off', 'our error'],
};

function badge(kind, text) {
  return `<span class="badge ${esc(kind)}">${esc(text)}</span>`;
}

function hookRow(h, publicBase) {
  const url = `${publicBase}/hooks${h.path}`;
  const signed = h.signature_scheme !== 'none';
  const cred = h.credential || {};

  // Three states, and the middle one is the one worth catching: live, signed,
  // and no key stored means every call the supplier makes is being refused
  // while the screen says "live".
  let state;
  if (h.status !== 'live' || !h.enabled) state = badge('mute', 'draft');
  else if (signed && !cred.is_set) state = badge('off', 'no key — refusing calls');
  else if (!h.forward_url) state = badge('off', 'nowhere to deliver');
  else state = badge('ok', 'live');

  const backlog = Number(h.pending || 0);
  const failed = Number(h.failed || 0);

  return `<tr>
    <td>
      <a class="lnk" href="/admin/webhooks/${esc(h.name)}"><b>${esc(h.display_name || h.name)}</b></a>
      <div class="t2 mono">${esc(h.name)}</div>
    </td>
    <td class="mono wrapword">${esc(url)}</td>
    <td>${signed
      ? `${badge('mute', 'signed')} <span class="t2">${esc(h.signature_header || '')}</span>`
      : badge('warn', 'unsigned')}</td>
    <td>${cred.is_set
      ? `<code class="masked">${esc(cred.masked || '••••')}</code>`
      : '<span class="t2">not set</span>'}</td>
    <td>${(h.ip_allowlist || []).length
      ? `<span class="t2 mono">${esc((h.ip_allowlist || []).join(', '))}</span>`
      : '<span class="t2">any source</span>'}</td>
    <td class="num">${backlog ? badge(backlog > 10 ? 'warn' : 'mute', fmtNum(backlog)) : '—'}</td>
    <td class="num">${failed ? badge('off', fmtNum(failed)) : '—'}</td>
    <td class="t2">${h.last_call ? fmtDate(h.last_call) : 'never called'}</td>
    <td>${state}</td>
  </tr>`;
}

function render({ admin, flash, hooks = [], calls = [], stuck = [], publicBase = '' }) {
  const rows = hooks.map((h) => hookRow(h, publicBase)).join('')
    || `<tr><td colspan="9" class="empty">No webhooks yet. Add one and give the supplier
        the address it creates.</td></tr>`;

  const callRows = calls.map((c) => {
    const [kind, label] = OUTCOME[c.outcome] || ['mute', c.outcome];
    return `<tr>
      <td class="t2">${fmtDate(c.occurred_at)}</td>
      <td class="mono">${esc(c.webhook || '—')}</td>
      <td class="mono t2">${esc(c.path)}</td>
      <td class="mono t2">${esc(c.source_ip || '—')}</td>
      <td class="num">${c.status}</td>
      <td>${badge(kind, label)}</td>
      <td class="mono t2 wrapword">${esc(c.event_key || '')}</td>
      <td class="t2 wrapword">${esc(c.detail || '')}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" class="empty">Nothing has called yet.</td></tr>`;

  const stuckRows = stuck.map((s) => `<tr>
      <td class="mono">${esc(s.webhook)}</td>
      <td class="mono t2 wrapword">${esc(s.event_key || '—')}</td>
      <td class="t2">${fmtDate(s.received_at)}</td>
      <td class="num">${s.attempts}</td>
      <td>${badge(s.state === 'failed' ? 'off' : 'warn', s.state)}</td>
      <td class="t2 wrapword">${esc(s.last_error || '')}</td>
      <td><form method="post" action="/admin/webhooks/delivery/${esc(String(s.id))}/retry"
            style="display:inline">
            <button class="btn sm" type="submit">Retry now</button></form></td>
    </tr>`).join('');

  const body = `
${pageHead('Webhooks',
    'Suppliers that call <strong>us</strong>. There is no consumer and no API key here — a shared ' +
    'signature is what proves the caller is who they say, and a verified payload is delivered on ' +
    'to the internal application afterwards.',
    '<a class="btn primary" href="/admin/webhooks/new">Add a webhook</a>')}

${stuckRows ? panel('Needs attention',
    'A payload that has been accepted but not yet taken by the internal application. The supplier ' +
    'has been told it arrived, so this is the only copy — it is kept rather than dropped.',
    `<div class="wrap"><table><thead><tr>
      <th>Webhook</th><th>Event</th><th>Received</th><th class="num">Tries</th>
      <th>State</th><th>Last error</th><th></th>
    </tr></thead><tbody>${stuckRows}</tbody></table></div>`,
    `${stuck.length}`) : ''}

${tablePanel('Configured webhooks',
    'The address column is what you give the supplier. It is public — it has to be, their server ' +
    'calls it — so the signature and the optional source list are what actually guard it.',
    `<th style="width:16%">Name</th><th style="width:24%">Address to give them</th>
     <th style="width:12%">Signature</th><th style="width:8%">Key</th>
     <th style="width:12%">Sources</th><th class="num" style="width:6%">Queued</th>
     <th class="num" style="width:6%">Failed</th><th style="width:10%">Last call</th>
     <th style="width:10%"></th>`,
    rows, `${hooks.length}`)}

${tablePanel('Recent calls',
    'Every inbound call, including the ones that were turned away. Without this a supplier signing ' +
    'with a rotated key is invisible: they see failures, we see nothing, and the conversation ' +
    'starts with "your webhook is broken". No payload is kept — only what identifies the call.',
    `<th style="width:12%">When</th><th style="width:11%">Webhook</th><th style="width:16%">Path</th>
     <th style="width:10%">Source</th><th class="num" style="width:6%">Status</th>
     <th style="width:10%">Outcome</th><th style="width:15%">Event</th><th>Detail</th>`,
    callRows)}

<style>${CSS}</style>`;

  return layout({ title: 'Webhooks', admin, current: '/admin/webhooks', body, flash });
}

/** The add / edit form. */
function renderOne({ admin, flash, hook = null, credential = {}, calls = [], publicBase = '' }) {
  const h = hook || {};
  const isNew = !hook;
  const scheme = h.signature_scheme || 'hmac_sha256_hex';

  const opts = SCHEMES.map(([v, l]) =>
    `<option value="${esc(v)}"${v === scheme ? ' selected' : ''}>${esc(l)}</option>`).join('');

  const address = h.path ? `${publicBase}/hooks${h.path}` : '';

  const body = `
${pageHead(isNew ? 'Add a webhook' : esc(h.display_name || h.name),
    isNew
      ? 'Four things: where they post, how they sign it, and where a verified payload goes next.'
      : 'Give the supplier the address below. Everything else is how we recognise them.',
    '<a class="btn" href="/admin/webhooks">All webhooks</a>')}

${!isNew && address ? panel('The address to give them',
    'Public, because their server has to reach it. Nothing under it is reachable without a valid ' +
    'signature.',
    `<code class="addr">${esc(address)}</code>`) : ''}

<form method="post" action="/admin/webhooks${isNew ? '' : `/${esc(h.name)}`}">
${panel('What it is', '', `
  <div class="grid2">
    <label>Reference
      <input name="name" value="${esc(h.name || '')}" placeholder="flipit_news"
        ${isNew ? '' : 'readonly'} required>
      <span class="n">Lowercase, no spaces. Used in logs and never shown to anyone outside.</span>
    </label>
    <label>Display name
      <input name="displayName" value="${esc(h.display_name || '')}" placeholder="FlipitMoney news">
    </label>
    <label>Path
      <input name="path" value="${esc(h.path || '')}" placeholder="/flipit/news" required>
      <span class="n">Served under <code>/hooks</code>. Something unguessable here is worth a
        little — it is not security, but it keeps casual scanners out of the log.</span>
    </label>
    <label>Description
      <input name="description" value="${esc(h.description || '')}"
        placeholder="News items, pushed on publish, update and delete">
    </label>
  </div>`)}

${panel('How we know it is them',
    'This is the whole of the authentication. Get the signed message wrong and you either reject ' +
    'every real call or accept forged ones, so copy it from their documentation rather than ' +
    'guessing.', `
  <div class="grid2">
    <label>Scheme
      <select name="signatureScheme">${opts}</select>
    </label>
    <label>Header
      <input name="signatureHeader" value="${esc(h.signature_header || '')}"
        placeholder="X-Flipit-Checksum">
      <span class="n">The header their checksum arrives in.</span>
    </label>
    <label>What they sign
      <input name="signatureMessage" value="${esc(h.signature_message || '')}"
        placeholder="{slug}{updated_at}">
      <span class="n">A template over the body. FlipitMoney sign <code>slug + updated_at</code>,
        so that is <code>{slug}{updated_at}</code>. Leave empty if they sign the whole body,
        which is the stronger scheme.</span>
    </label>
    <label>Signing key
      ${credential.is_set
        ? `<span class="secretcell"><code class="masked">${esc(credential.masked || '••••')}</code>
             <span class="n">set by ${esc(credential.set_by || '')}</span></span>
           <input type="password" name="plaintext" placeholder="paste a new one to replace it"
             autocomplete="new-password">`
        : `<input type="password" name="plaintext" placeholder="paste it once"
             autocomplete="new-password">`}
      <span class="n">Encrypted before it is stored. After saving you will see the last four
        characters and nothing more.</span>
    </label>
  </div>
  ${h.signature_message && h.signature_message.trim()
      ? `<p class="warnbox">A signature over <code>${esc(h.signature_message)}</code> proves those
         values came from someone holding the key. It says nothing about the rest of the payload —
         somebody who captured one call could alter the other fields and the checksum would still
         verify. That is a limit of their scheme, not of ours, and the source list below is the
         answer to it.</p>`
      : ''}`)}

${panel('Who may call', '', `
  <label>Allowed sources
    <input name="ipAllowlist" value="${esc((h.ip_allowlist || []).join(', '))}"
      placeholder="52.66.1.2, 52.66.0.0/16">
    <span class="n">Comma separated, addresses or CIDR blocks. <strong>Empty means any
      source</strong> — the signature is what guards the endpoint. Worth filling in when the
      supplier sends from a fixed address, and especially when they sign only part of the
      payload.</span>
  </label>`)}

${panel('Where a verified payload goes',
    'We answer the supplier as soon as the payload is written down, then deliver it here on our ' +
    'own schedule. That separation is the point: FlipitMoney retry three times over about a ' +
    'minute and then the news is gone, so the answer must not wait on anything that can be ' +
    'restarted.', `
  <div class="grid2">
    <label>Internal URL
      <input name="forwardUrl" value="${esc(h.forward_url || '')}"
        placeholder="https://ananta.internal/api/news/ingest">
    </label>
    <label>Timeout (ms)
      <input name="forwardTimeoutMs" type="number" value="${esc(String(h.forward_timeout_ms || 8000))}">
    </label>
    <label>Give up after
      <input name="forwardMaxAttempts" type="number"
        value="${esc(String(h.forward_max_attempts || 8))}">
      <span class="n">Attempts, backing off 2s, 4s, 8s … capped at ten minutes. A payload that
        runs out is kept, not dropped.</span>
    </label>
    <label>Identified by
      <input name="eventKeyField" value="${esc(h.event_key_field || 'slug')}" placeholder="slug">
      <span class="n">Which field names the event, so a supplier retry is recognised rather than
        delivered twice.</span>
    </label>
  </div>`)}

${panel('Live', '', `
  <label class="inline"><input type="checkbox" name="live" value="1"
    ${h.status === 'live' ? 'checked' : ''}> Serve this address
    <span class="n">A webhook that is not live answers 404, exactly as an unknown path does.</span>
  </label>`)}

  <div class="formactions">
    <button class="btn primary" type="submit">${isNew ? 'Create' : 'Save'}</button>
    <a class="btn" href="/admin/webhooks">Cancel</a>
  </div>
</form>

${!isNew ? tablePanel('Recent calls to this webhook', '',
    `<th style="width:14%">When</th><th style="width:12%">Source</th>
     <th class="num" style="width:8%">Status</th><th style="width:12%">Outcome</th>
     <th style="width:22%">Event</th><th>Detail</th>`,
    calls.map((c) => {
      const [kind, label] = OUTCOME[c.outcome] || ['mute', c.outcome];
      return `<tr><td class="t2">${fmtDate(c.occurred_at)}</td>
        <td class="mono t2">${esc(c.source_ip || '—')}</td>
        <td class="num">${c.status}</td><td>${badge(kind, label)}</td>
        <td class="mono t2 wrapword">${esc(c.event_key || '')}</td>
        <td class="t2 wrapword">${esc(c.detail || '')}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">Nothing yet.</td></tr>') : ''}

<style>${CSS}</style>`;

  return layout({
    title: isNew ? 'Add a webhook' : (h.display_name || h.name),
    admin, current: '/admin/webhooks', body, flash,
  });
}

const CSS = `
.wrapword{word-break:break-word}
.masked{font-size:11.5px;letter-spacing:.08em;color:var(--ink2);background:var(--surface2);
  border:1px solid var(--border);border-radius:4px;padding:2px 7px}
.addr{display:inline-block;font-size:13px;padding:8px 12px;background:var(--surface2);
  border:1px solid var(--border);border-radius:var(--r);word-break:break-all}
.secretcell{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.grid2{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.grid2 label{display:flex;flex-direction:column;gap:4px;font-size:10px;font-weight:700;
  text-transform:uppercase;letter-spacing:.6px;color:var(--ink3)}
.grid2 input,.grid2 select{border:1px solid var(--border);background:var(--surface);
  border-radius:var(--r);padding:7px 9px;font:inherit;font-size:12.5px;color:var(--ink)}
.grid2 input:focus,.grid2 select:focus{border-color:var(--blue);outline:none}
.grid2 .n,label .n{font-size:11px;font-weight:400;text-transform:none;letter-spacing:0;
  color:var(--ink3);line-height:1.5}
label.inline{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink2)}
/* The limit of a partial-payload signature, said where the decision is made. */
.warnbox{margin:12px 0 0;font-size:11.5px;color:var(--ink2);line-height:1.6;
  background:var(--surface2);border:1px solid var(--border);border-left:3px solid #fab219;
  border-radius:var(--r);padding:10px 12px}
.formactions{display:flex;gap:10px;margin:16px 0 8px}
.btn.sm{font-size:11px;padding:4px 9px}
`;

module.exports = { render, renderOne, SCHEMES };
