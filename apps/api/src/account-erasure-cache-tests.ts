import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { resolveContentRuntimeConfig } from "@hunch/config/content";
import type { Pool } from "@hunch/infra";
import { configureContentServiceRuntime } from "./content-service-runtime.js";
import { completeContentAssetUpload } from "./services/content-assets.js";
import {
  adminContentActor,
  userContentActor,
} from "./services/content-actor.js";

configureContentServiceRuntime(
  resolveContentRuntimeConfig(
    {
      CONTENT_ASSET_S3_BUCKET: "cache-fixture",
      CONTENT_ASSET_PUBLIC_BASE_URL: "https://images.example.test",
    },
    "test",
  ),
);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const checksum = createHash("sha256").update(png).digest("hex");
const ownerId = "10000000-0000-4000-8000-000000000001";
let copyCacheControl: string | undefined;
const originalSend = S3Client.prototype.send;
S3Client.prototype.send = (async (command: unknown) => {
  if (command instanceof HeadObjectCommand)
    return {
      ContentLength: png.length,
      ContentType: "image/png",
      ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
    };
  if (command instanceof GetObjectCommand)
    return { Body: { transformToByteArray: async () => png } };
  assert.ok(command instanceof CopyObjectCommand);
  assert.equal(command.input.MetadataDirective, "REPLACE");
  copyCacheControl = command.input.CacheControl;
  return {};
}) as typeof S3Client.prototype.send;

try {
  for (const actor of ["user", "admin-owned-user", "cms"] as const) {
    const id = "20000000-0000-4000-8000-000000000002";
    const owned = actor !== "cms";
    const asset = {
      id,
      status: "pending",
      kind: "image",
      owner_user_id: owned ? ownerId : null,
      storage_key: `content-staging/${id}.png`,
      public_url: null,
      original_filename: "avatar.png",
      mime_type: "image/png",
      byte_size: png.length,
      checksum_sha256: checksum,
      metadata: owned ? { avatarModerationConsentVersion: 1 } : {},
      created_at: new Date(),
      updated_at: new Date(),
    };
    const query = async (sql: string, values: unknown[] = []) => {
      if (sql.includes("select id from users where id=(select owner_user_id"))
        return { rows: [{ id: ownerId }] };
      if (
        sql.includes("select") &&
        sql.includes("from content_assets where id = $1 for update")
      )
        return { rows: [asset] };
      if (sql.includes("status = 'ready'"))
        return {
          rows: [
            {
              ...asset,
              status: "ready",
              storage_key: values[1],
              public_url: values[2],
            },
          ],
        };
      if (sql.includes("status = 'verifying'"))
        return { rows: [{ ...asset, status: "verifying" }] };
      if (
        ["begin", "commit", "rollback"].includes(sql.toLowerCase()) ||
        sql.includes("insert into content_")
      )
        return { rows: [] };
      throw new Error("Unexpected asset promotion SQL");
    };
    const db = {
      query,
      connect: async () => ({ query, release() {} }),
    } as unknown as Pool;
    copyCacheControl = undefined;
    const ready = await completeContentAssetUpload(
      db,
      id,
      { byteSize: png.length, checksumSha256: checksum },
      actor === "user"
        ? userContentActor(ownerId)
        : actor === "admin-owned-user"
          ? adminContentActor("30000000-0000-4000-8000-000000000003")
          : null,
      async (bytes) => {
        assert.equal(
          owned,
          true,
          "CMS uploads must not require avatar moderation",
        );
        assert.deepEqual(bytes, png);
      },
    );
    assert.equal(ready.status, "ready");
    assert.equal(
      copyCacheControl,
      owned
        ? "public, max-age=0, s-maxage=300, must-revalidate"
        : "public, max-age=31536000, immutable",
    );
  }
} finally {
  S3Client.prototype.send = originalSend;
}
console.log(
  "[account-erasure-cache] real asset promotion: user and admin-completed user media revalidate; CMS cache unchanged",
);
