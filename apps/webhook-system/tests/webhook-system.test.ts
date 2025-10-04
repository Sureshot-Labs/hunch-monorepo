// Webhook system comprehensive test suite
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { 
  TestUtils, 
  TestEnvironment, 
  setupGlobalTestEnvironment, 
  teardownGlobalTestEnvironment,
  TestDataFactory 
} from '@hunch/testing';
import { WebhookManager } from '../src/services/webhook-manager';
import { WebhookIntegrationService } from '../src/services/webhook-integration';
import { UnifiedOrder, UnifiedTrade, UnifiedPosition } from '@hunch/shared';

// Mock fetch for webhook delivery testing
global.fetch = vi.fn();

describe('Webhook System', () => {
  let testEnvironment: TestEnvironment;
  let testUtils: TestUtils;
  let webhookManager: WebhookManager;
  let webhookIntegration: WebhookIntegrationService;

  beforeAll(async () => {
    testEnvironment = await setupGlobalTestEnvironment();
    testUtils = new TestUtils(testEnvironment.getPool(), testEnvironment.getRedisClient());
    await testUtils.connect();
  });

  afterAll(async () => {
    await testUtils.disconnect();
    await teardownGlobalTestEnvironment();
  });

  beforeEach(async () => {
    await testUtils.clearAll();
    webhookManager = new WebhookManager(testEnvironment.getPool(), testEnvironment.getRedisClient());
    webhookIntegration = new WebhookIntegrationService(webhookManager);
    await webhookManager.start();
  });

  afterEach(async () => {
    await webhookManager.stop();
    await testUtils.clearAll();
    vi.clearAllMocks();
  });

  describe('Webhook Management', () => {
    it('should create a webhook', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhookData = TestDataFactory.createWebhook({
        userId: user.id,
        url: 'https://example.com/webhook',
        events: ['order.created', 'order.updated'],
        authMethod: 'hmac',
        authConfig: {
          hmacSecret: 'test-secret',
          hmacAlgorithm: 'sha256',
        },
      });

      // Act
      const webhook = await webhookManager.createWebhook(webhookData);

      // Assert
      expect(webhook).toBeDefined();
      expect(webhook.id).toBeDefined();
      expect(webhook.userId).toBe(user.id);
      expect(webhook.url).toBe('https://example.com/webhook');
      expect(webhook.events).toEqual(['order.created', 'order.updated']);
      expect(webhook.authMethod).toBe('hmac');
      expect(webhook.status).toBe('active');
      expect(webhook.isActive).toBe(true);

      // Verify in database
      await testUtils.assertWebhookExists(webhook.id);
      const dbWebhook = await testUtils.getWebhook(webhook.id);
      expect(dbWebhook.user_id).toBe(user.id);
    });

    it('should update a webhook', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        name: 'Original Name',
        url: 'https://example.com/webhook',
      });

      // Act
      const updatedWebhook = await webhookManager.updateWebhook(webhook.id, {
        name: 'Updated Name',
        url: 'https://example.com/webhook-updated',
      });

      // Assert
      expect(updatedWebhook.name).toBe('Updated Name');
      expect(updatedWebhook.url).toBe('https://example.com/webhook-updated');
      expect(updatedWebhook.id).toBe(webhook.id);
    });

    it('should delete a webhook', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id);

      // Act
      await webhookManager.deleteWebhook(webhook.id);

      // Assert
      const dbWebhook = await testUtils.getWebhook(webhook.id);
      expect(dbWebhook).toBeNull();
    });

    it('should get webhook by ID', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id);

      // Act
      const retrievedWebhook = await webhookManager.getWebhook(webhook.id);

      // Assert
      expect(retrievedWebhook).toBeDefined();
      expect(retrievedWebhook!.id).toBe(webhook.id);
      expect(retrievedWebhook!.userId).toBe(user.id);
    });

    it('should get user webhooks', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook1 = await testUtils.createTestWebhook(user.id, { name: 'Webhook 1' });
      const webhook2 = await testUtils.createTestWebhook(user.id, { name: 'Webhook 2' });

      // Act
      const userWebhooks = await webhookManager.getUserWebhooks(user.id);

      // Assert
      expect(userWebhooks).toHaveLength(2);
      expect(userWebhooks.map(w => w.id)).toContain(webhook1.id);
      expect(userWebhooks.map(w => w.id)).toContain(webhook2.id);
    });

    it('should filter webhooks by status', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const activeWebhook = await testUtils.createTestWebhook(user.id, { status: 'active' });
      const pausedWebhook = await testUtils.createTestWebhook(user.id, { status: 'paused' });

      // Act
      const activeWebhooks = await webhookManager.getUserWebhooks(user.id, { status: 'active' });
      const pausedWebhooks = await webhookManager.getUserWebhooks(user.id, { status: 'paused' });

      // Assert
      expect(activeWebhooks).toHaveLength(1);
      expect(activeWebhooks[0].id).toBe(activeWebhook.id);
      expect(pausedWebhooks).toHaveLength(1);
      expect(pausedWebhooks[0].id).toBe(pausedWebhook.id);
    });

    it('should validate webhook configuration', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const invalidWebhookData = {
        userId: user.id,
        name: 'Invalid Webhook',
        url: 'invalid-url', // Invalid URL
        events: [], // Empty events
        authMethod: 'bearer' as const,
        authConfig: {}, // Missing bearer token
        retryPolicy: {
          maxRetries: 15, // Too many retries
          retryDelay: 100, // Too short delay
          backoffMultiplier: 2,
          maxRetryDelay: 60000,
        },
        status: 'active' as const,
        isActive: true,
      };

      // Act & Assert
      await expect(webhookManager.createWebhook(invalidWebhookData)).rejects.toThrow();
    });
  });

  describe('Webhook Delivery', () => {
    it('should queue webhook events', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        events: ['order.created'],
      });

      const eventData = {
        order: TestDataFactory.createOrder({ userId: user.id }),
        venue: 'polymarket',
        tokenId: 'polymarket:test:YES' as any,
      };

      // Act
      await webhookManager.queueEvent('order.created', eventData, user.id);

      // Assert
      const events = await testEnvironment.getPool().query(
        'SELECT * FROM webhook_events WHERE webhook_id = $1',
        [webhook.id]
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0].event_type).toBe('order.created');
      expect(events.rows[0].status).toBe('pending');
    });

    it('should deliver webhook successfully', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        url: 'https://httpbin.org/post',
        events: ['order.created'],
      });

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"success": true}'),
      });

      const eventData = {
        order: TestDataFactory.createOrder({ userId: user.id }),
        venue: 'polymarket',
        tokenId: 'polymarket:test:YES' as any,
      };

      // Act
      await webhookManager.queueEvent('order.created', eventData, user.id);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Assert
      expect(global.fetch).toHaveBeenCalledWith(
        'https://httpbin.org/post',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: expect.stringContaining('order.created'),
        })
      );
    });

    it('should retry failed webhook deliveries', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        url: 'https://httpbin.org/status/500',
        events: ['order.created'],
        retryPolicy: {
          maxRetries: 2,
          retryDelay: 100,
          backoffMultiplier: 2,
          maxRetryDelay: 1000,
        },
      });

      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const eventData = {
        order: TestDataFactory.createOrder({ userId: user.id }),
        venue: 'polymarket',
        tokenId: 'polymarket:test:YES' as any,
      };

      // Act
      await webhookManager.queueEvent('order.created', eventData, user.id);

      // Wait for processing and retries
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Assert
      expect(global.fetch).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should test webhook endpoint', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        url: 'https://httpbin.org/post',
      });

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"success": true}'),
      });

      // Act
      const testResult = await webhookManager.testWebhook(webhook.id);

      // Assert
      expect(testResult.success).toBe(true);
      expect(testResult.statusCode).toBe(200);
      expect(testResult.duration).toBeGreaterThan(0);
    });
  });

  describe('Webhook Integration', () => {
    it('should trigger order created webhook', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        events: ['order.created'],
      });

      const order = TestDataFactory.createOrder({ userId: user.id });

      // Act
      await webhookIntegration.onOrderCreated(order);

      // Assert
      const events = await testEnvironment.getPool().query(
        'SELECT * FROM webhook_events WHERE webhook_id = $1 AND event_type = $2',
        [webhook.id, 'order.created']
      );
      expect(events.rows).toHaveLength(1);
    });

    it('should trigger order updated webhook', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        events: ['order.updated'],
      });

      const order = TestDataFactory.createOrder({ userId: user.id });

      // Act
      await webhookIntegration.onOrderUpdated(order, 'PENDING');

      // Assert
      const events = await testEnvironment.getPool().query(
        'SELECT * FROM webhook_events WHERE webhook_id = $1 AND event_type = $2',
        [webhook.id, 'order.updated']
      );
      expect(events.rows).toHaveLength(1);
    });

    it('should trigger order filled webhook', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        events: ['order.filled'],
      });

      const order = TestDataFactory.createOrder({ userId: user.id });
      const trades = [TestDataFactory.createTrade({ orderId: order.id, userId: user.id })];

      // Act
      await webhookIntegration.onOrderFilled(order, trades);

      // Assert
      const events = await testEnvironment.getPool().query(
        'SELECT * FROM webhook_events WHERE webhook_id = $1 AND event_type = $2',
        [webhook.id, 'order.filled']
      );
      expect(events.rows).toHaveLength(1);
    });

    it('should trigger trade executed webhook', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        events: ['trade.executed'],
      });

      const trade = TestDataFactory.createTrade({ userId: user.id });
      const order = TestDataFactory.createOrder({ id: trade.orderId, userId: user.id });

      // Act
      await webhookIntegration.onTradeExecuted(trade, order);

      // Assert
      const events = await testEnvironment.getPool().query(
        'SELECT * FROM webhook_events WHERE webhook_id = $1 AND event_type = $2',
        [webhook.id, 'trade.executed']
      );
      expect(events.rows).toHaveLength(1);
    });

    it('should trigger position updated webhook', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        events: ['position.updated'],
      });

      const position = TestDataFactory.createPosition({ userId: user.id });

      // Act
      await webhookIntegration.onPositionUpdated(position, 50, 0.4);

      // Assert
      const events = await testEnvironment.getPool().query(
        'SELECT * FROM webhook_events WHERE webhook_id = $1 AND event_type = $2',
        [webhook.id, 'position.updated']
      );
      expect(events.rows).toHaveLength(1);
    });

    it('should trigger price updated webhook', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        events: ['price.updated'],
      });

      const tokenId = 'polymarket:test:YES' as any;

      // Act
      await webhookIntegration.onPriceUpdated(tokenId, 0.65, 1000);

      // Assert
      const events = await testEnvironment.getPool().query(
        'SELECT * FROM webhook_events WHERE webhook_id = $1 AND event_type = $2',
        [webhook.id, 'price.updated']
      );
      expect(events.rows).toHaveLength(1);
    });

    it('should trigger analytics signal generated webhook', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        events: ['analytics.signal_generated'],
      });

      const tokenId = 'polymarket:test:YES' as any;
      const indicators = {
        rsi: 'neutral',
        macd: 'bullish',
        bollinger: 'neutral',
        stochastic: 'oversold',
        movingAverage: 'bullish',
      };

      // Act
      await webhookIntegration.onAnalyticsSignalGenerated(
        tokenId,
        'buy',
        0.8,
        '1d',
        indicators
      );

      // Assert
      const events = await testEnvironment.getPool().query(
        'SELECT * FROM webhook_events WHERE webhook_id = $1 AND event_type = $2',
        [webhook.id, 'analytics.signal_generated']
      );
      expect(events.rows).toHaveLength(1);
    });

    it('should trigger analytics recommendation updated webhook', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        events: ['analytics.recommendation_updated'],
      });

      const tokenId = 'polymarket:test:YES' as any;
      const recommendations = [
        {
          action: 'buy',
          confidence: 0.8,
          reasoning: ['Strong bullish signal', 'Volume increasing'],
          targetPrice: 0.7,
          stopLoss: 0.6,
          timeHorizon: 'medium',
          riskLevel: 'medium',
        },
      ];

      // Act
      await webhookIntegration.onAnalyticsRecommendationUpdated(tokenId, recommendations);

      // Assert
      const events = await testEnvironment.getPool().query(
        'SELECT * FROM webhook_events WHERE webhook_id = $1 AND event_type = $2',
        [webhook.id, 'analytics.recommendation_updated']
      );
      expect(events.rows).toHaveLength(1);
    });

    it('should handle batch order events', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        events: ['order.created'],
      });

      const orders = Array.from({ length: 5 }, () =>
        TestDataFactory.createOrder({ userId: user.id })
      );

      // Act
      await webhookIntegration.onBatchOrderEvents(orders, 'created');

      // Assert
      const events = await testEnvironment.getPool().query(
        'SELECT * FROM webhook_events WHERE webhook_id = $1 AND event_type = $2',
        [webhook.id, 'order.created']
      );
      expect(events.rows).toHaveLength(5);
    });

    it('should handle batch price updates', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        events: ['price.updated'],
      });

      const priceUpdates = Array.from({ length: 3 }, (_, i) => ({
        tokenId: `polymarket:test${i}:YES` as any,
        price: 0.5 + i * 0.1,
        volume: 1000 + i * 100,
      }));

      // Act
      await webhookIntegration.onBatchPriceUpdates(priceUpdates);

      // Assert
      const events = await testEnvironment.getPool().query(
        'SELECT * FROM webhook_events WHERE webhook_id = $1 AND event_type = $2',
        [webhook.id, 'price.updated']
      );
      expect(events.rows).toHaveLength(3);
    });
  });

  describe('Webhook Statistics', () => {
    it('should provide webhook statistics', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id);

      // Create some test events
      await testUtils.createTestWebhookEvent(webhook.id, 'order.created', 'delivered');
      await testUtils.createTestWebhookEvent(webhook.id, 'order.updated', 'failed');
      await testUtils.createTestWebhookEvent(webhook.id, 'trade.executed', 'pending');

      // Act
      const stats = await webhookManager.getStats();

      // Assert
      expect(stats.totalWebhooks).toBeGreaterThan(0);
      expect(stats.activeWebhooks).toBeGreaterThan(0);
      expect(stats.totalEvents).toBeGreaterThan(0);
      expect(stats.deliveredEvents).toBeGreaterThan(0);
      expect(stats.failedEvents).toBeGreaterThan(0);
      expect(stats.pendingEvents).toBeGreaterThan(0);
      expect(stats.successRate).toBeGreaterThanOrEqual(0);
      expect(stats.successRate).toBeLessThanOrEqual(100);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid webhook URL', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhookData = TestDataFactory.createWebhook({
        userId: user.id,
        url: 'invalid-url',
      });

      // Act & Assert
      await expect(webhookManager.createWebhook(webhookData)).rejects.toThrow();
    });

    it('should handle webhook delivery timeout', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        url: 'https://httpbin.org/delay/10', // 10 second delay
      });

      (global.fetch as any).mockImplementationOnce(() =>
        new Promise((resolve) => {
          setTimeout(() => resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve('{"success": true}'),
          }), 10000);
        })
      );

      const eventData = {
        order: TestDataFactory.createOrder({ userId: user.id }),
        venue: 'polymarket',
        tokenId: 'polymarket:test:YES' as any,
      };

      // Act
      await webhookManager.queueEvent('order.created', eventData, user.id);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Assert - Should timeout and retry
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should handle network errors gracefully', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        url: 'https://nonexistent-domain.com/webhook',
      });

      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      const eventData = {
        order: TestDataFactory.createOrder({ userId: user.id }),
        venue: 'polymarket',
        tokenId: 'polymarket:test:YES' as any,
      };

      // Act
      await webhookManager.queueEvent('order.created', eventData, user.id);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Assert - Should handle error gracefully
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe('Performance', () => {
    it('should handle multiple concurrent webhook deliveries', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const webhook = await testUtils.createTestWebhook(user.id, {
        url: 'https://httpbin.org/post',
        events: ['order.created'],
      });

      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"success": true}'),
      });

      const eventPromises = Array.from({ length: 10 }, (_, i) => {
        const eventData = {
          order: TestDataFactory.createOrder({ userId: user.id }),
          venue: 'polymarket',
          tokenId: `polymarket:test${i}:YES` as any,
        };
        return webhookManager.queueEvent('order.created', eventData, user.id);
      });

      // Act
      const startTime = Date.now();
      await Promise.all(eventPromises);
      const endTime = Date.now();

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Assert
      expect(endTime - startTime).toBeLessThan(5000); // Should queue quickly
      expect(global.fetch).toHaveBeenCalledTimes(10); // Should deliver all
    });
  });
});
