import type { DbQuery } from "../db.js";

// Existing storage-safety grace: a presigned PUT can be replayed until expiry.
const STAGING_DELETE_GRACE_SECONDS = 60;

export function stagingDeletionAvailableAt(input: {
  uploadTtlSec: number;
  uploadExpiresAt?: unknown;
  now?: Date;
}): Date {
  const now = input.now ?? new Date();
  const recordedExpiry =
    typeof input.uploadExpiresAt === "string"
      ? Date.parse(input.uploadExpiresAt)
      : Number.NaN;
  const expiry = Number.isFinite(recordedExpiry)
    ? recordedExpiry
    : now.getTime() + input.uploadTtlSec * 1_000;
  return new Date(
    Math.max(now.getTime(), expiry + STAGING_DELETE_GRACE_SECONDS * 1_000),
  );
}

export async function enqueueContentStorageDeletion(
  db: DbQuery,
  key: string,
  availableAt: Date = new Date(),
  // Use only after a later remote write may have recreated a previously deleted
  // key. Ordinary idempotent cleanup keeps completed jobs completed.
  options: { reopenAfterPossibleWrite?: boolean } = {},
): Promise<void> {
  const staging = key.startsWith("content-staging/");
  await db.query(
    `insert into content_storage_deletion_jobs(storage_key,available_at)
    values($1,$2) on conflict(storage_key) do update set
    status=case when not $4::boolean and content_storage_deletion_jobs.status='completed'
      and (not $3::boolean or content_storage_deletion_jobs.completed_at>=excluded.available_at) then 'completed' else 'pending' end,
    completed_at=case when not $4::boolean and content_storage_deletion_jobs.status='completed'
      and (not $3::boolean or content_storage_deletion_jobs.completed_at>=excluded.available_at) then content_storage_deletion_jobs.completed_at else null end,
    available_at=case when $3::boolean then greatest(content_storage_deletion_jobs.available_at,excluded.available_at)
      else least(content_storage_deletion_jobs.available_at,excluded.available_at) end,
    attempts=case when $4::boolean then 0 else content_storage_deletion_jobs.attempts end,
    last_error=case when $4::boolean then null else content_storage_deletion_jobs.last_error end,
    locked_at=null,locked_by=null`,
    [key, availableAt, staging, options.reopenAfterPossibleWrite ?? false],
  );
}
