'use strict';

/**
 * Brute-force limiter for the login form.
 *
 * bcrypt already makes guessing slow, but slow is not the same as bounded: an
 * attacker with the login URL and a password list can still work through it
 * indefinitely, and each attempt costs the gateway ~100ms of CPU. This caps
 * attempts per IP and, separately, per email.
 *
 * Per-email matters as much as per-IP. Without it, a distributed attempt
 * against one known administrator account never trips a per-IP limit.
 *
 * In memory, per instance. With two instances an attacker gets two buckets —
 * acceptable for a surface that is already IP-restricted at the NSG, and far
 * better than nothing. Lock-out state deliberately does not live in the
 * database: a login path that needs the database to say no would fail open
 * when the database is unavailable.
 */

const WINDOW_MS = Number(process.env.ADMIN_LOGIN_WINDOW_MS || 15 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.ADMIN_LOGIN_MAX_ATTEMPTS || 10);

/** key -> number[] of failure timestamps */
const failures = new Map();

function prune(list, now) {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < list.length && list[i] < cutoff) i++;
  return i === 0 ? list : list.slice(i);
}

/**
 * @returns {{blocked:boolean, retryAfter:number}} retryAfter in seconds
 */
function check(keys, now = Date.now()) {
  for (const key of keys) {
    const list = prune(failures.get(key) || [], now);
    if (list.length === 0) {
      failures.delete(key);
      continue;
    }
    failures.set(key, list);
    if (list.length >= MAX_ATTEMPTS) {
      const retryAfter = Math.max(1, Math.ceil((list[0] + WINDOW_MS - now) / 1000));
      return { blocked: true, retryAfter };
    }
  }
  return { blocked: false, retryAfter: 0 };
}

function recordFailure(keys, now = Date.now()) {
  for (const key of keys) {
    const list = prune(failures.get(key) || [], now);
    list.push(now);
    failures.set(key, list);
  }
}

/** A successful login clears that identity's counters. */
function recordSuccess(keys) {
  for (const key of keys) failures.delete(key);
}

function reset() {
  failures.clear();
}

module.exports = { check, recordFailure, recordSuccess, reset, WINDOW_MS, MAX_ATTEMPTS };
