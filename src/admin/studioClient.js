/* eslint-env browser */
'use strict';

/**
 * API Studio — browser side.
 *
 * Served as a file rather than inlined so it is real JavaScript: node parses
 * it at boot, and a syntax error shows up then rather than as a blank panel in
 * someone's browser.
 *
 * Deliberately framework-free. The state is one object, every change calls
 * render(), and render() rewrites only the parts that depend on it. At this
 * size that is less machinery to be wrong than any alternative.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var boot = JSON.parse($('bootstrapData').textContent);

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  var S = {
    app: boot.applications.length ? boot.applications[0].code : '',
    endpointName: boot.selected || '',
    upstream: null,      // the row being edited in step 1
    ep: null,            // the endpoint being edited
    params: [],
    fields: [],
    mode: 'whitelist',
    lastSample: null,    // body from the most recent step-1 test
    discovered: [],
    described: {},
    dirty: false,
    filter: ''
  };

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function opt(value, label, selected) {
    var o = el('option', { value: value, text: label });
    if (selected) o.selected = true;
    return o;
  }
  function fill(sel, items, value, placeholder) {
    sel.innerHTML = '';
    if (placeholder) sel.appendChild(opt('', placeholder, !value));
    items.forEach(function (i) { sel.appendChild(opt(i.value, i.label, i.value === value)); });
  }
  function slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '').replace(/_+/g, '_').slice(0, 48);
  }
  function pathParams(tpl) {
    var out = [], re = /:([A-Za-z0-9_]+)/g, m;
    while ((m = re.exec(String(tpl || '')))) if (out.indexOf(m[1]) === -1) out.push(m[1]);
    return out;
  }
  function pretty(v) {
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }
  function badge(kind, text) { return el('span', { class: 'badge ' + kind, text: text }); }
  function show(node, on) { node.classList[on ? 'remove' : 'add']('hidden'); }

  /**
   * In-app dialog, used for everything the browser would otherwise handle.
   *
   * window.prompt and window.confirm are the browser's, not ours: they cannot
   * be styled, cannot explain themselves properly, are suppressed outright in
   * some setups, and look like something has gone wrong with the page. This is
   * the same mechanism for asking a question, confirming a destructive act, or
   * telling someone something — in the console's own type and colours.
   *
   * Returns a promise: the typed string, true, or null when dismissed.
   */
  function dialog(opts) {
    var ovl = $('dlgOverlay');
    var input = $('dlgInput');
    var note = $('dlgNote');
    $('dlgTitle').textContent = opts.title || '';
    $('dlgBody').textContent = opts.body || '';
    $('dlgOk').textContent = opts.ok || 'OK';
    $('dlgCancel').textContent = opts.cancel || 'Cancel';
    show($('dlgCancel'), opts.cancel !== false);
    $('dlgOk').className = opts.danger ? 'danger' : 'primary';

    var wantsInput = opts.input === true;
    show(input, wantsInput);
    input.value = opts.value || '';
    input.placeholder = opts.placeholder || '';
    show(note, !!opts.note);
    note.textContent = opts.note || '';

    ovl.hidden = false;
    if (wantsInput) input.focus(); else $('dlgOk').focus();

    return new Promise(function (resolve) {
      function done(value) {
        ovl.hidden = true;
        $('dlgOk').removeEventListener('click', onOk);
        $('dlgCancel').removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        ovl.removeEventListener('mousedown', onBackdrop);
        resolve(value);
      }
      function onOk() { done(wantsInput ? input.value : true); }
      function onCancel() { done(null); }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        if (e.key === 'Enter' && wantsInput) { e.preventDefault(); onOk(); }
      }
      // Clicking the backdrop dismisses, clicking the card does not.
      function onBackdrop(e) { if (e.target === ovl) done(null); }
      $('dlgOk').addEventListener('click', onOk);
      $('dlgCancel').addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
      ovl.addEventListener('mousedown', onBackdrop);
    });
  }

  function api(path, body, method) {
    return fetch(path, {
      method: method || (body ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        // Blocks a cross-origin HTML form from reaching these routes: a form
        // cannot set this header, and the cookie is SameSite=Strict anyway.
        'x-requested-with': 'studio'
      },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('request failed with ' + r.status));
        return j;
      });
    });
  }

  function busy(btn, on, label) {
    btn.disabled = on;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Working…'; }
    else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
  }

  // ---------------------------------------------------------------------
  // Step collapsing + rail
  // ---------------------------------------------------------------------
  /**
   * One step at a time.
   *
   * All four steps used to render at once — a single page about 1,900px tall,
   * every field of every step on it, mandatory and optional indistinguishable,
   * and no way to tell where you were except by scrolling. The four steps were
   * already modelled; they were simply all open.
   *
   * Going FORWARD is gated on the step being complete, and the reason sits
   * beside the button that is refusing — a disabled control with no
   * explanation is the thing people file tickets about. Going BACK is never
   * gated: you may always return to look at, or fix, what you already did.
   */
  var STEP_COUNT = 4;
  S.step = 1;

  function val(id) { var n = $(id); return n ? String(n.value || '').trim() : ''; }

  /** Is this step done, and if not, what exactly is missing? */
  function stepReady(n) {
    if (n === 1) {
      if (!S.upstream || !S.upstream.name) {
        return { ok: false, why: 'Save the supplier API first — step 2 attaches your ' +
          'endpoint to one.' };
      }
      return { ok: true };
    }
    if (n === 2) {
      var miss = [];
      if (!val('epName')) miss.push('a reference');
      if (!val('epPath')) miss.push('the path we publish');
      if (!val('epUpPath')) miss.push('the supplier path');
      return miss.length
        ? { ok: false, why: 'Still needs ' + miss.join(', ') + '.' }
        : { ok: true };
    }
    if (n === 3) {
      if (S.mode === 'whitelist') {
        var on = S.fields.filter(function (f) { return f.exposed; }).length;
        return on ? { ok: true } : { ok: false, why: 'Tick at least one field — a ' +
          'whitelist with none would hand the consumer an empty object.' };
      }
      return { ok: true };
    }
    return { ok: true };
  }

  function goToStep(n) {
    if (n < 1) n = 1;
    if (n > STEP_COUNT) n = STEP_COUNT;
    S.step = n;
    for (var i = 1; i <= STEP_COUNT; i++) {
      var sec = $('step' + i);
      if (sec) {
        sec.classList.toggle('away', i !== n);
        sec.classList.remove('collapsed');
      }
    }
    paintWizard();
    var head = $('wizpos');
    if (head && head.scrollIntoView) head.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function paintWizard() {
    var fill = $('wizfill');
    if (fill) fill.style.width = Math.round((S.step / STEP_COUNT) * 100) + '%';
    var pos = $('wizpos');
    if (pos) pos.textContent = 'Step ' + S.step + ' of ' + STEP_COUNT;

    Array.prototype.forEach.call(document.querySelectorAll('.rail li'), function (li) {
      var n = Number(li.getAttribute('data-step'));
      li.classList.toggle('active', n === S.step);
      // Done means complete, not merely visited — the tick is a claim.
      li.classList.toggle('done', n < S.step && stepReady(n).ok);
    });

    for (var i = 1; i <= STEP_COUNT; i++) {
      var btn = document.querySelector('#step' + i + ' .wiznext');
      var why = $('wizwhy' + i);
      if (!btn) continue;
      var r = stepReady(i);
      btn.disabled = !r.ok;
      if (why) why.textContent = r.ok ? '' : r.why;
    }
  }

  ['epName', 'epPath', 'epUpPath'].forEach(function (id) {
    var n = $(id);
    if (n) n.addEventListener('input', paintWizard);
  });

  Array.prototype.forEach.call(document.querySelectorAll('.wiznext'), function (b) {
    b.addEventListener('click', function () {
      var to = Number(b.getAttribute('data-goto'));
      if (to > STEP_COUNT) return;            // "Done" on the last step
      goToStep(to);
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.wizback'), function (b) {
    b.addEventListener('click', function () { goToStep(Number(b.getAttribute('data-goto'))); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.rail li'), function (li) {
    li.addEventListener('click', function () {
      // Backwards is always allowed; forwards only as far as the work permits,
      // so clicking step 4 from step 1 lands on the step actually blocking you.
      var want = Number(li.getAttribute('data-step'));
      var limit = 1;
      while (limit < want && stepReady(limit).ok) limit++;
      goToStep(want <= S.step ? want : limit);
    });
  });

  // ---------------------------------------------------------------------
  // Top bar
  // ---------------------------------------------------------------------
  function appItems() {
    return boot.applications.map(function (a) {
      return { value: a.code, label: a.name + ' · ' + a.endpoint_count + ' endpoints' };
    });
  }
  function endpointItems() {
    return boot.endpoints.filter(function (e) { return !S.app || e.application === S.app; })
      .map(function (e) {
        return {
          value: e.name,
          label: (e.display_name || e.name) + '  —  ' + e.path +
                 '  [' + e.status + (e.exposed_count ? ', ' + e.exposed_count + ' fields' : '') + ']'
        };
      });
  }

  function renderBar() {
    fill($('appSel'), appItems(), S.app);
    fill($('epSel'), endpointItems(), S.endpointName, '— new endpoint —');
    var b = $('epBadges');
    b.innerHTML = '';
    if (S.ep && S.ep.name) {
      b.appendChild(badge(S.ep.status === 'live' ? 'ok' : S.ep.status === 'retired' ? 'off' : 'warn',
        S.ep.status));
      b.appendChild(badge('mute', S.mode));
      if (S.ep.last_test_status) {
        b.appendChild(badge(S.ep.last_test_status < 400 ? 'ok' : 'off',
          'last test ' + S.ep.last_test_status));
      }
    }
    show($('btnWithdraw'), !!(S.ep && S.ep.status === 'live'));
    $('btnPublish').textContent = S.ep && S.ep.status === 'live' ? 'Republish' : 'Publish';
  }

  $('appSel').addEventListener('change', function () {
    S.app = this.value;
    S.endpointName = '';
    loadEndpoint(null);
    renderBar();
    renderDropdowns();
    appExamples();
  });

  /**
   * Make the worked example follow the application you picked.
   *
   * Every placeholder in this form was CMOTS — invisible while onboarding
   * CMOTS, and indistinguishable from a wrongly pre-filled form the moment
   * you choose anything else. An application is one supplier now, so its own
   * code and name are the example that belongs here.
   */
  function appExamples() {
    var app = (boot.applications || []).filter(function (a) { return a.code === S.app; })[0];
    if (!app) return;
    var ref = $('upName');
    var disp = $('upDisplay');
    // Only the placeholder. Writing a VALUE would be the bug this is fixing —
    // a field that looks filled in but was never decided.
    if (ref) ref.placeholder = 'e.g. ' + app.code;
    if (disp) disp.placeholder = 'e.g. ' + (app.name || app.code);
  }
  $('epSel').addEventListener('change', function () {
    var want = this.value;
    var previous = S.endpointName;
    // Put the picker back until the guard has been answered, so the dropdown
    // never shows an endpoint the form is not actually displaying.
    this.value = previous;
    var sel = this;
    guard(function () {
      sel.value = want;
      if (!want) { loadEndpoint(null); return; }
      api('/admin/api/endpoint/' + encodeURIComponent(want)).then(function (j) {
        loadEndpoint(j.endpoint);
      }).catch(flashErr);
    });
  });
  // "New endpoint" is a link to the chooser now, not a button that clears the
  // form in place. The guard still has to run, or unsaved work leaves without
  // asking — so intercept, ask, and only then follow the link.
  (function () {
    var n = $('newEndpoint');
    if (!n) return;
    n.addEventListener('click', function (e) {
      if (!S.dirty) return;                       // nothing to lose; let it go
      e.preventDefault();
      guard(function () { location.href = n.getAttribute('href') || '/admin/onboard'; });
    });
  })();

  // ---------------------------------------------------------------------
  // Step 1 — supplier
  // ---------------------------------------------------------------------
  function upstreamItems() {
    return boot.upstreams.filter(function (u) { return !S.app || !u.application || u.application === S.app; })
      .map(function (u) {
        return { value: u.name, label: (u.display_name || u.name) + '  —  ' + u.base_url };
      });
  }

  function renderUpstream() {
    var u = S.upstream || {};
    fill($('upSel'), upstreamItems(), u.name || '', '— add a new supplier API —');
    $('upName').value = u.name || '';
    $('upDisplay').value = u.display_name || '';
    $('upVendor').value = u.vendor_name || '';
    $('upBase').value = u.base_url || '';
    $('upTimeout').value = u.timeout_ms || 15000;
    $('upAuthType').value = u.auth_type || 'none';
    $('upAuthName').value = u.auth_name || '';
    $('upAuthEnv').value = u.auth_value_env || '';
    $('upAuthUser').value = '';
    // Never prefilled, and never arrives from the server. An empty box on a
    // supplier that already has a credential means "leave it alone".
    $('upAuthSecret').value = '';
    renderCredStatus(u.credential || null);
    authVisibility();
    var st = $('s1status');
    st.innerHTML = '';
    if (u.name) {
      if (u.last_test_status) {
        st.appendChild(badge(u.last_test_status < 400 ? 'ok' : 'off',
          u.last_test_status + ' · ' + (u.last_test_ms || '?') + 'ms'));
      } else st.appendChild(badge('mute', 'never tested'));
    }
  }

  function authVisibility() {
    var t = $('upAuthType').value;
    show($('wrapAuthName'), t === 'header' || t === 'query');
    show($('wrapAuthEnv'), t !== 'none');
    show($('wrapAuthSecret'), t !== 'none');
    show($('wrapAuthUser'), t === 'basic');
  }

  /**
   * Show the stored credential.
   *
   * Full-access admins only, enforced on the server — this button simply
   * hides itself when the answer would be 403. Every press is written to
   * secret_audit with who asked and why, so reading a token is an event
   * rather than a silent lookup.
   */
  $('btnReveal').addEventListener('click', function () {
    var btn = this;
    var name = slug($('upName').value);
    if (!name) { msg('revealNote', 'Save the supplier API first.', true); return; }
    dialog({
      title: 'Show the stored credential',
      body: 'This is recorded against your name in the credential access log, ' +
            'with whatever you write here.',
      input: true,
      placeholder: 'What do you need it for?',
      note: 'The value is cleared from the screen after a minute.',
      ok: 'Show it'
    }).then(function (reason) {
      if (reason === null) return null;
      busy(btn, true, 'Reading…');
      return api('/admin/api/upstream/' + encodeURIComponent(name) + '/credential/reveal',
                 { reason: reason, slot: 'value' });
    }).then(function (j) {
        if (!j) return;
        var box = $('revealBox');
        box.textContent = j.value;
        show(box, true);
        msg('revealNote', 'Recorded in the access log. Hidden again when you leave this page.', false);
        // Not left on screen indefinitely: a console open on someone's desk is
        // the most common way a credential walks.
        clearTimeout(window.__revealTimer);
        window.__revealTimer = setTimeout(function () {
          box.textContent = '';
          show(box, false);
          msg('revealNote', 'Hidden again.', false);
        }, 60000);
      })
      .catch(function (e) { msg('revealNote', e.message, true); })
      .then(function () { busy(btn, false); });
  });

  /** What the console is allowed to say about a credential. */
  function renderCredStatus(c) {
    var n = $('credStatus');
    if (!n) return;
    // Nothing to reveal until something is stored.
    show($('credTools'), !!(c && c.stored));
    show($('revealBox'), false);
    if (c && c.stored) {
      n.innerHTML = '';
      n.appendChild(badge('ok', 'stored ' + (c.hint || '••••')));
      if (c.keyId) n.appendChild(badge('mute', 'key ' + c.keyId));
      var who = c.setBy ? ' by ' + c.setBy : '';
      n.appendChild(document.createTextNode(
        '  Encrypted' + (c.setAt ? ' ' + fmtWhen(c.setAt) : '') + who +
        '. Leave the box empty to keep it; type a new one to replace it.'));
    } else {
      n.textContent = 'Encrypted before it is stored, and never shown again.';
    }
  }
  function fmtWhen(d) {
    try {
      var x = new Date(d);
      var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][x.getMonth()];
      return x.getDate() + '-' + m + '-' + x.getFullYear();
    } catch (e) { return ''; }
  }
  $('upAuthType').addEventListener('change', authVisibility);

  $('upSel').addEventListener('change', function () {
    var found = boot.upstreams.filter(function (u) { return u.name === this.value; }.bind(this))[0];
    S.upstream = found || null;
    renderUpstream();
    if (found && !$('epUpPath').value) $('testPath').value = found.health_path || '';
  });

  $('upDisplay').addEventListener('blur', function () {
    if (!$('upName').value) $('upName').value = slug(this.value);
  });

  $('envHelp').addEventListener('click', function (e) {
    e.preventDefault();
    alertBox('The token is sealed with AES-256-GCM before it reaches a column, and the key ' +
      'is NOT in the database — it is GW_SECRET_KEY in /etc/api-gateway/env. That separation ' +
      'is the whole mechanism: a backup, a replica or a dump decrypts to nothing on its own. ' +
      'Each row records which key sealed it, so keys can be rotated without an outage. The ' +
      'token is never sent back to this page, and never appears in a log.');
  });

  function collectUpstream() {
    return {
      name: slug($('upName').value),
      application: S.app || null,
      displayName: $('upDisplay').value.trim() || null,
      vendorName: $('upVendor').value.trim() || null,
      baseUrl: $('upBase').value.trim(),
      timeoutMs: Number($('upTimeout').value) || 15000,
      authType: $('upAuthType').value,
      authName: $('upAuthName').value.trim() || null,
      authValueEnv: $('upAuthEnv').value.trim() || null,
      // Sent only when the operator typed something. An empty box leaves the
      // stored credential exactly as it was.
      authSecret: $('upAuthSecret').value || undefined,
      authUser: $('upAuthUser').value.trim() || undefined,
      healthPath: $('testPath').value.trim() || null
    };
  }

  $('btnSaveUp').addEventListener('click', function () {
    var btn = this, row = collectUpstream();
    if (!row.name || !row.baseUrl) { msg('s1msg', 'A reference and a base URL are needed.', true); return; }
    busy(btn, true, 'Saving…');
    api('/admin/api/upstream', row).then(function (j) {
      S.upstream = j.upstream;
      var i = -1;
      boot.upstreams.forEach(function (u, ix) { if (u.name === j.upstream.name) i = ix; });
      if (i >= 0) boot.upstreams[i] = j.upstream; else boot.upstreams.push(j.upstream);
      if (j.credential) S.upstream.credential = j.credential;
      renderUpstream();
      // The box is cleared on purpose: the value is gone from this page now,
      // and leaving it filled would suggest it could be read back.
      $('upAuthSecret').value = '';
      msg('s1msg', 'Saved. ' + (j.envHint || ''), false);
      // Step 2 depends on a saved supplier, so the Continue button has to
      // notice that it now exists. Without this the gate stays shut after the
      // very action that opens it.
      paintWizard();
      $('step1').classList.add('ok');
    }).catch(function (e) { msg('s1msg', e.message, true); })
      .then(function () { busy(btn, false); });
  });

  $('btnTestUp').addEventListener('click', function () {
    var btn = this;
    var row = collectUpstream();
    var path = $('testPath').value.trim();
    if (!row.baseUrl || !path) { msg('s1msg', 'Base URL and a path to call are both needed.', true); return; }
    busy(btn, true, 'Calling…');
    show($('s1res'), true);
    $('s1res').innerHTML = '';
    $('s1res').appendChild(el('span', { class: 'spin' }));
    api('/admin/api/test-upstream', { upstream: row, path: path }).then(function (j) {
      var r = j.result;
      var res = $('s1res');
      res.innerHTML = '';
      res.appendChild(badge(r.ok ? 'ok' : 'off', r.status ? 'HTTP ' + r.status : 'no answer'));
      if (r.ms !== undefined) res.appendChild(badge('mute', r.ms + ' ms'));
      if (r.bytes) res.appendChild(badge('mute', r.bytes + ' bytes'));
      if (j.fields && j.fields.length) {
        res.appendChild(badge('info', j.fields.length + ' fields found'));
      }
      if (r.error) res.appendChild(el('span', { class: 'err-inline', text: r.error }));
      renderShape(j.shape);
      if (r.body !== undefined && r.body !== null) {
        S.lastSample = r.body;
        S.discovered = j.fields || [];
        // path -> {type, sample}. Held in the page only, never saved.
        S.described = {};
        (j.described || []).forEach(function (d) {
          S.described[d.path] = { type: d.type, sample: d.sample };
        });
        renderFields();
        show($('s1box'), true);
        $('s1json').textContent = pretty(r.body);
        $('s1meta').textContent = (j.fields || []).length + ' leaf fields';
        $('step1').classList.add('ok');
        // The header badge said "never tested" until this moment; it should
        // now say what just happened rather than waiting for a page reload.
        var s1 = $('s1status');
        s1.innerHTML = '';
        s1.appendChild(badge(r.ok ? 'ok' : 'off', r.status + ' · ' + r.ms + 'ms'));
        renderFields();
      } else if (r.raw) {
        show($('s1box'), true);
        $('s1json').textContent = r.raw;
        $('s1meta').textContent = 'not JSON';
      }
    }).catch(function (e) {
      $('s1res').innerHTML = '';
      $('s1res').appendChild(el('span', { class: 'err-inline', text: e.message }));
    }).then(function () { busy(btn, false); });
  });

  // ---------------------------------------------------------------------
  // Step 2 — our endpoint
  // ---------------------------------------------------------------------
  function renderDropdowns() {
    fill($('epType'), boot.types.map(function (t) { return { value: t.code, label: t.label }; }),
      S.ep && S.ep.api_type, '— choose —');
    var cats = boot.categories.filter(function (c) { return c.application === S.app; });
    fill($('epCat'), cats.map(function (c) { return { value: c.code, label: c.label }; }),
      S.ep && S.ep.category, cats.length ? '— choose —' : 'no categories for this application');
  }

  function renderEndpoint() {
    var e = S.ep || {};
    $('epName').value = e.name || '';
    $('epDisplay').value = e.display_name || '';
    $('epMethod').value = e.method || 'GET';
    $('epPath').value = e.path || '';
    $('epUpPath').value = e.upstream_path || '';
    $('epRateMax').value = e.rate_max || 60;
    $('epRateWin').value = e.rate_window_ms || 60000;
    $('epDesc').value = e.description || '';
    $('scopePreview').textContent = 'ep:' + (e.name || '…');
    renderEndpointAuth();
    renderDropdowns();
    var st = $('s2status');
    st.innerHTML = '';
    if (e.path) st.appendChild(badge('mute', (e.method || 'GET') + ' ' + e.path));
  }

  // ---------------------------------------------------------------------
  // The credential this endpoint calls with
  //
  // Two statements, kept apart on purpose: "we hold this key" (the Save key
  // button, which writes to endpoint_secrets) and "we send this key" (the
  // radio, which is part of the endpoint and saves with it). Merging them
  // would mean a paste silently changed what the gateway puts on the wire.
  // ---------------------------------------------------------------------
  function epAuthMode() {
    var r = document.querySelector('input[name=epAuthMode]:checked');
    return r ? r.value : 'inherit';
  }

  function renderEndpointAuth() {
    var e = S.ep || {};
    var mode = e.auth_mode === 'override' ? 'override' : 'inherit';
    Array.prototype.forEach.call(document.getElementsByName('epAuthMode'), function (r) {
      r.checked = r.value === mode;
    });
    $('epAuthType').value = e.auth_type || 'bearer';
    $('epAuthName').value = e.auth_name || '';
    $('epAuthUser').value = '';
    // Never prefilled and never sent back by the server. Empty means "leave
    // whatever is stored alone".
    $('epAuthSecret').value = '';
    var inh = $('epAuthInherit');
    if (inh) {
      inh.textContent = S.upstream && S.upstream.auth_type && S.upstream.auth_type !== 'none'
        ? 'the ' + S.upstream.auth_type + ' credential on ' + S.upstream.name
        : 'whatever is set on the supplier API in step 1';
    }
    epAuthVisibility();
    renderEpCredStatus(S.epCredential || null);
  }

  function epAuthVisibility() {
    var on = epAuthMode() === 'override';
    var t = $('epAuthType').value;
    show($('epAuthBox'), on);
    show($('epWrapAuthName'), t === 'header' || t === 'query');
    show($('epWrapAuthUser'), t === 'basic');
    show($('epWrapAuthSecret'), t !== 'none');
  }

  function renderEpCredStatus(c) {
    var n = $('epCredStatus');
    if (!n) return;
    show($('epRevealBox'), false);
    n.innerHTML = '';
    if (c && c.secret_stored) {
      n.appendChild(badge('ok', 'stored ' + (c.secret_hint || '••••').replace(/^\*{4}/, '••••')));
      if (c.key_id) n.appendChild(badge('mute', 'key ' + c.key_id));
      n.appendChild(document.createTextNode(
        '  Encrypted' + (c.set_at ? ' ' + fmtWhen(c.set_at) : '') +
        (c.set_by ? ' by ' + c.set_by : '') +
        '. Leave the box empty to keep it; type a new one to replace it.'));
    } else if (c && c.broken) {
      n.appendChild(badge('off', 'no key saved'));
      n.appendChild(document.createTextNode(
        '  This endpoint is set to use its own key and none is stored, so it ' +
        'cannot go live. It will not fall back to the supplier credential.'));
    } else {
      n.textContent = 'Encrypted with the same key as the supplier credentials. ' +
        'Never stored in plain text and never sent to a consumer.';
    }
  }

  /** Pull the saved status for this endpoint's own key, if it has a name yet. */
  function loadEpCredential() {
    var name = slug($('epName').value);
    if (!name) { S.epCredential = null; renderEpCredStatus(null); return Promise.resolve(); }
    return api('/admin/api/endpoint/' + encodeURIComponent(name) + '/credential', null, 'GET')
      .then(function (j) { S.epCredential = j.credential || null; renderEpCredStatus(S.epCredential); })
      .catch(function () { /* a new endpoint has none; not an error worth showing */ });
  }

  Array.prototype.forEach.call(document.getElementsByName('epAuthMode'), function (r) {
    r.addEventListener('change', function () {
      S.dirty = true;
      epAuthVisibility();
      if (epAuthMode() === 'override') loadEpCredential();
    });
  });
  $('epAuthType').addEventListener('change', function () { S.dirty = true; epAuthVisibility(); });

  $('btnSaveEpKey').addEventListener('click', function () {
    var btn = this, name = slug($('epName').value), token = $('epAuthSecret').value;
    if (!name) { msg('epCredStatus', 'Save the endpoint first — a key is stored against its reference.', true); return; }
    if (!token) { msg('epCredStatus', 'Nothing to save. Paste the key above first.', true); return; }
    dialog({
      title: 'Save this key',
      body: 'It is encrypted before it is written and will be used for ' + name +
            ' only. Any key already stored for this endpoint is replaced.',
      ok: 'Save it'
    }).then(function (go) {
      if (!go) return null;
      busy(btn, true, 'Saving…');
      return api('/admin/api/endpoint/' + encodeURIComponent(name) + '/credential', {
        token: token,
        username: $('epAuthUser').value.trim() || undefined
      });
    }).then(function (j) {
      if (!j) return;
      $('epAuthSecret').value = '';
      $('epAuthUser').value = '';
      S.epCredential = j.credential || null;
      renderEpCredStatus(S.epCredential);
    }).catch(function (e) { msg('epCredStatus', e.message, true); })
      .then(function () { busy(btn, false); });
  });

  /**
   * Try a key against the supplier before committing to it.
   *
   * Uses whatever is typed in the box if anything is, otherwise the stored
   * one. A typed value is sent for this one call and is not written down.
   */
  $('btnTestEpKey').addEventListener('click', function () {
    var btn = this, name = slug($('epName').value);
    var u = S.upstream || {};
    if (!u.base_url) { msg('epCredStatus', 'Pick a supplier API in step 1 first.', true); return; }
    var path = $('epUpPath').value.trim() || $('testPath').value.trim();
    if (!path) { msg('epCredStatus', 'Fill in the supplier path above, so there is something to call.', true); return; }
    busy(btn, true, 'Calling…');
    api('/admin/api/test-credential', {
      scope: 'endpoint',
      name: name,
      upstream: u.name,
      baseUrl: u.base_url,
      timeoutMs: u.timeout_ms,
      path: path,
      values: testValues(),
      authType: $('epAuthType').value,
      authName: $('epAuthName').value.trim() || null,
      token: $('epAuthSecret').value || undefined,
      username: $('epAuthUser').value.trim() || undefined
    }).then(function (j) {
      var box = $('epKeyRes');
      box.innerHTML = '';
      box.appendChild(badge(j.ok ? 'ok' : 'off', j.ok ? 'accepted' : 'refused'));
      if (j.status) box.appendChild(badge('mute', 'HTTP ' + j.status));
      if (j.ms) box.appendChild(badge('mute', j.ms + 'ms'));
      if (j.fields) box.appendChild(badge('mute', j.fields + ' fields'));
      if (j.error) box.appendChild(document.createTextNode(' ' + j.error));
      show(box, true);
    }).catch(function (e) { msg('epCredStatus', e.message, true); })
      .then(function () { busy(btn, false); });
  });

  $('btnRevealEpKey').addEventListener('click', function () {
    var btn = this, name = slug($('epName').value);
    if (!name) { msg('epCredStatus', 'Save the endpoint first.', true); return; }
    dialog({
      title: 'Show this endpoint’s key',
      body: 'This is recorded against your name in the credential access log, ' +
            'with whatever you write here.',
      input: true,
      placeholder: 'What do you need it for?',
      note: 'The value is cleared from the screen after a minute.',
      ok: 'Show it'
    }).then(function (reason) {
      if (reason === null) return null;
      busy(btn, true, 'Reading…');
      return api('/admin/api/endpoint/' + encodeURIComponent(name) + '/credential/reveal',
                 { reason: reason, slot: 'value' });
    }).then(function (j) {
      if (!j) return;
      var box = $('epRevealBox');
      box.textContent = j.value;
      show(box, true);
      clearTimeout(window.__epRevealTimer);
      window.__epRevealTimer = setTimeout(function () {
        box.textContent = '';
        show(box, false);
      }, 60000);
    }).catch(function (e) { msg('epCredStatus', e.message, true); })
      .then(function () { busy(btn, false); });
  });

  $('btnClearEpKey').addEventListener('click', function () {
    var btn = this, name = slug($('epName').value);
    if (!name) { msg('epCredStatus', 'Nothing to remove.', true); return; }
    dialog({
      title: 'Remove this key',
      body: 'The stored key for ' + name + ' is deleted. If this endpoint is set to ' +
            'use its own key it will stop being served until a new one is saved — it ' +
            'does not fall back to the supplier credential.',
      danger: true,
      ok: 'Remove it'
    }).then(function (go) {
      if (!go) return null;
      busy(btn, true, 'Removing…');
      return api('/admin/api/endpoint/' + encodeURIComponent(name) + '/credential/clear', {});
    }).then(function (j) {
      if (!j) return;
      S.epCredential = j.credential || null;
      renderEpCredStatus(S.epCredential);
    }).catch(function (e) { msg('epCredStatus', e.message, true); })
      .then(function () { busy(btn, false); });
  });

  $('epName').addEventListener('input', function () {
    this.value = slug(this.value);
    $('scopePreview').textContent = 'ep:' + (this.value || '…');
    S.dirty = true;
  });
  $('epDisplay').addEventListener('blur', function () {
    if (!$('epName').value) { $('epName').value = slug(this.value); }
    if (!$('epPath').value && this.value && S.app) {
      $('epPath').value = '/v1/' + S.app + '/' + slug(this.value).replace(/_/g, '-');
    }
    $('scopePreview').textContent = 'ep:' + ($('epName').value || '…');
  });

  // ---------------------------------------------------------------------
  // Step 3 — transformation
  // ---------------------------------------------------------------------
  /**
   * @param {boolean} byUser  true when someone clicked a mode; false when we
   *   are just rendering a loaded endpoint.
   *
   * The distinction matters: loadEndpoint() marks the form clean and then
   * renders it, and rendering must not mark it dirty again. It did, which made
   * every freshly loaded endpoint look like it had unsaved changes — and was
   * why leaving the page asked you to confirm when you had typed nothing.
   */
  function setMode(m, byUser) {
    S.mode = m;
    Array.prototype.forEach.call(document.querySelectorAll('.mode'), function (n) {
      n.classList.toggle('on', n.getAttribute('data-mode') === m);
    });
    show($('fsFields'), m === 'whitelist');
    show($('fsExclude'), m === 'redact');
    // There is nothing to tick when the body is not JSON, and showing an empty
    // field list next to a status line reads as a bug rather than a mode.
    show($('fsText'), m === 'text');
    var warn = $('modeWarn');
    if (m === 'text') {
      warn.textContent = 'The supplier’s reply is forwarded exactly as it arrives, because a ' +
        'status line has no fields to filter. Pick this when the reply looks like ' +
        '1701|9199…|OK rather than { }. If you leave the failure match blank, a send that ' +
        'the supplier rejected inside a 200 will be recorded here as a success.';
      show(warn, true);
    } else if (m === 'passthrough') {
      warn.textContent = 'Passthrough forwards the supplier’s body exactly as it arrives. ' +
        'Anything they add later — a PAN, an internal cost — reaches the consumer the day they add it. ' +
        'Publishing records that you chose this.';
      show(warn, true);
    } else if (m === 'redact') {
      warn.textContent = 'Redact removes the fields you name and forwards the rest, so a field the ' +
        'supplier adds tomorrow is exposed by default. Whitelist is the other way round.';
      show(warn, true);
    } else show(warn, false);
    renderFields();
    if (byUser) S.dirty = true;
  }
  Array.prototype.forEach.call(document.querySelectorAll('.mode'), function (n) {
    n.addEventListener('click', function () { setMode(n.getAttribute('data-mode'), true); });
  });

  // --- request parameters ---
  var LOCS = ['path', 'query', 'header', 'body'];
  var SRCS = [['vendor', 'the consumer'], ['fixed', 'a fixed value'], ['env', 'a variable'],
    ['secret', 'a secret']];
  var TYPES = ['string', 'int', 'number', 'bool', 'date', 'enum'];

  function renderParams() {
    var tb = $('paramTable').querySelector('tbody');
    tb.innerHTML = '';
    S.params.forEach(function (p, i) {
      var tr = el('tr');
      tr.appendChild(el('td', {}, [input(p, 'name', 'co_code')]));
      tr.appendChild(el('td', {}, [select(p, 'location', LOCS.map(function (l) { return [l, l]; }))]));
      tr.appendChild(el('td', {}, [select(p, 'source', SRCS)]));
      tr.appendChild(el('td', {}, [select(p, 'data_type', TYPES.map(function (t) { return [t, t]; }))]));
      var cb = el('input', { type: 'checkbox' });
      cb.checked = p.required !== false;
      cb.addEventListener('change', function () { p.required = cb.checked; S.dirty = true; });
      tr.appendChild(el('td', { style: 'text-align:center' }, [cb]));
      tr.appendChild(el('td', {}, [valueCell(p)]));
      tr.appendChild(el('td', {}, [input(p, 'description', 'CMOTS company code')]));
      var x = el('button', { class: 'x', type: 'button', text: '×', title: 'Remove' });
      x.addEventListener('click', function () { S.params.splice(i, 1); renderParams(); renderTestParams(); });
      tr.appendChild(el('td', {}, [x]));
      tb.appendChild(tr);
    });
    if (!S.params.length) {
      tb.appendChild(el('tr', {}, [el('td', { colspan: '8', class: 'empty',
        text: 'No parameters. Add one, or press "Read from the paths above".' })]));
    }
  }
  /**
   * The value column, which depends on where the value comes from.
   *
   * A secret is the only one that is write-once. After it is saved the server
   * sends back the last four characters and nothing else — it has no way to
   * send more, because the screen is fed from a view with no ciphertext column
   * in it. So the cell shows the mask and a Replace button rather than an
   * input that would sit there looking editable and empty.
   *
   * p.plaintext is set ONLY while someone is typing a new one, and is posted
   * once. An untouched secret posts nothing, which is why editing an endpoint
   * does not mean re-entering every password.
   */
  function valueCell(p) {
    if (p.source !== 'secret') {
      return input(p, p.source === 'vendor' ? 'example' : 'fixed_value',
        p.source === 'vendor' ? '6' : '${TENANT_ID}');
    }

    if (p.secret_set && p.plaintext === undefined) {
      var wrap = el('span', { class: 'secretcell' });
      wrap.appendChild(el('code', { class: 'masked', text: p.secret_masked || '••••' }));
      var b = el('button', { type: 'button', class: 'linky', text: 'Replace' });
      b.addEventListener('click', function () {
        p.plaintext = '';
        S.dirty = true;
        renderParams();
      });
      wrap.appendChild(b);
      if (p.secret_set_by) {
        wrap.appendChild(el('span', { class: 'n',
          text: 'set by ' + p.secret_set_by }));
      }
      return wrap;
    }

    var n = el('input', {
      type: 'password', value: p.plaintext || '',
      placeholder: p.secret_set ? 'type the new one' : 'paste it once',
    });
    n.setAttribute('autocomplete', 'new-password');
    n.addEventListener('input', function () { p.plaintext = n.value; S.dirty = true; });
    return n;
  }

  function input(obj, key, ph) {
    var n = el('input', { value: obj[key] || '', placeholder: ph || '' });
    n.addEventListener('input', function () {
      obj[key] = n.value; S.dirty = true;
      if (key === 'name') renderTestParams();
    });
    return n;
  }
  function select(obj, key, pairs) {
    var n = el('select');
    pairs.forEach(function (p) { n.appendChild(opt(p[0], p[1], obj[key] === p[0])); });
    n.addEventListener('change', function () { obj[key] = n.value; S.dirty = true; renderParams(); });
    return n;
  }

  $('btnAddParam').addEventListener('click', function () {
    S.params.push({ name: '', location: 'query', source: 'vendor', data_type: 'string', required: true });
    renderParams();
  });

  $('btnParamsFromPath').addEventListener('click', function () {
    var names = pathParams($('epPath').value).concat(pathParams($('epUpPath').value));
    var added = 0;
    names.forEach(function (n) {
      var exists = S.params.some(function (p) { return p.name === n; });
      if (!exists) {
        S.params.push({ name: n, location: 'path', source: 'vendor', data_type: 'string', required: true });
        added++;
      }
    });
    S.params.forEach(function (p) {
      if (names.indexOf(p.name) !== -1) p.location = 'path';
    });
    renderParams();
    renderTestParams();
    msg('paramMsg', added ? added + ' parameter(s) added from the paths.'
      : 'Every path parameter is already listed.', false);
  });

  /**
   * "What kind of API is this", under the step-1 result.
   *
   * Nothing here is a question. The classification comes from the call that
   * just happened, because asking somebody to pick an API type before they
   * have read the response produces an answer nothing later contradicts.
   *
   * Ordered stop, then warn, then info: the thing that blocks you is the
   * thing you should read first, and on a long list nobody reaches the end.
   */
  function renderShape(shape) {
    var box = $('s1shape');
    if (!box) return;
    box.innerHTML = '';
    if (!shape) { show(box, false); return; }
    show(box, true);

    box.appendChild(el('div', { class: 'shape-kind', text: shape.kind || '' }));
    if (shape.summary) box.appendChild(el('div', { class: 'shape-sum', text: shape.summary }));

    var rank = { stop: 0, warn: 1, info: 2 };
    var items = (shape.findings || []).slice().sort(function (a, b) {
      return (rank[a.level] === undefined ? 3 : rank[a.level]) -
             (rank[b.level] === undefined ? 3 : rank[b.level]);
    });
    items.forEach(function (f) {
      var row = el('div', { class: 'shape-f ' + f.level });
      row.appendChild(el('b', { text: f.title }));
      row.appendChild(el('span', { text: f.text }));
      box.appendChild(row);
    });
  }

  // --- response fields ---
  function renderFields() {
    var tb = $('fieldRows');
    tb.innerHTML = '';
    var q = S.filter.toLowerCase();
    var shown = S.fields.filter(function (f) {
      return !q || f.path.toLowerCase().indexOf(q) !== -1 ||
        (f.description || '').toLowerCase().indexOf(q) !== -1;
    });
    // GROUPED BY PARENT, and the prefix said once.
    //
    // A supplier response is rarely flat. An account list arrives as
    // data[].dpId, data[].dpName, data[].dpAccount … and a flat list of fifty
    // of those is fifty rows that begin with the same eleven characters, with
    // the part that differs pushed to where the eye is not looking. Grouping
    // states `data[]` once as a heading and leaves each row showing only what
    // makes it itself.
    var groups = {}, order = [];
    shown.forEach(function (f) {
      var i = f.path.lastIndexOf('.');
      var parent = i === -1 ? '' : f.path.slice(0, i);
      if (!groups[parent]) { groups[parent] = []; order.push(parent); }
      groups[parent].push(f);
    });

    order.forEach(function (parent) {
      var rows = groups[parent];
      if (parent) {
        var on = rows.filter(function (f) { return f.exposed; }).length;
        var head = el('tr', { class: 'grp' });
        var tick = el('input', { type: 'checkbox' });
        tick.checked = on === rows.length;
        // Indeterminate when a group is part-chosen: unticked would claim
        // nothing in it is exposed, which on a long list is a lie you act on.
        tick.indeterminate = on > 0 && on < rows.length;
        tick.addEventListener('change', function () {
          rows.forEach(function (f) { f.exposed = tick.checked; });
          S.dirty = true; renderFields();
        });
        head.appendChild(el('td', {}, [tick]));
        head.appendChild(el('td', { class: 'mono grp-name', colspan: '4',
          text: parent + (parent.slice(-2) === '[]' ? '  — one per item in the list' : '') +
            '   ·   ' + on + ' of ' + rows.length }));
        tb.appendChild(head);
      }

      rows.forEach(function (f) {
        var tr = el('tr', { class: (f.exposed ? '' : 'off ') + (f.discovered ? 'new' : '') +
          (parent ? ' child' : '') });
        var cb = el('input', { type: 'checkbox' });
        cb.checked = !!f.exposed;
        cb.addEventListener('change', function () {
          f.exposed = cb.checked; S.dirty = true; renderFields();
        });
        tr.appendChild(el('td', {}, [cb]));

        var leaf = parent ? f.path.slice(parent.length + 1) : f.path;
        var nameCell = el('td', { class: 'mono' });
        nameCell.appendChild(el('span', { class: 'leaf', text: leaf }));
        nameCell.title = f.path;
        tr.appendChild(nameCell);

        var d = (S.described || {})[f.path] || {};
        tr.appendChild(el('td', { class: 't2', text: f.data_type || d.type || '—' }));

        // The sample is why this column exists. Two fields called dpAccount
        // and dpCode look like two things until both show 00061535.
        var sample = d.sample;
        tr.appendChild(el('td', {
          class: 'sample' + (sample === null || sample === undefined ? ' nosample' : ''),
          text: sample === null || sample === undefined ? '—' : sample,
        }));

        var rn = el('input', { value: f.rename_to || '', placeholder: '—' });
        rn.addEventListener('input', function () { f.rename_to = rn.value || null; S.dirty = true; });
        tr.appendChild(el('td', {}, [rn]));
        tb.appendChild(tr);
      });
    });
    if (!shown.length) {
      tb.appendChild(el('tr', {}, [el('td', { colspan: '5', class: 'empty',
        text: S.fields.length ? 'Nothing matches that filter.'
          : 'No fields yet — run the test in step 1 and press "Add fields from the last test".' })]));
    }
    var on = S.fields.filter(function (f) { return f.exposed; }).length;
    $('fieldCount').textContent = on + ' of ' + S.fields.length + ' exposed';
    $('fieldHint').textContent = S.mode === 'whitelist'
      ? 'The consumer receives exactly these ' + on + ' field(s) and nothing else. A field the ' +
        'supplier adds later arrives unticked, so it cannot leak by default.'
      : '';
    renderExclude();
    paintWizard();
    $('step3').classList.toggle('ok', S.mode !== 'whitelist' || on > 0);
    var st = $('s3status');
    st.innerHTML = '';
    st.appendChild(badge(S.mode === 'whitelist' ? 'ok' : S.mode === 'redact' ? 'warn' : 'off', S.mode));
    if (S.mode === 'whitelist') st.appendChild(badge('mute', on + ' fields'));
  }

  function renderExclude() {
    var tb = $('excludeRows');
    if (!tb) return;
    tb.innerHTML = '';
    S.fields.forEach(function (f) {
      var tr = el('tr', { class: f.exposed ? '' : 'off' });
      var cb = el('input', { type: 'checkbox' });
      // In redact mode the tick means "remove this one", the inverse of exposed.
      cb.checked = !f.exposed;
      cb.addEventListener('change', function () { f.exposed = !cb.checked; S.dirty = true; renderFields(); });
      tr.appendChild(el('td', {}, [cb]));
      tr.appendChild(el('td', { class: 'mono', text: f.path }));
      tr.appendChild(el('td', { class: 't2', text: f.description || '' }));
      tb.appendChild(tr);
    });
  }

  $('fieldSearch').addEventListener('input', function () { S.filter = this.value; renderFields(); });
  $('btnAll').addEventListener('click', function () {
    S.fields.forEach(function (f) { f.exposed = true; }); S.dirty = true; renderFields();
  });
  $('btnNone').addEventListener('click', function () {
    S.fields.forEach(function (f) { f.exposed = false; }); S.dirty = true; renderFields();
  });
  $('btnMerge').addEventListener('click', function () {
    if (!S.discovered.length) {
      msg('fieldMsg', 'Run the test in step 1 first — there is nothing to add yet.', true);
      return;
    }
    var have = {};
    S.fields.forEach(function (f) { have[f.path] = f; });
    var added = 0;
    S.discovered.forEach(function (p) {
      if (!have[p]) {
        // Arrives unticked on purpose: a field nobody has decided about is not
        // a field the consumer should be receiving.
        var d = (S.described || {})[p] || {};
        S.fields.push({ path: p, exposed: false, discovered: true,
          data_type: d.type || null, description: null });
        added++;
      }
    });
    S.dirty = true;
    renderFields();
    msg('fieldMsg', added ? added + ' new field(s) added, unticked — decide on each one.'
      : 'The test showed nothing the list did not already have.', false);
  });

  // ---------------------------------------------------------------------
  // Step 4 — final test
  // ---------------------------------------------------------------------
  function renderTestParams() {
    var box = $('testParams');
    box.innerHTML = '';
    var ps = S.params.filter(function (p) { return p.source === 'vendor' && p.name; });
    if (!ps.length) {
      box.appendChild(el('p', { class: 'hint', text: 'This endpoint takes no caller parameters.' }));
      return;
    }
    ps.forEach(function (p) {
      var f = el('div', { class: 'f' });
      f.appendChild(el('label', { for: 'tp_' + p.name, text: p.name + (p.required !== false ? ' *' : '') }));
      var i = el('input', { id: 'tp_' + p.name, value: p.testValue || p.example || '',
        placeholder: p.example || '' });
      i.addEventListener('input', function () { p.testValue = i.value; });
      f.appendChild(i);
      if (p.description || (p.allowed && p.allowed.length)) {
        f.appendChild(el('p', { class: 'hint',
          text: (p.description || '') + (p.allowed && p.allowed.length ? '  (' + p.allowed.join(' / ') + ')' : '') }));
      }
      box.appendChild(f);
    });
  }

  /** The sample values typed into step 4, keyed by parameter name. */
  function testValues() {
    var values = {};
    S.params.forEach(function (p) {
      if (p.source === 'vendor' && p.name) values[p.name] = p.testValue || p.example || '';
    });
    return values;
  }

  $('btnTestEp').addEventListener('click', function () {
    var btn = this;
    var values = testValues();
    busy(btn, true, 'Running…');
    show($('s4err'), false);
    show($('s4res'), true);
    $('s4res').innerHTML = '';
    $('s4res').appendChild(el('span', { class: 'spin' }));
    $('s4res').appendChild(el('span', { class: 'n', id: 's4probe',
      text: 'checking whether the supplier is reachable…' }));

    // Answer "can we even reach them" first, while the real call is still
    // running. A TCP/TLS handshake comes back in milliseconds; the call
    // itself can hang for the full timeout. When it does, this is the line
    // that says whether the host is down or the endpoint is wrong — two
    // problems that look identical from a request that never returns.
    S.lastProbe = null;
    api('/admin/api/probe', { baseUrl: collectUpstream().baseUrl })
      .then(function (pr) {
        S.lastProbe = pr;
        var n = $('s4probe');
        if (!n) return;
        n.textContent = '';
        n.appendChild(badge(pr.reachable ? 'ok' : 'off',
          pr.reachable ? 'host reachable · ' + pr.ms + ' ms'
                       : 'host NOT reachable' + (pr.why ? ' — ' + pr.why : '')));
      })
      .catch(function () {
        var n = $('s4probe');
        if (n) n.textContent = '';
      });
    api('/admin/api/test-endpoint', {
      upstream: collectUpstream(),
      upstreamPath: $('epUpPath').value.trim(),
      values: values,
      mode: S.mode,
      fields: S.fields.filter(function (f) { return f.exposed; }).map(function (f) { return f.path; }),
      exclude: S.fields.filter(function (f) { return !f.exposed; }).map(function (f) { return f.path; }),
      rename: S.fields.reduce(function (acc, f) {
        if (f.exposed && f.rename_to) acc[f.path] = f.rename_to;
        return acc;
      }, {}),
      endpoint: S.ep && S.ep.name ? S.ep.name : null,
      // The configured parameters, so the test calls the supplier the way the
      // live request will. Without these it called the bare URL and reported
      // whatever the supplier says to an empty request — green on the screen,
      // meaningless in fact.
      // The Studio has no upstream-method control yet, so use what was
      // saved. ACL's listener is a GET sitting behind our POST.
      upstreamMethod: (S.ep && S.ep.upstream_method) || 'GET',
      params: S.params.filter(function (p) { return p.name; }).map(function (p) {
        return {
          name: p.name, location: p.location, source: p.source,
          forwardAs: p.forward_as || null,
          // Never the sealed value — the browser does not have it and must
          // not. The server resolves it from the vault by endpoint and name.
          fixedValue: p.source === 'secret' ? null : (p.fixed_value || null)
        };
      }),
      // So the final test exercises the credential the live call would use,
      // not the supplier-wide one this endpoint may have been moved off.
      authMode: epAuthMode(),
      authType: $('epAuthType').value,
      authName: $('epAuthName').value.trim() || null
    }).then(function (j) {
      var r = j.result, res = $('s4res');
      // A text endpoint has no fields, so every count here is zero and the
      // whitelist language ("0 reach the consumer", "no field is ticked") is
      // not just unhelpful, it reads as a failure on an endpoint that is
      // working exactly as configured. What matters instead is the supplier's
      // reply itself, and whether the failure word appears in it.
      var isText = S.mode === 'text';
      res.innerHTML = '';
      // r.ok means "answered AND parsed as JSON", which is false by
      // definition for a text endpoint. Colour the status by the status.
      var httpOk = isText ? (r.status >= 200 && r.status < 300) : r.ok;
      res.appendChild(badge(httpOk ? 'ok' : 'off', r.status ? 'HTTP ' + r.status : 'no answer'));
      if (r.ms !== undefined) res.appendChild(badge('mute', r.ms + ' ms'));
      // Keep the reachability answer visible next to the result. On a
      // failure it is the first thing anyone needs, and clearing it the
      // moment the call lands throws away the more useful half.
      if (S.lastProbe) {
        res.appendChild(badge(S.lastProbe.reachable ? 'ok' : 'off',
          S.lastProbe.reachable ? 'host reachable' : 'host NOT reachable'));
      }

      var supplierText = (r.raw === undefined || r.raw === null) ? '' : String(r.raw);
      var failWord = ($('epTextFail').value || '').trim();
      var looksFailed = isText && failWord
        && supplierText.toLowerCase().indexOf(failWord.toLowerCase()) !== -1;

      if (isText) {
        res.appendChild(badge('mute', 'not JSON — forwarded as it arrives'));
        if (failWord) {
          res.appendChild(badge(looksFailed ? 'off' : 'ok',
            looksFailed ? 'the failure word is in this reply' : 'no failure word'));
        } else {
          res.appendChild(badge('warn', 'no failure word set'));
        }
      } else if (j.upstreamFields !== undefined) {
        res.appendChild(badge('mute', j.upstreamFields + ' fields from the supplier'));
        res.appendChild(badge(j.exposedFields ? 'info' : 'off', j.exposedFields + ' reach the consumer'));
        var held = j.upstreamFields - j.exposedFields;
        if (held > 0) res.appendChild(badge('ok', held + ' withheld'));
      }

      show($('s4split'), true);
      if (isText) {
        $('s4raw').textContent = supplierText || '(the supplier sent an empty body)';
        $('s4upmeta').textContent = supplierText.length + ' characters';
        $('s4proj').textContent = supplierText || '(nothing)';
        $('s4vmeta').textContent = 'forwarded whole';
      } else {
        $('s4raw').textContent = pretty(r.body);
        $('s4upmeta').textContent = j.upstreamFields + ' fields';
        $('s4proj').textContent = j.projection && j.projection.ok ? pretty(j.projection.result)
          : (j.projection ? j.projection.error : '');
        $('s4vmeta').textContent = j.exposedFields + ' fields';
      }

      // "the body is not JSON" is a FAULT for a JSON endpoint and the entire
      // point of a text one. Showing it in red under a text endpoint that
      // worked contradicts the green badge beside it, and reads as though
      // something needs fixing when nothing does.
      var realError = r.error && !(isText && /not JSON/i.test(r.error)) ? r.error : null;
      if (realError) { $('s4err').textContent = realError; show($('s4err'), true); }
      if (!isText && j.projection && !j.projection.ok) {
        $('s4err').textContent = j.projection.error; show($('s4err'), true);
      }
      if (isText && looksFailed) {
        $('s4err').textContent = 'The supplier answered HTTP ' + r.status +
          ' but its reply contains "' + failWord + '", so this send FAILED. ' +
          'That is the whole point of the failure word — without it this would ' +
          'have been recorded as a success.';
        show($('s4err'), true);
      }

      // For a text endpoint "passed" means the call was made and the reply
      // does not contain the failure word. A projection it never performs
      // must not decide the verdict.
      var passed = isText ? httpOk && !looksFailed
                          : !!(r.ok && j.projection && j.projection.ok);
      $('step4').classList.toggle('ok', passed);
      var st = $('s4status'); st.innerHTML = '';
      st.appendChild(badge(passed ? 'ok' : 'off', passed ? 'passed' : 'failed'));
    }).catch(function (e) {
      $('s4res').innerHTML = '';
      $('s4err').textContent = e.message; show($('s4err'), true);
    }).then(function () { busy(btn, false); });
  });

  // ---------------------------------------------------------------------
  // Save / publish
  // ---------------------------------------------------------------------
  function collectEndpoint() {
    return {
      name: slug($('epName').value),
      application: S.app || null,
      displayName: $('epDisplay').value.trim() || null,
      category: $('epCat').value || null,
      apiType: $('epType').value || null,
      description: $('epDesc').value.trim() || null,
      method: $('epMethod').value,
      path: $('epPath').value.trim(),
      upstream: slug($('upName').value),
      upstreamPath: $('epUpPath').value.trim(),
      responseMode: S.mode,
      responseExclude: S.mode === 'redact'
        ? S.fields.filter(function (f) { return !f.exposed; }).map(function (f) { return f.path; })
        : [],
      // Sent as null outside text mode, so a value typed and then abandoned by
      // switching mode does not sit in the database looking as though it does
      // something. The column has a CHECK saying the same thing.
      responseFailureMatch: S.mode === 'text' ? ($('epTextFail').value.trim() || null) : null,
      responseContentType: S.mode === 'text' ? ($('epTextCt').value.trim() || null) : null,
      rateMax: Number($('epRateMax').value) || 60,
      rateWindowMs: Number($('epRateWin').value) || 60000,
      authMode: epAuthMode(),
      authType: epAuthMode() === 'override' ? $('epAuthType').value : null,
      authName: epAuthMode() === 'override' ? ($('epAuthName').value.trim() || null) : null,
      params: S.params.map(function (p) {
        return {
          name: p.name, location: p.location, source: p.source, dataType: p.data_type,
          required: p.required !== false,
          // A secret never travels in this field. The server blanks it too and
          // the database has a CHECK saying the same, so three layers have to
          // fail before a password reaches a plaintext column.
          fixedValue: p.source === 'secret' ? null : (p.fixed_value || null),
          // Present only while someone is typing a new one. An untouched
          // secret posts nothing and is left exactly as it is.
          plaintext: p.source === 'secret' && typeof p.plaintext === 'string' && p.plaintext
            ? p.plaintext : undefined,
          allowed: p.allowed || [], example: p.example || null, description: p.description || null,
          forwardAs: p.forward_as || null
        };
      }).filter(function (p) { return p.name; }),
      fields: S.fields.map(function (f) {
        return {
          path: f.path, dataType: f.data_type || null, description: f.description || null,
          exposed: !!f.exposed, renameTo: f.rename_to || null, sensitive: !!f.sensitive,
          discovered: !!f.discovered
        };
      })
    };
  }

  function save() {
    var row = collectEndpoint();
    if (!row.name) throw new Error('The endpoint needs a reference.');
    if (!row.path) throw new Error('The endpoint needs a path of our own.');
    if (!row.upstream) throw new Error('Pick or save a supplier API in step 1 first.');
    if (!row.upstreamPath) throw new Error('The supplier path in step 2 is empty.');
    return api('/admin/api/endpoint', row).then(function (j) {
      S.ep = j.endpoint;
      S.dirty = false;
      // Re-read the parameters from what was actually stored.
      //
      // Without this a secret you just typed keeps showing as an editable
      // password box, because `secret_set` is still whatever it was when the
      // page loaded. There is then NO way to tell from the screen whether the
      // password was stored or silently lost — which is exactly the position
      // one of us was in for a day. After this it flips to ••••xxxx and a
      // Replace link, which is a positive confirmation rather than an absence
      // of error.
      if (j.endpoint && j.endpoint.params) {
        S.params = j.endpoint.params.map(function (q) { return Object.assign({}, q); });
        renderParams();
        renderTestParams();
      }
      var i = -1;
      boot.endpoints.forEach(function (e, ix) { if (e.name === j.endpoint.name) i = ix; });
      var summary = j.summary || j.endpoint;
      if (i >= 0) boot.endpoints[i] = summary; else boot.endpoints.push(summary);
      S.endpointName = j.endpoint.name;
      renderBar();
      return j;
    });
  }

  $('btnSave').addEventListener('click', function () {
    var btn = this;
    busy(btn, true, 'Saving…');
    Promise.resolve().then(save).then(function () {
      msg('saveMsg', 'Saved as a draft. It is not routed until you publish.', false);
    }).catch(function (e) { msg('saveMsg', e.message, true); })
      .then(function () { busy(btn, false); });
  });

  $('btnPublish').addEventListener('click', function () {
    var btn = this;
    busy(btn, true, 'Publishing…');
    Promise.resolve().then(save).then(function () {
      return api('/admin/api/endpoint/' + encodeURIComponent(S.ep.name) + '/status', { status: 'live' });
    }).then(function (j) {
      S.ep = j.endpoint;
      renderBar();
      msg('saveMsg', 'Live. ' + (j.note || ''), false);
    }).catch(function (e) { msg('saveMsg', e.message, true); })
      .then(function () { busy(btn, false); });
  });

  $('btnWithdraw').addEventListener('click', function () {
    var btn = this;
    busy(btn, true, 'Withdrawing…');
    api('/admin/api/endpoint/' + encodeURIComponent(S.ep.name) + '/status', { status: 'draft' })
      .then(function (j) {
        S.ep = j.endpoint; renderBar();
        msg('saveMsg', 'Withdrawn. It stopped answering within a few seconds.', false);
      }).catch(function (e) { msg('saveMsg', e.message, true); })
      .then(function () { busy(btn, false); });
  });

  /**
   * Unsaved-work guard.
   *
   * The browser's "Leave site?" box is gone — it cannot say what is unsaved or
   * offer to save it, and it appears in a style that belongs to nothing. In
   * its place: anything in this console that would discard the form asks
   * first, in our own dialog, with the option to save on the way out.
   *
   * A hard reload or a typed URL still leaves without asking. That is the
   * trade for not using the browser's box, and it is the right way round: the
   * paths people actually take are covered, and the one that is not is the one
   * someone takes deliberately.
   */
  function guard(action) {
    if (!S.dirty) return action();
    dialog({
      title: 'This endpoint has unsaved changes',
      body: 'Save it as a draft before leaving? A draft is never routed, so saving ' +
            'costs nothing.',
      ok: 'Save and continue',
      cancel: 'Discard and continue'
    }).then(function (answer) {
      if (answer === null) { S.dirty = false; action(); return; }   // discard
      Promise.resolve().then(save).then(function () {
        msg('saveMsg', 'Saved as a draft.', false);
        action();
      }).catch(function (e) { msg('saveMsg', e.message, true); });
    });
  }

  /**
   * Any edit inside steps 2 and 3 marks the form unsaved.
   *
   * Previously only a handful of fields did, so the guard could not fire for
   * the rest — you could retype a path, leave, and lose it silently. One
   * delegated listener covers every control in those panels, including ones
   * added later, which is the point: a new field should not have to remember
   * to opt in.
   *
   * Step 1 is excluded: it has its own Save button and its own object, and
   * typing a supplier's base URL is not an unsaved change to THIS endpoint.
   */
  ['step2', 'step3'].forEach(function (id) {
    var panel = $(id);
    if (!panel) return;
    ['input', 'change'].forEach(function (evt) {
      panel.addEventListener(evt, function (e) {
        var t = e.target;
        if (!t || !t.tagName) return;
        if (['INPUT', 'SELECT', 'TEXTAREA'].indexOf(t.tagName) === -1) return;
        S.dirty = true;
      });
    });
  });

  // Every link out of the Studio goes through the guard.
  Array.prototype.forEach.call(document.querySelectorAll('aside nav a, .pg-actions a'),
    function (a) {
      a.addEventListener('click', function (e) {
        if (!S.dirty) return;
        e.preventDefault();
        guard(function () { window.location.href = a.getAttribute('href'); });
      });
    });

  // ---------------------------------------------------------------------
  // Loading an endpoint into the four steps
  // ---------------------------------------------------------------------
  function loadEndpoint(e) {
    S.ep = e || null;
    S.endpointName = e ? e.name : '';
    S.params = e ? (e.params || []).map(function (p) { return Object.assign({}, p); }) : [];
    S.fields = e ? (e.fields || []).map(function (f) { return Object.assign({}, f); }) : [];
    S.mode = e ? e.response_mode : 'whitelist';
    $('epTextFail').value = e && e.text_failure_match ? e.text_failure_match : '';
    $('epTextCt').value = e && e.text_content_type ? e.text_content_type : '';
    S.dirty = false;
    if (e) {
      S.app = e.application || S.app;
      var up = boot.upstreams.filter(function (u) { return u.name === e.upstream; })[0];
      S.upstream = up || null;
      $('testPath').value = e.sample_path
        ? String(e.sample_path).replace(/^https?:\/\/[^/]+/, '')
        : (e.upstream_path || '');
    } else {
      $('testPath').value = '';
    }
    S.epCredential = null;
    renderBar();
    renderUpstream();
    renderEndpoint();
    if (e && e.auth_mode === 'override') loadEpCredential();
    setMode(S.mode, false);
    renderParams();
    renderFields();
    renderTestParams();
    // Last word, after every render: what is on screen is exactly what was
    // loaded, so there is nothing to save.
    S.dirty = false;
    $('step1').classList.toggle('ok', !!(S.upstream && S.upstream.last_test_status &&
      S.upstream.last_test_status < 400));
    $('step2').classList.toggle('ok', !!(e && e.path));
    // Open where the work is. Loading a half-built endpoint and landing on
    // step 1 makes somebody click through screens they already finished; the
    // first step that is NOT complete is the one they came back for.
    var land = 1;
    while (land < STEP_COUNT && stepReady(land).ok) land++;
    goToStep(e ? land : 1);
    show($('s1box'), false);
    show($('s1res'), false);
    show($('s4split'), false);
    show($('s4res'), false);
  }

  // ---------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------
  function msg(id, text, isErr) {
    var n = $(id);
    if (!n) return;
    n.textContent = text;
    n.classList.remove('hidden');
    n.style.color = isErr ? 'var(--red)' : 'var(--ink3)';
  }
  function flashErr(e) { msg('saveMsg', e.message, true); }
  function alertBox(text) { msg('s1msg', text, false); }

  // ---------------------------------------------------------------------
  // Go
  // ---------------------------------------------------------------------
  renderBar();
  renderDropdowns();
  if (boot.selectedEndpoint) loadEndpoint(boot.selectedEndpoint);
  else loadEndpoint(null);
})();
