-- Monitoring system database schema
-- This migration adds tables for metrics, health checks, alerts, and notifications

-- Metrics table for storing collected metrics
CREATE TABLE IF NOT EXISTS metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    value NUMERIC NOT NULL,
    labels JSONB DEFAULT '{}',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Service metrics table for aggregated service metrics
CREATE TABLE IF NOT EXISTS service_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cpu_usage NUMERIC DEFAULT 0,
    memory_usage NUMERIC DEFAULT 0,
    disk_usage NUMERIC DEFAULT 0,
    network_in NUMERIC DEFAULT 0,
    network_out NUMERIC DEFAULT 0,
    request_count NUMERIC DEFAULT 0,
    request_duration NUMERIC DEFAULT 0,
    error_count NUMERIC DEFAULT 0,
    active_connections NUMERIC DEFAULT 0,
    orders_processed NUMERIC DEFAULT 0,
    trades_executed NUMERIC DEFAULT 0,
    webhooks_delivered NUMERIC DEFAULT 0,
    analysis_completed NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance metrics table for detailed performance data
CREATE TABLE IF NOT EXISTS performance_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service TEXT NOT NULL,
    endpoint TEXT,
    method TEXT,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    response_time NUMERIC NOT NULL DEFAULT 0,
    throughput NUMERIC NOT NULL DEFAULT 0,
    error_rate NUMERIC NOT NULL DEFAULT 0,
    availability NUMERIC NOT NULL DEFAULT 0,
    latency_p50 NUMERIC DEFAULT 0,
    latency_p90 NUMERIC DEFAULT 0,
    latency_p95 NUMERIC DEFAULT 0,
    latency_p99 NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Database metrics table for database-specific metrics
CREATE TABLE IF NOT EXISTS database_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    connection_count NUMERIC DEFAULT 0,
    active_queries NUMERIC DEFAULT 0,
    slow_queries NUMERIC DEFAULT 0,
    deadlocks NUMERIC DEFAULT 0,
    cache_hit_rate NUMERIC DEFAULT 0,
    disk_usage NUMERIC DEFAULT 0,
    index_usage NUMERIC DEFAULT 0,
    replication_lag NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Redis metrics table for Redis-specific metrics
CREATE TABLE IF NOT EXISTS redis_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    connected_clients NUMERIC DEFAULT 0,
    used_memory NUMERIC DEFAULT 0,
    memory_fragmentation_ratio NUMERIC DEFAULT 0,
    keyspace_hits NUMERIC DEFAULT 0,
    keyspace_misses NUMERIC DEFAULT 0,
    commands_processed NUMERIC DEFAULT 0,
    evicted_keys NUMERIC DEFAULT 0,
    expired_keys NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Health checks table for service health status
CREATE TABLE IF NOT EXISTS health_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('healthy', 'unhealthy', 'degraded', 'unknown')),
    message TEXT,
    details JSONB DEFAULT '{}',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    response_time NUMERIC DEFAULT 0,
    dependencies JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Alert definitions table for alert rules
CREATE TABLE IF NOT EXISTS alert_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    conditions JSONB NOT NULL,
    actions JSONB NOT NULL,
    cooldown_period INTEGER NOT NULL DEFAULT 5, -- minutes
    evaluation_interval INTEGER NOT NULL DEFAULT 30, -- seconds
    labels JSONB DEFAULT '{}',
    annotations JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Alert instances table for active and historical alerts
CREATE TABLE IF NOT EXISTS alert_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id UUID NOT NULL REFERENCES alert_definitions(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('firing', 'resolved', 'acknowledged', 'silenced')),
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    labels JSONB DEFAULT '{}',
    annotations JSONB DEFAULT '{}',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by TEXT,
    silenced_until TIMESTAMPTZ,
    silenced_by TEXT,
    evaluation_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    value NUMERIC,
    threshold NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Notification channels table for alert delivery
CREATE TABLE IF NOT EXISTS notification_channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('email', 'webhook', 'slack', 'pagerduty', 'sms')),
    config JSONB NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    labels JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Notification templates table for alert message templates
CREATE TABLE IF NOT EXISTS notification_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    channel_type TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    variables JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Log entries table for application logs
CREATE TABLE IF NOT EXISTS log_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal')),
    service TEXT NOT NULL,
    message TEXT NOT NULL,
    context JSONB DEFAULT '{}',
    user_id UUID REFERENCES users(id),
    request_id TEXT,
    trace_id TEXT,
    span_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Monitoring reports table for periodic reports
CREATE TABLE IF NOT EXISTS monitoring_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL CHECK (type IN ('daily', 'weekly', 'monthly')),
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    summary JSONB NOT NULL,
    services JSONB DEFAULT '[]',
    alerts JSONB DEFAULT '[]',
    metrics JSONB DEFAULT '[]',
    recommendations JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance optimization

-- Metrics indexes
CREATE INDEX IF NOT EXISTS idx_metrics_service ON metrics(service);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_metrics_service_timestamp ON metrics(service, timestamp);

-- Service metrics indexes
CREATE INDEX IF NOT EXISTS idx_service_metrics_service ON service_metrics(service);
CREATE INDEX IF NOT EXISTS idx_service_metrics_timestamp ON service_metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_service_metrics_service_timestamp ON service_metrics(service, timestamp);

-- Performance metrics indexes
CREATE INDEX IF NOT EXISTS idx_performance_metrics_service ON performance_metrics(service);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_endpoint ON performance_metrics(endpoint);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_timestamp ON performance_metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_service_timestamp ON performance_metrics(service, timestamp);

-- Database metrics indexes
CREATE INDEX IF NOT EXISTS idx_database_metrics_service ON database_metrics(service);
CREATE INDEX IF NOT EXISTS idx_database_metrics_timestamp ON database_metrics(timestamp);

-- Redis metrics indexes
CREATE INDEX IF NOT EXISTS idx_redis_metrics_service ON redis_metrics(service);
CREATE INDEX IF NOT EXISTS idx_redis_metrics_timestamp ON redis_metrics(timestamp);

-- Health checks indexes
CREATE INDEX IF NOT EXISTS idx_health_checks_service ON health_checks(service);
CREATE INDEX IF NOT EXISTS idx_health_checks_status ON health_checks(status);
CREATE INDEX IF NOT EXISTS idx_health_checks_timestamp ON health_checks(timestamp);
CREATE INDEX IF NOT EXISTS idx_health_checks_service_timestamp ON health_checks(service, timestamp);

-- Alert definitions indexes
CREATE INDEX IF NOT EXISTS idx_alert_definitions_enabled ON alert_definitions(enabled);
CREATE INDEX IF NOT EXISTS idx_alert_definitions_severity ON alert_definitions(severity);

-- Alert instances indexes
CREATE INDEX IF NOT EXISTS idx_alert_instances_alert_id ON alert_instances(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_instances_status ON alert_instances(status);
CREATE INDEX IF NOT EXISTS idx_alert_instances_severity ON alert_instances(severity);
CREATE INDEX IF NOT EXISTS idx_alert_instances_started_at ON alert_instances(started_at);
CREATE INDEX IF NOT EXISTS idx_alert_instances_resolved_at ON alert_instances(resolved_at);

-- Notification channels indexes
CREATE INDEX IF NOT EXISTS idx_notification_channels_type ON notification_channels(type);
CREATE INDEX IF NOT EXISTS idx_notification_channels_enabled ON notification_channels(enabled);

-- Notification templates indexes
CREATE INDEX IF NOT EXISTS idx_notification_templates_channel_type ON notification_templates(channel_type);
CREATE INDEX IF NOT EXISTS idx_notification_templates_enabled ON notification_templates(enabled);

-- Log entries indexes
CREATE INDEX IF NOT EXISTS idx_log_entries_service ON log_entries(service);
CREATE INDEX IF NOT EXISTS idx_log_entries_level ON log_entries(level);
CREATE INDEX IF NOT EXISTS idx_log_entries_timestamp ON log_entries(timestamp);
CREATE INDEX IF NOT EXISTS idx_log_entries_user_id ON log_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_log_entries_request_id ON log_entries(request_id);
CREATE INDEX IF NOT EXISTS idx_log_entries_trace_id ON log_entries(trace_id);

-- Monitoring reports indexes
CREATE INDEX IF NOT EXISTS idx_monitoring_reports_type ON monitoring_reports(type);
CREATE INDEX IF NOT EXISTS idx_monitoring_reports_period_start ON monitoring_reports(period_start);
CREATE INDEX IF NOT EXISTS idx_monitoring_reports_period_end ON monitoring_reports(period_end);

-- TimescaleDB hypertables for time-series data
-- Note: These require TimescaleDB extension to be installed

-- Convert metrics table to hypertable
SELECT create_hypertable('metrics', 'timestamp', if_not_exists => TRUE);

-- Convert service_metrics table to hypertable
SELECT create_hypertable('service_metrics', 'timestamp', if_not_exists => TRUE);

-- Convert performance_metrics table to hypertable
SELECT create_hypertable('performance_metrics', 'timestamp', if_not_exists => TRUE);

-- Convert database_metrics table to hypertable
SELECT create_hypertable('database_metrics', 'timestamp', if_not_exists => TRUE);

-- Convert redis_metrics table to hypertable
SELECT create_hypertable('redis_metrics', 'timestamp', if_not_exists => TRUE);

-- Convert health_checks table to hypertable
SELECT create_hypertable('health_checks', 'timestamp', if_not_exists => TRUE);

-- Convert log_entries table to hypertable
SELECT create_hypertable('log_entries', 'timestamp', if_not_exists => TRUE);

-- Continuous aggregates for metrics aggregation
-- Note: These require TimescaleDB Toolkit extension

-- 1-minute aggregates for service metrics
CREATE MATERIALIZED VIEW IF NOT EXISTS service_metrics_1m
WITH (timescaledb.continuous) AS
SELECT 
    service,
    time_bucket('1 minute', timestamp) AS bucket,
    AVG(cpu_usage) AS avg_cpu_usage,
    MAX(cpu_usage) AS max_cpu_usage,
    AVG(memory_usage) AS avg_memory_usage,
    MAX(memory_usage) AS max_memory_usage,
    AVG(request_count) AS avg_request_count,
    SUM(request_count) AS total_request_count,
    AVG(error_count) AS avg_error_count,
    SUM(error_count) AS total_error_count
FROM service_metrics
GROUP BY service, bucket;

-- 5-minute aggregates for service metrics
CREATE MATERIALIZED VIEW IF NOT EXISTS service_metrics_5m
WITH (timescaledb.continuous) AS
SELECT 
    service,
    time_bucket('5 minutes', timestamp) AS bucket,
    AVG(cpu_usage) AS avg_cpu_usage,
    MAX(cpu_usage) AS max_cpu_usage,
    AVG(memory_usage) AS avg_memory_usage,
    MAX(memory_usage) AS max_memory_usage,
    AVG(request_count) AS avg_request_count,
    SUM(request_count) AS total_request_count,
    AVG(error_count) AS avg_error_count,
    SUM(error_count) AS total_error_count
FROM service_metrics
GROUP BY service, bucket;

-- 1-hour aggregates for service metrics
CREATE MATERIALIZED VIEW IF NOT EXISTS service_metrics_1h
WITH (timescaledb.continuous) AS
SELECT 
    service,
    time_bucket('1 hour', timestamp) AS bucket,
    AVG(cpu_usage) AS avg_cpu_usage,
    MAX(cpu_usage) AS max_cpu_usage,
    AVG(memory_usage) AS avg_memory_usage,
    MAX(memory_usage) AS max_memory_usage,
    AVG(request_count) AS avg_request_count,
    SUM(request_count) AS total_request_count,
    AVG(error_count) AS avg_error_count,
    SUM(error_count) AS total_error_count
FROM service_metrics
GROUP BY service, bucket;

-- 1-day aggregates for service metrics
CREATE MATERIALIZED VIEW IF NOT EXISTS service_metrics_1d
WITH (timescaledb.continuous) AS
SELECT 
    service,
    time_bucket('1 day', timestamp) AS bucket,
    AVG(cpu_usage) AS avg_cpu_usage,
    MAX(cpu_usage) AS max_cpu_usage,
    AVG(memory_usage) AS avg_memory_usage,
    MAX(memory_usage) AS max_memory_usage,
    AVG(request_count) AS avg_request_count,
    SUM(request_count) AS total_request_count,
    AVG(error_count) AS avg_error_count,
    SUM(error_count) AS total_error_count
FROM service_metrics
GROUP BY service, bucket;

-- Continuous aggregate policies for automatic refresh
SELECT add_continuous_aggregate_policy('service_metrics_1m',
    start_offset => INTERVAL '1 hour',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');

SELECT add_continuous_aggregate_policy('service_metrics_5m',
    start_offset => INTERVAL '1 day',
    end_offset => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes');

SELECT add_continuous_aggregate_policy('service_metrics_1h',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

SELECT add_continuous_aggregate_policy('service_metrics_1d',
    start_offset => INTERVAL '30 days',
    end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day');

-- Retention policies for data cleanup
SELECT add_retention_policy('metrics', INTERVAL '30 days');
SELECT add_retention_policy('service_metrics', INTERVAL '90 days');
SELECT add_retention_policy('performance_metrics', INTERVAL '30 days');
SELECT add_retention_policy('database_metrics', INTERVAL '30 days');
SELECT add_retention_policy('redis_metrics', INTERVAL '30 days');
SELECT add_retention_policy('health_checks', INTERVAL '7 days');
SELECT add_retention_policy('log_entries', INTERVAL '7 days');

-- Compression policies for older data
SELECT add_compression_policy('metrics', INTERVAL '7 days');
SELECT add_compression_policy('service_metrics', INTERVAL '7 days');
SELECT add_compression_policy('performance_metrics', INTERVAL '7 days');
SELECT add_compression_policy('database_metrics', INTERVAL '7 days');
SELECT add_compression_policy('redis_metrics', INTERVAL '7 days');
SELECT add_compression_policy('health_checks', INTERVAL '1 day');
SELECT add_compression_policy('log_entries', INTERVAL '1 day');

-- Triggers for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_alert_definitions_updated_at 
    BEFORE UPDATE ON alert_definitions 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_alert_instances_updated_at 
    BEFORE UPDATE ON alert_instances 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_notification_channels_updated_at 
    BEFORE UPDATE ON notification_channels 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_notification_templates_updated_at 
    BEFORE UPDATE ON notification_templates 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default notification channels
INSERT INTO notification_channels (id, name, type, config, enabled) VALUES
    ('00000000-0000-0000-0000-000000000001', 'Default Email', 'email', 
     '{"smtp": {"host": "localhost", "port": 587, "secure": false}, "from": "alerts@hunch.com", "to": "admin@hunch.com"}', 
     true),
    ('00000000-0000-0000-0000-000000000002', 'Default Webhook', 'webhook', 
     '{"url": "https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK", "method": "POST"}', 
     false),
    ('00000000-0000-0000-0000-000000000003', 'Default Slack', 'slack', 
     '{"webhook_url": "https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK", "channel": "#alerts"}', 
     false)
ON CONFLICT (id) DO NOTHING;

-- Insert default notification templates
INSERT INTO notification_templates (id, name, channel_type, subject, body, enabled) VALUES
    ('00000000-0000-0000-0000-000000000001', 'Email Alert Template', 'email', 
     'Alert: {{alert.title}}', 
     'Alert: {{alert.title}}\n\nDescription: {{alert.description}}\n\nSeverity: {{alert.severity}}\n\nStarted: {{alert.started_at}}\n\nService: {{alert.labels.service}}\n\nPlease investigate this issue.', 
     true),
    ('00000000-0000-0000-0000-000000000002', 'Slack Alert Template', 'slack', 
     null, 
     '🚨 *Alert: {{alert.title}}*\n\n*Description:* {{alert.description}}\n*Severity:* {{alert.severity}}\n*Service:* {{alert.labels.service}}\n*Started:* {{alert.started_at}}', 
     true),
    ('00000000-0000-0000-0000-000000000003', 'Webhook Alert Template', 'webhook', 
     null, 
     '{"alert": {"title": "{{alert.title}}", "description": "{{alert.description}}", "severity": "{{alert.severity}}", "service": "{{alert.labels.service}}", "started_at": "{{alert.started_at}}"}}', 
     true)
ON CONFLICT (id) DO NOTHING;
