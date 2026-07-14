CREATE TABLE IF NOT EXISTS holder_research_candidate_observations (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  thesis_key text NOT NULL,
  source_market_id text NOT NULL,
  side text NOT NULL CHECK (side IN ('YES', 'NO')),
  candidate_bucket text NOT NULL,
  input_digest text NOT NULL,
  feature_version smallint NOT NULL CHECK (feature_version = 2),
  decision_features jsonb NOT NULL,
  candidate_rank integer NOT NULL CHECK (candidate_rank > 0),
  shadow_score double precision NOT NULL CHECK (
    shadow_score >= 0 AND shadow_score <= 1
  ),
  shadow_rank integer NOT NULL CHECK (shadow_rank > 0),
  triage_action text CHECK (triage_action IN ('investigate', 'watch', 'skip')),
  research_verdict text CHECK (
    research_verdict IN (
      'supports_holder_side',
      'supports_opposite_side',
      'already_public',
      'unexplained',
      'mixed',
      'unknown'
    )
  ),
  final_verdict text CHECK (final_verdict IN ('publish', 'context', 'skip')),
  published_note_id uuid REFERENCES ai_notes(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, thesis_key)
);

CREATE INDEX IF NOT EXISTS idx_holder_research_candidate_observations_observed
  ON holder_research_candidate_observations (observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_holder_research_candidate_observations_thesis
  ON holder_research_candidate_observations (thesis_key, observed_at ASC);

CREATE INDEX IF NOT EXISTS idx_holder_research_candidate_observations_market_side
  ON holder_research_candidate_observations (source_market_id, side, observed_at ASC);
