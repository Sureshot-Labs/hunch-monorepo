-- Referral code registry with stable policy ownership.

CREATE TABLE IF NOT EXISTS referral_code_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_type text NOT NULL CHECK (policy_type IN ('user', 'campaign')),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  label text,
  multiplier_override numeric,
  visible_drop_points numeric NOT NULL DEFAULT 0,
  tier_drop_points numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_code_policies_owner_check CHECK (
    (policy_type = 'user' AND owner_user_id IS NOT NULL)
    OR (policy_type = 'campaign' AND owner_user_id IS NULL)
  ),
  CONSTRAINT referral_code_policies_multiplier_check CHECK (
    multiplier_override IS NULL OR multiplier_override > 0
  ),
  CONSTRAINT referral_code_policies_visible_drop_check CHECK (
    visible_drop_points >= 0
  ),
  CONSTRAINT referral_code_policies_tier_drop_check CHECK (
    tier_drop_points >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_code_policies_user_owner
  ON referral_code_policies(owner_user_id)
  WHERE policy_type = 'user';

CREATE TABLE IF NOT EXISTS referral_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  policy_id uuid NOT NULL REFERENCES referral_code_policies(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  retired_at timestamptz,
  retired_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_codes_code_normalized_check CHECK (code = upper(btrim(code))),
  CONSTRAINT referral_codes_retired_check CHECK (
    (is_active = true AND retired_at IS NULL)
    OR (is_active = false AND retired_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_code
  ON referral_codes(code);

CREATE INDEX IF NOT EXISTS idx_referral_codes_policy_id
  ON referral_codes(policy_id);

CREATE INDEX IF NOT EXISTS idx_referral_codes_active
  ON referral_codes(is_active, code)
  WHERE is_active = true;

DO $$
DECLARE
  duplicate_code text;
BEGIN
  SELECT normalized_code INTO duplicate_code
  FROM (
    SELECT upper(btrim(referral_code)) AS normalized_code
    FROM users
    WHERE referral_code IS NOT NULL
      AND btrim(referral_code) <> ''
    GROUP BY upper(btrim(referral_code))
    HAVING count(*) > 1
    LIMIT 1
  ) dup;

  IF duplicate_code IS NOT NULL THEN
    RAISE EXCEPTION 'Duplicate normalized user referral code before registry backfill: %', duplicate_code;
  END IF;

  WITH code_owners AS (
    SELECT upper(btrim(u.referral_code)) AS normalized_code, u.id AS owner_user_id
    FROM users u
    WHERE u.referral_code IS NOT NULL
      AND btrim(u.referral_code) <> ''

    UNION

    SELECT upper(btrim(r.code)) AS normalized_code, r.referrer_user_id AS owner_user_id
    FROM referrals r
    WHERE r.referrer_user_id IS NOT NULL
      AND r.code IS NOT NULL
      AND btrim(r.code) <> ''
  )
  SELECT normalized_code INTO duplicate_code
  FROM code_owners
  GROUP BY normalized_code
  HAVING count(DISTINCT owner_user_id) > 1
  LIMIT 1;

  IF duplicate_code IS NOT NULL THEN
    RAISE EXCEPTION 'Referral code has historical owners and cannot be safely backfilled: %', duplicate_code;
  END IF;
END
$$;

INSERT INTO referral_code_policies (policy_type, owner_user_id)
SELECT DISTINCT 'user', owner_user_id
FROM (
  SELECT u.id AS owner_user_id
  FROM users u
  WHERE u.referral_code IS NOT NULL
    AND btrim(u.referral_code) <> ''

  UNION

  SELECT r.referrer_user_id AS owner_user_id
  FROM referrals r
  WHERE r.referrer_user_id IS NOT NULL
    AND r.code IS NOT NULL
    AND btrim(r.code) <> ''
) owners
ON CONFLICT DO NOTHING;

INSERT INTO referral_codes (code, policy_id, is_active)
SELECT
  upper(btrim(u.referral_code)) AS code,
  p.id AS policy_id,
  true AS is_active
FROM users u
JOIN referral_code_policies p
  ON p.policy_type = 'user'
 AND p.owner_user_id = u.id
WHERE u.referral_code IS NOT NULL
  AND btrim(u.referral_code) <> ''
ON CONFLICT (code) DO NOTHING;

WITH historical_codes AS (
  SELECT DISTINCT
    upper(btrim(r.code)) AS code,
    r.referrer_user_id AS owner_user_id
  FROM referrals r
  WHERE r.referrer_user_id IS NOT NULL
    AND r.code IS NOT NULL
    AND btrim(r.code) <> ''
)
INSERT INTO referral_codes (
  code,
  policy_id,
  is_active,
  retired_at,
  retired_reason
)
SELECT
  h.code,
  p.id,
  false,
  now(),
  'historical_user_code'
FROM historical_codes h
JOIN referral_code_policies p
  ON p.policy_type = 'user'
 AND p.owner_user_id = h.owner_user_id
WHERE NOT EXISTS (
  SELECT 1
  FROM referral_codes rc
  WHERE rc.code = h.code
)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE referrals
  ADD COLUMN IF NOT EXISTS referral_code_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'referrals_referral_code_id_fkey'
  ) THEN
    ALTER TABLE referrals
      ADD CONSTRAINT referrals_referral_code_id_fkey
      FOREIGN KEY (referral_code_id)
      REFERENCES referral_codes(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

UPDATE referrals r
SET referral_code_id = rc.id
FROM referral_codes rc
JOIN referral_code_policies p
  ON p.id = rc.policy_id
WHERE r.referral_code_id IS NULL
  AND r.code IS NOT NULL
  AND upper(btrim(r.code)) = rc.code
  AND p.policy_type = 'user'
  AND p.owner_user_id = r.referrer_user_id;

DO $$
DECLARE
  unresolved_count bigint;
BEGIN
  SELECT count(*) INTO unresolved_count
  FROM referrals
  WHERE code IS NOT NULL
    AND btrim(code) <> ''
    AND referral_code_id IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'Referral code registry backfill left % referrals without referral_code_id', unresolved_count;
  END IF;
END
$$;

ALTER TABLE referrals
  ALTER COLUMN referrer_user_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'referrals_referrer_or_code_check'
  ) THEN
    ALTER TABLE referrals
      ADD CONSTRAINT referrals_referrer_or_code_check
      CHECK (referrer_user_id IS NOT NULL OR referral_code_id IS NOT NULL);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_referral_code_policy_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  code_policy_type text;
  code_owner_user_id uuid;
BEGIN
  IF NEW.referral_code_id IS NULL THEN
    IF NEW.referrer_user_id IS NULL THEN
      RAISE EXCEPTION 'referrals with a null referrer require referral_code_id';
    END IF;
    RETURN NEW;
  END IF;

  SELECT p.policy_type, p.owner_user_id
  INTO code_policy_type, code_owner_user_id
  FROM referral_codes rc
  JOIN referral_code_policies p
    ON p.id = rc.policy_id
  WHERE rc.id = NEW.referral_code_id;

  IF code_policy_type IS NULL THEN
    RAISE EXCEPTION 'referral_code_id % does not exist', NEW.referral_code_id;
  END IF;

  IF NEW.referrer_user_id IS NULL THEN
    IF code_policy_type <> 'campaign' OR code_owner_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'only ownerless campaign codes may have null referrer_user_id';
    END IF;
    RETURN NEW;
  END IF;

  IF code_policy_type = 'user' AND code_owner_user_id IS DISTINCT FROM NEW.referrer_user_id THEN
    RAISE EXCEPTION 'user referral code policy owner does not match referrer_user_id';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_referral_code_policy_consistency ON referrals;
CREATE TRIGGER enforce_referral_code_policy_consistency
BEFORE INSERT OR UPDATE OF referrer_user_id, referral_code_id ON referrals
FOR EACH ROW
EXECUTE FUNCTION enforce_referral_code_policy_consistency();

ALTER TABLE referral_first_trade_conversions
  ALTER COLUMN referrer_user_id DROP NOT NULL;

ALTER TABLE volume_events
  DROP CONSTRAINT IF EXISTS volume_events_multiplier_source_check;

ALTER TABLE volume_events
  ADD CONSTRAINT volume_events_multiplier_source_check
  CHECK (multiplier_source IN ('global', 'user', 'referral', 'tier', 'referral_code'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_referral_code_policies_updated_at'
  ) THEN
    CREATE TRIGGER update_referral_code_policies_updated_at
    BEFORE UPDATE ON referral_code_policies
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.triggers
    WHERE trigger_name = 'update_referral_codes_updated_at'
  ) THEN
    CREATE TRIGGER update_referral_codes_updated_at
    BEFORE UPDATE ON referral_codes
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;
