-- LOCAL DISPOSABLE DATABASE ONLY. Never run against production.
-- Target must be a fresh storage_maintenance_test database on PG16/TS2.14.2.
\set ON_ERROR_STOP on
\timing on
DO $$ BEGIN
  IF current_database() <> 'storage_maintenance_test' OR
     current_setting('server_version_num')::int NOT BETWEEN 160000 AND 169999 THEN
    RAISE EXCEPTION 'Expected disposable storage_maintenance_test on PG16';
  END IF;
END $$;
CREATE EXTENSION IF NOT EXISTS timescaledb;
DO $$ BEGIN
  IF (SELECT extversion FROM pg_extension WHERE extname = 'timescaledb') <> '2.14.2' THEN
    RAISE EXCEPTION 'Expected TimescaleDB 2.14.2';
  END IF;
END $$;
SET statement_timeout = '60s';
SET lock_timeout = '2s';
SET timezone = 'UTC';
CREATE TABLE unified_book_top (
  token_id text NOT NULL, venue text NOT NULL, ts timestamptz NOT NULL,
  best_bid numeric, best_ask numeric, mid numeric, spread numeric,
  PRIMARY KEY (token_id, ts)
);
SELECT create_hypertable('unified_book_top', 'ts', chunk_time_interval => interval '1 day');
-- The redundant recent and venue indexes were removed by migrations 0066/0238.
-- Keep the PK and Timescale's automatic ts index, matching the migrated schema.
ALTER TABLE unified_book_top SET (timescaledb.compress,
  timescaledb.compress_orderby = 'ts', timescaledb.compress_segmentby = 'token_id');
INSERT INTO unified_book_top
SELECT 'probe:' || token_number, 'polymarket',
       date_trunc('day', now()) - day_number * interval '1 day' + tick_number * interval '86 seconds',
       0.40 + tick_number::numeric / 100000, 0.42 + tick_number::numeric / 100000,
       0.41 + tick_number::numeric / 100000, 0.02
FROM generate_series(1, 100) token_number
CROSS JOIN generate_series(1, 10) day_number
CROSS JOIN generate_series(0, 999) tick_number;
ANALYZE unified_book_top;
CREATE MATERIALIZED VIEW unified_book_top_1m WITH (timescaledb.continuous) AS
SELECT token_id, venue, time_bucket('1 minute', ts) AS bucket,
       avg(mid) AS avg_mid, count(*) AS samples
FROM unified_book_top GROUP BY token_id, venue, bucket WITH NO DATA;
CALL refresh_continuous_aggregate('unified_book_top_1m', NULL, NULL);
CREATE TEMP TABLE probe_baseline AS
SELECT count(*) AS row_count, sum(mid) AS mid_sum FROM unified_book_top;
SELECT 'before' AS phase, * FROM hypertable_detailed_size('unified_book_top');
EXPLAIN (ANALYZE, BUFFERS) SELECT ts, mid FROM unified_book_top
WHERE token_id = 'probe:1' AND ts >= now() - interval '8 days' ORDER BY ts DESC LIMIT 100;
EXPLAIN (ANALYZE, BUFFERS) SELECT ts FROM unified_book_top
WHERE token_id = 'absent' AND ts >= now() - interval '8 days' ORDER BY ts DESC LIMIT 100;
SELECT compress_chunk(chunk_ref) FROM show_chunks('unified_book_top', older_than => interval '3 days') chunk_ref;
SELECT 'after_3_days' AS phase, * FROM hypertable_detailed_size('unified_book_top');
EXPLAIN (ANALYZE, BUFFERS) SELECT ts, mid FROM unified_book_top
WHERE token_id = 'probe:1' AND ts >= now() - interval '8 days' ORDER BY ts DESC LIMIT 100;
EXPLAIN (ANALYZE, BUFFERS) SELECT ts FROM unified_book_top
WHERE token_id = 'absent' AND ts >= now() - interval '8 days' ORDER BY ts DESC LIMIT 100;
EXPLAIN (ANALYZE, BUFFERS) SELECT time_bucket('1 hour', ts) AS bucket, avg(mid)
FROM unified_book_top WHERE token_id = 'probe:1'
AND ts >= date_trunc('day', now()) - interval '8 days'
AND ts < date_trunc('day', now()) - interval '7 days' GROUP BY bucket;
DO $$ BEGIN
  IF (SELECT row_count FROM probe_baseline) <> (SELECT count(*) FROM unified_book_top)
    OR (SELECT mid_sum FROM probe_baseline) <> (SELECT sum(mid) FROM unified_book_top) THEN
    RAISE EXCEPTION 'Compression changed quote data';
  END IF;
END $$;
-- Same INSERT ... SELECT ... ON CONFLICT DO NOTHING shape as the batch writer:
-- duplicate first, then new rows in the SAME compressed segment/chunk.
CREATE TEMP TABLE probe_batch (LIKE unified_book_top);
INSERT INTO probe_batch VALUES
 ('probe:1','polymarket',date_trunc('day',now())-interval '8 days',0.4,0.42,0.41,0.02),
 ('probe:1','polymarket',date_trunc('day',now())-interval '8 days'+interval '1 second',0.5,0.52,0.51,0.02),
 ('probe:1','polymarket',date_trunc('day',now())-interval '8 days'+interval '2 seconds',0.6,0.62,0.61,0.02);
INSERT INTO unified_book_top SELECT * FROM probe_batch ORDER BY ts ON CONFLICT DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM unified_book_top WHERE token_id = 'probe:1'
      AND ts >= date_trunc('day',now())-interval '8 days'
      AND ts < date_trunc('day',now())-interval '8 days'+interval '3 seconds') <> 3 THEN
    RAISE EXCEPTION 'Late batch dropped rows after a duplicate';
  END IF;
END $$;
UPDATE unified_book_top SET mid = 0.55 WHERE token_id = 'probe:1'
AND ts = date_trunc('day',now())-interval '8 days'+interval '1 second';
DELETE FROM unified_book_top WHERE token_id = 'probe:1'
AND ts = date_trunc('day',now())-interval '8 days'+interval '2 seconds';
CALL refresh_continuous_aggregate('unified_book_top_1m', NULL, NULL);
DO $$ BEGIN
  IF (SELECT count(*) FROM unified_book_top) <> 1000001 THEN
    RAISE EXCEPTION 'Unexpected late-write row count';
  END IF;
  IF (SELECT mid FROM unified_book_top WHERE token_id = 'probe:1'
      AND ts = date_trunc('day',now())-interval '8 days'+interval '1 second') IS DISTINCT FROM 0.55::numeric THEN
    RAISE EXCEPTION 'Late update did not persist';
  END IF;
  IF EXISTS (SELECT 1 FROM unified_book_top WHERE token_id = 'probe:1'
      AND ts = date_trunc('day',now())-interval '8 days'+interval '2 seconds') THEN
    RAISE EXCEPTION 'Late delete did not persist';
  END IF;
  IF (SELECT sum(samples) FROM unified_book_top_1m) <> (SELECT count(*) FROM unified_book_top) THEN
    RAISE EXCEPTION 'Aggregate did not reflect late writes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT time_bucket('1 minute',ts) AS quote_bucket, avg(mid) AS expected_mid, count(*) AS expected_samples
      FROM unified_book_top WHERE token_id = 'probe:1' GROUP BY quote_bucket
    ) raw_summary FULL JOIN (
      SELECT bucket, avg_mid, samples FROM unified_book_top_1m WHERE token_id = 'probe:1'
    ) aggregate_summary ON aggregate_summary.bucket = raw_summary.quote_bucket
    WHERE aggregate_summary.avg_mid IS DISTINCT FROM raw_summary.expected_mid
       OR aggregate_summary.samples IS DISTINCT FROM raw_summary.expected_samples
  ) THEN
    RAISE EXCEPTION 'Aggregate values did not reflect late writes';
  END IF;
END $$;
SELECT 'late_insert_update_delete_and_refresh_passed' AS result;
