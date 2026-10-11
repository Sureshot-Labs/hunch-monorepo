-- Additive passive canary only. No financial rows or provider calls/backfill.
CREATE TABLE IF NOT EXISTS hip4_read_markets (
  market_id text PRIMARY KEY REFERENCES unified_markets(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('mainnet', 'testnet')),
  outcome bigint NOT NULL CHECK (outcome >= 0),
  fetched_at timestamptz NOT NULL,
  generation uuid NOT NULL,
  read_model jsonb NOT NULL,
  raw jsonb NOT NULL,
  UNIQUE (environment, outcome)
);

-- The provider's identity is time + coin + tid. Timestamps are not perturbed
-- to fit unified_last_trade, whose token/timestamp PK cannot represent ties.
CREATE TABLE IF NOT EXISTS hip4_public_trades (
  environment text NOT NULL CHECK (environment IN ('mainnet', 'testnet')),
  coin text NOT NULL,
  time_ms bigint NOT NULL,
  tid bigint NOT NULL,
  market_id text NOT NULL REFERENCES hip4_read_markets(market_id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('A', 'B')),
  price numeric NOT NULL CHECK (price >= 0 AND price <= 1),
  size numeric NOT NULL CHECK (size > 0),
  transaction_hash text NOT NULL,
  PRIMARY KEY (environment, coin, time_ms, tid)
);
CREATE INDEX IF NOT EXISTS hip4_public_trades_market_time_idx
  ON hip4_public_trades (market_id, time_ms DESC, coin, tid);

-- Shared admission budget for public protocol consumers, not an API-local
-- in-memory limiter. Rejected/failed requests still consume their weight.
CREATE TABLE IF NOT EXISTS hip4_read_runtime (
  environment text PRIMARY KEY CHECK (environment IN ('mainnet', 'testnet')),
  after_outcome bigint NOT NULL DEFAULT -1
);

CREATE TABLE IF NOT EXISTS hip4_request_budget (
  scope text PRIMARY KEY,
  admissions jsonb NOT NULL DEFAULT '[]'::jsonb
);
