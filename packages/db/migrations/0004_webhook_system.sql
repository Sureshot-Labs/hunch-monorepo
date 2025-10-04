-- Webhook system tables
-- Migration: 0004_webhook_system.sql

-- Webhooks table
CREATE TABLE webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  events JSONB NOT NULL, -- Array of event types
  auth_method TEXT NOT NULL CHECK (auth_method IN ('none', 'bearer', 'hmac', 'api_key')),
  auth_config JSONB, -- Authentication configuration
  retry_policy JSONB NOT NULL, -- Retry policy configuration
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled', 'failed')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  last_triggered_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  failure_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0
);

-- Webhook events table
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  data JSONB NOT NULL, -- Event data payload
  retry_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'retrying')),
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Webhook delivery attempts table
CREATE TABLE webhook_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_event_id UUID REFERENCES webhook_events(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  response_status INTEGER,
  response_body TEXT,
  error_message TEXT,
  duration INTEGER, -- Duration in milliseconds
  retry_after INTEGER -- Retry after in milliseconds
);

-- Indexes for webhooks table
CREATE INDEX idx_webhooks_user_id ON webhooks(user_id);
CREATE INDEX idx_webhooks_status ON webhooks(status);
CREATE INDEX idx_webhooks_is_active ON webhooks(is_active);
CREATE INDEX idx_webhooks_created_at ON webhooks(created_at);
CREATE INDEX idx_webhooks_events ON webhooks USING GIN(events);

-- Indexes for webhook_events table
CREATE INDEX idx_webhook_events_webhook_id ON webhook_events(webhook_id);
CREATE INDEX idx_webhook_events_event_type ON webhook_events(event_type);
CREATE INDEX idx_webhook_events_timestamp ON webhook_events(timestamp);
CREATE INDEX idx_webhook_events_status ON webhook_events(status);
CREATE INDEX idx_webhook_events_webhook_timestamp ON webhook_events(webhook_id, timestamp);

-- Indexes for webhook_delivery_attempts table
CREATE INDEX idx_webhook_delivery_attempts_event_id ON webhook_delivery_attempts(webhook_event_id);
CREATE INDEX idx_webhook_delivery_attempts_timestamp ON webhook_delivery_attempts(timestamp);
CREATE INDEX idx_webhook_delivery_attempts_status ON webhook_delivery_attempts(status);
CREATE INDEX idx_webhook_delivery_attempts_event_attempt ON webhook_delivery_attempts(webhook_event_id, attempt_number);

-- Triggers for webhooks table
CREATE OR REPLACE FUNCTION update_webhooks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_webhooks_updated_at
    BEFORE UPDATE ON webhooks
    FOR EACH ROW EXECUTE FUNCTION update_webhooks_updated_at();

-- Function to update webhook statistics
CREATE OR REPLACE FUNCTION update_webhook_stats()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Update webhook last_triggered_at
        UPDATE webhooks 
        SET last_triggered_at = NEW.timestamp
        WHERE id = NEW.webhook_id;
        
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        -- Update webhook success/failure counts
        IF NEW.status = 'delivered' AND OLD.status != 'delivered' THEN
            UPDATE webhooks 
            SET success_count = success_count + 1,
                last_success_at = NEW.delivered_at
            WHERE id = NEW.webhook_id;
        ELSIF NEW.status = 'failed' AND OLD.status != 'failed' THEN
            UPDATE webhooks 
            SET failure_count = failure_count + 1,
                last_failure_at = NEW.failed_at
            WHERE id = NEW.webhook_id;
        END IF;
        
        RETURN NEW;
    END IF;
    
    RETURN NULL;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_webhook_stats_trigger
    AFTER INSERT OR UPDATE ON webhook_events
    FOR EACH ROW EXECUTE FUNCTION update_webhook_stats();

-- Function to clean up old webhook events
CREATE OR REPLACE FUNCTION cleanup_old_webhook_events()
RETURNS void AS $$
BEGIN
    -- Delete webhook events older than 30 days
    DELETE FROM webhook_events 
    WHERE timestamp < NOW() - INTERVAL '30 days';
    
    -- Delete webhook delivery attempts for deleted events
    DELETE FROM webhook_delivery_attempts 
    WHERE webhook_event_id NOT IN (
        SELECT id FROM webhook_events
    );
END;
$$ language 'plpgsql';

-- Create a scheduled job to clean up old events (requires pg_cron extension)
-- SELECT cron.schedule('cleanup-webhook-events', '0 2 * * *', 'SELECT cleanup_old_webhook_events();');

-- Views for webhook statistics
CREATE VIEW webhook_stats_view AS
SELECT 
    w.id as webhook_id,
    w.name,
    w.user_id,
    w.status,
    w.is_active,
    COUNT(we.id) as total_events,
    COUNT(CASE WHEN we.status = 'delivered' THEN 1 END) as delivered_events,
    COUNT(CASE WHEN we.status = 'failed' THEN 1 END) as failed_events,
    COUNT(CASE WHEN we.status = 'pending' THEN 1 END) as pending_events,
    AVG(CASE WHEN we.delivered_at IS NOT NULL THEN 
        EXTRACT(EPOCH FROM (we.delivered_at - we.timestamp)) * 1000 
    END) as avg_delivery_time_ms,
    w.last_triggered_at,
    w.last_success_at,
    w.last_failure_at,
    w.failure_count,
    w.success_count
FROM webhooks w
LEFT JOIN webhook_events we ON w.id = we.webhook_id
GROUP BY w.id, w.name, w.user_id, w.status, w.is_active, 
         w.last_triggered_at, w.last_success_at, w.last_failure_at,
         w.failure_count, w.success_count;

-- View for recent webhook events
CREATE VIEW recent_webhook_events_view AS
SELECT 
    we.id,
    we.webhook_id,
    w.name as webhook_name,
    w.user_id,
    we.event_type,
    we.timestamp,
    we.status,
    we.retry_count,
    we.delivered_at,
    we.failed_at,
    we.error_message,
    wda.response_status,
    wda.duration
FROM webhook_events we
JOIN webhooks w ON we.webhook_id = w.id
LEFT JOIN LATERAL (
    SELECT response_status, duration
    FROM webhook_delivery_attempts wda2
    WHERE wda2.webhook_event_id = we.id
    ORDER BY wda2.attempt_number DESC
    LIMIT 1
) wda ON true
WHERE we.timestamp >= NOW() - INTERVAL '24 hours'
ORDER BY we.timestamp DESC;

-- Sample webhook configurations
INSERT INTO webhooks (
    user_id,
    name,
    description,
    url,
    events,
    auth_method,
    auth_config,
    retry_policy,
    status,
    is_active
) VALUES (
    (SELECT id FROM users LIMIT 1), -- Use first user as example
    'Order Updates Webhook',
    'Webhook for order status updates',
    'https://example.com/webhooks/orders',
    '["order.created", "order.updated", "order.filled", "order.cancelled"]',
    'hmac',
    '{"hmacSecret": "your-secret-key", "hmacAlgorithm": "sha256"}',
    '{"maxRetries": 3, "retryDelay": 5000, "backoffMultiplier": 2, "maxRetryDelay": 60000}',
    'active',
    true
), (
    (SELECT id FROM users LIMIT 1),
    'Price Alerts Webhook',
    'Webhook for price change alerts',
    'https://example.com/webhooks/prices',
    '["price.updated"]',
    'bearer',
    '{"bearerToken": "your-bearer-token"}',
    '{"maxRetries": 2, "retryDelay": 2000, "backoffMultiplier": 1.5, "maxRetryDelay": 30000}',
    'active',
    true
), (
    (SELECT id FROM users LIMIT 1),
    'Analytics Signals Webhook',
    'Webhook for trading signals and recommendations',
    'https://example.com/webhooks/analytics',
    '["analytics.signal_generated", "analytics.recommendation_updated"]',
    'api_key',
    '{"apiKey": "your-api-key"}',
    '{"maxRetries": 1, "retryDelay": 1000, "backoffMultiplier": 1, "maxRetryDelay": 5000}',
    'active',
    true
);

-- Comments for documentation
COMMENT ON TABLE webhooks IS 'Webhook configurations for real-time event notifications';
COMMENT ON TABLE webhook_events IS 'Individual webhook events queued for delivery';
COMMENT ON TABLE webhook_delivery_attempts IS 'Delivery attempts for webhook events';

COMMENT ON COLUMN webhooks.events IS 'Array of event types this webhook subscribes to';
COMMENT ON COLUMN webhooks.auth_config IS 'Authentication configuration (bearer token, API key, HMAC secret)';
COMMENT ON COLUMN webhooks.retry_policy IS 'Retry policy configuration (max retries, delays, backoff)';

COMMENT ON COLUMN webhook_events.data IS 'Event data payload in JSON format';
COMMENT ON COLUMN webhook_events.retry_count IS 'Number of delivery attempts made';

COMMENT ON COLUMN webhook_delivery_attempts.duration IS 'Request duration in milliseconds';
COMMENT ON COLUMN webhook_delivery_attempts.retry_after IS 'Suggested retry delay in milliseconds';
