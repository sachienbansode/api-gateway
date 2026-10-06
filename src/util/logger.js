'use strict';

const pino = require('pino');

const dest =
  process.env.AUDIT_LOG && process.env.AUDIT_LOG !== 'stdout'
    ? pino.destination({ dest: process.env.AUDIT_LOG, sync: false, mkdir: true })
    : undefined;

/**
 * Keys that must never reach a log line, at any nesting depth.
 * Audit logs get shipped, grepped and pasted into tickets; a credential in
 * one is a credential leaked.
 */
const REDACT = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'headers["x-api-key"]',
  '*.password',
  '*.secret',
  '*.token',
  '*.apiKey',
  '*.api_key',
];

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    redact: { paths: REDACT, censor: '[redacted]' },
    base: { svc: 'vendor-api-wrapper' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  dest
);

module.exports = logger;
