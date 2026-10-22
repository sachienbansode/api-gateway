'use strict';

const express = require('express');
const { verifySignature, ipAllowed, normaliseIp, WebhookError } = require('./webhook');

/**
 * The inbound side: suppliers calling us.
 *
 * Mounted at /hooks, and PUBLIC — no API key, because the caller is a supplier
 * and has none. The signature is the whole of the authentication, with the
 * optional IP allowlist alongside it.
 *
 * FOUR THINGS THIS DOES THAT A NAIVE VERSION WOULD NOT
 *
 * 1. Keeps the raw bytes. An HMAC is over bytes, and express.json() throws the
 *    original away. Parsing and re-serialising changes key order and spacing,
 *    so a verifier built on the parsed object rejects every genuine call.
 *
 * 2. Answers 200 the moment the payload is written down, not when the internal
 *    application has taken it. FlipitMoney retry three times over about a
 *    minute and then the news is gone; the answer must not wait on anything
 *    that can be restarted.
 *
 * 3. Answers 200 to a REPEAT as well. They retry on any non-2xx, so returning
 *    409 for something we already hold would have them send it again, and
 *    again, and then give up — having successfully delivered it the first
 *    time. A duplicate is a success.
 *
 * 4. Says almost nothing in its responses. An error that distinguishes "no
 *    such webhook" from "wrong signature" tells someone probing which paths
 *    are real. The detail goes to webhook_log, where it is useful, rather than
 *    to the caller, where it is a gift.
 */

const MAX_BODY = '1mb';

function buildWebhookRouter({ repo, secrets, logger, onAccepted }) {
  const r = express.Router();

  // The raw body, kept. `verify` runs before any parsing, which is the only
  // point at which the original bytes still exist.
  r.use(express.json({
    limit: MAX_BODY,
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

  // A body that is not JSON must not become a 500 from the parser. It is a
  // 400 with a reason, recorded like any other turned-away call.
  r.use((err, req, res, next) => {
    if (!err) return next();
    const status = err.type === 'entity.too.large' ? 413 : 400;
    repo.log({
      path: req.path, sourceIp: normaliseIp(req.ip), status,
      outcome: 'malformed', bytes: req.rawBody?.length || null,
      detail: err.message,
    });
    return res.status(status).json({ error: 'the body could not be read' });
  });

  // Express 4 path syntax. `/*splat` is Express 5 and matches NOTHING here —
  // every call would 404 with the framework's own HTML page, which is exactly
  // what a webhook nobody is calling also looks like.
  r.all('/*', async (req, res) => {
    const path = req.path;
    const sourceIp = normaliseIp(req.ip);
    const bytes = req.rawBody?.length || 0;
    let hook = null;

    const turnAway = (status, outcome, detail) => {
      repo.log({ webhook: hook?.name, path, sourceIp, status, outcome, bytes, detail });
      logger?.warn?.({ path, sourceIp, outcome, detail }, 'webhook call turned away');
      // One shape for every refusal, so the response itself distinguishes
      // nothing. 404 and 401 still differ because the supplier needs to tell
      // "wrong address" from "wrong key" — but neither says more than that.
      return res.status(status).json({ error: status === 404 ? 'not found' : 'rejected' });
    };

    try {
      const all = await repo.routable();
      hook = all.find((h) => h.path === path) || null;

      if (!hook) return turnAway(404, 'unknown_hook', 'no live webhook on this path');
      if (req.method !== 'POST') {
        return turnAway(405, 'malformed', `method ${req.method}`);
      }
      if (!ipAllowed(hook.ip_allowlist, sourceIp)) {
        return turnAway(403, 'ip_blocked', `source ${sourceIp} is not on the allowlist`);
      }

      const secret = hook.signature_scheme === 'none'
        ? null
        : await secrets.resolveForWebhook(hook.name).catch(() => null);

      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;

      verifySignature(hook, {
        rawBody: req.rawBody ? req.rawBody.toString('utf8') : '',
        parsed: req.body,
        headers,
        secret,
      });

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const eventKey = hook.event_key_field ? body[hook.event_key_field] : null;
      const eventVersion = hook.event_version_field ? body[hook.event_version_field] : null;

      const result = await repo.accept({
        webhook: hook.name,
        eventKey: eventKey === undefined || eventKey === null ? null : String(eventKey),
        eventVersion: eventVersion === undefined || eventVersion === null
          ? null : String(eventVersion),
        payload: body,
        // Only what identifies the call. Their signature header and content
        // type are useful when something is wrong; the rest is noise, and
        // some of it would be a credential.
        headers: {
          'content-type': headers['content-type'] || null,
          'user-agent': headers['user-agent'] || null,
        },
      });

      repo.log({
        webhook: hook.name, path, sourceIp, status: 200,
        outcome: result.duplicate ? 'duplicate' : 'accepted',
        eventKey: eventKey ? String(eventKey) : null, bytes,
      });

      if (!result.duplicate && typeof onAccepted === 'function') {
        // Nudge the forwarder, but never wait on it. The supplier's answer
        // depends on the payload being written down, and on nothing else.
        setImmediate(() => { try { onAccepted(); } catch { /* ignore */ } });
      }

      logger?.info?.(
        { webhook: hook.name, eventKey, duplicate: result.duplicate, bytes },
        result.duplicate ? 'webhook repeat accepted' : 'webhook accepted'
      );

      // 200 for both. They retry on any non-2xx, so telling them a repeat is
      // a conflict makes them send it again.
      return res.status(200).json({ received: true, duplicate: result.duplicate });
    } catch (err) {
      if (err instanceof WebhookError) {
        return turnAway(err.status, err.outcome, err.message);
      }
      // Something of ours broke. A 500 is right: it is not their fault, and it
      // is the one case where we WANT them to retry.
      logger?.error?.({ path, err: err?.message }, 'webhook handler failed');
      repo.log({
        webhook: hook?.name, path, sourceIp, status: 500, outcome: 'error',
        bytes, detail: err?.message,
      });
      return res.status(500).json({ error: 'the request could not be completed' });
    }
  });

  return r;
}

module.exports = { buildWebhookRouter };
