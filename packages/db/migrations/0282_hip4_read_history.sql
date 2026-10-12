-- Derived read-only data. Existing 0281 snapshots/readers remain compatible.
CREATE TABLE IF NOT EXISTS hip4_candles (
  market_id text NOT NULL REFERENCES hip4_read_markets(market_id) ON DELETE CASCADE,
  bucket_ms bigint NOT NULL,
  open_price numeric NOT NULL, high_price numeric NOT NULL,
  low_price numeric NOT NULL, close_price numeric NOT NULL,
  volume numeric NOT NULL CHECK (volume > 0), trade_count bigint NOT NULL CHECK (trade_count > 0),
  first_time_ms bigint NOT NULL, first_tid bigint NOT NULL,
  last_time_ms bigint NOT NULL, last_tid bigint NOT NULL,
  PRIMARY KEY (market_id,bucket_ms)
);
-- One-minute pieces bound overlap scans without a new extension. Missing
-- intervals are unknown, not evidence of zero trading. Even observed intervals
-- are explicitly partial: public streams do not expose a completeness sequence.
CREATE TABLE IF NOT EXISTS hip4_observation_intervals (
  market_id text NOT NULL REFERENCES hip4_read_markets(market_id) ON DELETE CASCADE,
  bucket_ms bigint NOT NULL,
  start_ms bigint NOT NULL, end_ms bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('observed','gap')),
  reason text NOT NULL,
  CHECK (end_ms >= start_ms AND end_ms - start_ms <= 60000),
  PRIMARY KEY (market_id,bucket_ms,kind,reason)
);
