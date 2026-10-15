#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# TLS for pravah.ashikagroup.com, end to end, idempotent.
#
#   sudo /var/apps/api-gateway/deploy/ssl-setup.sh
#
# Safe to re-run: it skips the certificate step if a valid one is already
# there, and every nginx change is tested before it is applied.
#
# What it does NOT do: restrict /admin by IP. That was removed deliberately —
# the portal is public, per-vendor IP allowlists live in the database and are
# enforced by the application, where one vendor can be pinned without
# affecting another. If an `allow`/`deny` pair is still in the file on this
# machine, it came from an older copy; step 1 replaces the file wholesale.
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${DOMAIN:-pravah.ashikagroup.com}"
EMAIL="${EMAIL:-treeantstechnologies@gmail.com}"
APP_DIR="/var/apps/api-gateway"
SITE="/etc/nginx/sites-available/api-gateway"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run this with sudo"
[ -d "$APP_DIR" ]    || fail "$APP_DIR is not there — is this the right machine?"

# --- 0. sanity ------------------------------------------------------------
say "Checking the basics"
command -v nginx >/dev/null || fail "nginx is not installed"
systemctl is-active --quiet nginx || say "nginx is not running yet (fine, we start it below)"

RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
MYIP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
echo "    $DOMAIN resolves to: ${RESOLVED:-NOTHING}"
echo "    this machine's public IP: ${MYIP:-unknown}"
[ -n "$RESOLVED" ] || fail "$DOMAIN does not resolve. Fix DNS first — Let's Encrypt has to reach it."
if [ -n "$MYIP" ] && [ "$RESOLVED" != "$MYIP" ]; then
  echo "    WARNING: DNS points somewhere other than this machine."
  echo "             The certificate request will fail unless that is a proxy you control."
fi

# --- 1. port 80 that answers ---------------------------------------------
say "Step 1 — installing the HTTP-only config so port 80 answers"
install -d -m 755 /var/www/html/.well-known/acme-challenge
cp "$APP_DIR/deploy/nginx-bootstrap.conf" "$SITE"
ln -sf "$SITE" /etc/nginx/sites-enabled/api-gateway
rm -f /etc/nginx/sites-enabled/default
nginx -t || fail "the bootstrap config did not pass nginx -t (output above)"
systemctl reload nginx 2>/dev/null || systemctl start nginx
echo "ok" > /var/www/html/.well-known/acme-challenge/selftest
if curl -fsS --max-time 10 "http://$DOMAIN/.well-known/acme-challenge/selftest" | grep -q ok; then
  echo "    the challenge path is reachable from the internet"
else
  rm -f /var/www/html/.well-known/acme-challenge/selftest
  fail "http://$DOMAIN/.well-known/acme-challenge/ is not reachable.
     Open port 80 to Any in the Azure NSG (Let's Encrypt validates from many
     addresses, so it cannot be restricted to a known IP), then run this again."
fi
rm -f /var/www/html/.well-known/acme-challenge/selftest

# --- 2. the certificate ---------------------------------------------------
say "Step 2 — the certificate"
if [ -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ] \
   && openssl x509 -checkend 2592000 -noout -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" >/dev/null 2>&1; then
  echo "    a certificate is already there and is good for more than 30 days — skipping"
else
  command -v certbot >/dev/null || { apt-get update -qq && apt-get install -y -qq certbot; }
  certbot certonly --webroot -w /var/www/html \
    -d "$DOMAIN" --email "$EMAIL" --agree-tos --no-eff-email --non-interactive \
    || fail "certbot could not issue the certificate (its own message is above)"
fi
[ -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ] || fail "no certificate on disk after certbot ran"

# --- 3. the real config ---------------------------------------------------
say "Step 3 — switching to the TLS config"
cp "$APP_DIR/deploy/nginx.conf" "$SITE"
nginx -t || fail "the TLS config did not pass nginx -t (output above). Port 80 is still serving."
systemctl reload nginx

# --- 4. renewal -----------------------------------------------------------
say "Step 4 — renewal"
# certbot's own timer does the renewing; nginx needs a nudge afterwards or it
# keeps serving the old certificate from memory until something else reloads it.
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/bin/sh
systemctl reload nginx
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
systemctl enable --now certbot.timer >/dev/null 2>&1 || true
certbot renew --dry-run >/dev/null 2>&1 && echo "    renewal dry run passed" \
  || echo "    WARNING: the renewal dry run did not pass — check 'certbot renew --dry-run'"

# --- 5. prove it ----------------------------------------------------------
say "Step 5 — proving it works"
echo -n "    https://$DOMAIN/healthz  -> "; curl -fsS -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/healthz" || echo "FAILED"
echo -n "    https://$DOMAIN/admin/login -> "; curl -fsS -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/admin/login" || echo "FAILED"
echo -n "    http redirect            -> "; curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://$DOMAIN/admin/login"
echo -n "    certificate expires      : "; openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" | cut -d= -f2

say "Done — https://$DOMAIN/admin/login"
