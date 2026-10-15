'use strict';

const express = require('express');
const browse = require('../db/repos/browse');
const studio = require('../db/repos/studio');
const page = require('./catalogPage');

/**
 * Catalogue routes. Reads are open to any signed-in admin; the one write —
 * publishing or withdrawing — needs edit rights and a confirmation.
 */
function build(logger, { flashOf, deps = {} } = {}) {
  const r = express.Router();

  const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));

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
      const [list, facets] = await Promise.all([
        browse.endpoints({ ...query, size: 25 }),
        browse.facets(query.application),
      ]);
      res.type('html').send(
        page.endpointList({ admin: req.admin, flash: flashOf(req), page: list, facets, query })
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
        browse.upstreams({ ...query, size: 25 }),
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
      const endpoints = await browse.endpoints({
        upstream: u.name, page: Number(req.query.page) || 1, size: 25,
      });
      res.type('html').send(
        page.upstreamDetail({ admin: req.admin, flash: flashOf(req), u, endpoints })
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
      res.type('html').send(
        page.endpointDetail({ admin: req.admin, flash: flashOf(req), e, upstream })
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
