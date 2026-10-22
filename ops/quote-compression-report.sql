-- Read-only TimescaleDB 2.14 inventory. No raw quote scan, policy change,
-- compression, retention or EXPLAIN ANALYZE. Run with psql ON_ERROR_STOP=1.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SELECT now() AS observed_at, current_database() AS database_name,
       current_setting('server_version') AS postgres_version,
       extversion AS timescale_version
FROM pg_extension WHERE extname = 'timescaledb';

SELECT jobs.job_id, jobs.proc_name, jobs.schedule_interval, jobs.config,
       stats.last_run_status, stats.last_successful_finish, stats.next_start
FROM timescaledb_information.jobs jobs
LEFT JOIN timescaledb_information.job_stats stats USING (job_id)
WHERE jobs.hypertable_schema = 'public' AND jobs.hypertable_name = 'unified_book_top'
ORDER BY jobs.job_id;

WITH compression_ratio AS (
  SELECT sum(after_compression_total_bytes)::numeric /
         nullif(sum(before_compression_total_bytes), 0) AS compressed_fraction
  FROM chunk_compression_stats('public.unified_book_top')
  WHERE compression_status = 'Compressed'
), uncompressed_chunks AS MATERIALIZED (
  SELECT chunk_schema, chunk_name, range_end,
         pg_total_relation_size(format('%I.%I', chunk_schema, chunk_name)::regclass) AS current_bytes
  FROM timescaledb_information.chunks
  WHERE hypertable_schema = 'public' AND hypertable_name = 'unified_book_top'
    AND NOT is_compressed
), candidate_policies(candidate_days) AS (VALUES (7), (3), (2))
SELECT candidate_days, count(chunk_name) AS eligible_uncompressed_chunks,
       coalesce(sum(current_bytes), 0) AS eligible_bytes,
       round(compressed_fraction, 4) AS historical_compressed_fraction,
       round(sum(current_bytes) * (1 - compressed_fraction)) AS estimated_reclaim_bytes
FROM candidate_policies
CROSS JOIN compression_ratio
LEFT JOIN uncompressed_chunks ON range_end < now() - candidate_days * interval '1 day'
GROUP BY candidate_days, compressed_fraction ORDER BY candidate_days DESC;
-- Ratio is the recorded before/after size of previously compressed chunks, not
-- a guarantee for newer chunks or a measure of ongoing late-write overhead.
COMMIT;
