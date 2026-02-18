-- Pre-MVP rewards simplification migration (single-path, unapplied).
-- This migration intentionally squashes prior draft migrations 0073..0078
-- into one immutable event_time_frozen model.

-- ---------------------------------------------------------------------
-- 1) volume_events: multiplier + points-awarded
-- ---------------------------------------------------------------------

ALTER TABLE volume_events
ADD COLUMN IF NOT EXISTS multiplier_applied numeric;

ALTER TABLE volume_events
ADD COLUMN IF NOT EXISTS points_awarded numeric;

ALTER TABLE volume_events
ADD COLUMN IF NOT EXISTS multiplier_source text;

CREATE OR REPLACE FUNCTION set_volume_event_points_awarded()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.multiplier_applied IS NULL THEN
    NEW.multiplier_applied := 1.0;
  END IF;

  IF NEW.multiplier_source IS NULL OR btrim(NEW.multiplier_source) = '' THEN
    NEW.multiplier_source := 'global';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.notional_usd IS DISTINCT FROM OLD.notional_usd
       OR NEW.multiplier_applied IS DISTINCT FROM OLD.multiplier_applied THEN
      NEW.points_awarded := NEW.notional_usd * NEW.multiplier_applied;
    ELSIF NEW.points_awarded IS DISTINCT FROM OLD.points_awarded THEN
      NEW.points_awarded := OLD.points_awarded;
    END IF;
  END IF;

  IF NEW.points_awarded IS NULL THEN
    NEW.points_awarded := NEW.notional_usd * NEW.multiplier_applied;
  END IF;

  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'set_volume_events_points_awarded'
  ) THEN
    CREATE TRIGGER set_volume_events_points_awarded
    BEFORE INSERT OR UPDATE ON volume_events
    FOR EACH ROW
    EXECUTE FUNCTION set_volume_event_points_awarded();
  END IF;
END
$$;

UPDATE volume_events
SET multiplier_applied = 1.0
WHERE multiplier_applied IS NULL;

UPDATE volume_events
SET points_awarded = notional_usd * coalesce(multiplier_applied, 1.0)
WHERE points_awarded IS NULL;

UPDATE volume_events
SET multiplier_source = 'global'
WHERE multiplier_source IS NULL;

DO $$
DECLARE
  unresolved_count bigint;
BEGIN
  SELECT count(*) INTO unresolved_count
  FROM volume_events
  WHERE multiplier_applied IS NULL
     OR points_awarded IS NULL
     OR multiplier_source IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'volume_events backfill incomplete: % rows still null', unresolved_count;
  END IF;
END
$$;

ALTER TABLE volume_events
ALTER COLUMN multiplier_applied SET DEFAULT 1.0;

ALTER TABLE volume_events
ALTER COLUMN multiplier_source SET DEFAULT 'global';

ALTER TABLE volume_events
ALTER COLUMN multiplier_applied SET NOT NULL;

ALTER TABLE volume_events
ALTER COLUMN points_awarded SET NOT NULL;

ALTER TABLE volume_events
ALTER COLUMN multiplier_source SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'volume_events_multiplier_applied_check'
  ) THEN
    ALTER TABLE volume_events
      ADD CONSTRAINT volume_events_multiplier_applied_check
      CHECK (multiplier_applied > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'volume_events_points_awarded_check'
  ) THEN
    ALTER TABLE volume_events
      ADD CONSTRAINT volume_events_points_awarded_check
      CHECK (points_awarded >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'volume_events_multiplier_source_check'
  ) THEN
    ALTER TABLE volume_events
      ADD CONSTRAINT volume_events_multiplier_source_check
      CHECK (multiplier_source IN ('global', 'user', 'referral', 'tier'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'volume_events_points_consistency_check'
  ) THEN
    ALTER TABLE volume_events
      ADD CONSTRAINT volume_events_points_consistency_check
      CHECK (points_awarded = notional_usd * multiplier_applied);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_volume_events_user_created_points
  ON volume_events(user_id, created_at DESC, points_awarded);

CREATE INDEX IF NOT EXISTS idx_volume_events_created_user_points
  ON volume_events(created_at DESC, user_id, points_awarded);

-- ---------------------------------------------------------------------
-- 2) multiplier policy tables
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rewards_multiplier_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_at timestamptz NOT NULL,
  global_multiplier numeric NOT NULL DEFAULT 1.0,
  referral_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  tier_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rewards_multiplier_policy_effective_at
  ON rewards_multiplier_policy(effective_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'rewards_multiplier_policy_global_multiplier_check'
  ) THEN
    ALTER TABLE rewards_multiplier_policy
      ADD CONSTRAINT rewards_multiplier_policy_global_multiplier_check
      CHECK (global_multiplier > 0);
  END IF;
END
$$;

INSERT INTO rewards_multiplier_policy (effective_at, global_multiplier, referral_rules, tier_rules)
SELECT now(), 1.0, '[]'::jsonb, '[]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM rewards_multiplier_policy);

CREATE TABLE IF NOT EXISTS rewards_multiplier_user_overrides (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  multiplier numeric NOT NULL,
  reason text,
  effective_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'rewards_multiplier_user_overrides_multiplier_check'
  ) THEN
    ALTER TABLE rewards_multiplier_user_overrides
      ADD CONSTRAINT rewards_multiplier_user_overrides_multiplier_check
      CHECK (multiplier > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'rewards_multiplier_user_overrides_window_check'
  ) THEN
    ALTER TABLE rewards_multiplier_user_overrides
      ADD CONSTRAINT rewards_multiplier_user_overrides_window_check
      CHECK (expires_at IS NULL OR expires_at > effective_at);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_rewards_multiplier_user_overrides_expires_at
  ON rewards_multiplier_user_overrides(expires_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_rewards_multiplier_policy_updated_at'
  ) THEN
    CREATE TRIGGER update_rewards_multiplier_policy_updated_at
    BEFORE UPDATE ON rewards_multiplier_policy
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_rewards_multiplier_user_overrides_updated_at'
  ) THEN
    CREATE TRIGGER update_rewards_multiplier_user_overrides_updated_at
    BEFORE UPDATE ON rewards_multiplier_user_overrides
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 3) treasury run ledger
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reward_treasury_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL CHECK (mode IN ('dry_run', 'execute')),
  chain_id text,
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'partial', 'failed', 'skipped')),
  liability_mode text NOT NULL DEFAULT 'event_time_frozen'
    CHECK (liability_mode IN ('event_time_frozen')),
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_treasury_runs_started
  ON reward_treasury_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_reward_treasury_runs_status
  ON reward_treasury_runs(status, started_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_reward_treasury_runs_updated_at'
  ) THEN
    CREATE TRIGGER update_reward_treasury_runs_updated_at
    BEFORE UPDATE ON reward_treasury_runs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

END
$$;

-- ---------------------------------------------------------------------
-- 4) reward_claims USDC precision safety
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reward_claims_scale_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES reward_claims(id) ON DELETE CASCADE,
  old_amount_usdc numeric NOT NULL,
  new_amount_usdc numeric NOT NULL,
  delta_usdc numeric NOT NULL,
  reason text NOT NULL DEFAULT 'normalize_to_6_decimals',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_claims_scale_adjustments_claim
  ON reward_claims_scale_adjustments(claim_id, created_at DESC);

WITH affected AS (
  SELECT
    id as claim_id,
    amount_usdc as old_amount_usdc,
    trunc(amount_usdc, 6) as new_amount_usdc
  FROM reward_claims
  WHERE amount_usdc IS DISTINCT FROM trunc(amount_usdc, 6)
),
audited AS (
  INSERT INTO reward_claims_scale_adjustments (
    claim_id,
    old_amount_usdc,
    new_amount_usdc,
    delta_usdc
  )
  SELECT
    claim_id,
    old_amount_usdc,
    new_amount_usdc,
    old_amount_usdc - new_amount_usdc
  FROM affected
  RETURNING claim_id
)
UPDATE reward_claims rc
SET amount_usdc = a.new_amount_usdc
FROM affected a
WHERE rc.id = a.claim_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reward_claims_amount_usdc_scale_check'
  ) THEN
    ALTER TABLE reward_claims
      ADD CONSTRAINT reward_claims_amount_usdc_scale_check
      CHECK (amount_usdc = trunc(amount_usdc, 6));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reward_claims_amount_usdc_nonnegative_check'
  ) THEN
    ALTER TABLE reward_claims
      ADD CONSTRAINT reward_claims_amount_usdc_nonnegative_check
      CHECK (amount_usdc >= 0);
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 5) fee_events: frozen liability snapshot (single mode only)
-- ---------------------------------------------------------------------

ALTER TABLE fee_events
ADD COLUMN IF NOT EXISTS cashback_bps_applied integer;

ALTER TABLE fee_events
ADD COLUMN IF NOT EXISTS referral_bps_applied integer;

ALTER TABLE fee_events
ADD COLUMN IF NOT EXISTS cashback_earned_usdc numeric;

ALTER TABLE fee_events
ADD COLUMN IF NOT EXISTS referral_earned_usdc numeric;

ALTER TABLE fee_events
ADD COLUMN IF NOT EXISTS liability_snapshot_source text;

ALTER TABLE fee_events
ALTER COLUMN cashback_bps_applied SET DEFAULT 0;

ALTER TABLE fee_events
ALTER COLUMN referral_bps_applied SET DEFAULT 0;

ALTER TABLE fee_events
ALTER COLUMN liability_snapshot_source SET DEFAULT 'event_time_frozen';

UPDATE fee_events
SET cashback_bps_applied = 0
WHERE cashback_bps_applied IS NULL;

UPDATE fee_events
SET referral_bps_applied = 0
WHERE referral_bps_applied IS NULL;

UPDATE fee_events
SET cashback_earned_usdc = trunc((fee_usd * cashback_bps_applied) / 10000.0, 6)
WHERE cashback_earned_usdc IS NULL;

UPDATE fee_events
SET referral_earned_usdc = trunc((fee_usd * referral_bps_applied) / 10000.0, 6)
WHERE referral_earned_usdc IS NULL;

UPDATE fee_events
SET liability_snapshot_source = 'event_time_frozen'
WHERE liability_snapshot_source IS NULL OR liability_snapshot_source <> 'event_time_frozen';

ALTER TABLE fee_events
ALTER COLUMN cashback_bps_applied SET NOT NULL;

ALTER TABLE fee_events
ALTER COLUMN referral_bps_applied SET NOT NULL;

ALTER TABLE fee_events
ALTER COLUMN cashback_earned_usdc SET NOT NULL;

ALTER TABLE fee_events
ALTER COLUMN referral_earned_usdc SET NOT NULL;

ALTER TABLE fee_events
ALTER COLUMN liability_snapshot_source SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_cashback_bps_applied_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_cashback_bps_applied_check
      CHECK (cashback_bps_applied >= 0 AND cashback_bps_applied <= 10000);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_referral_bps_applied_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_referral_bps_applied_check
      CHECK (referral_bps_applied >= 0 AND referral_bps_applied <= 10000);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_total_bps_cap_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_total_bps_cap_check
      CHECK (cashback_bps_applied + referral_bps_applied <= 10000);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_fee_usd_nonnegative_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_fee_usd_nonnegative_check
      CHECK (fee_usd >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_cashback_earned_usdc_nonnegative_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_cashback_earned_usdc_nonnegative_check
      CHECK (cashback_earned_usdc >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_cashback_earned_usdc_scale_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_cashback_earned_usdc_scale_check
      CHECK (cashback_earned_usdc = trunc(cashback_earned_usdc, 6));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_referral_earned_usdc_nonnegative_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_referral_earned_usdc_nonnegative_check
      CHECK (referral_earned_usdc >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_referral_earned_usdc_scale_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_referral_earned_usdc_scale_check
      CHECK (referral_earned_usdc = trunc(referral_earned_usdc, 6));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_liability_snapshot_source_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_liability_snapshot_source_check
      CHECK (liability_snapshot_source = 'event_time_frozen');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_cashback_formula_consistency_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_cashback_formula_consistency_check
      CHECK (
        cashback_earned_usdc = trunc((fee_usd * cashback_bps_applied) / 10000.0, 6)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_referral_formula_consistency_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_referral_formula_consistency_check
      CHECK (
        referral_earned_usdc = trunc((fee_usd * referral_bps_applied) / 10000.0, 6)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fee_events_total_earned_cap_check'
  ) THEN
    ALTER TABLE fee_events
      ADD CONSTRAINT fee_events_total_earned_cap_check
      CHECK (cashback_earned_usdc + referral_earned_usdc <= fee_usd);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION guard_fee_event_snapshot_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.cashback_bps_applied IS DISTINCT FROM OLD.cashback_bps_applied
     OR NEW.referral_bps_applied IS DISTINCT FROM OLD.referral_bps_applied
     OR NEW.cashback_earned_usdc IS DISTINCT FROM OLD.cashback_earned_usdc
     OR NEW.referral_earned_usdc IS DISTINCT FROM OLD.referral_earned_usdc
     OR NEW.liability_snapshot_source IS DISTINCT FROM OLD.liability_snapshot_source THEN
    RAISE EXCEPTION 'fee_events snapshot fields are immutable after insert';
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'guard_fee_events_snapshot_immutable'
  ) THEN
    CREATE TRIGGER guard_fee_events_snapshot_immutable
    BEFORE UPDATE ON fee_events
    FOR EACH ROW
    EXECUTE FUNCTION guard_fee_event_snapshot_immutable();
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_fee_events_chain_status_snapshot_created
  ON fee_events(chain_id, status, liability_snapshot_source, created_at DESC);
