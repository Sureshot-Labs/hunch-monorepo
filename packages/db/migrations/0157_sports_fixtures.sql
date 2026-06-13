/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

CREATE TABLE IF NOT EXISTS sports_fixtures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL,
  competition_key text NOT NULL,
  season text NOT NULL,
  fixture_key text NOT NULL,
  provider text NOT NULL,
  provider_fixture_id text NOT NULL,
  status text,
  kickoff_utc timestamptz,
  local_date date,
  local_time text,
  stage text,
  group_name text,
  home_team_key text,
  home_team_name text,
  away_team_key text,
  away_team_name text,
  home_score integer,
  away_score integer,
  venue text,
  city text,
  country text,
  home_badge_url text,
  away_badge_url text,
  source_updated_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_fixture_id),
  UNIQUE (sport, competition_key, season, fixture_key)
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sports_fixtures_competition_schedule
  ON sports_fixtures (sport, competition_key, season, kickoff_utc, fixture_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sports_fixtures_competition_fixture
  ON sports_fixtures (sport, competition_key, season, fixture_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sports_fixtures_provider_fixture
  ON sports_fixtures (provider, provider_fixture_id);
