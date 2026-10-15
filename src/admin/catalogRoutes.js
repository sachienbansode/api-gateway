'use strict';

const express = require('express');
const browse = require('../db/repos/browse');
const studio = require('../db/repos/studio');
const settings = require('../db/repos/settings');
const secrets = require('../db/repos/secrets');
const tester = require('./studioTester');
const postman = require('../core/postman');
const page = require('./catalogPage');

/**
 * Catalogue routes. Reads are open to any signed-in admin; the one write —
 * publishing or withdrawing — needs edit rights and a confirmation.
 */
/** Five to a page. Rows are two lines tall and each can expand into a test
 *  result, so ten of them put the pager below the fold on a laptop. */
const PAGE_SIZE = 5;

const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));

function build(logger, { flashOf, deps = {} } = {}) {
  const r = express.Router();

  /**
   * Postman collections, for one endpoint, one supplier, or a filtered set.
   *
   * Only LIVE and DRAFT endpoints are included; retired ones would hand a
   * partner a request that 404s. The file is sent as an attachment with a
   * dated name, because the next question after "here's the collection" is
   * always "which version is this?".
   */
  async function sendCollection(req, res, { filter, name, description }) {
    const [rows, baseUrl, keyHeader, contact] = await Promise.all([
      browse.forExport(filter),
      settings.baseUrl(),
      settings.get('vendor_key_header'),
      settings.get('docs_contact'),
    ]);
    const usable = rows.filter((e) => e.status !== 'retired');
    if (!usable.length) {
      return res.status(404).type('text/plain')
        .send('Nothing to export — no endpoint matched, or they are all retired.');
    }
    if (!baseUrl) {
      return res.status(409).type('text/plain').send(
        'The public base URL is not set, so the collection would have no host in it. ' +
        'Set it in Admin config (/admin/settings) and try again.'
      );
    }
    const collection = postman.build(usable, {
      name, description, baseUrl, keyHeader, contact,
      groupBy: usable.length > 1 ? 'category' : null,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const file = `${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${stamp}.postman_collection.json`;
    logger?.info?.(
      { actor: req.admin.email, endpoints: usable.length, file },
      'catalogue: postman collection downloaded'
    );
    res.set('Content-Disposition', `attachment; filename="${file}"`);
    res.type('application/json').send(JSON.stringify(collection, null, 2));
  }

  r.get('/postman', async (req, res, next) => {
    try {
      const application = str(req.query.application);
      await sendCollection(req, res, {
        filter: { application, status: str(req.query.status) },
        name: application ? `Pravah — ${application}` : 'Pravah API',
        description: 'Every endpoint you have been granted access to.',
      });
    } catch (err) { next(err); }
  });

  r.get('/upstream/:name/postman', async (req, res, next) => {
    try {
      const u = await browse.upstream(String(req.params.name));
      if (!u) return next();
      await sendCollection(req, res, {
        filter: { upstream: u.name },
        name: `Pravah — ${u.display_name || u.name}`,
        description: `Endpoints served from ${u.display_name || u.name}.`,
      });
    } catch (err) { next(err); }
  });

  r.get('/endpoint/:name/postman', async (req, res, next) => {
    try {
      const rows = await browse.forExport({ name: String(req.params.name) });
      if (!rows.length) return next();
      await sendCollection(req, res, {
        filter: { name: rows[0].name },
        name: `Pravah — ${rows[0].display_name || rows[0].name}`,
        description: rows[0].description || '',
      });
    } catch (err) { next(err); }
  });

  r.get('/', async (req, res, next) => {
    try {
      const query = {
        q: str(req.query.q),
        application: str(req.query.application),
        category: str(req.query.category),
        status: str(req.query.status),
        mode: str(req.query.mode),
        upstream: str(req.query.upstream),
        page: Number(req.query.page) || 1,
      };
      const [list, facets, baseUrl] = await Promise.all([
        browse.endpoints({ ...query, size: PAGE_SIZE }),
        browse.facets(query.application),
        settings.baseUrl(),
      ]);
      res.type('html').send(
        page.endpointList({ admin: req.admin, flash: flashOf(req), page: list, facets, query, baseUrl })
      );
    } catch (err) { next(err); }
  });

  r.get('/upstreams', async (req, res, next) => {
    try {
      const query = {
        q: str(req.query.q),
        application: str(req.query.application),
        page: Number(req.query.page) || 1,
      };
      const [list, facets] = await Promise.all([
        browse.upstreams({ ...query, size: PAGE_SIZE }),
        browse.facets(query.application),
      ]);
      res.type('html').send(
        page.upstreamList({ admin: req.admin, flash: flashOf(req), page: list, facets, query })
      );
    } catch (err) { next(err); }
  });

  r.get('/upstream/:name', async (req, res, next) => {
    try {
      const u = await browse.upstream(String(req.params.name));
      if (!u) return next();
      const [endpoints, baseUrl] = await Promise.all([
        browse.endpoints({ upstream: u.name, page: Number(req.query.page) || 1, size: PAGE_SIZE }),
        settings.baseUrl(),
      ]);
      res.type('html').send(
        page.upstreamDetail({ admin: req.admin, flash: flashOf(req), u, endpoints, baseUrl })
      );
    } catch (err) { next(err); }
  });

  r.get('/endpoint/:name', async (req, res, next) => {
    try {
      const e = await studio.endpoint(String(req.params.name));
      if (!e) return next();
      const upstream = await browse.upstream(e.upstream).catch(() => null);
      // vendor_count is on the list query, not the detail one; fetch it here
      // rather than widening studio.endpoint(), which the Studio also uses.
      const one = await browse.endpoints({ q: e.name, size: 1 });
      e.vendor_count = one.rows[0] ? one.rows[0].vendor_count : 0;
      // Whether an endpoint on its own key actually HAS one. Status only —
      // this view never asks for a value.
      if (e.auth_mode === 'override') {
        const cred = (await secrets.statusForEndpoint(e.name).catch(() => []))[0];
        e.credential_broken = Boolean(cred && cred.broken);
      }
      const baseUrl = await settings.baseUrl();
      res.type('html').send(
        page.endpointDetail({ admin: req.admin, flash: flashOf(req), e, upstream, baseUrl })
      );
    } catch (err) { next(err); }
  });

  /**
   * Publish or withdraw.
   *
   * A POST from a form, with the confirmation handled in the browser before it
   * is sent — but the authority is here: canEdit, and setStatus() re-checks
   * that a whitelist endpoint has something to return before it will go live.
   */

  /**
   * Test one endpoint: the supplier, then what a vendor would receive.
   *
   * Three stages, and the third is conditional on purpose.
   *
   *   supplier  a real call to the third-party API with this endpoint's own
   *             credential. The thing that is actually most likely to break.
   *   wrapper   the real projection run over that response, so this shows what
   *             a vendor would get — field for field — not an approximation.
   *   route     only when the endpoint is LIVE. A draft endpoint is
   *             deliberately not mounted, so calling its public URL would 404
   *             and the failure would mean nothing. For a live one we call the
   *             published URL with NO key and expect 401: that proves the
   *             route is mounted AND that it refuses anonymous callers, which
   *             is the pair worth knowing. Getting a 200 there would be an
   *             emergency, and it is reported as one.
   *
   * Deliberately no vendor key is minted. Doing that would mean creating a
   * vendor row to run a test, and a throwaway vendor in a table people read to
   * answer "who can call us" is worse than the small thing it would prove.
   */
  r.post('/endpoint/:name/test', async (req, res) => {
    const name = String(req.params.name);
    const stages = [];
    const started = Date.now();
    try {
      const e = await studio.endpoint(name);
      if (!e) return res.status(404).json({ error: `No endpoint called "${name}".` });
      const up = await browse.upstream(e.upstream).catch(() => null);
      if (!up) {
        return res.json({
          stages: [{
            key: 'supplier', label: 'Supplier API', ok: false,
            error: `This endpoint points at the supplier "${e.upstream}", which no longer exists.`,
          }],
        });
      }

      // --- 1. the supplier ------------------------------------------------
      const values = {};
      for (const prm of e.params || []) {
        if (prm.example) values[prm.name] = prm.example;
        else if (prm.fixed_value) values[prm.name] = prm.fixed_value;
      }
      const filled = tester.fillPath(e.upstream_path || '', values);
      if (filled.missing.length) {
        stages.push({
          key: 'supplier', label: 'Supplier API', ok: false,
          error: `No sample value for ${filled.missing.map((m) => ':' + m).join(', ')}. ` +
            'Add an example on those parameters in the Studio (step 3) so this endpoint can be tested.',
        });
        return res.json({ stages, ms: Date.now() - started });
      }

      const override = e.auth_mode === 'override';
      let sealed = null;
      try {
        sealed = override
          ? await secrets.resolveAllForEndpoint(name)
          : await secrets.resolveAll(e.upstream);
      } catch (err) {
        stages.push({
          key: 'supplier', label: 'Supplier API', ok: false,
          error: `The stored credential could not be decrypted: ${err.message}. ` +
            'Either GW_SECRET_KEY has changed or the row was altered.',
        });
        return res.json({ stages, ms: Date.now() - started });
      }

      const sup = await tester.callUpstream({
        baseUrl: up.base_url,
        path: filled.path,
        timeoutMs: up.timeout_ms,
        secrets: sealed,
        upstream: override
          ? { auth_type: e.auth_type || 'bearer', auth_name: e.auth_name }
          : {
              auth_type: up.auth_type, auth_name: up.auth_name,
              auth_value_env: up.auth_value_env, auth_user_env: up.auth_user_env,
            },
      });

      stages.push({
        key: 'supplier',
        label: 'Supplier API',
        ok: sup.ok === true,
        status: sup.status || null,
        ms: sup.ms || null,
        // The supplier's own host and path. Safe here — this screen is behind
        // admin auth — and it is the first thing anyone needs when a call fails.
        detail: sup.url || null,
        fields: sup.body ? tester.discover(sup.body).length : 0,
        error: sup.error || (sup.ok ? null : `The supplier answered ${sup.status}.`),
      });

      // --- 2. what a vendor would receive ----------------------------------
      // Skipped when the supplier call FAILED, not merely when it returned
      // nothing. A 503 usually carries a JSON error body, and projecting that
      // produces an authoritative-looking "0 fields, 1 withheld" that describes
      // the shape of an error page — which tells nobody anything about the
      // endpoint and reads as though the whitelist were the problem.
      if (!sup.ok || !sup.body) {
        stages.push({
          key: 'wrapper', label: 'What a vendor receives', ok: null, skipped: true,
          detail: sup.ok
            ? 'Not run — the supplier returned no body to build a response from.'
            : 'Not run — fix the supplier call above first. Projecting an error ' +
              'response would describe the error, not this endpoint.',
        });
      } else {
        const proj = tester.project(
          {
            mode: e.response_mode,
            fields: (e.fields || []).filter((f) => f.exposed).map((f) => f.path),
            exclude: (e.fields || []).filter((f) => !f.exposed).map((f) => f.path),
            rename: (e.fields || []).reduce((acc, f) => {
              if (f.exposed && f.rename_to) acc[f.path] = f.rename_to;
              return acc;
            }, {}),
          },
          sup.body
        );
        const exposed = proj.ok ? tester.discover(proj.result).length : 0;
        const upstreamFields = tester.discover(sup.body).length;
        stages.push({
          key: 'wrapper',
          label: 'What a vendor receives',
          ok: proj.ok === true && exposed > 0,
          detail: proj.ok
            ? `${exposed} field(s) of the supplier's ${upstreamFields} — ` +
              `${upstreamFields - exposed} withheld`
            : null,
          sample: proj.ok ? JSON.stringify(proj.result, null, 2).slice(0, 4000) : null,
          error: proj.ok
            ? (exposed === 0 ? 'The vendor would receive an empty object.' : null)
            : proj.error,
        });
      }

      // --- 3. the published route ------------------------------------------
      if (e.status !== 'live') {
        stages.push({
          key: 'route', label: 'Published route', ok: null, skipped: true,
          detail: `Not published — this endpoint is ${e.status}, so it is deliberately not ` +
            'routed. Publish it to test the live URL.',
        });
      } else {
        const base = await settings.baseUrl();
        const url = base + e.path.replace(/:([A-Za-z0-9_]+)/g,
          (_, n) => encodeURIComponent(values[n] || 'test'));
        try {
          const started2 = Date.now();
          const probe = await fetch(url, {
            method: 'HEAD',
            signal: AbortSignal.timeout(8000),
            redirect: 'manual',
          });
          const ms = Date.now() - started2;
          // 401 is the PASS here: mounted, and refusing anonymous callers.
          stages.push({
            key: 'route', label: 'Published route', ok: probe.status === 401,
            status: probe.status, ms, detail: url,
            error: probe.status === 404
              ? 'The gateway does not have this route mounted. The catalogue may not have ' +
                'reloaded since it was published — restart, or publish it again.'
              : probe.status === 200
                ? 'SERIOUS: the route answered WITHOUT an API key. Every vendor-facing route ' +
                  'must require one. Report this.'
                : probe.status === 401 ? null
                  : `Expected 401 from an unauthenticated call, got ${probe.status}.`,
          });
        } catch (err) {
          stages.push({
            key: 'route', label: 'Published route', ok: false, detail: url,
            error: `Could not reach the published URL: ${err.message}. Check the public base ` +
              'URL in Admin config, and that this server can reach itself by that name.',
          });
        }
      }

      logger?.info(
        { endpoint: name, actor: req.admin.email, stages: stages.map((x) => `${x.key}:${x.ok}`) },
        'catalogue: endpoint tested'
      );
      res.json({ stages, ms: Date.now() - started });
    } catch (err) {
      logger?.error({ endpoint: name, err: err.message }, 'catalogue: endpoint test failed');
      res.status(500).json({ error: err.message, stages });
    }
  });

  r.post('/endpoint/:name/status', async (req, res) => {
    const name = String(req.params.name);
    const back = `/admin/catalog/endpoint/${encodeURIComponent(name)}`;
    if (!req.admin.canEdit) {
      return res.redirect(303, `${back}?err=${encodeURIComponent('Your role is read-only here.')}`);
    }
    try {
      const status = String((req.body || {}).status || '');
      if (!['draft', 'live', 'retired'].includes(status)) throw new Error('unknown status');
      await studio.setStatus(name, status, req.admin.email);
      if (deps.reloadCatalog) await deps.reloadCatalog().catch(() => {});
      logger?.info?.({ endpoint: name, status, actor: req.admin.email }, 'catalogue: status changed');
      const msg = status === 'live'
        ? 'Published. It is answering now — vendors still need the ep: scope.'
        : 'Withdrawn. It stopped answering within a few seconds.';
      res.redirect(303, `${back}?ok=${encodeURIComponent(msg)}`);
    } catch (err) {
      res.redirect(303, `${back}?err=${encodeURIComponent(err.message)}`);
    }
  });

  return r;
}

module.exports = { build };
