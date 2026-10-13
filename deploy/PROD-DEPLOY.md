# Production deploy — Azure VM, AWS Postgres

Written for the actual topology, which is **split across two clouds**:

| | Where | What |
|---|---|---|
| App server | **Azure VM**, Ubuntu 24.04, 4 vCPU / 16 GiB | nginx + Node gateway |
| Gateway DB | **AWS `13.234.135.5`**, database `gateway` | quota, idempotency, audit, vendor keys |
| Platform DB | **AWS `13.234.135.5`**, database `uat_ananta_staging` | `"admin-staging-api".users` / `roles` — admin identity |

⚠ **Read this before anything else.** Both databases are on the same AWS
Postgres server, in a different cloud from the VM. Three consequences, none of
them optional:

1. **The AWS security group and `pg_hba.conf` must both allow the Azure VM's
   public IP.** Miss either and the connection times out with no useful error —
   it looks exactly like a broken application. This is the single most common
   failure in this setup.
2. **Quota and idempotency sit on the request path**, and that path now crosses
   the public internet from Azure to AWS Mumbai. Budget 5–15 ms per query rather
   than the 1–2 ms an in-region database gives you. Measure it (§6) before the
   vendor does.
3. **The Azure root certificate that `install.sh` downloads is useless here.**
   It is for Azure Database for PostgreSQL. Your server is self-managed on EC2,
   so either point `DB_CA_CERT_PATH` at that server's own CA, or accept
   `DB_SSL_INSECURE=true` knowingly — see §3.

Everything below assumes the VM already exists.

---

## 1. Local PowerShell — push the code

```powershell
cd "D:\sachin b\projects\API Gateway-Ashika\api-wrapper"

git status --short          # expect no output
git log --oneline -3
git push
```

---

## 2. Azure — open the right doors, and only those

Install the CLI once (`winget install Microsoft.AzureCLI`), then:

```powershell
az login
az account set --subscription "<YOUR-SUBSCRIPTION-NAME-OR-ID>"

# Fill these in once; every command below reuses them.
$RG   = "<your-resource-group>"
$VM   = "<your-vm-name>"
$NSG  = "<your-nsg-name>"
$MYIP = (Invoke-RestMethod https://api.ipify.org)      # your office IP right now
```

Confirm what you actually have, rather than assuming:

```powershell
az vm show -g $RG -n $VM --query "{name:name, size:hardwareProfile.vmSize, os:storageProfile.imageReference.offer}" -o table
az vm list-ip-addresses -g $RG -n $VM -o table
az network nsg rule list -g $RG --nsg-name $NSG -o table
```

⚠ **Note the VM's public IP from the second command.** You need it in §4 for the
AWS side, and it must be **static** — a dynamic IP changes on reboot and
silently breaks the database connection. Check and fix:

```powershell
$IPNAME = (az vm list-ip-addresses -g $RG -n $VM --query "[0].virtualMachine.network.publicIpAddresses[0].name" -o tsv)
az network public-ip show -g $RG -n $IPNAME --query "{ip:ipAddress, allocation:publicIPAllocationMethod, sku:sku.name}" -o table

# If allocation is Dynamic:
az network public-ip update -g $RG -n $IPNAME --allocation-method Static
```

### NSG rules

Deploy with HTTPS open to **your own IP only**. The vendor's IPs go in last,
after §6 passes. This gives you a staging gate for free.

```powershell
# 443 — your office only, for now
az network nsg rule create -g $RG --nsg-name $NSG -n allow-vendor-https `
  --priority 100 --direction Inbound --access Allow --protocol Tcp `
  --source-address-prefixes $MYIP --destination-port-ranges 443 `
  --description "Vendor HTTPS. STAGING: office IP only until verification passes."

# 22 — your office only
az network nsg rule create -g $RG --nsg-name $NSG -n allow-admin-ssh `
  --priority 200 --direction Inbound --access Allow --protocol Tcp `
  --source-address-prefixes $MYIP --destination-port-ranges 22 `
  --description "Admin SSH from the office."

# Explicit deny, so the intent is visible to whoever audits this
az network nsg rule create -g $RG --nsg-name $NSG -n deny-all-inbound `
  --priority 4096 --direction Inbound --access Deny --protocol "*" `
  --source-address-prefixes "*" --destination-port-ranges "*" `
  --description "Everything not named above."

az network nsg rule list -g $RG --nsg-name $NSG -o table
```

---

## 3. On the VM — install

```powershell
ssh <admin-user>@<VM-PUBLIC-IP>
```

```bash
sudo apt-get update && sudo apt-get install -y git nginx
cd /var/apps
sudo git clone https://github.com/sachienbansode/api-gateway.git api-gateway
cd api-gateway
sudo bash deploy/install.sh
```

⚠ `install.sh` downloads the **Azure** DigiCert root to
`/etc/api-gateway/azure-root.pem`. Your database is not on Azure, so
**do not set `DB_CA_CERT_PATH` to it** — the connection would fail verification
against the wrong authority. Either:

- copy your Postgres server's own CA onto the VM and point `DB_CA_CERT_PATH` at
  it (correct), or
- set `DB_SSL_INSECURE=true` (encrypted but unauthenticated — it logs a warning
  every boot on purpose, and is a stopgap, not an answer).

---

## 4. AWS — let the VM in

On the AWS side, for the Postgres instance at `13.234.135.5`:

1. **Security group**: inbound TCP 5432 from the Azure VM's public IP `/32`.
2. **`pg_hba.conf`**: a `hostssl` line for that IP, then `sudo systemctl reload postgresql`.

```
# /etc/postgresql/18/main/pg_hba.conf
hostssl  gateway             gw_app      <AZURE-VM-IP>/32   scram-sha-256
hostssl  uat_ananta_staging  gw_admin_ro <AZURE-VM-IP>/32   scram-sha-256
```

Prove it from the VM before going further:

```bash
nc -zv 13.234.135.5 5432
```

A hang means the security group. `Connection refused` means Postgres is not
listening on that interface. Only an immediate `succeeded` is good.

---

## 5. Configure

```bash
sudoedit /etc/api-gateway/env
```

```bash
# ---------------------------------------------------------------------------
# DB 1: Gateway — the app's own database (read/write)
# ---------------------------------------------------------------------------
GW_DATABASE_URL=postgresql://gw_app@13.234.135.5:5432/gateway
GW_PG_PASSWORD=
GW_PG_SSL=true
GW_PG_POOL_MAX=10
GW_PG_SSL_INSECURE=true        # until the server's CA is on the box
GW_MIGRATE_ON_BOOT=false       # schema is already in place and recorded

# ---------------------------------------------------------------------------
# DB 2: Auth — the platform's user and role directory (READ ONLY)
# ---------------------------------------------------------------------------
AUTH_DATABASE_URL=postgresql://gw_auth_ro@13.234.135.5:5432/uat_ananta_staging
AUTH_PG_PASSWORD=
AUTH_PG_SSL=true
AUTH_PG_POOL_MAX=5
AUTH_PG_SSL_INSECURE=true
ADMIN_SCHEMA=admin-staging-api

# ---------------------------------------------------------------------------
# Admin identity — same JWT issuer as the platform
# ---------------------------------------------------------------------------
JWT_SECRET=                    # MUST match the platform's, or no token verifies
JWT_ISSUER=omnenest-staging-api
GATEWAY_PAGE_KEY=api-gateway
ADMIN_PERM_CACHE_MS=15000

# Break-glass. Generate with: node scripts/gw.js admin:hash
SUPERADMIN_ENABLED=true
SUPERADMIN_EMAIL=you@yourcompany.com
SUPERADMIN_PASSWORD_HASH=

# ---------------------------------------------------------------------------
# Upstreams — every ${VAR} named in config/upstreams.yaml must be here.
# An unresolved one is a hard boot failure, by design.
# ---------------------------------------------------------------------------
INTERNAL_NODE_API_TOKEN=
INTERNAL_PY_API_KEY=
```

In both blocks the password lives in its own variable and **overrides any
password in the URL**. That is deliberate: a connection URL gets logged, pasted
into tickets and shown in `ps`, and the secret should not travel with it. If you
put one in the URL anyway, the app warns and uses the separate variable.

⚠ **`gw_admin_ro` must be read-only on the platform database.** The gateway
reads identity; it never writes a user, a role or a grant. Give it `CONNECT`,
`USAGE` on `"admin-staging-api"`, and `SELECT` on `users` and `roles` — nothing
more. A gateway compromise must not become a way to grant yourself a role on the
platform.

Generate the break-glass hash on the VM:

```bash
cd /var/apps/api-gateway
node scripts/gw.js admin:hash      # reads the password from stdin, never argv
```

---

## 6. Verify — in this order

```bash
cd /var/apps/api-gateway
set -a && . /etc/api-gateway/env && set +a

node scripts/gw.js migrate:status     # expect: 001_init.sql applied, Pending (none)
node scripts/gw.js db:check
```

`db:check` connects as the configured role and **attempts** `CREATE`, `DROP`,
`ALTER` and `TRUNCATE` inside a rolled-back transaction, asserting each is
refused. Connecting as the table owner means 3 of 15 will fail — accurate, not
broken. See the open decision in the go-live workbook.

Measure the cross-cloud latency now, while you can still act on it:

```bash
psql "$GW_DATABASE_URL" -c '\timing' -c 'SELECT 1' -c 'SELECT 1' -c 'SELECT 1'
```

Under ~15 ms is fine. Consistently above ~40 ms and you should move quota off
the request path before the vendor is live.

Then start it:

```bash
sudo systemctl enable --now api-gateway
sudo systemctl status api-gateway --no-pager
journalctl -u api-gateway -n 40 --no-pager
curl -s localhost:8080/readyz | jq .
```

`readyz` returning 503 is the gateway telling you something is degraded — read
the `database`, `upstreams` and `audit` keys in its body rather than restarting.

---

## 7. TLS

DNS must resolve to the VM **before** certbot runs, or issuance fails.

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/api-gateway
sudo ln -sf /etc/nginx/sites-available/api-gateway /etc/nginx/sites-enabled/
sudoedit /etc/nginx/sites-available/api-gateway    # set server_name
sudo certbot --nginx -d partner-api.yourdomain.com
sudo nginx -t && sudo systemctl reload nginx
```

---

## 8. Only now, let the vendor in

Everything in §6 green, and the whitelist verified end to end:

```powershell
az network nsg rule update -g $RG --nsg-name $NSG -n allow-vendor-https `
  --source-address-prefixes <VENDOR-IP-1> <VENDOR-IP-2> `
  --description "Vendor HTTPS. Vendor egress IPs only."

az network nsg rule show -g $RG --nsg-name $NSG -n allow-vendor-https -o table
```

---

## 9. Redeploying later

```bash
cd /var/apps/api-gateway
git fetch origin                      # BEFORE reset — a stale cached ref has bitten this team repeatedly
git reset --hard origin/main
npm ci --omit=dev
sudo systemctl restart api-gateway
journalctl -u api-gateway -n 20 --no-pager
```

`npm ci`, never `npm install`: it installs exactly what `package-lock.json`
pins. This service holds credentials to every upstream you own, so a transitive
dependency resolving to something untested is not acceptable.

---

## Rollback

```bash
cd /var/apps/api-gateway
git log --oneline -5
git reset --hard <previous-sha>
npm ci --omit=dev
sudo systemctl restart api-gateway
```

The database needs no rollback: every migration is additive and guarded with
`IF NOT EXISTS`.
