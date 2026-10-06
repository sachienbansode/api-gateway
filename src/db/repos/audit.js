'use strict';

const db = require('../pool');

/**
 * Audit writer.
 *
 * Hard rule: writing an audit row must never add latency to a vendor request,
 * and must never fail one. So rows are queued in memory and flushed in batches
 * by a timer. The request path does one array push.
 *
 * The queue is BOUNDED. If Postgres is down and the queue fills, we drop the
 * oldest rows and count the drops rather than growing until the process runs out
 * of memory and dies. Losing audit rows during a database outage is bad; taking
 * the gateway down because the audit table is unavailable is worse. The drop
 * count is logged and exposed on /readyz so the loss is never silent.
 *
 * Batches insert via UNNEST rather than a multi-row VALUES list, so one prepared
 * statement shape covers every batch size — Postgres can reuse the plan instead
 * of parsing a new statement for every distinct row count.
 */

const MAX_QUEUE = Number(process.env.AUDIT_QUEUE_MAX) || 5000;
const FLUSH_MS = Number(process.env.AUDIT_FLUSH_MS) || 2000;
const BATCH_SIZE = Number(process.env.AUDIT_BATCH_SIZE) || 500;

class AuditWriter {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.queue = [];
    this.dropped = 0;
    this.written = 0;
    this.failures = 0;
    this.flushing = false;
  }

  start() {
    if (!db.isEnabled()) {
      this.logger?.info('audit persistence disabled (no database) — logs still go to journald');
      return;
    }
    this.timer = setInterval(() => this.flush().catch(() => {}), FLUSH_MS);
    if (this.timer.unref) this.timer.unref();
  }

  /** Queue one row. Synchronous, non-blocking, never throws. */
  record(row) {
    if (!db.isEnabled()) return;

    if (this.queue.length >= MAX_QUEUE) {
      // Drop the oldest: during an outage the newest rows are the ones you
      // actually want when you come to diagnose it.
      this.queue.shift();
      this.dropped += 1;
      if (this.dropped === 1 || this.dropped % 500 === 0) {
        this.logger?.error(
          { dropped: this.dropped, queueMax: MAX_QUEUE },
          'audit queue is full — dropping rows. The database is probably unreachable.'
        );
      }
    }

    this.queue.push({
      requestId: row.requestId,
      vendorId: row.vendorId ?? null,
      endpoint: row.endpoint ?? null,
      method: row.method ?? null,
      path: row.path ?? null,
      status: row.status ?? null,
      errorCode: row.errorCode ?? null,
      upstream: row.upstream ?? null,
      upstreamStatus: row.upstreamStatus ?? null,
      upstreamMs: row.upstreamMs ?? null,
      totalMs: row.totalMs ?? null,
      responseMode: row.responseMode ?? null,
      clientIp: normaliseIp(row.clientIp),
      internalReason: truncate(row.internalReason, 2000),
    });
  }

  async flush() {
    if (!db.isEnabled() || this.flushing || this.queue.length === 0) return;
    this.flushing = true;

    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, BATCH_SIZE);

        try {
          await this.insertBatch(batch);
          this.queue.splice(0, batch.length);
          this.written += batch.length;
        } catch (err) {
          this.failures += 1;
          this.logger?.error(
            { err: err.message, queued: this.queue.length },
            'audit batch insert failed — rows stay queued and will be retried'
          );
          // Leave the batch queued and stop trying this tick. Retrying in a
          // tight loop against a down database achieves nothing.
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async insertBatch(batch) {
    const cols = [
      'requestId',
      'vendorId',
      'endpoint',
      'method',
      'path',
      'status',
      'errorCode',
      'upstream',
      'upstreamStatus',
      'upstreamMs',
      'totalMs',
      'responseMode',
      'clientIp',
      'internalReason',
    ];
    const arrays = cols.map((c) => batch.map((r) => r[c]));

    await db.query(
      `INSERT INTO gateway.audit_log (
         request_id, vendor_id, endpoint, method, path, status, error_code,
         upstream, upstream_status, upstream_ms, total_ms, response_mode,
         client_ip, internal_reason
       )
       SELECT * FROM unnest(
         $1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[],
         $7::text[], $8::text[], $9::int[], $10::int[], $11::int[], $12::text[],
         $13::inet[], $14::text[]
       )`,
      arrays
    );
  }

  stats() {
    return {
      queued: this.queue.length,
      written: this.written,
      dropped: this.dropped,
      failures: this.failures,
    };
  }

  async stop() {
    clearInterval(this.timer);
    // Best effort: get whatever is queued into the database before we exit.
    await this.flush().catch(() => {});
    if (this.queue.length > 0) {
      this.logger?.warn(
        { unflushed: this.queue.length },
        'shutting down with audit rows still queued — they are lost'
      );
    }
  }
}

function truncate(s, n) {
  if (typeof s !== 'string') return s ?? null;
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * The column is INET, so a malformed value would fail the whole batch and take
 * 499 innocent rows with it. Anything unparseable becomes NULL.
 */
function normaliseIp(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return null;
  // Express gives ::ffff:1.2.3.4 for IPv4 over an IPv6 socket.
  const cleaned = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  const v6 = /^[0-9a-fA-F:]+$/;
  if (v4.test(cleaned) || v6.test(cleaned)) return cleaned;
  return null;
}

// ---------------------------------------------------------------------------
// Reads — for the usage CLI and whatever admin UI comes later.
// ---------------------------------------------------------------------------

async function recentForVendor(vendorId, limit = 100) {
  const res = await db.query(
    `SELECT request_id, occurred_at, endpoint, method, status, error_code,
            upstream_status, upstream_ms, total_ms
       FROM gateway.audit_log
      WHERE vendor_id = $1
      ORDER BY occurred_at DESC
      LIMIT $2`,
    [vendorId, limit]
  );
  return res?.rows || [];
}

async function findByRequestId(requestId) {
  const res = await db.query(
    `SELECT * FROM gateway.audit_log WHERE request_id = $1`,
    [requestId]
  );
  return res?.rows?.[0] || null;
}

async function usageSummary({ since = null, vendorId = null } = {}) {
  const res = await db.query(
    `SELECT vendor_id, endpoint,
            count(*)                                        AS calls,
            count(*) FILTER (WHERE status >= 400)           AS errors,
            round(avg(total_ms))                            AS avg_ms,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY total_ms) AS p95_ms,
            max(occurred_at)                                AS last_call
       FROM gateway.audit_log
      WHERE ($1::timestamptz IS NULL OR occurred_at >= $1)
        AND ($2::text IS NULL OR vendor_id = $2)
      GROUP BY vendor_id, endpoint
      ORDER BY vendor_id, calls DESC`,
    [since, vendorId]
  );
  return res?.rows || [];
}

/** Retention. Run from cron; deleting in chunks keeps the lock short. */
async function purgeOlderThan(days) {
  const res = await db.query(
    `DELETE FROM gateway.audit_log
      WHERE id IN (
        SELECT id FROM gateway.audit_log
         WHERE occurred_at < now() - ($1 || ' days')::interval
         LIMIT 50000
      )`,
    [String(days)]
  );
  return res?.rowCount || 0;
}

module.exports = {
  AuditWriter,
  recentForVendor,
  findByRequestId,
  usageSummary,
  purgeOlderThan,
  normaliseIp,
};
