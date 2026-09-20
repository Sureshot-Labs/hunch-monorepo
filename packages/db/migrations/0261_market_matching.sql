-- Additive, empty tables only. No legacy-data assertions or backfills.
CREATE TABLE event_match_versions (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES unified_events(id) ON DELETE RESTRICT,
  fingerprint text NOT NULL,
  "snapshot" jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id, fingerprint)
);
CREATE TABLE market_contract_versions (
  id text PRIMARY KEY,
  market_id text NOT NULL REFERENCES unified_markets(id) ON DELETE RESTRICT,
  event_id text NOT NULL REFERENCES unified_events(id) ON DELETE RESTRICT,
  fingerprint text NOT NULL,
  "snapshot" jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(market_id, fingerprint)
);
CREATE INDEX market_contract_versions_event ON market_contract_versions(event_id);
CREATE TABLE matching_evaluations (
  id text PRIMARY KEY,
  entity_kind text NOT NULL CHECK(entity_kind IN ('event','contract')),
  left_version text NOT NULL,
  right_version text NOT NULL,
  policy_version text NOT NULL,
  model text NOT NULL,
  request_payload jsonb NOT NULL,
  response_payload jsonb NOT NULL,
  decision text NOT NULL,
  disposition text NOT NULL,
  diagnostics jsonb NOT NULL,
  cost_usd numeric NOT NULL DEFAULT 0,
  elapsed_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE event_links (
  id text PRIMARY KEY,
  left_id text NOT NULL REFERENCES unified_events(id) ON DELETE RESTRICT,
  right_id text NOT NULL REFERENCES unified_events(id) ON DELETE RESTRICT,
  left_version text NOT NULL REFERENCES event_match_versions(id),
  right_version text NOT NULL REFERENCES event_match_versions(id),
  evaluation_id text NOT NULL REFERENCES matching_evaluations(id),
  decision text NOT NULL,
  disposition text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(left_id < right_id), UNIQUE(left_id,right_id)
);
CREATE INDEX event_links_right ON event_links(right_id);
CREATE TABLE market_links (
  id text PRIMARY KEY,
  left_id text NOT NULL REFERENCES unified_markets(id) ON DELETE RESTRICT,
  right_id text NOT NULL REFERENCES unified_markets(id) ON DELETE RESTRICT,
  left_version text NOT NULL REFERENCES market_contract_versions(id),
  right_version text NOT NULL REFERENCES market_contract_versions(id),
  evaluation_id text NOT NULL REFERENCES matching_evaluations(id),
  decision text NOT NULL,
  disposition text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(left_id < right_id), UNIQUE(left_id,right_id)
);
CREATE INDEX market_links_right ON market_links(right_id);
CREATE TABLE market_outcome_links (
  market_link_id text NOT NULL REFERENCES market_links(id) ON DELETE CASCADE,
  left_outcome_id text NOT NULL,
  right_outcome_id text NOT NULL,
  PRIMARY KEY(market_link_id,left_outcome_id,right_outcome_id)
);
CREATE TABLE market_matching_jobs (
  id text PRIMARY KEY,
  entity_kind text NOT NULL CHECK(entity_kind IN ('event','contract')),
  left_id text NOT NULL,
  right_id text NOT NULL,
  left_version text NOT NULL,
  right_version text NOT NULL,
  candidate_source text NOT NULL,
  policy_version text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','error','stale')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token text,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_matching_jobs_due ON market_matching_jobs(next_attempt_at,created_at) WHERE status IN ('queued','running');
CREATE TABLE market_matching_state (
  state_key text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE market_matching_budget (
  budget_day date PRIMARY KEY,
  reserved_usd numeric NOT NULL DEFAULT 0,
  spent_usd numeric NOT NULL DEFAULT 0,
  request_count integer NOT NULL DEFAULT 0,
  lazy_reserved_usd numeric NOT NULL DEFAULT 0,
  lazy_spent_usd numeric NOT NULL DEFAULT 0,
  lazy_request_count integer NOT NULL DEFAULT 0
);
-- Bounded discovery demand. Reads never enqueue; authenticated POST is separate.
CREATE TABLE market_matching_interest (
  market_id text PRIMARY KEY REFERENCES unified_markets(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK(source IN ('warm','lazy')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done')),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX market_matching_interest_due ON market_matching_interest(next_attempt_at) WHERE status IN ('queued','running');
CREATE TABLE market_matching_demand_limits (
  actor_hash text NOT NULL,
  market_id text NOT NULL REFERENCES unified_markets(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_hash,market_id)
);
CREATE INDEX market_matching_demand_limits_time ON market_matching_demand_limits(requested_at);
