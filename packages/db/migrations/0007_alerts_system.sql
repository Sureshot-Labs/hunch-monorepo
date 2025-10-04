-- Migration: Alerts system for large orders and anomalies

-- Alerts table to store all alerts
CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type VARCHAR(100) NOT NULL, -- 'LARGE_ORDER', 'RAPID_ORDERS', 'HIGH_EXPOSURE', etc.
  severity VARCHAR(20) NOT NULL, -- 'INFO', 'WARNING', 'CRITICAL'
  title VARCHAR(500) NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB,
  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_by VARCHAR(255),
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX idx_alerts_type ON alerts(alert_type);
CREATE INDEX idx_alerts_severity ON alerts(severity);
CREATE INDEX idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX idx_alerts_acknowledged ON alerts(acknowledged) WHERE acknowledged = FALSE;

-- Alert delivery log (track email/slack deliveries)
CREATE TABLE IF NOT EXISTS alert_delivery_log (
  id SERIAL PRIMARY KEY,
  alert_id UUID REFERENCES alerts(id) ON DELETE SET NULL,
  alert_type VARCHAR(100) NOT NULL,
  delivery_method VARCHAR(50) NOT NULL, -- 'email', 'slack', 'webhook'
  recipient TEXT NOT NULL,
  status VARCHAR(50) NOT NULL, -- 'pending', 'success', 'failed'
  error_message TEXT,
  attempted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for delivery tracking
CREATE INDEX idx_alert_delivery_alert_id ON alert_delivery_log(alert_id);
CREATE INDEX idx_alert_delivery_status ON alert_delivery_log(status);
CREATE INDEX idx_alert_delivery_created ON alert_delivery_log(created_at DESC);

-- Alert statistics view
CREATE OR REPLACE VIEW alert_stats AS
SELECT
  alert_type,
  severity,
  COUNT(*) as total_count,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') as last_hour,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as last_24h,
  COUNT(*) FILTER (WHERE acknowledged = FALSE) as unacknowledged,
  MAX(created_at) as last_alert_time
FROM alerts
GROUP BY alert_type, severity;

-- Function to get alert summary
CREATE OR REPLACE FUNCTION get_alert_summary(p_hours INTEGER DEFAULT 24)
RETURNS TABLE (
  alert_type VARCHAR,
  severity VARCHAR,
  count BIGINT,
  latest_time TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.alert_type,
    a.severity,
    COUNT(*) as count,
    MAX(a.created_at) as latest_time
  FROM alerts a
  WHERE a.created_at > NOW() - (p_hours || ' hours')::INTERVAL
  GROUP BY a.alert_type, a.severity
  ORDER BY count DESC;
END;
$$ LANGUAGE plpgsql;

-- Function to acknowledge alert
CREATE OR REPLACE FUNCTION acknowledge_alert(
  p_alert_id UUID,
  p_acknowledged_by VARCHAR
) RETURNS VOID AS $$
BEGIN
  UPDATE alerts
  SET
    acknowledged = TRUE,
    acknowledged_by = p_acknowledged_by,
    acknowledged_at = NOW()
  WHERE id = p_alert_id;
END;
$$ LANGUAGE plpgsql;

-- Alert retention policy (delete old alerts after 90 days)
-- This should be run as a scheduled job
CREATE OR REPLACE FUNCTION cleanup_old_alerts()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM alerts
  WHERE created_at < NOW() - INTERVAL '90 days'
  AND acknowledged = TRUE;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE alerts IS 'System alerts for large orders, anomalies, and other critical events';
COMMENT ON TABLE alert_delivery_log IS 'Log of alert delivery attempts via email, Slack, etc.';
COMMENT ON VIEW alert_stats IS 'Aggregated statistics of alerts by type and severity';
COMMENT ON FUNCTION get_alert_summary IS 'Get summary of alerts within specified time window';
COMMENT ON FUNCTION acknowledge_alert IS 'Mark an alert as acknowledged';
COMMENT ON FUNCTION cleanup_old_alerts IS 'Delete old acknowledged alerts (90+ days)';

