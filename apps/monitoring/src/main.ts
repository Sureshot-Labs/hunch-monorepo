// Monitoring service main entry point
import Fastify from 'fastify';
import { logger } from '@hunch/shared';
import { Pool } from 'pg';
import { createClient, RedisClientType } from 'redis';
import { MetricsCollector } from './services/metrics-collector';
import { HealthChecker } from './services/health-checker';
import { AlertManager } from './services/alert-manager';
import { MonitoringConfig } from './types/monitoring';

// Environment configuration
const config: MonitoringConfig = {
  metrics: {
    enabled: true,
    port: parseInt(process.env.MONITORING_METRICS_PORT || '9090'),
    path: process.env.MONITORING_METRICS_PATH || '/metrics',
    collectDefaultMetrics: true,
    collectSystemMetrics: true,
    collectBusinessMetrics: true,
  },
  alerts: {
    enabled: true,
    evaluationInterval: parseInt(process.env.MONITORING_ALERT_INTERVAL || '10'),
    cooldownPeriod: parseInt(process.env.MONITORING_ALERT_COOLDOWN || '5'),
    maxRetries: parseInt(process.env.MONITORING_ALERT_MAX_RETRIES || '3'),
  },
  notifications: {
    enabled: true,
    channels: [],
    templates: [],
  },
  retention: {
    metricsRetentionDays: parseInt(process.env.MONITORING_METRICS_RETENTION || '30'),
    alertsRetentionDays: parseInt(process.env.MONITORING_ALERTS_RETENTION || '90'),
    logsRetentionDays: parseInt(process.env.MONITORING_LOGS_RETENTION || '7'),
  },
};

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://hunch:hunch@localhost:5432/hunch',
});

// Redis connection
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

// Services
let metricsCollector: MetricsCollector;
let healthChecker: HealthChecker;
let alertManager: AlertManager;

// Fastify instance
const fastify = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
      },
    },
  },
});

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  
  try {
    // Stop services
    if (metricsCollector) {
      await metricsCollector.stop();
    }
    if (healthChecker) {
      await healthChecker.stop();
    }
    if (alertManager) {
      await alertManager.stop();
    }

    // Close connections
    await pool.end();
    await redisClient.quit();
    await fastify.close();

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown', error);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Health check endpoint
fastify.get('/health', async (request, reply) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'healthy',
        redis: 'healthy',
        metrics: metricsCollector ? 'healthy' : 'unhealthy',
        healthChecker: healthChecker ? 'healthy' : 'unhealthy',
        alertManager: alertManager ? 'healthy' : 'unhealthy',
      },
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
    };

    // Check database connection
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      health.services.database = 'unhealthy';
      health.status = 'unhealthy';
    }

    // Check Redis connection
    try {
      await redisClient.ping();
    } catch (error) {
      health.services.redis = 'unhealthy';
      health.status = 'unhealthy';
    }

    const statusCode = health.status === 'healthy' ? 200 : 503;
    reply.code(statusCode).send(health);
  } catch (error) {
    logger.error('Health check failed', error);
    reply.code(503).send({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Metrics endpoint
fastify.get('/metrics', async (request, reply) => {
  try {
    if (!metricsCollector) {
      reply.code(503).send('Metrics collector not available');
      return;
    }

    const metrics = await metricsCollector.getPrometheusMetrics();
    reply.type('text/plain').send(metrics);
  } catch (error) {
    logger.error('Failed to get metrics', error);
    reply.code(500).send('Failed to get metrics');
  }
});

// Service health status
fastify.get('/health/status', async (request, reply) => {
  try {
    if (!healthChecker) {
      reply.code(503).send('Health checker not available');
      return;
    }

    const healthStatus = await healthChecker.getHealthStatus();
    reply.send(healthStatus);
  } catch (error) {
    logger.error('Failed to get health status', error);
    reply.code(500).send('Failed to get health status');
  }
});

// Service uptime
fastify.get('/health/uptime/:service', async (request, reply) => {
  try {
    const { service } = request.params as { service: string };
    
    if (!healthChecker) {
      reply.code(503).send('Health checker not available');
      return;
    }

    const uptime = await healthChecker.getServiceUptime(service);
    reply.send({ service, uptime });
  } catch (error) {
    logger.error('Failed to get service uptime', error);
    reply.code(500).send('Failed to get service uptime');
  }
});

// Alerts endpoint
fastify.get('/alerts', async (request, reply) => {
  try {
    if (!alertManager) {
      reply.code(503).send('Alert manager not available');
      return;
    }

    const { status, severity } = request.query as { status?: string; severity?: string };
    const alerts = await alertManager.getAlerts(status as any, severity as any);
    reply.send(alerts);
  } catch (error) {
    logger.error('Failed to get alerts', error);
    reply.code(500).send('Failed to get alerts');
  }
});

// Alert statistics
fastify.get('/alerts/stats', async (request, reply) => {
  try {
    if (!alertManager) {
      reply.code(503).send('Alert manager not available');
      return;
    }

    const stats = await alertManager.getStats();
    reply.send(stats);
  } catch (error) {
    logger.error('Failed to get alert statistics', error);
    reply.code(500).send('Failed to get alert statistics');
  }
});

// Acknowledge alert
fastify.post('/alerts/:alertId/acknowledge', async (request, reply) => {
  try {
    const { alertId } = request.params as { alertId: string };
    const { userId } = request.body as { userId: string };

    if (!alertManager) {
      reply.code(503).send('Alert manager not available');
      return;
    }

    await alertManager.acknowledgeAlert(alertId, userId);
    reply.send({ success: true });
  } catch (error) {
    logger.error('Failed to acknowledge alert', error);
    reply.code(500).send('Failed to acknowledge alert');
  }
});

// Silence alert
fastify.post('/alerts/:alertId/silence', async (request, reply) => {
  try {
    const { alertId } = request.params as { alertId: string };
    const { userId, duration } = request.body as { userId: string; duration: number };

    if (!alertManager) {
      reply.code(503).send('Alert manager not available');
      return;
    }

    await alertManager.silenceAlert(alertId, userId, duration);
    reply.send({ success: true });
  } catch (error) {
    logger.error('Failed to silence alert', error);
    reply.code(500).send('Failed to silence alert');
  }
});

// Custom metrics endpoint
fastify.post('/metrics', async (request, reply) => {
  try {
    const metric = request.body as any;

    if (!metricsCollector) {
      reply.code(503).send('Metrics collector not available');
      return;
    }

    await metricsCollector.collectMetric(metric);
    reply.send({ success: true });
  } catch (error) {
    logger.error('Failed to collect custom metric', error);
    reply.code(500).send('Failed to collect custom metric');
  }
});

// Dashboard data
fastify.get('/dashboard', async (request, reply) => {
  try {
    const dashboardData = {
      overview: {
        totalServices: 6,
        healthyServices: 0,
        unhealthyServices: 0,
        activeAlerts: 0,
        totalMetrics: 0,
      },
      services: [],
      alerts: [],
      metrics: [],
    };

    // Get health status
    if (healthChecker) {
      const healthStatus = await healthChecker.getHealthStatus();
      dashboardData.overview.healthyServices = healthStatus.filter(h => h.status === 'healthy').length;
      dashboardData.overview.unhealthyServices = healthStatus.filter(h => h.status !== 'healthy').length;
      
      dashboardData.services = healthStatus.map(h => ({
        name: h.service,
        status: h.status,
        uptime: 0, // Would calculate from historical data
        responseTime: h.responseTime || 0,
        errorRate: 0, // Would calculate from metrics
        lastCheck: h.timestamp,
      }));
    }

    // Get alerts
    if (alertManager) {
      const alerts = await alertManager.getAlerts('firing');
      dashboardData.overview.activeAlerts = alerts.length;
      dashboardData.alerts = alerts.map(a => ({
        id: a.id,
        name: a.title,
        severity: a.severity,
        status: a.status,
        startedAt: a.startedAt,
        service: a.labels.service || 'unknown',
      }));
    }

    // Get metrics
    if (metricsCollector) {
      const metrics = await metricsCollector.getMetrics();
      dashboardData.overview.totalMetrics = metrics.length;
      dashboardData.metrics = metrics.slice(0, 10).map(m => ({
        name: m.name,
        value: typeof m.value === 'string' ? parseFloat(m.value) : m.value,
        trend: 'stable' as const,
        change: 0,
      }));
    }

    reply.send(dashboardData);
  } catch (error) {
    logger.error('Failed to get dashboard data', error);
    reply.code(500).send('Failed to get dashboard data');
  }
});

// Start monitoring service
async function startMonitoring() {
  try {
    logger.info('Starting monitoring service');

    // Connect to database
    await pool.connect();
    logger.info('Connected to database');

    // Connect to Redis
    await redisClient.connect();
    logger.info('Connected to Redis');

    // Initialize services
    metricsCollector = new MetricsCollector(pool, redisClient);
    healthChecker = new HealthChecker(pool, redisClient);
    alertManager = new AlertManager(pool, redisClient);

    // Start services
    if (config.metrics.enabled) {
      await metricsCollector.start();
      logger.info('Metrics collector started');
    }

    await healthChecker.start();
    logger.info('Health checker started');

    if (config.alerts.enabled) {
      await alertManager.start();
      logger.info('Alert manager started');
    }

    // Start Fastify server
    const port = parseInt(process.env.MONITORING_PORT || '3007');
    await fastify.listen({ port, host: '0.0.0.0' });
    logger.info(`Monitoring service started on port ${port}`);

    // Setup default alerts
    await setupDefaultAlerts();

  } catch (error) {
    logger.error('Failed to start monitoring service', error);
    process.exit(1);
  }
}

// Setup default alerts
async function setupDefaultAlerts() {
  try {
    if (!alertManager) return;

    const defaultAlerts = [
      {
        id: 'high-cpu-usage',
        name: 'High CPU Usage',
        description: 'CPU usage is above 80%',
        severity: 'high' as const,
        enabled: true,
        conditions: [
          {
            metric: 'system_cpu_usage_percent',
            operator: 'gt' as const,
            threshold: 80,
            duration: 300, // 5 minutes
          },
        ],
        actions: [
          {
            type: 'email' as const,
            config: {
              to: process.env.ALERT_EMAIL || 'admin@example.com',
              subject: 'High CPU Usage Alert',
            },
            enabled: true,
          },
        ],
        cooldownPeriod: 15,
        evaluationInterval: 30,
      },
      {
        id: 'high-memory-usage',
        name: 'High Memory Usage',
        description: 'Memory usage is above 90%',
        severity: 'critical' as const,
        enabled: true,
        conditions: [
          {
            metric: 'system_memory_usage_bytes',
            operator: 'gt' as const,
            threshold: 0.9 * 1024 * 1024 * 1024 * 1024, // 90% of 1TB
            duration: 180, // 3 minutes
          },
        ],
        actions: [
          {
            type: 'email' as const,
            config: {
              to: process.env.ALERT_EMAIL || 'admin@example.com',
              subject: 'High Memory Usage Alert',
            },
            enabled: true,
          },
        ],
        cooldownPeriod: 10,
        evaluationInterval: 30,
      },
      {
        id: 'database-connection-high',
        name: 'High Database Connections',
        description: 'Database connection count is above 80',
        severity: 'medium' as const,
        enabled: true,
        conditions: [
          {
            metric: 'database_connections',
            operator: 'gt' as const,
            threshold: 80,
            duration: 300, // 5 minutes
          },
        ],
        actions: [
          {
            type: 'email' as const,
            config: {
              to: process.env.ALERT_EMAIL || 'admin@example.com',
              subject: 'High Database Connections Alert',
            },
            enabled: true,
          },
        ],
        cooldownPeriod: 20,
        evaluationInterval: 30,
      },
    ];

    for (const alert of defaultAlerts) {
      try {
        await alertManager.createAlert(alert);
        logger.info('Default alert created', { alertId: alert.id });
      } catch (error) {
        logger.warn('Failed to create default alert', { error, alertId: alert.id });
      }
    }

    logger.info('Default alerts setup completed');
  } catch (error) {
    logger.error('Failed to setup default alerts', error);
  }
}

// Start the service
startMonitoring().catch(error => {
  logger.error('Failed to start monitoring service', error);
  process.exit(1);
});
