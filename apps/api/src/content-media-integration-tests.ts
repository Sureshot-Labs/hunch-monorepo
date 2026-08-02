// @requires-db

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { createPgPool } from "@hunch/infra";
import { configureContentTestRuntime } from "./content-test-runtime.js";

const connectionString = process.env.CONTENT_TEST_DATABASE_URL?.trim();
if (!connectionString) throw new Error("CONTENT_TEST_DATABASE_URL is required");

type StoredObject = {
  body: Buffer;
  contentType: string;
  checksumBase64: string;
};

const bucket = "content-media-test";
const objects = new Map<string, StoredObject>();

function checksumHex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function checksumBase64(body: Buffer): string {
  return createHash("sha256").update(body).digest("base64");
}

function objectKey(request: IncomingMessage): string {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  assert.equal(parts.shift(), bucket);
  return parts.join("/");
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendS3Error(response: ServerResponse, status: number, code: string) {
  response.statusCode = status;
  response.setHeader("content-type", "application/xml");
  response.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
}

const server = createServer(async (request, response) => {
  try {
    const key = objectKey(request);
    if (request.method === "PUT" && request.headers["x-amz-copy-source"]) {
      const sourcePath = decodeURIComponent(
        String(request.headers["x-amz-copy-source"]),
      ).replace(/^\/+/, "");
      const sourceKey = sourcePath.slice(sourcePath.indexOf("/") + 1);
      const source = objects.get(sourceKey);
      if (!source) return sendS3Error(response, 404, "NoSuchKey");
      objects.set(key, { ...source, body: Buffer.from(source.body) });
      response.statusCode = 200;
      response.setHeader("content-type", "application/xml");
      response.setHeader("x-amz-checksum-sha256", source.checksumBase64);
      response.end(
        `<CopyObjectResult><ETag>"test"</ETag><LastModified>${new Date().toISOString()}</LastModified><ChecksumSHA256>${source.checksumBase64}</ChecksumSHA256></CopyObjectResult>`,
      );
      return;
    }
    if (request.method === "PUT") {
      const body = await requestBody(request);
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const expectedChecksum = String(
        request.headers["x-amz-checksum-sha256"] ??
          requestUrl.searchParams.get("x-amz-checksum-sha256") ??
          "",
      );
      if (expectedChecksum && expectedChecksum !== checksumBase64(body)) {
        return sendS3Error(response, 400, "BadDigest");
      }
      objects.set(key, {
        body,
        contentType: String(
          request.headers["content-type"] ?? "application/octet-stream",
        ),
        checksumBase64: checksumBase64(body),
      });
      response.statusCode = 200;
      response.setHeader("x-amz-checksum-sha256", checksumBase64(body));
      response.end();
      return;
    }
    const stored = objects.get(key);
    if (request.method === "HEAD") {
      if (!stored) return sendS3Error(response, 404, "NoSuchKey");
      response.statusCode = 200;
      response.setHeader("content-length", stored.body.length);
      response.setHeader("content-type", stored.contentType);
      response.setHeader("x-amz-checksum-sha256", stored.checksumBase64);
      response.end();
      return;
    }
    if (request.method === "GET") {
      if (!stored) return sendS3Error(response, 404, "NoSuchKey");
      const selected = stored.body.subarray(0, 1_048_576);
      response.statusCode = request.headers.range ? 206 : 200;
      response.setHeader("content-length", selected.length);
      response.setHeader("content-type", stored.contentType);
      if (request.headers.range) {
        response.setHeader(
          "content-range",
          `bytes 0-${selected.length - 1}/${stored.body.length}`,
        );
      }
      response.end(selected);
      return;
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      response.statusCode = 204;
      response.end();
      return;
    }
    sendS3Error(response, 405, "MethodNotAllowed");
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : "test server error");
  }
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
assert.ok(address && typeof address === "object");

process.env.CONTENT_ASSET_S3_ENDPOINT = `http://127.0.0.1:${address.port}`;
process.env.CONTENT_ASSET_S3_REGION = "us-east-1";
process.env.CONTENT_ASSET_S3_BUCKET = bucket;
process.env.CONTENT_ASSET_S3_ACCESS_KEY_ID = "test-access";
process.env.CONTENT_ASSET_S3_SECRET_ACCESS_KEY = "test-secret";
process.env.CONTENT_ASSET_S3_FORCE_PATH_STYLE = "true";
process.env.CONTENT_ASSET_PUBLIC_BASE_URL = "https://cdn.example.com";
configureContentTestRuntime();

const [assetsModule, workerModule, contentModule] = await Promise.all([
  import("./services/content-assets.js"),
  import("./services/content-worker.js"),
  import("./services/content.js"),
]);
const {
  completeContentAssetUpload,
  createContentAssetUpload,
  deleteContentAsset,
} = assetsModule;
const { dispatchContentStorageDeletions } = workerModule;
const { ContentError } = contentModule;

const pool = createPgPool({ connectionString, max: 2 });
const assetIds: string[] = [];
const storageKeys = new Set<string>();
const logger = {
  info: () => undefined,
  warn: () => undefined,
};

try {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const pngChecksum = checksumHex(png);
  const intent = await createContentAssetUpload(
    pool,
    {
      kind: "image",
      originalFilename: "pixel.png",
      mimeType: "image/png",
      expectedByteSize: png.length,
      checksumSha256: pngChecksum,
      defaultAlt: "One pixel",
    },
    null,
  );
  assert.equal(
    intent.upload.headers["x-amz-checksum-sha256"],
    checksumBase64(png),
  );
  assetIds.push(intent.asset.id);
  storageKeys.add(intent.asset.storageKey);
  const rejectedPayload = await fetch(intent.upload.url, {
    method: intent.upload.method,
    headers: intent.upload.headers,
    body: Buffer.concat([png, Buffer.from([0])]),
  });
  assert.equal(rejectedPayload.status, 400);
  assert.equal(objects.has(intent.asset.storageKey), false);
  const uploaded = await fetch(intent.upload.url, {
    method: intent.upload.method,
    headers: intent.upload.headers,
    body: png,
  });
  assert.equal(uploaded.ok, true);
  const ready = await completeContentAssetUpload(
    pool,
    intent.asset.id,
    {
      byteSize: png.length,
      checksumSha256: pngChecksum,
      width: 1,
      height: 1,
    },
    null,
  );
  assert.equal(ready.status, "ready");
  assert.equal(ready.width, 1);
  assert.equal(ready.height, 1);
  assert.match(ready.storageKey, /^content\//);
  assert.equal(objects.has(ready.storageKey), true);
  storageKeys.add(ready.storageKey);

  await pool.query(
    "update content_storage_deletion_jobs set available_at = now() where storage_key = $1",
    [intent.asset.storageKey],
  );
  await dispatchContentStorageDeletions(
    pool,
    10,
    "media-test-staging-cleanup",
    logger,
  );
  assert.equal(objects.has(intent.asset.storageKey), false);
  assert.equal(objects.has(ready.storageKey), true);

  const deleted = await deleteContentAsset(pool, ready.id, null);
  assert.equal(deleted.status, "deleted");
  await dispatchContentStorageDeletions(
    pool,
    10,
    "media-test-public-cleanup",
    logger,
  );
  assert.equal(objects.has(ready.storageKey), false);

  const fakePdf = Buffer.from("this is not a pdf", "utf8");
  const fakePdfChecksum = checksumHex(fakePdf);
  const invalidIntent = await createContentAssetUpload(
    pool,
    {
      kind: "file",
      originalFilename: "unsafe.pdf",
      mimeType: "application/pdf",
      expectedByteSize: fakePdf.length,
      checksumSha256: fakePdfChecksum,
    },
    null,
  );
  assetIds.push(invalidIntent.asset.id);
  storageKeys.add(invalidIntent.asset.storageKey);
  const invalidUploaded = await fetch(invalidIntent.upload.url, {
    method: invalidIntent.upload.method,
    headers: invalidIntent.upload.headers,
    body: fakePdf,
  });
  assert.equal(invalidUploaded.ok, true);
  await assert.rejects(
    () =>
      completeContentAssetUpload(
        pool,
        invalidIntent.asset.id,
        {
          byteSize: fakePdf.length,
          checksumSha256: fakePdfChecksum,
        },
        null,
      ),
    (error: unknown) =>
      error instanceof ContentError && error.code === "content_asset_not_ready",
  );
  const { rows: failedRows } = await pool.query<{ status: string }>(
    "select status from content_assets where id = $1",
    [invalidIntent.asset.id],
  );
  assert.equal(failedRows[0].status, "failed");
  await pool.query(
    "update content_storage_deletion_jobs set available_at = now() where storage_key = $1",
    [invalidIntent.asset.storageKey],
  );
  await dispatchContentStorageDeletions(
    pool,
    10,
    "media-test-failed-cleanup",
    logger,
  );
  assert.equal(objects.has(invalidIntent.asset.storageKey), false);

  console.log("[content-media-integration-tests] passed");
} finally {
  if (assetIds.length > 0) {
    await pool.query(
      "delete from content_audit_events where asset_id = any($1::uuid[])",
      [assetIds],
    );
    const { rows } = await pool.query<{ storage_key: string }>(
      "select storage_key from content_assets where id = any($1::uuid[])",
      [assetIds],
    );
    for (const row of rows) storageKeys.add(row.storage_key);
    await pool.query(
      `
        delete from content_storage_deletion_jobs job
        where job.storage_key = any($1::text[])
           or exists (
             select 1 from unnest($2::text[]) as source(asset_id)
             where position(source.asset_id in job.storage_key) > 0
           )
      `,
      [[...storageKeys], assetIds],
    );
    await pool.query("delete from content_assets where id = any($1::uuid[])", [
      assetIds,
    ]);
  }
  await pool.end();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
