-- ===========================================================================
-- 001_gateway_access.sql — who may sign in to Pravah
--
-- RUN THIS ON THE PLATFORM DATABASE, NOT THE GATEWAY ONE.
--
--   database : uat_ananta_staging        (the Ananta master application DB)
--   schema   : "admin-staging-api"       (users, roles, page_registry)
--   host     : 172.31.24.77              (private; same VNet as the gateway VM)
--
-- Everything under db/migrations/ belongs to the `gateway` database and is run
-- by `scripts/gw.js migrate`. This file is NOT one of those and that runner
-- will not touch it. Run it in pgAdmin, against uat_ananta_staging.
--
-- WHY THIS EXISTS
--
-- Pravah keeps no user table and no password of its own. Identity comes from
-- Ananta: the same accounts, the same password policy, the same deactivation.
-- When somebody leaves and their Ananta account is disabled, they lose the API
-- gateway within fifteen seconds — the gateway reloads the grant on every
-- request behind a short cache and never trusts the token for authorisation.
--
-- Authorisation is one page grant, "api-gateway", exactly like every other
-- section of Ananta. Two roles get it and nothing else does.
--
-- Additive and idempotent. Safe to re-run.
-- ===========================================================================

SET search_path TO "admin-staging-api", public;

-- ---------------------------------------------------------------------------
-- 1. Register the page, so it appears in Ananta's Roles screen.
--
-- Without this row the grant can only be made by editing JSON by hand, which
-- is how grants end up wrong.
--
-- nav_ids is deliberately EMPTY. Those ids reveal items in Ananta's own
-- sidebar, and Pravah is a separate portal on its own host — granting this
-- page must not make a menu entry appear in an application that has no such
-- page to show.
--
-- Safe against the application overwriting it: lib/pageRegistry.js upserts the
-- pages it knows about and never deletes a key it does not, so this row
-- survives a restart and a deploy. (Verified by reading that file — it has no
-- DELETE and no "NOT IN" cleanup.)
-- ---------------------------------------------------------------------------
INSERT INTO "admin-staging-api".page_registry (key, label, nav_ids, sort_order, is_active)
VALUES ('api-gateway', 'Pravah · API Gateway (external portal)', ARRAY[]::text[], 90, true)
ON CONFLICT (key) DO UPDATE
  SET label = EXCLUDED.label,
      nav_ids = EXCLUDED.nav_ids,
      sort_order = EXCLUDED.sort_order,
      is_active = true;

-- ---------------------------------------------------------------------------
-- 2. The roles.
--
-- SuperAdmin already holds '*' and therefore already reaches Pravah with full
-- access. It is not modified here; it is only checked at the bottom.
--
-- API Admin   — onboards suppliers, builds endpoints, holds credentials,
--               publishes and withdraws. Everything the console can do.
-- API Viewer  — reads the catalogue, the health screen and the activity log,
--               and changes nothing. Useful for the people who are asked
--               "what does this endpoint expose?" and should not need the
--               rights to change the answer.
--
-- The level convention is Ananta's, because Ananta's Roles screen is where
-- these will be edited: the page key goes in permissions.pages, and
-- permissions.access names the level. Anything other than 'view' — including
-- the key being absent — means full access. Pravah reads it the same way.
-- ---------------------------------------------------------------------------
INSERT INTO "admin-staging-api".roles (name, description, is_system, requires_mfa, use_m365, permissions)
VALUES
  ('API Admin',
   'Pravah API Gateway: onboard supplier APIs, build and publish wrapper endpoints, hold credentials. No access to other Ananta sections.',
   false, false, false,
   '{"pages":["api-gateway"],"access":{"api-gateway":"edit"}}'::jsonb),
  ('API Viewer',
   'Pravah API Gateway: read-only. Can see the catalogue, health and activity; cannot change anything or read a stored credential.',
   false, false, false,
   '{"pages":["api-gateway"],"access":{"api-gateway":"view"}}'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- If the roles already existed from an earlier attempt, make sure they
-- actually carry the grant. Written as a merge rather than a replace so a
-- role someone has since given other pages keeps them.
--
-- Built with || rather than nested jsonb_set. jsonb_set's create_missing only
-- creates the LAST element of the path: on a role whose permissions have no
-- "access" object at all, setting '{access,api-gateway}' silently does
-- nothing. That failure is invisible — the role looks granted, and the level
-- it was supposed to carry is simply absent.
UPDATE "admin-staging-api".roles
   SET permissions = COALESCE(permissions, '{}'::jsonb)
         || jsonb_build_object(
              'pages',
              COALESCE(permissions->'pages', '[]'::jsonb) || '"api-gateway"'::jsonb)
         || jsonb_build_object(
              'access',
              COALESCE(permissions->'access', '{}'::jsonb)
                || jsonb_build_object(
                     'api-gateway',
                     CASE WHEN name = 'API Viewer' THEN 'view' ELSE 'edit' END)),
       updated_at = NOW()
 WHERE name IN ('API Admin', 'API Viewer')
   AND NOT (COALESCE(permissions->'pages', '[]'::jsonb) @> '"api-gateway"'::jsonb);

-- ---------------------------------------------------------------------------
-- 3. Give somebody the role.
--
-- Left commented ON PURPOSE. Running this file should not silently change who
-- can administer the gateway — that is a decision, and it belongs to whoever
-- is sitting in front of pgAdmin, not to a script they ran to create a role.
--
-- Put the real email in and run the one you want.
-- ---------------------------------------------------------------------------
-- UPDATE "admin-staging-api".users
--    SET role_id = (SELECT id FROM "admin-staging-api".roles WHERE name = 'API Admin'),
--        updated_at = NOW()
--  WHERE LOWER(email) = LOWER('someone@ashikagroup.com');

-- A user keeps ONE role, so the line above REPLACES whatever they had. If the
-- person also needs their existing Ananta sections, do not move them — add the
-- page to the role they already hold instead:
--
-- UPDATE "admin-staging-api".roles
--    SET permissions = jsonb_set(
--          jsonb_set(permissions, '{pages}',
--            COALESCE(permissions->'pages','[]'::jsonb) || '"api-gateway"'::jsonb, true),
--          '{access,api-gateway}', '"edit"'::jsonb, true),
--        updated_at = NOW()
--  WHERE name = 'Admin';

-- ---------------------------------------------------------------------------
-- 4. Check what this did.
-- ---------------------------------------------------------------------------

-- The page is registered.
SELECT key, label, nav_ids, sort_order, is_active
  FROM "admin-staging-api".page_registry
 WHERE key = 'api-gateway';

-- Every role that can reach Pravah, and at what level. This is the list to
-- read out in an access review: if a role is on it, the people holding that
-- role can sign in to the gateway console.
SELECT r.name AS role,
       CASE WHEN r.permissions->'pages' @> '"*"'::jsonb THEN 'full (SuperAdmin)'
            WHEN COALESCE(r.permissions->'access'->>'api-gateway', 'edit') = 'view'
              THEN 'view only'
            ELSE 'edit' END                                   AS gateway_access,
       (SELECT count(*) FROM "admin-staging-api".users u
         WHERE u.role_id = r.id AND COALESCE(u.is_active, true)) AS active_users
  FROM "admin-staging-api".roles r
 WHERE r.permissions->'pages' @> '"*"'::jsonb
    OR r.permissions->'pages' @> '"api-gateway"'::jsonb
    OR r.permissions->'pages' @> '"api-gateway:edit"'::jsonb
 ORDER BY 2, 1;

-- And the people, by name. Run this one after granting the role.
SELECT u.email, u.first_name, u.last_name, r.name AS role, u.is_active,
       (u.password_hash IS NOT NULL) AS can_sign_in_with_password,
       u.last_login_at
  FROM "admin-staging-api".users u
  JOIN "admin-staging-api".roles r ON r.id = u.role_id
 WHERE r.permissions->'pages' @> '"*"'::jsonb
    OR r.permissions->'pages' @> '"api-gateway"'::jsonb
 ORDER BY r.name, u.email;
