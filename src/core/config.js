'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, '..', '..', 'config');

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const VALID_UPSTREAM_AUTH = new Set(['none', 'bearer', 'header', 'basic', 'query']);
const VALID_RESPONSE_MODES = new Set(['whitelist', 'redact', 'passthrough']);
const VALID_IDEMPOTENCY = new Set(['required', 'optional', 'off']);

class ConfigError extends Error {}

/**
 * Replace ${VAR} references with values from the environment.
 *
 * Deliberately strict: an unresolved reference is a hard boot failure, not a
 * warning. A gateway that starts with an empty upstream credential will send
 * unauthenticated requests upstream and fail in confusing ways at 3am; far
 * better to refuse to start.
 */
function interpolate(value, envName) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const found = process.env[name];
    if (found === undefined || found === '') {
      throw new ConfigError(
        `${envName}: environment variable ${name} is referenced but not set. ` +
          `Add it to .env (see .env.example).`
      );
    }
    return found;
  });
}

function deepInterpolate(node, where) {
  if (Array.isArray(node)) return node.map((n) => deepInterpolate(n, where));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepInterpolate(v, where);
    return out;
  }
  return interpolate(node, where);
}

function readYaml(file) {
  const full = path.join(CONFIG_DIR, file);
  if (!fs.existsSync(full)) throw new ConfigError(`Missing config file: ${full}`);
  try {
    return yaml.load(fs.readFileSync(full, 'utf8')) || {};
  } catch (err) {
    throw new ConfigError(`${file} is not valid YAML: ${err.message}`);
  }
}

/** Extract `:param` names from a route pattern. */
function pathParams(p) {
  return (p.match(/:[A-Za-z0-9_]+/g) || []).map((s) => s.slice(1));
}

function loadUpstreams() {
  const raw = readYaml('upstreams.yaml');
  const src = raw.upstreams || {};
  const out = {};

  for (const [id, rawDef] of Object.entries(src)) {
    // Interpolate the whole upstream block, not just auth: baseUrl is
    // frequently an environment reference too (different host per environment).
    const def = deepInterpolate(rawDef, `upstream "${id}"`);

    if (!def || !def.baseUrl) throw new ConfigError(`upstream "${id}": baseUrl is required`);

    let parsed;
    try {
      parsed = new URL(def.baseUrl);
    } catch {
      throw new ConfigError(
        `upstream "${id}": baseUrl "${def.baseUrl}" is not a valid URL`
      );
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ConfigError(`upstream "${id}": baseUrl must be http or https`);
    }

    const auth = def.auth || { type: 'none' };
    if (!VALID_UPSTREAM_AUTH.has(auth.type)) {
      throw new ConfigError(
        `upstream "${id}": auth.type "${auth.type}" is not one of ${[...VALID_UPSTREAM_AUTH].join(', ')}`
      );
    }
    if (auth.type === 'bearer' && !auth.token) {
      throw new ConfigError(`upstream "${id}": auth.type bearer requires a token`);
    }
    if ((auth.type === 'header' || auth.type === 'query') && (!auth.name || !auth.value)) {
      throw new ConfigError(`upstream "${id}": auth.type ${auth.type} requires name and value`);
    }
    if (auth.type === 'basic' && (!auth.username || auth.password === undefined)) {
      throw new ConfigError(`upstream "${id}": auth.type basic requires username and password`);
    }

    out[id] = {
      id,
      baseUrl: def.baseUrl.replace(/\/+$/, ''),
      timeoutMs: Number(def.timeoutMs) > 0 ? Number(def.timeoutMs) : 8000,
      auth,
      breaker: {
        failureThreshold: Number(def.breaker?.failureThreshold) || 5,
        resetMs: Number(def.breaker?.resetMs) || 30000,
      },
    };
  }

  if (Object.keys(out).length === 0) throw new ConfigError('upstreams.yaml declares no upstreams');
  return out;
}

function loadEndpoints(upstreams) {
  const raw = readYaml('endpoints.yaml');
  const list = raw.endpoints || [];
  if (!Array.isArray(list) || list.length === 0) {
    throw new ConfigError('endpoints.yaml declares no endpoints');
  }

  const seenNames = new Set();
  const seenRoutes = new Set();
  const allScopes = new Set();

  const out = list.map((ep, i) => {
    const at = `endpoint #${i + 1}${ep.name ? ` (${ep.name})` : ''}`;

    if (!ep.name) throw new ConfigError(`${at}: name is required`);
    if (seenNames.has(ep.name)) throw new ConfigError(`${at}: duplicate endpoint name`);
    seenNames.add(ep.name);

    if (!ep.path || !ep.path.startsWith('/')) {
      throw new ConfigError(`${at}: path is required and must start with /`);
    }
    const method = String(ep.method || 'GET').toUpperCase();
    if (!VALID_METHODS.has(method)) {
      throw new ConfigError(`${at}: method "${method}" is not supported`);
    }

    const routeKey = `${method} ${ep.path}`;
    if (seenRoutes.has(routeKey)) throw new ConfigError(`${at}: duplicate route ${routeKey}`);
    seenRoutes.add(routeKey);

    if (!ep.upstream) throw new ConfigError(`${at}: upstream is required`);
    if (!upstreams[ep.upstream]) {
      throw new ConfigError(
        `${at}: upstream "${ep.upstream}" is not declared in upstreams.yaml`
      );
    }
    if (!ep.upstreamPath || !ep.upstreamPath.startsWith('/')) {
      throw new ConfigError(`${at}: upstreamPath is required and must start with /`);
    }

    // Every :param the upstream path needs must be suppliable from the
    // vendor-facing path, or we would build a URL containing a literal ":id".
    const have = new Set(pathParams(ep.path));
    for (const need of pathParams(ep.upstreamPath)) {
      if (!have.has(need)) {
        throw new ConfigError(
          `${at}: upstreamPath uses :${need} but the vendor-facing path does not define it`
        );
      }
    }

    const scopes = Array.isArray(ep.scopes) ? ep.scopes : [];
    if (scopes.length === 0) {
      throw new ConfigError(
        `${at}: at least one scope is required. An endpoint with no scope would be ` +
          `reachable by every vendor key, which is almost never what you want.`
      );
    }
    scopes.forEach((s) => allScopes.add(s));

    // ---------------------------------------------------------------------
    // Response handling mode.
    //
    //   whitelist   (default, safest) emit only the named fields
    //   redact      forward everything EXCEPT the named fields
    //   passthrough forward the upstream body verbatim
    //
    // whitelist is safe against upstream schema change; the other two are not,
    // and that is the whole trade-off. They are supported because real
    // migrations need them, but they must be declared explicitly so they show
    // up in a diff and in the validate report.
    // ---------------------------------------------------------------------
    const mode = String(ep.response?.mode || 'whitelist').toLowerCase();
    if (!VALID_RESPONSE_MODES.has(mode)) {
      throw new ConfigError(
        `${at}: response.mode "${mode}" is not one of ${[...VALID_RESPONSE_MODES].join(', ')}`
      );
    }

    const fields = ep.response?.fields;
    const exclude = ep.response?.exclude;
    const rename = ep.response?.rename || {};

    if (mode === 'whitelist') {
      if (!Array.isArray(fields) || fields.length === 0) {
        throw new ConfigError(
          `${at}: response.fields is required for mode "whitelist". If you genuinely ` +
            `need to forward the whole body for now, set response.mode to "redact" or ` +
            `"passthrough" so the decision is explicit and reviewable.`
        );
      }
      for (const from of Object.keys(rename)) {
        if (!fields.includes(from)) {
          throw new ConfigError(
            `${at}: response.rename maps "${from}" but that path is not in response.fields`
          );
        }
      }
    }

    if (mode === 'redact') {
      if (!Array.isArray(exclude) || exclude.length === 0) {
        throw new ConfigError(
          `${at}: response.exclude is required for mode "redact" and must be non-empty. ` +
            `A redact endpoint with nothing excluded is just a passthrough — say so.`
        );
      }
      if (Object.keys(rename).length > 0) {
        throw new ConfigError(
          `${at}: response.rename is only supported in mode "whitelist". Renaming in ` +
            `redact mode is phase-2 transformation work.`
        );
      }
    }

    if (mode === 'passthrough') {
      if (ep.response?.acknowledgeUnfiltered !== true) {
        throw new ConfigError(
          `${at}: mode "passthrough" forwards the upstream body verbatim, including any ` +
            `field added upstream in future. To confirm that is intended, set ` +
            `response.acknowledgeUnfiltered: true. Prefer "redact" if you only need to ` +
            `drop a handful of known-sensitive fields.`
        );
      }
      if (Array.isArray(exclude) && exclude.length > 0) {
        throw new ConfigError(
          `${at}: response.exclude is set but mode is "passthrough", so it would be ` +
            `ignored. Did you mean mode: redact?`
        );
      }
    }

    const inject = ep.request?.inject || {};
    const queryAllow = Array.isArray(ep.request?.query) ? ep.request.query : [];
    const bodyAllow = Array.isArray(ep.request?.body) ? ep.request.body : [];

    // An injected value the vendor can also send would let them override it.
    for (const k of Object.keys(inject)) {
      if (queryAllow.includes(k) || bodyAllow.includes(k)) {
        throw new ConfigError(
          `${at}: "${k}" is both injected and vendor-supplyable. Remove it from the ` +
            `allowlist, or the vendor can override the value you are forcing.`
        );
      }
    }

    if (['GET', 'DELETE'].includes(method) && bodyAllow.length > 0) {
      throw new ConfigError(`${at}: request.body is meaningless for a ${method} endpoint`);
    }

    // -------------------------------------------------------------------
    // Idempotency. Defaults to "required" on writes, because the failure it
    // prevents — a vendor retry creating the resource twice — is silent,
    // expensive, and certain to happen eventually over a network you do not
    // control. Opt out per endpoint if the upstream is genuinely idempotent.
    // -------------------------------------------------------------------
    const isWrite = ['POST', 'PUT', 'PATCH'].includes(method);
    const idempotency = String(
      ep.idempotency || (isWrite ? 'required' : 'off')
    ).toLowerCase();

    if (!VALID_IDEMPOTENCY.has(idempotency)) {
      throw new ConfigError(
        `${at}: idempotency "${idempotency}" is not one of ${[...VALID_IDEMPOTENCY].join(', ')}`
      );
    }
    if (!isWrite && idempotency !== 'off') {
      throw new ConfigError(
        `${at}: idempotency applies only to POST/PUT/PATCH — a ${method} is already safe to retry`
      );
    }

    return {
      name: ep.name,
      path: ep.path,
      method,
      upstream: ep.upstream,
      upstreamPath: ep.upstreamPath,
      upstreamMethod: String(ep.upstreamMethod || method).toUpperCase(),
      scopes,
      rateLimit: {
        windowMs: Number(ep.rateLimit?.windowMs) || 60000,
        max: Number(ep.rateLimit?.max) || 60,
      },
      request: { query: queryAllow, body: bodyAllow, inject },
      response: {
        mode,
        fields: Array.isArray(fields) ? fields : [],
        exclude: Array.isArray(exclude) ? exclude : [],
        rename,
      },
      // Discovery defaults ON for unfiltered modes, because that is exactly
      // where you need to know what is flowing through. Opt in elsewhere.
      discover: ep.response?.discover ?? mode !== 'whitelist',
      idempotency,
      description: ep.description || '',
    };
  });

  return { endpoints: out, declaredScopes: allScopes };
}

function loadVendors(declaredScopes) {
  const raw = readYaml('vendors.yaml');
  const list = raw.vendors || [];
  if (!Array.isArray(list) || list.length === 0) {
    throw new ConfigError('vendors.yaml declares no vendors');
  }

  const vendors = [];
  const byHash = new Map();

  for (const v of list) {
    if (!v.id) throw new ConfigError('vendors.yaml: every vendor needs an id');
    if (v.enabled === false) continue;

    const scopes = Array.isArray(v.scopes) ? v.scopes : [];
    for (const s of scopes) {
      if (!declaredScopes.has(s)) {
        throw new ConfigError(
          `vendor "${v.id}": scope "${s}" is not used by any endpoint. Typo, or a ` +
            `leftover from a removed endpoint.`
        );
      }
    }

    // ---------------------------------------------------------------------
    // Key hashes in env are the NO-DATABASE path only.
    //
    // Once DATABASE_URL is set, vendors and their keys live in Postgres and
    // this file is just the seed source for `gw.js vendor:seed`. Demanding
    // VENDOR_KEY_* in that mode would be pure friction — and worse, it would
    // imply the env hash is still authoritative when it is not.
    // ---------------------------------------------------------------------
    const keysComeFromDatabase = Boolean(process.env.DATABASE_URL);

    const keyEnvs = Array.isArray(v.keyEnv) ? v.keyEnv : [v.keyEnv].filter(Boolean);
    if (keyEnvs.length === 0 && !keysComeFromDatabase) {
      throw new ConfigError(
        `vendor "${v.id}": keyEnv is required when there is no database. Either set ` +
          `DATABASE_URL and manage keys with scripts/gw.js, or add a keyEnv here.`
      );
    }

    const hashes = [];
    for (const envName of keyEnvs) {
      const hash = (process.env[envName] || '').trim().toLowerCase();

      if (!hash) {
        if (keysComeFromDatabase) continue; // expected: the DB is authoritative
        throw new ConfigError(
          `vendor "${v.id}": ${envName} is not set. Run "npm run genkey -- ${v.id}" ` +
            `and put the printed hash in .env, or set enabled: false.`
        );
      }

      if (!/^[0-9a-f]{64}$/.test(hash)) {
        if (keysComeFromDatabase) continue; // unused in this mode; don't block boot
        throw new ConfigError(
          `vendor "${v.id}": ${envName} does not look like a SHA-256 hex hash. ` +
            `Did you paste the plaintext key by mistake? Store only the hash.`
        );
      }

      if (byHash.has(hash)) {
        throw new ConfigError(
          `vendor "${v.id}": key hash collides with vendor "${byHash.get(hash).id}". ` +
            `Two vendors must not share a key.`
        );
      }
      hashes.push(hash);
    }

    const vendor = {
      id: v.id,
      name: v.name || v.id,
      scopes: new Set(scopes),
      rateLimit: {
        windowMs: Number(v.rateLimit?.windowMs) || 60000,
        max: Number(v.rateLimit?.max) || 600,
      },
      // Durable monthly quotas need the database. Declaring one here is only
      // meaningful once vendors live in Postgres; null means uncapped.
      monthlyQuota: v.monthlyQuota === undefined ? null : Number(v.monthlyQuota),
    };
    vendors.push(vendor);
    hashes.forEach((h) => byHash.set(h, vendor));
  }

  if (vendors.length === 0) throw new ConfigError('vendors.yaml: no enabled vendors');
  return { vendors, byHash };
}

function load() {
  const upstreams = loadUpstreams();
  const { endpoints, declaredScopes } = loadEndpoints(upstreams);
  const { vendors, byHash } = loadVendors(declaredScopes);

  // Warn loudly about endpoints no enabled vendor can reach. Not fatal —
  // it is a legitimate staging state — but almost always a mistake.
  const grantedScopes = new Set();
  vendors.forEach((v) => v.scopes.forEach((s) => grantedScopes.add(s)));
  const unreachable = endpoints
    .filter((e) => !e.scopes.some((s) => grantedScopes.has(s)))
    .map((e) => e.name);

  return { upstreams, endpoints, vendors, vendorsByKeyHash: byHash, unreachable };
}

module.exports = { load, ConfigError, pathParams, CONFIG_DIR };
