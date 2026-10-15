'use strict';

const { esc, layout, pageHead, panel } = require('./ui');

/**
 * How it works.
 *
 * Written for the person who has just been given access and has to explain
 * this gateway to somebody else — a colleague, an auditor, a partner asking
 * why they cannot see a field. So it describes the MECHANISM rather than the
 * benefits: what is added to a call, what is removed from it, and where each
 * decision is made.
 *
 * The diagrams are inline SVG using the console's own colour variables, so
 * they follow light and dark without a second copy. No external image, no
 * build step, and the text in them is real text — selectable, searchable, and
 * readable by a screen reader.
 */

// ---------------------------------------------------------------------------
// Diagram 1: one consumer call, end to end
// ---------------------------------------------------------------------------
function requestDiagram(baseUrl) {
  const host = (baseUrl || 'https://pravah.ashikagroup.com').replace(/^https?:\/\//, '');
  return `
<svg class="flow" viewBox="0 0 980 400" role="img"
     aria-label="A consumer call enters the gateway, is authenticated and matched against the
       declared endpoints, forwarded to the supplier with Ashika's own credential, and the
       reply is rebuilt field by field from the whitelist before it reaches the consumer.">
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
            orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--ink3)"/>
    </marker>
    <marker id="arg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
            orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--gold)"/>
    </marker>
  </defs>

  <!-- lanes -->
  <rect x="1" y="54" width="180" height="300" rx="9"
        fill="var(--surface2)" stroke="var(--border)"/>
  <rect x="211" y="54" width="520" height="300" rx="9"
        fill="var(--surface)" stroke="var(--ink)" stroke-dasharray="0"/>
  <rect x="761" y="54" width="180" height="300" rx="9"
        fill="var(--surface2)" stroke="var(--border)"/>

  <text x="91"  y="40" class="lane" text-anchor="middle">THE VENDOR</text>
  <text x="471" y="40" class="lane" text-anchor="middle">PRAVAH &middot; ${esc(host)}</text>
  <text x="851" y="40" class="lane" text-anchor="middle">THE SUPPLIER</text>

  <!-- consumer -->
  <text x="91" y="92"  class="h" text-anchor="middle">Partner system</text>
  <text x="91" y="116" class="s" text-anchor="middle">Holds an API key</text>
  <text x="91" y="134" class="s" text-anchor="middle">issued by us</text>
  <rect x="21" y="158" width="140" height="56" rx="6" fill="var(--surface)" stroke="var(--border)"/>
  <text x="91" y="180" class="m" text-anchor="middle">X-API-Key: ••••</text>
  <text x="91" y="200" class="m" text-anchor="middle">GET /v1/cmots/…</text>

  <!-- the four gateway steps -->
  <g>
    <rect x="231" y="80" width="230" height="58" rx="6" fill="var(--surface2)" stroke="var(--border)"/>
    <text x="246" y="104" class="n">1</text>
    <text x="266" y="104" class="h">Who is calling?</text>
    <text x="266" y="124" class="s">Key hashed, matched to a consumer</text>

    <rect x="231" y="152" width="230" height="58" rx="6" fill="var(--surface2)" stroke="var(--border)"/>
    <text x="246" y="176" class="n">2</text>
    <text x="266" y="176" class="h">Is this route declared?</text>
    <text x="266" y="196" class="s">Allowlist only — no passthrough</text>

    <rect x="231" y="224" width="230" height="58" rx="6" fill="var(--surface2)" stroke="var(--border)"/>
    <text x="246" y="248" class="n">3</text>
    <text x="266" y="248" class="h">May they call it?</text>
    <text x="266" y="268" class="s">Scope <tspan class="mono">ep:name</tspan>, then rate limit</text>

    <rect x="231" y="296" width="230" height="44" rx="6" fill="var(--surface2)" stroke="var(--border)"/>
    <text x="246" y="324" class="n">4</text>
    <text x="266" y="324" class="h">Recorded in the audit log</text>
  </g>

  <!-- the swap -->
  <rect x="491" y="80" width="220" height="118" rx="6"
        fill="var(--gold-lt)" stroke="var(--gold)"/>
  <text x="601" y="104" class="h" text-anchor="middle">The call is rebuilt</text>
  <text x="506" y="128" class="s">+ Ashika's own credential</text>
  <text x="506" y="148" class="s">− every header the consumer sent</text>
  <text x="506" y="168" class="s">only allowlisted query values</text>
  <text x="506" y="188" class="s">timeout &amp; circuit breaker</text>

  <!-- the projection -->
  <rect x="491" y="214" width="220" height="126" rx="6"
        fill="var(--gold-lt)" stroke="var(--gold)"/>
  <text x="601" y="238" class="h" text-anchor="middle">The reply is rebuilt</text>
  <text x="506" y="262" class="s">Starts from an empty object</text>
  <text x="506" y="282" class="s">Each whitelisted field copied in</text>
  <text x="506" y="302" class="s">Anything else cannot appear —</text>
  <text x="506" y="322" class="s">including fields added upstream</text>

  <!-- supplier -->
  <text x="851" y="92"  class="h" text-anchor="middle">CMOTS and others</text>
  <rect x="781" y="112" width="140" height="80" rx="6" fill="var(--surface)" stroke="var(--border)"/>
  <text x="851" y="134" class="s" text-anchor="middle">Sees a call from</text>
  <text x="851" y="152" class="s" text-anchor="middle">Ashika, never</text>
  <text x="851" y="170" class="s" text-anchor="middle">from the consumer</text>
  <text x="851" y="228" class="s" text-anchor="middle">Returns its full</text>
  <text x="851" y="246" class="s" text-anchor="middle">response</text>

  <!-- arrows. The return path runs BELOW the lanes rather than across them:
       routed at step 3's height it drew a line straight through that box, which
       reads as an arrow out of the wrong step.

       Each is drawn twice: a static line, and a short dash travelling along the
       same path. The dash is what shows DIRECTION — a still diagram with an
       arrowhead states which way it goes, a moving one makes you see it. The
       four legs are offset in time so the eye follows one call round the loop
       rather than watching four things pulse at once. -->
  <g class="wire">
    <path id="w1" d="M166 186 L226 186"/>
    <path id="w2" d="M466 139 L486 139" class="gold"/>
    <path id="w3" d="M716 139 L776 139" class="gold"/>
    <path id="w4" d="M851 196 L851 268 L776 268"/>
    <path id="w5" d="M601 344 L601 374 L91 374 L91 222" class="green"/>
  </g>
  <g class="wire heads">
    <path d="M166 186 L226 186" marker-end="url(#ar)"/>
    <path d="M466 139 L486 139" class="gold" marker-end="url(#arg)"/>
    <path d="M716 139 L776 139" class="gold" marker-end="url(#arg)"/>
    <path d="M851 196 L851 268 L776 268" marker-end="url(#ar)"/>
    <path d="M601 344 L601 374 L91 374 L91 222" class="green" marker-end="url(#ar)"/>
  </g>
  <g class="pulses">
    <circle r="3.5" class="p-ink"><animateMotion dur="5.5s" repeatCount="indefinite"
      begin="0s" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
      <mpath href="#w1"/></animateMotion></circle>
    <circle r="3.5" class="p-gold"><animateMotion dur="5.5s" repeatCount="indefinite"
      begin="0.7s" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
      <mpath href="#w2"/></animateMotion></circle>
    <circle r="3.5" class="p-gold"><animateMotion dur="5.5s" repeatCount="indefinite"
      begin="1.4s" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
      <mpath href="#w3"/></animateMotion></circle>
    <circle r="3.5" class="p-ink"><animateMotion dur="5.5s" repeatCount="indefinite"
      begin="2.3s" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
      <mpath href="#w4"/></animateMotion></circle>
    <circle r="3.5" class="p-green"><animateMotion dur="5.5s" repeatCount="indefinite"
      begin="3.1s" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
      <mpath href="#w5"/></animateMotion></circle>
  </g>

  <text x="196" y="176" class="t" text-anchor="middle">request</text>
  <text x="620" y="370" class="t">only what the whitelist names comes back</text>
</svg>`;
}

// ---------------------------------------------------------------------------
// Diagram 2: how an endpoint comes to exist
// ---------------------------------------------------------------------------
function buildDiagram() {
  return `
<svg class="flow" viewBox="0 0 980 232" role="img"
     aria-label="An administrator signs in with their Ananta account, builds an endpoint in the
       API Studio, saves it as a draft, tests it, and publishes it — at which point the running
       gateway swaps its routing table without a restart.">
  <defs>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
            orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--ink3)"/>
    </marker>
  </defs>
  ${[
    ['Sign in', 'Your Ananta account. A role must', 'grant the api-gateway page.'],
    ['Step 1 · Supplier', 'Base URL and credential. The token', 'is encrypted before it is stored.'],
    ['Step 2 · Our endpoint', 'The path we publish instead,', 'which hides theirs.'],
    ['Step 3 · Fields', 'Tick what a consumer may see.', 'Everything else is withheld.'],
    ['Step 4 · Test', 'A real call to the supplier,', 'then the real projection.'],
  ].map((b, i) => {
    const x = 10 + i * 194;
    return `<g>
      <rect x="${x}" y="40" width="174" height="96" rx="6"
            fill="var(--surface2)" stroke="var(--border)"/>
      <text x="${x + 15}" y="66" class="n">${i + 1}</text>
      <text x="${x + 35}" y="66" class="h">${esc(b[0])}</text>
      <text x="${x + 15}" y="92" class="s">${esc(b[1])}</text>
      <text x="${x + 15}" y="110" class="s">${esc(b[2])}</text>
    </g>${i < 4 ? `<path d="M${x + 178} 88 L${x + 190} 88" stroke="var(--ink3)"
        stroke-width="1.5" marker-end="url(#ar2)"/>` : ''}`;
  }).join('')}

  <rect x="10" y="164" width="952" height="56" rx="6"
        fill="var(--gold-lt)" stroke="var(--gold)"/>
  <text x="26" y="188" class="h">Publish</text>
  <text x="96" y="188" class="s">The running gateway rebuilds its routing table in place — no restart, no dropped call.</text>
  <text x="26" y="208" class="s">A draft is deliberately not routed, so an unfinished endpoint cannot be reached by anyone.</text>
</svg>`;
}

function render({ admin, flash, baseUrl }) {
  const body = `
${pageHead('How it works',
  'What this gateway does to a call, and where each decision is made.')}

${panel('One consumer call, end to end', '', requestDiagram(baseUrl))}

${panel('What a consumer never receives', '', `
  <ul class="never">
    <li><b>The supplier's address.</b> They call a path on our host. Which third party answers
      it, and at which URL, is not in the response, the headers or the error messages.</li>
    <li><b>Our credential.</b> The consumer's key identifies the consumer. The supplier's token is
      added here, server-side, and travels only between this gateway and the supplier.</li>
    <li><b>Any field not ticked.</b> On a whitelist endpoint the response is built from an
      empty object by copying in the named fields. A field the supplier adds next month
      cannot appear, because nothing copies it.</li>
    <li><b>Another partner's endpoints.</b> The API documentation each consumer sees is filtered
      to the scopes they hold.</li>
  </ul>`)}

${panel('How an endpoint comes to exist', '', buildDiagram())}

${panel('Where things are kept, and what is not kept at all', '', `
  <dl class="cfg">
    <dt>Supplier data</dt>
      <dd><b>Nowhere here.</b> A response passes through this gateway to the consumer and is not
        written down. The datalake (<span class="mono">uat_ananta_staging.cmots</span>) is loaded
        separately, on its own schedule, by its own job. This console holds the SHAPE of a
        response — that a field exists and its type — never a value from it.</dd>
    <dt>Supplier credentials</dt>
      <dd>In the gateway database, sealed with AES-256-GCM. The key is in the server's env file
        and never in the database, so a backup or a stolen disk decrypts to nothing. Reading one
        back is an action, attributable to a person, and it is logged.</dd>
    <dt>Who may sign in</dt>
      <dd>Your Ananta account — the same password, the same deactivation. The grant is read
        fresh on every request, so removing someone takes effect in seconds rather than when
        their session expires. A role marked for MFA must enter an emailed code.</dd>
    <dt>Consumer API keys</dt>
      <dd>Only as hashes. We can check a key presented to us; we cannot tell you what it is.
        A lost key is replaced, not recovered.</dd>
  </dl>`)}

${panel('If something looks wrong', '', `
  <dl class="cfg">
    <dt>A consumer reports a missing field</dt>
      <dd>Open the endpoint in the <a href="/admin/catalog">Catalogue</a> and look at the
        withheld list. If it should be exposed, tick it in the Studio and publish — that is
        the whole change.</dd>
    <dt>An endpoint stopped answering</dt>
      <dd>Press <b>Test</b> on its Catalogue row. It calls the supplier, then runs the real
        projection, then checks the published route — so the three usual causes separate
        themselves without anyone guessing.</dd>
    <dt>A supplier is slow or down</dt>
      <dd><a href="/admin/health">Health</a> shows the circuit breaker. An open breaker means
        the gateway has stopped calling a failing supplier on purpose, rather than making
        every consumer wait for a timeout.</dd>
  </dl>`)}

<style>
.flow{width:100%;height:auto;display:block}
.flow .wire path{fill:none;stroke:var(--ink3);stroke-width:1.5}
.flow .wire path.gold{stroke:var(--gold)}
.flow .wire path.green{stroke:var(--green)}
.flow .wire:not(.heads) path{opacity:.45}
.flow .pulses circle{filter:none}
.flow .p-ink{fill:var(--ink2)}
.flow .p-gold{fill:var(--gold)}
.flow .p-green{fill:var(--green)}
/* Motion is the ONLY thing the animation adds; every arrow still carries a
   head, so nothing is lost when it is switched off. Somebody who has asked
   their system for less motion has usually asked for a reason. */
@media (prefers-reduced-motion: reduce){
  .flow .pulses{display:none}
  .flow .wire:not(.heads) path{opacity:1}
}
.flow .lane{font:700 9.5px var(--sans);fill:var(--ink3);letter-spacing:1.1px}
.flow .h{font:600 12.5px var(--sans);fill:var(--ink)}
.flow .s{font:400 11px var(--sans);fill:var(--ink2)}
.flow .t{font:400 10px var(--sans);fill:var(--ink3)}
.flow .m{font:400 11px var(--mono);fill:var(--ink2)}
.flow .mono{font-family:var(--mono)}
.flow .n{font:700 11px var(--sans);fill:var(--gold)}
.never{margin:0;padding-left:18px}
.never li{font-size:12.5px;color:var(--ink2);line-height:1.6;margin-bottom:9px}
.never li:last-child{margin-bottom:0}
.never b{color:var(--ink)}
.cfg{display:grid;grid-template-columns:190px 1fr;gap:0;margin:0}
.cfg dt{padding:10px 0;font-size:12px;font-weight:600;color:var(--ink);
  border-bottom:1px solid var(--border)}
.cfg dd{margin:0;padding:10px 0;font-size:12.5px;color:var(--ink2);line-height:1.6;
  border-bottom:1px solid var(--border)}
.cfg dd b{color:var(--ink)}
.cfg .mono{font-family:var(--mono);font-size:11.5px}
.cfg dt:last-of-type,.cfg dd:last-of-type{border-bottom:0}
@media(max-width:860px){
  .cfg{grid-template-columns:1fr}
  .cfg dd{padding-top:0;border-bottom:0}
  /* The diagrams are laid out horizontally and do not reflow. Below this width
     they are scrolled rather than shrunk to the point of being unreadable. */
  .flow{min-width:760px}
  .panel .pb{overflow-x:auto}
}
</style>`;

  return layout({ title: 'How it works', admin, current: '/admin/how', body, flash });
}

module.exports = { render };
