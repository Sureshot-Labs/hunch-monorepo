// @requires-db
import { createIntegrationTestPool } from "./test-database-target.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { configureContentServiceRuntime } from "./content-service-runtime.js";
import { dispatchContentStorageDeletions } from "./services/content-worker.js";
import { clearUserSocialData } from "./services/social-lifecycle.js";
import { resolveContentRuntimeConfig } from "@hunch/config/content";
const repo = new URL("../../../", import.meta.url).pathname.replace(/\/$/u, "");
const require = createRequire(repo + "/apps/api/package.json");
const { PNG } = require("pngjs");
const {
  S3Client,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
} = require("@aws-sdk/client-s3");
const {
  CloudFrontClient,
  CreateInvalidationCommand,
} = require("@aws-sdk/client-cloudfront");
const pool = await createIntegrationTestPool({ max: 2 });
const userId = randomUUID(),
  assetId = randomUUID(),
  stagingKey = "content-staging/" + assetId + ".png";
const bytes = PNG.sync.write(new PNG({ width: 80, height: 80 }));
const checksum = createHash("sha256").update(bytes).digest("hex");
let child!: ReturnType<typeof spawn>;
let childLog = "";
let objectExists = false;
let targetKey = "";
const originalS3 = S3Client.prototype.send,
  originalCF = CloudFrontClient.prototype.send;
try {
  assert.equal(
    (await pool.query("select current_database() as db")).rows[0].db,
    process.env.HUNCH_TEST_EXPECT_DATABASE,
  );
  // Earlier integration assertions may leave fixture jobs behind. This database
  // is owned exclusively by this audit; isolate this one-worker reproduction.
  await pool.query(
    "truncate content_storage_deletion_jobs,content_promotion_intents",
  );
  await pool.query("insert into users(id) values($1)", [userId]);
  await pool.query(
    `insert into content_assets(id,owner_user_id,kind,storage_key,original_filename,mime_type,byte_size,checksum_sha256,metadata)
   values($1,$2,'image',$3,'fixture.png','image/png',$4,$5,'{"avatarModerationConsentVersion":1}')`,
    [assetId, userId, stagingKey, bytes.length, checksum],
  );
  configureContentServiceRuntime(
    resolveContentRuntimeConfig(
      {
        CONTENT_ASSET_S3_BUCKET: "fixture",
        CONTENT_ASSET_PUBLIC_BASE_URL: "https://images.example.test",
        CONTENT_ASSET_CLOUDFRONT_DISTRIBUTION_ID: "fixture",
      },
      "test",
    ),
  );
  child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      new URL(
        `./content-promotion-crash-child.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
        import.meta.url,
      ).pathname,
      assetId,
      userId,
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        HUNCH_RUNTIME_SECRETS_LOADED: "1",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  child.stdout?.on("data", (data: Buffer) => (childLog += data));
  child.stderr?.on("data", (data: Buffer) => (childLog += data));
  const exit = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) =>
      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) =>
        resolve({ code, signal }),
      ),
  );
  targetKey = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("No copy submission: " + childLog)),
      15000,
    );
    child.once("message", (message: unknown) => {
      clearTimeout(timer);
      assert.ok(
        message &&
          typeof message === "object" &&
          "kind" in message &&
          "key" in message,
      );
      assert.equal(message.kind, "remote-copy-submitted");
      assert.equal(typeof message.key, "string");
      resolve(String(message.key));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Child exited before copy: " + childLog));
    });
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select id from users where id=$1 for update", [userId]);
    await clearUserSocialData(client, userId);
    await client.query("delete from users where id=$1", [userId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  S3Client.prototype.send = async (command: { input: { Key?: string } }) => {
    if (command instanceof DeleteObjectCommand) {
      if (command.input.Key === targetKey) objectExists = false;
      return {};
    }
    assert.ok(command instanceof ListObjectVersionsCommand);
    return { Versions: [], DeleteMarkers: [] };
  };
  CloudFrontClient.prototype.send = async (command: {
    input: { Key?: string };
  }) => {
    assert.ok(command instanceof CreateInvalidationCommand);
    return { Invalidation: { Id: "fixture", Status: "Completed" } };
  };
  const logger = { info() {}, warn() {} };
  assert.equal(
    await dispatchContentStorageDeletions(pool, 1, "single-worker", logger),
    1,
  );
  // Remote copy completes after origin/CDN deletion. The API dies before it can
  // observe the response and enqueue the catch-block cleanup.
  objectExists = true;
  child.kill("SIGKILL");
  const childExit = await exit;
  assert.equal(childExit.signal, "SIGKILL");
  await pool.query("delete from content_assets where id=$1", [assetId]);
  await pool.query(
    "update content_promotion_intents set next_check_at=now() where asset_id=$1",
    [assetId],
  );
  assert.equal(
    await dispatchContentStorageDeletions(pool, 1, "single-worker", logger),
    1,
  );
  assert.equal(objectExists, false);
  // No remote cancellation/expiry is assumed: another very late write is repaired too.
  objectExists = true;
  await pool.query(
    "update content_promotion_intents set next_check_at=now() where asset_id=$1",
    [assetId],
  );
  assert.equal(
    await dispatchContentStorageDeletions(pool, 1, "single-worker", logger),
    1,
  );
  assert.equal(objectExists, false);
  const row = (
    await pool.query(
      "select status,completed_at from content_storage_deletion_jobs where storage_key=$1",
      [targetKey],
    )
  ).rows[0];
  const asset = (
    await pool.query(
      "select status,owner_user_id from content_assets where id=$1",
      [assetId],
    )
  ).rows[0];
  assert.equal(row.status, "completed");
  assert.equal(asset, undefined);
  assert.equal(objectExists, false);
  const evidence = {
    scenario: "account-delete-remote-copy-process-crash",
    childExit,
    objectExists,
    job: row,
    asset,
    subsequentWorkerProcessed: 2,
    workers: 1,
    staleWorkerOverlap: false,
  };
  console.log(JSON.stringify(evidence));
} finally {
  child?.kill("SIGKILL");
  S3Client.prototype.send = originalS3;
  CloudFrontClient.prototype.send = originalCF;
  await pool.query("delete from content_promotion_intents where asset_id=$1", [
    assetId,
  ]);
  await pool.query("delete from content_audit_events where asset_id=$1", [
    assetId,
  ]);
  await pool.query("delete from content_assets where id=$1", [assetId]);
  await pool.query(
    "delete from content_storage_deletion_jobs where storage_key=any($1::text[])",
    [[targetKey, stagingKey]],
  );
  await pool.query("delete from users where id=$1", [userId]);
  await pool.end();
}
