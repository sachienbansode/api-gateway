# What to run next

Everything below is on the VM `app-monitor` (20.244.33.142) unless it says
otherwise. Commands are chained with `&&` so a failure stops the line rather
than running the next step in the wrong state.

⚠ **OFS is on this machine.** Nothing here touches it. The nginx work is
name-based — only requests for `pravah.ashikagroup.com` reach this app, and
every other host keeps going to OFS. `ssl-setup.sh` refuses to start if it
finds a conflict, and re-checks the other sites after every reload.

---

## 1. Push, from your own machine

The commit is already made on your laptop (two of them). The push needs your
GitHub credential, which the automation here does not have:

```powershell
cd "D:\sachin b\projects\API Gateway-Ashika\api-wrapper"
git log --oneline -3
git push origin main
```

---

## 2. Pull and restart on the VM

```bash
cd /var/apps/api-gateway && \
git pull && \
npm ci --omit=dev && \
node scripts/validate-config.js && \
pm2 delete api-gateway ; pm2 start ecosystem.config.js && \
pm2 save && \
sleep 3 && curl -s -o /dev/null -w 'readyz %{http_code}\n' http://127.0.0.1:8080/readyz
```

`pm2 delete` then `start` rather than `restart`: a restart reuses the cached
environment, so a change to `/etc/api-gateway/env` would not be picked up.

---

## 3. The database — three scripts, in order

Run these in pgAdmin against the **`gateway`** database, autocommit on.

| | file | what it does |
|---|---|---|
| 1 | `db/migrations/002_catalog.sql` | upstreams, endpoints, per-vendor grants, per-vendor IP allowlists |
| 2 | `db/migrations/003_studio.sql` | applications, types, categories, parameters, field catalogue, test log |
| 3 | `db/migrations/004_upstream_secrets.sql` | encrypted supplier credentials, the status view, the secret audit |
| 4 | `db/seed/001_cmots_assignment.sql` | assignment 1 — the CMOTS catalogue |

All three are idempotent; running one twice changes nothing the second time.

The seed ends with two SELECTs that print what landed. Expect:

```
 application |   1
 categories  |  12
 upstream    |   1
 endpoints   |  68
 parameters  | 101
 fields      | 938
```

---

## 4a. The encryption key — once, before any token is entered

Supplier credentials are stored in the database, sealed with AES-256-GCM. The
key is **not** in the database; it lives in the env file, and that separation is
the entire mechanism. A backup, a replica, or a dump handed to a DBA decrypts
to nothing on its own.

```bash
KEY="v1:$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" && \
sudo sh -c "echo 'GW_SECRET_KEY=$KEY' >> /etc/api-gateway/env" && \
sudo chmod 640 /etc/api-gateway/env && \
unset KEY && \
cd /var/apps/api-gateway && pm2 delete api-gateway && pm2 start ecosystem.config.js
```

**Back this key up somewhere other than that VM**, in whatever your team uses
for secrets. If the VM is lost and the key with it, every stored credential has
to be re-entered by hand — 68 endpoints' worth of supplier relationships.

Then put the CMOTS token in through the UI, not the shell: API Studio → step 1 →
**Credential** → Save supplier API. It is encrypted before it reaches a column,
never written to a log, and never sent back to the browser. The console will
show `stored ••••7b21 · key v1` and who set it.

The `${CMOTS_API_TOKEN}` environment variable still works as a fallback if you
would rather do it the old way — the internal upstreams still use that path —
but you do not need both.

Everything lands as a **draft**. Nothing is served until someone opens it in
the Studio, tests it against the real CMOTS and presses Publish.

---

## 4. TLS

```bash
sudo /var/apps/api-gateway/deploy/ssl-setup.sh
```

It prints what it finds before it changes anything, and stops at the first
problem rather than carrying on. The one thing it cannot do for you: **port 80
must be open to Any in the Azure NSG.** Let's Encrypt validates from many
addresses, so it cannot be restricted to a known IP. Port 443 open to Any too.

```powershell
# from your machine, if the NSG still needs it
az network nsg rule create --resource-group <rg> --nsg-name <nsg> `
  --name allow-http  --priority 1010 --access Allow --protocol Tcp `
  --direction Inbound --source-address-prefixes '*' --destination-port-ranges 80

az network nsg rule create --resource-group <rg> --nsg-name <nsg> `
  --name allow-https --priority 1011 --access Allow --protocol Tcp `
  --direction Inbound --source-address-prefixes '*' --destination-port-ranges 443
```

### Why the earlier attempt failed

The config on the VM was an older copy that still had the office-IP block in
`location /admin`. The patch script tried to insert an `allow` line into it,
`$MYIP` was empty, and the file ended up with `allow ;` — so `nginx -t` failed
and nginx never reloaded. Step 2 above replaces that file with the current one,
which has no IP restriction at all: the portal is public by decision, and
per-vendor IP allowlists live in the database where one vendor can be pinned
without affecting another.

---

## 5. First run through the Studio

`https://pravah.ashikagroup.com/admin/studio`

1. Application → **CMOTS Market Data**, Endpoint → **Company Master**.
2. Step 1 is already filled in. Press **Call the supplier**. You should get
   HTTP 200 and a field count. If it says the credential is not set, step 3
   above has not been done.
3. Step 3 — press **Add fields from the last test**. Anything CMOTS returns
   that the workbook never documented appears here, **unticked**. Decide on
   each one.
4. Step 4 — **Run the endpoint**. The left pane is what CMOTS sent, the right
   is what a vendor would receive. They should differ.
5. **Publish**. It starts answering immediately — no restart.
6. Vendors screen → give the vendor the scope `ep:company_master`, then issue
   them a key.

---

## Still open

- **The repo is public.** `github.com/sachienbansode/api-gateway` should be
  private before go-live. It holds no credential, but it does describe the
  internal topology.
- **`AUTH_DATABASE_URL` is unset**, so admin access is the break-glass
  superadmin alone. Point it at `uat_ananta_staging` and give the login
  SELECT on the users and roles tables only, then set
  `SUPERADMIN_ENABLED=false`.
- **Vendor scopes for the catalogue.** Publishing an endpoint does not grant
  anybody access to it; the Vendors screen still lists only the YAML scopes.
  Picking endpoints per vendor from a list is the next screen to build.
- **`.github/workflows/ci.yml`** is still missing — the tests (109 of them)
  only run when someone runs them.
- **Key rotation is built but has no button yet.** `POST /admin/api/credentials/rotate`
  re-seals every credential onto the newest key in `GW_SECRET_KEY`; adding a
  second key at the front of that variable and calling it is the whole
  procedure. Worth putting on a screen before anyone needs it in a hurry.
