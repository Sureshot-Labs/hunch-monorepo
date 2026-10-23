import assert from "node:assert/strict";
import {
  S3Client,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { resolveContentRuntimeConfig } from "@hunch/config/content";
import type { Pool } from "@hunch/infra";
import { configureContentServiceRuntime } from "./content-service-runtime.js";
import { dispatchContentStorageDeletions } from "./services/content-worker.js";

configureContentServiceRuntime(
  resolveContentRuntimeConfig(
    {
      CONTENT_ASSET_S3_BUCKET: "test-bucket",
      CONTENT_ASSET_PUBLIC_BASE_URL: "https://images.example.test",
      CONTENT_ASSET_CLOUDFRONT_DISTRIBUTION_ID: "test-distribution",
      CONTENT_WORKER_MAX_ATTEMPTS: "1",
    },
    "test",
  ),
);

let status = "pending";
let attempts = 0;
let invalidationId: string | null = null;
let versionsRemain = true;
let originDeletes = 0;
let invalidations = 0;
let warnings = 0;
const query = async (sql: string, values: unknown[] = []) => {
  if (sql.includes("select id, storage_key")) {
    return {
      rows:
        status === "pending"
          ? [
              {
                id: 1,
                storage_key: "content/avatar.jpg",
                attempts,
                cdn_invalidation_id: invalidationId,
                cdn_invalidation_reference: "test-generation",
              },
            ]
          : [],
    };
  }
  if (sql.includes("returning cdn_invalidation_reference")) {
    attempts += 1;
    status = "processing";
    return { rows: [{ cdn_invalidation_reference: "test-generation" }] };
  }
  if (sql.includes("attempts=greatest(attempts-1,0)")) {
    attempts -= 1;
    status = "pending";
    if (sql.includes("cdn_invalidation_id=$3"))
      invalidationId = String(values[2]);
  } else if (sql.includes("status = 'completed'")) {
    status = "completed";
  } else if (sql.includes("last_error = $5")) {
    status = "failed";
  }
  return { rows: [] };
};
const database = {
  query,
  connect: async () => ({ query, release() {} }),
} as unknown as Pool;
const logger = {
  info() {},
  warn() {
    warnings += 1;
  },
};
const originalS3 = S3Client.prototype.send;
const originalCloudFront = CloudFrontClient.prototype.send;
S3Client.prototype.send = (async (command: unknown) => {
  if (command instanceof DeleteObjectCommand) originDeletes += 1;
  if (command instanceof ListObjectVersionsCommand) {
    return {
      Versions: versionsRemain
        ? [{ Key: "content/avatar.jpg", VersionId: "more" }]
        : [],
    };
  }
  return {};
}) as typeof S3Client.prototype.send;
CloudFrontClient.prototype.send = (async (command: unknown) => {
  if (command instanceof CreateInvalidationCommand) {
    invalidations += 1;
    return { Invalidation: { Id: "test-invalidation", Status: "InProgress" } };
  }
  return { Invalidation: { Id: "test-invalidation", Status: "Completed" } };
}) as typeof CloudFrontClient.prototype.send;
try {
  assert.equal(
    await dispatchContentStorageDeletions(
      database,
      1,
      "fixture-worker",
      logger,
    ),
    0,
  );
  assert.equal(status, "pending", "bounded S3 progress must remain retryable");
  assert.equal(attempts, 0, "progress must not spend the last failure attempt");
  assert.equal(warnings, 0);
  assert.equal(invalidations, 0);
  versionsRemain = false;
  assert.equal(
    await dispatchContentStorageDeletions(
      database,
      1,
      "fixture-worker",
      logger,
    ),
    0,
  );
  assert.equal(invalidationId, "test-invalidation");
  assert.equal(status, "pending");
  assert.equal(attempts, 0, "CDN polling must not spend failure attempts");
  const deletesBeforePolling = originDeletes;
  assert.equal(
    await dispatchContentStorageDeletions(
      database,
      1,
      "fixture-worker",
      logger,
    ),
    1,
  );
  assert.equal(status, "completed");
  assert.equal(
    originDeletes,
    deletesBeforePolling,
    "polling must not recreate S3 delete markers",
  );
  assert.equal(
    invalidations,
    1,
    "a durable invalidation must not be recreated",
  );
  assert.equal(
    await dispatchContentStorageDeletions(
      database,
      1,
      "fixture-worker",
      logger,
    ),
    0,
  );
} finally {
  S3Client.prototype.send = originalS3;
  CloudFrontClient.prototype.send = originalCloudFront;
}
console.log(
  "[account-erasure-worker] bounded progress, CDN polling and completion passed",
);
