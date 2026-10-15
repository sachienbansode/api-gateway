'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const studio = require('../db/repos/studio');
const tester = require('./studioTester');
const studioPage = require('./studioPage');

/**
 * Routes behind the API Studio.
 *
 * Mounted by routes.js AFTER the admin session check, so every handler here
 * already has req.admin. The write guard (canEdit, x-requested-with) is
 * applied there too; this file deals with what the Studio does, not with who
 * is allowed to reach it.
 */

// Read once at boot. The file changes when the service is deployed, not while
// it runs, and reading it per request would be a filesystem call on a path
// taken by every admin page load.
const CLIENT_JS = fs.readFileSync(path.join(__dirname, 'studioClient.js'), 'utf8');

function script() {
  return (req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(CLIENT_JS);
  };
}

/** The page itself, with everything the dropdowns need already in it. */
function page(logger, { flashOf }) {
  return async (req, res, next) => {
    try {
      const want = req.query.endpoint ? String(req.query.endpoint) : null;
      const [applications, types, categories, upstreams, endpoints] = await Promise.all([
        studio.applications(),
        studio.apiTypes(),
        studio.categories(),
        studio.upstreams(),
        studio.endpoints(),
      ]);
      const selectedEndpoint = want ? await studio.endpoint(want) : null;
      res.type('html').send(
        studioPage.render({
          admin: req.admin,
          flash: flashOf(req),
          bootstrap: {
            applications, types, categories, upstreams, endpoints,
            selected: want, selectedEndpoint,
          },
        })
      );
    } catch (err) {
      next(err);
    }
  };
}

function json(logger, deps = {}) {
  const r = express.Router();

  // --- reads ---------------------------------------------------------------
  r.get('/bootstrap', async (req, res, next) => {
    try {
      const app = req.query.app ? String(req.query.app) : null;
      const [applications, types, categories, upstreams, endpoints] = await Promise.all([
        studio.applications(), studio.apiTypes(), studio.categories(app),
        studio.upstreams(app), studio.endpoints(app),
      ]);
      res.json({ applications, types, categories, upstreams, endpoints });
    } catch (err) { next(err); }
  });

  r.get('/endpoint/:name', async (req, res, next) => {
    try {
      const e = await studio.endpoint(String(req.params.name));
      if (!e) return res.status(404).json({ error: 'no endpoint by that name' });
      res.json({ endpoint: e });
    } catch (err) { next(err); }
  });

  // --- step 1 --------------------------------------------------------------
  r.post('/application', async (req, res, next) => {
    try {
      res.json({ application: await studio.saveApplication(req.body, req.admin.email) });
    } catch (err) { next(err); }
  });

  r.post('/category', async (req, res, next) => {
    try {
      res.json({ category: await studio.saveCategory(req.body) });
    } catch (err) { next(err); }
  });

  r.post('/upstream', async (req, res, next) => {
    try {
      const row = req.body || {};
      if (!row.name) return res.status(400).json({ error: 'a reference is required' });
      if (!/^https?:\/\//.test(String(row.baseUrl || ''))) {
        return res.status(400).json({ error: 'the base URL must start with http:// or https://' });
      }
      // The one rule the UI must not be able to talk its way out of: what
      // lands in the column is the NAME of an environment variable. A pasted
      // token is rejected here rather than quietly stored.
      if (row.authType && row.authType !== 'none') {
        const ref = String(row.authValueEnv || '').trim();
        if (!/^\$\{[A-Z0-9_]+\}$/.test(ref)) {
          return res.status(400).json({
            error: 'The credential field takes the NAME of an environment variable, ' +
              'written as ${SUPPLIER_TOKEN} — not the token itself. Put the value in ' +
              '/etc/api-gateway/env on the server.',
          });
        }
      }
      const saved = await studio.saveUpstream(row, req.admin.email);
      const ref = tester.resolveRef(saved.auth_value_env);
      res.json({
        upstream: saved,
        envHint: ref.varName
          ? ref.set
            ? `${ref.varName} is set on this server.`
            : `${ref.varName} is NOT set on this server — add it to /etc/api-gateway/env and restart.`
          : '',
      });
    } catch (err) { next(err); }
  });

  r.post('/test-upstream', async (req, res, next) => {
    try {
      const { upstream = {}, path: p = '' } = req.body || {};
      const result = await tester.callUpstream({
        baseUrl: upstream.baseUrl,
        path: p,
        timeoutMs: upstream.timeoutMs,
        upstream: {
          auth_type: upstream.authType,
          auth_name: upstream.authName,
          auth_value_env: upstream.authValueEnv,
          auth_user_env: upstream.authUserEnv,
        },
      });
      const fields = result.body ? tester.discover(result.body) : [];
      await studio.recordTest({
        kind: 'upstream',
        upstream: upstream.name || null,
        actor: req.admin.email,
        requestUrl: result.url,
        status: result.status,
        latencyMs: result.ms,
        ok: result.ok === true,
        error: result.error,
        fieldCount: fields.length,
      }).catch(() => {});
      logger?.info?.(
        { upstream: upstream.name, status: result.status, ms: result.ms, actor: req.admin.email },
        'studio: upstream test'
      );
      // The sample body goes back to the admin's own browser and no further.
      res.json({ result, fields });
    } catch (err) { next(err); }
  });

  // --- steps 2 and 3 -------------------------------------------------------
  r.post('/endpoint', async (req, res, next) => {
    try {
      const row = req.body || {};
      if (!row.name) return res.status(400).json({ error: 'a reference is required' });
      if (!String(row.path || '').startsWith('/')) {
        return res.status(400).json({ error: 'our path must start with /' });
      }
      if (!String(row.upstreamPath || '').startsWith('/')) {
        return res.status(400).json({ error: 'the supplier path must start with /' });
      }
      // Every :param in the supplier path has to be fillable from somewhere,
      // or the call cannot be built at request time.
      const ours = pathNames(row.path);
      const theirs = pathNames(row.upstreamPath);
      const known = new Set([
        ...ours,
        ...(row.params || []).filter((p) => p.source !== 'vendor').map((p) => p.name),
      ]);
      const orphan = theirs.filter((n) => !known.has(n));
      if (orphan.length) {
        return res.status(400).json({
          error: `the supplier path uses :${orphan.join(', :')} but nothing supplies ` +
            `${orphan.length > 1 ? 'those' : 'that'} — add ${orphan.length > 1 ? 'them' : 'it'} to our path, ` +
            `or give ${orphan.length > 1 ? 'them' : 'it'} a fixed value in step 3`,
        });
      }
      const saved = await studio.saveEndpoint(row, req.admin.email);
      const summary = (await studio.endpoints(saved.application))
        .find((e) => e.name === saved.name) || saved;
      res.json({ endpoint: await studio.endpoint(saved.name), summary });
    } catch (err) { next(err); }
  });

  r.post('/endpoint/:name/status', async (req, res, next) => {
    try {
      const status = String((req.body || {}).status || '');
      if (!['draft', 'live', 'retired'].includes(status)) {
        return res.status(400).json({ error: 'status must be draft, live or retired' });
      }
      const saved = await studio.setStatus(String(req.params.name), status, req.admin.email);
      if (deps.reloadCatalog) await deps.reloadCatalog().catch(() => {});
      res.json({
        endpoint: saved,
        note: status === 'live'
          ? 'Vendors still need the ep: scope before they can call it.'
          : '',
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  r.delete('/endpoint/:name', async (req, res, next) => {
    try {
      await studio.deleteEndpoint(String(req.params.name), req.admin.email);
      res.json({ deleted: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- step 4 --------------------------------------------------------------
  r.post('/test-endpoint', async (req, res, next) => {
    try {
      const b = req.body || {};
      const filled = tester.fillPath(b.upstreamPath || '', b.values || {});
      if (filled.missing.length) {
        return res.status(400).json({
          error: `fill in ${filled.missing.join(', ')} before running the test`,
        });
      }
      const result = await tester.callUpstream({
        baseUrl: (b.upstream || {}).baseUrl,
        path: filled.path,
        timeoutMs: (b.upstream || {}).timeoutMs,
        upstream: {
          auth_type: (b.upstream || {}).authType,
          auth_name: (b.upstream || {}).authName,
          auth_value_env: (b.upstream || {}).authValueEnv,
          auth_user_env: (b.upstream || {}).authUserEnv,
        },
      });
      const upstreamFields = result.body ? tester.discover(result.body).length : 0;
      const projection = result.body
        ? tester.project(
            { mode: b.mode, fields: b.fields || [], exclude: b.exclude || [], rename: b.rename || {} },
            result.body
          )
        : { ok: false, error: result.error || 'there is no body to project' };
      const exposedFields = projection.ok ? tester.discover(projection.result).length : 0;

      await studio.recordTest({
        kind: 'endpoint',
        endpoint: b.endpoint || null,
        upstream: (b.upstream || {}).name || null,
        actor: req.admin.email,
        requestUrl: result.url,
        status: result.status,
        latencyMs: result.ms,
        ok: Boolean(result.ok && projection.ok),
        error: result.error || (projection.ok ? null : projection.error),
        fieldCount: exposedFields,
        // Only the PROJECTED body is kept: by construction it holds nothing
        // the vendor would not have been given anyway. The supplier's raw
        // response is the thing being protected and is not written down.
        responseSample: projection.ok ? projection.result : null,
      }).catch(() => {});

      res.json({ result, projection, upstreamFields, exposedFields });
    } catch (err) { next(err); }
  });

  return r;
}

function pathNames(tpl) {
  const out = [];
  const re = /:([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(String(tpl || '')))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

module.exports = { page, json, script };
