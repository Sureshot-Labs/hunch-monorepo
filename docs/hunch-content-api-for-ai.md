# Hunch Content Admin API for AI Agents

This guide explains how to issue a dedicated, revocable API key to an AI agent
and use the Hunch CMS through `/admin/content/*`. This is neither a user token
nor an MCP server: the agent calls a standard HTTP API with the minimum
permissions it needs.

The canonical contract is defined in:

- [`apps/api/src/routes/admin-content.ts`](../apps/api/src/routes/admin-content.ts);
- [`apps/api/src/schemas/content.ts`](../apps/api/src/schemas/content.ts);
- [`apps/api/src/routes/admin-service-principals.ts`](../apps/api/src/routes/admin-service-principals.ts);
- [`apps/api/src/services/admin-service-auth.ts`](../apps/api/src/services/admin-service-auth.ts).

If the examples below differ from these files, the code is the source of truth.

## Authentication model

The system separates a persistent identity from its secrets:

- a **service principal** is the stable identity of a specific agent or
  integration, such as `codex-content-editor-prod`;
- a **credential** is a revocable API key for that principal, with explicit
  permissions and an expiration time;
- a **human admin session** is the session of a real `sadmin`, required only to
  create, rotate, and revoke machine credentials.

An API key has the format `hsa_v1.<credential-id>.<secret>`. The server stores
only the secret HMAC, the prefix, and the last four characters. The complete
`token` is returned only when the credential is issued and cannot be retrieved
again.

A principal can have at most two active keys at the same time. This allows an
operator to issue a new key, switch the agent over, and then revoke the old key
without downtime.

## Backend preparation

Before issuing the first key, the operator must verify that:

1. Migration `0221_admin_service_principals.sql` has been applied.
2. `CONTENT_ENABLED=true`; otherwise, `/admin/content/*` routes are not
   registered.
3. Every API replica has the same stable `ADMIN_SERVICE_TOKEN_PEPPER`, at least
   32 characters long. Store it in the deployment secret manager. Changing the
   pepper invalidates all existing keys.
4. `ADMIN_SERVICE_CREDENTIAL_MAX_TTL_DAYS` defines the maximum key TTL; the
   default is 90 days.
5. Publishing additionally requires `CONTENT_PUBLISHING_ENABLED=true`. When
   `CONTENT_REQUIRE_APPROVAL=true`, content must be approved before it can be
   published.

Do not use an API key as the pepper, and do not store the pepper in the
repository.

## Permissions

| Permission        | Allowed operations                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `content:read`    | Operations status; read and search articles, versions, audit records, and assets.                                                  |
| `content:write`   | Create and edit drafts, issue preview tokens, perform review transitions, create checkpoints, restore versions, and manage assets. |
| `content:publish` | Approve, publish or schedule, cancel a schedule, unpublish, and archive.                                                           |

Recommended profiles:

- researcher or reviewer: `content:read`;
- editor: `content:read`, `content:write`;
- publisher: `content:read`, `content:write`, `content:publish`, only for a
  trusted process that publishes exclusively on an explicit command.

Permissions are not hierarchical: `content:publish` does not implicitly grant
`content:read`.

## Creating a key for an AI agent

Every endpoint in this section is available only to a human with an active
`sadmin` role. It requires the bearer session and CSRF token from the admin
authentication flow. Login details are documented in
[`docs/admin-auth-api.md`](./admin-auth-api.md). A machine API key cannot be
used to create other keys.

### Use Hunch Admin

When the Service Keys release is deployed, use the admin interface:

1. Sign in to `https://admin.hunch.trade` with an account that has the `sadmin`
   role.
2. Open **Service Keys** in the sidebar.
3. Select **New principal**. Use one unique lowercase kebab-case key for each
   agent and environment, then add a display name and an operator note.
4. Select **Issue key** for that principal. Choose the minimum permissions,
   enter a short TTL and an operator note, and issue the credential.
5. Copy the full token immediately into the agent's secret manager. The screen
   shows it only once.

The same screen lists active, expired, and revoked credentials. Use **Revoke**
for routine rotation and **Disable** as an emergency stop for the principal and
all of its active credentials.

### HTTP API fallback

If the deployed admin interface does not yet include **Service Keys**, issue
the credential through the HTTP API from an operator terminal. Use the same
email, password, and TOTP as the admin interface; the account must have the
`sadmin` role.

You do not need to extract an httpOnly cookie from the browser. Obtain a
separate, short-lived admin session directly through `/admin-auth/login`, then
follow the steps below.

#### 0. Obtain an sadmin session

Set the API address and read credentials safely without writing the password to
shell history:

```bash
set +x # shell tracing must not write secrets to logs
API_BASE="https://api.hunch.trade"

printf 'Admin email: '
IFS= read -r ADMIN_EMAIL
printf 'Admin password: '
IFS= read -rs ADMIN_PASSWORD
printf '\nTOTP: '
IFS= read -r ADMIN_TOTP

login_response="$(
  jq -n \
    --arg email "${ADMIN_EMAIL}" \
    --arg password "${ADMIN_PASSWORD}" \
    --arg totpCode "${ADMIN_TOTP}" \
    '{email: $email, password: $password, totpCode: $totpCode}' |
    curl -sS --fail-with-body \
      -H "Content-Type: application/json" \
      --data-binary @- \
      "${API_BASE%/}/admin-auth/login"
)"

printf '%s' "${login_response}" | jq -e \
  '.admin | {email, status, role}'
test "$(printf '%s' "${login_response}" | jq -r '.admin.role')" = "sadmin"

SADMIN_SESSION="$(printf '%s' "${login_response}" | jq -er '.session.token')"
SADMIN_CSRF="$(printf '%s' "${login_response}" | jq -er '.session.csrfToken')"

unset ADMIN_PASSWORD ADMIN_TOTP login_response
```

If the role is not `sadmin`, the account cannot issue keys. An existing
`sadmin` must either elevate the role or create the key. An admin session lasts
eight hours by default. After issuing the key, also remove `SADMIN_SESSION` and
`SADMIN_CSRF` from the shell.

#### 1. Create a service principal

Create a separate principal for each agent and environment:

```bash
principal_response="$(
  curl -sS --fail-with-body \
    -X POST \
    -H "Authorization: Bearer ${SADMIN_SESSION}" \
    -H "X-CSRF-Token: ${SADMIN_CSRF}" \
    -H "Content-Type: application/json" \
    -d '{
      "key": "codex-content-editor-prod",
      "displayName": "Codex Content Editor — production",
      "note": "Edits Hunch articles; publishing remains human-controlled"
    }' \
    "${API_BASE%/}/admin/service-principals"
)"

PRINCIPAL_ID="$(printf '%s' "${principal_response}" | jq -er '.principal.id')"
printf '%s' "${principal_response}" | jq '.principal'
unset principal_response
```

The `key` field must be unique lowercase kebab-case and 3–80 characters long.
`displayName` appears in the content audit as the actor label.

If the principal already exists, find its ID:

```bash
curl -sS --fail-with-body \
  -H "Authorization: Bearer ${SADMIN_SESSION}" \
  "${API_BASE%/}/admin/service-principals" | jq
```

#### 2. Issue a credential

The following example creates a 30-day editor key without publishing access:

```bash
credential_response="$(
  curl -sS --fail-with-body \
    -X POST \
    -H "Authorization: Bearer ${SADMIN_SESSION}" \
    -H "X-CSRF-Token: ${SADMIN_CSRF}" \
    -H "Content-Type: application/json" \
    -d '{
      "permissions": ["content:read", "content:write"],
      "ttlDays": 30,
      "note": "Initial credential for Codex content editor"
    }' \
    "${API_BASE%/}/admin/service-principals/${PRINCIPAL_ID}/credentials"
)"

CREDENTIAL_ID="$(printf '%s' "${credential_response}" | jq -er '.credential.id')"
HUNCH_ADMIN_API_KEY="$(printf '%s' "${credential_response}" | jq -er '.credential.token')"
export HUNCH_ADMIN_API_KEY

# Display metadata safely without printing the token.
printf '%s' "${credential_response}" | jq '.credential | del(.token)'
unset credential_response
```

Immediately save `HUNCH_ADMIN_API_KEY` in the agent's secret manager. Do not
send it through chat, issues, logs, or URLs; do not commit it to `.env`; and do
not print it with `echo`. The issuance response includes `token` exactly once.
A subsequent list request returns only the credential ID, prefix, last four
characters, permissions, expiration, and last-used time.

### Connect the agent

The agent runtime needs only two variables:

```bash
export HUNCH_ADMIN_API_BASE_URL="https://<api-host>"
export HUNCH_ADMIN_API_KEY="<load-from-secret-manager>"
```

The Codex instructions in this repository are located at
`.agents/skills/hunch-content-api/SKILL.md`. For content tasks, the agent must
use this skill and must never ask for the key to be pasted into the
conversation.

Verify access:

```bash
curl -sS --fail-with-body \
  -H "Authorization: Bearer ${HUNCH_ADMIN_API_KEY}" \
  -H "Accept: application/json" \
  "${HUNCH_ADMIN_API_BASE_URL%/}/admin/content/operations" | jq
```

A machine API key does not require a CSRF header. Send the key only in
`Authorization: Bearer ...` and only over HTTPS, except in an explicitly local
test.

## Core article workflow

### Read the article list and an article

```bash
curl -sS --fail-with-body \
  -H "Authorization: Bearer ${HUNCH_ADMIN_API_KEY}" \
  "${HUNCH_ADMIN_API_BASE_URL%/}/admin/content/articles?status=draft&limit=25" | jq

curl -sS --fail-with-body \
  -H "Authorization: Bearer ${HUNCH_ADMIN_API_KEY}" \
  "${HUNCH_ADMIN_API_BASE_URL%/}/admin/content/articles/${ARTICLE_ID}" | jq
```

Supported filters are `status`, `q`, `limit`, and cursor pagination.

### Create a draft

The minimum request body contains `slug` and `title`:

```bash
curl -sS --fail-with-body \
  -X POST \
  -H "Authorization: Bearer ${HUNCH_ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "prediction-markets-guide",
    "title": "Prediction Markets Guide",
    "contentKind": "guide",
    "excerpt": "A practical introduction to prediction markets."
  }' \
  "${HUNCH_ADMIN_API_BASE_URL%/}/admin/content/articles" | jq
```

Create and action POST requests must not be treated as idempotent. If the
connection drops after sending a request, first find the article and inspect
the audit trail instead of blindly repeating the POST.

### Edit a draft

Every article update uses optimistic concurrency. Before a mutation, read the
article again and pass the current `article.draft.revision`:

```bash
curl -sS --fail-with-body \
  -X PATCH \
  -H "Authorization: Bearer ${HUNCH_ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "expectedRevision": 3,
    "excerpt": "Updated summary."
  }' \
  "${HUNCH_ADMIN_API_BASE_URL%/}/admin/content/articles/${ARTICLE_ID}" | jq
```

On `409 content_revision_conflict`, the agent must reread the article and
report the conflict. It must not overwrite or repeat the mutation
automatically.

### Review and publishing

The primary flow is:

```text
draft -> in_review -> approved -> published
                              \-> scheduled
```

Action endpoints accept `{"expectedRevision": <current revision>}`:

| Operation         | Endpoint                                           | Permission        |
| ----------------- | -------------------------------------------------- | ----------------- |
| Submit for review | `POST /admin/content/articles/:id/submit-review`   | `content:write`   |
| Return to draft   | `POST /admin/content/articles/:id/return-draft`    | `content:write`   |
| Approve           | `POST /admin/content/articles/:id/approve`         | `content:publish` |
| Publish now       | `POST /admin/content/articles/:id/publish`         | `content:publish` |
| Schedule          | The same publish endpoint with ISO `publishAt`     | `content:publish` |
| Cancel schedule   | `POST /admin/content/articles/:id/cancel-schedule` | `content:publish` |
| Unpublish         | `POST /admin/content/articles/:id/unpublish`       | `content:publish` |
| Archive           | `POST /admin/content/articles/:id/archive`         | `content:publish` |

Publishing example:

```bash
curl -sS --fail-with-body \
  -X POST \
  -H "Authorization: Bearer ${HUNCH_ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"expectedRevision": 5}' \
  "${HUNCH_ADMIN_API_BASE_URL%/}/admin/content/articles/${ARTICLE_ID}/publish" | jq
```

An AI agent must not approve, publish, unpublish, or archive content without an
explicit user command, even when its credential technically has the
`content:publish` permission.

## Versions, audit, and restore

- `POST /admin/content/articles/:id/versions` creates a checkpoint;
- `GET /admin/content/articles/:id/versions` lists versions;
- `GET /admin/content/articles/:id/versions/:versionId` returns a specific
  version;
- `POST /admin/content/articles/:id/versions/:versionId/restore` restores a
  version using the current `expectedRevision`;
- `GET /admin/content/articles/:id/audit` returns the action history and
  service actor.

A restore creates a new revision and must not bypass conflict checks.

## Assets

An upload always has three steps:

1. `POST /admin/content/assets` with the MIME type, exact byte size, and SHA-256
   creates an asset and returns a signed `upload.url`, method, and required
   headers.
2. Upload the file directly to storage through the signed URL, using the exact
   headers from the response. The bytes do not pass through the admin API.
3. `POST /admin/content/assets/:id/complete` submits the actual byte size,
   checksum, and media dimensions or duration.

Signed upload URLs and API keys must not be logged or included in an agent
report. The following metadata endpoints are available:

- `GET /admin/content/assets` and `GET /admin/content/assets/:id`;
- `PATCH /admin/content/assets/:id`;
- `DELETE /admin/content/assets/:id`.

## Rotation, revocation, and emergency stop

Zero-downtime rotation:

1. Issue a second credential for the same principal.
2. Save the new token in the secret manager and switch the agent runtime.
3. Verify `GET /admin/content/operations` with the new key.
4. Revoke the old credential:

```bash
curl -sS --fail-with-body \
  -X POST \
  -H "Authorization: Bearer ${SADMIN_SESSION}" \
  -H "X-CSRF-Token: ${SADMIN_CSRF}" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Rotated after deployment"}' \
  "${API_BASE%/}/admin/service-credentials/${OLD_CREDENTIAL_ID}/revoke" | jq
```

To disable a principal and all of its active credentials completely:

```bash
curl -sS --fail-with-body \
  -X POST \
  -H "Authorization: Bearer ${SADMIN_SESSION}" \
  -H "X-CSRF-Token: ${SADMIN_CSRF}" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Agent access disabled"}' \
  "${API_BASE%/}/admin/service-principals/${PRINCIPAL_ID}/disable" | jq
```

Disable is a kill switch, not a routine rotation operation. There is currently
no endpoint for re-enabling a principal.

## Errors and safe agent behavior

| HTTP  | Required behavior                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------ |
| `401` | The key is invalid, expired, or revoked. Stop and request rotation without exposing the key.                       |
| `403` | A permission is missing or the endpoint requires a human admin. Do not bypass the check.                           |
| `409` | Reread the resource and report the revision or slug conflict; do not retry blindly.                                |
| `429` | Apply backoff. The service-auth limit is 120 requests per minute for each security client IP.                      |
| `503` | Authentication, storage, publishing, or the database is temporarily unavailable; honor `Retry-After` when present. |

In its report, the agent should include the operation, article or asset ID, new
revision or status, and required follow-up. It must never include an API key,
Authorization header, signed upload URL, or an unprocessed internal error body.

## Short operational checklist

- Use a separate principal for every agent and environment.
- Grant minimum permissions; do not grant `content:publish` by default.
- Use a short TTL and set a calendar reminder for rotation.
- Store keys and the pepper only in a secret manager.
- Call `GET /admin/content/operations` before a working session.
- Read before writing and always supply `expectedRevision`.
- Never blindly retry create or action POST requests.
- Publish and archive only on an explicit command.
- Regularly inspect `lastUsedAt`, expiration, and the audit trail.
