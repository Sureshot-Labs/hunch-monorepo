---
name: hunch-content-api
description: Read, create, edit, review, publish, archive, and manage media for Hunch articles through the existing scoped admin HTTP API. Use for Hunch CMS work that should authenticate with an admin service API key; do not use this skill to create keys, manage human admins, or introduce an MCP server.
---

# Hunch Content API

Use the existing `/admin/content/*` HTTP surface directly. Keep authentication and authorization on the API; keep this skill instruction-only.

## Prepare

1. Require `HUNCH_ADMIN_API_BASE_URL` and `HUNCH_ADMIN_API_KEY` in the secure process environment. Ask the user to configure them outside chat when missing; never ask them to paste a key into the conversation.
2. Never print, persist, or place the key in a URL. Send it only as `Authorization: Bearer $HUNCH_ADMIN_API_KEY` over HTTPS, except for an explicitly requested localhost test.
3. In a source checkout, read `apps/api/src/routes/admin-content.ts` and the relevant definitions in `apps/api/src/schemas/content.ts` before constructing a request. Treat them as the canonical contract instead of copying schemas into this skill.
4. Call `GET /admin/content/operations` first to verify access. Stop on `401`; report the missing permission on `403`; back off on `429`.

## Execute

- Use `content:read` only for reads, `content:write` for drafts, review transitions, checkpoints, restores, and assets, and `content:publish` for approval, publication, unpublication, or archival.
- Read the current article immediately before a mutation and send its current `expectedRevision`. On `409`, refetch and show the conflict; never overwrite or retry blindly.
- Treat create and action POSTs as non-idempotent. If a transport failure leaves the outcome ambiguous, inspect the resource or audit log before retrying.
- Publish, unpublish, approve, or archive only when the user explicitly requested that state change. A request to edit a draft does not authorize publication.
- For assets, follow the API's three steps: create the upload intent, upload directly to the returned signed storage URL with the exact required checksum and headers, then complete the asset through the API. Do not proxy file bytes through the admin API.
- Use credential-free `http` or `https` credit URLs only. Do not send embedded credentials, `javascript:` URLs, or arbitrary document fields.

Use a direct HTTP client such as:

```sh
curl -sS --fail-with-body \
  -H "Authorization: Bearer ${HUNCH_ADMIN_API_KEY}" \
  -H "Accept: application/json" \
  "${HUNCH_ADMIN_API_BASE_URL%/}/admin/content/operations"
```

For writes, add `Content-Type: application/json` and send only fields accepted by the current Zod schema.

## Report

Return the operation, article or asset ID, resulting revision/status, and any follow-up required. Never include the API key, authorization header, signed upload URL, or raw internal error body.
