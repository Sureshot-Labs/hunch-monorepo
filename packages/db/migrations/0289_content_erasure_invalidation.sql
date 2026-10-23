-- No table rewrite or unbounded backfill for existing deletion jobs.
ALTER TABLE content_storage_deletion_jobs
  ADD COLUMN cdn_invalidation_id text,
  ADD COLUMN cdn_invalidation_reference uuid;
ALTER TABLE content_storage_deletion_jobs
  ALTER COLUMN cdn_invalidation_reference SET DEFAULT gen_random_uuid();
