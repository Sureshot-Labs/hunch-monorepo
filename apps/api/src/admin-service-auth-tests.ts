#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
  adminServiceHasPermissions,
  adminServiceTokenHmac,
  authenticateAdminServiceCredential,
  isAdminServiceToken,
} from "./services/admin-service-auth.js";

const credentialId = "00000000-0000-4000-8000-000000000101";
const principalId = "00000000-0000-4000-8000-000000000102";
const token = `hsa_v1.${credentialId}.${"A".repeat(43)}`;
const pepper = "admin-service-test-pepper-value-32-bytes";
const nowMs = Date.parse("2026-08-18T12:00:00.000Z");

function authPool(
  overrides: Partial<{
    token_hmac: string;
    permissions: string[];
    expires_at: string;
    revoked_at: string | null;
    principal_status: "active" | "disabled";
  }> = {},
  lookupFailure = false,
): Pool {
  return {
    async query(sql: string) {
      if (sql.includes("from admin_service_credentials")) {
        if (lookupFailure) throw new Error("database unavailable");
        return {
          rows: [
            {
              credential_id: credentialId,
              service_principal_id: principalId,
              token_hmac: adminServiceTokenHmac(token, pepper),
              token_prefix: token.slice(0, 16),
              permissions: ["content:read", "content:write"],
              expires_at: "2026-09-18T12:00:00.000Z",
              revoked_at: null,
              principal_key: "codex-content-editor",
              principal_display_name: "Codex Content Editor",
              principal_status: "active",
              ...overrides,
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
}

assert.equal(isAdminServiceToken(token), true);
assert.equal(isAdminServiceToken("hsa_v1.malformed"), true);
assert.equal(isAdminServiceToken("admin-session-token"), false);

const valid = await authenticateAdminServiceCredential(authPool(), token, {
  pepper,
  nowMs,
});
assert.equal(valid.ok, true);
if (valid.ok) {
  assert.equal(valid.principal.id, principalId);
  assert.deepEqual(valid.credential.permissions, [
    "content:read",
    "content:write",
  ]);
}

const modified = await authenticateAdminServiceCredential(
  authPool(),
  `${token.slice(0, -1)}B`,
  { pepper, nowMs },
);
assert.deepEqual(modified.ok ? null : [modified.statusCode, modified.error], [
  401,
  "invalid_admin_service_credential",
]);

for (const [overrides, expected] of [
  [
    { revoked_at: "2026-08-18T11:00:00.000Z" },
    "revoked_admin_service_credential",
  ],
  [
    { expires_at: "2026-08-18T11:59:59.000Z" },
    "expired_admin_service_credential",
  ],
  [{ principal_status: "disabled" }, "disabled_admin_service_principal"],
] as const) {
  const result = await authenticateAdminServiceCredential(
    authPool(overrides),
    token,
    { pepper, nowMs },
  );
  assert.equal(result.ok ? null : result.error, expected);
}

const unavailable = await authenticateAdminServiceCredential(
  authPool({}, true),
  token,
  { pepper, nowMs },
);
assert.deepEqual(
  unavailable.ok ? null : [unavailable.statusCode, unavailable.error],
  [503, "admin_service_auth_unavailable"],
);

assert.equal(
  adminServiceHasPermissions(
    ["content:read", "content:write"],
    ["content:read"],
  ),
  true,
);
assert.equal(
  adminServiceHasPermissions(["content:write"], ["content:publish"]),
  false,
);
assert.equal(
  adminServiceHasPermissions(
    ["content:read", "content:write"],
    ["content:read", "content:write"],
  ),
  true,
);

console.log("[admin-service-auth-tests] passed");
