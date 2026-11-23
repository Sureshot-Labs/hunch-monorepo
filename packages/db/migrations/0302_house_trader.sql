CREATE TABLE house_trader_account (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  controller text UNIQUE,
  deposit_wallet text UNIQUE,
  active boolean NOT NULL DEFAULT false,
  settings jsonb,
  revision integer NOT NULL DEFAULT 0,
  cursor_at timestamptz NOT NULL DEFAULT now(),
  cursor_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  position_cursor uuid,
  worker_status jsonb NOT NULL DEFAULT '{}',
  snapshot jsonb,
  CHECK (NOT active OR (settings IS NOT NULL AND deposit_wallet IS NOT NULL))
);

CREATE TABLE house_trader_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_user_id uuid NOT NULL REFERENCES house_trader_account(user_id) ON DELETE RESTRICT,
  action_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('setup','buy','sell','redeem','withdraw')),
  state text NOT NULL CHECK (state IN ('queued','working','submitting','submitted','filled','done','skipped','review')),
  claim_token uuid,
  market_id text REFERENCES unified_markets(id) ON DELETE RESTRICT,
  event_id text,
  token_id text,
  outcome text CHECK (outcome IN ('YES','NO')),
  revision integer NOT NULL,
  budget_raw bigint NOT NULL DEFAULT 0 CHECK (budget_raw >= 0),
  committed_at timestamptz,
  request jsonb NOT NULL DEFAULT '{}',
  result jsonb NOT NULL DEFAULT '{}',
  reference text,
  protected_submission text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_user_id, action_key)
);

CREATE INDEX house_trader_actions_account_recent
  ON house_trader_actions(account_user_id, created_at DESC, id DESC);
CREATE INDEX house_trader_actions_market_ref
  ON house_trader_actions(market_id) WHERE market_id IS NOT NULL;
CREATE INDEX house_trader_action_outstanding
  ON house_trader_actions(account_user_id, created_at, id)
  WHERE state IN ('queued','working','submitting','submitted','review');
CREATE INDEX house_trader_action_position_exit
  ON house_trader_actions(account_user_id, (request->>'positionId'), updated_at DESC)
  WHERE kind IN ('sell','redeem');
