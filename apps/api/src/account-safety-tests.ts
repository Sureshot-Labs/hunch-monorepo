import assert from "node:assert/strict";
import { PNG } from "pngjs";
import {
  S3Client,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
  GetInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  RekognitionClient,
  DetectModerationLabelsCommand,
} from "@aws-sdk/client-rekognition";
import { resolveContentRuntimeConfig } from "@hunch/config/content";
import { configureContentServiceRuntime } from "./content-service-runtime.js";
import {
  eraseObjectVersions,
  invalidateStoredContent,
  StorageErasureInProgress,
} from "./services/content-storage-erasure.js";
import {
  checkAvatarContent,
  isSocialTextAllowed,
  requireAllowedSocialText,
} from "./services/social-content-filter.js";
import {
  recordAccountErasure,
  erasureJournalConfig,
} from "./services/account-erasure-journal.js";
import { adultConfirmationBodySchema } from "./schemas/auth.js";
import { adminSocialModerationBodySchema } from "./schemas/admin-social.js";

const uuid = "10000000-0000-4000-8000-000000000001";
assert.equal(
  adultConfirmationBodySchema.safeParse({ isAtLeast18: true, policyVersion: 1 })
    .success,
  true,
);
for (const body of [
  { isAtLeast18: false, policyVersion: 1 },
  { isAtLeast18: true },
  { isAtLeast18: true, policyVersion: 2 },
  { isAtLeast18: true, policyVersion: 1, birthDate: "2000-01-01" },
])
  assert.equal(adultConfirmationBodySchema.safeParse(body).success, false);
assert.equal(
  adminSocialModerationBodySchema.safeParse({
    target: { kind: "user", id: uuid },
    action: "remove_avatar",
    expectedAvatarUrl: "https://cdn.example/avatar.jpg",
    reason: "Objectionable avatar",
  }).success,
  true,
);
assert.equal(
  adminSocialModerationBodySchema.safeParse({
    target: { kind: "thesis", id: uuid },
    action: "remove_avatar",
    reason: "Invalid",
  }).success,
  false,
);
for (const text of [
  "I will kill you",
  "fu\u200bck",
  "ＦＵＣＫ",
  "убей себя",
  "пидорас",
  "faggot",
])
  assert.equal(isSocialTextAllowed(text), false, text);
for (const text of [
  "Bitcoin is volatile",
  "I disagree with your thesis",
  "The court heard a murder case",
  "Политические выборы завтра",
  "Scunthorpe and Arsenal",
  "🤔 60% probability",
])
  assert.equal(isSocialTextAllowed(text), true, text);
assert.throws(() => requireAllowedSocialText("I will kill you"), {
  code: "content_not_allowed",
});

let remaining = 1501;
let deleted = 0;
const s3 = {
  send: async (command: unknown) => {
    if (command instanceof DeleteObjectCommand) return {};
    if (command instanceof ListObjectVersionsCommand) {
      assert.equal(command.input.Prefix, "content/avatar.jpg");
      const size = Math.min(remaining, 999);
      return {
        Versions: Array.from({ length: size }, (_, i) => ({
          Key: "content/avatar.jpg",
          VersionId: String(i),
        })),
        DeleteMarkers: remaining
          ? [{ Key: "content/avatar.jpg", VersionId: "marker" }]
          : [],
        // A prefix match must never delete a neighbour.
        ...(remaining === 0
          ? {
              Versions: [
                { Key: "content/avatar.jpg.other", VersionId: "keep" },
              ],
            }
          : {}),
      };
    }
    assert.ok(command instanceof DeleteObjectsCommand);
    assert.ok(
      command.input.Delete?.Objects?.every(
        (item) => item.Key === "content/avatar.jpg" && item.VersionId,
      ),
    );
    const size = (command.input.Delete?.Objects?.length ?? 0) - 1;
    remaining -= size;
    deleted += size;
    return {};
  },
} as unknown as Pick<S3Client, "send">;
await eraseObjectVersions(s3, "test-bucket", "content/avatar.jpg");
assert.equal(deleted, 1501);
await assert.rejects(
  eraseObjectVersions(
    {
      send: async (command: unknown) => {
        if (command instanceof ListObjectVersionsCommand)
          return { Versions: [{ Key: "content/x", VersionId: "v1" }] };
        return {};
      },
    } as unknown as Pick<S3Client, "send">,
    "test",
    "content/x",
  ),
  StorageErasureInProgress,
);
await assert.rejects(
  eraseObjectVersions(
    {
      send: async (command: unknown) => {
        if (command instanceof ListObjectVersionsCommand)
          return { Versions: [{ Key: "content/x", VersionId: "v1" }] };
        if (command instanceof DeleteObjectsCommand)
          return { Errors: [{ Code: "AccessDenied" }] };
        return {};
      },
    } as unknown as Pick<S3Client, "send">,
    "test",
    "content/x",
  ),
  /incomplete/,
);

configureContentServiceRuntime(
  resolveContentRuntimeConfig(
    {
      CONTENT_ASSET_S3_BUCKET: "test",
      CONTENT_ASSET_PUBLIC_BASE_URL: "https://test.cloudfront.net",
      CONTENT_ASSET_CLOUDFRONT_DISTRIBUTION_ID: "test-distribution",
    },
    "test",
  ),
);
let invalidations = 0;
const cf = {
  send: async (command: unknown) => {
    if (command instanceof CreateInvalidationCommand) {
      invalidations += 1;
      assert.deepEqual(command.input.InvalidationBatch?.Paths?.Items, [
        "/content/avatar.jpg",
      ]);
      assert.equal(
        command.input.InvalidationBatch?.CallerReference,
        "stable-job-generation",
      );
      return {
        Invalidation: { Id: "test-invalidation", Status: "InProgress" },
      };
    }
    assert.ok(command instanceof GetInvalidationCommand);
    assert.equal(command.input.Id, "test-invalidation");
    return { Invalidation: { Id: "test-invalidation", Status: "Completed" } };
  },
} as unknown as Pick<CloudFrontClient, "send">;
assert.deepEqual(
  await invalidateStoredContent(
    "content-staging/private.jpg",
    "generation",
    null,
    cf,
  ),
  { id: null, completed: true },
);
assert.equal(
  (
    await invalidateStoredContent(
      "content/avatar.jpg",
      "stable-job-generation",
      null,
      cf,
    )
  ).completed,
  false,
);
assert.equal(
  (
    await invalidateStoredContent(
      "content/avatar.jpg",
      "stable-job-generation",
      "test-invalidation",
      cf,
    )
  ).completed,
  true,
);
assert.equal(invalidations, 1);

const avatarPng = PNG.sync.write(new PNG({ width: 80, height: 80 }));
for (const [labels, rejected] of [
  [[], false],
  [[{ Name: "Explicit", Confidence: 99 }], true],
  [[{ Name: "Hate Symbols", Confidence: 79 }], false],
] as const) {
  const operation = checkAvatarContent(avatarPng, {
    send: async (command: unknown) => {
      assert.ok(command instanceof DetectModerationLabelsCommand);
      return { ModerationLabels: labels, ModerationModelVersion: "test" };
    },
  } as unknown as Pick<RekognitionClient, "send">);
  if (rejected)
    await assert.rejects(operation, { code: "content_not_allowed" });
  else await operation;
}
await assert.rejects(
  checkAvatarContent(avatarPng, {
    send: async () => {
      throw new Error("unavailable");
    },
  } as unknown as Pick<RekognitionClient, "send">),
  { code: "avatar_check_unavailable" },
);
assert.throws(
  () =>
    erasureJournalConfig({
      ACCOUNT_ERASURE_JOURNAL_BUCKET: "public",
      CONTENT_ASSET_S3_BUCKET: "public",
    }),
  /separate private/,
);
let journalRecord: unknown;
const journalEnv = {
  ACCOUNT_ERASURE_JOURNAL_BUCKET: "private-journal",
  CONTENT_ASSET_S3_BUCKET: "public-assets",
};
await recordAccountErasure(
  uuid,
  {
    send: async (command: unknown) => {
      assert.ok(command instanceof PutObjectCommand);
      assert.equal(command.input.IfNoneMatch, "*");
      journalRecord = JSON.parse(String(command.input.Body));
      assert.deepEqual(Object.keys(journalRecord as object).sort(), [
        "requestedAt",
        "schemaVersion",
        "userId",
      ]);
      return {};
    },
  } as unknown as Pick<S3Client, "send">,
  journalEnv,
);
await recordAccountErasure(
  uuid,
  {
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        if (command.input.IfNoneMatch === "*")
          throw { $metadata: { httpStatusCode: 412 } };
        assert.equal(command.input.IfMatch, '"journal-etag"');
        return {};
      }
      assert.ok(command instanceof GetObjectCommand);
      return {
        ETag: '"journal-etag"',
        ContentLength: 160,
        Body: { transformToString: async () => JSON.stringify(journalRecord) },
      };
    },
  } as unknown as Pick<S3Client, "send">,
  journalEnv,
);
console.log(
  "[account-safety] passed: age contract, text rules, avatar check, all S3 versions, exact keys, partial failures, CDN polling, private durable journal",
);
