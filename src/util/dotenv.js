'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal .env loader. Existing environment variables always win, so systemd
 * EnvironmentFile or a container's injected env overrides the file.
 */
function load(file = path.join(__dirname, '..', '..', '.env')) {
  if (!fs.existsSync(file)) return;

  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

module.exports = { load };
