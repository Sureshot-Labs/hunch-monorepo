/** Run against an isolated RESTORED database before opening traffic/workers. */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { AuthService } from "./auth.js";
import { pool } from "./db.js";
import {
  erasureJournalConfig,
  erasureRecordSchema,
  ERASURE_JOURNAL_PREFIX,
} from "./services/account-erasure-journal.js";

const apply = process.argv.includes("--apply");
if (apply && process.env.ACCOUNT_ERASURE_RESTORE_ISOLATED !== "true")
  throw new Error(
    "Keep restored database isolated and set ACCOUNT_ERASURE_RESTORE_ISOLATED=true before --apply",
  );
const { bucket, region } = erasureJournalConfig();
const s3 = new S3Client({ region });
let cursor: string | undefined;
let checked = 0;
let replayed = 0;
try {
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: ERASURE_JOURNAL_PREFIX,
        MaxKeys: 100,
        ContinuationToken: cursor,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (!object.Key || Number(object.Size) > 1024)
        throw new Error("Invalid journal object");
      const result = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: object.Key }),
      );
      if (!result.Body) throw new Error("Missing journal body");
      const record = erasureRecordSchema.parse(
        JSON.parse(await result.Body.transformToString()),
      );
      if (object.Key !== ERASURE_JOURNAL_PREFIX + record.userId + ".json")
        throw new Error("Journal identity mismatch");
      checked += 1;
      if (apply) {
        // Reuses financial safety locks, social erasure and provider reconciliation outbox.
        // No new trade, transfer, payout or withdrawal is created.
        await AuthService.deleteUser(record.userId);
        replayed += 1;
      }
    }
    cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !cursor)
      throw new Error("Journal pagination did not advance");
  } while (cursor);
  console.log(
    JSON.stringify({ mode: apply ? "applied" : "dry_run", checked, replayed }),
  );
} finally {
  s3.destroy();
  await pool.end();
}
