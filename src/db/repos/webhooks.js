'use strict';

const db = require('../pool');
const secrets = require('./secrets');

/**
 * Webhooks: the APIs that call us.
 *
 * The queue rules this module keeps, because getting them wrong is silent:
 *
 *  1. ACCEPTING AND DELIVERING ARE SEPARATE. The supplier is answered 200 as
 *     soon as the payload is written down. FlipitMoney retry three times over
 *     about a minute and then the news is gone for good, so the answer must
 *     not wait on an internal application being up.
 *
 *  2. A DELIVERED ROW IS DELETED. This is a queue, not a store of supplier
 *     data. When everything is working the table is empty, which also makes
 *     "is anything stuck" a question with an obvious answer.
 *
 *  3. A REPEAT IS RECOGNISED WITHOUT KEEPING THE PAYLOAD. webhook_seen holds
 *     an identifier and a version. A supplier retry of something we already
 *     took must not become a second copy downstream; a genuine update, which
 *     carries a new version, must.
 */

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function list() {
  const r = await db.query(`
    SELECT w.*,
           (SELECT count(*) FROM gateway.webhook_deliveries d
             WHERE d.webhook = w.name AND d.state = 'pending')   AS pending,
           (SELECT count(*) FROM gateway.webhook_deliveries d
             WHERE d.webhook = w.name AND d.state = 'failed')    AS failed,
           (SELECT max(occurred_at) FROM gateway.webhook_log l
             WHERE l.webhook = w.name)                            AS last_call
      FROM gateway.webhooks w
     ORDER BY w.name`);
  return r?.rows || [];
}

/** The live routing table: only what can actually serve a request. */
async function routable() {
  const r = await db.query(
    `SELECT * FROM gateway.webhooks
      WHERE enabled = TRUE AND status = 'live' ORDER BY path`);
  return r?.rows || [];
}

async function byName(name) {
  const r = await db.query(`SELECT * FROM gateway.webhooks WHERE name = $1`, [name]);
  return r?.rows?.[0] || null;
}

/** Masked credential state for a screen. No ciphertext column is selected. */
async function credentialStatus(name = null) {
  const r = await db.query(
    `SELECT * FROM gateway.webhook_credentials
      WHERE ($1::text IS NULL OR webhook = $1) ORDER BY webhook`,
    [name]
  );
  return r?.rows || [];
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function save(row, actor) {
  const saved = await db.query(
    `INSERT INTO gateway.webhooks
       (name, application, display_name, description, path,
        signature_scheme, signature_header, signature_message,
        forward_url, forward_timeout_ms, forward_max_attempts,
        ip_allowlist, event_key_field, event_version_field,
        status, enabled, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
             COALESCE($10,8000), COALESCE($11,8),
             COALESCE($12,'{}'::text[]), COALESCE($13,'slug'), $14,
             COALESCE($15,'draft'), COALESCE($16,TRUE), $17)
     ON CONFLICT (name) DO UPDATE SET
       application=EXCLUDED.application, display_name=EXCLUDED.display_name,
       description=EXCLUDED.description, path=EXCLUDED.path,
       signature_scheme=EXCLUDED.signature_scheme,
       signature_header=EXCLUDED.signature_header,
       signature_message=EXCLUDED.signature_message,
       forward_url=EXCLUDED.forward_url,
       forward_timeout_ms=EXCLUDED.forward_timeout_ms,
       forward_max_attempts=EXCLUDED.forward_max_attempts,
       ip_allowlist=EXCLUDED.ip_allowlist,
       event_key_field=EXCLUDED.event_key_field,
       event_version_field=EXCLUDED.event_version_field,
       status=EXCLUDED.status, enabled=EXCLUDED.enabled,
       updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING *`,
    [
      row.name, row.application || null, row.displayName || null,
      row.description || null, row.path,
      row.signatureScheme || 'hmac_sha256_hex',
      row.signatureHeader || null, row.signatureMessage || null,
      row.forwardUrl || null, row.forwardTimeoutMs || null, row.forwardMaxAttempts || null,
      row.ipAllowlist || null, row.eventKeyField || null, row.eventVersionField || null,
      row.status || null, row.enabled, actor,
    ]
  );

  // Sealed after the row exists, for the same foreign-key reason as a
  // parameter credential: secrets runs on its own connection.
  if (typeof row.plaintext === 'string' && row.plaintext) {
    await secrets.setForWebhook({ webhook: row.name, plaintext: row.plaintext, actor });
  }

  return saved.rows[0];
}

/**
 * Accept a verified payload.
 *
 * Returns {accepted, duplicate, id}. A duplicate is still a success as far as
 * the supplier is concerned — they are retrying something we already have, and
 * answering anything but 200 makes them retry it again.
 */
async function accept({ webhook, eventKey, eventVersion, payload, headers }) {
  return db.transaction(async (client) => {
    // ON CONFLICT DO NOTHING rather than a SELECT then an INSERT: two of their
    // retries can arrive at the same moment, and a check-then-write would let
    // both through. The primary key is what actually decides.
    const seen = await client.query(
      `INSERT INTO gateway.webhook_seen (webhook, event_key, event_version)
       VALUES ($1,$2,COALESCE($3,''))
       ON CONFLICT (webhook, event_key, event_version) DO NOTHING
       RETURNING 1`,
      [webhook, eventKey || '', eventVersion || '']
    );

    if (!seen?.rows?.length) return { accepted: true, duplicate: true, id: null };

    const r = await client.query(
      `INSERT INTO gateway.webhook_deliveries
         (webhook, event_key, event_version, payload, headers)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [webhook, eventKey || null, eventVersion || null,
        JSON.stringify(payload), JSON.stringify(headers || {})]
    );
    return { accepted: true, duplicate: false, id: r.rows[0].id };
  });
}

/** Deliveries due now, oldest first, capped so one backlog cannot starve the rest. */
async function due(limit = 20) {
  const r = await db.query(
    `SELECT d.*, w.forward_url, w.forward_timeout_ms, w.forward_max_attempts
       FROM gateway.webhook_deliveries d
       JOIN gateway.webhooks w ON w.name = d.webhook
      WHERE d.state = 'pending' AND d.next_attempt_at <= now()
        AND w.forward_url IS NOT NULL
      ORDER BY d.received_at
      LIMIT $1`,
    [limit]
  );
  return r?.rows || [];
}

/** The internal application took it. The row has done its job. */
async function delivered(id) {
  await db.query(`DELETE FROM gateway.webhook_deliveries WHERE id = $1`, [id]);
}

/**
 * It did not go. Back off and try again, or give up and keep the row.
 *
 * Exponential with a ceiling: 2s, 4s, 8s … capped at 10 minutes. The cap
 * matters — without it the eighth attempt is four hours away, and a payload
 * nobody is going to look at for four hours is one nobody will remember.
 */
async function failedAttempt(id, error, maxAttempts) {
  const r = await db.query(
    `UPDATE gateway.webhook_deliveries
        SET attempts = attempts + 1,
            last_error = $2,
            state = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = now() +
              (LEAST(power(2, attempts + 1)::int, 600) || ' seconds')::interval
      WHERE id = $1
      RETURNING attempts, state`,
    [id, String(error || '').slice(0, 500), maxAttempts || 8]
  );
  return r?.rows?.[0] || null;
}

/** Put a failed delivery back in the queue — the button on the screen. */
async function retry(id) {
  const r = await db.query(
    `UPDATE gateway.webhook_deliveries
        SET state = 'pending', next_attempt_at = now(), attempts = 0, last_error = NULL
      WHERE id = $1 RETURNING id`,
    [id]
  );
  return Boolean(r?.rows?.length);
}

async function stuck(limit = 50) {
  const r = await db.query(
    `SELECT id, webhook, event_key, received_at, attempts, last_error, state
       FROM gateway.webhook_deliveries
      WHERE state = 'failed' OR received_at < now() - interval '1 hour'
      ORDER BY received_at LIMIT $1`,
    [limit]
  );
  return r?.rows || [];
}

/**
 * Record what arrived, including what was turned away.
 *
 * Without this a supplier signing with the wrong key is invisible: they see
 * failures, we see nothing, and the conversation starts with "your webhook is
 * broken" and no way to check. No payload is kept.
 */
async function log({ webhook, path, sourceIp, status, outcome, eventKey, bytes, detail }) {
  await db.query(
    `INSERT INTO gateway.webhook_log
       (webhook, path, source_ip, status, outcome, event_key, bytes, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [webhook || null, path, sourceIp || null, status, outcome,
      eventKey || null, bytes || null, detail ? String(detail).slice(0, 500) : null]
  ).catch(() => {});
}

async function recentCalls(webhook = null, limit = 100) {
  const r = await db.query(
    `SELECT * FROM gateway.webhook_log
      WHERE ($1::text IS NULL OR webhook = $1)
      ORDER BY occurred_at DESC LIMIT $2`,
    [webhook, limit]
  );
  return r?.rows || [];
}

/**
 * Forget events older than the retention window.
 *
 * The window has to be comfortably longer than the supplier's own retry
 * schedule — FlipitMoney give up after about a minute — or a late retry would
 * be treated as a new event and delivered twice. Thirty days is generous and
 * the table holds no payload, so it stays small.
 */
async function pruneSeen(days = 30) {
  const r = await db.query(
    `DELETE FROM gateway.webhook_seen WHERE seen_at < now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return r?.rowCount || 0;
}

/**
 * Forget old call records.
 *
 * webhook_log gets a row per inbound call including the refused ones, so on a
 * busy feed it is the fastest-growing table in the schema and would otherwise
 * grow without limit. It holds no payload, so a generous window is cheap —
 * but a window there must be, or the first anyone hears of it is a full disk.
 */
async function pruneLog(days = 90) {
  const r = await db.query(
    `DELETE FROM gateway.webhook_log WHERE occurred_at < now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return r?.rowCount || 0;
}

module.exports = {
  list, routable, byName, credentialStatus, save,
  accept, due, delivered, failedAttempt, retry, stuck,
  log, recentCalls, pruneSeen, pruneLog,
};
