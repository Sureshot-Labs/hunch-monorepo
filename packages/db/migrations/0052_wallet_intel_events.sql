-- Wallet intelligence: separate snapshots from activity events.

CREATE TABLE IF NOT EXISTS wallet_position_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  venue text NOT NULL,
  market_id text NOT NULL,
  outcome_side text,
  shares numeric,
  size_usd numeric,
  price numeric,
  metadata jsonb,
  snapshot_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (wallet_id, venue, market_id, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_wallet_position_snapshots_wallet_time
  ON wallet_position_snapshots(wallet_id, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_position_snapshots_wallet_market_time
  ON wallet_position_snapshots(wallet_id, venue, market_id, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_position_snapshots_market_time
  ON wallet_position_snapshots(venue, market_id, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS wallet_activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  venue text NOT NULL,
  market_id text NOT NULL,
  outcome_side text,
  action text,
  delta_shares numeric,
  size_usd numeric,
  price numeric,
  activity_type text NOT NULL CHECK (activity_type IN ('delta', 'trade', 'holder')),
  source text,
  metadata jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (wallet_id, venue, market_id, activity_type, occurred_at)
);

CREATE INDEX IF NOT EXISTS idx_wallet_activity_events_wallet_time
  ON wallet_activity_events(wallet_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_activity_events_market_time
  ON wallet_activity_events(venue, market_id, occurred_at DESC);

-- Backfill existing followed snapshots and deltas (skip holder-only pulls).
INSERT INTO wallet_position_snapshots (
  wallet_id,
  venue,
  market_id,
  outcome_side,
  shares,
  size_usd,
  price,
  metadata,
  snapshot_at
)
SELECT
  wallet_id,
  venue,
  market_id,
  side,
  COALESCE(NULLIF((metadata->>'shares')::numeric, 0), (metadata->>'size')::numeric),
  size_usd,
  price,
  metadata,
  occurred_at
FROM wallet_activity_cache
WHERE (metadata->>'source') IN ('followed_positions', 'followed_wallet')
ON CONFLICT (wallet_id, venue, market_id, snapshot_at)
DO NOTHING;

INSERT INTO wallet_activity_events (
  wallet_id,
  venue,
  market_id,
  outcome_side,
  action,
  delta_shares,
  size_usd,
  price,
  activity_type,
  source,
  metadata,
  occurred_at
)
SELECT
  wallet_id,
  venue,
  market_id,
  (metadata->>'outcomeSide')::text,
  side,
  COALESCE((metadata->>'deltaShares')::numeric, (metadata->>'size')::numeric),
  size_usd,
  price,
  'delta',
  metadata->>'source',
  metadata,
  occurred_at
FROM wallet_activity_cache
WHERE (metadata->>'source') = 'snapshot_delta'
ON CONFLICT (wallet_id, venue, market_id, activity_type, occurred_at)
DO NOTHING;
