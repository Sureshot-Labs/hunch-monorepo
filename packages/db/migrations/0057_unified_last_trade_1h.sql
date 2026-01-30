/* no-transaction */
SET statement_timeout = 0;

CREATE MATERIALIZED VIEW IF NOT EXISTS unified_last_trade_1h
WITH (timescaledb.continuous) AS
SELECT
  token_id,
  venue,
  time_bucket('1 hour', ts) AS bucket,
  sum(size) AS volume,
  (sum(price * size) / NULLIF(sum(size), 0)) AS vwap,
  count(*) AS trades
FROM unified_last_trade
GROUP BY token_id, venue, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'unified_last_trade_1h',
  start_offset => INTERVAL '90 days',
  end_offset   => INTERVAL '10 minutes',
  schedule_interval => INTERVAL '10 minutes'
)
WHERE NOT EXISTS (
  SELECT 1
  FROM timescaledb_information.continuous_aggregates c
  JOIN timescaledb_information.jobs j
    ON j.proc_name = 'policy_refresh_continuous_aggregate'
   AND j.hypertable_name = c.materialization_hypertable_name
  WHERE c.view_name = 'unified_last_trade_1h'
);

SELECT add_retention_policy('unified_last_trade_1h', INTERVAL '365 days')
WHERE NOT EXISTS (
  SELECT 1
  FROM timescaledb_information.continuous_aggregates c
  JOIN timescaledb_information.jobs j
    ON j.proc_name = 'policy_retention'
   AND j.hypertable_name = c.materialization_hypertable_name
  WHERE c.view_name = 'unified_last_trade_1h'
);

CREATE INDEX IF NOT EXISTS idx_unified_last_trade_1h_venue_bucket
  ON unified_last_trade_1h (venue, bucket);

CALL refresh_continuous_aggregate(
  'unified_last_trade_1h',
  now() - INTERVAL '2 days',
  now()
);
