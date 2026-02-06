/* no-transaction */
SET statement_timeout = 0;

-- Reduce refresh windows to match operational needs and lower write I/O pressure.
SELECT remove_continuous_aggregate_policy(
  'unified_book_top_1m'::regclass,
  if_exists => true
);

SELECT add_continuous_aggregate_policy(
  'unified_book_top_1m'::regclass,
  start_offset => INTERVAL '24 hours',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => true
);

SELECT remove_continuous_aggregate_policy(
  'unified_last_trade_1m'::regclass,
  if_exists => true
);

SELECT add_continuous_aggregate_policy(
  'unified_last_trade_1m'::regclass,
  start_offset => INTERVAL '24 hours',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => true
);

SELECT remove_continuous_aggregate_policy(
  'unified_last_trade_1h'::regclass,
  if_exists => true
);

SELECT add_continuous_aggregate_policy(
  'unified_last_trade_1h'::regclass,
  start_offset => INTERVAL '7 days',
  end_offset => INTERVAL '10 minutes',
  schedule_interval => INTERVAL '10 minutes',
  if_not_exists => true
);

SELECT remove_continuous_aggregate_policy(
  'unified_book_top_1h'::regclass,
  if_exists => true
);

SELECT add_continuous_aggregate_policy(
  'unified_book_top_1h'::regclass,
  start_offset => INTERVAL '7 days',
  end_offset => INTERVAL '10 minutes',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => true
);

SELECT remove_continuous_aggregate_policy(
  'unified_last_trade_24h'::regclass,
  if_exists => true
);

SELECT add_continuous_aggregate_policy(
  'unified_last_trade_24h'::regclass,
  start_offset => INTERVAL '30 days',
  end_offset => INTERVAL '10 minutes',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => true
);

-- pkey(token_id, ts) already covers this lookup direction for conflict checks.
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_book_top_recent;
