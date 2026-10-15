'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const studio = require('../db/repos/studio');
const secrets = require('../db/repos/secrets');
const secretbox = require('../core/secretbox');
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

/**
 * Turn a database error into something a person can act on.
 *
 * The Studio reads tables that arrive in migrations 003, 004 and 005. If one
 * has not been applied, the query fails with a Postgres error code and the
 * generic handler renders "An unexpected error occurred" — which tells the
 * operator nothing and costs an hour. Name the missing thing instead.
 */
const MIGRATION_FOR = {
  applications: '003_studio.sql',
  api_types: '003_studio.sql',
  api_categories: '003_studio.sql',
  endpoint_params: '003_studio.sql',
  endpoint_fields: '003_studio.sql',
  connection_tests: '003_studio.sql',
  upstream_secrets: '004_upstream_secrets.sql',
  secret_audit: '004_upstream_secrets.sql',
  upstream_credentials: '004_upstream_secrets.sql',
  payload_check: '005_no_payloads.sql',
};

function explainDbError(err) {
  // 42P01 undefined_table, 42703 undefined_column
  if (err && (err.code === '42P01' || err.code === '42703')) {
    const text = `${err.message || ''} ${err.detail || ''}`;
    for (const [object, file] of Object.entries(MIGRATION_FOR)) {
      if (text.includes(object)) {
        return {
          title: `The database is missing ${object}`,
          detail:
            `This comes from db/migrations/${file}, which has not been applied to ` +
            `this database. Run it in pgAdmin against the gateway database — the ` +
            `whole file, not a selection — then reload this page. It is safe to ` +
            `re-run if you are unsure.`,
          raw: err.message,
        };
      }
    }
    return {
      title: 'The database schema is behind the application',
      detail:
        'A table or column this page needs does not exist. Apply any unrun files ' +
        'in db/migrations/ in numerical order, then reload.',
      raw: err.message,
    };
  }
  if (err && err.code === '42501') {
    return {
      title: 'The database login is not permitted to read this',
      detail: `GRANT SELECT on the gateway schema to the application role.`,
      raw: err.message,
    };
  }
  return null;
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
      const explained = explainDbError(err);
      if (!explained) return next(err);
      // Logged in full; shown to the admin in words they can act on.
      logger?.error?.({ err: err.message, code: err.code }, 'studio: schema problem');
      return res.status(503).type('html').send(
        studioPage.unavailable({ admin: req.admin, problem: explained })
      );
    }
  };
}

function json(logger, deps = {}) {
  const r = express.Router();

  // Every handler below funnels its errors through here, so a missing
  // migration reads the same whether you hit the page or the API.
  const fail = (res, next) => (err) => {
    const explained = explainDbError(err);
    if (!explained) return next(err);
    res.status(503).json({ error: `${explained.title}. ${explained.detail}` });
  };

  // --- reads ---------------------------------------------------------------
  r.get('/bootstrap', async (req, res, next) => {
    try {
      const app = req.query.app ? String(req.query.app) : null;
      const [applications, types, categories, upstreams, endpoints] = await Promise.all([
        studio.applications(), studio.apiTypes(), studio.categories(app),
        studio.upstreams(app), studio.endpoints(app),
      ]);
      res.json({ applications, types, categories, upstreams, endpoints });
    } catch (err) { fail(res, next)(err); }
  });

  r.get('/endpoint/:name', async (req, res, next) => {
    try {
      const e = await studio.endpoint(String(req.params.name));
      if (!e) return res.status(404).json({ error: 'no endpoint by that name' });
      res.json({ endpoint: e });
    } catch (err) { fail(res, next)(err); }
  });

  // --- step 1 --------------------------------------------------------------
  r.post('/application', async (req, res, next) => {
    try {
      res.json({ application: await studio.saveApplication(req.body, req.admin.email) });
    } catch (err) { fail(res, next)(err); }
  });

  r.post('/category', async (req, res, next) => {
    try {
      res.json({ category: await studio.saveCategory(req.body) });
    } catch (err) { fail(res, next)(err); }
  });

  r.post('/upstream', async (req, res, next) => {
    try {
      const row = req.body || {};
      if (!row.name) return res.status(400).json({ error: 'a reference is required' });
      if (!/^https?:\/\//.test(String(row.baseUrl || ''))) {
        return res.status(400).json({ error: 'the base URL must start with http:// or https://' });
      }
      // A credential arrives one of two ways, and the UI may not invent a
      // third. Either a ${VAR} reference, which is stored as written, or a
      // token in `authSecret`, which is encrypted before it touches a column
      // and is never echoed back.
      const plaintext = typeof row.authSecret === 'string' ? row.authSecret.trim() : '';
      const ref = String(row.authValueEnv || '').trim();
      const existing = plaintext
        ? null
        : (await secrets.status(row.name).catch(() => []))[0] || null;
      const alreadySealed = Boolean(existing && existing.secret_stored);

      if (row.authType && row.authType !== 'none') {
        if (plaintext) {
          if (!secretbox.enabled()) {
            return res.status(400).json({
              error: 'GW_SECRET_KEY is not set on this server, so a credential cannot be ' +
                'encrypted. Generate one with  node -e "console.log(\'v1:\'+' +
                'require(\'crypto\').randomBytes(32).toString(\'base64\'))"  then add it ' +
                'to /etc/api-gateway/env and restart. Until then, use a ${VAR} reference.',
            });
          }
          if (/^\$\{[A-Z0-9_]+\}$/.test(plaintext)) {
            return res.status(400).json({
              error: 'That looks like a variable reference, not a token. Put it in the ' +
                'reference field instead, or paste the real credential here.',
            });
          }
        } else if (!alreadySealed && !/^\$\{[A-Z0-9_]+\}$/.test(ref)) {
          return res.status(400).json({
            error: 'This supplier needs a credential: either paste the token (it is ' +
              'encrypted before it is stored) or give the name of an environment ' +
              'variable as ${SUPPLIER_TOKEN}.',
          });
        }
      }

      const saved = await studio.saveUpstream(row, req.admin.email);

      let credential = null;
      if (plaintext) {
        const sealed = await secrets.set({
          upstream: saved.name, slot: 'value', plaintext, actor: req.admin.email,
        });
        if (row.authType === 'basic' && typeof row.authUser === 'string' && row.authUser.trim()) {
          await secrets.set({
            upstream: saved.name, slot: 'username',
            plaintext: row.authUser.trim(), actor: req.admin.email,
          });
        }
        credential = {
          stored: true,
          hint: sealed.hint ? `••••${sealed.hint}` : '••••',
          keyId: sealed.keyId,
          rotated: sealed.rotated,
        };
        if (deps.reloadCatalog) await deps.reloadCatalog().catch(() => {});
      }

      const status = (await secrets.status(saved.name).catch(() => []))[0] || null;
      const envRef = tester.resolveRef(saved.auth_value_env);
      res.json({
        upstream: saved,
        credential: credential || (status && status.secret_stored
          ? {
              stored: true,
              hint: status.secret_hint ? status.secret_hint.replace(/^\*{4}/, '••••') : '••••',
              keyId: status.key_id, setAt: status.set_at, setBy: status.set_by,
            }
          : { stored: false }),
        envHint: status && status.secret_stored
          ? credential
            ? credential.rotated
              ? 'Credential replaced and encrypted. The old one no longer works.'
              : 'Credential encrypted and stored. It is not readable from the database.'
            : ''
          : envRef.varName
            ? envRef.set
              ? `${envRef.varName} is set on this server.`
              : `${envRef.varName} is NOT set on this server — add it to /etc/api-gateway/env and restart.`
            : '',
      });
    } catch (err) { fail(res, next)(err); }
  });

  r.get('/credentials', async (req, res, next) => {
    try {
      res.json({
        keySet: secretbox.enabled(),
        credentials: await secrets.status(req.query.upstream || null),
        recent: await secrets.recentAudit(10),
      });
    } catch (err) { fail(res, next)(err); }
  });

  r.post('/upstream/:name/credential/clear', async (req, res) => {
    try {
      await secrets.clear({ upstream: String(req.params.name), actor: req.admin.email });
      if (deps.reloadCatalog) await deps.reloadCatalog().catch(() => {});
      res.json({ cleared: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  r.post('/credentials/rotate', async (req, res) => {
    try {
      const out = await secrets.rotateAll(req.admin.email);
      if (deps.reloadCatalog) await deps.reloadCatalog().catch(() => {});
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  r.post('/test-upstream', async (req, res, next) => {
    try {
      const { upstream = {}, path: p = '' } = req.body || {};
      // If a credential is sealed for this upstream, it is read here, on the
      // server. The browser never sends one and never receives one.
      const sealed = upstream.name
        ? await secrets.resolveAll(upstream.name).catch(() => null)
        : null;
      const result = await tester.callUpstream({
        baseUrl: upstream.baseUrl,
        path: p,
        timeoutMs: upstream.timeoutMs,
        secrets: sealed,
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
    } catch (err) { fail(res, next)(err); }
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
    } catch (err) { fail(res, next)(err); }
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
      const sealed = (b.upstream || {}).name
        ? await secrets.resolveAll(b.upstream.name).catch(() => null)
        : null;
      const result = await tester.callUpstream({
        baseUrl: (b.upstream || {}).baseUrl,
        path: filled.path,
        timeoutMs: (b.upstream || {}).timeoutMs,
        secrets: sealed,
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
    } catch (err) { fail(res, next)(err); }
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
