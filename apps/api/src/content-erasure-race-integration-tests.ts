import type { Pool as PgPool } from "pg";
// @requires-db
import { createIntegrationTestPool } from "./test-database-target.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { configureContentServiceRuntime } from "./content-service-runtime.js";
import { dispatchContentStorageDeletions } from "./services/content-worker.js";
import { enqueueContentStorageDeletion } from "./services/content-asset-deletion.js";
import { resolveContentRuntimeConfig } from "@hunch/config/content";
const repo = new URL("../../../", import.meta.url).pathname.replace(/\/$/u, "");
const require = createRequire(repo + "/apps/api/package.json");
const { Pool } = require("pg");
const {
  S3Client,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
} = require("@aws-sdk/client-s3");
const {
  CloudFrontClient,
  CreateInvalidationCommand,
} = require("@aws-sdk/client-cloudfront");
const connectionString = process.env.DATABASE_URL;
const admin = await createIntegrationTestPool({ max: 1 });
let db!: PgPool;
const originalS3 = S3Client.prototype.send;
const originalCF = CloudFrontClient.prototype.send;
function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const firstInvalidationStarted = deferred();
const oldResponse = deferred();
const secondDeleteStarted = deferred();
const newDelete = deferred();
let deletes = 0;
let objectExists = true;
try {
  assert.equal(
    (await admin.query("select current_database() as name")).rows[0].name,
    process.env.HUNCH_TEST_EXPECT_DATABASE,
  );
  await admin.query("create schema generation_probe");
  db = new Pool({
    connectionString,
    options: "-c search_path=generation_probe,public",
    max: 4,
  });
  const migration = await readFile(
    repo + "/packages/db/migrations/0198_content_cms_adoption.sql",
    "utf8",
  );
  const start = migration.indexOf(
    "CREATE TABLE IF NOT EXISTS content_storage_deletion_jobs (",
  );
  const end = migration.indexOf(
    "DROP TRIGGER IF EXISTS content_storage_deletion_jobs_set_updated_at",
    start,
  );
  await db.query(migration.slice(start, end));
  await db.query(
    await readFile(
      repo + "/packages/db/migrations/0289_content_erasure_invalidation.sql",
      "utf8",
    ),
  );
  await db.query(
    `create table content_promotion_intents(id uuid primary key,asset_id uuid,storage_key text,next_check_at timestamptz); create index on content_promotion_intents(next_check_at,id)`,
  );
  configureContentServiceRuntime(
    resolveContentRuntimeConfig(
      {
        CONTENT_ASSET_S3_BUCKET: "fixture",
        CONTENT_ASSET_PUBLIC_BASE_URL: "https://images.example.test",
        CONTENT_ASSET_CLOUDFRONT_DISTRIBUTION_ID: "fixture",
        CONTENT_WORKER_MAX_ATTEMPTS: "8",
      },
      "test",
    ),
  );
  S3Client.prototype.send = async (command: unknown) => {
    if (command instanceof DeleteObjectCommand) {
      deletes++;
      if (deletes === 1) {
        objectExists = false;
        return {};
      }
      secondDeleteStarted.resolve();
      return newDelete.promise;
    }
    assert.ok(command instanceof ListObjectVersionsCommand);
    return { Versions: [], DeleteMarkers: [] };
  };
  CloudFrontClient.prototype.send = async (command: unknown) => {
    assert.ok(command instanceof CreateInvalidationCommand);
    firstInvalidationStarted.resolve();
    return oldResponse.promise;
  };
  const key = "content/lease-probe.png";
  const logger = { info() {}, warn() {} };
  await enqueueContentStorageDeletion(db, key);
  const generation1 = (
    await db.query(
      "select cdn_invalidation_reference from content_storage_deletion_jobs",
    )
  ).rows[0].cdn_invalidation_reference;
  const oldTurn = dispatchContentStorageDeletions(
    db,
    1,
    "finance-worker:1:storage",
    logger,
  );
  await firstInvalidationStarted.promise;
  objectExists = true; // A late CopyObject recreated the key after the first erasure.
  await enqueueContentStorageDeletion(db, key, new Date(), {
    reopenAfterPossibleWrite: true,
  });
  const generation2 = (
    await db.query(
      "select cdn_invalidation_reference from content_storage_deletion_jobs",
    )
  ).rows[0].cdn_invalidation_reference;
  assert.notEqual(generation1, generation2);
  const newTurn = dispatchContentStorageDeletions(
    db,
    1,
    "finance-worker:1:storage",
    logger,
  );
  await secondDeleteStarted.promise;
  oldResponse.resolve({
    Invalidation: { Id: "old-invalidation", Status: "Completed" },
  });
  assert.equal(await oldTurn, 0);
  newDelete.reject(new Error("New generation's origin deletion failed"));
  assert.equal(await newTurn, 0);
  const row = (
    await db.query(
      "select status,cdn_invalidation_reference,locked_by from content_storage_deletion_jobs",
    )
  ).rows[0];
  assert.equal(row.status, "pending");
  assert.equal(row.cdn_invalidation_reference, generation2);
  assert.equal(objectExists, true);
  // A worker lost on its final attempt must be reclaimable, then completable.
  await db.query("truncate content_storage_deletion_jobs");
  await db.query(
    "insert into content_storage_deletion_jobs(storage_key,status,attempts,locked_at,locked_by) values('content/abandoned.png','processing',8,now()-interval '3 minutes','lost-worker')",
  );
  S3Client.prototype.send = (async () => ({
    Versions: [],
    DeleteMarkers: [],
  })) as typeof S3Client.prototype.send;
  CloudFrontClient.prototype.send = (async () => ({
    Invalidation: { Id: "recovered", Status: "Completed" },
  })) as typeof CloudFrontClient.prototype.send;
  assert.equal(
    await dispatchContentStorageDeletions(db, 1, "same-worker", logger),
    1,
  );
  assert.equal(
    (await db.query("select status from content_storage_deletion_jobs")).rows[0]
      .status,
    "completed",
  );
  const evidence = {
    generation1,
    generation2,
    row,
    objectExists,
    originDeleteAttempts: deletes,
  };

  console.log(JSON.stringify(evidence));
} finally {
  S3Client.prototype.send = originalS3;
  CloudFrontClient.prototype.send = originalCF;
  await db?.end();
  await admin.query("drop schema if exists generation_probe cascade");
  await admin.end();
}
