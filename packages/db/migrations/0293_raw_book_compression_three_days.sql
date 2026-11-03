-- Change only the existing raw quote compression job. No quote rewrite runs
-- during deploy; missing/alternative optional policies are left untouched.
-- Keep the installed job id, schedule, next start, retries and enabled state.
-- TimescaleDB 2.14 supports maxchunks_to_compress: one chunk per invocation
-- bounds the initial backlog without compressing several GiB in migration.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

SELECT alter_job(
  compression_job.job_id,
  config => compression_job.config || jsonb_build_object(
    'compress_after', '3 days',
    'maxchunks_to_compress', 1
  )
)
FROM timescaledb_information.jobs compression_job
WHERE compression_job.hypertable_schema = 'public'
  AND compression_job.hypertable_name = 'unified_book_top'
  AND compression_job.proc_name = 'policy_compression'
  AND compression_job.config ? 'compress_after'
  AND NOT (compression_job.config ? 'compress_created_before');
