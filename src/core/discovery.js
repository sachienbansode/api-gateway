'use strict';

const fs = require('fs');
const path = require('path');
const { enumeratePaths } = require('./projection');
const db = require('../db/pool');

/**
 * Field discovery.
 *
 * This is the answer to "how do I author a whitelist for 10+ endpoints without
 * a UI, when I don't know what the upstream actually returns?"
 *
 * Ship the endpoint in redact or passthrough mode, let real traffic flow for a
 * day, and this records every leaf path each upstream has actually produced.
 * `npm run fields` then prints those paths as a ready-to-paste
 * `response.fields:` block. You convert to a strict whitelist from observed
 * reality rather than from someone's memory of the schema.
 *
 * Two deliberate properties:
 *   - Only field NAMES are recorded, never values. This file is safe to read,
 *     commit, and paste into a ticket. Recording values would turn a
 *     convenience feature into a second copy of your customer data.
 *   - On an unfiltered endpoint, the FIRST time a never-before-seen path
 *     appears it logs a warning. That is your early warning that upstream
 *     added a column and it is now reaching the vendor.
 */

const DEFAULT_FILE = process.env.DISCOVERY_FILE || path.join(process.cwd(), 'discovered-fields.json');

class FieldObserver {
  constructor({ file = DEFAULT_FILE, logger, flushMs = 30000, enabled = true } = {}) {
    this.file = file;
    this.logger = logger;
    this.enabled = enabled;
    /** @type {Map<string, Set<string>>} endpoint name -> observed paths */
    this.seen = new Map();
    this.dirty = false;
    /**
     * Paths observed but not yet written to Postgres, as "endpoint\0path".
     *
     * Without this, every flush re-upserted every path ever seen. At 500
     * observed paths on a 30s timer that is 1.4 million writes a day to
     * refresh a timestamp nobody is reading in real time — and on Azure
     * Flexible Server you pay for those IOPS.
     */
    this.unpersisted = new Set();

    if (this.enabled) {
      this.load();
      this.timer = setInterval(() => {
        this.flush();
        this.persist().catch(() => {});
      }, flushMs);
      if (this.timer.unref) this.timer.unref();
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [endpoint, entry] of Object.entries(raw.endpoints || {})) {
        this.seen.set(endpoint, new Set(entry.fields || []));
      }
    } catch (err) {
      // A corrupt discovery file must never stop the gateway serving traffic.
      this.logger?.warn({ file: this.file, err: err.message }, 'could not read discovery file');
    }
  }

  /**
   * Record the shape of one response.
   * @param {object} endpoint  the endpoint config
   * @param {any}    body      upstream body (values are NOT retained)
   */
  observe(endpoint, body) {
    if (!this.enabled) return;

    let paths;
    try {
      paths = enumeratePaths(body);
    } catch {
      return; // never let discovery break a response
    }

    let known = this.seen.get(endpoint.name);
    const firstSighting = known === undefined;
    if (!known) {
      known = new Set();
      this.seen.set(endpoint.name, known);
    }

    const novel = [];
    for (const p of paths) {
      if (!known.has(p)) {
        known.add(p);
        novel.push(p);
        this.unpersisted.add(`${endpoint.name}\u0000${p}`);
        this.dirty = true;
      }
    }

    if (novel.length === 0) return;

    // On an unfiltered endpoint a new upstream field is now reaching the
    // vendor, so this is a warning rather than an info line. On a whitelist
    // endpoint it is merely interesting — the projector already dropped it.
    const unfiltered = endpoint.response.mode !== 'whitelist';
    if (unfiltered && !firstSighting) {
      this.logger?.warn(
        { endpoint: endpoint.name, mode: endpoint.response.mode, newFields: novel },
        'upstream returned field(s) never seen before, and this endpoint does not ' +
          'whitelist — these are now reaching the vendor. Review.'
      );
    } else {
      this.logger?.info(
        { endpoint: endpoint.name, mode: endpoint.response.mode, newFields: novel.length },
        'discovery: new field paths recorded'
      );
    }
  }

  /**
   * Persist observed paths to Postgres as well as the local file.
   *
   * Worth having because the JSON file is per-instance and per-VM: with two
   * gateway instances you would otherwise have two partial pictures, and a
   * rebuilt VM would lose its history. The table gives one view across
   * instances and survives redeploys.
   *
   * Field NAMES only, exactly as with the file. Never values.
   */
  /**
   * @param {{all?:boolean}} [opts] `all: true` rewrites every known path,
   *        refreshing last_seen. Used on shutdown, never on the timer.
   */
  async persist({ all = false } = {}) {
    if (!this.enabled || !db.isEnabled() || this.seen.size === 0) return;

    const endpoints = [];
    const paths = [];

    if (all) {
      for (const [endpoint, set] of this.seen) {
        for (const p of set) {
          endpoints.push(endpoint);
          paths.push(p);
        }
      }
    } else {
      // Only what is new since the last successful write.
      for (const entry of this.unpersisted) {
        const split = entry.indexOf('\u0000');
        endpoints.push(entry.slice(0, split));
        paths.push(entry.slice(split + 1));
      }
    }

    if (endpoints.length === 0) return;

    try {
      // first_seen is preserved on conflict; only last_seen moves. That makes
      // "when did upstream start returning this field?" answerable later.
      await db.query(
        `INSERT INTO gateway.observed_fields (endpoint, field_path, first_seen, last_seen)
         SELECT e, p, now(), now() FROM unnest($1::text[], $2::text[]) AS t(e, p)
         ON CONFLICT (endpoint, field_path) DO UPDATE SET last_seen = now()`,
        [endpoints, paths]
      );
      // Only clear on success, so a failed write is retried on the next tick
      // rather than silently losing the paths.
      if (!all) this.unpersisted.clear();
    } catch (err) {
      // Never let discovery bookkeeping affect serving traffic.
      this.logger?.warn({ err: err.message }, 'could not persist discovered fields');
    }
  }

  flush() {
    if (!this.enabled || !this.dirty) return;
    const payload = {
      note:
        'Field NAMES observed in upstream responses. No values are recorded. ' +
        'Generated by the gateway; run "npm run fields" to turn this into YAML.',
      updatedAt: new Date().toISOString(),
      endpoints: {},
    };
    for (const [endpoint, paths] of this.seen) {
      payload.endpoints[endpoint] = { fields: [...paths].sort() };
    }
    try {
      fs.writeFileSync(this.file, JSON.stringify(payload, null, 2));
      this.dirty = false;
    } catch (err) {
      this.logger?.warn({ file: this.file, err: err.message }, 'could not write discovery file');
    }
  }

  snapshot() {
    const out = {};
    for (const [endpoint, paths] of this.seen) out[endpoint] = [...paths].sort();
    return out;
  }

  async stop() {
    clearInterval(this.timer);
    this.flush();
    // One full rewrite on the way out refreshes last_seen for every path, which
    // is what makes "is upstream still returning this field?" answerable
    // without paying for it on every tick.
    await this.persist({ all: true }).catch(() => {});
  }
}

module.exports = { FieldObserver, DEFAULT_FILE };
