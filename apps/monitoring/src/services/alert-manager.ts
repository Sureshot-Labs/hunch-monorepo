// Alert management service for monitoring system
import { EventEmitter } from 'events';
import { logger } from '@hunch/shared';
import { Pool } from 'pg';
import { RedisClientType } from 'redis';
import { v4 as uuid } from 'uuid';
import {
  AlertDefinition,
  AlertInstance,
  AlertCondition,
  AlertAction,
  AlertSeverity,
  AlertStatus,
  MonitoringEvents,
} from '../types/monitoring';

export class AlertManager extends EventEmitter {
  private pool: Pool;
  private redisClient: RedisClientType;
  private alerts: Map<string, AlertDefinition> = new Map();
  private alertInstances: Map<string, AlertInstance> = new Map();
  private evaluationInterval?: NodeJS.Timeout;
  private isRunning: boolean = false;

  constructor(pool: Pool, redisClient: RedisClientType) {
    super();
    this.pool = pool;
    this.redisClient = redisClient;
    this.setupEventHandlers();
  }

  // Start alert evaluation
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Alert manager is already running');
      return;
    }

    try {
      logger.info('Starting alert manager');

      // Load alerts from database
      await this.loadAlerts();

      // Start evaluation loop
      this.evaluationInterval = setInterval(() => {
        this.evaluateAlerts().catch(error => {
          logger.error('Alert evaluation error', error);
        });
      }, 10000); // Evaluate every 10 seconds

      this.isRunning = true;
      logger.info('Alert manager started successfully');
    } catch (error) {
      logger.error('Failed to start alert manager', error);
      throw error;
    }
  }

  // Stop alert evaluation
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Alert manager is not running');
      return;
    }

    try {
      logger.info('Stopping alert manager');

      if (this.evaluationInterval) {
        clearInterval(this.evaluationInterval);
        this.evaluationInterval = undefined;
      }

      this.isRunning = false;
      logger.info('Alert manager stopped successfully');
    } catch (error) {
      logger.error('Error stopping alert manager', error);
    }
  }

  // Create alert definition
  public async createAlert(alert: AlertDefinition): Promise<void> {
    try {
      // Validate alert definition
      this.validateAlertDefinition(alert);

      // Store in database
      await this.storeAlertDefinition(alert);

      // Add to memory
      this.alerts.set(alert.id, alert);

      logger.info('Alert created', { alertId: alert.id, name: alert.name });
    } catch (error) {
      logger.error('Failed to create alert', { error, alert });
      throw error;
    }
  }

  // Update alert definition
  public async updateAlert(alertId: string, updates: Partial<AlertDefinition>): Promise<void> {
    try {
      const existingAlert = this.alerts.get(alertId);
      if (!existingAlert) {
        throw new Error(`Alert not found: ${alertId}`);
      }

      const updatedAlert = { ...existingAlert, ...updates };
      
      // Validate updated alert
      this.validateAlertDefinition(updatedAlert);

      // Update in database
      await this.updateAlertDefinition(alertId, updates);

      // Update in memory
      this.alerts.set(alertId, updatedAlert);

      logger.info('Alert updated', { alertId, updates });
    } catch (error) {
      logger.error('Failed to update alert', { error, alertId, updates });
      throw error;
    }
  }

  // Delete alert definition
  public async deleteAlert(alertId: string): Promise<void> {
    try {
      // Remove from database
      await this.deleteAlertDefinition(alertId);

      // Remove from memory
      this.alerts.delete(alertId);

      // Resolve any active instances
      const activeInstances = Array.from(this.alertInstances.values())
        .filter(instance => instance.alertId === alertId && instance.status === 'firing');

      for (const instance of activeInstances) {
        await this.resolveAlert(instance.id, 'Alert definition deleted');
      }

      logger.info('Alert deleted', { alertId });
    } catch (error) {
      logger.error('Failed to delete alert', { error, alertId });
      throw error;
    }
  }

  // Acknowledge alert
  public async acknowledgeAlert(alertId: string, userId: string): Promise<void> {
    try {
      const instance = this.alertInstances.get(alertId);
      if (!instance) {
        throw new Error(`Alert instance not found: ${alertId}`);
      }

      instance.status = 'acknowledged';
      instance.acknowledgedAt = new Date();
      instance.acknowledgedBy = userId;

      // Update in database
      await this.updateAlertInstance(instance);

      logger.info('Alert acknowledged', { alertId, userId });
    } catch (error) {
      logger.error('Failed to acknowledge alert', { error, alertId, userId });
      throw error;
    }
  }

  // Silence alert
  public async silenceAlert(alertId: string, userId: string, duration: number): Promise<void> {
    try {
      const instance = this.alertInstances.get(alertId);
      if (!instance) {
        throw new Error(`Alert instance not found: ${alertId}`);
      }

      instance.status = 'silenced';
      instance.silencedUntil = new Date(Date.now() + duration * 60 * 1000); // duration in minutes
      instance.silencedBy = userId;

      // Update in database
      await this.updateAlertInstance(instance);

      logger.info('Alert silenced', { alertId, userId, duration });
    } catch (error) {
      logger.error('Failed to silence alert', { error, alertId, userId, duration });
      throw error;
    }
  }

  // Get alerts
  public async getAlerts(status?: AlertStatus, severity?: AlertSeverity): Promise<AlertInstance[]> {
    try {
      let query = 'SELECT * FROM alert_instances WHERE 1=1';
      const params: any[] = [];
      let paramIndex = 1;

      if (status) {
        query += ` AND status = $${paramIndex++}`;
        params.push(status);
      }

      if (severity) {
        query += ` AND severity = $${paramIndex++}`;
        params.push(severity);
      }

      query += ' ORDER BY started_at DESC LIMIT 100';

      const result = await this.pool.query(query, params);
      return result.rows.map(row => this.mapRowToAlertInstance(row));
    } catch (error) {
      logger.error('Failed to get alerts', error);
      throw error;
    }
  }

  // Get alert statistics
  public async getStats(): Promise<{
    totalAlerts: number;
    activeAlerts: number;
    acknowledgedAlerts: number;
    silencedAlerts: number;
    resolvedAlerts: number;
  }> {
    try {
      const result = await this.pool.query(`
        SELECT 
          COUNT(*) as total_alerts,
          COUNT(CASE WHEN status = 'firing' THEN 1 END) as active_alerts,
          COUNT(CASE WHEN status = 'acknowledged' THEN 1 END) as acknowledged_alerts,
          COUNT(CASE WHEN status = 'silenced' THEN 1 END) as silenced_alerts,
          COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved_alerts
        FROM alert_instances
        WHERE started_at >= NOW() - INTERVAL '24 hours'
      `);

      const stats = result.rows[0];
      return {
        totalAlerts: parseInt(stats.total_alerts),
        activeAlerts: parseInt(stats.active_alerts),
        acknowledgedAlerts: parseInt(stats.acknowledged_alerts),
        silencedAlerts: parseInt(stats.silenced_alerts),
        resolvedAlerts: parseInt(stats.resolved_alerts),
      };
    } catch (error) {
      logger.error('Failed to get alert statistics', error);
      throw error;
    }
  }

  // Private methods

  private async evaluateAlerts(): Promise<void> {
    try {
      for (const [alertId, alert] of this.alerts) {
        if (!alert.enabled) continue;

        try {
          const shouldFire = await this.evaluateAlertConditions(alert);
          const existingInstance = this.getActiveAlertInstance(alertId);

          if (shouldFire && !existingInstance) {
            // Fire new alert
            await this.fireAlert(alert);
          } else if (!shouldFire && existingInstance) {
            // Resolve existing alert
            await this.resolveAlert(existingInstance.id, 'Conditions no longer met');
          }
        } catch (error) {
          logger.error('Error evaluating alert', { error, alertId });
        }
      }
    } catch (error) {
      logger.error('Error in alert evaluation loop', error);
    }
  }

  private async evaluateAlertConditions(alert: AlertDefinition): Promise<boolean> {
    try {
      for (const condition of alert.conditions) {
        const conditionMet = await this.evaluateCondition(condition);
        if (!conditionMet) {
          return false;
        }
      }
      return true;
    } catch (error) {
      logger.error('Error evaluating alert conditions', { error, alertId: alert.id });
      return false;
    }
  }

  private async evaluateCondition(condition: AlertCondition): Promise<boolean> {
    try {
      // Get current metric value
      const metricValue = await this.getMetricValue(condition.metric, condition.labels);
      if (metricValue === null) {
        return false;
      }

      // Evaluate condition
      switch (condition.operator) {
        case 'gt':
          return metricValue > condition.threshold;
        case 'lt':
          return metricValue < condition.threshold;
        case 'eq':
          return metricValue === condition.threshold;
        case 'ne':
          return metricValue !== condition.threshold;
        case 'gte':
          return metricValue >= condition.threshold;
        case 'lte':
          return metricValue <= condition.threshold;
        default:
          logger.error('Unknown operator', { operator: condition.operator });
          return false;
      }
    } catch (error) {
      logger.error('Error evaluating condition', { error, condition });
      return false;
    }
  }

  private async getMetricValue(metric: string, labels?: Record<string, string>): Promise<number | null> {
    try {
      // This would typically query your metrics store
      // For now, we'll simulate metric values
      const simulatedValues: Record<string, number> = {
        'system_cpu_usage_percent': Math.random() * 100,
        'system_memory_usage_bytes': Math.random() * 1024 * 1024 * 1024,
        'http_requests_total': Math.random() * 1000,
        'http_request_duration_seconds': Math.random() * 5,
        'database_connections': Math.random() * 100,
        'redis_memory_usage_bytes': Math.random() * 100 * 1024 * 1024,
      };

      return simulatedValues[metric] || null;
    } catch (error) {
      logger.error('Error getting metric value', { error, metric, labels });
      return null;
    }
  }

  private async fireAlert(alert: AlertDefinition): Promise<void> {
    try {
      const instance: AlertInstance = {
        id: uuid(),
        alertId: alert.id,
        status: 'firing',
        severity: alert.severity,
        title: alert.name,
        description: alert.description,
        labels: alert.labels || {},
        annotations: alert.annotations || {},
        startedAt: new Date(),
        evaluationTime: new Date(),
      };

      // Store in database
      await this.storeAlertInstance(instance);

      // Add to memory
      this.alertInstances.set(instance.id, instance);

      // Execute alert actions
      await this.executeAlertActions(alert, instance);

      this.emit('alert:fired', instance);
      logger.info('Alert fired', { alertId: alert.id, instanceId: instance.id });
    } catch (error) {
      logger.error('Failed to fire alert', { error, alert });
    }
  }

  private async resolveAlert(instanceId: string, reason: string): Promise<void> {
    try {
      const instance = this.alertInstances.get(instanceId);
      if (!instance) {
        logger.warn('Alert instance not found for resolution', { instanceId });
        return;
      }

      instance.status = 'resolved';
      instance.resolvedAt = new Date();

      // Update in database
      await this.updateAlertInstance(instance);

      // Remove from memory
      this.alertInstances.delete(instanceId);

      this.emit('alert:resolved', instance);
      logger.info('Alert resolved', { instanceId, reason });
    } catch (error) {
      logger.error('Failed to resolve alert', { error, instanceId, reason });
    }
  }

  private async executeAlertActions(alert: AlertDefinition, instance: AlertInstance): Promise<void> {
    try {
      for (const action of alert.actions) {
        if (!action.enabled) continue;

        try {
          await this.executeAction(action, instance);
        } catch (error) {
          logger.error('Failed to execute alert action', { error, action, instance });
        }
      }
    } catch (error) {
      logger.error('Failed to execute alert actions', { error, alert, instance });
    }
  }

  private async executeAction(action: AlertAction, instance: AlertInstance): Promise<void> {
    try {
      switch (action.type) {
        case 'email':
          await this.sendEmailNotification(action.config, instance);
          break;
        case 'webhook':
          await this.sendWebhookNotification(action.config, instance);
          break;
        case 'slack':
          await this.sendSlackNotification(action.config, instance);
          break;
        case 'pagerduty':
          await this.sendPagerDutyNotification(action.config, instance);
          break;
        case 'sms':
          await this.sendSMSNotification(action.config, instance);
          break;
        default:
          logger.error('Unknown action type', { type: action.type });
      }
    } catch (error) {
      logger.error('Failed to execute action', { error, action, instance });
    }
  }

  private async sendEmailNotification(config: Record<string, any>, instance: AlertInstance): Promise<void> {
    // Email notification implementation
    logger.info('Sending email notification', { instanceId: instance.id, config });
  }

  private async sendWebhookNotification(config: Record<string, any>, instance: AlertInstance): Promise<void> {
    // Webhook notification implementation
    logger.info('Sending webhook notification', { instanceId: instance.id, config });
  }

  private async sendSlackNotification(config: Record<string, any>, instance: AlertInstance): Promise<void> {
    // Slack notification implementation
    logger.info('Sending Slack notification', { instanceId: instance.id, config });
  }

  private async sendPagerDutyNotification(config: Record<string, any>, instance: AlertInstance): Promise<void> {
    // PagerDuty notification implementation
    logger.info('Sending PagerDuty notification', { instanceId: instance.id, config });
  }

  private async sendSMSNotification(config: Record<string, any>, instance: AlertInstance): Promise<void> {
    // SMS notification implementation
    logger.info('Sending SMS notification', { instanceId: instance.id, config });
  }

  private getActiveAlertInstance(alertId: string): AlertInstance | undefined {
    return Array.from(this.alertInstances.values())
      .find(instance => instance.alertId === alertId && instance.status === 'firing');
  }

  private validateAlertDefinition(alert: AlertDefinition): void {
    if (!alert.id || !alert.name || !alert.description) {
      throw new Error('Alert must have id, name, and description');
    }

    if (!alert.conditions || alert.conditions.length === 0) {
      throw new Error('Alert must have at least one condition');
    }

    if (!alert.actions || alert.actions.length === 0) {
      throw new Error('Alert must have at least one action');
    }

    for (const condition of alert.conditions) {
      if (!condition.metric || !condition.operator || condition.threshold === undefined) {
        throw new Error('Alert condition must have metric, operator, and threshold');
      }
    }

    for (const action of alert.actions) {
      if (!action.type || !action.config) {
        throw new Error('Alert action must have type and config');
      }
    }
  }

  private async loadAlerts(): Promise<void> {
    try {
      const result = await this.pool.query('SELECT * FROM alert_definitions WHERE enabled = true');
      
      for (const row of result.rows) {
        const alert: AlertDefinition = {
          id: row.id,
          name: row.name,
          description: row.description,
          severity: row.severity,
          enabled: row.enabled,
          conditions: row.conditions,
          actions: row.actions,
          cooldownPeriod: row.cooldown_period,
          evaluationInterval: row.evaluation_interval,
          labels: row.labels,
          annotations: row.annotations,
        };

        this.alerts.set(alert.id, alert);
      }

      logger.info('Loaded alerts from database', { count: this.alerts.size });
    } catch (error) {
      logger.error('Failed to load alerts from database', error);
      throw error;
    }
  }

  private async storeAlertDefinition(alert: AlertDefinition): Promise<void> {
    await this.pool.query(
      `INSERT INTO alert_definitions (
        id, name, description, severity, enabled, conditions, actions,
        cooldown_period, evaluation_interval, labels, annotations
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        alert.id,
        alert.name,
        alert.description,
        alert.severity,
        alert.enabled,
        JSON.stringify(alert.conditions),
        JSON.stringify(alert.actions),
        alert.cooldownPeriod,
        alert.evaluationInterval,
        JSON.stringify(alert.labels),
        JSON.stringify(alert.annotations),
      ]
    );
  }

  private async updateAlertDefinition(alertId: string, updates: Partial<AlertDefinition>): Promise<void> {
    const setClause = Object.keys(updates)
      .map((key, index) => `${key} = $${index + 2}`)
      .join(', ');

    const values = Object.values(updates);
    await this.pool.query(
      `UPDATE alert_definitions SET ${setClause} WHERE id = $1`,
      [alertId, ...values]
    );
  }

  private async deleteAlertDefinition(alertId: string): Promise<void> {
    await this.pool.query('DELETE FROM alert_definitions WHERE id = $1', [alertId]);
  }

  private async storeAlertInstance(instance: AlertInstance): Promise<void> {
    await this.pool.query(
      `INSERT INTO alert_instances (
        id, alert_id, status, severity, title, description, labels, annotations,
        started_at, resolved_at, acknowledged_at, acknowledged_by, silenced_until,
        silenced_by, evaluation_time, value, threshold
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        instance.id,
        instance.alertId,
        instance.status,
        instance.severity,
        instance.title,
        instance.description,
        JSON.stringify(instance.labels),
        JSON.stringify(instance.annotations),
        instance.startedAt,
        instance.resolvedAt,
        instance.acknowledgedAt,
        instance.acknowledgedBy,
        instance.silencedUntil,
        instance.silencedBy,
        instance.evaluationTime,
        instance.value,
        instance.threshold,
      ]
    );
  }

  private async updateAlertInstance(instance: AlertInstance): Promise<void> {
    await this.pool.query(
      `UPDATE alert_instances SET 
        status = $2, resolved_at = $3, acknowledged_at = $4, acknowledged_by = $5,
        silenced_until = $6, silenced_by = $7
      WHERE id = $1`,
      [
        instance.id,
        instance.status,
        instance.resolvedAt,
        instance.acknowledgedAt,
        instance.acknowledgedBy,
        instance.silencedUntil,
        instance.silencedBy,
      ]
    );
  }

  private mapRowToAlertInstance(row: any): AlertInstance {
    return {
      id: row.id,
      alertId: row.alert_id,
      status: row.status,
      severity: row.severity,
      title: row.title,
      description: row.description,
      labels: row.labels,
      annotations: row.annotations,
      startedAt: row.started_at,
      resolvedAt: row.resolved_at,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedBy: row.acknowledged_by,
      silencedUntil: row.silenced_until,
      silencedBy: row.silenced_by,
      evaluationTime: row.evaluation_time,
      value: row.value,
      threshold: row.threshold,
    };
  }

  private setupEventHandlers(): void {
    this.on('alert:fired', (instance) => {
      logger.info('Alert fired', { instanceId: instance.id, alertId: instance.alertId });
    });

    this.on('alert:resolved', (instance) => {
      logger.info('Alert resolved', { instanceId: instance.id, alertId: instance.alertId });
    });

    this.on('error', (error, context) => {
      logger.error('Alert manager error', { error: error.message, context });
    });
  }
}
