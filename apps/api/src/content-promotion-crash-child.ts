import { createIntegrationTestPool } from "./test-database-target.js";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
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
const bytes = PNG.sync.write(new PNG({ width: 80, height: 80 }));
const checksum = createHash("sha256").update(bytes).digest("hex");
const [assetId, userId] = process.argv.slice(2);
const pool = await createIntegrationTestPool({ max: 1 });
configureContentServiceRuntime(
  resolveContentRuntimeConfig(
    {
      CONTENT_ASSET_S3_BUCKET: "fixture",
      CONTENT_ASSET_PUBLIC_BASE_URL: "https://images.example.test",
    },
    "test",
  ),
);
S3Client.prototype.send = async (command: { input: { Key?: string } }) => {
  if (command instanceof HeadObjectCommand)
    return {
      ContentLength: bytes.length,
      ContentType: "image/png",
      ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
      VersionId: "pinned-version",
      ETag: '"fixture"',
    };
  if (command instanceof GetObjectCommand)
    return { Body: { transformToByteArray: async () => bytes } };
  if (command instanceof CopyObjectCommand) {
    process.send?.({ kind: "remote-copy-submitted", key: command.input.Key });
    // The remote operation is accepted; deliberately lose its response.
    return new Promise(() => {});
  }
  throw new Error("Unexpected command");
};
try {
  await completeContentAssetUpload(
    pool,
    assetId,
    { byteSize: bytes.length, checksumSha256: checksum },
    userContentActor(userId),
    async () => {},
  );
} finally {
  await pool.end();
}
