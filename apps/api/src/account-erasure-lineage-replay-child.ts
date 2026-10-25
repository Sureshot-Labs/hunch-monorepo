import { readFile } from "node:fs/promises";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  erasureJournalKey,
  type ErasureRecord,
} from "./services/account-erasure-journal.js";
const [file, url, database] = process.argv.slice(2);
const records = JSON.parse(await readFile(file, "utf8")) as ErasureRecord[];
const original = S3Client.prototype.send;
S3Client.prototype.send = (async (command: unknown) => {
  if (command instanceof ListObjectsV2Command)
    return {
      Contents: records.map((record) => ({
        Key: erasureJournalKey(record),
        Size: 200,
      })),
    };
  if (command instanceof GetObjectCommand) {
    const record = records.find(
      (record) => erasureJournalKey(record) === command.input.Key,
    );
    if (!record) throw new Error("Unknown fixture journal key");
    return { Body: { transformToString: async () => JSON.stringify(record) } };
  }
  throw new Error("Unexpected journal command");
}) as typeof S3Client.prototype.send;
process.env.ACCOUNT_ERASURE_RESTORE_ISOLATED = "true";
process.argv = [
  process.execPath,
  new URL("./account-erasure-replay.ts", import.meta.url).pathname,
  "--database-url",
  url,
  "--expect-database",
  database,
  "--apply",
];
try {
  await import("./account-erasure-replay.js");
} finally {
  S3Client.prototype.send = original;
  const { closeAcquiredRuntimeResources, unregisterRuntimeResourceCleanup } =
    await import("./runtime-resource-cleanup.js");
  unregisterRuntimeResourceCleanup("api-database");
  await closeAcquiredRuntimeResources();
}
