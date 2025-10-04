// Trading engine comprehensive test suite
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { 
  TestUtils, 
  TestEnvironment, 
  setupGlobalTestEnvironment, 
  teardownGlobalTestEnvironment,
  TestDataFactory 
} from '@hunch/testing';
import { TradingEngine } from '../src/services/trading-engine';
import { OrderManager } from '../src/services/order-manager';
import { PositionManager } from '../src/services/position-manager';
import { RiskManager } from '../src/services/risk-manager';
import { UnifiedOrder, UnifiedTrade, UnifiedPosition } from '@hunch/shared';

describe('Trading Engine', () => {
  let testEnvironment: TestEnvironment;
  let testUtils: TestUtils;
  let tradingEngine: TradingEngine;
  let orderManager: OrderManager;
  let positionManager: PositionManager;
  let riskManager: RiskManager;

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
    
    // Initialize services
    orderManager = new OrderManager(testEnvironment.getPool());
    positionManager = new PositionManager(testEnvironment.getPool());
    riskManager = new RiskManager(testEnvironment.getPool());
    tradingEngine = new TradingEngine(orderManager, positionManager, riskManager);
  });

  afterEach(async () => {
    await testUtils.clearAll();
  });

  describe('Order Management', () => {
    it('should create a new order', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      const orderData = TestDataFactory.createOrder({
        userId: user.id,
        tokenId: tokens[0].tokenId,
        venue: market.venue,
      });

      // Act
      const order = await tradingEngine.createOrder(orderData);

      // Assert
      expect(order).toBeDefined();
      expect(order.id).toBeDefined();
      expect(order.userId).toBe(user.id);
      expect(order.tokenId).toBe(tokens[0].tokenId);
      expect(order.status).toBe('PENDING');
      expect(order.sizeUsd).toBe(orderData.sizeUsd);

      // Verify in database
      await testUtils.assertOrderExists(order.id);
      const dbOrder = await testUtils.getOrder(order.id);
      expect(dbOrder.user_id).toBe(user.id);
      expect(dbOrder.token_id).toBe(tokens[0].tokenId);
    });

    it('should update order status', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      const order = await testUtils.createTestOrder(user.id, tokens[0].tokenId);

      // Act
      await tradingEngine.updateOrderStatus(order.id, 'FILLED');

      // Assert
      const updatedOrder = await testUtils.getOrder(order.id);
      expect(updatedOrder.status).toBe('FILLED');
    });

    it('should cancel an order', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      const order = await testUtils.createTestOrder(user.id, tokens[0].tokenId);

      // Act
      await tradingEngine.cancelOrder(order.id);

      // Assert
      const cancelledOrder = await testUtils.getOrder(order.id);
      expect(cancelledOrder.status).toBe('CANCELLED');
      expect(cancelledOrder.cancelled_at).toBeDefined();
    });

    it('should get user orders', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      const order1 = await testUtils.createTestOrder(user.id, tokens[0].tokenId);
      const order2 = await testUtils.createTestOrder(user.id, tokens[1].tokenId);

      // Act
      const orders = await tradingEngine.getUserOrders(user.id);

      // Assert
      expect(orders).toHaveLength(2);
      expect(orders.map(o => o.id)).toContain(order1.id);
      expect(orders.map(o => o.id)).toContain(order2.id);
    });

    it('should get orders by status', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      const pendingOrder = await testUtils.createTestOrder(user.id, tokens[0].tokenId, { status: 'PENDING' });
      const filledOrder = await testUtils.createTestOrder(user.id, tokens[1].tokenId, { status: 'FILLED' });

      // Act
      const pendingOrders = await tradingEngine.getOrdersByStatus('PENDING');
      const filledOrders = await tradingEngine.getOrdersByStatus('FILLED');

      // Assert
      expect(pendingOrders.map(o => o.id)).toContain(pendingOrder.id);
      expect(filledOrders.map(o => o.id)).toContain(filledOrder.id);
    });
  });

  describe('Trade Execution', () => {
    it('should execute a trade', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      const order = await testUtils.createTestOrder(user.id, tokens[0].tokenId);

      const tradeData = TestDataFactory.createTrade({
        orderId: order.id,
        userId: user.id,
        tokenId: tokens[0].tokenId,
        venue: market.venue,
      });

      // Act
      const trade = await tradingEngine.executeTrade(tradeData);

      // Assert
      expect(trade).toBeDefined();
      expect(trade.id).toBeDefined();
      expect(trade.orderId).toBe(order.id);
      expect(trade.userId).toBe(user.id);
      expect(trade.tokenId).toBe(tokens[0].tokenId);

      // Verify in database
      await testUtils.assertTradeExists(trade.id);
      const dbTrade = await testUtils.getTrade(trade.id);
      expect(dbTrade.order_id).toBe(order.id);
      expect(dbTrade.user_id).toBe(user.id);
    });

    it('should update order fill status after trade', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      const order = await testUtils.createTestOrder(user.id, tokens[0].tokenId, { sizeUsd: 100 });

      const tradeData = TestDataFactory.createTrade({
        orderId: order.id,
        userId: user.id,
        tokenId: tokens[0].tokenId,
        venue: market.venue,
        sizeUsd: 100,
      });

      // Act
      await tradingEngine.executeTrade(tradeData);

      // Assert
      const updatedOrder = await testUtils.getOrder(order.id);
      expect(updatedOrder.filled_size_usd).toBe(100);
      expect(updatedOrder.status).toBe('FILLED');
    });
  });

  describe('Position Management', () => {
    it('should update position after trade', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      const order = await testUtils.createTestOrder(user.id, tokens[0].tokenId, { 
        side: 'BUY',
        sizeUsd: 100,
        price: 0.5 
      });

      const tradeData = TestDataFactory.createTrade({
        orderId: order.id,
        userId: user.id,
        tokenId: tokens[0].tokenId,
        venue: market.venue,
        side: 'BUY',
        sizeUsd: 100,
        price: 0.5,
      });

      // Act
      await tradingEngine.executeTrade(tradeData);

      // Assert
      const positions = await tradingEngine.getUserPositions(user.id);
      expect(positions).toHaveLength(1);
      
      const position = positions[0];
      expect(position.userId).toBe(user.id);
      expect(position.tokenId).toBe(tokens[0].tokenId);
      expect(position.side).toBe('YES');
      expect(position.quantity).toBe(100);
      expect(position.averagePrice).toBe(0.5);
    });

    it('should calculate unrealized P&L', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      // Create position
      const position = await testUtils.createTestPosition(user.id, tokens[0].tokenId, {
        quantity: 100,
        averagePrice: 0.5,
      });

      // Create price history
      await testUtils.createTestPriceHistory(tokens[0].tokenId, 5);

      // Act
      await tradingEngine.updateUnrealizedPnL(user.id);

      // Assert
      const updatedPosition = await testUtils.getPosition(position.id);
      expect(updatedPosition.unrealized_pnl_usd).toBeDefined();
    });

    it('should get user portfolio', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      const position1 = await testUtils.createTestPosition(user.id, tokens[0].tokenId, {
        quantity: 100,
        averagePrice: 0.5,
      });

      const position2 = await testUtils.createTestPosition(user.id, tokens[1].tokenId, {
        quantity: 50,
        averagePrice: 0.6,
      });

      // Act
      const portfolio = await tradingEngine.getUserPortfolio(user.id);

      // Assert
      expect(portfolio).toBeDefined();
      expect(portfolio.totalValue).toBeDefined();
      expect(portfolio.totalPnL).toBeDefined();
      expect(portfolio.positions).toHaveLength(2);
    });
  });

  describe('Risk Management', () => {
    it('should validate order against risk limits', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      const orderData = TestDataFactory.createOrder({
        userId: user.id,
        tokenId: tokens[0].tokenId,
        sizeUsd: 1000, // Large order
      });

      // Act
      const validation = await tradingEngine.validateOrderRisk(orderData);

      // Assert
      expect(validation.isValid).toBeDefined();
      expect(validation.violations).toBeDefined();
    });

    it('should check position limits', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      // Create large position
      const position = await testUtils.createTestPosition(user.id, tokens[0].tokenId, {
        quantity: 10000, // Large position
      });

      // Act
      const riskCheck = await tradingEngine.checkPositionRisk(user.id, tokens[0].tokenId);

      // Assert
      expect(riskCheck.isWithinLimits).toBeDefined();
      expect(riskCheck.violations).toBeDefined();
    });

    it('should enforce daily loss limits', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      // Create losing trades
      const order = await testUtils.createTestOrder(user.id, tokens[0].tokenId, { 
        side: 'BUY',
        sizeUsd: 1000,
        price: 0.8 
      });

      const trade = await testUtils.createTestTrade(order.id, user.id, tokens[0].tokenId, {
        side: 'BUY',
        sizeUsd: 1000,
        price: 0.8,
      });

      // Act
      const dailyLoss = await tradingEngine.getDailyLoss(user.id);

      // Assert
      expect(dailyLoss).toBeDefined();
      expect(dailyLoss).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid order data', async () => {
      // Arrange
      const invalidOrderData = {
        userId: 'invalid-uuid',
        tokenId: 'invalid-token-id' as any,
        side: 'INVALID' as any,
        orderType: 'INVALID' as any,
        sizeUsd: -100, // Negative size
      };

      // Act & Assert
      await expect(tradingEngine.createOrder(invalidOrderData as any)).rejects.toThrow();
    });

    it('should handle non-existent order cancellation', async () => {
      // Act & Assert
      await expect(tradingEngine.cancelOrder('non-existent-id')).rejects.toThrow();
    });

    it('should handle invalid trade data', async () => {
      // Arrange
      const invalidTradeData = {
        orderId: 'non-existent-order',
        userId: 'invalid-uuid',
        tokenId: 'invalid-token-id' as any,
        side: 'INVALID' as any,
        price: -0.5, // Negative price
        sizeUsd: -100, // Negative size
      };

      // Act & Assert
      await expect(tradingEngine.executeTrade(invalidTradeData as any)).rejects.toThrow();
    });
  });

  describe('Performance', () => {
    it('should handle multiple concurrent orders', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      const orderPromises = Array.from({ length: 10 }, (_, i) =>
        testUtils.createTestOrder(user.id, tokens[0].tokenId, {
          sizeUsd: 100 + i,
        })
      );

      // Act
      const startTime = Date.now();
      const orders = await Promise.all(orderPromises);
      const endTime = Date.now();

      // Assert
      expect(orders).toHaveLength(10);
      expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
    });

    it('should handle batch trade execution', async () => {
      // Arrange
      const user = await testUtils.createTestUser();
      const venueId = await testUtils.createTestVenue();
      const eventId = await testUtils.createTestEvent(venueId);
      const market = await testUtils.createTestMarket(eventId, venueId);
      const tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      const order = await testUtils.createTestOrder(user.id, tokens[0].tokenId, { sizeUsd: 1000 });

      const tradePromises = Array.from({ length: 5 }, (_, i) =>
        TestDataFactory.createTrade({
          orderId: order.id,
          userId: user.id,
          tokenId: tokens[0].tokenId,
          venue: market.venue,
          sizeUsd: 200,
        })
      );

      // Act
      const startTime = Date.now();
      const trades = await Promise.all(
        tradePromises.map(tradeData => tradingEngine.executeTrade(tradeData))
      );
      const endTime = Date.now();

      // Assert
      expect(trades).toHaveLength(5);
      expect(endTime - startTime).toBeLessThan(3000); // Should complete within 3 seconds
    });
  });
});
