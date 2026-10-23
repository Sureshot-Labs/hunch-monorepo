import assert from "node:assert/strict";
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
import { resolveContentRuntimeConfig } from "@hunch/config/content";
import { configureContentServiceRuntime } from "./content-service-runtime.js";
import {
  eraseObjectVersions,
  invalidateStoredContent,
  StorageErasureInProgress,
} from "./services/content-storage-erasure.js";
import {
  recordAccountErasure,
  erasureJournalConfig,
} from "./services/account-erasure-journal.js";
const uuid = "10000000-0000-4000-8000-000000000001";

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
      CONTENT_ASSET_PUBLIC_BASE_URL: "https://images.example.test",
    },
    "test",
  ),
);
await assert.rejects(
  invalidateStoredContent("content/avatar.jpg", "test-generation", null),
  /distribution is not configured/,
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

assert.throws(
  () =>
    erasureJournalConfig({
      ACCOUNT_ERASURE_JOURNAL_BUCKET: "public",
      CONTENT_ASSET_S3_BUCKET: "public",
    }),
  /separate private/,
);
await assert.rejects(
  recordAccountErasure(
    uuid,
    {
      send: async () => {
        throw new Error("journal unavailable");
      },
    } as unknown as Pick<S3Client, "send">,
    {
      ACCOUNT_ERASURE_JOURNAL_BUCKET: "private-journal",
      CONTENT_ASSET_S3_BUCKET: "public-assets",
    },
  ),
  /journal unavailable/,
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
      if (command instanceof PutObjectCommand)
        throw { $metadata: { httpStatusCode: 412 } };
      assert.ok(command instanceof GetObjectCommand);
      return {
        ContentLength: 160,
        Body: { transformToString: async () => JSON.stringify(journalRecord) },
      };
    },
  } as unknown as Pick<S3Client, "send">,
  journalEnv,
);
console.log(
  "[account-erasure] passed: all S3 versions, exact keys, partial failures, CDN polling, private durable journal",
);
