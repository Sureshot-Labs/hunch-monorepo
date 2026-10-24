import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ServiceException,
} from "@aws-sdk/client-s3";
import { z } from "zod";

export const erasureRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    userId: z.string().uuid(),
    requestedAt: z.string().datetime(),
  })
  .strict();
export type ErasureRecord = z.infer<typeof erasureRecordSchema>;
export const ERASURE_JOURNAL_PREFIX = "account-erasure/v1/";

export function erasureJournalConfig(source: NodeJS.ProcessEnv = process.env) {
  const bucket = source.ACCOUNT_ERASURE_JOURNAL_BUCKET?.trim();
  if (!bucket || bucket === source.CONTENT_ASSET_S3_BUCKET?.trim())
    throw new Error(
      "A separate private account erasure journal bucket is required",
    );
  return { bucket, region: source.AWS_REGION?.trim() || "eu-north-1" };
}

/** Acknowledged outside the database volume BEFORE account deletion is committed. */
export async function recordAccountErasure(
  userId: string,
  client?: Pick<S3Client, "send">,
  source: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { bucket, region } = erasureJournalConfig(source);
  const record = erasureRecordSchema.parse({
    schemaVersion: 1,
    userId,
    requestedAt: new Date().toISOString(),
  });
  const s3 = client ?? new S3Client({ region, maxAttempts: 2 });
  const key = ERASURE_JOURNAL_PREFIX + userId + ".json";
  const writeRecord = (condition: { IfNoneMatch: "*" } | { IfMatch: string }) =>
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(record),
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
        ...condition,
      }),
      { abortSignal: AbortSignal.timeout(10_000) },
    );
  try {
    await writeRecord({ IfNoneMatch: "*" });
  } catch (error) {
    // Validate an earlier request before refreshing its S3 lifecycle clock.
    if ((error as S3ServiceException).$metadata?.httpStatusCode !== 412)
      throw error;
    const stored = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(10_000) },
    );
    if (
      !stored.Body ||
      !stored.ETag ||
      Number(stored.ContentLength ?? 0) > 1024
    )
      throw new Error("Invalid erasure journal record");
    const existing = erasureRecordSchema.parse(
      JSON.parse(await stored.Body.transformToString()),
    );
    if (existing.userId !== userId)
      throw new Error("Erasure journal owner mismatch");
    // DB erasure may have failed long ago. Acknowledging that old object alone
    // could let it expire before backups taken since the failed attempt.
    // A concurrent change must fail this request, which can then be retried.
    await writeRecord({ IfMatch: stored.ETag });
  } finally {
    if (!client && s3 instanceof S3Client) s3.destroy();
  }
}
