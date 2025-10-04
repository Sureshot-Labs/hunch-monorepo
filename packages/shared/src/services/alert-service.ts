// Alert service for large orders and other critical events
import { Pool } from 'pg';
import { Redis } from 'ioredis';

export interface OrderAlert {
  orderId: string;
  userId: string;
  venue: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  price?: number;
  sizeUsd: number;
  timestamp: Date;
  reason: string;
}

export interface AlertConfig {
  largeOrderThreshold: number; // USD
  emailRecipients?: string[];
  slackWebhookUrl?: string;
  enableEmail?: boolean;
  enableSlack?: boolean;
  enableLogging?: boolean;
}

export interface AlertRecord {
  id?: string;
  alert_type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  message: string;
  metadata: any;
  created_at?: Date;
}

export class AlertService {
  private pool: Pool;
  private redis: Redis;
  private config: AlertConfig;

  constructor(pool: Pool, redis: Redis, config: AlertConfig) {
    this.pool = pool;
    this.redis = redis;
    this.config = config;
  }

  /**
   * Check if order exceeds threshold and send alert
   */
  async checkOrderSizeAndAlert(order: OrderAlert): Promise<void> {
    if (order.sizeUsd >= this.config.largeOrderThreshold) {
      await this.sendLargeOrderAlert(order);
    }
  }

  /**
   * Send alert for large order
   */
  private async sendLargeOrderAlert(order: OrderAlert): Promise<void> {
    const severity = order.sizeUsd >= 50000 ? 'CRITICAL' : 'WARNING';
    const title = `Large Order Alert: $${order.sizeUsd.toLocaleString()}`;
    const message = this.formatLargeOrderMessage(order);

    // Store in database
    await this.storeAlert({
      alert_type: 'LARGE_ORDER',
      severity,
      title,
      message,
      metadata: order,
    });

    // Log to console
    if (this.config.enableLogging !== false) {
      console.warn(`[ALERT] ${title}`);
      console.warn(`[ALERT] ${message}`);
    }

    // Send email if configured
    if (this.config.enableEmail && this.config.emailRecipients?.length) {
      await this.sendEmailAlert(title, message, severity, order);
    }

    // Send Slack notification if configured
    if (this.config.enableSlack && this.config.slackWebhookUrl) {
      await this.sendSlackAlert(title, message, severity, order);
    }

    // Publish to Redis for real-time monitoring
    await this.publishAlertToRedis('large_order', order);
  }

  /**
   * Format large order alert message
   */
  private formatLargeOrderMessage(order: OrderAlert): string {
    return `
Large Order Detected:
- Order ID: ${order.orderId}
- User ID: ${order.userId}
- Venue: ${order.venue}
- Market: ${order.tokenId}
- Side: ${order.side}
- Type: ${order.orderType}
- Size: $${order.sizeUsd.toLocaleString()}
${order.price ? `- Price: ${order.price}` : ''}
- Timestamp: ${order.timestamp.toISOString()}
- Reason: ${order.reason}
    `.trim();
  }

  /**
   * Send email alert (placeholder - integrate with your email service)
   */
  private async sendEmailAlert(
    title: string,
    message: string,
    severity: string,
    metadata: any
  ): Promise<void> {
    // TODO: Integrate with email service (SendGrid, AWS SES, etc.)
    // For now, just log that we would send an email
    console.log(`[EMAIL ALERT] Would send email to ${this.config.emailRecipients?.join(', ')}`);
    console.log(`[EMAIL ALERT] Subject: ${title}`);
    console.log(`[EMAIL ALERT] Body: ${message}`);

    // Store email send attempt
    await this.pool.query(
      `INSERT INTO alert_delivery_log (alert_type, delivery_method, recipient, status, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      ['LARGE_ORDER', 'email', this.config.emailRecipients?.join(','), 'pending']
    ).catch(() => {
      // Ignore if table doesn't exist yet
    });
  }

  /**
   * Send Slack alert
   */
  private async sendSlackAlert(
    title: string,
    message: string,
    severity: string,
    metadata: any
  ): Promise<void> {
    if (!this.config.slackWebhookUrl) return;

    try {
      const color = severity === 'CRITICAL' ? '#FF0000' : '#FFA500';
      const payload = {
        attachments: [
          {
            color,
            title,
            text: message,
            fields: [
              { title: 'Severity', value: severity, short: true },
              { title: 'Timestamp', value: new Date().toISOString(), short: true },
            ],
            footer: 'Hunch Trading Alert System',
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      };

      const response = await fetch(this.config.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(`Failed to send Slack alert: ${response.statusText}`);
      }

      // Store delivery attempt
      await this.pool.query(
        `INSERT INTO alert_delivery_log (alert_type, delivery_method, recipient, status, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        ['LARGE_ORDER', 'slack', this.config.slackWebhookUrl, response.ok ? 'success' : 'failed']
      ).catch(() => {});
    } catch (error) {
      console.error('Error sending Slack alert:', error);
    }
  }

  /**
   * Store alert in database for audit trail
   */
  private async storeAlert(alert: AlertRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO alerts (alert_type, severity, title, message, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          alert.alert_type,
          alert.severity,
          alert.title,
          alert.message,
          JSON.stringify(alert.metadata),
        ]
      );
    } catch (error) {
      // If table doesn't exist, just log to console
      console.warn('Could not store alert in database (table may not exist):', error);
    }
  }

  /**
   * Publish alert to Redis for real-time monitoring
   */
  private async publishAlertToRedis(channel: string, data: any): Promise<void> {
    await this.redis.publish(`alerts:${channel}`, JSON.stringify(data));
  }

  /**
   * Subscribe to alerts
   */
  async subscribeToAlerts(
    channel: string,
    callback: (data: any) => void
  ): Promise<void> {
    const subscriber = this.redis.duplicate();
    await subscriber.connect();

    await subscriber.subscribe(`alerts:${channel}`, (err: Error | null | undefined, message: unknown) => {
      try {
        const data = JSON.parse(message as string);
        callback(data);
      } catch (error) {
        console.error('Failed to parse alert message:', error);
      }
    });
  }

  /**
   * Get recent alerts from database
   */
  async getRecentAlerts(options?: {
    limit?: number;
    severity?: string;
    alertType?: string;
  }): Promise<any[]> {
    const { limit = 100, severity, alertType } = options || {};

    let query = 'SELECT * FROM alerts WHERE 1=1';
    const params: any[] = [];
    let paramIdx = 1;

    if (severity) {
      query += ` AND severity = $${paramIdx}`;
      params.push(severity);
      paramIdx++;
    }

    if (alertType) {
      query += ` AND alert_type = $${paramIdx}`;
      params.push(alertType);
      paramIdx++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
    params.push(limit);

    try {
      const result = await this.pool.query(query, params);
      return result.rows;
    } catch (error) {
      console.warn('Could not fetch alerts from database:', error);
      return [];
    }
  }

  /**
   * Send custom alert
   */
  async sendCustomAlert(alert: {
    type: string;
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    title: string;
    message: string;
    metadata?: any;
  }): Promise<void> {
    await this.storeAlert({
      alert_type: alert.type,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      metadata: alert.metadata || {},
    });

    if (this.config.enableLogging !== false) {
      console.log(`[ALERT ${alert.severity}] ${alert.title}: ${alert.message}`);
    }

    await this.publishAlertToRedis(alert.type, alert);
  }

  /**
   * Check for anomalies in order patterns
   */
  async checkOrderAnomalies(userId: string, recentOrders: OrderAlert[]): Promise<void> {
    // Check for rapid-fire orders (more than 5 orders in 1 minute)
    const oneMinuteAgo = new Date(Date.now() - 60000);
    const recentCount = recentOrders.filter(o => o.timestamp > oneMinuteAgo).length;

    if (recentCount > 5) {
      await this.sendCustomAlert({
        type: 'RAPID_ORDERS',
        severity: 'WARNING',
        title: `Rapid Order Activity: User ${userId}`,
        message: `User ${userId} placed ${recentCount} orders in the last minute`,
        metadata: { userId, orderCount: recentCount, timeWindow: '1m' },
      });
    }

    // Check for high total exposure
    const totalExposure = recentOrders.reduce((sum, o) => sum + o.sizeUsd, 0);
    if (totalExposure > 100000) {
      await this.sendCustomAlert({
        type: 'HIGH_EXPOSURE',
        severity: 'CRITICAL',
        title: `High User Exposure: $${totalExposure.toLocaleString()}`,
        message: `User ${userId} has total exposure of $${totalExposure.toLocaleString()}`,
        metadata: { userId, totalExposure, orderCount: recentOrders.length },
      });
    }
  }
}

/**
 * Create alert service with default configuration
 */
export function createAlertService(
  pool: Pool,
  redis: Redis,
  overrides?: Partial<AlertConfig>
): AlertService {
  const defaultConfig: AlertConfig = {
    largeOrderThreshold: 10000, // $10k
    emailRecipients: process.env.ALERT_EMAIL_RECIPIENTS?.split(','),
    slackWebhookUrl: process.env.ALERT_SLACK_WEBHOOK_URL,
    enableEmail: process.env.ALERT_ENABLE_EMAIL === 'true',
    enableSlack: process.env.ALERT_ENABLE_SLACK === 'true',
    enableLogging: true,
  };

  const config = { ...defaultConfig, ...overrides };
  return new AlertService(pool, redis, config);
}

