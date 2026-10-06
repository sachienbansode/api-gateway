'use strict';

const { pathParams } = require('./config');
const { tokenize } = require('./projection');

/**
 * Build a vendor-facing OpenAPI 3.0 spec from the manifest.
 *
 * The point of generating it rather than writing it: the documentation is
 * derived from the same whitelist that enforces the filtering, so it cannot
 * drift into describing a field you do not actually expose, and it cannot
 * mention an upstream you do not want named. Nothing from upstreams.yaml is
 * read here at all.
 */

/** Turn whitelist paths into a nested JSON Schema. */
function schemaFromFields(fields, rename = {}) {
  const outputPaths = fields.map((f) => rename[f] || f);
  const rootIsArray = outputPaths.length > 0 && outputPaths[0].startsWith('[]');

  function insert(node, tokens) {
    const [t, ...rest] = tokens;

    if (t.key === null) {
      // root array marker
      node.type = 'array';
      node.items = node.items || { type: 'object', properties: {} };
      if (rest.length) insert(node.items, rest);
      return;
    }

    node.type = 'object';
    node.properties = node.properties || {};

    if (t.array) {
      node.properties[t.key] = node.properties[t.key] || {
        type: 'array',
        items: { type: 'object', properties: {} },
      };
      if (rest.length) insert(node.properties[t.key].items, rest);
      return;
    }

    if (rest.length === 0) {
      // We do not know the upstream type, and claiming one we cannot guarantee
      // is worse than staying silent. Leave it untyped but documented.
      node.properties[t.key] = node.properties[t.key] || {};
      return;
    }

    node.properties[t.key] = node.properties[t.key] || { type: 'object', properties: {} };
    insert(node.properties[t.key], rest);
  }

  const root = rootIsArray ? {} : { type: 'object', properties: {} };
  for (const p of outputPaths) insert(root, tokenize(p, 'openapi'));
  return root;
}

function build({ endpoints, info = {} }) {
  const paths = {};

  for (const ep of endpoints) {
    // Express `:param` -> OpenAPI `{param}`
    const oaPath = ep.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    paths[oaPath] = paths[oaPath] || {};

    const parameters = [
      ...pathParams(ep.path).map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      ...ep.request.query.map((name) => ({
        name,
        in: 'query',
        required: false,
        schema: { type: 'string' },
      })),
    ];

    // In whitelist mode the schema is exact, because the same list enforces it.
    // In redact/passthrough mode we cannot honestly enumerate the shape, so we
    // say so rather than publishing a schema that is wrong the moment upstream
    // adds a field.
    const okSchema =
      ep.response.mode === 'whitelist'
        ? schemaFromFields(ep.response.fields, ep.response.rename)
        : {
            type: 'object',
            description:
              'Response shape is not enumerated for this endpoint and may gain ' +
              'additional properties without notice. Do not assume a fixed set of fields.',
            additionalProperties: true,
          };

    const operation = {
      operationId: ep.name,
      summary: ep.description || ep.name.replace(/_/g, ' '),
      tags: [ep.scopes[0].split('.')[0]],
      parameters,
      security: [{ ApiKeyAuth: [] }],
      responses: {
        200: {
          description: 'Success',
          content: { 'application/json': { schema: okSchema } },
        },
        400: { $ref: '#/components/responses/BadRequest' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
        429: { $ref: '#/components/responses/RateLimited' },
        503: { $ref: '#/components/responses/Unavailable' },
      },
      'x-rate-limit': `${ep.rateLimit.max} requests per ${ep.rateLimit.windowMs / 1000}s`,
    };

    if (['POST', 'PUT', 'PATCH'].includes(ep.method) && ep.request.body.length) {
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              // Documented AND enforced: the gateway rejects unknown fields.
              additionalProperties: false,
              properties: Object.fromEntries(ep.request.body.map((f) => [f, {}])),
            },
          },
        },
      };
    }

    paths[oaPath][ep.method.toLowerCase()] = operation;
  }

  const errorSchema = {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          requestId: {
            type: 'string',
            description:
              'Quote this value when reporting a problem — it identifies the request in our logs.',
          },
          retryAfter: { type: 'integer' },
        },
      },
    },
  };

  const errResponse = (description) => ({
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  });

  return {
    openapi: '3.0.3',
    info: {
      title: info.title || 'Partner API',
      version: info.version || '1.0.0',
      description:
        info.description ||
        'Partner-facing API. Authenticate with the API key issued to you, sent in the ' +
          'X-API-Key header. Keys are per-partner and rate limited; contact us to rotate one.',
    },
    servers: info.servers || [{ url: 'https://partner-api.example.com' }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
      schemas: { Error: errorSchema },
      responses: {
        BadRequest: errResponse('Invalid request — unsupported parameter or field.'),
        Unauthorized: errResponse('Missing or invalid API key.'),
        Forbidden: errResponse('Key not permitted to use this endpoint.'),
        NotFound: errResponse('No such endpoint or resource.'),
        RateLimited: errResponse('Rate limit exceeded.'),
        Unavailable: errResponse('Temporarily unavailable.'),
      },
    },
    security: [{ ApiKeyAuth: [] }],
    paths,
  };
}

module.exports = { build, schemaFromFields };
