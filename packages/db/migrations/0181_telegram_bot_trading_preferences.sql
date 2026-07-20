CREATE TABLE IF NOT EXISTS telegram_bot_trading_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  desired_enabled boolean NOT NULL,
  decision_source text NOT NULL CHECK (
    decision_source IN (
      'auto_link',
      'legacy_enabled',
      'legacy_preserved',
      'manual_enable',
      'manual_disable',
      'admin_merge'
    )
  ),
  decision_version bigint NOT NULL DEFAULT 1 CHECK (decision_version > 0),
  manual_disabled_at timestamptz,
  applied_policy_revision text,
  retry_attempt_count integer NOT NULL DEFAULT 0 CHECK (retry_attempt_count >= 0),
  retry_after timestamptz,
  last_setup_error_code text,
  setup_blocked boolean NOT NULL DEFAULT false,
  claim_id uuid,
  claim_telegram_account_id uuid,
  claim_decision_version bigint,
  claim_policy_revision text,
  claim_expires_at timestamptz,
  blocked_telegram_account_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_bot_trading_preferences_claim_complete_check CHECK (
    (claim_id IS NULL
      AND claim_telegram_account_id IS NULL
      AND claim_decision_version IS NULL
      AND claim_policy_revision IS NULL
      AND claim_expires_at IS NULL)
    OR
    (claim_id IS NOT NULL
      AND claim_telegram_account_id IS NOT NULL
      AND claim_decision_version IS NOT NULL
      AND claim_policy_revision IS NOT NULL
      AND claim_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_telegram_bot_trading_preferences_claim_expiry
  ON telegram_bot_trading_preferences(claim_expires_at)
  WHERE claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_bot_trading_preferences_retry
  ON telegram_bot_trading_preferences(retry_after)
  WHERE desired_enabled = true AND retry_after IS NOT NULL;

INSERT INTO telegram_bot_trading_preferences (
  user_id,
  desired_enabled,
  decision_source,
  decision_version,
  manual_disabled_at,
  created_at,
  updated_at
)
WITH candidate_users AS (
  SELECT user_id FROM user_telegram_accounts
  UNION
  SELECT user_id FROM telegram_bot_trading_authorizations
), legacy_state AS (
  SELECT
    candidates.user_id,
    bool_or(coalesce(authorizations.enabled, false)) AS desired_enabled
  FROM candidate_users candidates
  LEFT JOIN telegram_bot_trading_authorizations authorizations
    ON authorizations.user_id = candidates.user_id
  GROUP BY candidates.user_id
)
SELECT
  legacy_state.user_id,
  legacy_state.desired_enabled,
  CASE
    WHEN legacy_state.desired_enabled THEN 'legacy_enabled'
    ELSE 'legacy_preserved'
  END,
  1,
  NULL,
  now(),
  now()
FROM legacy_state
ON CONFLICT (user_id) DO NOTHING;
