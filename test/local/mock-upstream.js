'use strict';

/**
 * Mock upstream for local testing. Stands in for your internal Node and Python
 * services so you can exercise the gateway without touching anything real.
 *
 *   node test/local/mock-upstream.js
 *
 * It deliberately returns fields the vendor must NOT see (credit_score,
 * internal_notes, cost_basis, address.internal_geo_id) so you can prove the
 * response whitelist is doing its job.
 *
 * The shipment counter only advances on a real POST, which is what makes the
 * idempotency test meaningful: a replayed request must return the SAME
 * shipment_id, because the upstream was never called a second time.
 */

const http = require('http');
const PORT = Number(process.env.MOCK_PORT) || 9910;

let shipments = 0;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    let body = '';
    for await (const chunk of req) body += chunk;

    const json = (status, payload) => {
      // x-powered-by is here on purpose: the gateway must strip it.
      res.writeHead(status, { 'content-type': 'application/json', 'x-powered-by': 'Express' });
      res.end(JSON.stringify(payload));
    };

    console.log(`${req.method} ${url.pathname}`);

    if (url.pathname.startsWith('/api/customers/')) {
      return json(200, {
        id: Number(url.pathname.split('/').pop()) || 1,
        display_name: 'Acme Ltd',
        status: 'active',
        credit_score: 780,
        internal_notes: 'DO NOT SHARE',
        cost_basis: 19.55,
        created_by_user_id: 'u-1099',
        address: { city: 'Pune', country: 'IN', postal_code: '411001', internal_geo_id: 'GEO-X-991' },
      });
    }

    if (url.pathname === '/api/shipments') {
      shipments += 1;
      return json(201, {
        shipment_id: `shp_${shipments}`,
        state: 'created',
        internal_cost: 42.5,
        carrier_account: 'ACCT-SECRET-9',
      });
    }

    // A deliberately leaky 404, to prove the gateway never forwards it.
    return json(404, { error: 'no such row', table: 'internal_customers', host: 'db-prod-01.internal' });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`mock upstream listening on http://127.0.0.1:${PORT}`);
    console.log('it returns secrets on purpose — the gateway must filter them out');
  });
