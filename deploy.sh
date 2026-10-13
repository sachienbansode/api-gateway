#!/usr/bin/env bash
#
# Deploy the API Gateway. Run on the VM, from the repo root, as root:
#
#     cd /var/apps/api-gateway
#     git pull origin main
#     sudo bash deploy.sh
#
# Safe to re-run. Does nothing destructive and never touches the database
# schema — migrations are a separate, deliberate step (see MIGRATE below).
#
# The order below is the point: config is validated BEFORE the service is
# restarted, so a whitelist typo fails here with the old version still serving,
# rather than taking the gateway down and taking the vendor with it.
#
set -Eeuo pipefail

SVC="api-gateway"
ENV_FILE="/etc/${SVC}/env"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_URL="http://127.0.0.1:${PORT:-8080}/readyz"
MIGRATE="${MIGRATE:-false}"

bold()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()    { printf '    \033[32mok\033[0m  %s\n' "$1"; }
warn()  { printf '    \033[33m!\033[0m   %s\n' "$1"; }
die()   { printf '\n\033[31mFAILED: %s\033[0m\n\n' "$1" >&2; exit 1; }

trap 'die "line $LINENO. Nothing was restarted if this fired before the restart step."' ERR

# ---------------------------------------------------------------------------
# 0. Preconditions
# ---------------------------------------------------------------------------
bold "Checks"

[[ $EUID -eq 0 ]] || die "run as root:  sudo bash deploy.sh"
[[ -f "$APP_DIR/package.json" ]] || die "no package.json in $APP_DIR — run this from the repo root"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE does not exist. Run deploy/install.sh first."

command -v node >/dev/null || die "node is not installed. Run deploy/install.sh first."
command -v npm  >/dev/null || die "npm is not installed."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "Node $NODE_MAJOR is too old; this needs 20 or newer."
ok "node v$(node -p 'process.versions.node')"

# package-lock.json is what makes `npm ci` reproducible. Without it npm would
# re-resolve transitive versions, and this service holds credentials to every
# upstream you own.
[[ -f "$APP_DIR/package-lock.json" ]] || die "package-lock.json is missing — refusing to deploy unpinned dependencies"
ok "package-lock.json present"

cd "$APP_DIR"

# Refuse to run against another application's checkout.
#
# This box hosts more than one app. A mistyped `cd` leaves you standing in the
# previous directory and the next command runs there instead — which is exactly
# how a deploy ends up pulling into a neighbouring repo. Check the identity of
# what we are about to deploy rather than trusting the working directory.
PKG_NAME="$(node -p "require('$APP_DIR/package.json').name" 2>/dev/null || echo '')"
if [[ "$PKG_NAME" != "api-gateway" ]]; then
  die "$APP_DIR is not the API Gateway (package.json says \"$PKG_NAME\"). You are in the wrong directory."
fi
ok "confirmed this is the api-gateway checkout"

if command -v git >/dev/null && [[ -d .git ]]; then
  ORIGIN="$(git remote get-url origin 2>/dev/null || echo '')"
  if [[ -n "$ORIGIN" && "$ORIGIN" != *"api-gateway"* ]]; then
    die "git origin is \"$ORIGIN\", which is not the api-gateway repository. Wrong directory."
  fi
  SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  SUBJ="$(git log -1 --pretty=%s 2>/dev/null || true)"
  ok "deploying ${SHA} — ${SUBJ}"
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    warn "working tree has local modifications; they will be deployed as-is"
  fi
  PREV_SHA="$SHA"
else
  PREV_SHA="unknown"
fi

# ---------------------------------------------------------------------------
# 1. Dependencies
# ---------------------------------------------------------------------------
bold "Dependencies"
npm ci --omit=dev --no-audit --no-fund
ok "installed exactly what package-lock.json pins"

# ---------------------------------------------------------------------------
# 2. Validate config BEFORE touching the running service
#
# This is the gate. It parses endpoints.yaml / upstreams.yaml / vendors.yaml,
# resolves every ${VAR} against the real env file, and prints the exposure
# report. A missing credential or a malformed whitelist dies here.
# ---------------------------------------------------------------------------
bold "Config"
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a

npm run validate --silent || die "config validation failed — the running service was NOT restarted"
ok "manifests parse and every credential resolves"

# ---------------------------------------------------------------------------
# 3. Schema
# ---------------------------------------------------------------------------
bold "Database"
if [[ -z "${DATABASE_URL:-}" ]]; then
  warn "DATABASE_URL is not set — audit, durable quota and idempotency are DISABLED"
elif [[ "$MIGRATE" == "true" ]]; then
  [[ -n "${MIGRATION_DATABASE_URL:-}" ]] || die "MIGRATE=true needs MIGRATION_DATABASE_URL (the owner credential)"
  node scripts/gw.js migrate
  ok "migrations applied"
else
  node scripts/gw.js migrate:status || warn "could not read migration status"
  warn "migrations not run. If any are pending:  sudo MIGRATE=true bash deploy.sh"
fi

# ---------------------------------------------------------------------------
# 4. Restart
# ---------------------------------------------------------------------------
bold "Restart"
trap - ERR    # past this point we handle failure ourselves, with logs

systemctl daemon-reload
systemctl restart "$SVC"
systemctl is-enabled --quiet "$SVC" || systemctl enable --quiet "$SVC"
ok "$SVC restarted"

# ---------------------------------------------------------------------------
# 5. Prove it actually came up
#
# "systemctl restart returned 0" only means systemd forked it. A gateway that
# boots and then dies on an unresolved upstream credential looks identical
# until you ask it.
# ---------------------------------------------------------------------------
bold "Health"
for i in $(seq 1 30); do
  CODE="$(curl -s -o /tmp/readyz.$$ -w '%{http_code}' --max-time 3 "$HEALTH_URL" || true)"
  if [[ "$CODE" == "200" ]]; then
    ok "readyz 200 after ${i}s"
    command -v jq >/dev/null && jq -c '{database,audit,vendorStore:.vendorStore.source}' /tmp/readyz.$$ || cat /tmp/readyz.$$
    rm -f /tmp/readyz.$$
    bold "Deployed: $PREV_SHA"
    exit 0
  fi
  if [[ "$CODE" == "503" ]]; then
    warn "readyz 503 (degraded) — reading why"
    command -v jq >/dev/null && jq . /tmp/readyz.$$ || cat /tmp/readyz.$$
    rm -f /tmp/readyz.$$
    printf '\n\033[33mUp, but degraded.\033[0m An open breaker or a sick database. The service is\n'
    printf 'running; check the keys above before sending the vendor any traffic.\n\n'
    exit 0
  fi
  sleep 1
done

rm -f /tmp/readyz.$$
printf '\n\033[31mThe service did not become healthy within 30s.\033[0m\n\n'
journalctl -u "$SVC" -n 40 --no-pager || true
cat <<EOF

To roll back:

    cd $APP_DIR
    git log --oneline -5
    git reset --hard <previous-sha>
    sudo bash deploy.sh

The database needs no rollback — every migration is additive and guarded
with IF NOT EXISTS.

EOF
exit 1
