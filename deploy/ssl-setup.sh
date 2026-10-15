#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# TLS for pravah.ashikagroup.com, end to end, idempotent.
#
#   sudo /var/apps/api-gateway/deploy/ssl-setup.sh
#
# ⚠ THIS SERVER IS SHARED with the OFS application, which already owns port 80
#   for its own host names. This script is written for that:
#
#     * it only ever touches /etc/nginx/sites-{available,enabled}/api-gateway
#     * it never removes `default` or any other site
#     * our server blocks match by NAME only — no default_server, no bare IP,
#       no `_` — so a request for any other host still reaches OFS
#     * the ACME webroot is /var/www/pravah-acme, not the shared /var/www/html
#     * before it changes anything it records what the other sites answer, and
#       after each reload it checks they still answer the same way
#
# Safe to re-run: it skips the certificate if a current one is already there,
# and every nginx change is tested with `nginx -t` before it is applied.
#
# What it does NOT do: restrict /admin by IP. The portal is public by decision;
# per-vendor IP allowlists live in the database and are enforced by the
# application, where one vendor can be pinned without affecting another. If an
# `allow`/`deny` pair is still in the file on this machine it came from an
# older copy — step 2 replaces the file wholesale.
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${DOMAIN:-pravah.ashikagroup.com}"
EMAIL="${EMAIL:-treeantstechnologies@gmail.com}"
APP_DIR="${APP_DIR:-/var/apps/api-gateway}"
SITE_NAME="api-gateway"
SITE="/etc/nginx/sites-available/$SITE_NAME"
WEBROOT="/var/www/pravah-acme"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run this with sudo"
[ -d "$APP_DIR" ]    || fail "$APP_DIR is not there — wrong machine, or the app lives elsewhere"
command -v nginx >/dev/null || fail "nginx is not installed"

# ---------------------------------------------------------------------------
# 0. Look before touching
# ---------------------------------------------------------------------------
say "What is on this machine already"
note "sites enabled:"
ls -1 /etc/nginx/sites-enabled/ 2>/dev/null | sed 's/^/      /' || true
note "server names other sites claim:"
grep -rhE '^\s*server_name' /etc/nginx/sites-enabled/ 2>/dev/null \
  | sed 's/^\s*/      /' | sort -u || true

# A second block claiming our name would make the outcome depend on file order.
CLAIMS="$(grep -rlE "^\s*server_name.*\b${DOMAIN//./\\.}\b" /etc/nginx/sites-enabled/ 2>/dev/null \
          | grep -v "/$SITE_NAME\$" || true)"
[ -z "$CLAIMS" ] || fail "another site also claims $DOMAIN:
     $CLAIMS
     Two blocks with the same server_name means nginx picks whichever it read
     first. Remove the name from that file, then run this again."

# Zone and upstream names are global to the http{} block; a collision is a
# hard nginx failure, and it is better to know now than after the reload.
for n in vendor_ip vendor_conn admin_ip vendor_wrapper pravah_app_boot; do
  HIT="$(grep -rlE "(zone=$n[: ]|upstream\s+$n\s)" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null \
         | grep -v "/$SITE_NAME\$" || true)"
  [ -z "$HIT" ] || fail "the name '$n' is already used by: $HIT
     Rename it in deploy/nginx.conf before continuing."
done

# Record how the other sites answer now, so we can prove we did not break them.
OTHERS="$(ls -1 /etc/nginx/sites-enabled/ 2>/dev/null | grep -v "^$SITE_NAME\$" || true)"
BEFORE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/ || echo '---')"
note "the default host on 127.0.0.1:80 currently answers: $BEFORE"

RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
MYIP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
note "$DOMAIN resolves to: ${RESOLVED:-NOTHING}"
note "this machine's public IP: ${MYIP:-unknown}"
[ -n "$RESOLVED" ] || fail "$DOMAIN does not resolve — Let's Encrypt has to reach it by name"
if [ -n "$MYIP" ] && [ "$RESOLVED" != "$MYIP" ]; then
  note "WARNING: DNS points somewhere other than this machine. The certificate"
  note "         request will fail unless that address forwards port 80 here."
fi

check_others() {
  local now
  now="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/ || echo '---')"
  if [ "$now" != "$BEFORE" ]; then
    note "WARNING: the default host on port 80 now answers $now, was $BEFORE."
    note "         Check the other application before going further."
  else
    note "the other site(s) on port 80 still answer $now — unchanged"
  fi
}

# ---------------------------------------------------------------------------
# 1. Our own site, HTTP only, so the challenge can be served
# ---------------------------------------------------------------------------
say "Step 1 — adding our HTTP-only site (nothing else is touched)"
install -d -m 755 "$WEBROOT/.well-known/acme-challenge"
cp "$APP_DIR/deploy/nginx-bootstrap.conf" "$SITE"
ln -sf "$SITE" "/etc/nginx/sites-enabled/$SITE_NAME"
nginx -t || fail "the bootstrap config did not pass nginx -t (output above). Nothing was reloaded."
systemctl reload nginx 2>/dev/null || systemctl start nginx
check_others

echo ok > "$WEBROOT/.well-known/acme-challenge/selftest"
if curl -fsS --max-time 10 "http://$DOMAIN/.well-known/acme-challenge/selftest" 2>/dev/null | grep -q ok; then
  note "the challenge path is reachable from the internet"
  rm -f "$WEBROOT/.well-known/acme-challenge/selftest"
else
  rm -f "$WEBROOT/.well-known/acme-challenge/selftest"
  fail "http://$DOMAIN/.well-known/acme-challenge/ is not reachable from outside.
     Port 80 must be open to Any in the Azure NSG — Let's Encrypt validates
     from many addresses and cannot be restricted to a known one.
     Our nginx site is in place and harmless; fix the NSG and run this again."
fi

# ---------------------------------------------------------------------------
# 2. The certificate
# ---------------------------------------------------------------------------
say "Step 2 — the certificate"
if [ -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ] \
   && openssl x509 -checkend 2592000 -noout -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" >/dev/null 2>&1; then
  note "one is already there and good for more than 30 days — skipping"
else
  command -v certbot >/dev/null || { apt-get update -qq && apt-get install -y -qq certbot; }
  # --webroot, NOT --nginx: the nginx plugin rewrites config files, and on a
  # machine running someone else's application that is not a thing to let
  # loose. This only writes a file into our own webroot.
  certbot certonly --webroot -w "$WEBROOT" \
    -d "$DOMAIN" --email "$EMAIL" --agree-tos --no-eff-email --non-interactive \
    || fail "certbot could not issue the certificate (its message is above). Nothing else changed."
fi
[ -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ] || fail "no certificate on disk after certbot ran"

# ---------------------------------------------------------------------------
# 3. The TLS config
# ---------------------------------------------------------------------------
say "Step 3 — switching our site to TLS"
cp "$SITE" "/tmp/$SITE_NAME.before-tls.$(date +%s)" 2>/dev/null || true
cp "$APP_DIR/deploy/nginx.conf" "$SITE"
nginx -t || fail "the TLS config did not pass nginx -t (output above).
     Nothing was reloaded — our site is still serving HTTP and the other
     application is untouched."
systemctl reload nginx
check_others

# ---------------------------------------------------------------------------
# 4. Renewal
# ---------------------------------------------------------------------------
say "Step 4 — renewal"
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/bin/sh
# certbot renews the file; nginx keeps serving the old certificate from memory
# until something reloads it.
systemctl reload nginx
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
systemctl enable --now certbot.timer >/dev/null 2>&1 || true
if certbot renew --dry-run >/dev/null 2>&1; then
  note "the renewal dry run passed"
else
  note "WARNING: the renewal dry run did not pass — run 'certbot renew --dry-run' and read it"
fi

# ---------------------------------------------------------------------------
# 5. Prove it
# ---------------------------------------------------------------------------
say "Step 5 — proving it works"
printf '    https://%s/healthz       -> ' "$DOMAIN"; curl -fsS -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/healthz" || echo FAILED
printf '    https://%s/admin/login   -> ' "$DOMAIN"; curl -fsS -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/admin/login" || echo FAILED
printf '    http -> https redirect       : '; curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://$DOMAIN/admin/login"
printf '    certificate expires          : '; openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" | cut -d= -f2
printf '    other sites on port 80       : '; check_others

say "Done — https://$DOMAIN/admin/login"
