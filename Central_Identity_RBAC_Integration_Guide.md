# Central Identity & RBAC — Developer Integration Guide

**Prepared by:** NIYTRI Technologies  **Prepared for:** Ashika Group
**Version:** 1.1  |  16-Oct-2026  |  Status: Draft for review
**Environment:** Staging / UAT (Ananta DB) — same design promotes to Production

The Ashika API Portal (`omnenest-uploader-api`, the "Portal") is the organisation's **central identity provider**. Other applications authenticate their users against the Portal and receive the user's identity plus **live roles and permissions** — they do not keep their own passwords, MFA, or role tables. This guide tells an application team how to integrate.

---

## 1. What the Portal provides

- **Single login surface.** Passwords, email/SMS OTP, and Microsoft 365 (Entra ID) sign-in all happen only in the Portal. Your app never handles credentials.
- **One source of truth for authorization.** Roles and per-page permissions live in the Portal database. Every validation re-reads the user from the database, so disabling a user or changing a role takes effect **immediately** in every app.
- **Two integration paths:**
  - **A — Central SSO API (recommended):** OAuth2 authorization-code style. Your app redirects the user to the Portal, gets a one-time code, exchanges it for an access token, and validates/looks-up users via an introspection endpoint.
  - **B — Read-only DB fallback:** for apps that cannot do the browser redirect, a read-only database view (`vw_identity`) exposes users + roles + permissions. Use only when A is not possible.
- **MFA, handled for you.** M365 users are MFA'd by Entra (Authenticator / Conditional Access). Password (external) users get the Portal's email/SMS OTP. Your app receives an already-MFA'd identity.

---

## 2. Identity & RBAC model (read this first)

### 2.1 Users and roles
- **Users** and **roles** live in Postgres schema `"admin-staging-api"` on database `uat_ananta_staging`.
- Each user has exactly one role. The role carries a **permissions** JSONB document:

```json
{
  "pages":   ["*"]  // or an explicit list of page keys, e.g. ["dashboard","customer360"]
  ,"access": { "customer360": "edit", "mis": "view" }   // per-key view/edit
  ,"pii_view": true   // may see unmasked PII
  ,"actions": ["export", "approve"]   // optional fine-grained action grants
}
```

- `pages: ["*"]` = full access. Otherwise the user may open only the listed page keys; `access[key]` of `"view"` vs `"edit"` controls read vs write; `pii_view` gates unmasked PII.
- **Your app decides which of its own screens map to which page keys.** Reuse existing keys where they fit, or request new keys be added to the Portal role definitions.

### 2.2 Token model
- The Portal issues a **signed JWT**. For the Portal's own UI it rides in an httpOnly cookie; for your app it is an **SSO access token** (see §3).
- A valid token proves identity. **It is not, by itself, an authorization decision** — always resolve the current role/permissions via introspection (§3.4) or the DB view (§4), both of which read live state.

### 2.3 Applications & multi-role
Each role is tagged to one or more **applications** (`role_applications`). A user may hold **several roles** (`user_roles`) — typically one per application. A user's effective access **for a given app** is the most-permissive union of the roles they hold that are tagged to that app; roles for other apps are never visible to it. SSO `/token` and `/introspect` responses are therefore already scoped to the calling application. Admins tick an app list when creating a role, and assign multiple roles on the user screen.

---

## 3. Option A — Central SSO API (recommended)

OAuth2 authorization-code flow. Base path: `https://<portal-host>/api/sso`.

### 3.1 One-time registration (Portal admin does this)
Each app is registered in `"admin-staging-api".sso_apps` with:

| Field | Meaning |
|---|---|
| `client_id` | Public identifier for your app (e.g. `ofs-desk`). |
| `client_secret` | Secret shared with your app's **backend only**. Stored AES-encrypted in the Portal. |
| `redirect_uris` | Exact allow-list of callback URLs in your app. |
| `allowed_roles` | Optional CSV; if set, only those roles may enter your app. |

Generate the encrypted secret (run inside the Portal project):
```bash
node -e 'console.log(require("./lib/connCrypto").encrypt("YOUR_LONG_RANDOM_SECRET"))'
```
Store the output in `sso_apps.client_secret_enc`; give the **plaintext** secret to your app's backend config.

### 3.2 Step 1 — send the user to the Portal
Redirect the browser to:
```
GET https://<portal-host>/api/sso/authorize
      ?client_id=<your client_id>
      &redirect_uri=<your callback, must be in the allow-list>
      &state=<opaque anti-CSRF value you generate>
```
If the user has no Portal session they will log in (password/OTP or Microsoft) and then be returned automatically. On success the Portal redirects to:
```
<your redirect_uri>?code=<one-time code>&state=<same state>
```
The `code` is single-use and expires in **60 seconds**. If the user's role is not allowed for your app you receive `?error=access_denied`.

### 3.3 Step 2 — exchange the code (server-to-server)
From your **backend** (never the browser):
```
POST https://<portal-host>/api/sso/token
Content-Type: application/x-www-form-urlencoded

client_id=<id>&client_secret=<secret>&code=<code>
```
Response:
```json
{
  "token_type": "Bearer",
  "access_token": "<jwt>",
  "expires_in": 28800,
  "sub": "123", "email": "user@ashikagroup.com",
  "first_name": "...", "last_name": "...",
  "role": "Operator",
  "permissions": { "pages": ["customer360"], "access": {"customer360":"edit"}, "pii_view": false },
  "pages": ["customer360"], "access": {"customer360":"edit"}, "full_access": false
}
```
Create your app's own session for the user from this response.

### 3.4 Step 3 — validate later / refresh authorization (recommended)
On each request (or periodically) confirm the user is still valid and pull **live** role/permissions:
```
POST https://<portal-host>/api/sso/introspect
Content-Type: application/x-www-form-urlencoded

client_id=<id>&client_secret=<secret>&token=<access_token>
```
Response when valid:
```json
{ "active": true, "sub": "123", "email": "...", "role": "Operator",
  "permissions": {...}, "pages": [...], "access": {...}, "full_access": false }
```
`{"active": false}` means the token is invalid/expired **or** the account was disabled — treat as logged out. Because introspection re-reads the database, a role change or deactivation in the Portal is reflected instantly.

`GET /api/sso/userinfo` with `Authorization: Bearer <token>` is a lighter convenience (verifies the signature and returns the live profile) — prefer `introspect` where the live/active check matters.

### 3.5 Enforcing RBAC in your app
Map your screens/actions to Portal page keys, then gate on the introspection result:
- open a screen only if `full_access` **or** its key is in `pages`;
- allow writes only if `access[key] === "edit"`;
- show unmasked PII only if `pii_view === true`.

### 3.6 Minimal Node/Express example
```js
// callback: exchange the code
app.get('/auth/sso/callback', async (req, res) => {
  const body = new URLSearchParams({ client_id: CID, client_secret: CSEC, code: req.query.code });
  const r = await fetch(PORTAL + '/api/sso/token', { method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
  const u = await r.json();            // identity + roles + permissions
  req.session.user = u;                // your app's own session
  res.redirect('/');
});

// guard: live check + page gate
async function requirePage(key) {
  return async (req, res, next) => {
    const body = new URLSearchParams({ client_id: CID, client_secret: CSEC, token: req.session.token });
    const j = await (await fetch(PORTAL + '/api/sso/introspect', { method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'}, body })).json();
    if (!j.active) return res.redirect('/login');
    if (!(j.full_access || (j.pages||[]).includes(key))) return res.status(403).send('Forbidden');
    req.user = j; next();
  };
}
```

---

## 4. Option B — Read-only DB fallback

For apps that cannot use the browser redirect (batch jobs, server-side lookups). Connect with the least-privilege login role `ashika_identity_ro` and read **only** the view:

```sql
SELECT user_id, email, role_name, permissions, full_access
  FROM "admin-staging-api"."vw_identity"
 WHERE lower(email) = lower($1) AND is_active;
```
`vw_identity` exposes identity + role + the permissions JSONB, and never exposes password hashes or M365 secrets. This path gives you **authorization data** but does **not** authenticate a login — use it alongside the API, or only where the user was already authenticated by the Portal. Treat it as read-only; never write to Portal tables from another app.

---

## 5. Microsoft 365 (Entra ID) sign-in

### 5.1 Model
M365 is a **login method for staff**; the **Portal remains the authority for roles**. Entra verifies the person (and enforces MFA); the Portal maps that Microsoft identity to a local user and applies the local role. Microsoft accounts are **not** auto-provisioned — the user must already exist in the Portal (created by an admin) for the login to succeed.

### 5.2 Azure App Registration (one-time, tenant admin)
1. Azure Portal → Microsoft Entra ID → App registrations → **New registration**.
2. Supported accounts: **single tenant** (your organisation).
3. **Redirect URI** (Web): `https://<portal-host>/api/auth/m365/callback`.
4. After creation note the **Directory (tenant) ID** and **Application (client) ID**.
5. Certificates & secrets → **New client secret** → copy the value.
6. API permissions → Microsoft Graph → delegated **openid**, **profile**, **email** → Grant admin consent.
7. (Recommended) Enforce **MFA** for these users via a Conditional Access policy.

### 5.3 Configure in the Portal
Settings → **Microsoft 365 SSO**: paste Tenant ID, Client ID, Client Secret, the Redirect URI above, tick **Enable**. The secret is stored AES-encrypted.

### 5.4 Provision staff
For each staff member, create a Portal user whose **email matches their M365 (UPN) email**, assign a role, and use a role (or user flag) marked **Require Microsoft 365**. On their first Microsoft sign-in the Portal binds their Entra object id (`m365_oid`) to the account. Password login is blocked for these accounts; MFA is handled entirely by Entra (no second Portal OTP).

### 5.5 Flow
"Sign in with Microsoft" on the Portal login page → Entra login + MFA → back to `/api/auth/m365/callback` → Portal maps to the local user and starts the normal session. The flow is bound with `state`, `nonce`, and PKCE.

---

## 6. MFA policy
| User type | Authentication | MFA |
|---|---|---|
| Staff (M365) | Microsoft Entra | Entra (Authenticator / Conditional Access) |
| External / partner (password) | Portal password | Portal email or SMS OTP |

Apps integrating via SSO never implement MFA themselves — the identity they receive has already satisfied the right MFA for that user.

---

## 7. Onboarding checklist for a new app
1. Decide integration path (A API — default; B DB only if A impossible).
2. Portal admin registers your app in `sso_apps` (client_id, encrypted secret, redirect URIs, optional role gate).
3. Your backend stores `client_id` + `client_secret` + the Portal base URL as config/secrets.
4. Implement redirect → `/authorize`, callback → `/token`, and per-request `/introspect`.
5. Map your screens/actions to Portal page keys; agree any new keys with the Portal admin.
6. For staff SSO, ensure users exist in the Portal with matching M365 emails and M365-enabled roles.
7. Test: login, role change reflects immediately, disabled user is locked out everywhere.

---

## 8. Security notes
- The `client_secret` and the DB role password are backend-only secrets — never ship them to a browser or mobile client.
- Always validate `state` on the callback; use HTTPS everywhere; keep redirect URIs exact in the allow-list.
- Authorization codes are single-use and live 60 seconds; access tokens live 8 hours — re-check with `introspect` for sensitive actions.
- This design should get a security review before production exposure, and the new endpoints should sit behind the same WAF/rate-limiting as the rest of the Portal.

---

## 9. Reference

**SSO endpoints** (base `https://<portal-host>/api/sso`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/authorize` | Portal session (browser) | Start login, returns a one-time `code`. |
| POST | `/token` | client_id + client_secret | Exchange `code` for access token + identity. |
| POST | `/introspect` | client_id + client_secret | Validate token + return LIVE role/permissions. |
| GET | `/userinfo` | Bearer token | Convenience profile lookup (signature only). |
| POST | `/profile` | client_id + client_secret | Identity + app-scoped permissions + the apps the user can reach. |
| POST | `/forgot-password` | client_id + client_secret | Mail a new password to a user of this app (Portal policy/limits). |
| POST | `/change-password` | client_id + client_secret | Change password (token + current + new). |

**M365 endpoints** (base `https://<portal-host>/api/auth/m365`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/enabled` | Public flag — is M365 configured. |
| GET | `/login` | Redirect to Entra. |
| GET | `/callback` | Entra returns here; Portal starts the session. |

**Database objects** (schema `"admin-staging-api"`)

| Object | Purpose |
|---|---|
| `users`, `roles` | Identity + role/permissions (source of truth). |
| `sso_apps` | Registered client apps (id, encrypted secret, redirect allow-list, role gate). |
| `sso_codes` | Short-lived single-use authorization codes. |
| `vw_identity` | Read-only identity view for Option B (role `ashika_identity_ro`). |
| `m365_settings` | Entra tenant/client/secret/redirect + enabled flag. |
| `applications` | Apps that use this identity (Portal + externals). |
| `role_applications` | Which applications each role grants (app-group access). |
| `user_roles` | Many-to-many user↔roles (multiple profiles per user). |

**Environment variables (Portal)**

| Var | Purpose |
|---|---|
| `JWT_SECRET` | Signs Portal session + M365 state. |
| `JWT_EXPIRES_IN` | Session lifetime (default `8h`). |
| `SSO_JWT_SECRET` | Signs SSO access tokens (falls back to `JWT_SECRET`). |
| `API_KEY_SECRET` | Key for AES encryption of stored secrets (M365 + SSO client secrets). |
