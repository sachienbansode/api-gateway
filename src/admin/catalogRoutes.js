'use strict';

const express = require('express');
const browse = require('../db/repos/browse');
const studio = require('../db/repos/studio');
const settings = require('../db/repos/settings');
const postman = require('../core/postman');
const page = require('./catalogPage');

/**
 * Catalogue routes. Reads are open to any signed-in admin; the one write —
 * publishing or withdrawing — needs edit rights and a confirmation.
 */
/** Ten to a page. Chosen because the rows are two lines tall and an operator
 *  should be able to take in a page without scrolling. */
const PAGE_SIZE = 10;

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
