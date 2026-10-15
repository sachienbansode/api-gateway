'use strict';

const adminDb = require('../adminPool');

/**
 * Every email this gateway sends, in the platform's shared log.
 *
 * Ported from the OFS app's lib/emailLog.js, which was itself ported from
 * omnenest-uploader-api (REUSE.md §3). The rule there is explicit and applies
 * here for the same reason: every send in the platform is captured in one
 * table, so Admin → Email & OTP Logs answers "did that code actually go out,
 * and when" for the whole estate rather than for three applications out of
 * four. A gateway that kept its own private mail log would be the one nobody
 * thinks to check.
 *
 * `purpose` doubles as the type. OFS adds ofs_allotment and ofs_bid_otp; this
 * adds pravah_login_otp.
 *
 * ON THE READ-ONLY CLAIM
 *
 * src/db/adminPool.js says this connection reads and never writes. That was
 * true when written and is now too broad: this file appends to email_logs.
 * The precise statement is that the gateway never writes IDENTITY — no user,
 * no role, no grant — so a gateway compromise cannot become a way to grant
 * yourself access to the platform. Appending to a log is a different act from
 * changing who may do what, and the log is the thing an auditor reads.
 *
 * A failure here is swallowed. Mail that was sent but not logged is bad;
 * mail that was not sent because the logging failed is worse.
 */

let ready = false;

/**
 * The platform owns this table and creates it. We ensure it exists only so a
 * fresh environment does not lose the first send, and never alter a column the
 * platform owns.
 */
async function ensure() {
  if (ready) return;
  await adminDb
    .query(
      `CREATE TABLE IF NOT EXISTS ${adminDb.T('email_logs')} (
        id            BIGSERIAL PRIMARY KEY,
        purpose       VARCHAR(40),
        to_email      VARCHAR(255),
        user_id       INTEGER,
        subject       TEXT,
        status        VARCHAR(12),
        accepted      TEXT,
        rejected      TEXT,
        message_id    TEXT,
        smtp_response TEXT,
        error_text    TEXT,
        ip_address    VARCHAR(64),
        triggered_by  VARCHAR(255),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    )
    .catch(() => {});
  ready = true;
}

async function log(d) {
  try {
    if (!adminDb.isEnabled()) return;
    await ensure();
    await adminDb.query(
      `INSERT INTO ${adminDb.T('email_logs')}
         (purpose, to_email, user_id, subject, status, accepted, rejected,
          message_id, smtp_response, error_text, ip_address, triggered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        d.purpose || null, d.to_email || null, d.user_id || null, d.subject || null,
        d.status || null, d.accepted || null, d.rejected || null, d.message_id || null,
        d.smtp_response || null, d.error_text || null, d.ip_address || null,
        d.triggered_by || null,
      ]
    );
  } catch (err) {
    // Never break a send. The console log is the fallback record.
    console.error('[emaillog]', err.message);
  }
}

/** Log straight from a nodemailer sendMail() result. */
async function fromInfo(base, info) {
  await log({
    ...base,
    status: 'sent',
    accepted: ((info && info.accepted) || []).join(', '),
    rejected: ((info && info.rejected) || []).join(', '),
    message_id: (info && info.messageId) || null,
    smtp_response: (info && info.response) || null,
  });
}

module.exports = { log, fromInfo, ensure };
