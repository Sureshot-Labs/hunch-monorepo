-- Wallet intel aggregates for fast whale + summary queries.

CREATE TABLE IF NOT EXISTS wallet_activity_hourly (
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  venue text NOT NULL,
  market_id text NOT NULL,
  outcome_side text NOT NULL DEFAULT '',
  activity_type text NOT NULL CHECK (activity_type IN ('delta', 'trade', 'holder')),
  hour_bucket timestamptz NOT NULL,
  event_count integer,
  volume_usd numeric,
  delta_shares_sum numeric,
  price_weighted_sum numeric,
  signed_delta_shares numeric,
  signed_delta_usd numeric,
  abs_delta_usd numeric,
  max_abs_delta_usd numeric,
  last_occurred_at timestamptz,
  last_price numeric,
  last_change_action text,
  entered_late boolean,
  counts_opened integer,
  counts_closed integer,
  counts_increased integer,
  counts_reduced integer,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (wallet_id, venue, market_id, outcome_side, activity_type, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_wallet_activity_hourly_wallet_time
  ON wallet_activity_hourly(wallet_id, hour_bucket DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_activity_hourly_wallet_market_time
  ON wallet_activity_hourly(wallet_id, market_id, outcome_side, hour_bucket DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_activity_hourly_wallet_type_time
  ON wallet_activity_hourly(wallet_id, activity_type, hour_bucket DESC);

CREATE TABLE IF NOT EXISTS wallet_activity_baseline (
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  window_days integer NOT NULL,
  as_of timestamptz NOT NULL,
  p50_usd numeric,
  p90_usd numeric,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (wallet_id, window_days)
);

CREATE INDEX IF NOT EXISTS idx_wallet_activity_baseline_window
  ON wallet_activity_baseline(window_days, as_of DESC);

CREATE TABLE IF NOT EXISTS wallet_position_exposure (
  wallet_id uuid PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
  exposure_usd numeric,
  as_of timestamptz NOT NULL,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_inferred_outcomes (
  wallet_id uuid PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
  wins integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

-- Support faster wallet intel scans.
CREATE INDEX IF NOT EXISTS idx_wallet_activity_events_wallet_type_time
  ON wallet_activity_events(wallet_id, activity_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_activity_events_wallet_market_time
  ON wallet_activity_events(wallet_id, market_id, outcome_side, occurred_at DESC)
  WHERE activity_type IN ('delta', 'trade');

CREATE INDEX IF NOT EXISTS idx_wallet_position_snapshots_wallet_venue_time
  ON wallet_position_snapshots(wallet_id, venue, snapshot_at DESC);
