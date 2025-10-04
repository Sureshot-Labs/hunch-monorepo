-- Migration: Dead Letter Queue for failed ingestion
-- Stores failed ingestion attempts for retry and debugging

-- Failed ingestion table (Dead Letter Queue)
CREATE TABLE IF NOT EXISTS failed_ingestion (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Source information
  source VARCHAR(50) NOT NULL, -- 'polymarket', 'kalshi', 'limitless'
  resource_type VARCHAR(50) NOT NULL, -- 'event', 'market', 'token', 'book', 'trade'
  endpoint VARCHAR(500) NOT NULL, -- API endpoint that was called
  
  -- Request details
  request_method VARCHAR(10), -- 'GET', 'POST', etc.
  request_params JSONB,
  request_body JSONB,
  
  -- Response details
  response_status INTEGER,
  response_body TEXT,
  
  -- Error details
  error_type VARCHAR(100), -- 'NETWORK_ERROR', 'PARSE_ERROR', 'VALIDATION_ERROR', 'RATE_LIMIT', etc.
  error_message TEXT NOT NULL,
  error_stack TEXT,
  
  -- Payload that failed to process
  raw_payload JSONB NOT NULL,
  
  -- Retry tracking
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  next_retry_at TIMESTAMPTZ,
  last_retry_at TIMESTAMPTZ,
  
  -- Status
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending', 'retrying', 'failed', 'resolved', 'ignored'
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(255),
  resolution_notes TEXT,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for DLQ queries
CREATE INDEX idx_failed_ingestion_source ON failed_ingestion(source);
CREATE INDEX idx_failed_ingestion_resource_type ON failed_ingestion(resource_type);
CREATE INDEX idx_failed_ingestion_status ON failed_ingestion(status);
CREATE INDEX idx_failed_ingestion_next_retry ON failed_ingestion(next_retry_at) WHERE status = 'pending';
CREATE INDEX idx_failed_ingestion_created ON failed_ingestion(created_at DESC);
CREATE INDEX idx_failed_ingestion_error_type ON failed_ingestion(error_type);

-- DLQ statistics view
CREATE OR REPLACE VIEW dlq_stats AS
SELECT
  source,
  resource_type,
  error_type,
  status,
  COUNT(*) as total_count,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') as last_hour,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as last_24h,
  COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
  COUNT(*) FILTER (WHERE status = 'failed') as failed_count,
  MAX(created_at) as last_failure_time,
  AVG(retry_count) as avg_retry_count
FROM failed_ingestion
GROUP BY source, resource_type, error_type, status;

-- Function to add item to DLQ
CREATE OR REPLACE FUNCTION add_to_dlq(
  p_source VARCHAR,
  p_resource_type VARCHAR,
  p_endpoint VARCHAR,
  p_error_type VARCHAR,
  p_error_message TEXT,
  p_raw_payload JSONB,
  p_response_status INTEGER DEFAULT NULL,
  p_response_body TEXT DEFAULT NULL,
  p_request_params JSONB DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_id UUID;
  v_next_retry TIMESTAMPTZ;
BEGIN
  -- Calculate next retry time (exponential backoff: 5min, 30min, 2h)
  v_next_retry := NOW() + INTERVAL '5 minutes';
  
  INSERT INTO failed_ingestion (
    source,
    resource_type,
    endpoint,
    request_params,
    response_status,
    response_body,
    error_type,
    error_message,
    raw_payload,
    next_retry_at
  ) VALUES (
    p_source,
    p_resource_type,
    p_endpoint,
    p_request_params,
    p_response_status,
    p_response_body,
    p_error_type,
    p_error_message,
    p_raw_payload,
    v_next_retry
  ) RETURNING id INTO v_id;
  
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- Function to get items ready for retry
CREATE OR REPLACE FUNCTION get_dlq_items_for_retry(p_limit INTEGER DEFAULT 100)
RETURNS TABLE (
  id UUID,
  source VARCHAR,
  resource_type VARCHAR,
  endpoint VARCHAR,
  raw_payload JSONB,
  retry_count INTEGER,
  error_message TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    fi.id,
    fi.source,
    fi.resource_type,
    fi.endpoint,
    fi.raw_payload,
    fi.retry_count,
    fi.error_message
  FROM failed_ingestion fi
  WHERE fi.status = 'pending'
    AND fi.next_retry_at <= NOW()
    AND fi.retry_count < fi.max_retries
  ORDER BY fi.next_retry_at ASC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Function to update retry attempt
CREATE OR REPLACE FUNCTION update_dlq_retry(
  p_id UUID,
  p_success BOOLEAN,
  p_error_message TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
  v_retry_count INTEGER;
  v_max_retries INTEGER;
  v_next_retry TIMESTAMPTZ;
BEGIN
  -- Get current retry count
  SELECT retry_count, max_retries
  INTO v_retry_count, v_max_retries
  FROM failed_ingestion
  WHERE id = p_id;
  
  IF p_success THEN
    -- Mark as resolved
    UPDATE failed_ingestion
    SET
      status = 'resolved',
      resolved_at = NOW(),
      updated_at = NOW()
    WHERE id = p_id;
  ELSE
    -- Increment retry count
    v_retry_count := v_retry_count + 1;
    
    IF v_retry_count >= v_max_retries THEN
      -- Max retries exceeded, mark as failed
      UPDATE failed_ingestion
      SET
        status = 'failed',
        retry_count = v_retry_count,
        last_retry_at = NOW(),
        error_message = COALESCE(p_error_message, error_message),
        updated_at = NOW()
      WHERE id = p_id;
    ELSE
      -- Calculate next retry with exponential backoff
      v_next_retry := NOW() + (INTERVAL '5 minutes' * POWER(6, v_retry_count)); -- 5min, 30min, 3h
      
      UPDATE failed_ingestion
      SET
        status = 'pending',
        retry_count = v_retry_count,
        next_retry_at = v_next_retry,
        last_retry_at = NOW(),
        error_message = COALESCE(p_error_message, error_message),
        updated_at = NOW()
      WHERE id = p_id;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to clean up old resolved items
CREATE OR REPLACE FUNCTION cleanup_old_dlq_items()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM failed_ingestion
  WHERE status = 'resolved'
    AND resolved_at < NOW() - INTERVAL '30 days';
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function to manually mark item as ignored
CREATE OR REPLACE FUNCTION ignore_dlq_item(
  p_id UUID,
  p_ignored_by VARCHAR,
  p_notes TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE failed_ingestion
  SET
    status = 'ignored',
    resolved_at = NOW(),
    resolved_by = p_ignored_by,
    resolution_notes = p_notes,
    updated_at = NOW()
  WHERE id = p_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE failed_ingestion IS 'Dead Letter Queue for failed data ingestion attempts';
COMMENT ON FUNCTION add_to_dlq IS 'Add failed ingestion to DLQ for retry';
COMMENT ON FUNCTION get_dlq_items_for_retry IS 'Get items ready for retry';
COMMENT ON FUNCTION update_dlq_retry IS 'Update DLQ item after retry attempt';
COMMENT ON FUNCTION cleanup_old_dlq_items IS 'Clean up old resolved items (30+ days)';
COMMENT ON FUNCTION ignore_dlq_item IS 'Manually mark DLQ item as ignored (won''t retry)';

