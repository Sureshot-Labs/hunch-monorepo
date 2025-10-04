// Test containers setup for integration testing
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer } from 'testcontainers-postgres';
import { RedisContainer } from 'testcontainers-redis';
import { Pool } from 'pg';
import { RedisClientType, createClient } from 'redis';

// Test containers configuration
export interface TestContainersConfig {
  postgres: {
    image: string;
    database: string;
    username: string;
    password: string;
    port: number;
  };
  redis: {
    image: string;
    port: number;
  };
}

// Test containers manager
export class TestContainersManager {
  private postgresContainer?: StartedTestContainer;
  private redisContainer?: StartedTestContainer;
  private config: TestContainersConfig;

  constructor(config?: Partial<TestContainersConfig>) {
    this.config = {
      postgres: {
        image: 'postgres:15-alpine',
        database: 'hunch_test',
        username: 'hunch',
        password: 'hunch',
        port: 5432,
        ...config?.postgres,
      },
      redis: {
        image: 'redis:7-alpine',
        port: 6379,
        ...config?.redis,
      },
    };
  }

  // Start all containers
  async start(): Promise<{
    postgres: StartedTestContainer;
    redis: StartedTestContainer;
    postgresUrl: string;
    redisUrl: string;
  }> {
    console.log('Starting test containers...');

    // Start PostgreSQL container
    this.postgresContainer = await new PostgreSqlContainer(this.config.postgres.image)
      .withDatabase(this.config.postgres.database)
      .withUsername(this.config.postgres.username)
      .withPassword(this.config.postgres.password)
      .withExposedPorts(this.config.postgres.port)
      .start();

    // Start Redis container
    this.redisContainer = await new RedisContainer(this.config.redis.image)
      .withExposedPorts(this.config.redis.port)
      .start();

    const postgresUrl = this.postgresContainer.getConnectionUri();
    const redisUrl = `redis://localhost:${this.redisContainer.getMappedPort(this.config.redis.port)}`;

    console.log('Test containers started successfully');
    console.log(`PostgreSQL: ${postgresUrl}`);
    console.log(`Redis: ${redisUrl}`);

    return {
      postgres: this.postgresContainer,
      redis: this.redisContainer,
      postgresUrl,
      redisUrl,
    };
  }

  // Stop all containers
  async stop(): Promise<void> {
    console.log('Stopping test containers...');

    if (this.postgresContainer) {
      await this.postgresContainer.stop();
      this.postgresContainer = undefined;
    }

    if (this.redisContainer) {
      await this.redisContainer.stop();
      this.redisContainer = undefined;
    }

    console.log('Test containers stopped successfully');
  }

  // Get PostgreSQL connection
  async getPostgresConnection(postgresUrl: string): Promise<Pool> {
    const pool = new Pool({ connectionString: postgresUrl });
    
    // Test connection
    await pool.query('SELECT 1');
    
    return pool;
  }

  // Get Redis connection
  async getRedisConnection(redisUrl: string): Promise<RedisClientType> {
    const client = createClient({ url: redisUrl });
    await client.connect();
    
    // Test connection
    await client.ping();
    
    return client;
  }

  // Setup database schema
  async setupDatabase(pool: Pool): Promise<void> {
    console.log('Setting up test database schema...');

    // Create venues table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS venues (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        api_base TEXT,
        ws_url TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        is_active BOOLEAN DEFAULT true,
        is_verified BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        last_login TIMESTAMPTZ
      )
    `);

    // Create events table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        venue_id INTEGER REFERENCES venues(id),
        event_id TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT,
        slug TEXT,
        active BOOLEAN DEFAULT true,
        closed BOOLEAN DEFAULT false,
        start_time TIMESTAMPTZ,
        end_time TIMESTAMPTZ,
        liquidity NUMERIC,
        volume_total NUMERIC,
        volume24hr NUMERIC,
        raw JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE(venue_id, event_id)
      )
    `);

    // Create markets table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS markets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id UUID REFERENCES events(id),
        venue_id INTEGER REFERENCES venues(id),
        market_id TEXT NOT NULL,
        title TEXT NOT NULL,
        enable_orderbook BOOLEAN DEFAULT true,
        accepting_orders BOOLEAN DEFAULT true,
        condition_id TEXT,
        order_price_min_tick_size NUMERIC,
        order_min_size NUMERIC,
        neg_risk BOOLEAN,
        neg_risk_market_id TEXT,
        liquidity NUMERIC,
        volume_total NUMERIC,
        volume24hr NUMERIC,
        clob_token_yes TEXT,
        clob_token_no TEXT,
        unified_token_id_yes TEXT,
        unified_token_id_no TEXT,
        normalized_yes_price NUMERIC CHECK (normalized_yes_price >= 0 AND normalized_yes_price <= 1),
        normalized_no_price NUMERIC CHECK (normalized_no_price >= 0 AND normalized_no_price <= 1),
        min_order_size_usd NUMERIC DEFAULT 1,
        max_order_size_usd NUMERIC,
        tick_size NUMERIC DEFAULT 0.01,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed', 'settled')),
        tags TEXT[] DEFAULT '{}',
        raw JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (venue_id, market_id)
      )
    `);

    // Create tokens table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tokens (
        token_id TEXT PRIMARY KEY,
        market_id UUID REFERENCES markets(id),
        side TEXT CHECK (side IN ('YES','NO')) NOT NULL,
        UNIQUE (market_id, side)
      )
    `);

    // Create user_wallets table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_wallets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        venue TEXT NOT NULL,
        wallet_address TEXT,
        balance_usd NUMERIC DEFAULT 0,
        balance_tokens NUMERIC DEFAULT 0,
        token_symbol TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE(user_id, venue)
      )
    `);

    // Create trading_orders table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trading_orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        venue TEXT NOT NULL,
        token_id TEXT REFERENCES tokens(token_id),
        side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
        order_type TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'STOP')),
        price NUMERIC CHECK (price >= 0 AND price <= 1),
        size_usd NUMERIC NOT NULL CHECK (size_usd > 0),
        size_tokens NUMERIC,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'REJECTED')),
        filled_size_usd NUMERIC DEFAULT 0,
        filled_size_tokens NUMERIC DEFAULT 0,
        average_fill_price NUMERIC,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        filled_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        venue_order_id TEXT,
        venue_tx_hash TEXT,
        raw_data JSONB,
        UNIQUE(user_id, venue_order_id)
      )
    `);

    // Create trading_trades table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trading_trades (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID REFERENCES trading_orders(id),
        user_id UUID REFERENCES users(id),
        venue TEXT NOT NULL,
        token_id TEXT REFERENCES tokens(token_id),
        side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
        price NUMERIC NOT NULL CHECK (price >= 0 AND price <= 1),
        size_usd NUMERIC NOT NULL CHECK (size_usd > 0),
        size_tokens NUMERIC,
        executed_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        venue_trade_id TEXT,
        venue_tx_hash TEXT,
        fee_usd NUMERIC DEFAULT 0,
        fee_tokens NUMERIC DEFAULT 0,
        raw_data JSONB
      )
    `);

    // Create user_positions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_positions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        token_id TEXT REFERENCES tokens(token_id),
        side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
        quantity NUMERIC NOT NULL DEFAULT 0,
        average_price NUMERIC,
        unrealized_pnl_usd NUMERIC DEFAULT 0,
        realized_pnl_usd NUMERIC DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE(user_id, token_id, side)
      )
    `);

    // Create price_history table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS price_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_id TEXT REFERENCES tokens(token_id),
        timestamp TIMESTAMPTZ NOT NULL,
        open_price NUMERIC NOT NULL CHECK (open_price >= 0 AND open_price <= 1),
        high_price NUMERIC NOT NULL CHECK (high_price >= 0 AND high_price <= 1),
        low_price NUMERIC NOT NULL CHECK (low_price >= 0 AND low_price <= 1),
        close_price NUMERIC NOT NULL CHECK (close_price >= 0 AND close_price <= 1),
        volume_usd NUMERIC NOT NULL DEFAULT 0,
        trade_count INTEGER NOT NULL DEFAULT 0,
        best_bid NUMERIC CHECK (best_bid >= 0 AND best_bid <= 1),
        best_ask NUMERIC CHECK (best_ask >= 0 AND best_ask <= 1),
        spread NUMERIC CHECK (spread >= 0),
        resolution INTERVAL NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE(token_id, timestamp, resolution)
      )
    `);

    // Create webhooks table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        url TEXT NOT NULL,
        events JSONB NOT NULL,
        auth_method TEXT NOT NULL CHECK (auth_method IN ('none', 'bearer', 'hmac', 'api_key')),
        auth_config JSONB,
        retry_policy JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled', 'failed')),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        last_triggered_at TIMESTAMPTZ,
        last_success_at TIMESTAMPTZ,
        last_failure_at TIMESTAMPTZ,
        failure_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0
      )
    `);

    // Create webhook_events table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        webhook_id UUID REFERENCES webhooks(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
        data JSONB NOT NULL,
        retry_count INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'retrying')),
        delivered_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    // Create webhook_delivery_attempts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        webhook_event_id UUID REFERENCES webhook_events(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
        status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
        response_status INTEGER,
        response_body TEXT,
        error_message TEXT,
        duration INTEGER,
        retry_after INTEGER
      )
    `);

    // Create indexes
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_events_venue_id ON events(venue_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_markets_event_id ON markets(event_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_markets_venue_id ON markets(venue_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tokens_market_id ON tokens(market_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_trading_orders_user_id ON trading_orders(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_trading_orders_token_id ON trading_orders(token_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_trading_trades_user_id ON trading_trades(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_trading_trades_token_id ON trading_trades(token_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_user_positions_user_id ON user_positions(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_user_positions_token_id ON user_positions(token_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_price_history_token_id ON price_history(token_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_price_history_timestamp ON price_history(timestamp)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_webhooks_user_id ON webhooks(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_webhook_events_webhook_id ON webhook_events(webhook_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_webhook_events_event_type ON webhook_events(event_type)');

    console.log('Test database schema setup completed');
  }

  // Cleanup database
  async cleanupDatabase(pool: Pool): Promise<void> {
    console.log('Cleaning up test database...');

    // Drop tables in reverse dependency order
    await pool.query('DROP TABLE IF EXISTS webhook_delivery_attempts CASCADE');
    await pool.query('DROP TABLE IF EXISTS webhook_events CASCADE');
    await pool.query('DROP TABLE IF EXISTS webhooks CASCADE');
    await pool.query('DROP TABLE IF EXISTS price_history CASCADE');
    await pool.query('DROP TABLE IF EXISTS user_positions CASCADE');
    await pool.query('DROP TABLE IF EXISTS trading_trades CASCADE');
    await pool.query('DROP TABLE IF EXISTS trading_orders CASCADE');
    await pool.query('DROP TABLE IF EXISTS user_wallets CASCADE');
    await pool.query('DROP TABLE IF EXISTS tokens CASCADE');
    await pool.query('DROP TABLE IF EXISTS markets CASCADE');
    await pool.query('DROP TABLE IF EXISTS events CASCADE');
    await pool.query('DROP TABLE IF EXISTS users CASCADE');
    await pool.query('DROP TABLE IF EXISTS venues CASCADE');

    console.log('Test database cleanup completed');
  }
}

// Test environment with containers
export class TestEnvironment {
  private containersManager: TestContainersManager;
  private pool?: Pool;
  private redisClient?: RedisClientType;
  private postgresUrl?: string;
  private redisUrl?: string;

  constructor(config?: Partial<TestContainersConfig>) {
    this.containersManager = new TestContainersManager(config);
  }

  // Setup test environment
  async setup(): Promise<{
    pool: Pool;
    redisClient: RedisClientType;
    postgresUrl: string;
    redisUrl: string;
  }> {
    const { postgres, redis, postgresUrl, redisUrl } = await this.containersManager.start();

    this.postgresUrl = postgresUrl;
    this.redisUrl = redisUrl;

    this.pool = await this.containersManager.getPostgresConnection(postgresUrl);
    this.redisClient = await this.containersManager.getRedisConnection(redisUrl);

    await this.containersManager.setupDatabase(this.pool);

    return {
      pool: this.pool,
      redisClient: this.redisClient,
      postgresUrl,
      redisUrl,
    };
  }

  // Teardown test environment
  async teardown(): Promise<void> {
    if (this.pool) {
      await this.containersManager.cleanupDatabase(this.pool);
      await this.pool.end();
    }

    if (this.redisClient) {
      await this.redisClient.quit();
    }

    await this.containersManager.stop();
  }

  // Get connections
  getPool(): Pool {
    if (!this.pool) {
      throw new Error('Test environment not setup');
    }
    return this.pool;
  }

  getRedisClient(): RedisClientType {
    if (!this.redisClient) {
      throw new Error('Test environment not setup');
    }
    return this.redisClient;
  }

  getPostgresUrl(): string {
    if (!this.postgresUrl) {
      throw new Error('Test environment not setup');
    }
    return this.postgresUrl;
  }

  getRedisUrl(): string {
    if (!this.redisUrl) {
      throw new Error('Test environment not setup');
    }
    return this.redisUrl;
  }
}

// Global test environment instance
let globalTestEnvironment: TestEnvironment | null = null;

// Setup global test environment
export async function setupGlobalTestEnvironment(): Promise<TestEnvironment> {
  if (!globalTestEnvironment) {
    globalTestEnvironment = new TestEnvironment();
    await globalTestEnvironment.setup();
  }
  return globalTestEnvironment;
}

// Teardown global test environment
export async function teardownGlobalTestEnvironment(): Promise<void> {
  if (globalTestEnvironment) {
    await globalTestEnvironment.teardown();
    globalTestEnvironment = null;
  }
}

// Get global test environment
export function getGlobalTestEnvironment(): TestEnvironment {
  if (!globalTestEnvironment) {
    throw new Error('Global test environment not setup');
  }
  return globalTestEnvironment;
}
