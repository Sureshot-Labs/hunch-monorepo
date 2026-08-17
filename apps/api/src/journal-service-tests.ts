#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Pool } from "@hunch/infra";

import { reserveDistributedBudgetStatus } from "./lib/rate-limit.js";
import {
  authenticateJournalServiceCredential,
  journalServiceTokenHmac,
} from "./services/journal-service-auth.js";
import {
  journalServiceAssetCreateBodySchema,
  journalServiceAssetUpdateBodySchema,
  journalServiceIdempotencyHeadersSchema,
} from "./schemas/content.js";
import { journalServiceAsset } from "./services/content-assets.js";
import {
  journalServiceArticle,
  journalServiceContentAuditEvent,
  journalServiceVersion,
  type ContentArticle,
  type ContentArticleVersion,
} from "./services/content.js";
import {
  journalIdempotencyResourceForClaim,
  JournalIdempotencyError,
  type JournalIdempotencyClaim,
} from "./services/journal-idempotency.js";

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
await assert.rejects(
  () => reserveDistributedBudgetStatus("daily", 100, 1_000, 60_000, ""),
  /reservation identifier are invalid/,
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
const unsafeCreditUrl = {
  originalFilename: "capture.png",
  mimeType: "image/png",
  expectedByteSize: 100,
  checksumSha256: "0".repeat(64),
  sourceType: "app-screenshot",
  creditUrl: "javascript:alert(1)",
};
assert.equal(
  journalServiceAssetCreateBodySchema.safeParse(unsafeCreditUrl).success,
  false,
  "service uploads must reject non-HTTP(S) credit URLs",
);
assert.equal(
  journalServiceAssetUpdateBodySchema.safeParse({
    creditUrl: "https://user:password@example.com/credit",
  }).success,
  false,
  "asset updates must reject URLs containing credentials",
);

const replayClaim: JournalIdempotencyClaim = {
  rowId: "1",
  leaseOwner: null,
  resourceId: "00000000-0000-4000-8000-000000000104",
  replay: true,
  reclaimed: false,
  httpStatus: 201,
  response: { articleId: "00000000-0000-4000-8000-000000000104" },
};
assert.throws(
  () => journalIdempotencyResourceForClaim(replayClaim, null, "article"),
  (error: unknown) =>
    error instanceof JournalIdempotencyError &&
    error.code === "idempotency_result_unavailable" &&
    error.statusCode === 409,
  "a replay must not recreate a resource that was deleted after creation",
);
assert.equal(
  journalIdempotencyResourceForClaim(
    { ...replayClaim, replay: false },
    null,
    "article",
  ),
  null,
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

const sanitizedArticle = journalServiceArticle({
  createdByAdminId: adminActorId,
  updatedByAdminId: adminActorId,
  publishedByAdminId: adminActorId,
  createdByServicePrincipalId: principalId,
  updatedByServicePrincipalId: principalId,
  draft: {
    updatedByAdminId: adminActorId,
    updatedByServicePrincipalId: principalId,
    title: "Visible title",
  },
} as unknown as ContentArticle);
assert.equal("createdByAdminId" in sanitizedArticle, false);
assert.equal("updatedByAdminId" in sanitizedArticle, false);
assert.equal("publishedByAdminId" in sanitizedArticle, false);
assert.equal("updatedByAdminId" in sanitizedArticle.draft, false);
assert.equal(sanitizedArticle.createdByServicePrincipalId, principalId);
assert.equal(sanitizedArticle.draft.updatedByServicePrincipalId, principalId);

const sanitizedVersion = journalServiceVersion({
  id: credentialId,
  createdByAdminId: adminActorId,
  createdByServicePrincipalId: principalId,
} as unknown as ContentArticleVersion);
assert.equal("createdByAdminId" in sanitizedVersion, false);
assert.equal(sanitizedVersion.createdByServicePrincipalId, principalId);

const sanitizedAudit = journalServiceContentAuditEvent({
  id: "1",
  action: "article.scheduled_publication_completed",
  articleId: credentialId,
  assetId: null,
  versionId: null,
  actorAdminId: adminActorId,
  actorServicePrincipalId: null,
  actorKind: "admin",
  actorLabel: "admin@example.com",
  actor: {
    kind: "admin",
    id: adminActorId,
    label: "admin@example.com",
  },
  metadata: {
    initiatedBy: {
      kind: "admin",
      id: adminActorId,
      label: `admin:${adminActorId}`,
    },
    currentRevision: 2,
  },
  createdAt: "2026-08-17T12:00:00.000Z",
});
const sanitizedAuditJson = JSON.stringify(sanitizedAudit);
assert.equal("actorAdminId" in sanitizedAudit, false);
assert.equal(sanitizedAudit.actor.id, null);
assert.equal(sanitizedAudit.actor.label, "human-admin");
assert.equal(sanitizedAuditJson.includes(adminActorId), false);
assert.equal(sanitizedAuditJson.includes("admin@example.com"), false);
assert.deepEqual(sanitizedAudit.metadata.initiatedBy, { kind: "admin" });

const authSource = readFileSync(
  new URL("./services/journal-service-auth.ts", import.meta.url),
  "utf8",
);
assert.match(authSource, /row\?\.token_hmac \?\? "0"\.repeat\(64\)/);
assert.match(authSource, /timingSafeEqual/);
assert.doesNotMatch(authSource, /positive.*cache|credentialCache/i);
