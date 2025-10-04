// Metrics collection service for monitoring system
import { EventEmitter } from 'events';
import { logger } from '@hunch/shared';
import { Pool } from 'pg';
import { RedisClientType } from 'redis';
import { register, Counter, Gauge, Histogram, Summary, collectDefaultMetrics } from 'prom-client';
import {
  MetricDefinition,
  MetricDataPoint,
  ServiceMetrics,
  PerformanceMetrics,
  DatabaseMetrics,
  RedisMetrics,
  MonitoringEvents,
} from '../types/monitoring';

// Prometheus metrics
const metrics = {
  // System metrics
  cpuUsage: new Gauge({
    name: 'system_cpu_usage_percent',
    help: 'CPU usage percentage',
    labelNames: ['service'],
  }),
  memoryUsage: new Gauge({
    name: 'system_memory_usage_bytes',
    help: 'Memory usage in bytes',
    labelNames: ['service'],
  }),
  diskUsage: new Gauge({
    name: 'system_disk_usage_bytes',
    help: 'Disk usage in bytes',
    labelNames: ['service', 'mountpoint'],
  }),
  networkIn: new Counter({
    name: 'system_network_in_bytes_total',
    help: 'Network input bytes',
    labelNames: ['service', 'interface'],
  }),
  networkOut: new Counter({
    name: 'system_network_out_bytes_total',
    help: 'Network output bytes',
    labelNames: ['service', 'interface'],
  }),

  // Application metrics
  requestCount: new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['service', 'method', 'endpoint', 'status_code'],
  }),
  requestDuration: new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['service', 'method', 'endpoint'],
    buckets: [0.1, 0.5, 1, 2, 5, 10],
  }),
  errorCount: new Counter({
    name: 'http_errors_total',
    help: 'Total HTTP errors',
    labelNames: ['service', 'method', 'endpoint', 'error_type'],
  }),
  activeConnections: new Gauge({
    name: 'active_connections',
    help: 'Number of active connections',
    labelNames: ['service', 'type'],
  }),

  // Business metrics
  ordersProcessed: new Counter({
    name: 'orders_processed_total',
    help: 'Total orders processed',
    labelNames: ['service', 'venue', 'status'],
  }),
  tradesExecuted: new Counter({
    name: 'trades_executed_total',
    help: 'Total trades executed',
    labelNames: ['service', 'venue', 'side'],
  }),
  webhooksDelivered: new Counter({
    name: 'webhooks_delivered_total',
    help: 'Total webhooks delivered',
    labelNames: ['service', 'event_type', 'status'],
  }),
  analysisCompleted: new Counter({
    name: 'analysis_completed_total',
    help: 'Total analysis completed',
    labelNames: ['service', 'type'],
  }),

  // Database metrics
  dbConnections: new Gauge({
    name: 'database_connections',
    help: 'Number of database connections',
    labelNames: ['service', 'state'],
  }),
  dbQueries: new Counter({
    name: 'database_queries_total',
    help: 'Total database queries',
    labelNames: ['service', 'type', 'status'],
  }),
  dbQueryDuration: new Histogram({
    name: 'database_query_duration_seconds',
    help: 'Database query duration in seconds',
    labelNames: ['service', 'type'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  }),
  dbCacheHitRate: new Gauge({
    name: 'database_cache_hit_rate',
    help: 'Database cache hit rate',
    labelNames: ['service'],
  }),

  // Redis metrics
  redisConnections: new Gauge({
    name: 'redis_connections',
    help: 'Number of Redis connections',
    labelNames: ['service'],
  }),
  redisCommands: new Counter({
    name: 'redis_commands_total',
    help: 'Total Redis commands',
    labelNames: ['service', 'command', 'status'],
  }),
  redisMemory: new Gauge({
    name: 'redis_memory_usage_bytes',
    help: 'Redis memory usage in bytes',
    labelNames: ['service'],
  }),
  redisKeys: new Gauge({
    name: 'redis_keys',
    help: 'Number of Redis keys',
    labelNames: ['service', 'type'],
  }),

  // Custom metrics
  customMetrics: new Map<string, Counter | Gauge | Histogram | Summary>(),
};

export class MetricsCollector extends EventEmitter {
  private pool: Pool;
  private redisClient: RedisClientType;
  private isCollecting: boolean = false;
  private collectionInterval?: NodeJS.Timeout;
  private customMetrics: Map<string, MetricDefinition> = new Map();

  constructor(pool: Pool, redisClient: RedisClientType) {
    super();
    this.pool = pool;
    this.redisClient = redisClient;
    this.setupEventHandlers();
  }

  // Start metrics collection
  public async start(): Promise<void> {
    if (this.isCollecting) {
      logger.warn('Metrics collection is already running');
      return;
    }

    try {
      logger.info('Starting metrics collection');

      // Collect default system metrics
      collectDefaultMetrics({ register });

      // Start periodic collection
      this.collectionInterval = setInterval(() => {
        this.collectSystemMetrics();
        this.collectDatabaseMetrics();
        this.collectRedisMetrics();
      }, 10000); // Collect every 10 seconds

      this.isCollecting = true;
      logger.info('Metrics collection started successfully');
    } catch (error) {
      logger.error('Failed to start metrics collection', error);
      throw error;
    }
  }

  // Stop metrics collection
  public async stop(): Promise<void> {
    if (!this.isCollecting) {
      logger.warn('Metrics collection is not running');
      return;
    }

    try {
      logger.info('Stopping metrics collection');

      if (this.collectionInterval) {
        clearInterval(this.collectionInterval);
        this.collectionInterval = undefined;
      }

      this.isCollecting = false;
      logger.info('Metrics collection stopped successfully');
    } catch (error) {
      logger.error('Error stopping metrics collection', error);
    }
  }

  // Collect custom metric
  public async collectMetric(metric: MetricDataPoint): Promise<void> {
    try {
      const metricName = metric.name;
      const labels = metric.labels || {};
      const value = typeof metric.value === 'string' ? parseFloat(metric.value) : metric.value;

      // Get or create metric
      let prometheusMetric = metrics.customMetrics.get(metricName);
      if (!prometheusMetric) {
        const definition = this.customMetrics.get(metricName);
        if (!definition) {
          throw new Error(`Metric definition not found: ${metricName}`);
        }

        prometheusMetric = this.createPrometheusMetric(definition);
        metrics.customMetrics.set(metricName, prometheusMetric);
      }

      // Update metric
      if (prometheusMetric instanceof Counter) {
        prometheusMetric.inc(labels, value);
      } else if (prometheusMetric instanceof Gauge) {
        prometheusMetric.set(labels, value);
      } else if (prometheusMetric instanceof Histogram) {
        prometheusMetric.observe(labels, value);
      } else if (prometheusMetric instanceof Summary) {
        prometheusMetric.observe(labels, value);
      }

      this.emit('metric:collected', metric);
      logger.debug('Custom metric collected', { metric: metricName, value, labels });
    } catch (error) {
      logger.error('Failed to collect custom metric', { error, metric });
      this.emit('error', error as Error, 'collectMetric');
    }
  }

  // Define custom metric
  public defineMetric(definition: MetricDefinition): void {
    this.customMetrics.set(definition.name, definition);
    logger.info('Custom metric defined', { name: definition.name, type: definition.type });
  }

  // Collect service metrics
  public async collectServiceMetrics(service: string): Promise<ServiceMetrics> {
    try {
      const timestamp = new Date();

      // Collect system metrics
      const systemMetrics = await this.getSystemMetrics(service);

      // Collect application metrics
      const appMetrics = await this.getApplicationMetrics(service);

      // Collect business metrics
      const businessMetrics = await this.getBusinessMetrics(service);

      const serviceMetrics: ServiceMetrics = {
        service,
        timestamp,
        metrics: {
          ...systemMetrics,
          ...appMetrics,
          ...businessMetrics,
          customMetrics: {},
        },
      };

      // Store in database
      await this.storeServiceMetrics(serviceMetrics);

      return serviceMetrics;
    } catch (error) {
      logger.error('Failed to collect service metrics', { error, service });
      throw error;
    }
  }

  // Collect performance metrics
  public async collectPerformanceMetrics(
    service: string,
    endpoint?: string,
    method?: string
  ): Promise<PerformanceMetrics> {
    try {
      const timestamp = new Date();

      // Get performance data from Prometheus metrics
      const responseTime = this.getMetricValue('http_request_duration_seconds', { service, endpoint, method }) || 0;
      const throughput = this.getMetricValue('http_requests_total', { service, endpoint, method }) || 0;
      const errorRate = this.getMetricValue('http_errors_total', { service, endpoint, method }) || 0;

      const performanceMetrics: PerformanceMetrics = {
        service,
        endpoint,
        method,
        timestamp,
        metrics: {
          responseTime,
          throughput,
          errorRate,
          availability: errorRate === 0 ? 100 : Math.max(0, 100 - (errorRate / throughput) * 100),
          latency: {
            p50: responseTime * 0.5,
            p90: responseTime * 0.9,
            p95: responseTime * 0.95,
            p99: responseTime * 0.99,
          },
        },
      };

      // Store in database
      await this.storePerformanceMetrics(performanceMetrics);

      return performanceMetrics;
    } catch (error) {
      logger.error('Failed to collect performance metrics', { error, service });
      throw error;
    }
  }

  // Get metrics for Prometheus scraping
  public async getPrometheusMetrics(): Promise<string> {
    try {
      return await register.metrics();
    } catch (error) {
      logger.error('Failed to get Prometheus metrics', error);
      throw error;
    }
  }

  // Get metrics from database
  public async getMetrics(
    service?: string,
    timeRange?: { start: Date; end: Date }
  ): Promise<MetricDataPoint[]> {
    try {
      let query = 'SELECT * FROM metrics WHERE 1=1';
      const params: any[] = [];
      let paramIndex = 1;

      if (service) {
        query += ` AND service = $${paramIndex++}`;
        params.push(service);
      }

      if (timeRange) {
        query += ` AND timestamp >= $${paramIndex++} AND timestamp <= $${paramIndex++}`;
        params.push(timeRange.start, timeRange.end);
      }

      query += ' ORDER BY timestamp DESC LIMIT 1000';

      const result = await this.pool.query(query, params);
      return result.rows.map(row => ({
        name: row.metric_name,
        value: row.value,
        labels: row.labels,
        timestamp: row.timestamp,
      }));
    } catch (error) {
      logger.error('Failed to get metrics from database', error);
      throw error;
    }
  }

  // Private methods

  private async collectSystemMetrics(): Promise<void> {
    try {
      // This would typically use system monitoring libraries
      // For now, we'll simulate system metrics
      const services = ['trading-engine', 'analytics-engine', 'webhook-system', 'api'];

      for (const service of services) {
        // Simulate CPU usage
        const cpuUsage = Math.random() * 100;
        metrics.cpuUsage.set({ service }, cpuUsage);

        // Simulate memory usage
        const memoryUsage = Math.random() * 1024 * 1024 * 1024; // Random GB
        metrics.memoryUsage.set({ service }, memoryUsage);

        // Simulate disk usage
        const diskUsage = Math.random() * 100 * 1024 * 1024 * 1024; // Random GB
        metrics.diskUsage.set({ service, mountpoint: '/' }, diskUsage);
      }
    } catch (error) {
      logger.error('Failed to collect system metrics', error);
    }
  }

  private async collectDatabaseMetrics(): Promise<void> {
    try {
      // Get database connection count
      const connectionResult = await this.pool.query(
        'SELECT count(*) as connections FROM pg_stat_activity WHERE state = $1',
        ['active']
      );
      const activeConnections = parseInt(connectionResult.rows[0].connections);

      metrics.dbConnections.set({ service: 'postgres', state: 'active' }, activeConnections);

      // Get cache hit rate
      const cacheResult = await this.pool.query(
        'SELECT round(100.0 * sum(blks_hit) / (sum(blks_hit) + sum(blks_read)), 2) as hit_rate FROM pg_stat_database'
      );
      const cacheHitRate = parseFloat(cacheResult.rows[0].hit_rate) || 0;

      metrics.dbCacheHitRate.set({ service: 'postgres' }, cacheHitRate);

      // Get slow queries
      const slowQueriesResult = await this.pool.query(
        'SELECT count(*) as slow_queries FROM pg_stat_statements WHERE mean_time > 1000'
      );
      const slowQueries = parseInt(slowQueriesResult.rows[0].slow_queries);

      metrics.dbQueries.inc({ service: 'postgres', type: 'slow', status: 'completed' }, slowQueries);
    } catch (error) {
      logger.error('Failed to collect database metrics', error);
    }
  }

  private async collectRedisMetrics(): Promise<void> {
    try {
      // Get Redis info
      const info = await this.redisClient.info('memory');
      const lines = info.split('\r\n');
      const memoryUsed = lines.find(line => line.startsWith('used_memory:'))?.split(':')[1];
      
      if (memoryUsed) {
        metrics.redisMemory.set({ service: 'redis' }, parseInt(memoryUsed));
      }

      // Get Redis key count
      const dbSize = await this.redisClient.dbSize();
      metrics.redisKeys.set({ service: 'redis', type: 'total' }, dbSize);

      // Get Redis connection count
      const clientList = await this.redisClient.clientList();
      const connectionCount = clientList.split('\n').length;
      metrics.redisConnections.set({ service: 'redis' }, connectionCount);
    } catch (error) {
      logger.error('Failed to collect Redis metrics', error);
    }
  }

  private async getSystemMetrics(service: string): Promise<Partial<ServiceMetrics['metrics']>> {
    return {
      cpuUsage: this.getMetricValue('system_cpu_usage_percent', { service }) || 0,
      memoryUsage: this.getMetricValue('system_memory_usage_bytes', { service }) || 0,
      diskUsage: this.getMetricValue('system_disk_usage_bytes', { service }) || 0,
      networkIn: this.getMetricValue('system_network_in_bytes_total', { service }) || 0,
      networkOut: this.getMetricValue('system_network_out_bytes_total', { service }) || 0,
    };
  }

  private async getApplicationMetrics(service: string): Promise<Partial<ServiceMetrics['metrics']>> {
    return {
      requestCount: this.getMetricValue('http_requests_total', { service }) || 0,
      requestDuration: this.getMetricValue('http_request_duration_seconds', { service }) || 0,
      errorCount: this.getMetricValue('http_errors_total', { service }) || 0,
      activeConnections: this.getMetricValue('active_connections', { service }) || 0,
    };
  }

  private async getBusinessMetrics(service: string): Promise<Partial<ServiceMetrics['metrics']>> {
    return {
      ordersProcessed: this.getMetricValue('orders_processed_total', { service }) || 0,
      tradesExecuted: this.getMetricValue('trades_executed_total', { service }) || 0,
      webhooksDelivered: this.getMetricValue('webhooks_delivered_total', { service }) || 0,
      analysisCompleted: this.getMetricValue('analysis_completed_total', { service }) || 0,
    };
  }

  private getMetricValue(metricName: string, labels: Record<string, string>): number | null {
    try {
      const metric = metrics[metricName as keyof typeof metrics] as any;
      if (!metric) return null;

      // This is a simplified version - in reality, you'd need to query the actual metric values
      return Math.random() * 100; // Placeholder
    } catch (error) {
      logger.error('Failed to get metric value', { error, metricName, labels });
      return null;
    }
  }

  private createPrometheusMetric(definition: MetricDefinition): Counter | Gauge | Histogram | Summary {
    const config = {
      name: definition.name,
      help: definition.help,
      labelNames: definition.labels || [],
    };

    switch (definition.type) {
      case 'counter':
        return new Counter(config);
      case 'gauge':
        return new Gauge(config);
      case 'histogram':
        return new Histogram({
          ...config,
          buckets: definition.buckets || [0.1, 0.5, 1, 2, 5, 10],
        });
      case 'summary':
        return new Summary({
          ...config,
          percentiles: definition.percentiles || [0.5, 0.9, 0.95, 0.99],
        });
      default:
        throw new Error(`Unsupported metric type: ${definition.type}`);
    }
  }

  private async storeServiceMetrics(metrics: ServiceMetrics): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO service_metrics (
          service, timestamp, cpu_usage, memory_usage, disk_usage,
          network_in, network_out, request_count, request_duration,
          error_count, active_connections, orders_processed,
          trades_executed, webhooks_delivered, analysis_completed
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          metrics.service,
          metrics.timestamp,
          metrics.metrics.cpuUsage,
          metrics.metrics.memoryUsage,
          metrics.metrics.diskUsage,
          metrics.metrics.networkIn,
          metrics.metrics.networkOut,
          metrics.metrics.requestCount,
          metrics.metrics.requestDuration,
          metrics.metrics.errorCount,
          metrics.metrics.activeConnections,
          metrics.metrics.ordersProcessed,
          metrics.metrics.tradesExecuted,
          metrics.metrics.webhooksDelivered,
          metrics.metrics.analysisCompleted,
        ]
      );
    } catch (error) {
      logger.error('Failed to store service metrics', error);
    }
  }

  private async storePerformanceMetrics(metrics: PerformanceMetrics): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO performance_metrics (
          service, endpoint, method, timestamp, response_time,
          throughput, error_rate, availability, latency_p50,
          latency_p90, latency_p95, latency_p99
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          metrics.service,
          metrics.endpoint,
          metrics.method,
          metrics.timestamp,
          metrics.metrics.responseTime,
          metrics.metrics.throughput,
          metrics.metrics.errorRate,
          metrics.metrics.availability,
          metrics.metrics.latency.p50,
          metrics.metrics.latency.p90,
          metrics.metrics.latency.p95,
          metrics.metrics.latency.p99,
        ]
      );
    } catch (error) {
      logger.error('Failed to store performance metrics', error);
    }
  }

  private setupEventHandlers(): void {
    this.on('metric:collected', (metric) => {
      logger.debug('Metric collected', { name: metric.name, value: metric.value });
    });

    this.on('error', (error, context) => {
      logger.error('Metrics collector error', { error: error.message, context });
    });
  }
}
