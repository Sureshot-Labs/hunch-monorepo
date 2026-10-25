import assert from "node:assert/strict";
import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { recordAccountErasure } from "./services/account-erasure-journal.js";

const userId = "10000000-0000-4000-8000-000000000001";
const source = {
  ACCOUNT_ERASURE_JOURNAL_BUCKET: "private-journal",
  CONTENT_ASSET_S3_BUCKET: "public-assets",
};
const oldRecord = {
  schemaVersion: 1,
  userId,
  requestedAt: new Date(Date.now() - 89 * 86_400_000).toISOString(),
};
const preconditionFailed = { $metadata: { httpStatusCode: 412 } };
const storedRecord = (record: unknown = oldRecord) => ({
  ETag: '"old-record"',
  ContentLength: 160,
  Body: { transformToString: async () => JSON.stringify(record) },
});
const client = (send: (command: unknown) => Promise<unknown>) =>
  ({ send }) as unknown as Pick<S3Client, "send">;

const beforeRetry = Date.now();
let refreshedAt: string | undefined;
let refreshes = 0;
await recordAccountErasure(
  userId,
  client(async (command) => {
    if (command instanceof GetObjectCommand) return storedRecord();
    assert.ok(command instanceof PutObjectCommand);
    assert.equal(command.input.Bucket, source.ACCOUNT_ERASURE_JOURNAL_BUCKET);
    assert.equal(command.input.Key, `account-erasure/v1/${userId}.json`);
    if (command.input.IfNoneMatch === "*") throw preconditionFailed;
    assert.equal(command.input.IfMatch, '"old-record"');
    assert.equal(command.input.IfNoneMatch, undefined);
    assert.equal(command.input.ServerSideEncryption, "AES256");
    const refreshed = JSON.parse(String(command.input.Body));
    assert.equal(refreshed.userId, userId);
    refreshedAt = refreshed.requestedAt;
    refreshes += 1;
    return {};
  }),
  source,
);
assert.equal(refreshes, 1, "An old record must be durably refreshed");
assert.ok(refreshedAt && Date.parse(refreshedAt) >= beforeRetry);
assert.ok(Date.parse(refreshedAt) <= Date.now());

// A 412 alone, or an invalid existing record, must never authorize deletion.
for (const response of [
  storedRecord({
    ...oldRecord,
    userId: "20000000-0000-4000-8000-000000000002",
  }),
  storedRecord({ ...oldRecord, schemaVersion: 2 }),
  { ...storedRecord(), ETag: undefined },
  { ...storedRecord(), Body: undefined },
  { ...storedRecord(), ContentLength: 1025 },
]) {
  let writes = 0;
  await assert.rejects(
    recordAccountErasure(
      userId,
      client(async (command) => {
        if (command instanceof GetObjectCommand) return response;
        assert.ok(command instanceof PutObjectCommand);
        writes += 1;
        throw preconditionFailed;
      }),
      source,
    ),
  );
  assert.equal(writes, 1, "Invalid records must not be overwritten");
}

// Do not acknowledge a refresh that failed or lost a race with another writer.
// A subsequent request can re-read the current version and recover normally.
for (const refreshError of [
  new Error("refresh unavailable"),
  preconditionFailed,
  { $metadata: { httpStatusCode: 409 } },
  { $metadata: { httpStatusCode: 404 } },
]) {
  let failRefresh = true;
  let currentEtag = '"old-record"';
  let successfulRefreshes = 0;
  const s3 = client(async (command) => {
    if (command instanceof GetObjectCommand)
      return { ...storedRecord(), ETag: currentEtag };
    assert.ok(command instanceof PutObjectCommand);
    if (command.input.IfNoneMatch === "*") throw preconditionFailed;
    assert.equal(command.input.IfMatch, currentEtag);
    if (failRefresh) throw refreshError;
    successfulRefreshes += 1;
    return {};
  });
  await assert.rejects(recordAccountErasure(userId, s3, source), (error) => {
    assert.equal(error, refreshError);
    return true;
  });
  assert.equal(successfulRefreshes, 0);
  failRefresh = false;
  currentEtag = '"new-record"';
  await recordAccountErasure(userId, s3, source);
  assert.equal(successfulRefreshes, 1);
}

console.log(
  "[account-erasure-retention] passed: delayed retry refresh, record validation, conditional-write failures and recovery",
);
