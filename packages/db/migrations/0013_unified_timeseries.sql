-- Unified timeseries tables migration
-- This migration creates unified timeseries tables to replace the legacy book_top and last_trade tables
-- These tables store historical price and trade data across all venues

-- Unified book top timeseries table - stores top-of-book data from all venues
CREATE TABLE IF NOT EXISTS unified_book_top (
  token_id text NOT NULL,
  venue text NOT NULL, -- 'polymarket', 'kalshi', 'limitless'
  ts timestamptz NOT NULL,
  best_bid numeric,
  best_ask numeric,
  mid numeric,
  spread numeric,
  PRIMARY KEY (token_id, ts)
);

-- Convert to TimescaleDB hypertable for efficient time-series storage
SELECT create_hypertable('unified_book_top', 'ts', if_not_exists => true);

-- Unified last trade timeseries table - stores trade data from all venues
CREATE TABLE IF NOT EXISTS unified_last_trade (
  token_id text NOT NULL,
  venue text NOT NULL, -- 'polymarket', 'kalshi', 'limitless'
  ts timestamptz NOT NULL,
  price numeric NOT NULL CHECK (price >= 0 AND price <= 1),
  size numeric NOT NULL CHECK (size > 0),
  side text CHECK (side IN ('BUY','SELL')) NOT NULL,
  tx_hash text,
  PRIMARY KEY (token_id, ts)
);

-- Convert to TimescaleDB hypertable for efficient time-series storage
SELECT create_hypertable('unified_last_trade', 'ts', if_not_exists => true);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_unified_book_top_recent ON unified_book_top (token_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_unified_book_top_venue ON unified_book_top (venue, ts DESC);
CREATE INDEX IF NOT EXISTS idx_unified_last_trade_recent ON unified_last_trade (token_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_unified_last_trade_venue ON unified_last_trade (venue, ts DESC);

-- Continuous aggregates for 1-minute data (similar to legacy book_top_1m)
CREATE MATERIALIZED VIEW IF NOT EXISTS unified_book_top_1m
WITH (timescaledb.continuous) AS
SELECT
  token_id,
  venue,
  time_bucket('1 minute', ts) AS bucket,
  avg(mid)       AS avg_mid,
  min(mid)       AS min_mid,
  max(mid)       AS max_mid,
  avg(best_bid)  AS avg_best_bid,
  avg(best_ask)  AS avg_best_ask,
  count(*)       AS samples
FROM unified_book_top
GROUP BY token_id, venue, bucket
WITH NO DATA;

-- Continuous aggregates for 1-minute trade data
CREATE MATERIALIZED VIEW IF NOT EXISTS unified_last_trade_1m
WITH (timescaledb.continuous) AS
SELECT
  token_id,
  venue,
  time_bucket('1 minute', ts) AS bucket,
  sum(size)                        AS volume,
  sum(price * size) / NULLIF(sum(size), 0) AS vwap,
  count(*)                         AS trades
FROM unified_last_trade
GROUP BY token_id, venue, bucket
WITH NO DATA;

-- Add continuous aggregate policies
SELECT add_continuous_aggregate_policy(
  'unified_book_top_1m',
  start_offset => INTERVAL '90 days',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute'
);

SELECT add_continuous_aggregate_policy(
  'unified_last_trade_1m',
  start_offset => INTERVAL '90 days',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute'
);

-- Retention policies (keep raw data for 30 days, aggregates for 365 days)
SELECT add_retention_policy('unified_book_top',      INTERVAL '30 days');
SELECT add_retention_policy('unified_last_trade',    INTERVAL '30 days');
SELECT add_retention_policy('unified_book_top_1m',   INTERVAL '365 days');
SELECT add_retention_policy('unified_last_trade_1m', INTERVAL '365 days');

-- Compression policies (compress data older than 7 days)
ALTER TABLE unified_book_top  SET (timescaledb.compress, timescaledb.compress_orderby = 'ts', timescaledb.compress_segmentby = 'token_id');
ALTER TABLE unified_last_trade SET (timescaledb.compress, timescaledb.compress_orderby = 'ts', timescaledb.compress_segmentby = 'token_id');

SELECT add_compression_policy('unified_book_top',  INTERVAL '7 days');
SELECT add_compression_policy('unified_last_trade', INTERVAL '7 days');

-- Add comments for documentation
COMMENT ON TABLE unified_book_top IS 'Unified timeseries table for top-of-book data from all venues';
COMMENT ON TABLE unified_last_trade IS 'Unified timeseries table for trade data from all venues';
COMMENT ON COLUMN unified_book_top.token_id IS 'Token identifier (format varies by venue)';
COMMENT ON COLUMN unified_book_top.venue IS 'Source venue: polymarket, kalshi, or limitless';
COMMENT ON COLUMN unified_last_trade.token_id IS 'Token identifier (format varies by venue)';
COMMENT ON COLUMN unified_last_trade.venue IS 'Source venue: polymarket, kalshi, or limitless';
