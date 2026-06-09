-- Hyperliquid HIP-4 read-only indexer tables.
-- These tables store raw public outcome metadata and normalized side assets.
-- Trading/account/order tables are intentionally not changed here.

INSERT INTO venues(name, api_base, ws_url)
VALUES ('hyperliquid', 'https://api.hyperliquid.xyz', 'wss://api.hyperliquid.xyz/ws')
ON CONFLICT (name) DO UPDATE SET
  api_base = EXCLUDED.api_base,
  ws_url = EXCLUDED.ws_url;

CREATE TABLE IF NOT EXISTS hyperliquid_questions (
  question_id text PRIMARY KEY,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'ACTIVE',
  fallback_outcome_id text,
  named_outcome_ids text[] NOT NULL DEFAULT '{}',
  settled_named_outcome_ids text[] NOT NULL DEFAULT '{}',
  outcome_ids text[] NOT NULL DEFAULT '{}',
  parsed_description jsonb NOT NULL DEFAULT '{}'::jsonb,
  category text,
  expiration_time timestamptz,
  raw jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hyperliquid_questions_status_check
    CHECK (status IN ('ACTIVE', 'CLOSED', 'SETTLED', 'ARCHIVED'))
);

CREATE TABLE IF NOT EXISTS hyperliquid_outcomes (
  outcome_id text PRIMARY KEY,
  question_id text REFERENCES hyperliquid_questions(question_id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'ACTIVE',
  side_specs jsonb NOT NULL DEFAULT '[]'::jsonb,
  parsed_description jsonb NOT NULL DEFAULT '{}'::jsonb,
  category text,
  expiration_time timestamptz,
  raw jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hyperliquid_outcomes_status_check
    CHECK (status IN ('ACTIVE', 'CLOSED', 'SETTLED', 'ARCHIVED'))
);

CREATE TABLE IF NOT EXISTS hyperliquid_outcome_assets (
  outcome_id text NOT NULL REFERENCES hyperliquid_outcomes(outcome_id) ON DELETE CASCADE,
  side_index integer NOT NULL CHECK (side_index >= 0),
  side_name text NOT NULL,
  outcome_side text NOT NULL CHECK (outcome_side IN ('YES', 'NO')),
  encoding bigint NOT NULL,
  coin text NOT NULL,
  token_name text NOT NULL,
  official_asset_id bigint NOT NULL,
  hunch_token_id text NOT NULL,
  mark_px numeric,
  mid_px numeric,
  prev_day_px numeric,
  day_ntl_vlm numeric,
  day_base_vlm numeric,
  circulating_supply numeric,
  total_supply numeric,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outcome_id, side_index),
  CONSTRAINT hyperliquid_outcome_assets_coin_unique UNIQUE (coin),
  CONSTRAINT hyperliquid_outcome_assets_hunch_token_unique UNIQUE (hunch_token_id),
  CONSTRAINT hyperliquid_outcome_assets_official_asset_unique UNIQUE (official_asset_id)
);

CREATE INDEX IF NOT EXISTS idx_hyperliquid_questions_status
  ON hyperliquid_questions(status);

CREATE INDEX IF NOT EXISTS idx_hyperliquid_questions_expiration
  ON hyperliquid_questions(expiration_time DESC)
  WHERE expiration_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hyperliquid_questions_outcome_ids_gin
  ON hyperliquid_questions USING gin(outcome_ids);

CREATE INDEX IF NOT EXISTS idx_hyperliquid_outcomes_question
  ON hyperliquid_outcomes(question_id);

CREATE INDEX IF NOT EXISTS idx_hyperliquid_outcomes_status
  ON hyperliquid_outcomes(status);

CREATE INDEX IF NOT EXISTS idx_hyperliquid_outcomes_expiration
  ON hyperliquid_outcomes(expiration_time DESC)
  WHERE expiration_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hyperliquid_outcomes_category
  ON hyperliquid_outcomes(category)
  WHERE category IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hyperliquid_outcome_assets_outcome_side
  ON hyperliquid_outcome_assets(outcome_id, outcome_side);

CREATE INDEX IF NOT EXISTS idx_hyperliquid_outcome_assets_day_ntl_vlm
  ON hyperliquid_outcome_assets(day_ntl_vlm DESC)
  WHERE day_ntl_vlm IS NOT NULL;

CREATE OR REPLACE FUNCTION update_hyperliquid_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_hyperliquid_questions_updated_at ON hyperliquid_questions;
CREATE TRIGGER update_hyperliquid_questions_updated_at
  BEFORE UPDATE ON hyperliquid_questions
  FOR EACH ROW EXECUTE FUNCTION update_hyperliquid_updated_at_column();

DROP TRIGGER IF EXISTS update_hyperliquid_outcomes_updated_at ON hyperliquid_outcomes;
CREATE TRIGGER update_hyperliquid_outcomes_updated_at
  BEFORE UPDATE ON hyperliquid_outcomes
  FOR EACH ROW EXECUTE FUNCTION update_hyperliquid_updated_at_column();

DROP TRIGGER IF EXISTS update_hyperliquid_outcome_assets_updated_at ON hyperliquid_outcome_assets;
CREATE TRIGGER update_hyperliquid_outcome_assets_updated_at
  BEFORE UPDATE ON hyperliquid_outcome_assets
  FOR EACH ROW EXECUTE FUNCTION update_hyperliquid_updated_at_column();
