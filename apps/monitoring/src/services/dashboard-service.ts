// Dashboard service for monitoring system
import { EventEmitter } from 'events';
import { logger } from '@hunch/shared';
import { Pool } from 'pg';
import { RedisClientType } from 'redis';
import {
  DashboardData,
  MonitoringReport,
  HealthCheck,
  AlertInstance,
  MetricDataPoint,
} from '../types/monitoring';

export class DashboardService extends EventEmitter {
  private pool: Pool;
  private redisClient: RedisClientType;

  constructor(pool: Pool, redisClient: RedisClientType) {
    super();
    this.pool = pool;
    this.redisClient = redisClient;
  }

  // Get dashboard data
  public async getDashboardData(): Promise<DashboardData> {
    try {
      const [overview, services, alerts, metrics] = await Promise.all([
        this.getOverviewData(),
        this.getServicesData(),
        this.getAlertsData(),
        this.getMetricsData(),
      ]);

      return {
        overview,
        services,
        alerts,
        metrics,
      };
    } catch (error) {
      logger.error('Failed to get dashboard data', error);
      throw error;
    }
  }

  // Get overview statistics
  private async getOverviewData(): Promise<DashboardData['overview']> {
    try {
      const [
        totalServices,
        healthyServices,
        unhealthyServices,
        activeAlerts,
        totalMetrics,
      ] = await Promise.all([
        this.getTotalServices(),
        this.getHealthyServices(),
        this.getUnhealthyServices(),
        this.getActiveAlerts(),
        this.getTotalMetrics(),
      ]);

      return {
        totalServices,
        healthyServices,
        unhealthyServices,
        activeAlerts,
        totalMetrics,
      };
    } catch (error) {
      logger.error('Failed to get overview data', error);
      return {
        totalServices: 0,
        healthyServices: 0,
        unhealthyServices: 0,
        activeAlerts: 0,
        totalMetrics: 0,
      };
    }
  }

  // Get services data
  private async getServicesData(): Promise<DashboardData['services']> {
    try {
      const result = await this.pool.query(`
        SELECT 
          service,
          status,
          AVG(response_time) as avg_response_time,
          COUNT(*) as check_count,
          MAX(timestamp) as last_check
        FROM health_checks 
        WHERE timestamp >= NOW() - INTERVAL '1 hour'
        GROUP BY service, status
        ORDER BY service
      `);

      const services = result.rows.map(row => ({
        name: row.service,
        status: row.status,
        uptime: await this.calculateUptime(row.service),
        responseTime: parseFloat(row.avg_response_time) || 0,
        errorRate: await this.calculateErrorRate(row.service),
        lastCheck: row.last_check,
      }));

      return services;
    } catch (error) {
      logger.error('Failed to get services data', error);
      return [];
    }
  }

  // Get alerts data
  private async getAlertsData(): Promise<DashboardData['alerts']> {
    try {
      const result = await this.pool.query(`
        SELECT 
          ai.id,
          ai.title,
          ai.severity,
          ai.status,
          ai.started_at,
          ai.labels
        FROM alert_instances ai
        WHERE ai.status IN ('firing', 'acknowledged', 'silenced')
        ORDER BY ai.started_at DESC
        LIMIT 20
      `);

      return result.rows.map(row => ({
        id: row.id,
        name: row.title,
        severity: row.severity,
        status: row.status,
        startedAt: row.started_at,
        service: row.labels?.service || 'unknown',
      }));
    } catch (error) {
      logger.error('Failed to get alerts data', error);
      return [];
    }
  }

  // Get metrics data
  private async getMetricsData(): Promise<DashboardData['metrics']> {
    try {
      const result = await this.pool.query(`
        SELECT 
          metric_name,
          AVG(value) as avg_value,
          MAX(value) as max_value,
          MIN(value) as min_value
        FROM metrics 
        WHERE timestamp >= NOW() - INTERVAL '1 hour'
        GROUP BY metric_name
        ORDER BY avg_value DESC
        LIMIT 10
      `);

      return result.rows.map(row => ({
        name: row.metric_name,
        value: parseFloat(row.avg_value),
        trend: await this.calculateTrend(row.metric_name),
        change: await this.calculateChange(row.metric_name),
      }));
    } catch (error) {
      logger.error('Failed to get metrics data', error);
      return [];
    }
  }

  // Generate monitoring report
  public async generateReport(
    type: 'daily' | 'weekly' | 'monthly',
    startDate: Date,
    endDate: Date
  ): Promise<MonitoringReport> {
    try {
      const report: MonitoringReport = {
        id: `report-${type}-${startDate.toISOString().split('T')[0]}`,
        type,
        period: { start: startDate, end: endDate },
        summary: await this.generateReportSummary(startDate, endDate),
        services: await this.generateServicesReport(startDate, endDate),
        alerts: await this.generateAlertsReport(startDate, endDate),
        metrics: await this.generateMetricsReport(startDate, endDate),
        recommendations: await this.generateRecommendations(startDate, endDate),
        createdAt: new Date(),
      };

      // Store report in database
      await this.storeReport(report);

      return report;
    } catch (error) {
      logger.error('Failed to generate monitoring report', error);
      throw error;
    }
  }

  // Get monitoring reports
  public async getReports(
    type?: 'daily' | 'weekly' | 'monthly',
    limit: number = 10
  ): Promise<MonitoringReport[]> {
    try {
      let query = 'SELECT * FROM monitoring_reports WHERE 1=1';
      const params: any[] = [];
      let paramIndex = 1;

      if (type) {
        query += ` AND type = $${paramIndex++}`;
        params.push(type);
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIndex++}`;
      params.push(limit);

      const result = await this.pool.query(query, params);
      return result.rows.map(row => this.mapRowToReport(row));
    } catch (error) {
      logger.error('Failed to get monitoring reports', error);
      throw error;
    }
  }

  // Private helper methods

  private async getTotalServices(): Promise<number> {
    const result = await this.pool.query(`
      SELECT COUNT(DISTINCT service) as count 
      FROM health_checks 
      WHERE timestamp >= NOW() - INTERVAL '1 hour'
    `);
    return parseInt(result.rows[0].count);
  }

  private async getHealthyServices(): Promise<number> {
    const result = await this.pool.query(`
      SELECT COUNT(DISTINCT service) as count 
      FROM health_checks 
      WHERE status = 'healthy' 
        AND timestamp >= NOW() - INTERVAL '1 hour'
    `);
    return parseInt(result.rows[0].count);
  }

  private async getUnhealthyServices(): Promise<number> {
    const result = await this.pool.query(`
      SELECT COUNT(DISTINCT service) as count 
      FROM health_checks 
      WHERE status != 'healthy' 
        AND timestamp >= NOW() - INTERVAL '1 hour'
    `);
    return parseInt(result.rows[0].count);
  }

  private async getActiveAlerts(): Promise<number> {
    const result = await this.pool.query(`
      SELECT COUNT(*) as count 
      FROM alert_instances 
      WHERE status IN ('firing', 'acknowledged', 'silenced')
    `);
    return parseInt(result.rows[0].count);
  }

  private async getTotalMetrics(): Promise<number> {
    const result = await this.pool.query(`
      SELECT COUNT(*) as count 
      FROM metrics 
      WHERE timestamp >= NOW() - INTERVAL '1 hour'
    `);
    return parseInt(result.rows[0].count);
  }

  private async calculateUptime(service: string): Promise<number> {
    try {
      const result = await this.pool.query(`
        SELECT 
          COUNT(*) as total_checks,
          COUNT(CASE WHEN status = 'healthy' THEN 1 END) as healthy_checks
        FROM health_checks 
        WHERE service = $1 
          AND timestamp >= NOW() - INTERVAL '24 hours'
      `, [service]);

      const { total_checks, healthy_checks } = result.rows[0];
      if (total_checks === 0) return 0;
      return (healthy_checks / total_checks) * 100;
    } catch (error) {
      logger.error('Failed to calculate uptime', { error, service });
      return 0;
    }
  }

  private async calculateErrorRate(service: string): Promise<number> {
    try {
      const result = await this.pool.query(`
        SELECT 
          COUNT(*) as total_requests,
          COUNT(CASE WHEN error_count > 0 THEN 1 END) as error_requests
        FROM service_metrics 
        WHERE service = $1 
          AND timestamp >= NOW() - INTERVAL '1 hour'
      `, [service]);

      const { total_requests, error_requests } = result.rows[0];
      if (total_requests === 0) return 0;
      return (error_requests / total_requests) * 100;
    } catch (error) {
      logger.error('Failed to calculate error rate', { error, service });
      return 0;
    }
  }

  private async calculateTrend(metricName: string): Promise<'up' | 'down' | 'stable'> {
    try {
      const result = await this.pool.query(`
        SELECT 
          AVG(CASE WHEN timestamp >= NOW() - INTERVAL '30 minutes' THEN value END) as recent_avg,
          AVG(CASE WHEN timestamp >= NOW() - INTERVAL '60 minutes' AND timestamp < NOW() - INTERVAL '30 minutes' THEN value END) as previous_avg
        FROM metrics 
        WHERE metric_name = $1
          AND timestamp >= NOW() - INTERVAL '1 hour'
      `, [metricName]);

      const { recent_avg, previous_avg } = result.rows[0];
      if (!recent_avg || !previous_avg) return 'stable';

      const change = ((recent_avg - previous_avg) / previous_avg) * 100;
      if (change > 5) return 'up';
      if (change < -5) return 'down';
      return 'stable';
    } catch (error) {
      logger.error('Failed to calculate trend', { error, metricName });
      return 'stable';
    }
  }

  private async calculateChange(metricName: string): Promise<number> {
    try {
      const result = await this.pool.query(`
        SELECT 
          AVG(CASE WHEN timestamp >= NOW() - INTERVAL '30 minutes' THEN value END) as recent_avg,
          AVG(CASE WHEN timestamp >= NOW() - INTERVAL '60 minutes' AND timestamp < NOW() - INTERVAL '30 minutes' THEN value END) as previous_avg
        FROM metrics 
        WHERE metric_name = $1
          AND timestamp >= NOW() - INTERVAL '1 hour'
      `, [metricName]);

      const { recent_avg, previous_avg } = result.rows[0];
      if (!recent_avg || !previous_avg) return 0;

      return ((recent_avg - previous_avg) / previous_avg) * 100;
    } catch (error) {
      logger.error('Failed to calculate change', { error, metricName });
      return 0;
    }
  }

  private async generateReportSummary(startDate: Date, endDate: Date): Promise<MonitoringReport['summary']> {
    try {
      const result = await this.pool.query(`
        SELECT 
          COUNT(DISTINCT ai.id) as total_alerts,
          COUNT(DISTINCT CASE WHEN ai.status = 'resolved' THEN ai.id END) as resolved_alerts,
          AVG(sm.response_time) as avg_response_time,
          AVG(CASE WHEN hc.status = 'healthy' THEN 1 ELSE 0 END) * 100 as uptime,
          AVG(sm.error_rate) as error_rate
        FROM alert_instances ai
        LEFT JOIN service_metrics sm ON sm.timestamp BETWEEN $1 AND $2
        LEFT JOIN health_checks hc ON hc.timestamp BETWEEN $1 AND $2
        WHERE ai.started_at BETWEEN $1 AND $2
      `, [startDate, endDate]);

      const row = result.rows[0];
      return {
        totalAlerts: parseInt(row.total_alerts) || 0,
        resolvedAlerts: parseInt(row.resolved_alerts) || 0,
        averageResponseTime: parseFloat(row.avg_response_time) || 0,
        uptime: parseFloat(row.uptime) || 0,
        errorRate: parseFloat(row.error_rate) || 0,
      };
    } catch (error) {
      logger.error('Failed to generate report summary', error);
      return {
        totalAlerts: 0,
        resolvedAlerts: 0,
        averageResponseTime: 0,
        uptime: 0,
        errorRate: 0,
      };
    }
  }

  private async generateServicesReport(startDate: Date, endDate: Date): Promise<MonitoringReport['services']> {
    try {
      const result = await this.pool.query(`
        SELECT 
          service,
          AVG(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) * 100 as uptime,
          COUNT(DISTINCT ai.id) as alerts,
          AVG(error_count) as errors,
          AVG(response_time) as performance
        FROM health_checks hc
        LEFT JOIN alert_instances ai ON ai.labels->>'service' = hc.service 
          AND ai.started_at BETWEEN $1 AND $2
        WHERE hc.timestamp BETWEEN $1 AND $2
        GROUP BY service
      `, [startDate, endDate]);

      return result.rows.map(row => ({
        name: row.service,
        uptime: parseFloat(row.uptime) || 0,
        alerts: parseInt(row.alerts) || 0,
        errors: parseFloat(row.errors) || 0,
        performance: parseFloat(row.performance) || 0,
      }));
    } catch (error) {
      logger.error('Failed to generate services report', error);
      return [];
    }
  }

  private async generateAlertsReport(startDate: Date, endDate: Date): Promise<MonitoringReport['alerts']> {
    try {
      const result = await this.pool.query(`
        SELECT 
          ad.name,
          COUNT(ai.id) as count,
          ad.severity,
          AVG(EXTRACT(EPOCH FROM (ai.resolved_at - ai.started_at))) as avg_resolution_time
        FROM alert_definitions ad
        LEFT JOIN alert_instances ai ON ai.alert_id = ad.id 
          AND ai.started_at BETWEEN $1 AND $2
        GROUP BY ad.id, ad.name, ad.severity
        HAVING COUNT(ai.id) > 0
        ORDER BY count DESC
      `, [startDate, endDate]);

      return result.rows.map(row => ({
        name: row.name,
        count: parseInt(row.count),
        severity: row.severity,
        averageResolutionTime: parseFloat(row.avg_resolution_time) || 0,
      }));
    } catch (error) {
      logger.error('Failed to generate alerts report', error);
      return [];
    }
  }

  private async generateMetricsReport(startDate: Date, endDate: Date): Promise<MonitoringReport['metrics']> {
    try {
      const result = await this.pool.query(`
        SELECT 
          metric_name,
          AVG(value) as average,
          MIN(value) as min,
          MAX(value) as max,
          CASE 
            WHEN AVG(CASE WHEN timestamp >= $2 - INTERVAL '1 day' THEN value END) > 
                 AVG(CASE WHEN timestamp < $2 - INTERVAL '1 day' THEN value END) THEN 'up'
            WHEN AVG(CASE WHEN timestamp >= $2 - INTERVAL '1 day' THEN value END) < 
                 AVG(CASE WHEN timestamp < $2 - INTERVAL '1 day' THEN value END) THEN 'down'
            ELSE 'stable'
          END as trend
        FROM metrics 
        WHERE timestamp BETWEEN $1 AND $2
        GROUP BY metric_name
        ORDER BY average DESC
        LIMIT 20
      `, [startDate, endDate]);

      return result.rows.map(row => ({
        name: row.metric_name,
        average: parseFloat(row.average),
        min: parseFloat(row.min),
        max: parseFloat(row.max),
        trend: row.trend,
      }));
    } catch (error) {
      logger.error('Failed to generate metrics report', error);
      return [];
    }
  }

  private async generateRecommendations(startDate: Date, endDate: Date): Promise<string[]> {
    const recommendations: string[] = [];

    try {
      // Check for high error rates
      const errorRateResult = await this.pool.query(`
        SELECT service, AVG(error_rate) as avg_error_rate
        FROM service_metrics 
        WHERE timestamp BETWEEN $1 AND $2
        GROUP BY service
        HAVING AVG(error_rate) > 5
      `, [startDate, endDate]);

      if (errorRateResult.rows.length > 0) {
        recommendations.push(`High error rates detected for services: ${errorRateResult.rows.map(r => r.service).join(', ')}`);
      }

      // Check for slow response times
      const responseTimeResult = await this.pool.query(`
        SELECT service, AVG(response_time) as avg_response_time
        FROM service_metrics 
        WHERE timestamp BETWEEN $1 AND $2
        GROUP BY service
        HAVING AVG(response_time) > 2000
      `, [startDate, endDate]);

      if (responseTimeResult.rows.length > 0) {
        recommendations.push(`Slow response times detected for services: ${responseTimeResult.rows.map(r => r.service).join(', ')}`);
      }

      // Check for frequent alerts
      const alertResult = await this.pool.query(`
        SELECT ad.name, COUNT(ai.id) as alert_count
        FROM alert_definitions ad
        LEFT JOIN alert_instances ai ON ai.alert_id = ad.id 
          AND ai.started_at BETWEEN $1 AND $2
        GROUP BY ad.id, ad.name
        HAVING COUNT(ai.id) > 10
      `, [startDate, endDate]);

      if (alertResult.rows.length > 0) {
        recommendations.push(`Frequent alerts detected: ${alertResult.rows.map(r => r.name).join(', ')}`);
      }

      // Check for low uptime
      const uptimeResult = await this.pool.query(`
        SELECT service, AVG(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) * 100 as uptime
        FROM health_checks 
        WHERE timestamp BETWEEN $1 AND $2
        GROUP BY service
        HAVING AVG(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) * 100 < 95
      `, [startDate, endDate]);

      if (uptimeResult.rows.length > 0) {
        recommendations.push(`Low uptime detected for services: ${uptimeResult.rows.map(r => r.service).join(', ')}`);
      }

    } catch (error) {
      logger.error('Failed to generate recommendations', error);
    }

    return recommendations;
  }

  private async storeReport(report: MonitoringReport): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO monitoring_reports (
          id, type, period_start, period_end, summary, services, alerts, metrics, recommendations, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          report.id,
          report.type,
          report.period.start,
          report.period.end,
          JSON.stringify(report.summary),
          JSON.stringify(report.services),
          JSON.stringify(report.alerts),
          JSON.stringify(report.metrics),
          JSON.stringify(report.recommendations),
          report.createdAt,
        ]
      );
    } catch (error) {
      logger.error('Failed to store monitoring report', error);
    }
  }

  private mapRowToReport(row: any): MonitoringReport {
    return {
      id: row.id,
      type: row.type,
      period: {
        start: row.period_start,
        end: row.period_end,
      },
      summary: row.summary,
      services: row.services,
      alerts: row.alerts,
      metrics: row.metrics,
      recommendations: row.recommendations,
      createdAt: row.created_at,
    };
  }
}
