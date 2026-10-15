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
  Array.prototype.forEach.call(document.querySelectorAll('[data-toggle]'), function (h) {
    h.addEventListener('click', function () {
      $(h.getAttribute('data-toggle')).classList.toggle('collapsed');
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.rail li'), function (li) {
    li.addEventListener('click', function () {
      var s = $('step' + li.getAttribute('data-step'));
      s.classList.remove('collapsed');
      s.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  });
  $('epSel').addEventListener('change', function () {
    if (!this.value) { loadEndpoint(null); return; }
    api('/admin/api/endpoint/' + encodeURIComponent(this.value)).then(function (j) {
      loadEndpoint(j.endpoint);
    }).catch(flashErr);
  });
  $('newEndpoint').addEventListener('click', function () { loadEndpoint(null); });

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
    var reason = window.prompt(
      'This will be recorded against your name in the credential access log.\n\n' +
      'What do you need it for?', '');
    if (reason === null) return;
    busy(btn, true, 'Reading…');
    api('/admin/api/upstream/' + encodeURIComponent(name) + '/credential/reveal',
        { reason: reason, slot: 'value' })
      .then(function (j) {
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
      if (r.body !== undefined && r.body !== null) {
        S.lastSample = r.body;
        S.discovered = j.fields || [];
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
    renderDropdowns();
    var st = $('s2status');
    st.innerHTML = '';
    if (e.path) st.appendChild(badge('mute', (e.method || 'GET') + ' ' + e.path));
  }

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
  function setMode(m) {
    S.mode = m;
    Array.prototype.forEach.call(document.querySelectorAll('.mode'), function (n) {
      n.classList.toggle('on', n.getAttribute('data-mode') === m);
    });
    show($('fsFields'), m === 'whitelist');
    show($('fsExclude'), m === 'redact');
    var warn = $('modeWarn');
    if (m === 'passthrough') {
      warn.textContent = 'Passthrough forwards the supplier’s body exactly as it arrives. ' +
        'Anything they add later — a PAN, an internal cost — reaches the vendor the day they add it. ' +
        'Publishing records that you chose this.';
      show(warn, true);
    } else if (m === 'redact') {
      warn.textContent = 'Redact removes the fields you name and forwards the rest, so a field the ' +
        'supplier adds tomorrow is exposed by default. Whitelist is the other way round.';
      show(warn, true);
    } else show(warn, false);
    renderFields();
    S.dirty = true;
  }
  Array.prototype.forEach.call(document.querySelectorAll('.mode'), function (n) {
    n.addEventListener('click', function () { setMode(n.getAttribute('data-mode')); });
  });

  // --- request parameters ---
  var LOCS = ['path', 'query', 'header', 'body'];
  var SRCS = [['vendor', 'the vendor'], ['fixed', 'a fixed value'], ['env', 'a variable']];
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
      tr.appendChild(el('td', {}, [input(p, p.source === 'vendor' ? 'example' : 'fixed_value',
        p.source === 'vendor' ? '6' : '${TENANT_ID}')]));
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

  // --- response fields ---
  function renderFields() {
    var tb = $('fieldRows');
    tb.innerHTML = '';
    var q = S.filter.toLowerCase();
    var shown = S.fields.filter(function (f) {
      return !q || f.path.toLowerCase().indexOf(q) !== -1 ||
        (f.description || '').toLowerCase().indexOf(q) !== -1;
    });
    shown.forEach(function (f) {
      var tr = el('tr', { class: (f.exposed ? '' : 'off ') + (f.discovered ? 'new' : '') });
      var cb = el('input', { type: 'checkbox' });
      cb.checked = !!f.exposed;
      cb.addEventListener('change', function () {
        f.exposed = cb.checked; S.dirty = true; renderFields();
      });
      tr.appendChild(el('td', {}, [cb]));
      tr.appendChild(el('td', { class: 'mono', text: f.path }));
      tr.appendChild(el('td', { class: 't2', text: f.data_type || '—' }));
      var rn = el('input', { value: f.rename_to || '', placeholder: '—' });
      rn.addEventListener('input', function () { f.rename_to = rn.value || null; S.dirty = true; });
      tr.appendChild(el('td', {}, [rn]));
      tr.appendChild(el('td', { class: 't2', text: f.description || '' }));
      tb.appendChild(tr);
    });
    if (!shown.length) {
      tb.appendChild(el('tr', {}, [el('td', { colspan: '5', class: 'empty',
        text: S.fields.length ? 'Nothing matches that filter.'
          : 'No fields yet — run the test in step 1 and press "Add fields from the last test".' })]));
    }
    var on = S.fields.filter(function (f) { return f.exposed; }).length;
    $('fieldCount').textContent = on + ' of ' + S.fields.length + ' exposed';
    $('fieldHint').textContent = S.mode === 'whitelist'
      ? 'The vendor receives exactly these ' + on + ' field(s) and nothing else. A field the ' +
        'supplier adds later arrives unticked, so it cannot leak by default.'
      : '';
    renderExclude();
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
        // a field the vendor should be receiving.
        S.fields.push({ path: p, exposed: false, discovered: true, data_type: null, description: null });
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

  $('btnTestEp').addEventListener('click', function () {
    var btn = this;
    var values = {};
    S.params.forEach(function (p) {
      if (p.source === 'vendor' && p.name) values[p.name] = p.testValue || p.example || '';
    });
    busy(btn, true, 'Running…');
    show($('s4err'), false);
    show($('s4res'), true);
    $('s4res').innerHTML = '';
    $('s4res').appendChild(el('span', { class: 'spin' }));
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
      endpoint: S.ep && S.ep.name ? S.ep.name : null
    }).then(function (j) {
      var r = j.result, res = $('s4res');
      res.innerHTML = '';
      res.appendChild(badge(r.ok ? 'ok' : 'off', r.status ? 'HTTP ' + r.status : 'no answer'));
      if (r.ms !== undefined) res.appendChild(badge('mute', r.ms + ' ms'));
      if (j.upstreamFields !== undefined) {
        res.appendChild(badge('mute', j.upstreamFields + ' fields from the supplier'));
        res.appendChild(badge(j.exposedFields ? 'info' : 'off', j.exposedFields + ' reach the vendor'));
        var held = j.upstreamFields - j.exposedFields;
        if (held > 0) res.appendChild(badge('ok', held + ' withheld'));
      }
      show($('s4split'), true);
      $('s4raw').textContent = pretty(r.body);
      $('s4upmeta').textContent = j.upstreamFields + ' fields';
      $('s4proj').textContent = j.projection && j.projection.ok ? pretty(j.projection.result)
        : (j.projection ? j.projection.error : '');
      $('s4vmeta').textContent = j.exposedFields + ' fields';
      if (r.error) { $('s4err').textContent = r.error; show($('s4err'), true); }
      if (j.projection && !j.projection.ok) { $('s4err').textContent = j.projection.error; show($('s4err'), true); }
      $('step4').classList.toggle('ok', !!(r.ok && j.projection && j.projection.ok));
      var st = $('s4status'); st.innerHTML = '';
      st.appendChild(badge(r.ok ? 'ok' : 'off', r.ok ? 'passed' : 'failed'));
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
      rateMax: Number($('epRateMax').value) || 60,
      rateWindowMs: Number($('epRateWin').value) || 60000,
      params: S.params.map(function (p) {
        return {
          name: p.name, location: p.location, source: p.source, dataType: p.data_type,
          required: p.required !== false, fixedValue: p.fixed_value || null,
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

  window.addEventListener('beforeunload', function (e) {
    if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
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
    renderBar();
    renderUpstream();
    renderEndpoint();
    setMode(S.mode);
    renderParams();
    renderFields();
    renderTestParams();
    $('step1').classList.toggle('ok', !!(S.upstream && S.upstream.last_test_status &&
      S.upstream.last_test_status < 400));
    $('step2').classList.toggle('ok', !!(e && e.path));
    // An endpoint that is already shaped does not need step 1 open.
    $('step1').classList.toggle('collapsed', !!e);
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
