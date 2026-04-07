CREATE TABLE IF NOT EXISTS unified_token_top_latest (
  token_id text PRIMARY KEY,
  venue text NOT NULL,
  ts timestamptz NOT NULL,
  best_bid numeric,
  best_ask numeric,
  mid numeric,
  spread numeric,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unified_token_top_latest_ts
  ON unified_token_top_latest (ts DESC);

