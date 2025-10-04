// Webhook manager service for handling webhook delivery and management
import { EventEmitter } from 'events';
import { logger } from '@hunch/shared';
import { Pool } from 'pg';
import { RedisClientType, createClient } from 'redis';
import { v4 as uuid } from 'uuid';
import * as crypto from 'crypto';
import {
  WebhookConfig,
  WebhookEvent,
  WebhookEventType,
  WebhookEventData,
  WebhookDeliveryAttempt,
  WebhookStats,
  WebhookValidationResult,
  WebhookTestResult,
  WebhookQueueConfig,
  WebhookFilter,
  WebhookRateLimit,
  WebhookSecurity,
} from '../types/webhook';

// Webhook manager events
export interface WebhookManagerEvents {
  'webhook:created': (webhook: WebhookConfig) => void;
  'webhook:updated': (webhook: WebhookConfig) => void;
  'webhook:deleted': (webhookId: string) => void;
  'webhook:enabled': (webhookId: string) => void;
  'webhook:disabled': (webhookId: string) => void;
  'event:queued': (event: WebhookEvent) => void;
  'event:delivered': (event: WebhookEvent, attempt: WebhookDeliveryAttempt) => void;
  'event:failed': (event: WebhookEvent, attempt: WebhookDeliveryAttempt) => void;
  'event:retrying': (event: WebhookEvent, attempt: WebhookDeliveryAttempt) => void;
  'error': (error: Error, context: string) => void;
}

export class WebhookManager extends EventEmitter {
  private pool: Pool;
  private redisClient: RedisClientType;
  private queueConfig: WebhookQueueConfig;
  private rateLimits: Map<string, WebhookRateLimit> = new Map();
  private securityConfig: WebhookSecurity;
  private isRunning: boolean = false;
  private processingQueue: boolean = false;

  constructor(
    pool: Pool,
    redisClient: RedisClientType,
    config: {
      queueConfig?: WebhookQueueConfig;
      securityConfig?: WebhookSecurity;
    } = {}
  ) {
    super();
    this.pool = pool;
    this.redisClient = redisClient;
    this.queueConfig = config.queueConfig || {
      concurrency: 10,
      batchSize: 50,
      batchTimeout: 5000,
      maxQueueSize: 10000,
      enableDeadLetterQueue: true,
      deadLetterQueueRetention: 7 * 24 * 60 * 60 * 1000, // 7 days
    };
    this.securityConfig = config.securityConfig || {
      requireHTTPS: true,
      validateSSL: true,
      timeout: 30000,
      maxPayloadSize: 1024 * 1024, // 1MB
    };
    this.setupEventHandlers();
  }

  // Start the webhook manager
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Webhook manager is already running');
      return;
    }

    try {
      logger.info('Starting webhook manager');

      // Connect to Redis
      await this.redisClient.connect();

      // Start processing queue
      this.startQueueProcessing();

      this.isRunning = true;

      logger.info('Webhook manager started successfully');
    } catch (error) {
      logger.error('Failed to start webhook manager', error);
      throw error;
    }
  }

  // Stop the webhook manager
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Webhook manager is not running');
      return;
    }

    try {
      logger.info('Stopping webhook manager');

      // Stop queue processing
      this.processingQueue = false;

      // Close Redis connection
      await this.redisClient.quit();

      this.isRunning = false;

      logger.info('Webhook manager stopped successfully');
    } catch (error) {
      logger.error('Error stopping webhook manager', error);
    }
  }

  // Create a new webhook
  public async createWebhook(config: Omit<WebhookConfig, 'id' | 'createdAt' | 'updatedAt' | 'failureCount' | 'successCount'>): Promise<WebhookConfig> {
    try {
      const webhookId = uuid();
      const now = new Date();

      const webhook: WebhookConfig = {
        id: webhookId,
        ...config,
        createdAt: now,
        updatedAt: now,
        failureCount: 0,
        successCount: 0,
      };

      // Validate webhook configuration
      const validation = await this.validateWebhook(webhook);
      if (!validation.isValid) {
        throw new Error(`Webhook validation failed: ${validation.errors.join(', ')}`);
      }

      // Insert into database
      await this.pool.query(
        `INSERT INTO webhooks (
          id, user_id, name, description, url, events, auth_method, auth_config,
          retry_policy, status, is_active, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          webhook.id,
          webhook.userId,
          webhook.name,
          webhook.description,
          webhook.url,
          JSON.stringify(webhook.events),
          webhook.authMethod,
          JSON.stringify(webhook.authConfig),
          JSON.stringify(webhook.retryPolicy),
          webhook.status,
          webhook.isActive,
          webhook.createdAt,
          webhook.updatedAt,
        ]
      );

      this.emit('webhook:created', webhook);

      logger.info('Webhook created successfully', { webhookId: webhook.id, userId: webhook.userId });
      return webhook;
    } catch (error) {
      logger.error('Failed to create webhook', error);
      this.emit('error', error as Error, 'createWebhook');
      throw error;
    }
  }

  // Update an existing webhook
  public async updateWebhook(webhookId: string, updates: Partial<WebhookConfig>): Promise<WebhookConfig> {
    try {
      const now = new Date();
      const updateFields: string[] = [];
      const updateValues: any[] = [];
      let paramIndex = 1;

      // Build dynamic update query
      if (updates.name !== undefined) {
        updateFields.push(`name = $${paramIndex++}`);
        updateValues.push(updates.name);
      }
      if (updates.description !== undefined) {
        updateFields.push(`description = $${paramIndex++}`);
        updateValues.push(updates.description);
      }
      if (updates.url !== undefined) {
        updateFields.push(`url = $${paramIndex++}`);
        updateValues.push(updates.url);
      }
      if (updates.events !== undefined) {
        updateFields.push(`events = $${paramIndex++}`);
        updateValues.push(JSON.stringify(updates.events));
      }
      if (updates.authMethod !== undefined) {
        updateFields.push(`auth_method = $${paramIndex++}`);
        updateValues.push(updates.authMethod);
      }
      if (updates.authConfig !== undefined) {
        updateFields.push(`auth_config = $${paramIndex++}`);
        updateValues.push(JSON.stringify(updates.authConfig));
      }
      if (updates.retryPolicy !== undefined) {
        updateFields.push(`retry_policy = $${paramIndex++}`);
        updateValues.push(JSON.stringify(updates.retryPolicy));
      }
      if (updates.status !== undefined) {
        updateFields.push(`status = $${paramIndex++}`);
        updateValues.push(updates.status);
      }
      if (updates.isActive !== undefined) {
        updateFields.push(`is_active = $${paramIndex++}`);
        updateValues.push(updates.isActive);
      }

      updateFields.push(`updated_at = $${paramIndex++}`);
      updateValues.push(now);

      updateValues.push(webhookId);

      const query = `
        UPDATE webhooks 
        SET ${updateFields.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const result = await this.pool.query(query, updateValues);

      if (result.rows.length === 0) {
        throw new Error(`Webhook not found: ${webhookId}`);
      }

      const webhook = this.mapRowToWebhook(result.rows[0]);

      // Validate updated webhook
      const validation = await this.validateWebhook(webhook);
      if (!validation.isValid) {
        throw new Error(`Webhook validation failed: ${validation.errors.join(', ')}`);
      }

      this.emit('webhook:updated', webhook);

      logger.info('Webhook updated successfully', { webhookId });
      return webhook;
    } catch (error) {
      logger.error('Failed to update webhook', { error, webhookId });
      this.emit('error', error as Error, 'updateWebhook');
      throw error;
    }
  }

  // Delete a webhook
  public async deleteWebhook(webhookId: string): Promise<void> {
    try {
      const result = await this.pool.query('DELETE FROM webhooks WHERE id = $1', [webhookId]);

      if (result.rowCount === 0) {
        throw new Error(`Webhook not found: ${webhookId}`);
      }

      this.emit('webhook:deleted', webhookId);

      logger.info('Webhook deleted successfully', { webhookId });
    } catch (error) {
      logger.error('Failed to delete webhook', { error, webhookId });
      this.emit('error', error as Error, 'deleteWebhook');
      throw error;
    }
  }

  // Get webhook by ID
  public async getWebhook(webhookId: string): Promise<WebhookConfig | null> {
    try {
      const result = await this.pool.query('SELECT * FROM webhooks WHERE id = $1', [webhookId]);

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToWebhook(result.rows[0]);
    } catch (error) {
      logger.error('Failed to get webhook', { error, webhookId });
      this.emit('error', error as Error, 'getWebhook');
      throw error;
    }
  }

  // Get webhooks by user
  public async getUserWebhooks(userId: string, filter?: WebhookFilter): Promise<WebhookConfig[]> {
    try {
      let query = 'SELECT * FROM webhooks WHERE user_id = $1';
      const params: any[] = [userId];
      let paramIndex = 2;

      if (filter) {
        if (filter.status) {
          query += ` AND status = $${paramIndex++}`;
          params.push(filter.status);
        }
        if (filter.isActive !== undefined) {
          query += ` AND is_active = $${paramIndex++}`;
          params.push(filter.isActive);
        }
        if (filter.eventTypes && filter.eventTypes.length > 0) {
          query += ` AND events ?| $${paramIndex++}`;
          params.push(filter.eventTypes);
        }
        if (filter.createdAfter) {
          query += ` AND created_at >= $${paramIndex++}`;
          params.push(filter.createdAfter);
        }
        if (filter.createdBefore) {
          query += ` AND created_at <= $${paramIndex++}`;
          params.push(filter.createdBefore);
        }
      }

      query += ' ORDER BY created_at DESC';

      const result = await this.pool.query(query, params);
      return result.rows.map(row => this.mapRowToWebhook(row));
    } catch (error) {
      logger.error('Failed to get user webhooks', { error, userId });
      this.emit('error', error as Error, 'getUserWebhooks');
      throw error;
    }
  }

  // Queue a webhook event
  public async queueEvent(
    eventType: WebhookEventType,
    data: WebhookEventData,
    userId?: string,
    tokenId?: string
  ): Promise<void> {
    try {
      // Get active webhooks for this event type
      const webhooks = await this.getActiveWebhooksForEvent(eventType, userId, tokenId);

      if (webhooks.length === 0) {
        logger.debug('No active webhooks found for event', { eventType, userId, tokenId });
        return;
      }

      // Create webhook events for each webhook
      const events: WebhookEvent[] = webhooks.map(webhook => ({
        id: uuid(),
        webhookId: webhook.id,
        eventType,
        timestamp: new Date(),
        data,
        retryCount: 0,
        status: 'pending',
      }));

      // Insert events into database
      for (const event of events) {
        await this.pool.query(
          `INSERT INTO webhook_events (
            id, webhook_id, event_type, timestamp, data, retry_count, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            event.id,
            event.webhookId,
            event.eventType,
            event.timestamp,
            JSON.stringify(event.data),
            event.retryCount,
            event.status,
          ]
        );

        // Queue for processing
        await this.redisClient.lPush('webhook_queue', JSON.stringify(event));

        this.emit('event:queued', event);
      }

      logger.info('Webhook events queued', { 
        eventType, 
        eventsCount: events.length, 
        userId, 
        tokenId 
      });
    } catch (error) {
      logger.error('Failed to queue webhook event', { error, eventType });
      this.emit('error', error as Error, 'queueEvent');
      throw error;
    }
  }

  // Test a webhook
  public async testWebhook(webhookId: string): Promise<WebhookTestResult> {
    try {
      const webhook = await this.getWebhook(webhookId);
      if (!webhook) {
        throw new Error(`Webhook not found: ${webhookId}`);
      }

      const startTime = Date.now();
      const testPayload = {
        eventType: 'test',
        timestamp: new Date().toISOString(),
        data: {
          message: 'This is a test webhook from Hunch Trading Platform',
          webhookId: webhook.id,
          webhookName: webhook.name,
        },
      };

      const headers = await this.buildHeaders(webhook, testPayload);
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(testPayload),
        timeout: this.securityConfig.timeout,
      });

      const duration = Date.now() - startTime;
      const responseBody = await response.text();

      const result: WebhookTestResult = {
        success: response.ok,
        statusCode: response.status,
        responseBody,
        duration,
        timestamp: new Date(),
      };

      logger.info('Webhook test completed', { webhookId, result });
      return result;
    } catch (error) {
      logger.error('Webhook test failed', { error, webhookId });
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        duration: 0,
        timestamp: new Date(),
      };
    }
  }

  // Get webhook statistics
  public async getStats(): Promise<WebhookStats> {
    try {
      const webhookStats = await this.pool.query(`
        SELECT 
          COUNT(*) as total_webhooks,
          COUNT(CASE WHEN is_active = true THEN 1 END) as active_webhooks,
          COUNT(CASE WHEN status = 'paused' THEN 1 END) as paused_webhooks,
          COUNT(CASE WHEN status = 'disabled' THEN 1 END) as disabled_webhooks
        FROM webhooks
      `);

      const eventStats = await this.pool.query(`
        SELECT 
          COUNT(*) as total_events,
          COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered_events,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_events,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_events,
          AVG(CASE WHEN delivered_at IS NOT NULL THEN 
            EXTRACT(EPOCH FROM (delivered_at - timestamp)) * 1000 
          END) as avg_delivery_time
        FROM webhook_events
        WHERE timestamp >= NOW() - INTERVAL '24 hours'
      `);

      const last24hStats = await this.pool.query(`
        SELECT 
          COUNT(*) as last24h_events,
          COUNT(CASE WHEN status = 'delivered' THEN 1 END) as last24h_deliveries,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as last24h_failures
        FROM webhook_events
        WHERE timestamp >= NOW() - INTERVAL '24 hours'
      `);

      const webhookRow = webhookStats.rows[0];
      const eventRow = eventStats.rows[0];
      const last24hRow = last24hStats.rows[0];

      const totalEvents = parseInt(webhookRow.total_webhooks) || 0;
      const deliveredEvents = parseInt(eventRow.delivered_events) || 0;
      const successRate = totalEvents > 0 ? (deliveredEvents / totalEvents) * 100 : 0;

      return {
        totalWebhooks: parseInt(webhookRow.total_webhooks) || 0,
        activeWebhooks: parseInt(webhookRow.active_webhooks) || 0,
        pausedWebhooks: parseInt(webhookRow.paused_webhooks) || 0,
        disabledWebhooks: parseInt(webhookRow.disabled_webhooks) || 0,
        totalEvents: parseInt(eventRow.total_events) || 0,
        deliveredEvents,
        failedEvents: parseInt(eventRow.failed_events) || 0,
        pendingEvents: parseInt(eventRow.pending_events) || 0,
        averageDeliveryTime: parseFloat(eventRow.avg_delivery_time) || 0,
        successRate,
        last24hEvents: parseInt(last24hRow.last24h_events) || 0,
        last24hDeliveries: parseInt(last24hRow.last24h_deliveries) || 0,
        last24hFailures: parseInt(last24hRow.last24h_failures) || 0,
      };
    } catch (error) {
      logger.error('Failed to get webhook statistics', error);
      this.emit('error', error as Error, 'getStats');
      throw error;
    }
  }

  // Private methods

  private async getActiveWebhooksForEvent(
    eventType: WebhookEventType,
    userId?: string,
    tokenId?: string
  ): Promise<WebhookConfig[]> {
    let query = `
      SELECT * FROM webhooks 
      WHERE is_active = true 
        AND status = 'active'
        AND events ? $1
    `;
    const params: any[] = [eventType];

    if (userId) {
      query += ' AND user_id = $2';
      params.push(userId);
    }

    const result = await this.pool.query(query, params);
    return result.rows.map(row => this.mapRowToWebhook(row));
  }

  private async validateWebhook(webhook: WebhookConfig): Promise<WebhookValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate URL
    try {
      const url = new URL(webhook.url);
      if (this.securityConfig.requireHTTPS && url.protocol !== 'https:') {
        errors.push('HTTPS is required for webhook URLs');
      }
    } catch {
      errors.push('Invalid webhook URL');
    }

    // Validate events
    if (!webhook.events || webhook.events.length === 0) {
      errors.push('At least one event type must be specified');
    }

    // Validate authentication
    if (webhook.authMethod === 'bearer' && !webhook.authConfig?.bearerToken) {
      errors.push('Bearer token is required for bearer authentication');
    }
    if (webhook.authMethod === 'api_key' && !webhook.authConfig?.apiKey) {
      errors.push('API key is required for API key authentication');
    }
    if (webhook.authMethod === 'hmac' && !webhook.authConfig?.hmacSecret) {
      errors.push('HMAC secret is required for HMAC authentication');
    }

    // Validate retry policy
    if (webhook.retryPolicy.maxRetries < 0 || webhook.retryPolicy.maxRetries > 10) {
      errors.push('Max retries must be between 0 and 10');
    }
    if (webhook.retryPolicy.retryDelay < 1000) {
      warnings.push('Retry delay should be at least 1000ms');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private async buildHeaders(webhook: WebhookConfig, payload: any): Promise<HeadersInit> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'User-Agent': 'Hunch-Trading-Platform-Webhook/1.0',
      'X-Webhook-Event': 'test',
      'X-Webhook-Timestamp': new Date().toISOString(),
    };

    // Add authentication headers
    if (webhook.authMethod === 'bearer' && webhook.authConfig?.bearerToken) {
      headers['Authorization'] = `Bearer ${webhook.authConfig.bearerToken}`;
    } else if (webhook.authMethod === 'api_key' && webhook.authConfig?.apiKey) {
      headers['X-API-Key'] = webhook.authConfig.apiKey;
    } else if (webhook.authMethod === 'hmac' && webhook.authConfig?.hmacSecret) {
      const payloadString = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha256', webhook.authConfig.hmacSecret)
        .update(payloadString)
        .digest('hex');
      headers['X-Webhook-Signature'] = `sha256=${signature}`;
    }

    return headers;
  }

  private mapRowToWebhook(row: any): WebhookConfig {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      description: row.description,
      url: row.url,
      events: JSON.parse(row.events),
      authMethod: row.auth_method,
      authConfig: row.auth_config ? JSON.parse(row.auth_config) : undefined,
      retryPolicy: JSON.parse(row.retry_policy),
      status: row.status,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastTriggeredAt: row.last_triggered_at,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      failureCount: row.failure_count || 0,
      successCount: row.success_count || 0,
    };
  }

  private startQueueProcessing(): void {
    if (this.processingQueue) {
      return;
    }

    this.processingQueue = true;
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    while (this.processingQueue) {
      try {
        const batch = await this.redisClient.brPop('webhook_queue', 1);
        if (!batch) {
          continue;
        }

        const eventData = JSON.parse(batch.element);
        await this.processWebhookEvent(eventData);
      } catch (error) {
        logger.error('Error processing webhook queue', error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private async processWebhookEvent(eventData: any): Promise<void> {
    try {
      const webhook = await this.getWebhook(eventData.webhookId);
      if (!webhook || !webhook.isActive) {
        logger.warn('Webhook not found or inactive', { webhookId: eventData.webhookId });
        return;
      }

      const attempt = await this.deliverWebhook(webhook, eventData);
      
      if (attempt.status === 'success') {
        await this.updateEventStatus(eventData.id, 'delivered', attempt);
        this.emit('event:delivered', eventData, attempt);
      } else {
        await this.handleFailedDelivery(eventData, attempt);
      }
    } catch (error) {
      logger.error('Error processing webhook event', { error, eventData });
      this.emit('error', error as Error, 'processWebhookEvent');
    }
  }

  private async deliverWebhook(webhook: WebhookConfig, event: WebhookEvent): Promise<WebhookDeliveryAttempt> {
    const attemptId = uuid();
    const startTime = Date.now();

    try {
      const payload = {
        eventType: event.eventType,
        timestamp: event.timestamp.toISOString(),
        data: event.data,
      };

      const headers = await this.buildHeaders(webhook, payload);
      
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        timeout: this.securityConfig.timeout,
      });

      const duration = Date.now() - startTime;
      const responseBody = await response.text();

      const attempt: WebhookDeliveryAttempt = {
        id: attemptId,
        webhookEventId: event.id,
        attemptNumber: event.retryCount + 1,
        timestamp: new Date(),
        status: response.ok ? 'success' : 'failed',
        responseStatus: response.status,
        responseBody,
        duration,
      };

      return attempt;
    } catch (error) {
      const duration = Date.now() - startTime;
      return {
        id: attemptId,
        webhookEventId: event.id,
        attemptNumber: event.retryCount + 1,
        timestamp: new Date(),
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        duration,
      };
    }
  }

  private async handleFailedDelivery(event: WebhookEvent, attempt: WebhookDeliveryAttempt): Promise<void> {
    const webhook = await this.getWebhook(event.webhookId);
    if (!webhook) return;

    if (event.retryCount < webhook.retryPolicy.maxRetries) {
      // Schedule retry
      const retryDelay = Math.min(
        webhook.retryPolicy.retryDelay * Math.pow(webhook.retryPolicy.backoffMultiplier, event.retryCount),
        webhook.retryPolicy.maxRetryDelay
      );

      setTimeout(async () => {
        await this.redisClient.lPush('webhook_queue', JSON.stringify({
          ...event,
          retryCount: event.retryCount + 1,
        }));
      }, retryDelay);

      await this.updateEventStatus(event.id, 'retrying', attempt);
      this.emit('event:retrying', event, attempt);
    } else {
      // Max retries exceeded
      await this.updateEventStatus(event.id, 'failed', attempt);
      this.emit('event:failed', event, attempt);
    }
  }

  private async updateEventStatus(
    eventId: string,
    status: 'delivered' | 'failed' | 'retrying',
    attempt: WebhookDeliveryAttempt
  ): Promise<void> {
    const updateFields: string[] = ['status = $1'];
    const values: any[] = [status];
    let paramIndex = 2;

    if (status === 'delivered') {
      updateFields.push(`delivered_at = $${paramIndex++}`);
      values.push(new Date());
    } else if (status === 'failed') {
      updateFields.push(`failed_at = $${paramIndex++}`);
      values.push(new Date());
    }

    updateFields.push(`retry_count = $${paramIndex++}`);
    values.push(attempt.attemptNumber);

    values.push(eventId);

    await this.pool.query(
      `UPDATE webhook_events 
       SET ${updateFields.join(', ')}
       WHERE id = $${paramIndex}`,
      values
    );

    // Insert delivery attempt
    await this.pool.query(
      `INSERT INTO webhook_delivery_attempts (
        id, webhook_event_id, attempt_number, timestamp, status,
        response_status, response_body, error_message, duration
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        attempt.id,
        attempt.webhookEventId,
        attempt.attemptNumber,
        attempt.timestamp,
        attempt.status,
        attempt.responseStatus,
        attempt.responseBody,
        attempt.errorMessage,
        attempt.duration,
      ]
    );
  }

  private setupEventHandlers(): void {
    this.on('webhook:created', (webhook) => {
      logger.info('Webhook created', { webhookId: webhook.id, userId: webhook.userId });
    });

    this.on('webhook:updated', (webhook) => {
      logger.info('Webhook updated', { webhookId: webhook.id });
    });

    this.on('webhook:deleted', (webhookId) => {
      logger.info('Webhook deleted', { webhookId });
    });

    this.on('event:queued', (event) => {
      logger.debug('Webhook event queued', { eventId: event.id, eventType: event.eventType });
    });

    this.on('event:delivered', (event, attempt) => {
      logger.info('Webhook event delivered', { 
        eventId: event.id, 
        attemptNumber: attempt.attemptNumber,
        duration: attempt.duration 
      });
    });

    this.on('event:failed', (event, attempt) => {
      logger.warn('Webhook event failed', { 
        eventId: event.id, 
        attemptNumber: attempt.attemptNumber,
        error: attempt.errorMessage 
      });
    });

    this.on('error', (error, context) => {
      logger.error('Webhook manager error', { error: error.message, context });
    });
  }
}
