'use strict';

/**
 * Response projection — the security core of this gateway.
 *
 * Given an upstream response body and a whitelist of field paths, produce a
 * new object containing ONLY those paths. The upstream body is never passed
 * through, never spread, never merged into the output. The output is built up
 * from nothing, field by field, which is what makes this safe: a field added
 * upstream tomorrow cannot appear in a vendor response, because nothing
 * copies it.
 *
 * Path syntax:
 *   id                     top-level scalar
 *   address.city           nested scalar
 *   items[].id             scalar inside every element of an array
 *   [].id                  scalar inside every element of a root-level array
 *
 * Deliberate restriction: a whitelisted path must resolve to a LEAF — a
 * scalar, null, or an array of scalars. If it resolves to an object, the value
 * is dropped and a warning is logged, because emitting the object wholesale
 * would forward its unknown sub-fields and silently defeat the whitelist.
 * Name the sub-fields you want instead.
 */

const OMIT = Symbol('omit');

function tokenize(pathStr, where) {
  if (typeof pathStr !== 'string' || pathStr.length === 0) {
    throw new Error(`${where}: field path must be a non-empty string`);
  }
  return pathStr.split('.').map((seg) => {
    if (seg === '[]') return { key: null, array: true };
    const m = /^([A-Za-z0-9_-]+)(\[\])?$/.exec(seg);
    if (!m) {
      throw new Error(
        `${where}: "${pathStr}" has an invalid segment "${seg}". Use dotted keys, ` +
          `optionally suffixed with [] for arrays (e.g. items[].id).`
      );
    }
    return { key: m[1], array: !!m[2] };
  });
}

/** A rename must not change the shape of the path, only the names in it. */
function assertSameShape(fromTokens, toTokens, where) {
  if (fromTokens.length !== toTokens.length) {
    throw new Error(
      `${where}: rename target must have the same number of segments as the source path`
    );
  }
  for (let i = 0; i < fromTokens.length; i++) {
    if (fromTokens[i].array !== toTokens[i].array) {
      throw new Error(`${where}: rename target must keep [] in the same positions`);
    }
    if ((fromTokens[i].key === null) !== (toTokens[i].key === null)) {
      throw new Error(`${where}: rename target must keep the root-array marker in place`);
    }
  }
}

function isScalar(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/**
 * Convert a resolved value into something safe to emit, or OMIT.
 * `onUnsafe` is called when an object leaf is refused, so the operator finds
 * out about a misconfigured whitelist instead of quietly getting less data.
 */
function leafValue(v, pathStr, onUnsafe) {
  if (isScalar(v)) return v;
  if (v === undefined) return OMIT;

  if (Array.isArray(v)) {
    if (v.every(isScalar)) return v.slice();
    onUnsafe(pathStr, 'array containing objects');
    return OMIT;
  }

  if (typeof v === 'object') {
    onUnsafe(pathStr, 'object');
    return OMIT;
  }

  // functions, symbols, bigint — not valid JSON anyway
  return OMIT;
}

function walk(src, from, to, dst, pathStr, onUnsafe) {
  const tf = from[0];
  const tt = to[0];
  const restF = from.slice(1);
  const restT = to.slice(1);

  // Resolve the source value for this segment.
  let val;
  if (tf.key === null) {
    val = src;
  } else {
    if (src === null || typeof src !== 'object' || Array.isArray(src)) return;
    if (!Object.prototype.hasOwnProperty.call(src, tf.key)) return;
    val = src[tf.key];
  }

  if (tf.array) {
    if (!Array.isArray(val)) return;

    let arr;
    if (tt.key === null) {
      if (!Array.isArray(dst)) return;
      arr = dst;
    } else {
      if (!Array.isArray(dst[tt.key])) dst[tt.key] = [];
      arr = dst[tt.key];
    }

    val.forEach((el, i) => {
      if (restF.length === 0) {
        const leaf = leafValue(el, pathStr, onUnsafe);
        if (leaf !== OMIT) arr[i] = leaf;
        return;
      }
      if (arr[i] === undefined || arr[i] === null || typeof arr[i] !== 'object') arr[i] = {};
      walk(el, restF, restT, arr[i], pathStr, onUnsafe);
    });
    return;
  }

  if (restF.length === 0) {
    const leaf = leafValue(val, pathStr, onUnsafe);
    if (leaf !== OMIT) dst[tt.key] = leaf;
    return;
  }

  if (val === null || typeof val !== 'object' || Array.isArray(val)) return;
  const cur = dst[tt.key];
  if (cur === undefined || cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
    dst[tt.key] = {};
  }
  walk(val, restF, restT, dst[tt.key], pathStr, onUnsafe);
}

/** Remove holes left by dropped array elements, and prune empty objects. */
function compact(node) {
  if (Array.isArray(node)) {
    const out = [];
    for (const el of node) {
      if (el === undefined) continue;
      const c = compact(el);
      if (c === OMIT) continue;
      out.push(c);
    }
    return out;
  }
  if (node && typeof node === 'object') {
    const out = {};
    let kept = 0;
    for (const [k, v] of Object.entries(node)) {
      if (v === undefined) continue;
      const c = compact(v);
      if (c === OMIT) continue;
      out[k] = c;
      kept++;
    }
    return kept === 0 ? OMIT : out;
  }
  return node;
}

/**
 * Compile a whitelist into a projector. Compilation happens once at boot, so a
 * malformed path is a startup failure rather than a 500 in production.
 *
 * @param {string[]} fields  whitelisted paths
 * @param {object}   rename  optional { sourcePath: targetPath }
 * @param {string}   where   label used in error messages
 * @returns {(body:any, onUnsafe?:Function) => any}
 */
function compile(fields, rename = {}, where = 'response') {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error(`${where}: field whitelist must be a non-empty array`);
  }

  const compiled = fields.map((f) => {
    const fromTokens = tokenize(f, where);
    const target = rename[f] || f;
    const toTokens = tokenize(target, `${where} rename of "${f}"`);
    assertSameShape(fromTokens, toTokens, `${where} rename of "${f}"`);
    return { path: f, fromTokens, toTokens };
  });

  const rootIsArray = compiled[0].fromTokens[0].key === null;
  for (const c of compiled) {
    if ((c.fromTokens[0].key === null) !== rootIsArray) {
      throw new Error(
        `${where}: cannot mix root-array paths ([].x) with object paths in one whitelist`
      );
    }
  }

  return function project(body, onUnsafe = () => {}) {
    const dst = rootIsArray ? [] : {};
    if (rootIsArray && !Array.isArray(body)) return [];
    for (const c of compiled) {
      walk(body, c.fromTokens, c.toTokens, dst, c.path, onUnsafe);
    }
    const result = compact(dst);
    if (result === OMIT) return rootIsArray ? [] : {};
    return result;
  };
}

// ---------------------------------------------------------------------------
// Redact mode — forward everything EXCEPT the named paths.
//
// Understand the trade-off before using this: unlike a whitelist, a redact list
// does not protect you against upstream schema change. Add a column upstream
// tomorrow and it goes straight to the vendor. It exists because real
// migrations need a stepping stone — you have 10 endpoints to ship today and
// you know the three fields that must not leave — and because discovery mode
// (below) gives you a path from here to a proper whitelist.
// ---------------------------------------------------------------------------

/** Keys that must never be copied, whatever the upstream sends. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeClone(node) {
  if (Array.isArray(node)) return node.map(safeClone);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      out[k] = safeClone(v);
    }
    return out;
  }
  return node;
}

function removeAt(node, tokens) {
  const t = tokens[0];
  const rest = tokens.slice(1);

  let target;
  if (t.key === null) {
    target = node;
  } else {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    if (!Object.prototype.hasOwnProperty.call(node, t.key)) return;
    if (rest.length === 0 && !t.array) {
      delete node[t.key];
      return;
    }
    target = node[t.key];
  }

  if (t.array) {
    if (!Array.isArray(target)) return;
    if (rest.length === 0) {
      // `items[]` with nothing after it means drop the array itself.
      if (t.key !== null) delete node[t.key];
      return;
    }
    for (const el of target) removeAt(el, rest);
    return;
  }

  if (rest.length > 0) removeAt(target, rest);
}

/**
 * Compile an exclusion list into a redactor.
 * @returns {(body:any) => any}
 */
function compileRedact(excludePaths, where = 'response') {
  if (!Array.isArray(excludePaths) || excludePaths.length === 0) {
    throw new Error(`${where}: exclusion list must be a non-empty array`);
  }
  const compiled = excludePaths.map((p) => tokenize(p, where));

  return function redact(body) {
    if (body === null || typeof body !== 'object') return body;
    const clone = safeClone(body);
    for (const tokens of compiled) removeAt(clone, tokens);
    return clone;
  };
}

/** Forward verbatim, minus prototype-polluting keys. */
function compilePassthrough() {
  return function passthrough(body) {
    if (body === null || typeof body !== 'object') return body;
    return safeClone(body);
  };
}

// ---------------------------------------------------------------------------
// Discovery — enumerate the leaf paths present in a body.
//
// This is what replaces a field-picker UI. Run an endpoint in redact or
// passthrough mode, let real traffic flow, and the gateway records every leaf
// path it has actually seen. `npm run fields` then prints those paths as a
// ready-to-paste `response.fields:` block, so converting an endpoint to a
// strict whitelist is a copy-paste rather than a guess about upstream's schema.
// ---------------------------------------------------------------------------

/**
 * @returns {Set<string>} leaf paths in the same syntax the whitelist uses
 */
function enumeratePaths(node, prefix = '', out = new Set()) {
  if (Array.isArray(node)) {
    // An array of scalars is itself a valid leaf (e.g. `tags`).
    if (node.every(isScalar)) {
      if (prefix) out.add(prefix);
      return out;
    }
    for (const el of node) enumeratePaths(el, `${prefix}[]`, out);
    return out;
  }

  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      enumeratePaths(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }

  if (prefix) out.add(prefix);
  return out;
}

module.exports = {
  compile,
  compileRedact,
  compilePassthrough,
  enumeratePaths,
  tokenize,
  OMIT,
};
