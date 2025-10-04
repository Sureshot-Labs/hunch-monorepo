// Monitoring and alerting system types
import { EventEmitter } from 'events';

// Metric types
export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary';

export type MetricValue = number | string;

// Metric definition
export interface MetricDefinition {
  name: string;
  type: MetricType;
  help: string;
  labels?: string[];
  buckets?: number[]; // For histogram
  percentiles?: number[]; // For summary
}

// Metric data point
export interface MetricDataPoint {
  name: string;
  value: MetricValue;
  labels?: Record<string, string>;
  timestamp?: Date;
}

// Service health status
export type HealthStatus = 'healthy' | 'unhealthy' | 'degraded' | 'unknown';

// Service health check
export interface HealthCheck {
  service: string;
  status: HealthStatus;
  message?: string;
  details?: Record<string, any>;
  timestamp: Date;
  responseTime?: number;
  dependencies?: HealthCheck[];
}

// Alert severity levels
export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

// Alert status
export type AlertStatus = 'firing' | 'resolved' | 'acknowledged' | 'silenced';

// Alert definition
export interface AlertDefinition {
  id: string;
  name: string;
  description: string;
  severity: AlertSeverity;
  enabled: boolean;
  conditions: AlertCondition[];
  actions: AlertAction[];
  cooldownPeriod: number; // minutes
  evaluationInterval: number; // seconds
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

// Alert condition
export interface AlertCondition {
  metric: string;
  operator: 'gt' | 'lt' | 'eq' | 'ne' | 'gte' | 'lte';
  threshold: number;
  duration?: number; // seconds
  labels?: Record<string, string>;
}

// Alert action
export interface AlertAction {
  type: 'email' | 'webhook' | 'slack' | 'pagerduty' | 'sms';
  config: Record<string, any>;
  enabled: boolean;
}

// Alert instance
export interface AlertInstance {
  id: string;
  alertId: string;
  status: AlertStatus;
  severity: AlertSeverity;
  title: string;
  description: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startedAt: Date;
  resolvedAt?: Date;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  silencedUntil?: Date;
  silencedBy?: string;
  evaluationTime: Date;
  value?: number;
  threshold?: number;
}

// Notification channel
export interface NotificationChannel {
  id: string;
  name: string;
  type: 'email' | 'webhook' | 'slack' | 'pagerduty' | 'sms';
  config: Record<string, any>;
  enabled: boolean;
  labels?: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

// Notification template
export interface NotificationTemplate {
  id: string;
  name: string;
  channelType: string;
  subject?: string;
  body: string;
  enabled: boolean;
  variables?: string[];
  createdAt: Date;
  updatedAt: Date;
}

// Service metrics
export interface ServiceMetrics {
  service: string;
  timestamp: Date;
  metrics: {
    // System metrics
    cpuUsage: number;
    memoryUsage: number;
    diskUsage: number;
    networkIn: number;
    networkOut: number;
    
    // Application metrics
    requestCount: number;
    requestDuration: number;
    errorCount: number;
    activeConnections: number;
    
    // Business metrics
    ordersProcessed: number;
    tradesExecuted: number;
    webhooksDelivered: number;
    analysisCompleted: number;
    
    // Custom metrics
    customMetrics: Record<string, number>;
  };
}

// Performance metrics
export interface PerformanceMetrics {
  service: string;
  endpoint?: string;
  method?: string;
  timestamp: Date;
  metrics: {
    responseTime: number;
    throughput: number;
    errorRate: number;
    availability: number;
    latency: {
      p50: number;
      p90: number;
      p95: number;
      p99: number;
    };
  };
}

// Database metrics
export interface DatabaseMetrics {
  service: string;
  timestamp: Date;
  metrics: {
    connectionCount: number;
    activeQueries: number;
    slowQueries: number;
    deadlocks: number;
    cacheHitRate: number;
    diskUsage: number;
    indexUsage: number;
    replicationLag?: number;
  };
}

// Redis metrics
export interface RedisMetrics {
  service: string;
  timestamp: Date;
  metrics: {
    connectedClients: number;
    usedMemory: number;
    memoryFragmentationRatio: number;
    keyspaceHits: number;
    keyspaceMisses: number;
    commandsProcessed: number;
    evictedKeys: number;
    expiredKeys: number;
  };
}

// Monitoring configuration
export interface MonitoringConfig {
  metrics: {
    enabled: boolean;
    port: number;
    path: string;
    collectDefaultMetrics: boolean;
    collectSystemMetrics: boolean;
    collectBusinessMetrics: boolean;
  };
  alerts: {
    enabled: boolean;
    evaluationInterval: number;
    cooldownPeriod: number;
    maxRetries: number;
  };
  notifications: {
    enabled: boolean;
    channels: NotificationChannel[];
    templates: NotificationTemplate[];
  };
  retention: {
    metricsRetentionDays: number;
    alertsRetentionDays: number;
    logsRetentionDays: number;
  };
}

// Monitoring events
export interface MonitoringEvents {
  'metric:collected': (metric: MetricDataPoint) => void;
  'health:checked': (health: HealthCheck) => void;
  'alert:fired': (alert: AlertInstance) => void;
  'alert:resolved': (alert: AlertInstance) => void;
  'notification:sent': (channel: string, alert: AlertInstance) => void;
  'notification:failed': (channel: string, alert: AlertInstance, error: Error) => void;
  'error': (error: Error, context: string) => void;
}

// Monitoring service interface
export interface MonitoringService extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  collectMetric(metric: MetricDataPoint): Promise<void>;
  checkHealth(service: string): Promise<HealthCheck>;
  evaluateAlerts(): Promise<void>;
  createAlert(alert: AlertDefinition): Promise<void>;
  updateAlert(alertId: string, updates: Partial<AlertDefinition>): Promise<void>;
  deleteAlert(alertId: string): Promise<void>;
  acknowledgeAlert(alertId: string, userId: string): Promise<void>;
  silenceAlert(alertId: string, userId: string, duration: number): Promise<void>;
  getMetrics(service?: string, timeRange?: { start: Date; end: Date }): Promise<MetricDataPoint[]>;
  getAlerts(status?: AlertStatus, severity?: AlertSeverity): Promise<AlertInstance[]>;
  getHealthStatus(): Promise<HealthCheck[]>;
  getStats(): Promise<{
    totalMetrics: number;
    totalAlerts: number;
    activeAlerts: number;
    healthyServices: number;
    unhealthyServices: number;
  }>;
}

// Dashboard data
export interface DashboardData {
  overview: {
    totalServices: number;
    healthyServices: number;
    unhealthyServices: number;
    activeAlerts: number;
    totalMetrics: number;
  };
  services: Array<{
    name: string;
    status: HealthStatus;
    uptime: number;
    responseTime: number;
    errorRate: number;
    lastCheck: Date;
  }>;
  alerts: Array<{
    id: string;
    name: string;
    severity: AlertSeverity;
    status: AlertStatus;
    startedAt: Date;
    service: string;
  }>;
  metrics: Array<{
    name: string;
    value: number;
    trend: 'up' | 'down' | 'stable';
    change: number;
  }>;
}

// Log entry
export interface LogEntry {
  id: string;
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  service: string;
  message: string;
  context?: Record<string, any>;
  userId?: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
}

// Log query
export interface LogQuery {
  service?: string;
  level?: string;
  startTime?: Date;
  endTime?: Date;
  limit?: number;
  offset?: number;
  search?: string;
}

// Monitoring report
export interface MonitoringReport {
  id: string;
  type: 'daily' | 'weekly' | 'monthly';
  period: {
    start: Date;
    end: Date;
  };
  summary: {
    totalAlerts: number;
    resolvedAlerts: number;
    averageResponseTime: number;
    uptime: number;
    errorRate: number;
  };
  services: Array<{
    name: string;
    uptime: number;
    alerts: number;
    errors: number;
    performance: number;
  }>;
  alerts: Array<{
    name: string;
    count: number;
    severity: AlertSeverity;
    averageResolutionTime: number;
  }>;
  metrics: Array<{
    name: string;
    average: number;
    min: number;
    max: number;
    trend: 'up' | 'down' | 'stable';
  }>;
  recommendations: string[];
  createdAt: Date;
}
