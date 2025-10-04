-- Optional but recommended for OHLC helpers
DO $$
BEGIN
  -- Only attempt CREATE EXTENSION if it’s listed as available on this server.
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb_toolkit') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;
  ELSE
    RAISE NOTICE 'timescaledb_toolkit not available; skipping OHLC helpers';
  END IF;
END$$;

-- =========================
-- 1) Mid-price 1m aggregates (from book_top)
-- =========================
CREATE MATERIALIZED VIEW IF NOT EXISTS book_top_1m
WITH (timescaledb.continuous) AS
SELECT
  token_id,
  time_bucket('1 minute', ts) AS bucket,
  avg(mid)       AS avg_mid,
  min(mid)       AS min_mid,
  max(mid)       AS max_mid,
  avg(best_bid)  AS avg_best_bid,
  avg(best_ask)  AS avg_best_ask,
  count(*)       AS samples
FROM book_top
GROUP BY token_id, bucket
WITH NO DATA;

-- Add continuous aggregate policy (skip if already exists)
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy(
    'book_top_1m',
    start_offset => INTERVAL '90 days',
    end_offset   => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE
  );
EXCEPTION WHEN OTHERS THEN
  -- Policy might already exist, ignore
  NULL;
END $$;

-- =========================
-- 2) Trades 1m aggregates (from last_trade)
-- =========================
CREATE MATERIALIZED VIEW IF NOT EXISTS last_trade_1m
WITH (timescaledb.continuous) AS
SELECT
  token_id,
  time_bucket('1 minute', ts) AS bucket,
  sum(size)                        AS volume,
  sum(price * size) / NULLIF(sum(size), 0) AS vwap,
  count(*)                         AS trades
FROM last_trade
GROUP BY token_id, bucket
WITH NO DATA;

-- Add continuous aggregate policy (skip if already exists)
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy(
    'last_trade_1m',
    start_offset => INTERVAL '90 days',
    end_offset   => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- =========================
-- 3) Optional OHLC (only if toolkit is installed)
-- =========================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb_toolkit') THEN
    CREATE MATERIALIZED VIEW IF NOT EXISTS last_trade_1m_ohlc
    WITH (timescaledb.continuous) AS
    SELECT
      token_id,
      time_bucket('1 minute', ts) AS bucket,
      toolkit_experimental.first(price, ts) AS open,
      max(price) AS high,
      min(price) AS low,
      toolkit_experimental.last(price, ts)  AS close,
      sum(size) AS volume
    FROM last_trade
    GROUP BY token_id, bucket
    WITH NO DATA;

    PERFORM add_continuous_aggregate_policy(
      'last_trade_1m_ohlc',
      start_offset => INTERVAL '90 days',
      end_offset   => INTERVAL '1 minute',
      schedule_interval => INTERVAL '1 minute',
      if_not_exists => TRUE
    );
  END IF;
END$$;

-- =========================
-- 4) Retention + compression
-- =========================

-- Add retention policies with error handling
DO $$
BEGIN
  PERFORM add_retention_policy('book_top', INTERVAL '30 days', if_not_exists => TRUE);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM add_retention_policy('last_trade', INTERVAL '30 days', if_not_exists => TRUE);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM add_retention_policy('book_top_1m', INTERVAL '365 days', if_not_exists => TRUE);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM add_retention_policy('last_trade_1m', INTERVAL '365 days', if_not_exists => TRUE);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  IF to_regclass('public.last_trade_1m_ohlc') IS NOT NULL THEN
    PERFORM add_retention_policy('last_trade_1m_ohlc', INTERVAL '365 days', if_not_exists => TRUE);
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Enable compression (moved to migration 0003 to avoid conflicts)
-- DO $$
-- BEGIN
--   ALTER TABLE book_top SET (timescaledb.compress, timescaledb.compress_orderby = 'ts', timescaledb.compress_segmentby = 'token_id');
-- EXCEPTION WHEN OTHERS THEN NULL;
-- END $$;

-- DO $$
-- BEGIN
--   ALTER TABLE last_trade SET (timescaledb.compress, timescaledb.compress_orderby = 'ts', timescaledb.compress_segmentby = 'token_id');
-- EXCEPTION WHEN OTHERS THEN NULL;
-- END $$;

-- Compression policies moved to migration 0003 to avoid conflicts
-- DO $$
-- BEGIN
--   PERFORM add_compression_policy('book_top', INTERVAL '7 days', if_not_exists => TRUE);
-- EXCEPTION WHEN OTHERS THEN NULL;
-- END $$;

-- DO $$
-- BEGIN
--   PERFORM add_compression_policy('last_trade', INTERVAL '7 days', if_not_exists => TRUE);
-- EXCEPTION WHEN OTHERS THEN NULL;
-- END $$;
