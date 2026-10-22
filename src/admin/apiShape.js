'use strict';

/**
 * What kind of API is this, and what follows from that?
 *
 * The Studio already makes one real call in step 1. That response answers
 * almost every question worth asking about a supplier API — whether it
 * returns a list or a record, whether it is JSON at all, whether it is slow
 * enough to time out a consumer, whether a retry would do something twice.
 *
 * So nothing here is asked. A dropdown saying "select API type" would make
 * somebody classify an API they have not read yet, and then be wrong in a way
 * nothing later contradicts. This reads the evidence instead.
 *
 * EVERY FINDING IS AN OBSERVATION PLUS ITS CONSEQUENCE. "Returns an array" is
 * a label and helps nobody; "the fields you tick apply to every item, and the
 * consumer receives one object per account" is a thing you can act on. A note
 * that does not change what the reader does next does not belong here — it is
 * decoration, and decoration is what makes people stop reading the panel.
 *
 * Pure, and deliberately so: no DOM, no database, no network. It takes the
 * test result it is given and returns findings, which is what makes it
 * testable against the shapes that actually caused trouble.
 */

const SLOW_MS = 5000;
const BIG_BYTES = 1024 * 1024;

/** level: 'stop' blocks sensible progress, 'warn' needs a decision, 'info' informs. */
function note(level, title, text) {
  return { level, title, text };
}

/**
 * @param {object} result   what callUpstream returned
 * @param {Array}  described [{path, type, sample}] from describe()
 * @param {object} opts     { method, authType, timeoutMs }
 */
function classify(result = {}, described = [], opts = {}) {
  const findings = [];
  const method = String(opts.method || 'GET').toUpperCase();
  const writes = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const body = result.body;

  // -- Did the call even work? Everything below is guesswork if not. --------
  if (result.error && result.body === undefined) {
    return {
      kind: 'Not known yet',
      summary: 'The supplier did not answer, so there is nothing to learn from yet.',
      findings: [note('stop', 'The test did not succeed',
        'Fix step 1 first. Nothing below this point can be worked out without a ' +
        'response to read.')],
    };
  }
  if (typeof result.status === 'number' && (result.status < 200 || result.status >= 300)) {
    findings.push(note('warn', `The supplier answered ${result.status}`,
      'This is an error response, so the fields below describe the error, not the data. ' +
      'Get a successful call before choosing what to expose.'));
  }

  // -- JSON, or not? The single most consequential fact. --------------------
  const isJson = body !== null && body !== undefined;
  let kind;
  let summary;

  if (!isJson) {
    kind = 'Not JSON';
    summary = 'The supplier answered with something other than JSON.';
    findings.push(note('stop', 'Field-by-field filtering is not possible here',
      'The whitelist works by building a JSON object field by field. There are no ' +
      'fields to build from in a plain-text, XML or CSV response, so this endpoint ' +
      'cannot be filtered that way — whatever the supplier sends is what a consumer ' +
      'would get. Common with SMS and payment gateways, which answer with a status ' +
      'line rather than a document.'));
    if (result.parseError) {
      findings.push(note('info', 'What the parser said', String(result.parseError)));
    }
  } else if (Array.isArray(body)) {
    kind = `A list of ${body.length} item(s), at the top level`;
    summary = 'The whole response is a list — there is no wrapper object around it.';
    findings.push(note('info', 'The fields below apply to every item',
      'Tick a field once and the consumer receives it for each item in the list, not once.'));
    if (body.length === 0) {
      findings.push(note('warn', 'The list came back empty',
        'An empty list has no fields to discover. Call it with parameters that return ' +
        'at least one row, or you will be choosing from a list of nothing.'));
    }
  } else if (typeof body === 'object') {
    const arrayKeys = Object.keys(body).filter((k) => Array.isArray(body[k]));
    const recordKey = arrayKeys.find((k) => body[k].length && typeof body[k][0] === 'object');

    if (recordKey) {
      const n = body[recordKey].length;
      kind = `A list of ${n} record(s) under "${recordKey}"`;
      summary = `The data is in ${recordKey}[]; the rest of the response wraps it.`;
      findings.push(note('info', `The fields under ${recordKey}[] repeat`,
        `Ticking one gives the consumer that field for each of the ${n} item(s), not once. ` +
        'Fields outside it are returned once for the whole response.'));
      if (n === 1) {
        findings.push(note('warn', 'Only one item came back',
          'A one-item list looks exactly like a single record until the day it does not. ' +
          'Check with a call that returns several before deciding the shape.'));
      }
    } else if (arrayKeys.length && !recordKey) {
      kind = 'A record with an empty list in it';
      summary = `"${arrayKeys[0]}" is a list but came back empty, so its fields are unknown.`;
      findings.push(note('warn', 'Part of the response could not be read',
        `Nothing can be discovered inside ${arrayKeys[0]}[] while it is empty. Call it ` +
        'with parameters that fill it, or those fields will be missing from the whitelist.'));
    } else {
      kind = 'A single record';
      summary = 'One object, no repeating list.';
    }

    const keys = Object.keys(body).map((k) => k.toLowerCase());
    if (keys.some((k) => /^(page|pageno|pagenumber|offset|skip|nextpage|cursor)$/.test(k)) ||
        keys.some((k) => /^(total|totalcount|totalrecords|totalpages)$/.test(k))) {
      findings.push(note('warn', 'This response is paged',
        'The supplier is returning one page at a time. Expose the paging fields and ' +
        'allow the page parameter through, or consumers will silently receive only the ' +
        'first page and believe it is everything.'));
    }
  } else {
    kind = 'A single value';
    summary = 'The response is a bare value rather than an object.';
  }

  // -- Does calling it twice do something twice? ----------------------------
  if (writes) {
    findings.push(note('warn', `${method} — this changes something`,
      'A consumer that times out and retries would do it a second time. Turn on ' +
      'idempotency in step 2 so a repeated call with the same key returns the first ' +
      'result instead of acting again. This matters most where the side effect costs ' +
      'money or is visible to a customer — an SMS, a payment, an order.'));
  }

  // -- Will a consumer experience what you just experienced? ----------------
  const limit = Number(opts.timeoutMs) || 0;
  if (result.truncated) {
    findings.push(note('warn', 'The response is larger than this preview reads',
      'Only the first part was read here. The endpoint itself is not limited, but a ' +
      'response this size needs a timeout to match — and a consumer gets the whole thing.'));
  } else if (typeof result.bytes === 'number' && result.bytes > BIG_BYTES) {
    findings.push(note('info', `${(result.bytes / 1048576).toFixed(1)} MB in one response`,
      'Large enough that the timeout and the consumer\'s own client both matter. Consider ' +
      'whether a narrower or paged variant exists.'));
  }
  if (typeof result.ms === 'number' && result.ms >= SLOW_MS) {
    findings.push(note('warn', `Took ${result.ms} ms`,
      limit && result.ms > limit * 0.75
        ? `That is close to this supplier's ${limit} ms timeout. A consumer calling this ` +
          'would fail the same way — raise the timeout in step 1.'
        : 'Slow enough that a consumer will notice. Check the timeout is comfortably above it.'));
  }

  // -- Where does our credential travel? ------------------------------------
  if (String(opts.authType || '') === 'query') {
    findings.push(note('warn', 'The credential travels in the URL',
      'Query strings are written to access logs, proxy logs and browser history at the ' +
      'far end. The consumer never sees it — but the supplier logs it. Prefer a header ' +
      'if they accept one.'));
  }

  // -- Fields that always held the same value -------------------------------
  //
  // Weak evidence from one sample, and stated as such. It still catches the
  // thing nobody catches by reading names: a supplier returning the same
  // value under two labels, both of which then get exposed forever.
  const dup = duplicateSamples(described);
  for (const group of dup.slice(0, 3)) {
    findings.push(note('info', `${group.paths.join(' and ')} held the same value`,
      `Both were "${group.sample}" in this response. Worth checking whether consumers ` +
      'need both, or whether one of them is the supplier repeating itself.'));
  }

  return { kind, summary, findings };
}

/** Leaf fields that shared a value in this one sample. */
function duplicateSamples(described) {
  const byValue = new Map();
  for (const d of described || []) {
    const v = d.sample;
    // Null, empty and short flags coincide constantly and mean nothing.
    if (v === null || v === undefined || v === '' || String(v).length < 4) continue;
    if (!byValue.has(v)) byValue.set(v, []);
    byValue.get(v).push(d.path);
  }
  const out = [];
  for (const [sample, paths] of byValue) {
    if (paths.length > 1) out.push({ sample, paths });
  }
  return out;
}

module.exports = { classify, duplicateSamples, SLOW_MS, BIG_BYTES };
