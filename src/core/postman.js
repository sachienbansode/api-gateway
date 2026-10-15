'use strict';

/**
 * Postman collections, generated from the catalogue.
 *
 * The point is not convenience, it is accuracy. A partner integrating against
 * a hand-written collection is integrating against someone's memory of the
 * endpoint; this one is built from the same rows the gateway routes with, so
 * the path, the parameters, their allowed values and the exact set of fields
 * they will receive are correct by construction.
 *
 * Two things are deliberately NOT in it:
 *
 *   - any API key. The collection ships with a `{{apiKey}}` variable left
 *     empty. A collection is shared, committed and emailed; a key in one is a
 *     key you will be rotating.
 *   - any supplier detail. No upstream host, no supplier path. The vendor is
 *     not supposed to know those exist, and a collection is the easiest way to
 *     leak them by accident.
 *
 * Schema v2.1.0, which is what Postman has imported since 2017 and what
 * Insomnia, Bruno and Hoppscotch read too.
 */

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/** Our `:param` route syntax becomes Postman's `:param` — same spelling. */
function pathSegments(p) {
  return String(p).replace(/^\//, '').split('/').filter(Boolean);
}

function exampleFor(param) {
  if (param.example) return param.example;
  if ((param.allowed || []).length) return param.allowed[0];
  switch (param.data_type) {
    case 'int': return '1';
    case 'number': return '1';
    case 'date': return new Date().toISOString().slice(0, 10);
    case 'bool': return 'true';
    default: return '';
  }
}

function describe(param) {
  const bits = [];
  if (param.description) bits.push(param.description);
  if ((param.allowed || []).length) bits.push(`One of: ${param.allowed.join(', ')}`);
  bits.push(param.required ? 'Required.' : 'Optional.');
  if (param.data_type) bits.push(`Type: ${param.data_type}.`);
  return bits.join(' ');
}

/** A sample of the response shape, built from the fields the vendor gets. */
function sampleResponse(endpoint) {
  const exposed = (endpoint.fields || []).filter((f) => f.exposed).map((f) => f.rename_to || f.path);
  if (!exposed.length) return null;

  const root = {};
  for (const path of exposed) {
    let node = root;
    const parts = String(path).split('.');
    parts.forEach((seg, i) => {
      const isArray = seg.endsWith('[]');
      const key = seg.replace(/\[\]$/, '');
      const last = i === parts.length - 1;
      if (!key) return;
      if (last) {
        node[key] = isArray ? ['…'] : '…';
      } else {
        if (!node[key]) node[key] = isArray ? [{}] : {};
        node = isArray ? node[key][0] : node[key];
      }
    });
  }
  return root;
}

function requestFor(endpoint, { baseUrl, keyHeader }) {
  const params = (endpoint.params || []).filter((p) => p.source === 'vendor');
  const pathParams = params.filter((p) => p.location === 'path');
  const queryParams = params.filter((p) => p.location === 'query');
  const headerParams = params.filter((p) => p.location === 'header');

  const header = [
    { key: keyHeader, value: '{{apiKey}}', type: 'text',
      description: 'Your API key. Never commit this into a shared collection.' },
    { key: 'Accept', value: 'application/json', type: 'text' },
  ].concat(headerParams.map((p) => ({
    key: p.name, value: `{{${p.name}}}`, type: 'text', description: describe(p),
  })));

  const url = {
    raw: `{{baseUrl}}${endpoint.path}` +
      (queryParams.length ? '?' + queryParams.map((p) => `${p.name}={{${p.name}}}`).join('&') : ''),
    host: ['{{baseUrl}}'],
    path: pathSegments(endpoint.path),
    variable: pathParams.map((p) => ({
      key: p.name, value: exampleFor(p), description: describe(p),
    })),
  };
  if (queryParams.length) {
    url.query = queryParams.map((p) => ({
      key: p.name, value: exampleFor(p), description: describe(p),
      disabled: p.required === false,
    }));
  }

  const sample = sampleResponse(endpoint);
  const exposedCount = (endpoint.fields || []).filter((f) => f.exposed).length;

  const description = [
    endpoint.description || endpoint.display_name || endpoint.name,
    '',
    endpoint.response_mode === 'whitelist'
      ? `Returns exactly ${exposedCount} field(s). Any other field the data provider ` +
        'returns is removed before the response leaves the gateway, including fields ' +
        'added in future.'
      : 'This endpoint forwards the provider response with minimal filtering.',
    '',
    `Rate limit: ${endpoint.rate_max} call(s) per ${Math.round(endpoint.rate_window_ms / 1000)}s.`,
    endpoint.frequency ? `Source data refreshes: ${endpoint.frequency}${endpoint.refresh_at ? ' at ' + endpoint.refresh_at : ''}.` : '',
  ].filter(Boolean).join('\n');

  const item = {
    name: endpoint.display_name || endpoint.name,
    request: { method: endpoint.method, header, url, description },
    response: [],
  };

  if (sample) {
    item.response.push({
      name: 'Example — 200 OK',
      originalRequest: { method: endpoint.method, header, url },
      status: 'OK',
      code: 200,
      _postman_previewlanguage: 'json',
      header: [{ key: 'Content-Type', value: 'application/json' }],
      body: JSON.stringify(sample, null, 2),
    });
  }
  item.response.push({
    name: 'Example — 401 Unauthorized',
    originalRequest: { method: endpoint.method, header, url },
    status: 'Unauthorized', code: 401,
    _postman_previewlanguage: 'json',
    header: [{ key: 'Content-Type', value: 'application/json' }],
    body: JSON.stringify(
      { error: { code: 'unauthorized', message: 'Missing or invalid API key.' } }, null, 2),
  });

  return item;
}

/**
 * @param {object[]} endpoints  catalogue rows, each with .params and .fields
 * @param {object}   opts       { name, baseUrl, keyHeader, contact, groupBy }
 */
function build(endpoints, opts = {}) {
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  const keyHeader = opts.keyHeader || 'X-API-Key';
  const live = endpoints.filter(Boolean);

  const items = [];
  if (opts.groupBy === 'category') {
    const groups = new Map();
    for (const e of live) {
      const label = e.category_label || e.category || 'Uncategorised';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(requestFor(e, { baseUrl, keyHeader }));
    }
    for (const [label, children] of groups) items.push({ name: label, item: children });
  } else {
    for (const e of live) items.push(requestFor(e, { baseUrl, keyHeader }));
  }

  return {
    info: {
      _postman_id: undefined,
      name: opts.name || 'API',
      description: [
        opts.description || '',
        '',
        'Set `apiKey` in the collection variables before sending anything. The key is not',
        'included here on purpose — a collection gets shared, committed and emailed.',
        opts.contact ? `\nQuestions: ${opts.contact}` : '',
        `\nGenerated ${new Date().toISOString().slice(0, 10)} from the live catalogue.`,
      ].filter(Boolean).join('\n'),
      schema: SCHEMA,
    },
    item: items,
    variable: [
      { key: 'baseUrl', value: baseUrl, type: 'string' },
      { key: 'apiKey', value: '', type: 'string' },
    ],
  };
}

module.exports = { build, requestFor, sampleResponse };
