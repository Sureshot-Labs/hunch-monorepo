/* no-transaction */
SET statement_timeout = 0;

CREATE MATERIALIZED VIEW IF NOT EXISTS unified_book_top_1h
WITH (timescaledb.continuous) AS
SELECT
  token_id,
  venue,
  time_bucket('1 hour', ts) AS bucket,
  avg(mid)       AS avg_mid,
  min(mid)       AS min_mid,
  max(mid)       AS max_mid,
  avg(best_bid)  AS avg_best_bid,
  avg(best_ask)  AS avg_best_ask,
  count(*)       AS samples
FROM unified_book_top
GROUP BY token_id, venue, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'unified_book_top_1h',
  start_offset => INTERVAL '90 days',
  end_offset   => INTERVAL '10 minutes',
  schedule_interval => INTERVAL '1 hour'
)
WHERE NOT EXISTS (
  SELECT 1
  FROM timescaledb_information.continuous_aggregates c
  JOIN timescaledb_information.jobs j
    ON j.proc_name = 'policy_refresh_continuous_aggregate'
   AND j.hypertable_name = c.materialization_hypertable_name
  WHERE c.view_name = 'unified_book_top_1h'
);

SELECT add_retention_policy('unified_book_top_1h', INTERVAL '365 days')
WHERE NOT EXISTS (
  SELECT 1
  FROM timescaledb_information.continuous_aggregates c
  JOIN timescaledb_information.jobs j
    ON j.proc_name = 'policy_retention'
   AND j.hypertable_name = c.materialization_hypertable_name
  WHERE c.view_name = 'unified_book_top_1h'
);

CREATE INDEX IF NOT EXISTS idx_unified_book_top_1h_token_bucket
  ON unified_book_top_1h (token_id, bucket DESC);

CREATE INDEX IF NOT EXISTS idx_unified_book_top_1h_venue_bucket
  ON unified_book_top_1h (venue, bucket DESC);

CALL refresh_continuous_aggregate(
  'unified_book_top_1h',
  now() - INTERVAL '2 days',
  now()
);
