-- Migration: Trading controls (emergency stop, per-venue controls)
-- This allows admins to pause trading globally or per-venue

-- Trading controls table
CREATE TABLE IF NOT EXISTS trading_controls (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  trading_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  reason TEXT,
  disabled_by VARCHAR(255), -- User/admin who disabled it
  disabled_at TIMESTAMPTZ,
  enabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(venue_id)
);

-- Global trading control (venue_id NULL means global)
INSERT INTO trading_controls (venue_id, trading_enabled, reason)
VALUES (NULL, TRUE, 'Initial state - trading enabled');

-- Index for fast lookups
CREATE INDEX idx_trading_controls_venue ON trading_controls(venue_id);
CREATE INDEX idx_trading_controls_enabled ON trading_controls(trading_enabled);

-- Trading control audit log
CREATE TABLE IF NOT EXISTS trading_control_audit (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL, -- 'ENABLE', 'DISABLE'
  reason TEXT,
  changed_by VARCHAR(255) NOT NULL,
  previous_state BOOLEAN,
  new_state BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for audit queries
CREATE INDEX idx_trading_control_audit_venue ON trading_control_audit(venue_id);
CREATE INDEX idx_trading_control_audit_created ON trading_control_audit(created_at DESC);

-- Function to audit trading control changes
CREATE OR REPLACE FUNCTION audit_trading_control_change()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.trading_enabled != NEW.trading_enabled THEN
    INSERT INTO trading_control_audit (
      venue_id,
      action,
      reason,
      changed_by,
      previous_state,
      new_state
    ) VALUES (
      NEW.venue_id,
      CASE WHEN NEW.trading_enabled THEN 'ENABLE' ELSE 'DISABLE' END,
      NEW.reason,
      NEW.disabled_by,
      OLD.trading_enabled,
      NEW.trading_enabled
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically audit changes
CREATE TRIGGER trigger_audit_trading_control
  AFTER UPDATE ON trading_controls
  FOR EACH ROW
  EXECUTE FUNCTION audit_trading_control_change();

-- Function to check if trading is enabled
CREATE OR REPLACE FUNCTION is_trading_enabled(p_venue_id INTEGER DEFAULT NULL)
RETURNS BOOLEAN AS $$
DECLARE
  global_enabled BOOLEAN;
  venue_enabled BOOLEAN;
BEGIN
  -- Check global control (venue_id NULL)
  SELECT trading_enabled INTO global_enabled
  FROM trading_controls
  WHERE venue_id IS NULL;
  
  -- If global is disabled, return false
  IF global_enabled = FALSE THEN
    RETURN FALSE;
  END IF;
  
  -- If venue_id provided, check venue-specific control
  IF p_venue_id IS NOT NULL THEN
    SELECT trading_enabled INTO venue_enabled
    FROM trading_controls
    WHERE venue_id = p_venue_id;
    
    -- Return venue-specific status, or true if no venue-specific control exists
    RETURN COALESCE(venue_enabled, TRUE);
  END IF;
  
  -- Default to global status
  RETURN global_enabled;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE trading_controls IS 'Controls for enabling/disabling trading globally or per-venue';
COMMENT ON TABLE trading_control_audit IS 'Audit log of all trading control changes';
COMMENT ON FUNCTION is_trading_enabled IS 'Check if trading is enabled globally or for a specific venue';

