'use strict';

const { esc, layout, pageHead } = require('./ui');

/**
 * The API Studio — onboarding a supplier API and publishing our wrapper over
 * it, in one view.
 *
 * Four steps, all on screen at once rather than four pages with Next buttons:
 * the decisions interlock. What you tick in step 3 only makes sense next to
 * the sample response from step 1, and step 4 is meaningless unless you can
 * see the whitelist you are testing. A wizard that hides the previous step
 * makes people guess.
 *
 * The browser code lives in studioClient.js and is served as its own file —
 * real JavaScript in a real file, not a string inside a template literal.
 */

const STUDIO_CSS = `
.stu{display:grid;grid-template-columns:186px 1fr;gap:20px;align-items:start}
/* ---------- the wizard ---------- */
/* One step on screen at a time. The whole thing used to render as a single
   1,900px page: every field of every step visible at once, mandatory and
   optional indistinguishable, and the only way to know where you were was to
   scroll. The four steps were already there — they were just all open. */
.step.away{display:none}
.wizhead{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.wizbar{flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden}
.wizbar i{display:block;height:100%;background:var(--gold);width:0;
  transition:width .22s ease}
.wizpos{font-size:11px;color:var(--ink3);font-weight:600;white-space:nowrap}
.wiznav{display:flex;align-items:center;gap:10px;margin-top:18px;padding-top:14px;
  border-top:1px solid var(--border)}
.wiznav .wizback[data-goto="0"]{visibility:hidden}
/* The reason the next step is not reachable yet, beside the button that is
   refusing. A disabled control with no explanation is the thing people file
   tickets about. */
.wizwhy{font-size:11.5px;color:var(--ink3);line-height:1.45}
.wiznext[disabled]{opacity:.45;cursor:not-allowed}

/* ---------- optional, and why it is worth setting ---------- */
.opt{margin-top:14px;border-top:1px dashed var(--border);padding-top:12px}
.opt>summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--ink2);
  list-style:none;display:flex;align-items:center;gap:7px}
.opt>summary::-webkit-details-marker{display:none}
.opt>summary:before{content:"+";display:inline-flex;align-items:center;justify-content:center;
  width:16px;height:16px;border:1px solid var(--border);border-radius:4px;font-weight:700;
  color:var(--ink3);flex:none}
.opt[open]>summary:before{content:"−"}
.opt>summary em{font-style:normal;font-weight:400;color:var(--ink3);font-size:11.5px}
.optwhy{margin:9px 0 2px;font-size:11.5px;color:var(--ink3);line-height:1.55;max-width:84ch}

.rail{position:sticky;top:18px}
.rail ol{list-style:none;margin:0;padding:0}
.rail li{position:relative;padding:0 0 16px 28px;font-size:11.5px;color:var(--ink3);cursor:pointer}
.rail li:before{content:attr(data-n);position:absolute;left:0;top:0;width:19px;height:19px;
  border-radius:50%;border:1px solid var(--border);background:var(--surface);color:var(--ink3);
  font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center}
.rail li:after{content:"";position:absolute;left:9px;top:21px;bottom:3px;width:1px;background:var(--border)}
.rail li:last-child:after{display:none}
.rail li b{display:block;color:var(--ink2);font-weight:600;font-size:12px;line-height:19px}
.rail li span{display:block;margin-top:1px;line-height:1.4}
.rail li.done:before{background:var(--green);border-color:var(--green);color:#fff;content:"✓"}
.rail li.active:before{background:var(--ink);border-color:var(--ink);color:#fff}
.rail li.active b{color:var(--ink)}

.step{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);
  margin-bottom:14px;overflow:hidden}
.step>.sh{display:flex;align-items:center;gap:10px;padding:11px 15px;background:var(--surface2);
  border-bottom:1px solid var(--border);cursor:pointer;user-select:none}
.step>.sh .no{width:19px;height:19px;border-radius:50%;background:var(--ink);color:#fff;
  font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none}
.step.ok>.sh .no{background:var(--green)}
.step>.sh h3{margin:0;font-size:12.5px;font-weight:600;color:var(--ink)}
.step>.sh .sub{font-size:11px;color:var(--ink3);margin-left:2px}
.step>.sh .right{margin-left:auto;display:flex;align-items:center;gap:8px}
.step>.sb{padding:16px 15px}
.step.collapsed>.sb{display:none}
.step .caret{color:var(--ink3);font-size:10px;transition:transform .15s}
.step.collapsed .caret{transform:rotate(-90deg)}

.bar{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:13px 15px}
.bar .f{min-width:190px}
.bar .spacer{flex:1}

.rowset{width:100%;border-collapse:collapse;font-size:12px}
.rowset th{font-size:9.5px;padding:6px 8px;background:transparent;border-bottom:1px solid var(--border)}
.rowset td{padding:4px 6px;border-bottom:1px solid var(--border)}
.rowset input,.rowset select{width:100%;border:1px solid transparent;background:transparent;
  border-radius:4px;padding:5px 7px;font:inherit;font-size:11.5px;color:var(--ink);min-width:0}
.rowset input:hover,.rowset select:hover{border-color:var(--border)}
.rowset input:focus,.rowset select:focus{border-color:var(--blue);background:var(--surface2);outline:none}
.rowset .x{color:var(--ink3);border:0;background:transparent;cursor:pointer;padding:2px 6px;font-size:14px}
.rowset .x:hover{color:var(--red);background:var(--red-lt)}
.rowset tbody tr:hover td{background:var(--surface2)}

.modes{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.mode{flex:1;min-width:180px;border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;
  cursor:pointer;background:var(--surface2)}
.mode:hover{border-color:var(--border2)}
.mode.on{border-color:var(--ink);background:var(--surface);box-shadow:inset 0 0 0 1px var(--ink)}
.mode b{display:block;font-size:12px;font-weight:600}
.mode span{display:block;font-size:10.5px;color:var(--ink3);margin-top:2px;line-height:1.45}
.mode.on.warn{box-shadow:inset 0 0 0 1px var(--gold);border-color:var(--gold)}
.mode.on.danger{box-shadow:inset 0 0 0 1px var(--red);border-color:var(--red)}

.fieldbox{border:1px solid var(--border);border-radius:var(--r);max-height:330px;overflow:auto}
.fieldbox table{font-size:11.5px}
.fieldbox th{position:sticky;top:0;z-index:1}
.fieldbox td{padding:5px 10px}
.fieldbox tr.off td{opacity:.5}
/* ---------- what kind of API this is ---------- */
.shape{margin-top:10px;border:1px solid var(--border);border-radius:var(--r);
  background:var(--surface2);padding:11px 13px}
.shape-kind{font-size:12.5px;font-weight:600;color:var(--ink)}
.shape-sum{font-size:11.5px;color:var(--ink3);margin-top:2px}
.shape-f{display:block;font-size:11.5px;line-height:1.55;color:var(--ink2);
  margin-top:9px;padding-left:11px;border-left:2px solid var(--border)}
.shape-f b{display:block;color:var(--ink);font-weight:600}
/* A blocker, something to decide, and something to know — distinguished by a
   rail rather than by colouring the text, which would make a whole paragraph
   red and unreadable. */
.shape-f.stop{border-left-color:var(--red)}
.shape-f.warn{border-left-color:#fab219}
.shape-f.info{border-left-color:var(--border)}
/* A group heading. Says the shared prefix once so every row below can show
   only the part that differs. */
.fieldbox tr.grp td{background:var(--surface2);font-weight:600;color:var(--ink2);
  border-top:1px solid var(--border);padding-top:7px;padding-bottom:7px}
.fieldbox tr.grp td.grp-name{letter-spacing:.01em}
/* The rail that makes a row read as belonging to the heading above it. */
.fieldbox tr.child td:nth-child(2){padding-left:22px;position:relative}
.fieldbox tr.child td:nth-child(2):before{content:"";position:absolute;left:10px;top:0;bottom:0;
  border-left:1px solid var(--border)}
/* The value column. Monospace so 00061535 and 00061535 line up character for
   character — seeing that two fields carry the same value is the whole point. */
.fieldbox td.sample{font-family:var(--mono);font-size:11px;color:var(--ink);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:0}
.fieldbox td.sample.nosample{color:var(--ink3)}
.fieldbox tr.new td:first-child:before{content:"NEW";font-size:8.5px;font-weight:700;color:var(--gold);
  background:var(--gold-lt);border-radius:3px;padding:1px 4px;margin-right:6px}
.tools{display:flex;gap:8px;align-items:center;margin-bottom:9px;flex-wrap:wrap}
.tools input[type=search]{flex:1;min-width:160px;border:1px solid var(--border);border-radius:var(--r);
  padding:6px 10px;font:inherit;font-size:11.5px;background:var(--surface2);color:var(--ink)}
.tools .n{font-size:11px;color:var(--ink3)}

/* A two-option choice where each option needs a sentence of explanation —
   a select would hide the consequence behind a click. */
.radios{display:grid;gap:8px}
.radios label{display:flex;gap:9px;align-items:flex-start;padding:9px 11px;cursor:pointer;
  border:1px solid var(--border);border-radius:var(--r);background:var(--surface2)}
.radios label:has(input:checked){border-color:var(--ink);background:var(--surface)}
.radios input{margin-top:2px;flex:none}
.radios b{display:block;font-size:12px;font-weight:600}
.radios em{display:block;font-style:normal;font-size:11px;color:var(--ink3);margin-top:2px}

.split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:1100px){.split{grid-template-columns:1fr}.stu{grid-template-columns:1fr}.rail{display:none}}
.jsonbox{border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
.jsonbox .jh{padding:7px 11px;background:var(--surface2);border-bottom:1px solid var(--border);
  font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--ink3);
  display:flex;justify-content:space-between;align-items:center;gap:8px}
.jsonbox pre{border:0;border-radius:0;max-height:300px;font-size:11px;margin:0}
.res{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-bottom:11px;font-size:11.5px}
.spin{display:inline-block;width:11px;height:11px;border:2px solid var(--border2);
  border-top-color:var(--ink);border-radius:50%;animation:sp .6s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.hidden{display:none!important}
.err-inline{color:var(--red);font-size:11.5px;margin-top:7px}
.ok-inline{color:var(--green);font-size:11.5px;margin-top:7px}
.sticky-save{position:sticky;bottom:0;background:var(--surface);border:1px solid var(--border);
  border-radius:var(--r-lg);padding:11px 15px;display:flex;align-items:center;gap:11px;
  flex-wrap:wrap;margin-top:4px;box-shadow:0 -2px 8px rgba(0,0,0,.04);z-index:5}
.sticky-save .msg{font-size:11.5px;color:var(--ink3);flex:1;min-width:140px}
/* ---------- in-app dialog ---------- */
.ovl{position:fixed;inset:0;background:rgba(26,24,22,.42);display:flex;align-items:center;
  justify-content:center;z-index:100;padding:20px;backdrop-filter:blur(1px)}
.ovl[hidden]{display:none}
.dlg{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);
  width:100%;max-width:430px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.18)}
.dlg .dh{padding:13px 17px;border-bottom:1px solid var(--border);background:var(--surface2)}
.dlg .dh h3{margin:0;font-size:13px;font-weight:600;color:var(--ink)}
.dlg .db{padding:16px 17px}
.dlg .db p{margin:0 0 12px;font-size:12.5px;color:var(--ink2);line-height:1.55}
.dlg .db p:last-child{margin-bottom:0}
.dlg input{width:100%;border:1px solid var(--border);border-radius:var(--r);padding:8px 11px;
  font:inherit;font-size:12.5px;color:var(--ink);background:var(--surface2);outline:none}
.dlg input:focus{border-color:var(--blue)}
.dlg .df{padding:12px 17px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;
  gap:8px;background:var(--surface2)}
.dlg .note{font-size:11px;color:var(--ink3);margin-top:9px;line-height:1.45}

code.path{font-family:var(--mono);font-size:11.5px;background:var(--surface2);border:1px solid var(--border);
  border-radius:4px;padding:1px 6px}
`;

/**
 * JSON for a <script type="application/json"> block.
 *
 * NOT html-escaped: the browser does not decode entities inside a script
 * element, so &quot; would arrive literally and JSON.parse would fail. The one
 * thing that must not survive is a closing tag, which is why `<` and the two
 * line separators JSON leaves raw are escaped as \u sequences.
 */
function jsonForScript(value) {
  var LS = String.fromCharCode(0x2028);
  var PS = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .split('<').join('\\u003c')
    .split(LS).join('\\u2028')
    .split(PS).join('\\u2029');
}

function render({ admin, bootstrap, flash }) {
  const body = `
<div class="pg-head"><div>
  <h2 class="pg-title">API Studio</h2>
  <p class="pg-sub">Onboard a supplier's API, wrap it in an endpoint of our own, decide what
    crosses the boundary, and prove it — in one pass.</p>
</div><div class="pg-actions">
  <a class="btn" href="/admin/endpoints">All endpoints</a>
  <button type="button" class="primary" id="newEndpoint">New endpoint</button>
</div></div>

<div class="bar">
  <div class="f" style="min-width:230px">
    <label for="appSel">Application</label>
    <select id="appSel"></select>
  </div>
  <div class="f" style="min-width:300px;flex:1">
    <label for="epSel">Endpoint</label>
    <select id="epSel"></select>
  </div>
  <div class="f" style="min-width:auto">
    <label>&nbsp;</label>
    <span id="epBadges" class="badges"></span>
  </div>
</div>

<div class="stu">
  <aside class="rail">
    <ol>
      <li data-step="1" data-n="1"><b>Third-party API</b><span>Supplier, auth, live test</span></li>
      <li data-step="2" data-n="2"><b>Our endpoint</b><span>Path, type, category</span></li>
      <li data-step="3" data-n="3"><b>Transformation</b><span>Request and response</span></li>
      <li data-step="4" data-n="4"><b>Final test</b><span>What the consumer sees</span></li>
    </ol>
  </aside>

  <div>
    <div class="wizhead">
      <div class="wizbar"><i id="wizfill"></i></div>
      <span class="wizpos" id="wizpos"></span>
    </div>
    <!-- ================= STEP 1 ================= -->
    <section class="step" id="step1">
      <div class="sh" data-toggle="step1">
        <span class="no">1</span><h3>Third-party API</h3>
        <span class="sub">where the data really comes from</span>
        <span class="right"><span id="s1status"></span><span class="caret">▾</span></span>
      </div>
      <div class="sb">
        <div class="fields">
          <div class="f"><label for="upSel">Supplier API</label>
            <select id="upSel"></select>
            <p class="hint">Pick one already onboarded, or add a new one.</p></div>
          <div class="f"><label for="upName">Reference</label>
            <input id="upName" placeholder="cmots" spellcheck="false">
            <p class="hint">Lowercase, no spaces. Used in config, never shown to a consumer.</p></div>
          <div class="f" style="grid-column:span 2"><label for="upBase">Base URL</label>
            <input id="upBase" placeholder="https://supplier.example.com" spellcheck="false">
            <p class="hint">Scheme and host only. The per-endpoint path comes in step 2.</p></div>
          <div class="f"><label for="upAuthType">Authentication</label>
            <select id="upAuthType">
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
              <option value="query">Query parameter</option>
              <option value="basic">Basic auth</option>
            </select></div>
          <div class="f" id="wrapAuthName"><label for="upAuthName">Header / parameter name</label>
            <input id="upAuthName" placeholder="x-api-key" spellcheck="false"></div>
          <div class="f" id="wrapAuthSecret" style="grid-column:span 2">
            <label for="upAuthSecret">Credential</label>
            <input id="upAuthSecret" type="password" autocomplete="new-password"
                   placeholder="paste the supplier's token" spellcheck="false">
            <p class="hint" id="credStatus">Encrypted before it is stored.
              <a href="#" id="envHelp">What protects it?</a></p>
            <div class="tools" id="credTools" style="margin-top:7px">
              <button type="button" id="btnReveal">Show the stored credential</button>
              <span class="n" id="revealNote"></span>
            </div>
            <div class="key hidden" id="revealBox"></div></div>
          <div class="f" id="wrapAuthUser"><label for="upAuthUser">Username</label>
            <input id="upAuthUser" placeholder="for basic auth" spellcheck="false"></div>
          <div class="f" id="wrapAuthEnv"><label for="upAuthEnv">Or: variable name</label>
            <input id="upAuthEnv" placeholder="\${CMOTS_API_TOKEN}" spellcheck="false">
            <p class="hint">Leave the credential blank to keep using an environment
              variable instead. The internal APIs still do.</p></div>
        </div>

        <div class="flash err hidden" id="envWarn" style="margin:14px 0 0"></div>

        <details class="opt">
          <summary>Naming and limits <em>— optional, but three of these are worth a minute</em></summary>
          <div class="fields" style="margin-top:12px">
            <div class="f"><label for="upDisplay">Display name</label>
              <input id="upDisplay" placeholder="CMOTS Stock APIs">
              <p class="hint">What appears in the Catalogue, the Applications list and the
                Postman collection. Without it everyone reads the lowercase reference.</p></div>
            <div class="f"><label for="upVendor">Supplied by</label>
              <input id="upVendor" placeholder="Capital Market Online">
              <p class="hint">Who the company behind the API actually is — the thing nobody
                can remember a year later when the contract comes up.</p></div>
            <div class="f"><label for="upTimeout">Timeout (ms)</label>
              <input id="upTimeout" type="number" min="100" max="120000" value="15000">
              <p class="hint"><strong>Worth checking.</strong> A consumer's call fails at this
                limit too. A large master list routinely needs 60000, and the default of
                15000 is what makes it look as though the supplier is down.</p></div>
          </div>
        </details>

        <fieldset>
          <legend>Test the connection</legend>
          <div class="tools">
            <input type="search" id="testPath" placeholder="/Market/api/CompanyMaster"
                   spellcheck="false" style="font-family:var(--mono)">
            <button type="button" id="btnTestUp">Call the supplier</button>
            <button type="button" id="btnTestKey">Test this key</button>
          </div>
          <p class="hint">"Test this key" uses whatever is typed in Credential above,
            without saving it — so you can find out whether a token works before it
            becomes the one this gateway sends. Leave it blank to test the saved one.</p>
          <div class="res hidden" id="s1res"></div>
          <div class="shape hidden" id="s1shape"></div>
          <div class="jsonbox hidden" id="s1box">
            <div class="jh"><span>What the supplier returned</span>
              <span id="s1meta"></span></div>
            <pre id="s1json"></pre>
          </div>
        </fieldset>

        <div class="formfoot">
          <button type="button" class="primary" id="btnSaveUp">Save supplier API</button>
          <p class="hint" id="s1msg">Nothing is called until you press the button above.</p>
        </div>
        <div class="wiznav">
          <button type="button" class="wizback" data-goto="0">Back</button>
          <button type="button" class="primary wiznext" data-goto="2">Continue</button>
          <span class="wizwhy" id="wizwhy1"></span>
        </div>
      </div>
    </section>

    <!-- ================= STEP 2 ================= -->
    <section class="step" id="step2">
      <div class="sh" data-toggle="step2">
        <span class="no">2</span><h3>Our endpoint</h3>
        <span class="sub">the address we publish instead</span>
        <span class="right"><span id="s2status"></span><span class="caret">▾</span></span>
      </div>
      <div class="sb">
        <div class="fields">
          <div class="f"><label for="epName">Reference</label>
            <input id="epName" placeholder="company_master" spellcheck="false">
            <p class="hint">Permanent. Becomes the scope <code id="scopePreview">ep:…</code>.</p></div>
          <div class="f"><label for="epMethod">Method</label>
            <select id="epMethod"><option>GET</option><option>POST</option><option>PUT</option>
              <option>PATCH</option><option>DELETE</option></select></div>
          <div class="f" style="grid-column:span 2"><label for="epPath">Our path</label>
            <input id="epPath" placeholder="/v1/cmots/company-master/:co_code"
                   spellcheck="false" style="font-family:var(--mono)">
            <p class="hint">What the consumer calls. <code>:name</code> marks a path parameter.</p></div>
          <div class="f" style="grid-column:span 2"><label for="epUpPath">Supplier path</label>
            <input id="epUpPath" placeholder="/Market/api/CompanyMaster/:co_code"
                   spellcheck="false" style="font-family:var(--mono)">
            <p class="hint">Where we forward it. Same <code>:name</code> parameters.</p></div>
        </div>

        <details class="opt">
          <summary>Naming, grouping and limits <em>— optional; the rate limit protects the supplier</em></summary>
          <div class="fields" style="margin-top:12px">
            <div class="f"><label for="epDisplay">Display name</label>
              <input id="epDisplay" placeholder="Company Master">
              <p class="hint">The human name in the Catalogue and in the documentation a
                partner reads. The reference is for config; this is for people.</p></div>
            <div class="f" style="grid-column:span 2"><label for="epDesc">Description</label>
              <input id="epDesc" placeholder="Shown in the vendor-facing API documentation">
              <p class="hint">Goes straight into the partner-facing docs. Written now it takes
                a sentence; written later it is a meeting.</p></div>
            <div class="f"><label for="epType">Type</label><select id="epType"></select>
              <p class="hint">Groups the endpoint in the Catalogue filters.</p></div>
            <div class="f"><label for="epCat">Category</label><select id="epCat"></select>
              <p class="hint">The second filter consumers and admins browse by.</p></div>
            <div class="f"><label for="epRateMax">Rate limit (calls)</label>
              <input id="epRateMax" type="number" min="1" value="60">
              <p class="hint"><strong>Worth setting.</strong> This is what stops one consumer's
                retry loop from taking the supplier down for everybody else.</p></div>
            <div class="f"><label for="epRateWin">per window (ms)</label>
              <input id="epRateWin" type="number" min="1000" value="60000">
              <p class="hint">The window the count above applies to. 60 per 60000 ms is one
                call a second on average.</p></div>
          </div>
        </details>

        <!-- ------------------------------------------------------------
             Which credential THIS endpoint calls with.

             Almost always the supplier's. The override exists for metered
             products, staged token migrations, and keeping the blast radius
             of a leaked key down to one endpoint — see
             009_endpoint_secrets.sql.
             ------------------------------------------------------------ -->
        <fieldset>
          <legend>Key this endpoint calls with</legend>
          <div class="radios" id="epAuthMode">
            <label><input type="radio" name="epAuthMode" value="inherit" checked>
              <span><b>The supplier's key</b><em id="epAuthInherit">whatever is set on the supplier
                API in step 1</em></span></label>
            <label><input type="radio" name="epAuthMode" value="override">
              <span><b>A key just for this endpoint</b><em>stored encrypted, used for this
                endpoint only, and never for its siblings</em></span></label>
          </div>

          <div id="epAuthBox" class="hidden" style="margin-top:12px">
            <div class="fields">
              <div class="f"><label for="epAuthType">How it is sent</label>
                <select id="epAuthType">
                  <option value="bearer">Bearer token</option>
                  <option value="header">Custom header</option>
                  <option value="query">Query parameter</option>
                  <option value="basic">Basic auth</option>
                  <option value="none">No credential at all</option>
                </select>
                <p class="hint">May differ from the supplier's scheme.</p></div>
              <div class="f" id="epWrapAuthName"><label for="epAuthName">Header / parameter name</label>
                <input id="epAuthName" placeholder="x-api-key" spellcheck="false"></div>
              <div class="f" id="epWrapAuthUser"><label for="epAuthUser">Username</label>
                <input id="epAuthUser" placeholder="for basic auth" spellcheck="false"></div>
              <div class="f" id="epWrapAuthSecret" style="grid-column:span 2">
                <label for="epAuthSecret">Key / token</label>
                <input id="epAuthSecret" type="password" autocomplete="new-password"
                       placeholder="paste the key for this endpoint" spellcheck="false">
                <p class="hint" id="epCredStatus">Encrypted with the same key as the supplier
                  credentials. Never stored in plain text and never sent to a consumer.</p>
                <div class="tools" style="margin-top:7px">
                  <button type="button" id="btnSaveEpKey">Save key</button>
                  <button type="button" id="btnTestEpKey">Test key</button>
                  <button type="button" id="btnRevealEpKey">Show saved key</button>
                  <button type="button" id="btnClearEpKey">Remove key</button>
                </div>
                <div class="key hidden" id="epRevealBox"></div>
                <div class="res hidden" id="epKeyRes"></div>
              </div>
            </div>
            <p class="hint">Saving the key and switching this endpoint onto it are two
              separate actions: the key is saved by the button above, the switch by
              saving the endpoint. An endpoint set to use its own key cannot go live
              until a key exists — it will not quietly fall back to the supplier's.</p>
          </div>
        </fieldset>

        <div class="err-inline hidden" id="s2err"></div>
        <div class="wiznav">
          <button type="button" class="wizback" data-goto="1">Back</button>
          <button type="button" class="primary wiznext" data-goto="3">Continue</button>
          <span class="wizwhy" id="wizwhy2"></span>
        </div>
      </div>
    </section>

    <!-- ================= STEP 3 ================= -->
    <section class="step" id="step3">
      <div class="sh" data-toggle="step3">
        <span class="no">3</span><h3>Transformation</h3>
        <span class="sub">what goes in, what comes back</span>
        <span class="right"><span id="s3status"></span><span class="caret">▾</span></span>
      </div>
      <div class="sb">
        <div class="modes" id="modes">
          <div class="mode" data-mode="whitelist"><b>Whitelist</b>
            <span>Build the response from the ticked fields only. A field the supplier
              adds later cannot appear.</span></div>
          <div class="mode warn" data-mode="redact"><b>Redact</b>
            <span>Forward everything except the fields you exclude. New supplier fields
              reach the consumer.</span></div>
          <div class="mode danger" data-mode="passthrough"><b>Passthrough</b>
            <span>Forward the supplier's body verbatim. Nothing is filtered.</span></div>
        </div>
        <div class="flash err hidden" id="modeWarn"></div>

        <fieldset>
          <legend>Request parameters</legend>
          <table class="rowset" id="paramTable">
            <thead><tr>
              <th style="width:19%">Name</th><th style="width:11%">In</th><th style="width:13%">Value from</th>
              <th style="width:11%">Type</th><th style="width:7%">Req</th>
              <th style="width:15%">Fixed / example</th><th>Description</th><th style="width:28px"></th>
            </tr></thead>
            <tbody></tbody>
          </table>
          <div class="tools" style="margin-top:9px">
            <button type="button" id="btnAddParam">Add parameter</button>
            <button type="button" id="btnParamsFromPath">Read from the paths above</button>
            <span class="n" id="paramMsg">A <strong>fixed</strong> or <strong>variable</strong>
              parameter is one the consumer cannot influence — that is how an account code stays
              ours.</span>
          </div>
        </fieldset>

        <fieldset id="fsFields">
          <legend>Response fields</legend>
          <div class="tools">
            <input type="search" id="fieldSearch" placeholder="Filter fields">
            <button type="button" id="btnAll">Tick all</button>
            <button type="button" id="btnNone">Untick all</button>
            <button type="button" id="btnMerge">Add fields from the last test</button>
            <span class="n" id="fieldCount"></span>
            <span class="n" id="fieldMsg"></span>
          </div>
          <div class="fieldbox">
            <table><thead><tr>
              <th style="width:32px"></th><th>Field</th><th style="width:11%">Type</th>
              <th style="width:26%">Value in the last test</th><th style="width:17%">Rename to</th>
            </tr></thead><tbody id="fieldRows"></tbody></table>
          </div>
          <p class="hint" id="fieldHint" style="margin-top:8px"></p>
        </fieldset>

        <fieldset id="fsExclude" class="hidden">
          <legend>Fields to remove</legend>
          <div class="fieldbox" style="max-height:230px">
            <table><thead><tr><th style="width:32px"></th><th>Field</th><th>Meaning</th></tr></thead>
            <tbody id="excludeRows"></tbody></table>
          </div>
        </fieldset>
        <div class="wiznav">
          <button type="button" class="wizback" data-goto="2">Back</button>
          <button type="button" class="primary wiznext" data-goto="4">Continue</button>
          <span class="wizwhy" id="wizwhy3"></span>
        </div>
      </div>
    </section>

    <!-- ================= STEP 4 ================= -->
    <section class="step" id="step4">
      <div class="sh" data-toggle="step4">
        <span class="no">4</span><h3>Final test</h3>
        <span class="sub">the consumer's view, before anyone is given it</span>
        <span class="right"><span id="s4status"></span><span class="caret">▾</span></span>
      </div>
      <div class="sb">
        <div class="fields" id="testParams"></div>
        <div class="tools" style="margin-top:14px">
          <button type="button" class="primary" id="btnTestEp">Run the endpoint</button>
          <span class="n" id="s4note"></span>
        </div>
        <div class="res hidden" id="s4res"></div>
        <div class="split hidden" id="s4split">
          <div class="jsonbox"><div class="jh"><span>Supplier → us</span><span id="s4upmeta"></span></div>
            <pre id="s4raw"></pre></div>
          <div class="jsonbox"><div class="jh"><span>Us → consumer</span><span id="s4vmeta"></span></div>
            <pre id="s4proj"></pre></div>
        </div>
        <div class="err-inline hidden" id="s4err"></div>
      </div>
    </section>

    <div class="sticky-save">
      <button type="button" class="primary" id="btnSave">Save draft</button>
      <button type="button" id="btnPublish">Publish</button>
      <button type="button" class="danger hidden" id="btnWithdraw">Withdraw</button>
      <span class="msg" id="saveMsg">A draft is never routed. Publishing is the moment it
        starts answering.</span>
    </div>
  </div>
</div>

<div class="ovl" id="dlgOverlay" hidden>
  <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
    <div class="dh"><h3 id="dlgTitle"></h3></div>
    <div class="db">
      <p id="dlgBody"></p>
      <input id="dlgInput" class="hidden" autocomplete="off">
      <p class="note hidden" id="dlgNote"></p>
    </div>
    <div class="df">
      <button type="button" id="dlgCancel">Cancel</button>
      <button type="button" class="primary" id="dlgOk">OK</button>
    </div>
  </div>
</div>

<style>${STUDIO_CSS}</style>
<script id="bootstrapData" type="application/json">${jsonForScript(bootstrap)}</script>
<script src="/admin/studio.js" defer></script>`;

  return layout({ title: 'API Studio', admin, current: '/admin/studio', body, flash });
}

/**
 * Shown instead of the Studio when the database cannot serve it.
 *
 * A 503 with the reason named, because "An unexpected error occurred" sends an
 * operator to the logs when the answer is one sentence long.
 */
function unavailable({ admin, problem }) {
  const body = `
${pageHead('API Studio', 'The Studio cannot start until the database is in step with the application.')}
<section class="panel">
  <div class="ph"><h3>${esc(problem.title)}</h3></div>
  <div class="pd">
    <p style="margin-top:0">${esc(problem.detail)}</p>
    <pre style="margin-top:12px">${esc(problem.raw || '')}</pre>
    <p class="hint" style="margin-bottom:0">Migrations live in <code>db/migrations/</code> in the
      repository and are applied with pgAdmin against the <code>gateway</code> database. Every one
      of them is safe to run twice.</p>
  </div>
</section>`;
  return layout({ title: 'API Studio', admin, current: '/admin/studio', body, flash: null });
}

module.exports = { render, unavailable };
