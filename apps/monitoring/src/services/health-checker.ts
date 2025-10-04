// Health checking service for monitoring system
import { EventEmitter } from 'events';
import { logger } from '@hunch/shared';
import { Pool } from 'pg';
import { RedisClientType } from 'redis';
import axios from 'axios';
import {
  HealthCheck,
  HealthStatus,
  MonitoringEvents,
} from '../types/monitoring';

// Service configuration
interface ServiceConfig {
  name: string;
  url: string;
  timeout: number;
  interval: number;
  dependencies?: string[];
  checks?: HealthCheckFunction[];
}

// Health check function type
type HealthCheckFunction = (service: string) => Promise<HealthCheck>;

export class HealthChecker extends EventEmitter {
  private pool: Pool;
  private redisClient: RedisClientType;
  private services: Map<string, ServiceConfig> = new Map();
  private healthChecks: Map<string, NodeJS.Timeout> = new Map();
  private isRunning: boolean = false;

  constructor(pool: Pool, redisClient: RedisClientType) {
    super();
    this.pool = pool;
    this.redisClient = redisClient;
    this.setupDefaultServices();
    this.setupEventHandlers();
  }

  // Start health checking
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Health checking is already running');
      return;
    }

    try {
      logger.info('Starting health checking');

      // Start health checks for all services
      for (const [serviceName, config] of this.services) {
        await this.startHealthCheck(serviceName, config);
      }

      this.isRunning = true;
      logger.info('Health checking started successfully');
    } catch (error) {
      logger.error('Failed to start health checking', error);
      throw error;
    }
  }

  // Stop health checking
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Health checking is not running');
      return;
    }

    try {
      logger.info('Stopping health checking');

      // Clear all health check intervals
      for (const [serviceName, interval] of this.healthChecks) {
        clearInterval(interval);
        logger.debug(`Stopped health check for ${serviceName}`);
      }

      this.healthChecks.clear();
      this.isRunning = false;
      logger.info('Health checking stopped successfully');
    } catch (error) {
      logger.error('Error stopping health checking', error);
    }
  }

  // Add service to monitor
  public addService(config: ServiceConfig): void {
    this.services.set(config.name, config);
    logger.info('Service added to health monitoring', { service: config.name });

    if (this.isRunning) {
      this.startHealthCheck(config.name, config);
    }
  }

  // Remove service from monitoring
  public removeService(serviceName: string): void {
    const interval = this.healthChecks.get(serviceName);
    if (interval) {
      clearInterval(interval);
      this.healthChecks.delete(serviceName);
    }

    this.services.delete(serviceName);
    logger.info('Service removed from health monitoring', { service: serviceName });
  }

  // Check health of specific service
  public async checkHealth(service: string): Promise<HealthCheck> {
    try {
      const config = this.services.get(service);
      if (!config) {
        throw new Error(`Service not found: ${service}`);
      }

      const startTime = Date.now();
      const healthCheck = await this.performHealthCheck(config);
      const responseTime = Date.now() - startTime;

      healthCheck.responseTime = responseTime;

      // Store health check result
      await this.storeHealthCheck(healthCheck);

      this.emit('health:checked', healthCheck);
      return healthCheck;
    } catch (error) {
      logger.error('Health check failed', { error, service });
      
      const failedCheck: HealthCheck = {
        service,
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
        responseTime: 0,
      };

      await this.storeHealthCheck(failedCheck);
      this.emit('health:checked', failedCheck);
      return failedCheck;
    }
  }

  // Get health status of all services
  public async getHealthStatus(): Promise<HealthCheck[]> {
    try {
      const result = await this.pool.query(
        `SELECT * FROM health_checks 
         WHERE timestamp >= NOW() - INTERVAL '5 minutes'
         ORDER BY timestamp DESC`
      );

      const healthChecks: HealthCheck[] = result.rows.map(row => ({
        service: row.service,
        status: row.status,
        message: row.message,
        details: row.details,
        timestamp: row.timestamp,
        responseTime: row.response_time,
        dependencies: row.dependencies,
      }));

      return healthChecks;
    } catch (error) {
      logger.error('Failed to get health status', error);
      throw error;
    }
  }

  // Get service uptime
  public async getServiceUptime(service: string, timeRange?: { start: Date; end: Date }): Promise<number> {
    try {
      let query = `
        SELECT 
          COUNT(*) as total_checks,
          COUNT(CASE WHEN status = 'healthy' THEN 1 END) as healthy_checks
        FROM health_checks 
        WHERE service = $1
      `;
      
      const params: any[] = [service];
      let paramIndex = 2;

      if (timeRange) {
        query += ` AND timestamp >= $${paramIndex++} AND timestamp <= $${paramIndex++}`;
        params.push(timeRange.start, timeRange.end);
      } else {
        query += ` AND timestamp >= NOW() - INTERVAL '24 hours'`;
      }

      const result = await this.pool.query(query, params);
      const { total_checks, healthy_checks } = result.rows[0];

      if (total_checks === 0) return 0;
      return (healthy_checks / total_checks) * 100;
    } catch (error) {
      logger.error('Failed to get service uptime', error);
      return 0;
    }
  }

  // Private methods

  private async startHealthCheck(serviceName: string, config: ServiceConfig): Promise<void> {
    const interval = setInterval(async () => {
      try {
        await this.checkHealth(serviceName);
      } catch (error) {
        logger.error('Health check interval error', { error, service: serviceName });
      }
    }, config.interval * 1000);

    this.healthChecks.set(serviceName, interval);
    logger.debug(`Started health check for ${serviceName}`, { interval: config.interval });
  }

  private async performHealthCheck(config: ServiceConfig): Promise<HealthCheck> {
    const dependencies: HealthCheck[] = [];

    // Check dependencies first
    if (config.dependencies) {
      for (const dep of config.dependencies) {
        try {
          const depConfig = this.services.get(dep);
          if (depConfig) {
            const depHealth = await this.performHealthCheck(depConfig);
            dependencies.push(depHealth);
          }
        } catch (error) {
          dependencies.push({
            service: dep,
            status: 'unhealthy',
            message: 'Dependency check failed',
            timestamp: new Date(),
          });
        }
      }
    }

    // Perform main health check
    let status: HealthStatus = 'healthy';
    let message: string | undefined;
    let details: Record<string, any> = {};

    try {
      // HTTP health check
      const response = await axios.get(`${config.url}/health`, {
        timeout: config.timeout,
        validateStatus: (status) => status < 500,
      });

      if (response.status >= 400) {
        status = 'unhealthy';
        message = `HTTP ${response.status}: ${response.statusText}`;
      } else {
        details = response.data;
      }

      // Custom health checks
      if (config.checks) {
        for (const check of config.checks) {
          try {
            const checkResult = await check(config.name);
            if (checkResult.status !== 'healthy') {
              status = 'unhealthy';
              message = checkResult.message || 'Custom health check failed';
              details.customChecks = details.customChecks || [];
              details.customChecks.push(checkResult);
            }
          } catch (error) {
            status = 'unhealthy';
            message = `Custom health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
          }
        }
      }

      // Check if any dependencies are unhealthy
      const unhealthyDeps = dependencies.filter(dep => dep.status !== 'healthy');
      if (unhealthyDeps.length > 0) {
        status = 'degraded';
        message = `Dependencies unhealthy: ${unhealthyDeps.map(dep => dep.service).join(', ')}`;
        details.unhealthyDependencies = unhealthyDeps;
      }

    } catch (error) {
      status = 'unhealthy';
      message = error instanceof Error ? error.message : 'Health check failed';
      details.error = error;
    }

    return {
      service: config.name,
      status,
      message,
      details,
      timestamp: new Date(),
      dependencies,
    };
  }

  private async storeHealthCheck(healthCheck: HealthCheck): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO health_checks (
          service, status, message, details, timestamp, response_time, dependencies
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          healthCheck.service,
          healthCheck.status,
          healthCheck.message,
          JSON.stringify(healthCheck.details),
          healthCheck.timestamp,
          healthCheck.responseTime,
          JSON.stringify(healthCheck.dependencies),
        ]
      );
    } catch (error) {
      logger.error('Failed to store health check', error);
    }
  }

  private setupDefaultServices(): void {
    // Add default services
    this.addService({
      name: 'api',
      url: 'http://localhost:3000',
      timeout: 5000,
      interval: 30,
    });

    this.addService({
      name: 'trading-engine',
      url: 'http://localhost:3001',
      timeout: 5000,
      interval: 30,
    });

    this.addService({
      name: 'analytics-engine',
      url: 'http://localhost:3003',
      timeout: 5000,
      interval: 30,
    });

    this.addService({
      name: 'webhook-system',
      url: 'http://localhost:3004',
      timeout: 5000,
      interval: 30,
    });

    this.addService({
      name: 'price-history',
      url: 'http://localhost:3005',
      timeout: 5000,
      interval: 30,
    });

    this.addService({
      name: 'data-ingestion',
      url: 'http://localhost:3006',
      timeout: 5000,
      interval: 30,
    });
  }

  private setupEventHandlers(): void {
    this.on('health:checked', (healthCheck) => {
      logger.debug('Health check completed', {
        service: healthCheck.service,
        status: healthCheck.status,
        responseTime: healthCheck.responseTime,
      });
    });

    this.on('error', (error, context) => {
      logger.error('Health checker error', { error: error.message, context });
    });
  }
}
