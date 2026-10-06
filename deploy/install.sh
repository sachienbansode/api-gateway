#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# First-time install on an Azure Ubuntu/Debian VM. Run as root.
#
#   sudo bash deploy/install.sh
#
# Idempotent: safe to re-run. It does NOT write your secrets — it creates the
# env file with the right ownership and permissions and leaves you to fill it.
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR=/opt/vendor-api-wrapper
CFG_DIR=/etc/vendor-api-wrapper
LOG_DIR=/var/log/vendor-api-wrapper
STATE_DIR=/var/lib/vendor-api-wrapper
SVC=vendor-api-wrapper
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Installing Node.js 22 if absent"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> Creating service account"
id -u apigw >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin apigw

echo "==> Laying out directories"
mkdir -p "$APP_DIR" "$CFG_DIR" "$LOG_DIR" "$STATE_DIR"

echo "==> Copying application"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude .env --exclude test \
  "$SRC_DIR"/ "$APP_DIR"/

echo "==> Installing production dependencies"
cd "$APP_DIR"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev --no-audit --no-fund

echo "==> Permissions"
# The app only ever reads its code and config. It never needs write access.
chown -R root:apigw "$APP_DIR"
chmod -R u=rwX,g=rX,o= "$APP_DIR"
chown -R apigw:apigw "$LOG_DIR" "$STATE_DIR"
chmod 0750 "$LOG_DIR" "$STATE_DIR"

echo "==> Azure Postgres root certificate"
# Verifying the database TLS certificate properly beats trusting the VM's CA
# bundle, and beats DB_SSL_INSECURE by a mile.
if [[ ! -f "$CFG_DIR/azure-root.pem" ]]; then
  curl -fsSL -o "$CFG_DIR/azure-root.pem" \
    https://dl.cacerts.digicert.com/DigiCertGlobalRootCA.crt.pem \
    && echo "    Downloaded. Set DB_CA_CERT_PATH=$CFG_DIR/azure-root.pem in the env file." \
    || echo "    ! Could not download it. Fetch it manually, or set DB_SSL_INSECURE=true as a stopgap."
  chmod 0644 "$CFG_DIR/azure-root.pem" 2>/dev/null || true
fi

echo "==> Secrets file"
if [[ ! -f "$CFG_DIR/env" ]]; then
  cp "$SRC_DIR/.env.example" "$CFG_DIR/env"
  echo "    Created $CFG_DIR/env from the template — EDIT IT before starting."
fi
chown root:apigw "$CFG_DIR/env"
chmod 0640 "$CFG_DIR/env"

echo "==> systemd unit"
install -m 0644 "$SRC_DIR/deploy/$SVC.service" "/etc/systemd/system/$SVC.service"
systemctl daemon-reload
systemctl enable "$SVC"

echo "==> housekeeping cron"
install -m 0644 "$SRC_DIR/deploy/$SVC.cron" "/etc/cron.d/$SVC"

RUN="cd $APP_DIR && set -a && . $CFG_DIR/env && set +a &&"

cat <<EOF

──────────────────────────────────────────────────────────────────────────────
 Installed. Remaining steps, in order:

 1. Fill in secrets — DATABASE_URL, upstream credentials, TLS cert path:
      sudoedit $CFG_DIR/env

    For Azure Postgres the URL looks like:
      postgresql://gwadmin:PASS@YOURSERVER.postgres.database.azure.com:5432/gateway
    and remember to add a firewall rule on the Postgres server allowing this
    VM's IP, or the connection will simply time out.

 2. Point config/upstreams.yaml at your real internal hosts, and declare your
    endpoints in config/endpoints.yaml:
      sudoedit $APP_DIR/config/upstreams.yaml
      sudoedit $APP_DIR/config/endpoints.yaml

 3. Validate — catches typos, missing credentials and bad whitelists, and
    prints the exposure report, without touching production:
      $RUN npm run validate

 4. Create the schema, as the OWNER role, then verify the privilege boundary.
    Supply the owner credential here — it should NOT live in the env file:
      cd $APP_DIR && set -a && . $CFG_DIR/env && set +a && \
        MIGRATION_DATABASE_URL='postgresql://gw_owner:PW@HOST:5432/gateway?sslmode=require' \
        npm run migrate
      $RUN node scripts/gw.js migrate:status
      $RUN node scripts/gw.js db:check      # 15 checks, all must pass

 5. Import your vendors, then issue a key:
      $RUN node scripts/gw.js vendor:seed
      $RUN node scripts/gw.js key:issue acme
    The key prints ONCE. Send it to the vendor over a channel you trust.

 6. Start it:
      sudo systemctl start $SVC
      sudo systemctl status $SVC
      journalctl -u $SVC -f
      curl -s localhost:8080/readyz | jq

 7. nginx + TLS:
      sudo cp $SRC_DIR/deploy/nginx.conf /etc/nginx/sites-available/$SVC
      sudo ln -sf /etc/nginx/sites-available/$SVC /etc/nginx/sites-enabled/
      # edit the server_name, then:
      sudo certbot --nginx -d partner-api.yourdomain.com
      sudo nginx -t && sudo systemctl reload nginx

 8. Azure NSG: allow 443 inbound ONLY from your vendor's egress IPs.
    Everything else inbound denied. This is the strongest single control you
    have — a leaked key is useless from any other address.

 Day to day:
      node scripts/gw.js usage              traffic, errors, latency, quota
      node scripts/gw.js audit:trace <id>   one request, by the id the vendor quotes
      node scripts/gw.js key:revoke ...     revoke a key (~30s to take effect)
──────────────────────────────────────────────────────────────────────────────
EOF
