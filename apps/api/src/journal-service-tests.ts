#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Pool } from "@hunch/infra";

import {
  authenticateJournalServiceCredential,
  journalServiceTokenHmac,
} from "./services/journal-service-auth.js";
import {
  journalServiceAssetCreateBodySchema,
  journalServiceIdempotencyHeadersSchema,
} from "./schemas/content.js";
import { journalServiceAsset } from "./services/content-assets.js";

const credentialId = "00000000-0000-4000-8000-000000000101";
const principalId = "00000000-0000-4000-8000-000000000102";
const adminActorId = "00000000-0000-4000-8000-000000000103";
const token = `hjs_v1.${credentialId}.${"A".repeat(43)}`;
const pepper = "journal-service-test-pepper-value-32-bytes";
const nowMs = Date.parse("2026-08-17T12:00:00.000Z");

type RowOverrides = Partial<{
  token_hmac: string;
  expires_at: string;
  revoked_at: string | null;
  principal_status: "active" | "disabled";
  scopes: string[];
}>;

function authPool(overrides: RowOverrides = {}, lookupFailure = false): Pool {
  return {
    async query(sql: string) {
      if (sql.includes("from admin_service_credentials")) {
        if (lookupFailure) throw new Error("database unavailable");
        return {
          rows: [
            {
              credential_id: credentialId,
              service_principal_id: principalId,
              token_hmac: journalServiceTokenHmac(token, pepper),
              token_prefix: token.slice(0, 16),
              scopes: ["journal:read", "journal:draft:update"],
              expires_at: "2026-09-17T12:00:00.000Z",
              revoked_at: null,
              principal_key: "codex-journal-editor",
              principal_display_name: "Codex Journal Editor",
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

const valid = await authenticateJournalServiceCredential(authPool(), token, {
  pepper,
  nowMs,
});
assert.equal(valid.ok, true);
if (valid.ok) {
  assert.equal(valid.principal.id, principalId);
  assert.deepEqual(valid.credential.scopes, [
    "journal:read",
    "journal:draft:update",
  ]);
}

const modified = await authenticateJournalServiceCredential(
  authPool(),
  `${token.slice(0, -1)}B`,
  { pepper, nowMs },
);
assert.deepEqual(modified.ok ? null : [modified.statusCode, modified.error], [
  401,
  "invalid_service_credential",
]);

const revoked = await authenticateJournalServiceCredential(
  authPool({ revoked_at: "2026-08-17T11:00:00.000Z" }),
  token,
  { pepper, nowMs },
);
assert.equal(revoked.ok ? null : revoked.error, "revoked_service_credential");

const expired = await authenticateJournalServiceCredential(
  authPool({ expires_at: "2026-08-17T11:59:59.000Z" }),
  token,
  { pepper, nowMs },
);
assert.equal(expired.ok ? null : expired.error, "expired_service_credential");

const disabled = await authenticateJournalServiceCredential(
  authPool({ principal_status: "disabled" }),
  token,
  { pepper, nowMs },
);
assert.equal(disabled.ok ? null : disabled.error, "disabled_service_principal");

const unavailable = await authenticateJournalServiceCredential(
  authPool({}, true),
  token,
  { pepper, nowMs },
);
assert.deepEqual(
  unavailable.ok ? null : [unavailable.statusCode, unavailable.error],
  [503, "service_auth_unavailable"],
);

assert.equal(
  journalServiceIdempotencyHeadersSchema.safeParse({
    "idempotency-key": "retry.key:0001",
  }).success,
  true,
);
assert.equal(
  journalServiceIdempotencyHeadersSchema.safeParse({
    "idempotency-key": "short",
  }).success,
  false,
);
assert.equal(
  journalServiceAssetCreateBodySchema.safeParse({
    kind: "video",
    originalFilename: "clip.mp4",
    mimeType: "video/mp4",
    expectedByteSize: 100,
    checksumSha256: "0".repeat(64),
    sourceType: "app-screenshot",
  }).success,
  false,
  "service upload schema must not accept a client-selected kind",
);

const sanitizedAsset = journalServiceAsset({
  id: "00000000-0000-4000-8000-000000000103",
  status: "ready",
  kind: "image",
  storageKey: "staging/internal-key",
  publicUrl: "https://cdn.example.com/image.png",
  originalFilename: "image.png",
  mimeType: "image/png",
  byteSize: 100,
  width: 1,
  height: 1,
  durationMs: null,
  checksumSha256: "0".repeat(64),
  defaultAlt: "Alt",
  defaultCaption: null,
  creditName: null,
  creditUrl: null,
  focalX: null,
  focalY: null,
  metadata: { stagingSecret: "never-return" },
  createdByAdminId: adminActorId,
  createdByServicePrincipalId: principalId,
  updatedByAdminId: adminActorId,
  updatedByServicePrincipalId: principalId,
  createdAt: "2026-08-17T12:00:00.000Z",
  updatedAt: "2026-08-17T12:00:00.000Z",
  readyAt: "2026-08-17T12:00:00.000Z",
  deletedAt: null,
});
assert.equal("storageKey" in sanitizedAsset, false);
assert.equal("metadata" in sanitizedAsset, false);
assert.equal("createdByAdminId" in sanitizedAsset, false);
assert.equal("updatedByAdminId" in sanitizedAsset, false);
assert.equal("deletedAt" in sanitizedAsset, false);
assert.equal(sanitizedAsset.createdByServicePrincipalId, principalId);

const authSource = readFileSync(
  new URL("./services/journal-service-auth.ts", import.meta.url),
  "utf8",
);
assert.match(authSource, /row\?\.token_hmac \?\? "0"\.repeat\(64\)/);
assert.match(authSource, /timingSafeEqual/);
assert.doesNotMatch(authSource, /positive.*cache|credentialCache/i);
