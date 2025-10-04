// Main entry point for webhook system service
import { WebhookManager } from './services/webhook-manager';
import { logger } from '@hunch/shared';
import { config } from 'dotenv';
import { resolve } from 'path';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { v4 as uuid } from 'uuid';
import {
  WebhookConfig,
  WebhookEventType,
  WebhookFilter,
  WebhookStats,
  WebhookTestResult,
} from './types/webhook';

// Load environment variables
config({ path: resolve(process.cwd(), '../../.env'), override: true });

// Configuration
const webhookConfig = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://hunch:hunch@localhost:5432/hunch',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  port: parseInt(process.env.WEBHOOK_PORT || '3007'),
  enableHealthCheck: process.env.ENABLE_HEALTH_CHECK === 'true',
  healthCheckPort: parseInt(process.env.WEBHOOK_HEALTH_PORT || '3008'),
};

// Create Fastify app
const app = Fastify({ logger: true });

// Create database connection
const pool = new Pool({ connectionString: webhookConfig.databaseUrl });

// Create Redis client
const redisClient = createClient({ url: webhookConfig.redisUrl });

// Create webhook manager
const webhookManager = new WebhookManager(pool, redisClient);

// Setup event handlers
webhookManager.on('webhook:created', (webhook) => {
  logger.info('Webhook created', { webhookId: webhook.id, userId: webhook.userId });
});

webhookManager.on('webhook:updated', (webhook) => {
  logger.info('Webhook updated', { webhookId: webhook.id });
});

webhookManager.on('webhook:deleted', (webhookId) => {
  logger.info('Webhook deleted', { webhookId });
});

webhookManager.on('event:queued', (event) => {
  logger.debug('Webhook event queued', { eventId: event.id, eventType: event.eventType });
});

webhookManager.on('event:delivered', (event, attempt) => {
  logger.info('Webhook event delivered', { 
    eventId: event.id, 
    attemptNumber: attempt.attemptNumber,
    duration: attempt.duration 
  });
});

webhookManager.on('event:failed', (event, attempt) => {
  logger.warn('Webhook event failed', { 
    eventId: event.id, 
    attemptNumber: attempt.attemptNumber,
    error: attempt.errorMessage 
  });
});

webhookManager.on('error', (error, context) => {
  logger.error('Webhook manager error', { error: error.message, context });
});

// API Routes

// Health check
app.get('/health', async () => {
  try {
    await pool.query('SELECT 1');
    await redisClient.ping();
    return {
      status: 'healthy',
      database: true,
      redis: true,
      service: 'webhook-system',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      database: false,
      redis: false,
      service: 'webhook-system',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    };
  }
});

// Get webhook statistics
app.get('/stats', async () => {
  try {
    const stats = await webhookManager.getStats();
    return {
      success: true,
      data: stats,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to get webhook statistics', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get statistics',
      timestamp: new Date().toISOString()
    };
  }
});

// Create webhook
app.post('/webhooks', async (request, reply) => {
  try {
    const webhookData = request.body as Omit<WebhookConfig, 'id' | 'createdAt' | 'updatedAt' | 'failureCount' | 'successCount'>;
    
    const webhook = await webhookManager.createWebhook(webhookData);
    
    return {
      success: true,
      data: webhook,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to create webhook', error);
    return reply.code(400).send({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create webhook',
      timestamp: new Date().toISOString()
    });
  }
});

// Get webhook by ID
app.get('/webhooks/:webhookId', async (request, reply) => {
  try {
    const { webhookId } = request.params as { webhookId: string };
    
    const webhook = await webhookManager.getWebhook(webhookId);
    
    if (!webhook) {
      return reply.code(404).send({
        success: false,
        error: 'Webhook not found',
        timestamp: new Date().toISOString()
      });
    }
    
    return {
      success: true,
      data: webhook,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to get webhook', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get webhook',
      timestamp: new Date().toISOString()
    });
  }
});

// Update webhook
app.put('/webhooks/:webhookId', async (request, reply) => {
  try {
    const { webhookId } = request.params as { webhookId: string };
    const updates = request.body as Partial<WebhookConfig>;
    
    const webhook = await webhookManager.updateWebhook(webhookId, updates);
    
    return {
      success: true,
      data: webhook,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to update webhook', error);
    return reply.code(400).send({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update webhook',
      timestamp: new Date().toISOString()
    });
  }
});

// Delete webhook
app.delete('/webhooks/:webhookId', async (request, reply) => {
  try {
    const { webhookId } = request.params as { webhookId: string };
    
    await webhookManager.deleteWebhook(webhookId);
    
    return {
      success: true,
      message: 'Webhook deleted successfully',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to delete webhook', error);
    return reply.code(400).send({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete webhook',
      timestamp: new Date().toISOString()
    });
  }
});

// Get user webhooks
app.get('/users/:userId/webhooks', async (request, reply) => {
  try {
    const { userId } = request.params as { userId: string };
    const { status, isActive, eventTypes, createdAfter, createdBefore } = request.query as {
      status?: string;
      isActive?: string;
      eventTypes?: string;
      createdAfter?: string;
      createdBefore?: string;
    };
    
    const filter: WebhookFilter = {};
    if (status) filter.status = status as any;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (eventTypes) filter.eventTypes = eventTypes.split(',') as WebhookEventType[];
    if (createdAfter) filter.createdAfter = new Date(createdAfter);
    if (createdBefore) filter.createdBefore = new Date(createdBefore);
    
    const webhooks = await webhookManager.getUserWebhooks(userId, filter);
    
    return {
      success: true,
      data: webhooks,
      count: webhooks.length,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to get user webhooks', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get user webhooks',
      timestamp: new Date().toISOString()
    });
  }
});

// Test webhook
app.post('/webhooks/:webhookId/test', async (request, reply) => {
  try {
    const { webhookId } = request.params as { webhookId: string };
    
    const result = await webhookManager.testWebhook(webhookId);
    
    return {
      success: true,
      data: result,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to test webhook', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to test webhook',
      timestamp: new Date().toISOString()
    });
  }
});

// Trigger webhook event (for testing)
app.post('/webhooks/:webhookId/trigger', async (request, reply) => {
  try {
    const { webhookId } = request.params as { webhookId: string };
    const { eventType, data } = request.body as {
      eventType: WebhookEventType;
      data: any;
    };
    
    await webhookManager.queueEvent(eventType, data, undefined, undefined);
    
    return {
      success: true,
      message: 'Webhook event triggered successfully',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to trigger webhook', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to trigger webhook',
      timestamp: new Date().toISOString()
    });
  }
});

// Get webhook events
app.get('/webhooks/:webhookId/events', async (request, reply) => {
  try {
    const { webhookId } = request.params as { webhookId: string };
    const { limit = '50', offset = '0', status } = request.query as {
      limit?: string;
      offset?: string;
      status?: string;
    };
    
    let query = `
      SELECT we.*, wda.status as attempt_status, wda.response_status, wda.error_message
      FROM webhook_events we
      LEFT JOIN webhook_delivery_attempts wda ON we.id = wda.webhook_event_id
      WHERE we.webhook_id = $1
    `;
    const params: any[] = [webhookId];
    let paramIndex = 2;
    
    if (status) {
      query += ` AND we.status = $${paramIndex++}`;
      params.push(status);
    }
    
    query += ` ORDER BY we.timestamp DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    
    const events = result.rows.map(row => ({
      id: row.id,
      webhookId: row.webhook_id,
      eventType: row.event_type,
      timestamp: row.timestamp,
      data: JSON.parse(row.data),
      retryCount: row.retry_count,
      status: row.status,
      deliveredAt: row.delivered_at,
      failedAt: row.failed_at,
      errorMessage: row.error_message,
      lastAttempt: row.attempt_status ? {
        status: row.attempt_status,
        responseStatus: row.response_status,
        errorMessage: row.error_message,
      } : null,
    }));
    
    return {
      success: true,
      data: events,
      count: events.length,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to get webhook events', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get webhook events',
      timestamp: new Date().toISOString()
    });
  }
});

// Get webhook delivery attempts
app.get('/webhooks/:webhookId/events/:eventId/attempts', async (request, reply) => {
  try {
    const { webhookId, eventId } = request.params as { webhookId: string; eventId: string };
    
    const result = await pool.query(
      `SELECT * FROM webhook_delivery_attempts 
       WHERE webhook_event_id = $1 
       ORDER BY attempt_number ASC`,
      [eventId]
    );
    
    const attempts = result.rows.map(row => ({
      id: row.id,
      webhookEventId: row.webhook_event_id,
      attemptNumber: row.attempt_number,
      timestamp: row.timestamp,
      status: row.status,
      responseStatus: row.response_status,
      responseBody: row.response_body,
      errorMessage: row.error_message,
      duration: row.duration,
    }));
    
    return {
      success: true,
      data: attempts,
      count: attempts.length,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to get webhook delivery attempts', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get delivery attempts',
      timestamp: new Date().toISOString()
    });
  }
});

// Graceful shutdown handling
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down gracefully`);
  try {
    await webhookManager.stop();
    await pool.end();
    await redisClient.quit();
    await app.close();
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', error);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Health check endpoint
if (webhookConfig.enableHealthCheck) {
  const healthCheckPort = webhookConfig.healthCheckPort;
  
  // Simple HTTP server for health checks
  const http = await import('http');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      try {
        await pool.query('SELECT 1');
        await redisClient.ping();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'healthy',
          database: true,
          redis: true,
          service: 'webhook-system',
          timestamp: new Date().toISOString()
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'unhealthy',
          database: false,
          redis: false,
          service: 'webhook-system',
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }));
      }
    } else if (req.url === '/stats') {
      try {
        const stats = await webhookManager.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: 'webhook-system',
          stats,
          timestamp: new Date().toISOString()
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : 'Stats check failed',
          timestamp: new Date().toISOString()
        }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(healthCheckPort, () => {
    logger.info(`Webhook system health check server listening on port ${healthCheckPort}`);
  });
}

try {
  // Start webhook manager
  await webhookManager.start();

  // Start Fastify server
  await app.listen({ port: webhookConfig.port, host: '0.0.0.0' });

  logger.info(`Webhook system started successfully on port ${webhookConfig.port}`);
} catch (error) {
  logger.error('Failed to start webhook system', error);
  process.exit(1);
}
