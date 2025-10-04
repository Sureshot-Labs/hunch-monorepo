// Test utilities and helpers for comprehensive testing
import { Pool } from 'pg';
import { RedisClientType, createClient } from 'redis';
import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { UnifiedTokenId, UnifiedOrder, UnifiedTrade, UnifiedPosition } from '@hunch/shared';

// Test database configuration
export interface TestDatabaseConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

// Test Redis configuration
export interface TestRedisConfig {
  host: string;
  port: number;
  password?: string;
}

// Test user data
export interface TestUser {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
}

// Test market data
export interface TestMarket {
  id: string;
  venue: string;
  venueMarketId: string;
  title: string;
  status: string;
  acceptingOrders: boolean;
}

// Test token data
export interface TestToken {
  tokenId: UnifiedTokenId;
  marketId: string;
  side: 'YES' | 'NO';
}

// Test order data
export interface TestOrder {
  id: string;
  userId: string;
  venue: string;
  tokenId: UnifiedTokenId;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  price?: number;
  sizeUsd: number;
  status: string;
}

// Test trade data
export interface TestTrade {
  id: string;
  orderId: string;
  userId: string;
  venue: string;
  tokenId: UnifiedTokenId;
  side: 'BUY' | 'SELL';
  price: number;
  sizeUsd: number;
  executedAt: Date;
}

// Test position data
export interface TestPosition {
  id: string;
  userId: string;
  tokenId: UnifiedTokenId;
  side: 'YES' | 'NO';
  quantity: number;
  averagePrice: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
}

// Test webhook data
export interface TestWebhook {
  id: string;
  userId: string;
  name: string;
  url: string;
  events: string[];
  authMethod: string;
  status: string;
  isActive: boolean;
}

// Test utilities class
export class TestUtils {
  private pool: Pool;
  private redisClient: RedisClientType;
  private testData: {
    users: TestUser[];
    markets: TestMarket[];
    tokens: TestToken[];
    orders: TestOrder[];
    trades: TestTrade[];
    positions: TestPosition[];
    webhooks: TestWebhook[];
  } = {
    users: [],
    markets: [],
    tokens: [],
    orders: [],
    trades: [],
    positions: [],
    webhooks: [],
  };

  constructor(pool: Pool, redisClient: RedisClientType) {
    this.pool = pool;
    this.redisClient = redisClient;
  }

  // Database utilities
  async connect(): Promise<void> {
    await this.pool.connect();
    await this.redisClient.connect();
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
    await this.redisClient.quit();
  }

  async clearDatabase(): Promise<void> {
    // Clear all test data in reverse dependency order
    await this.pool.query('DELETE FROM webhook_delivery_attempts');
    await this.pool.query('DELETE FROM webhook_events');
    await this.pool.query('DELETE FROM webhooks');
    await this.pool.query('DELETE FROM user_positions');
    await this.pool.query('DELETE FROM trading_trades');
    await this.pool.query('DELETE FROM trading_orders');
    await this.pool.query('DELETE FROM user_wallets');
    await this.pool.query('DELETE FROM tokens');
    await this.pool.query('DELETE FROM markets');
    await this.pool.query('DELETE FROM events');
    await this.pool.query('DELETE FROM users');
    await this.pool.query('DELETE FROM venues');
  }

  async clearRedis(): Promise<void> {
    await this.redisClient.flushAll();
  }

  async clearAll(): Promise<void> {
    await this.clearDatabase();
    await this.clearRedis();
    this.testData = {
      users: [],
      markets: [],
      tokens: [],
      orders: [],
      trades: [],
      positions: [],
      webhooks: [],
    };
  }

  // Data creation utilities
  async createTestUser(overrides: Partial<TestUser> = {}): Promise<TestUser> {
    const user: TestUser = {
      id: uuid(),
      email: `test-${uuid()}@example.com`,
      username: `testuser-${uuid().slice(0, 8)}`,
      firstName: 'Test',
      lastName: 'User',
      ...overrides,
    };

    await this.pool.query(
      `INSERT INTO users (id, email, username, password_hash, first_name, last_name, is_active, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        user.id,
        user.email,
        user.username,
        'hashed-password',
        user.firstName,
        user.lastName,
        true,
        true,
      ]
    );

    this.testData.users.push(user);
    return user;
  }

  async createTestVenue(name: string = 'test-venue'): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO venues (name, api_base, ws_url) 
       VALUES ($1, $2, $3) 
       RETURNING id`,
      [`${name}-${uuid().slice(0, 8)}`, 'https://api.test.com', 'wss://ws.test.com']
    );
    return result.rows[0].id;
  }

  async createTestEvent(venueId: number, overrides: Partial<any> = {}): Promise<string> {
    const eventId = uuid();
    await this.pool.query(
      `INSERT INTO events (id, venue_id, event_id, title, category, active, closed)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        eventId,
        venueId,
        `event-${uuid().slice(0, 8)}`,
        overrides.title || 'Test Event',
        overrides.category || 'Test Category',
        overrides.active !== false,
        overrides.closed || false,
      ]
    );
    return eventId;
  }

  async createTestMarket(eventId: string, venueId: number, overrides: Partial<TestMarket> = {}): Promise<TestMarket> {
    const market: TestMarket = {
      id: uuid(),
      venue: 'polymarket',
      venueMarketId: `market-${uuid().slice(0, 8)}`,
      title: 'Test Market',
      status: 'active',
      acceptingOrders: true,
      ...overrides,
    };

    await this.pool.query(
      `INSERT INTO markets (
        id, event_id, venue_id, market_id, title, enable_orderbook, 
        accepting_orders, status, unified_token_id_yes, unified_token_id_no,
        normalized_yes_price, normalized_no_price, min_order_size_usd,
        tick_size, raw
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        market.id,
        eventId,
        venueId,
        market.venueMarketId,
        market.title,
        true,
        market.acceptingOrders,
        market.status,
        `${market.venue}:${market.venueMarketId}:YES`,
        `${market.venue}:${market.venueMarketId}:NO`,
        0.5,
        0.5,
        1,
        0.01,
        JSON.stringify({ test: true }),
      ]
    );

    this.testData.markets.push(market);
    return market;
  }

  async createTestTokens(marketId: string, venue: string, venueMarketId: string): Promise<TestToken[]> {
    const yesToken: TestToken = {
      tokenId: `${venue}:${venueMarketId}:YES` as UnifiedTokenId,
      marketId,
      side: 'YES',
    };

    const noToken: TestToken = {
      tokenId: `${venue}:${venueMarketId}:NO` as UnifiedTokenId,
      marketId,
      side: 'NO',
    };

    await this.pool.query(
      `INSERT INTO tokens (token_id, market_id, side) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        yesToken.tokenId,
        marketId,
        yesToken.side,
        noToken.tokenId,
        marketId,
        noToken.side,
      ]
    );

    this.testData.tokens.push(yesToken, noToken);
    return [yesToken, noToken];
  }

  async createTestOrder(userId: string, tokenId: UnifiedTokenId, overrides: Partial<TestOrder> = {}): Promise<TestOrder> {
    const order: TestOrder = {
      id: uuid(),
      userId,
      venue: 'polymarket',
      tokenId,
      side: 'BUY',
      orderType: 'LIMIT',
      price: 0.5,
      sizeUsd: 100,
      status: 'PENDING',
      ...overrides,
    };

    await this.pool.query(
      `INSERT INTO trading_orders (
        id, user_id, venue, token_id, side, order_type, price, size_usd, status,
        filled_size_usd, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        order.id,
        order.userId,
        order.venue,
        order.tokenId,
        order.side,
        order.orderType,
        order.price,
        order.sizeUsd,
        order.status,
        0,
        new Date(),
        new Date(),
      ]
    );

    this.testData.orders.push(order);
    return order;
  }

  async createTestTrade(orderId: string, userId: string, tokenId: UnifiedTokenId, overrides: Partial<TestTrade> = {}): Promise<TestTrade> {
    const trade: TestTrade = {
      id: uuid(),
      orderId,
      userId,
      venue: 'polymarket',
      tokenId,
      side: 'BUY',
      price: 0.5,
      sizeUsd: 100,
      executedAt: new Date(),
      ...overrides,
    };

    await this.pool.query(
      `INSERT INTO trading_trades (
        id, order_id, user_id, venue, token_id, side, price, size_usd,
        executed_at, created_at, fee_usd
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        trade.id,
        trade.orderId,
        trade.userId,
        trade.venue,
        trade.tokenId,
        trade.side,
        trade.price,
        trade.sizeUsd,
        trade.executedAt,
        new Date(),
        0,
      ]
    );

    this.testData.trades.push(trade);
    return trade;
  }

  async createTestPosition(userId: string, tokenId: UnifiedTokenId, overrides: Partial<TestPosition> = {}): Promise<TestPosition> {
    const position: TestPosition = {
      id: uuid(),
      userId,
      tokenId,
      side: 'YES',
      quantity: 100,
      averagePrice: 0.5,
      unrealizedPnlUsd: 0,
      realizedPnlUsd: 0,
      ...overrides,
    };

    await this.pool.query(
      `INSERT INTO user_positions (
        id, user_id, token_id, side, quantity, average_price,
        unrealized_pnl_usd, realized_pnl_usd, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        position.id,
        position.userId,
        position.tokenId,
        position.side,
        position.quantity,
        position.averagePrice,
        position.unrealizedPnlUsd,
        position.realizedPnlUsd,
        new Date(),
        new Date(),
      ]
    );

    this.testData.positions.push(position);
    return position;
  }

  async createTestWebhookEvent(webhookId: string, eventType: string, status: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_events (
        webhook_id, event_type, timestamp, data, retry_count, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        webhookId,
        eventType,
        new Date(),
        JSON.stringify({ test: true }),
        0,
        status,
        new Date(),
      ]
    );
  }

  async createTestWebhook(userId: string, overrides: Partial<TestWebhook> = {}): Promise<TestWebhook> {
    const webhook: TestWebhook = {
      id: uuid(),
      userId,
      name: 'Test Webhook',
      url: 'https://example.com/webhook',
      events: ['order.created'],
      authMethod: 'none',
      status: 'active',
      isActive: true,
      ...overrides,
    };

    await this.pool.query(
      `INSERT INTO webhooks (
        id, user_id, name, description, url, events, auth_method, auth_config,
        retry_policy, status, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        webhook.id,
        webhook.userId,
        webhook.name,
        'Test webhook description',
        webhook.url,
        JSON.stringify(webhook.events),
        webhook.authMethod,
        JSON.stringify({}),
        JSON.stringify({
          maxRetries: 3,
          retryDelay: 5000,
          backoffMultiplier: 2,
          maxRetryDelay: 60000,
        }),
        webhook.status,
        webhook.isActive,
        new Date(),
        new Date(),
      ]
    );

    this.testData.webhooks.push(webhook);
    return webhook;
  }

  // Price history utilities
  async createTestPriceHistory(tokenId: UnifiedTokenId, count: number = 10): Promise<void> {
    const baseTime = new Date();
    const prices = [0.45, 0.46, 0.47, 0.48, 0.49, 0.50, 0.51, 0.52, 0.53, 0.54];

    for (let i = 0; i < count; i++) {
      const timestamp = new Date(baseTime.getTime() + i * 60000); // 1 minute intervals
      const price = prices[i % prices.length];

      await this.pool.query(
        `INSERT INTO price_history (
          token_id, timestamp, open_price, high_price, low_price, close_price,
          volume_usd, trade_count, resolution, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          tokenId,
          timestamp,
          price,
          price + 0.01,
          price - 0.01,
          price,
          1000,
          10,
          '1m',
          new Date(),
        ]
      );
    }
  }

  // Redis utilities
  async setRedisKey(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl) {
      await this.redisClient.setEx(key, ttl, value);
    } else {
      await this.redisClient.set(key, value);
    }
  }

  async getRedisKey(key: string): Promise<string | null> {
    return await this.redisClient.get(key);
  }

  async deleteRedisKey(key: string): Promise<void> {
    await this.redisClient.del(key);
  }

  // Assertion utilities
  async assertUserExists(userId: string): Promise<void> {
    const result = await this.pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      throw new Error(`User ${userId} does not exist`);
    }
  }

  async assertOrderExists(orderId: string): Promise<void> {
    const result = await this.pool.query('SELECT id FROM trading_orders WHERE id = $1', [orderId]);
    if (result.rows.length === 0) {
      throw new Error(`Order ${orderId} does not exist`);
    }
  }

  async assertTradeExists(tradeId: string): Promise<void> {
    const result = await this.pool.query('SELECT id FROM trading_trades WHERE id = $1', [tradeId]);
    if (result.rows.length === 0) {
      throw new Error(`Trade ${tradeId} does not exist`);
    }
  }

  async assertPositionExists(positionId: string): Promise<void> {
    const result = await this.pool.query('SELECT id FROM user_positions WHERE id = $1', [positionId]);
    if (result.rows.length === 0) {
      throw new Error(`Position ${positionId} does not exist`);
    }
  }

  async assertWebhookExists(webhookId: string): Promise<void> {
    const result = await this.pool.query('SELECT id FROM webhooks WHERE id = $1', [webhookId]);
    if (result.rows.length === 0) {
      throw new Error(`Webhook ${webhookId} does not exist`);
    }
  }

  // Data retrieval utilities
  async getUser(userId: string): Promise<any> {
    const result = await this.pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    return result.rows[0];
  }

  async getOrder(orderId: string): Promise<any> {
    const result = await this.pool.query('SELECT * FROM trading_orders WHERE id = $1', [orderId]);
    return result.rows[0];
  }

  async getTrade(tradeId: string): Promise<any> {
    const result = await this.pool.query('SELECT * FROM trading_trades WHERE id = $1', [tradeId]);
    return result.rows[0];
  }

  async getPosition(positionId: string): Promise<any> {
    const result = await this.pool.query('SELECT * FROM user_positions WHERE id = $1', [positionId]);
    return result.rows[0];
  }

  async getWebhook(webhookId: string): Promise<any> {
    const result = await this.pool.query('SELECT * FROM webhooks WHERE id = $1', [webhookId]);
    return result.rows[0];
  }

  // Cleanup utilities
  async cleanup(): Promise<void> {
    await this.clearAll();
  }

  // Get test data
  getTestData() {
    return this.testData;
  }

  // Mock data generators
  generateMockOrder(overrides: Partial<UnifiedOrder> = {}): UnifiedOrder {
    return {
      id: uuid(),
      userId: uuid(),
      venue: 'polymarket',
      tokenId: 'polymarket:test:YES' as UnifiedTokenId,
      side: 'BUY',
      orderType: 'LIMIT',
      price: 0.5,
      sizeUsd: 100,
      sizeTokens: 100,
      status: 'PENDING',
      filledSizeUsd: 0,
      filledSizeTokens: 0,
      averageFillPrice: undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
      filledAt: undefined,
      cancelledAt: undefined,
      venueOrderId: undefined,
      venueTxHash: undefined,
      rawData: {},
      ...overrides,
    };
  }

  generateMockTrade(overrides: Partial<UnifiedTrade> = {}): UnifiedTrade {
    return {
      id: uuid(),
      orderId: uuid(),
      userId: uuid(),
      venue: 'polymarket',
      tokenId: 'polymarket:test:YES' as UnifiedTokenId,
      side: 'BUY',
      price: 0.5,
      sizeUsd: 100,
      sizeTokens: 100,
      executedAt: new Date(),
      createdAt: new Date(),
      venueTradeId: undefined,
      venueTxHash: undefined,
      feeUsd: 0,
      feeTokens: 0,
      rawData: {},
      ...overrides,
    };
  }

  generateMockPosition(overrides: Partial<UnifiedPosition> = {}): UnifiedPosition {
    return {
      id: uuid(),
      userId: uuid(),
      tokenId: 'polymarket:test:YES' as UnifiedTokenId,
      side: 'YES',
      quantity: 100,
      averagePrice: 0.5,
      unrealizedPnlUsd: 0,
      realizedPnlUsd: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }
}

// Test environment setup
export async function setupTestEnvironment(): Promise<{
  pool: Pool;
  redisClient: RedisClientType;
  testUtils: TestUtils;
}> {
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL || 'postgresql://hunch:hunch@localhost:5432/hunch_test',
  });

  const redisClient = createClient({
    url: process.env.TEST_REDIS_URL || 'redis://localhost:6379/1',
  });

  const testUtils = new TestUtils(pool, redisClient);
  await testUtils.connect();

  return { pool, redisClient, testUtils };
}

// Test environment teardown
export async function teardownTestEnvironment(
  pool: Pool,
  redisClient: RedisClientType,
  testUtils: TestUtils
): Promise<void> {
  await testUtils.cleanup();
  await pool.end();
  await redisClient.quit();
}

// Fastify test utilities
export async function createTestFastifyApp(app: FastifyInstance): Promise<FastifyInstance> {
  await app.ready();
  return app;
}

// HTTP test utilities
export function createTestHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  return headers;
}

// Time utilities for testing
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createDateRange(start: Date, end: Date, intervalMs: number): Date[] {
  const dates: Date[] = [];
  let current = new Date(start);

  while (current <= end) {
    dates.push(new Date(current));
    current = new Date(current.getTime() + intervalMs);
  }

  return dates;
}

// Random data generators
export function randomPrice(min: number = 0.1, max: number = 0.9): number {
  return Math.random() * (max - min) + min;
}

export function randomVolume(min: number = 100, max: number = 10000): number {
  return Math.floor(Math.random() * (max - min) + min);
}

export function randomTokenId(venue: string = 'polymarket'): UnifiedTokenId {
  const marketId = `market-${Math.random().toString(36).substr(2, 9)}`;
  const side = Math.random() > 0.5 ? 'YES' : 'NO';
  return `${venue}:${marketId}:${side}` as UnifiedTokenId;
}

// Test data factories
export class TestDataFactory {
  static createUser(overrides: Partial<TestUser> = {}): TestUser {
    return {
      id: uuid(),
      email: `test-${uuid()}@example.com`,
      username: `testuser-${uuid().slice(0, 8)}`,
      firstName: 'Test',
      lastName: 'User',
      ...overrides,
    };
  }

  static createMarket(overrides: Partial<TestMarket> = {}): TestMarket {
    return {
      id: uuid(),
      venue: 'polymarket',
      venueMarketId: `market-${uuid().slice(0, 8)}`,
      title: 'Test Market',
      status: 'active',
      acceptingOrders: true,
      ...overrides,
    };
  }

  static createOrder(overrides: Partial<TestOrder> = {}): TestOrder {
    return {
      id: uuid(),
      userId: uuid(),
      venue: 'polymarket',
      tokenId: randomTokenId(),
      side: 'BUY',
      orderType: 'LIMIT',
      price: randomPrice(),
      sizeUsd: randomVolume(),
      status: 'PENDING',
      ...overrides,
    };
  }

  static createTrade(overrides: Partial<TestTrade> = {}): TestTrade {
    return {
      id: uuid(),
      orderId: uuid(),
      userId: uuid(),
      venue: 'polymarket',
      tokenId: randomTokenId(),
      side: 'BUY',
      price: randomPrice(),
      sizeUsd: randomVolume(),
      executedAt: new Date(),
      ...overrides,
    };
  }

  static createPosition(overrides: Partial<TestPosition> = {}): TestPosition {
    return {
      id: uuid(),
      userId: uuid(),
      tokenId: randomTokenId(),
      side: 'YES',
      quantity: randomVolume(10, 1000),
      averagePrice: randomPrice(),
      unrealizedPnlUsd: 0,
      realizedPnlUsd: 0,
      ...overrides,
    };
  }

  static createWebhook(overrides: Partial<TestWebhook> = {}): TestWebhook {
    return {
      id: uuid(),
      userId: uuid(),
      name: 'Test Webhook',
      url: 'https://example.com/webhook',
      events: ['order.created'],
      authMethod: 'none',
      status: 'active',
      isActive: true,
      ...overrides,
    };
  }
}
