// @requires-db

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tx, type Pool } from "@hunch/infra";

import {
  configureContentTestRuntime,
  createContentTestPool,
} from "./content-test-runtime.js";

type StoredObject = {
  body: Buffer;
  contentType: string;
  checksumBase64: string;
};

const bucket = "content-media-test";
const objects = new Map<string, StoredObject>();
let beforeCopyObject: ((key: string) => Promise<void>) | null = null;

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
      await beforeCopyObject?.(key);
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

let pool: Pool | null = null;
const assetIds: string[] = [];
const userIds: string[] = [];
const storageKeys = new Set<string>();

try {
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

  const testPool = await createContentTestPool(2);
  pool = testPool;
  const logger = {
    info: () => undefined,
    warn: () => undefined,
  };

  async function prioritizeStorageDeletion(storageKey: string): Promise<void> {
    // The shared integration DB may contain unrelated jobs from earlier files.
    await testPool.query(
      `update content_storage_deletion_jobs
     set available_at = '-infinity'::timestamptz
     where storage_key = $1`,
      [storageKey],
    );
  }

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const pngChecksum = checksumHex(png);
  const intent = await createContentAssetUpload(
    testPool,
    {
      kind: "image",
      originalFilename: "pixel.png",
      mimeType: "image/png",
      expectedByteSize: png.length,
      checksumSha256: pngChecksum,
      defaultAlt: "One pixel",
      metadata: { uploadExpiresAt: "2000-01-01T00:00:00.000Z" },
    },
    null,
  );
  assert.equal(
    intent.upload.headers["x-amz-checksum-sha256"],
    checksumBase64(png),
  );
  const signedUploadUrl = new URL(intent.upload.url);
  const signedHeaders = new Set(
    signedUploadUrl.searchParams
      .get("X-Amz-SignedHeaders")
      ?.split(";")
      .filter(Boolean) ?? [],
  );
  assert.equal(
    signedUploadUrl.searchParams.has("x-amz-checksum-sha256"),
    false,
  );
  assert.equal(signedHeaders.has("x-amz-checksum-sha256"), true);
  assert.equal(signedHeaders.has("content-length"), false);
  assetIds.push(intent.asset.id);
  assert.equal(intent.asset.metadata.uploadExpiresAt, intent.upload.expiresAt);
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
    testPool,
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
  await assert.rejects(
    () =>
      completeContentAssetUpload(
        testPool,
        ready.id,
        {
          byteSize: png.length,
          checksumSha256: "f".repeat(64),
          width: 1,
          height: 1,
        },
        null,
      ),
    (error: unknown) =>
      error instanceof ContentError &&
      error.code === "content_asset_complete_mismatch",
  );

  await prioritizeStorageDeletion(intent.asset.storageKey);
  await dispatchContentStorageDeletions(
    testPool,
    10,
    "media-test-staging-cleanup",
    logger,
  );
  assert.equal(objects.has(intent.asset.storageKey), false);
  assert.equal(objects.has(ready.storageKey), true);

  const deleted = await deleteContentAsset(testPool, ready.id, null);
  assert.equal(deleted.status, "deleted");
  await prioritizeStorageDeletion(ready.storageKey);
  await dispatchContentStorageDeletions(
    testPool,
    10,
    "media-test-public-cleanup",
    logger,
  );
  assert.equal(objects.has(ready.storageKey), false);

  // Social avatars reuse verified immutable storage, but are strictly owner-scoped.
  const { userContentActor } = await import("./services/content-actor.js");
  const { SocialService } = await import("./services/social-service.js");
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  userIds.push(ownerId, strangerId);
  await testPool.query(`insert into users(id) values($1),($2)`, [
    ownerId,
    strangerId,
  ]);
  const ownerActor = userContentActor(ownerId);
  const strangerActor = userContentActor(strangerId);
  const avatarBody = {
    kind: "image" as const,
    originalFilename: "avatar.png",
    mimeType: "image/png",
    expectedByteSize: png.length,
    checksumSha256: pngChecksum,
  };
  const snapshot = { maximumBytes: png.length, revision: "test-frozen-policy" };
  await assert.rejects(
    () =>
      createContentAssetUpload(testPool, avatarBody, ownerActor, {
        ...snapshot,
        maximumBytes: png.length - 1,
      }),
    (error: unknown) =>
      error instanceof ContentError && error.statusCode === 413,
  );
  const avatar = await createContentAssetUpload(
    testPool,
    avatarBody,
    ownerActor,
    snapshot,
  );
  assetIds.push(avatar.asset.id);
  storageKeys.add(avatar.asset.storageKey);
  assert.deepEqual(avatar.asset.metadata.socialUploadPolicy, snapshot);
  assert.equal(avatar.asset.metadata.uploadExpiresAt, avatar.upload.expiresAt);
  const completion = { byteSize: png.length, checksumSha256: pngChecksum };
  await assert.rejects(
    () =>
      completeContentAssetUpload(
        testPool,
        avatar.asset.id,
        completion,
        strangerActor,
      ),
    (error: unknown) =>
      error instanceof ContentError && error.code === "content_asset_not_found",
  );
  await assert.rejects(
    () => deleteContentAsset(testPool, avatar.asset.id, strangerActor),
    (error: unknown) =>
      error instanceof ContentError && error.code === "content_asset_not_found",
  );
  assert.equal(
    (
      await fetch(avatar.upload.url, {
        method: "PUT",
        headers: avatar.upload.headers,
        body: png,
      })
    ).ok,
    true,
  );
  // A deployment may reduce the configured TTL after this URL has been issued.
  configureContentTestRuntime({
    ...process.env,
    CONTENT_ASSET_UPLOAD_TTL_SEC: "60",
  });
  const readyAvatar = await completeContentAssetUpload(
    testPool,
    avatar.asset.id,
    completion,
    ownerActor,
  );
  storageKeys.add(readyAvatar.storageKey);
  assert.equal(readyAvatar.status, "ready");
  const avatarDeletion = (
    await testPool.query(
      `select available_at from content_storage_deletion_jobs where storage_key=$1`,
      [avatar.asset.storageKey],
    )
  ).rows[0];
  assert.ok(
    new Date(avatarDeletion.available_at).getTime() >=
      Date.parse(avatar.upload.expiresAt) + 60_000,
  );
  const avatarAudit = (
    await testPool.query(
      `select actor_kind,actor_user_id,actor_admin_id from content_audit_events where asset_id=$1 and action='asset.ready'`,
      [avatar.asset.id],
    )
  ).rows[0];
  assert.deepEqual(avatarAudit, {
    actor_kind: "user",
    actor_user_id: ownerId,
    actor_admin_id: null,
  });
  const social = new SocialService(testPool);
  await assert.rejects(
    () => social.updateProfile(strangerId, { avatarAssetId: readyAvatar.id }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "avatar_unavailable",
  );
  await social.updateProfile(ownerId, { avatarAssetId: readyAvatar.id });
  await assert.rejects(
    () => deleteContentAsset(testPool, readyAvatar.id, ownerActor),
    (error: unknown) =>
      error instanceof ContentError && error.code === "content_asset_in_use",
  );
  await social.updateProfile(ownerId, { avatarAssetId: null });
  const race = await Promise.allSettled([
    social.updateProfile(ownerId, { avatarAssetId: readyAvatar.id }),
    deleteContentAsset(testPool, readyAvatar.id, ownerActor),
  ]);
  assert.equal(
    race.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const postRace = (
    await testPool.query(
      `select a.status,u.avatar_asset_id from content_assets a join users u on u.id=$2 where a.id=$1`,
      [readyAvatar.id, ownerId],
    )
  ).rows[0];
  assert.ok(
    (postRace.status === "ready" &&
      postRace.avatar_asset_id === readyAvatar.id) ||
      (postRace.status === "deleted" && postRace.avatar_asset_id === null),
  );
  if (postRace.status === "ready") {
    await social.updateProfile(ownerId, { avatarAssetId: null });
    await deleteContentAsset(testPool, readyAvatar.id, ownerActor);
  }
  await testPool.query(
    `update users set social_suspended_at=now() where id=$1`,
    [ownerId],
  );
  await assert.rejects(
    () => createContentAssetUpload(testPool, avatarBody, ownerActor, snapshot),
    (error: unknown) =>
      error instanceof ContentError && error.statusCode === 403,
  );

  // Abandoned verification can be reclaimed without allowing an unexpired URL
  // to recreate a staging orphan after cleanup has already finished.
  const abandonedId = randomUUID();
  const abandonedKey = `content-staging/${abandonedId}/avatar.png`;
  const abandonedExpiry = new Date(Date.now() + 600_000).toISOString();
  assetIds.push(abandonedId);
  storageKeys.add(abandonedKey);
  await testPool.query(
    `insert into content_assets(id,status,kind,storage_key,original_filename,mime_type,byte_size,checksum_sha256,metadata,updated_at)
    values($1,'verifying','image',$2,'avatar.png','image/png',$3,$4,$5,now()-interval '11 minutes')`,
    [
      abandonedId,
      abandonedKey,
      png.length,
      pngChecksum,
      { uploadExpiresAt: abandonedExpiry },
    ],
  );
  configureContentTestRuntime({
    ...process.env,
    CONTENT_ASSET_UPLOAD_TTL_SEC: "60",
  });
  await assetsModule.reclaimStaleContentAssetUploads(testPool, 1);
  const abandonedDeletion = (
    await testPool.query(
      `select available_at from content_storage_deletion_jobs where storage_key=$1`,
      [abandonedKey],
    )
  ).rows[0];
  assert.ok(
    new Date(abandonedDeletion.available_at).getTime() >=
      Date.parse(abandonedExpiry) + 60_000,
  );

  const { clearUserSocialData } =
    await import("./services/social-lifecycle.js");
  for (const removeAssetRow of [false, true]) {
    const deletingUser = randomUUID();
    userIds.push(deletingUser);
    await testPool.query(`insert into users(id) values($1)`, [deletingUser]);
    const delayed = await createContentAssetUpload(
      testPool,
      avatarBody,
      userContentActor(deletingUser),
      snapshot,
    );
    assetIds.push(delayed.asset.id);
    storageKeys.add(delayed.asset.storageKey);
    assert.equal(
      (
        await fetch(delayed.upload.url, {
          method: "PUT",
          headers: delayed.upload.headers,
          body: png,
        })
      ).ok,
      true,
    );
    let copyStarted!: (key: string) => void;
    let resumeCopy!: () => void;
    const started = new Promise<string>((resolve) => {
      copyStarted = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resumeCopy = resolve;
    });
    beforeCopyObject = async (key) => {
      copyStarted(key);
      await paused;
    };
    // Attach the rejection handler before unblocking the provider response.
    const completionRejected = assert.rejects(
      completeContentAssetUpload(
        testPool,
        delayed.asset.id,
        completion,
        userContentActor(deletingUser),
      ),
      (error: unknown) =>
        error instanceof ContentError && error.code === "content_asset_busy",
    );
    let targetKey: string;
    try {
      targetKey = await started;
      storageKeys.add(targetKey);
      await tx(testPool, async (db) => {
        await db.query(`select id from users where id=$1 for update`, [
          deletingUser,
        ]);
        await clearUserSocialData(db, deletingUser);
        await db.query(`delete from users where id=$1`, [deletingUser]);
        if (removeAssetRow)
          await db.query(`delete from content_assets where id=$1`, [
            delayed.asset.id,
          ]);
      });
      await prioritizeStorageDeletion(targetKey);
      await dispatchContentStorageDeletions(
        testPool,
        1,
        `pre-copy-delete-${removeAssetRow}`,
        logger,
      );
      const completedDeletion = (
        await testPool.query(
          `select status from content_storage_deletion_jobs where storage_key=$1`,
          [targetKey],
        )
      ).rows[0];
      assert.equal(completedDeletion.status, "completed");
      assert.equal(objects.has(targetKey), false);
    } finally {
      beforeCopyObject = null;
      resumeCopy();
    }
    await completionRejected;
    assert.equal(
      objects.has(targetKey),
      true,
      "The paused provider copy completed after the first cleanup",
    );
    const reopened = (
      await testPool.query(
        `select status,completed_at,attempts from content_storage_deletion_jobs where storage_key=$1`,
        [targetKey],
      )
    ).rows[0];
    assert.deepEqual(reopened, {
      status: "pending",
      completed_at: null,
      attempts: 0,
    });
    const retainedStaging = (
      await testPool.query(
        `select available_at from content_storage_deletion_jobs where storage_key=$1`,
        [delayed.asset.storageKey],
      )
    ).rows[0];
    assert.ok(
      new Date(retainedStaging.available_at).getTime() >=
        Date.parse(delayed.upload.expiresAt) + 60_000,
    );
    await prioritizeStorageDeletion(targetKey);
    await dispatchContentStorageDeletions(
      testPool,
      1,
      `post-copy-delete-${removeAssetRow}`,
      logger,
    );
    assert.equal(
      objects.has(targetKey),
      false,
      "Late public object must be removed by the reopened cleanup",
    );
  }

  // Losing the COMMIT acknowledgement is different: the ready public object
  // must survive the same failure cleanup path.
  const ambiguous = await createContentAssetUpload(testPool, avatarBody, null);
  assetIds.push(ambiguous.asset.id);
  storageKeys.add(ambiguous.asset.storageKey);
  assert.equal(
    (
      await fetch(ambiguous.upload.url, {
        method: "PUT",
        headers: ambiguous.upload.headers,
        body: png,
      })
    ).ok,
    true,
  );
  const originalConnect = testPool.connect.bind(testPool);
  let lostAcknowledgement = false;
  testPool.connect = (async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    const originalRelease = client.release.bind(client);
    let promoted = false;
    client.query = (async (...args: unknown[]) => {
      const result = await Reflect.apply(originalQuery, client, args);
      const sql = typeof args[0] === "string" ? args[0] : "";
      if (/update content_assets\s+set\s+status = 'ready'/i.test(sql))
        promoted = true;
      if (
        sql.trim().toLowerCase() === "commit" &&
        promoted &&
        !lostAcknowledgement
      ) {
        lostAcknowledgement = true;
        throw new Error("Fixture: commit acknowledgement lost after success");
      }
      return result;
    }) as typeof client.query;
    client.release = ((error?: Error | boolean) => {
      client.query = originalQuery as typeof client.query;
      client.release = originalRelease;
      originalRelease(error);
    }) as typeof client.release;
    return client;
  }) as typeof testPool.connect;
  try {
    await assert.rejects(
      completeContentAssetUpload(
        testPool,
        ambiguous.asset.id,
        completion,
        null,
      ),
      (error: unknown) =>
        error instanceof ContentError &&
        error.code === "content_asset_not_ready",
    );
  } finally {
    testPool.connect = originalConnect as typeof testPool.connect;
  }
  assert.equal(lostAcknowledgement, true);
  const committed = (
    await testPool.query(
      `select status,storage_key from content_assets where id=$1`,
      [ambiguous.asset.id],
    )
  ).rows[0];
  storageKeys.add(committed.storage_key);
  assert.equal(committed.status, "ready");
  assert.equal(objects.has(committed.storage_key), true);
  assert.equal(
    (
      await testPool.query(
        `select 1 from content_storage_deletion_jobs where storage_key=$1`,
        [committed.storage_key],
      )
    ).rows.length,
    0,
  );
  await deleteContentAsset(testPool, ambiguous.asset.id, null);

  const missingIntent = await createContentAssetUpload(
    testPool,
    {
      kind: "image",
      originalFilename: "missing.png",
      mimeType: "image/png",
      expectedByteSize: png.length,
      checksumSha256: pngChecksum,
    },
    null,
  );
  assetIds.push(missingIntent.asset.id);
  storageKeys.add(missingIntent.asset.storageKey);
  await assert.rejects(
    () =>
      completeContentAssetUpload(
        testPool,
        missingIntent.asset.id,
        { byteSize: png.length, checksumSha256: pngChecksum },
        null,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal(error.code, "content_asset_not_ready");
      assert.deepEqual(error.issues, [
        "uploaded object could not be inspected",
      ]);
      return true;
    },
  );

  const fakePdf = Buffer.from("this is not a pdf", "utf8");
  const fakePdfChecksum = checksumHex(fakePdf);
  const invalidIntent = await createContentAssetUpload(
    testPool,
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
        testPool,
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
  const { rows: failedRows } = await testPool.query<{ status: string }>(
    "select status from content_assets where id = $1",
    [invalidIntent.asset.id],
  );
  assert.equal(failedRows[0].status, "failed");
  await prioritizeStorageDeletion(invalidIntent.asset.storageKey);
  await dispatchContentStorageDeletions(
    testPool,
    10,
    "media-test-failed-cleanup",
    logger,
  );
  assert.equal(objects.has(invalidIntent.asset.storageKey), false);

  console.log("[content-media-integration-tests] passed");
} finally {
  try {
    if (pool && assetIds.length > 0) {
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
      await pool.query(
        "delete from content_assets where id = any($1::uuid[])",
        [assetIds],
      );
    }
    if (pool && userIds.length > 0)
      await pool.query(`delete from users where id=any($1::uuid[])`, [userIds]);
  } finally {
    try {
      if (pool) await pool.end();
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  }
}
