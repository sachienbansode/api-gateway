'use strict';

/**
 * Handing a verified payload to the internal application.
 *
 * This runs on our schedule rather than the supplier's, which is the whole
 * reason the payload was written down first. FlipitMoney give up after three
 * attempts in about a minute; this keeps trying for hours.
 *
 * WHY IT DOES NOT LOOP CONTINUOUSLY
 *
 * It wakes on a timer and when something arrives, takes a small batch, and
 * stops. A tight loop over a queue that is almost always empty is a busy
 * database connection doing nothing, and on a single VM that is noticeable.
 *
 * WHY ONE FAILING WEBHOOK CANNOT BLOCK ANOTHER
 *
 * The batch is ordered by arrival and capped. A supplier whose internal
 * application is down accumulates rows with increasing backoff, so they drop
 * out of "due now" quickly and the others keep moving.
 */

const DEFAULT_INTERVAL_MS = 15000;
const BATCH = 20;

function buildDeliverer({ repo, logger, fetchImpl = fetch, intervalMs = DEFAULT_INTERVAL_MS }) {
  let timer = null;
  let running = false;
  let stopped = false;

  async function deliverOne(row) {
    const started = Date.now();
    let res;
    try {
      res = await fetchImpl(row.forward_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // So the internal application can recognise a repeat of its own,
          // and can tell which webhook a payload came from without parsing it.
          'x-pravah-webhook': row.webhook,
          'x-pravah-event-key': row.event_key || '',
          'x-pravah-attempt': String((row.attempts || 0) + 1),
        },
        body: JSON.stringify(row.payload),
        signal: AbortSignal.timeout(row.forward_timeout_ms || 8000),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return { ok: false, error: timedOut ? `timeout after ${row.forward_timeout_ms}ms`
        : `transport error: ${err?.message}` };
    }

    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, ms: Date.now() - started };
    }

    // A 4xx from our own internal application is still retried. It is far more
    // often a deployment mid-restart than a payload the application will never
    // accept, and the cost of retrying something unacceptable is a few log
    // lines — against losing a news item there is no second copy of.
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status,
      error: `internal application answered ${res.status}: ${text.slice(0, 200)}` };
  }

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const rows = await repo.due(BATCH);
      for (const row of rows) {
        const out = await deliverOne(row);
        if (out.ok) {
          await repo.delivered(row.id);
          logger?.info?.(
            { webhook: row.webhook, eventKey: row.event_key, ms: out.ms,
              attempts: (row.attempts || 0) + 1 },
            'webhook payload delivered'
          );
        } else {
          const after = await repo.failedAttempt(row.id, out.error, row.forward_max_attempts);
          const give = after?.state === 'failed';
          logger?.[give ? 'error' : 'warn']?.(
            { webhook: row.webhook, eventKey: row.event_key,
              attempts: after?.attempts, err: out.error },
            give
              ? 'webhook payload could NOT be delivered and is being kept for review'
              : 'webhook delivery failed, will retry'
          );
        }
      }
    } catch (err) {
      // The queue being unreadable must not kill the process; the next tick
      // tries again. The log line is the alert.
      logger?.error?.({ err: err?.message }, 'webhook delivery sweep failed');
    } finally {
      running = false;
    }
  }

  return {
    /** Called when something is accepted, so a quiet queue still moves at once. */
    nudge() { setImmediate(() => { tick().catch(() => {}); }); },
    start() {
      if (timer) return;
      stopped = false;
      timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
      // Never hold the process open on account of this timer.
      if (timer.unref) timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}

module.exports = { buildDeliverer };
