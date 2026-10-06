'use strict';

const crypto = require('crypto');

/**
 * Assign every request an id we generate ourselves.
 *
 * Deliberately NOT read from a vendor-supplied header: a vendor could then
 * collide or forge ids and make your audit trail useless as evidence. The id we
 * generate goes into the audit log, into the error body the vendor sees, and
 * into the X-Gateway-Request-Id header we send upstream — so one id ties the
 * vendor's complaint to your log line to your internal service's log line.
 */
module.exports = function requestId(req, res, next) {
  req.requestId = crypto.randomUUID();
  req.startedAt = process.hrtime.bigint();
  res.set('X-Request-Id', req.requestId);
  next();
};
