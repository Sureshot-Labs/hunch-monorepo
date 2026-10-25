import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AccessDeniedException,
  DetectModerationLabelsCommand,
  ImageTooLargeException,
  InvalidImageFormatException,
  InvalidParameterException,
  RekognitionClient,
} from "@aws-sdk/client-rekognition";
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { resolveContentRuntimeConfig } from "@hunch/config/content";
import type { Pool } from "@hunch/infra";
import { PNG } from "pngjs";
import { configureContentServiceRuntime } from "./content-service-runtime.js";
import { userContentActor } from "./services/content-actor.js";
import { completeContentAssetUpload } from "./services/content-assets.js";
import { checkAvatarContent } from "./services/social-content-filter.js";

const image = (width: number, height: number) =>
  PNG.sync.write(new PNG({ width, height }));
const accepted = { ModerationModelVersion: "test", ModerationLabels: [] };
const provider = (send: (command: unknown) => Promise<unknown>) =>
  ({ send }) as unknown as Pick<RekognitionClient, "send">;
const unsupported = { code: "avatar_unsupported", statusCode: 422 };
const unavailable = { code: "avatar_check_unavailable", statusCode: 503 };

// Exercise each axis and both inclusive boundaries, without calling AWS.
for (const [width, height] of [
  [64, 64],
  [79, 80],
  [80, 79],
  [10001, 80],
  [80, 10001],
]) {
  let calls = 0;
  await assert.rejects(
    checkAvatarContent(
      image(width, height),
      provider(async () => {
        calls += 1;
        return accepted;
      }),
    ),
    unsupported,
  );
  assert.equal(calls, 0, `${width}x${height} must be rejected before AWS`);
}
for (const bytes of [
  Buffer.alloc(0),
  Buffer.from([1]),
  Buffer.alloc(5_000_001),
])
  await assert.rejects(
    checkAvatarContent(
      bytes,
      provider(async () => assert.fail("Unexpected AWS call")),
    ),
    unsupported,
  );
const valid = image(80, 80);
for (const [width, height] of [
  [80, 80],
  [10000, 80],
  [80, 10000],
]) {
  let calls = 0;
  await checkAvatarContent(
    image(width, height),
    provider(async (command) => {
      assert.ok(command instanceof DetectModerationLabelsCommand);
      calls += 1;
      return accepted;
    }),
  );
  assert.equal(calls, 1);
}
for (const ErrorClass of [
  InvalidImageFormatException,
  ImageTooLargeException,
  InvalidParameterException,
])
  await assert.rejects(
    checkAvatarContent(
      valid,
      provider(async () => {
        throw new ErrorClass({
          message: "Unsupported image",
          $metadata: { httpStatusCode: 400 },
        });
      }),
    ),
    unsupported,
  );
for (const error of [
  new Error("Provider unavailable"),
  new AccessDeniedException({
    message: "Role unavailable",
    $metadata: { httpStatusCode: 400 },
  }),
])
  await assert.rejects(
    checkAvatarContent(
      valid,
      provider(async () => {
        throw error;
      }),
    ),
    unavailable,
  );

configureContentServiceRuntime(
  resolveContentRuntimeConfig(
    {
      CONTENT_ASSET_S3_BUCKET: "avatar-fixture",
      CONTENT_ASSET_PUBLIC_BASE_URL: "https://images.example.test",
    },
    "test",
  ),
);
const ownerId = "10000000-0000-4000-8000-000000000001";
const assetId = "20000000-0000-4000-8000-000000000002";
const originalSend = S3Client.prototype.send;
try {
  for (const scenario of [
    "small",
    "large",
    "provider-invalid",
    "outage",
  ] as const) {
    const bytes =
      scenario === "small"
        ? image(64, 64)
        : scenario === "large"
          ? image(10001, 80)
          : valid;
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const asset = {
      id: assetId,
      status: "pending",
      kind: "image",
      owner_user_id: ownerId,
      storage_key: `content-staging/${assetId}.png`,
      public_url: null as string | null,
      original_filename: "avatar.png",
      mime_type: "image/png",
      byte_size: bytes.length,
      checksum_sha256: checksum,
      metadata: { avatarModerationConsentVersion: 1 } as Record<
        string,
        unknown
      >,
      created_at: new Date(),
      updated_at: new Date(),
    };
    let providerCalls = 0;
    let copies = 0;
    let providerHealthy = false;
    const query = async (sql: string, values: unknown[] = []) => {
      if (
        ["begin", "commit", "rollback"].includes(sql.trim().toLowerCase()) ||
        sql.includes("insert into content_") ||
        sql.includes("delete from content_promotion_intents")
      )
        return { rows: [] };
      if (sql.includes("from content_assets where id = $1 for update"))
        return { rows: [{ ...asset }] };
      if (sql.includes("select id from users where id=(select owner_user_id"))
        return { rows: [{ id: ownerId }] };
      if (/set\s+status = 'verifying'/u.test(sql)) {
        asset.status = "verifying";
        asset.metadata = {
          ...asset.metadata,
          ...JSON.parse(String(values[1])),
        };
      } else if (sql.includes("set status='pending' where id=$1")) {
        asset.status = "pending";
      } else if (sql.includes("status = 'failed'")) {
        asset.status = "failed";
      } else if (sql.includes("status = 'ready'")) {
        asset.status = "ready";
        asset.storage_key = String(values[1]);
        asset.public_url = String(values[2]);
      } else {
        throw new Error("Unexpected avatar completion SQL");
      }
      return { rows: [{ ...asset }], rowCount: 1 };
    };
    const db = {
      query,
      connect: async () => ({ query, release() {} }),
    } as unknown as Pool;
    S3Client.prototype.send = (async (command: unknown) => {
      if (command instanceof HeadObjectCommand)
        return {
          ContentLength: bytes.length,
          ContentType: "image/png",
          ETag: '"fixture"',
          ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
        };
      if (command instanceof GetObjectCommand)
        return { Body: { transformToByteArray: async () => bytes } };
      assert.ok(command instanceof CopyObjectCommand);
      copies += 1;
      return {};
    }) as typeof S3Client.prototype.send;
    const check = (input: Uint8Array) =>
      checkAvatarContent(
        input,
        provider(async () => {
          providerCalls += 1;
          if (providerHealthy) return accepted;
          if (scenario === "provider-invalid")
            throw new InvalidImageFormatException({
              message: "Invalid image",
              $metadata: { httpStatusCode: 400 },
            });
          throw new Error("Provider unavailable");
        }),
      );
    const complete = () =>
      completeContentAssetUpload(
        db,
        assetId,
        { byteSize: bytes.length, checksumSha256: checksum },
        userContentActor(ownerId),
        check,
      );
    await assert.rejects(
      complete(),
      scenario === "outage" ? unavailable : unsupported,
    );
    assert.equal(asset.status, scenario === "outage" ? "pending" : "failed");
    assert.equal(
      copies,
      0,
      "Rejected or unchecked avatars must never be public",
    );
    if (scenario === "small" || scenario === "large")
      assert.equal(providerCalls, 0);
    if (scenario === "outage") {
      providerHealthy = true;
      const ready = await complete();
      assert.equal(
        ready.status,
        "ready",
        "The same upload must recover after a real outage",
      );
      assert.equal(providerCalls, 2);
      assert.equal(copies, 1);
    } else {
      const callsBeforeRetry = providerCalls;
      await assert.rejects(complete(), {
        code: "content_asset_busy",
        statusCode: 409,
      });
      assert.equal(
        providerCalls,
        callsBeforeRetry,
        "Permanent failures must not repeat moderation",
      );
    }
  }
} finally {
  S3Client.prototype.send = originalSend;
}
console.log(
  "[avatar-moderation] passed: dimension boundaries, permanent input errors, no unsafe promotion, outage recovery",
);
