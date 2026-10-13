/**
 * PM2 process definition for the Pravah API Gateway.
 *
 * Matches the convention the other apps on this box already use, rather than
 * a systemd unit with its own sandboxing rules to debug.
 *
 * Secrets are NOT here. They stay in /etc/api-gateway/env, which this file
 * loads at start time — so the repo never carries a credential, and rotating
 * one does not need a commit.
 */

const fs = require('fs');

const ENV_FILE = process.env.GATEWAY_ENV_FILE || '/etc/api-gateway/env';

/**
 * Read the env file the way systemd's EnvironmentFile does.
 *
 * Deliberately not `require('dotenv')` and definitely not `source`: bash would
 * expand `$2a$12$...` in a bcrypt hash into positional parameters and silently
 * corrupt it, and sourcing executes whatever is in the file.
 */
function loadEnv(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Fail loudly. A gateway that boots without its upstream credentials is
    // worse than one that refuses to start.
    throw new Error(`cannot read ${file}: ${err.message}`);
  }

  for (let line of raw.split('\n')) {
    line = line.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(i + 1);
    if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') val = val.slice(1, -1);
    else if (val.length >= 2 && val[0] === "'" && val[val.length - 1] === "'") val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

module.exports = {
  apps: [
    {
      name: 'api-gateway',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',

      env: Object.assign({ NODE_ENV: 'production' }, loadEnv(ENV_FILE)),

      autorestart: true,
      // Give up after 10 fast restarts rather than crash-looping silently.
      max_restarts: 10,
      min_uptime: '20s',
      restart_delay: 2000,

      // The gateway's measured peak is well under 200MB. Well above that means
      // a leak, and a restart is better than an OOM kill mid-request.
      max_memory_restart: '600M',

      error_file: '/var/log/api-gateway/error.log',
      out_file: '/var/log/api-gateway/out.log',
      merge_logs: true,
      time: true,

      // Match the app's own graceful shutdown, measured at ~1.7s.
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
  ],
};
