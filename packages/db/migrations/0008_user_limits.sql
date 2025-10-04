-- Migration: User limits and exposure tracking
-- Implements cooling-off period and daily exposure limits

-- User limits configuration table
CREATE TABLE IF NOT EXISTS user_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  
  -- Cooling-off period limits (first 2 days)
  cooling_off_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cooling_off_limit_usd DECIMAL(20,2) NOT NULL DEFAULT 10000, -- $10k for first 2 days
  cooling_off_period_hours INTEGER NOT NULL DEFAULT 48, -- 2 days
  
  -- Post-cooling-off limits
  daily_limit_usd DECIMAL(20,2) NOT NULL DEFAULT 50000, -- $50k per day
  
  -- Position limits
  max_total_exposure_usd DECIMAL(20,2), -- NULL = unlimited
  max_single_order_usd DECIMAL(20,2) DEFAULT 100000, -- $100k max per order
  
  -- Admin overrides
  limits_disabled BOOLEAN NOT NULL DEFAULT FALSE, -- Admin can disable limits
  override_reason TEXT,
  override_by VARCHAR(255),
  override_at TIMESTAMPTZ,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast user lookups
CREATE INDEX idx_user_limits_user_id ON user_limits(user_id);

-- User exposure tracking (real-time)
CREATE TABLE IF NOT EXISTS user_exposure_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Current exposure
  total_position_value_usd DECIMAL(20,2) NOT NULL DEFAULT 0,
  total_unrealized_pnl_usd DECIMAL(20,2) NOT NULL DEFAULT 0,
  total_realized_pnl_usd DECIMAL(20,2) NOT NULL DEFAULT 0,
  
  -- Daily tracking (resets daily)
  daily_order_volume_usd DECIMAL(20,2) NOT NULL DEFAULT 0,
  daily_trade_count INTEGER NOT NULL DEFAULT 0,
  daily_reset_at TIMESTAMPTZ NOT NULL DEFAULT DATE_TRUNC('day', NOW()),
  
  -- Lifetime stats
  lifetime_order_volume_usd DECIMAL(20,2) NOT NULL DEFAULT 0,
  lifetime_trade_count INTEGER NOT NULL DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE(user_id)
);

-- Index for exposure queries
CREATE INDEX idx_user_exposure_user_id ON user_exposure_tracking(user_id);
CREATE INDEX idx_user_exposure_daily_reset ON user_exposure_tracking(daily_reset_at);

-- Function to check if user is in cooling-off period
CREATE OR REPLACE FUNCTION is_user_in_cooling_off(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  user_created_at TIMESTAMPTZ;
  cooling_off_hours INTEGER;
BEGIN
  -- Get user creation time and cooling-off period
  SELECT u.created_at, COALESCE(ul.cooling_off_period_hours, 48)
  INTO user_created_at, cooling_off_hours
  FROM users u
  LEFT JOIN user_limits ul ON ul.user_id = u.id
  WHERE u.id = p_user_id;
  
  IF user_created_at IS NULL THEN
    RETURN FALSE; -- User doesn't exist
  END IF;
  
  -- Check if user is still in cooling-off period
  RETURN (NOW() - user_created_at) < (cooling_off_hours || ' hours')::INTERVAL;
END;
$$ LANGUAGE plpgsql;

-- Function to get user's current exposure limit
CREATE OR REPLACE FUNCTION get_user_exposure_limit(p_user_id UUID)
RETURNS DECIMAL AS $$
DECLARE
  in_cooling_off BOOLEAN;
  cooling_off_limit DECIMAL;
  daily_limit DECIMAL;
  limits_disabled BOOLEAN;
BEGIN
  -- Check if limits are disabled for this user
  SELECT COALESCE(ul.limits_disabled, FALSE)
  INTO limits_disabled
  FROM user_limits ul
  WHERE ul.user_id = p_user_id;
  
  IF limits_disabled THEN
    RETURN NULL; -- NULL means unlimited
  END IF;
  
  -- Check cooling-off status
  in_cooling_off := is_user_in_cooling_off(p_user_id);
  
  IF in_cooling_off THEN
    -- Return cooling-off limit
    SELECT COALESCE(ul.cooling_off_limit_usd, 10000)
    INTO cooling_off_limit
    FROM user_limits ul
    WHERE ul.user_id = p_user_id;
    
    RETURN COALESCE(cooling_off_limit, 10000);
  ELSE
    -- Return daily limit
    SELECT COALESCE(ul.daily_limit_usd, 50000)
    INTO daily_limit
    FROM user_limits ul
    WHERE ul.user_id = p_user_id;
    
    RETURN COALESCE(daily_limit, 50000);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to check if order would exceed limits
CREATE OR REPLACE FUNCTION check_order_within_limits(
  p_user_id UUID,
  p_order_size_usd DECIMAL
) RETURNS TABLE (
  within_limits BOOLEAN,
  limit_type VARCHAR,
  current_exposure DECIMAL,
  limit_value DECIMAL,
  available DECIMAL,
  error_message TEXT
) AS $$
DECLARE
  v_exposure_limit DECIMAL;
  v_daily_volume DECIMAL;
  v_max_single_order DECIMAL;
  v_in_cooling_off BOOLEAN;
  v_daily_reset_at TIMESTAMPTZ;
BEGIN
  -- Get user's exposure limit
  v_exposure_limit := get_user_exposure_limit(p_user_id);
  v_in_cooling_off := is_user_in_cooling_off(p_user_id);
  
  -- Get current daily volume
  SELECT 
    COALESCE(ue.daily_order_volume_usd, 0),
    ue.daily_reset_at
  INTO v_daily_volume, v_daily_reset_at
  FROM user_exposure_tracking ue
  WHERE ue.user_id = p_user_id;
  
  -- Reset daily volume if needed
  IF v_daily_reset_at IS NOT NULL AND v_daily_reset_at < DATE_TRUNC('day', NOW()) THEN
    v_daily_volume := 0;
  END IF;
  
  v_daily_volume := COALESCE(v_daily_volume, 0);
  
  -- Get max single order limit
  SELECT COALESCE(ul.max_single_order_usd, 100000)
  INTO v_max_single_order
  FROM user_limits ul
  WHERE ul.user_id = p_user_id;
  
  v_max_single_order := COALESCE(v_max_single_order, 100000);
  
  -- Check 1: Single order size limit
  IF p_order_size_usd > v_max_single_order THEN
    RETURN QUERY SELECT
      FALSE,
      'MAX_SINGLE_ORDER'::VARCHAR,
      p_order_size_usd,
      v_max_single_order,
      0::DECIMAL,
      format('Order size $%s exceeds maximum single order limit of $%s', 
        p_order_size_usd::TEXT, v_max_single_order::TEXT)::TEXT;
    RETURN;
  END IF;
  
  -- Check 2: Daily exposure limit (if set)
  IF v_exposure_limit IS NOT NULL THEN
    IF v_daily_volume + p_order_size_usd > v_exposure_limit THEN
      RETURN QUERY SELECT
        FALSE,
        CASE WHEN v_in_cooling_off THEN 'COOLING_OFF_LIMIT' ELSE 'DAILY_LIMIT' END::VARCHAR,
        v_daily_volume,
        v_exposure_limit,
        GREATEST(0, v_exposure_limit - v_daily_volume),
        format('Order would exceed %s limit. Current: $%s, Limit: $%s, Available: $%s',
          CASE WHEN v_in_cooling_off THEN 'cooling-off' ELSE 'daily' END,
          v_daily_volume::TEXT,
          v_exposure_limit::TEXT,
          GREATEST(0, v_exposure_limit - v_daily_volume)::TEXT)::TEXT;
      RETURN;
    END IF;
  END IF;
  
  -- All checks passed
  RETURN QUERY SELECT
    TRUE,
    'APPROVED'::VARCHAR,
    v_daily_volume,
    v_exposure_limit,
    CASE WHEN v_exposure_limit IS NOT NULL 
      THEN v_exposure_limit - v_daily_volume - p_order_size_usd 
      ELSE NULL END,
    NULL::TEXT;
END;
$$ LANGUAGE plpgsql;

-- Function to update user exposure after order
CREATE OR REPLACE FUNCTION update_user_exposure_on_order()
RETURNS TRIGGER AS $$
BEGIN
  -- Initialize or update user exposure tracking
  INSERT INTO user_exposure_tracking (
    user_id,
    daily_order_volume_usd,
    daily_trade_count,
    lifetime_order_volume_usd,
    lifetime_trade_count,
    daily_reset_at
  ) VALUES (
    NEW.user_id,
    NEW.size_usd,
    1,
    NEW.size_usd,
    1,
    DATE_TRUNC('day', NOW())
  )
  ON CONFLICT (user_id) DO UPDATE SET
    daily_order_volume_usd = CASE
      WHEN user_exposure_tracking.daily_reset_at < DATE_TRUNC('day', NOW())
      THEN NEW.size_usd -- Reset if new day
      ELSE user_exposure_tracking.daily_order_volume_usd + NEW.size_usd
    END,
    daily_trade_count = CASE
      WHEN user_exposure_tracking.daily_reset_at < DATE_TRUNC('day', NOW())
      THEN 1
      ELSE user_exposure_tracking.daily_trade_count + 1
    END,
    daily_reset_at = DATE_TRUNC('day', NOW()),
    lifetime_order_volume_usd = user_exposure_tracking.lifetime_order_volume_usd + NEW.size_usd,
    lifetime_trade_count = user_exposure_tracking.lifetime_trade_count + 1,
    updated_at = NOW();
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update exposure when order is created
CREATE TRIGGER trigger_update_user_exposure_on_order
  AFTER INSERT ON orders
  FOR EACH ROW
  WHEN (NEW.status IN ('PENDING', 'SUBMITTED', 'PARTIALLY_FILLED'))
  EXECUTE FUNCTION update_user_exposure_on_order();

-- Function to get user exposure summary
CREATE OR REPLACE FUNCTION get_user_exposure_summary(p_user_id UUID)
RETURNS TABLE (
  user_id UUID,
  in_cooling_off BOOLEAN,
  current_limit_usd DECIMAL,
  daily_volume_usd DECIMAL,
  available_limit_usd DECIMAL,
  total_position_value_usd DECIMAL,
  lifetime_volume_usd DECIMAL,
  lifetime_trades INTEGER,
  user_created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    u.id,
    is_user_in_cooling_off(u.id),
    get_user_exposure_limit(u.id),
    COALESCE(ue.daily_order_volume_usd, 0),
    CASE
      WHEN get_user_exposure_limit(u.id) IS NOT NULL
      THEN GREATEST(0, get_user_exposure_limit(u.id) - COALESCE(ue.daily_order_volume_usd, 0))
      ELSE NULL
    END,
    COALESCE(ue.total_position_value_usd, 0),
    COALESCE(ue.lifetime_order_volume_usd, 0),
    COALESCE(ue.lifetime_trade_count, 0),
    u.created_at
  FROM users u
  LEFT JOIN user_exposure_tracking ue ON ue.user_id = u.id
  WHERE u.id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- Create default limits for existing users
INSERT INTO user_limits (user_id, cooling_off_enabled, cooling_off_limit_usd, daily_limit_usd)
SELECT 
  id,
  TRUE,
  10000,
  50000
FROM users
ON CONFLICT (user_id) DO NOTHING;

COMMENT ON TABLE user_limits IS 'User-specific trading limits and configurations';
COMMENT ON TABLE user_exposure_tracking IS 'Real-time tracking of user exposure and trading activity';
COMMENT ON FUNCTION is_user_in_cooling_off IS 'Check if user is in cooling-off period (first 2 days)';
COMMENT ON FUNCTION get_user_exposure_limit IS 'Get current exposure limit for user (cooling-off or daily)';
COMMENT ON FUNCTION check_order_within_limits IS 'Validate if order is within user limits';
COMMENT ON FUNCTION get_user_exposure_summary IS 'Get comprehensive exposure summary for user';

