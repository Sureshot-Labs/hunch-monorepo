// @requires-db
import { createIntegrationTestPool } from "./test-database-target.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { configureContentServiceRuntime } from "./content-service-runtime.js";
import { completeContentAssetUpload } from "./services/content-assets.js";
import { userContentActor } from "./services/content-actor.js";
import { resolveContentRuntimeConfig } from "@hunch/config/content";
const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
} = require("@aws-sdk/client-s3");
const pool = await createIntegrationTestPool({ max: 2 });
const bytes = PNG.sync.write(new PNG({ width: 80, height: 80 }));
const checksum = createHash("sha256").update(bytes).digest("hex");
configureContentServiceRuntime(
  resolveContentRuntimeConfig(
    {
      CONTENT_ASSET_S3_BUCKET: "fixture",
      CONTENT_ASSET_PUBLIC_BASE_URL: "https://images.example.test",
    },
    "test",
  ),
);
const original = S3Client.prototype.send;
const results = [];
try {
  assert.equal(
    (await pool.query("select current_database() as db")).rows[0].db,
    process.env.HUNCH_TEST_EXPECT_DATABASE,
  );
  for (const failureAt of ["head", "body"]) {
    const userId = randomUUID(),
      assetId = randomUUID(),
      key = "content-staging/" + assetId + ".png";
    await pool.query("insert into users(id) values($1)", [userId]);
    await pool.query(
      `insert into content_assets(id,owner_user_id,kind,storage_key,original_filename,mime_type,byte_size,checksum_sha256,metadata)
   values($1,$2,'image',$3,'fixture.png','image/png',$4,$5,'{"avatarModerationConsentVersion":1}')`,
      [assetId, userId, key, bytes.length, checksum],
    );
    try {
      S3Client.prototype.send = async (command: unknown) => {
        if (command instanceof HeadObjectCommand && failureAt === "body")
          return {
            ContentLength: bytes.length,
            ContentType: "image/png",
            ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
            VersionId: "fixture-version",
            ETag: '"fixture"',
          };
        assert.ok(
          command instanceof HeadObjectCommand ||
            command instanceof GetObjectCommand,
        );
        throw Object.assign(new Error("Temporarily unavailable"), {
          name: "SlowDown",
          $metadata: { httpStatusCode: 503 },
        });
      };
      await assert.rejects(
        completeContentAssetUpload(
          pool,
          assetId,
          { byteSize: bytes.length, checksumSha256: checksum },
          userContentActor(userId),
        ),
        { code: "content_storage_unavailable", statusCode: 503 },
      );
      const asset = (
        await pool.query(
          "select status,metadata from content_assets where id=$1",
          [assetId],
        )
      ).rows[0];
      assert.equal(asset.status, "pending");
      const jobs = (
        await pool.query(
          "select storage_key,status from content_storage_deletion_jobs where storage_key like $1 or storage_key=$2",
          ["%" + assetId + "%", key],
        )
      ).rows;
      assert.equal(jobs.length, 0);
      S3Client.prototype.send = async (command: unknown) => {
        if (command instanceof HeadObjectCommand)
          return {
            ContentLength: bytes.length,
            ContentType: "image/png",
            ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
            VersionId: "fixture-version",
            ETag: '"fixture"',
          };
        if (command instanceof GetObjectCommand)
          return { Body: { transformToByteArray: async () => bytes } };
        assert.ok(command instanceof CopyObjectCommand);
        return {};
      };
      const ready = await completeContentAssetUpload(
        pool,
        assetId,
        { byteSize: bytes.length, checksumSha256: checksum },
        userContentActor(userId),
        async () => {},
      );
      assert.equal(ready.status, "ready");
      results.push({ failureAt, firstStatus: 503, retryStatus: 200 });
    } finally {
      await pool.query("delete from content_audit_events where asset_id=$1", [
        assetId,
      ]);
      await pool.query("delete from content_assets where id=$1", [assetId]);
      await pool.query(
        "delete from content_storage_deletion_jobs where storage_key like $1",
        ["%" + assetId + "%"],
      );
      await pool.query("delete from users where id=$1", [userId]);
    }
  }
  console.log(JSON.stringify(results));
} finally {
  S3Client.prototype.send = original;
  await pool.end();
}
