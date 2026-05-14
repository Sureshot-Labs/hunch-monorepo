# Admin Auth API Handoff

This document describes the backend contract for the separate admin frontend.
The public Hunch app and Privy user auth remain unchanged.

## Overview

Admin accounts are independent from normal `users` records. Operators create an
admin invite with the backend CLI, send the one-time enrollment URL manually,
then activate the enrolled account with a role: `sadmin`, `admin`, `viewer`, or
`analyst`.

Supported roles:

- `sadmin`: can use all `admin` APIs and admin-management endpoints such as
  changing legacy user admin status.
- `admin`: can use existing operational `/admin/*` panel APIs except
  admin-management endpoints.
- `viewer`: can use read-only `/admin/*` panel APIs, including user, finance,
  rewards, intel, and analytics reads, but cannot mutate users, fees, rewards,
  points, policies, or admin accounts.
- `analyst`: can log in to the admin panel so the frontend can show
  external/client-side analytics surfaces, such as Google Analytics. It cannot
  call internal Hunch `/admin/*`, `/analytics/*`, user, finance, rewards, or
  intel APIs unless a future backend route grants a narrower permission.

Account statuses:

- `invited`: enrollment link exists; cannot log in.
- `enrolled`: password and TOTP are configured; cannot log in until activated.
- `active`: can log in.
- `disabled`: cannot enroll or log in; sessions are revoked.

## Admin Frontend RBAC Contract

The admin frontend should treat the backend role as a navigation and capability
hint only. Backend permissions remain the security boundary; hidden frontend UI
does not replace backend authorization.

Recommended role visibility:

| Role | Frontend visibility | Mutations |
| --- | --- | --- |
| `sadmin` | All admin sections, including admin account management. | All supported admin mutations. |
| `admin` | Operational admin sections, but no admin account management. | Operational mutations only. |
| `viewer` | Read-only internal admin sections. | None. Hide or disable write controls. |
| `analyst` | External/client-side analytics surfaces only. | None. Do not call internal Hunch admin APIs. |

Internal Hunch admin sections currently map to backend permissions like this:

| Section | Example backend routes | Required permission family |
| --- | --- | --- |
| Operational analytics health | `/analytics/collector/telemetry`, `/admin/vector`, `/admin/api-cache-warm/status` | `analytics:read` |
| Users | `/admin/users`, `/admin/users/:id`, user balances/activity | `users:read` or `users:write` |
| Finance | `/admin/overview`, `/admin/fees/*`, debridge config routes | `finance:read` or `finance:write` |
| Wallet intel | `/admin/intel/*` | `intel:read` or `intel:write` |
| Rewards and points | `/admin/rewards/*`, manual points routes | `rewards:read` or `rewards:write` |
| Admin accounts | `/admin-auth/admins/*` | `admin:manage` |

`analyst` is intentionally not included in any internal backend permission
family. The role exists so the future admin panel can authenticate a user and
then show frontend-owned or third-party analytics content, such as embedded or
linked Google Analytics reporting, without granting access to Hunch user,
finance, rewards, wallet, intel, cache, vector, or collector data.

Frontend implementation notes:

- Build the navigation from the role returned by `/admin-auth/me`.
- Clear admin cookies and redirect to login on `admin_session_expired`.
- Hide write controls for `viewer` and `analyst`; still handle backend `403`
  responses because authorization is enforced server-side.
- Keep legacy fallback out of the new admin frontend. It exists only to avoid
  breaking current backend/admin ops during rollout.

## CLI Ops

Run inside the API package:

```bash
pnpm -F api run admin:auth -- invite --email admin@example.com
pnpm -F api run admin:auth -- activate --email admin@example.com --role admin
pnpm -F api run admin:auth -- activate --email viewer@example.com --role viewer
pnpm -F api run admin:auth -- activate --email analyst@example.com --role analyst
pnpm -F api run admin:auth -- activate --email owner@example.com --role sadmin
pnpm -F api run admin:auth -- disable --email admin@example.com
pnpm -F api run admin:auth -- rotate-link --email admin@example.com
pnpm -F api run admin:auth -- revoke-sessions --email admin@example.com
pnpm -F api run admin:auth -- list
```

On prod, run the same script inside the `hunch-api` container after migrations:

```bash
/usr/bin/docker exec hunch-api node /app/apps/api/dist/admin-auth-cli.js invite --email admin@example.com
```

`invite` and `rotate-link` print a one-time URL using `ADMIN_APP_BASE_URL`, for
example:

```text
https://admin.hunch.trade/enroll?token=<opaque-token>
```

The token is stored only as a SHA-256 hash server-side.

## Enrollment Flow

The frontend receives `/enroll?token=...`.

### Start Enrollment

`POST /admin-auth/enroll/start`

Request:

```json
{
  "token": "one-time-token-from-url"
}
```

Success:

```json
{
  "ok": true,
  "email": "admin@example.com",
  "otpauthUri": "otpauth://totp/...",
  "manualSecret": "BASE32SECRET",
  "expiresAt": "2026-05-08T12:00:00.000Z"
}
```

Frontend behavior:

- Render a QR code from `otpauthUri`.
- Also show `manualSecret` for manual authenticator setup.
- Ask the admin to enter a password and the current 6-digit TOTP code.

Calling start again before completion rotates the TOTP secret for that invite.

### Complete Enrollment

`POST /admin-auth/enroll/complete`

Request:

```json
{
  "token": "one-time-token-from-url",
  "password": "long-password-123",
  "totpCode": "123456"
}
```

Success:

```json
{
  "ok": true,
  "admin": {
    "id": "uuid",
    "email": "admin@example.com",
    "status": "enrolled",
    "role": null,
    "createdAt": "2026-05-08T12:00:00.000Z",
    "invitedAt": "2026-05-08T12:00:00.000Z",
    "enrolledAt": "2026-05-08T12:05:00.000Z",
    "activatedAt": null,
    "disabledAt": null,
    "lastLoginAt": null
  }
}
```

After this, show a pending activation message. Enrollment does not create a
session. The operator must run:

```bash
pnpm -F api run admin:auth -- activate --email admin@example.com --role admin
```

The enrollment TOTP code is consumed. If activation happens immediately, the
admin may need to wait for the next authenticator code before logging in.

## Login Flow

`POST /admin-auth/login`

Request:

```json
{
  "email": "admin@example.com",
  "password": "long-password-123",
  "totpCode": "123456"
}
```

Success:

```json
{
  "ok": true,
  "admin": {
    "id": "uuid",
    "email": "admin@example.com",
    "status": "active",
    "role": "admin",
    "createdAt": "2026-05-08T12:00:00.000Z",
    "invitedAt": "2026-05-08T12:00:00.000Z",
    "enrolledAt": "2026-05-08T12:05:00.000Z",
    "activatedAt": "2026-05-08T12:10:00.000Z",
    "disabledAt": null,
    "lastLoginAt": "2026-05-08T12:15:00.000Z"
  },
  "session": {
    "token": "opaque-session-token",
    "csrfToken": "opaque-csrf-token",
    "expiresAt": "2026-05-08T20:15:00.000Z"
  }
}
```

Frontend proxy requirements:

- Call this endpoint from a server route/proxy, not directly from browser
  client code.
- The frontend proxy must set `X-Hunch-Proxy-Secret` from the shared
  `HUNCH_PROXY_SECRET` env and `X-Hunch-Client-IP` from ingress-owned IP
  headers. Do not trust or re-sign a browser-supplied `X-Hunch-Client-IP`.
- Store `session.token` in an httpOnly cookie, recommended name
  `hunch_admin_session`.
- Store `session.csrfToken` in a readable cookie, recommended name
  `hunch_admin_csrf`.
- For admin API calls, send `Authorization: Bearer <session.token>`.
- For mutating admin API calls, also send `X-CSRF-Token: <csrfToken>`.

The browser should not expose `session.token` to client-side JS.

Login intentionally masks account status until credentials are proven. Unknown
emails, unconfigured accounts, and wrong passwords return generic
`invalid_credentials`.

## Session APIs

### Current Admin

`GET /admin-auth/me`

Headers:

```text
Authorization: Bearer <session.token>
```

Success:

```json
{
  "ok": true,
  "admin": {
    "id": "uuid",
    "email": "admin@example.com",
    "status": "active",
    "role": "admin",
    "createdAt": "2026-05-08T12:00:00.000Z",
    "invitedAt": "2026-05-08T12:00:00.000Z",
    "enrolledAt": "2026-05-08T12:05:00.000Z",
    "activatedAt": "2026-05-08T12:10:00.000Z",
    "disabledAt": null,
    "lastLoginAt": "2026-05-08T12:15:00.000Z"
  },
  "session": {
    "expiresAt": "2026-05-08T20:15:00.000Z"
  }
}
```

### Logout

`POST /admin-auth/logout`

Headers:

```text
Authorization: Bearer <session.token>
X-CSRF-Token: <csrfToken>
```

Success:

```json
{ "ok": true }
```

### Logout All

`POST /admin-auth/logout-all`

Headers:

```text
Authorization: Bearer <session.token>
X-CSRF-Token: <csrfToken>
```

Success:

```json
{ "ok": true, "revoked": 3 }
```

## Sadmin Admin Management APIs

These routes are for the future separate admin panel. They require a new admin
session with role `sadmin`.

Headers for every route:

```text
Authorization: Bearer <session.token>
```

Headers for every mutating route:

```text
X-CSRF-Token: <csrfToken>
```

### List Admins

`GET /admin-auth/admins`

Success:

```json
{
  "ok": true,
  "admins": [
    {
      "id": "uuid",
      "email": "admin@example.com",
      "status": "active",
      "role": "sadmin",
      "createdAt": "2026-05-08T12:00:00.000Z",
      "invitedAt": "2026-05-08T12:00:00.000Z",
      "enrolledAt": "2026-05-08T12:05:00.000Z",
      "activatedAt": "2026-05-08T12:10:00.000Z",
      "disabledAt": null,
      "lastLoginAt": "2026-05-08T12:15:00.000Z"
    }
  ]
}
```

### Invite Admin

`POST /admin-auth/admins/invite`

Request:

```json
{ "email": "new-admin@example.com" }
```

Success:

```json
{
  "ok": true,
  "admin": {
    "id": "uuid",
    "email": "new-admin@example.com",
    "status": "invited",
    "role": null,
    "createdAt": "2026-05-08T12:00:00.000Z",
    "invitedAt": "2026-05-08T12:00:00.000Z",
    "enrolledAt": null,
    "activatedAt": null,
    "disabledAt": null,
    "lastLoginAt": null
  },
  "enrollmentUrl": "https://admin.hunch.trade/enroll?token=<opaque-token>",
  "expiresAt": "2026-05-11T12:00:00.000Z"
}
```

### Activate Admin

`POST /admin-auth/admins/:id/activate`

Request:

```json
{ "role": "admin" }
```

Allowed role values are `sadmin`, `admin`, `viewer`, and `analyst`.

Success:

```json
{ "ok": true, "admin": { "id": "uuid", "status": "active", "role": "admin" } }
```

The account must already be `enrolled`.

### Change Admin Role

`POST /admin-auth/admins/:id/role`

Request:

```json
{ "role": "sadmin" }
```

Allowed role values are `sadmin`, `admin`, `viewer`, and `analyst`.

Success:

```json
{ "ok": true, "admin": { "id": "uuid", "status": "active", "role": "sadmin" } }
```

The account must already be `active`.

### Disable Admin

`POST /admin-auth/admins/:id/disable`

Success:

```json
{ "ok": true, "admin": { "id": "uuid", "status": "disabled", "role": null } }
```

Disabling an admin revokes all of that admin's sessions.

### Rotate Enrollment Link

`POST /admin-auth/admins/:id/rotate-link`

Success:

```json
{
  "ok": true,
  "admin": { "id": "uuid", "status": "invited", "role": null },
  "enrollmentUrl": "https://admin.hunch.trade/enroll?token=<opaque-token>",
  "expiresAt": "2026-05-11T12:00:00.000Z"
}
```

This resets the target account back to enrollment, clears password/TOTP state,
and revokes existing sessions. Use it for lost authenticator/password recovery.

### Revoke Admin Sessions

`POST /admin-auth/admins/:id/revoke-sessions`

Success:

```json
{ "ok": true, "revoked": 2 }
```

### Lockout Rules

The backend prevents these operations:

- A `sadmin` cannot disable their own account.
- A `sadmin` cannot demote their own account from `sadmin` to `admin`.
- A `sadmin` cannot rotate their own enrollment link.
- The last active `sadmin` cannot be disabled or demoted.
- The last active `sadmin` cannot have their enrollment link rotated.

### Audit Trail

Admin-management actions write to `admin_auth_attempts` with both target and
actor fields:

- Target fields: `admin_id`, `email`, `attempt_type`, `success`, `error_code`.
- Actor fields: `actor_admin_id`, `actor_email`, `actor_role`.

Panel actions currently audited with actor fields are invite, activate, role
change, disable, rotate enrollment link, and revoke sessions.

## Existing Admin APIs

Existing backend `/admin/*` routes keep their current paths and payloads.
During compatibility, they accept either:

- New admin session: `Authorization: Bearer <admin-session-token>`.
- Legacy app admin session, if `ADMIN_AUTH_LEGACY_FALLBACK=true`.

The new admin frontend should use only the new admin session path.

For new admin sessions, endpoints that grant or revoke admin powers require
`sadmin`. During compatibility, legacy app admin sessions keep their current
behavior while `ADMIN_AUTH_LEGACY_FALLBACK=true`.

Role permissions for new admin sessions:

- `sadmin`: all read/write/admin-management permissions.
- `admin`: operational read/write permissions, but no admin-account management.
- `viewer`: read-only admin panel permissions.
- `analyst`: admin-panel login only; no internal Hunch admin API data
  permissions.

## Error Codes

Errors use this shape:

```json
{
  "error": "invalid_totp",
  "message": "Invalid TOTP code"
}
```

`error` is the canonical field. `message` is optional because the API-wide
error sanitizer may strip it from non-success responses.

Known error codes:

- `admin_auth_disabled`
- `invalid_enrollment_token`
- `expired_enrollment_token`
- `used_enrollment_token`
- `weak_password`
- `invalid_totp`
- `totp_replay`
- `invalid_credentials`
- `admin_not_enrolled`
- `admin_pending_activation`
- `admin_disabled`
- `admin_session_expired`
- `admin_csrf_invalid`
- `admin_access_required`
- `sadmin_access_required`
- `admin_permission_required`
- `admin_invalid_role`
- `admin_not_found`
- `admin_self_action_forbidden`
- `admin_last_sadmin_forbidden`
- `rate_limit_exceeded`

Recommended frontend handling:

- `admin_not_enrolled`: ask operator for a fresh enrollment link.
- `admin_pending_activation`: show “Pending activation”.
- `admin_disabled`: show “Account disabled”.
- `admin_session_expired`: clear admin cookies and show login.
- `admin_csrf_invalid`: refresh session state; if repeated, clear cookies and log in again.
- `admin_self_action_forbidden`: block the action and explain that admins must use another `sadmin` account for self-demotion or disable.
- `admin_last_sadmin_forbidden`: require creating or promoting another `sadmin` first.

## Environment

Backend envs:

- `ADMIN_AUTH_ENABLED=true`
- `ADMIN_AUTH_LEGACY_FALLBACK=true`
- `ADMIN_APP_BASE_URL=https://admin.hunch.trade`
- `HUNCH_PROXY_SECRET=<shared frontend/backend secret>`
- `ADMIN_ENROLLMENT_TTL_MS=259200000`
- `ADMIN_SESSION_TTL_MS=28800000`
- `ADMIN_TOTP_ISSUER="Hunch Admin"`

`CREDENTIALS_ENCRYPTION_KEY` is required because TOTP secrets are encrypted with
the existing credentials encryption helper.

Proxy requirements:

- Backend and frontend proxy must use the same `HUNCH_PROXY_SECRET`.
- Nginx should overwrite standard forwarded IP headers with the direct client
  socket address before proxying to API/frontend containers.
- Keep `ADMIN_AUTH_LEGACY_FALLBACK=true` during migration only; disable it once
  the separate admin panel is fully verified.
