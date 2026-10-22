'use strict';

const { esc, layout, pageHead } = require('./ui');

/**
 * "What are you onboarding?" — the page before the wizard.
 *
 * The Studio asks the same four steps of every API, and they are the right
 * four for one shape only: a REST call that returns JSON and changes nothing.
 * An SMS gateway answers with a status line and sends a message; the whitelist
 * step is meaningless for it and the idempotency question, which the wizard
 * never asks, is the one that matters most.
 *
 * So the shape is chosen first and the workflow follows from it.
 *
 * NOT THE SAME THING AS `gateway.api_types`. That table — Master, Fundamental,
 * Market Data, News, Calculator, Report, Transactional — says what the data is
 * ABOUT, and it stays where it is, as the Catalogue's category. This says how
 * the integration BEHAVES. A Market Data feed and an SMS gateway can share a
 * category and need completely different questions.
 *
 * WHAT IS NOT SUPPORTED SAYS SO, HERE, BEFORE ANY WORK.
 *
 * A card that leads into the wizard and fails at step 3 wastes somebody's
 * afternoon and teaches them not to trust the screen. The honest states are
 * ready, partly, and not yet — and the partial ones name the exact thing that
 * will stop them.
 */

const SHAPES = [
  {
    code: 'read',
    state: 'ready',
    title: 'It returns data',
    lede: 'A call that fetches something and changes nothing.',
    example: 'CMOTS Company Master — a GET that answers with JSON.',
    asks: [
      'which fields cross the boundary, picked from a real response',
      'how long to wait, and how often a consumer may call',
      'what the consumer sees, proved before anyone is given it',
    ],
  },
  {
    code: 'action',
    state: 'partly',
    title: 'It does something',
    lede: 'A call with a side effect — a message sent, a payment taken, an order placed.',
    example: 'ACL / Sinch SMS — a call that sends a text and answers with a status line.',
    asks: [
      'idempotency, so a consumer\'s retry does not do it twice',
      'which values the consumer may set, and which we fix for them',
      'a rate limit, because every call here costs money',
    ],
    // Named exactly, because "partly supported" without the specifics is
    // indistinguishable from "probably fine".
    blocked: 'Works today if the supplier answers in JSON. If it answers with ' +
      'plain text — as ACL does, with 1701|9199…|OK — the gateway rejects the ' +
      'response and the consumer gets a 502 AFTER the message has gone out. ' +
      'Their retry then sends a second one. That is being fixed before this ' +
      'card becomes green.',
  },
  {
    code: 'database',
    state: 'no',
    title: 'It is a database',
    lede: 'A SQL source queried directly rather than over HTTP.',
    example: 'The CMOTS datalake — 70 tables on uat_ananta_staging.',
    asks: [],
    blocked: 'Pravah wraps HTTP APIs. It has no SQL path, and giving it one ' +
      'would mean holding a database credential that reaches far more than any ' +
      'single endpoint needs. A read-only API in front of the datalake is the ' +
      'safer shape, and that API is something this gateway can then wrap.',
  },
];

function card(s) {
  const badge = {
    ready:  '<span class="sb ok">ready</span>',
    partly: '<span class="sb warn">partly</span>',
    no:     '<span class="sb off">not yet</span>',
  }[s.state];

  const go = s.state === 'no'
    ? ''
    : `<a class="btn ${s.state === 'ready' ? 'primary' : ''}"
          href="/admin/studio?shape=${esc(s.code)}">Start${s.state === 'partly' ? ' anyway' : ''}</a>`;

  return `<section class="shape ${esc(s.state)}">
    <div class="sh-top"><h3>${esc(s.title)}</h3>${badge}</div>
    <p class="sh-lede">${esc(s.lede)}</p>
    <p class="sh-eg"><b>For example</b> ${esc(s.example)}</p>
    ${s.asks.length ? `<p class="sh-asks-t">The wizard will ask you for</p>
      <ul class="sh-asks">${s.asks.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
    ${s.blocked ? `<p class="sh-blocked">${esc(s.blocked)}</p>` : ''}
    <div class="sh-go">${go}</div>
  </section>`;
}

function render({ admin, flash }) {
  const body = `
${pageHead('Onboard an API',
  'Pick what you are wrapping. The questions that follow depend on it — a feed that returns data and a gateway that sends a message need almost nothing in common.',
  '<a class="btn" href="/admin/catalog">All endpoints</a>')}

<div class="shapes">${SHAPES.map(card).join('')}</div>

<p class="shape-foot">Not sure which? Pick <strong>It returns data</strong>. Step 1 makes
  one real call and then tells you what the supplier actually sent — including whether it
  is JSON, whether it is a list, and whether calling it twice would be safe.</p>

<style>${CSS}</style>`;

  return layout({ title: 'Onboard an API', admin, current: '/admin/studio', body, flash });
}

const CSS = `
.shapes{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));
  align-items:start}
.shape{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);
  padding:18px 20px}
/* The one that works is the one that should catch the eye. */
.shape.ready{border-left:3px solid var(--gold)}
.shape.partly{border-left:3px solid #fab219}
.shape.no{border-left:3px solid var(--border);background:var(--surface2)}
.sh-top{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.shape h3{margin:0;font-size:15px;font-weight:600;color:var(--ink);letter-spacing:-.01em}
.sb{font-size:9.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;
  padding:2px 7px;border-radius:3px;border:1px solid var(--border);color:var(--ink3)}
.sb.ok{color:#0a7a0a;border-color:#0a7a0a}
.sb.warn{color:#9a6b00;border-color:#fab219}
.sh-lede{margin:0 0 9px;font-size:12.5px;color:var(--ink2);line-height:1.55}
.sh-eg{margin:0 0 11px;font-size:11.5px;color:var(--ink3);line-height:1.55}
.sh-eg b{color:var(--ink2);font-weight:600}
.sh-asks-t{margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;
  letter-spacing:.6px;color:var(--ink3)}
.sh-asks{margin:0 0 12px;padding-left:17px;font-size:11.5px;color:var(--ink2);line-height:1.6}
/* What will stop you, stated before you start rather than at step 3. */
.sh-blocked{margin:0 0 12px;font-size:11.5px;color:var(--ink2);line-height:1.6;
  background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);
  padding:9px 11px}
.shape.no .sh-blocked{background:var(--surface)}
.sh-go{margin-top:2px}
.shape-foot{margin:16px 0 0;font-size:12px;color:var(--ink3);line-height:1.6;max-width:80ch}
`;

module.exports = { render, SHAPES };
