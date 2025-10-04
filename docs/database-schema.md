# Hunch Platform Database Schema

Complete database schema documentation for all tables, relationships, and data structures.

## 📋 Table of Contents

1. [Core Tables](#core-tables)
2. [Trading Tables](#trading-tables)
3. [Price History Tables](#price-history-tables)
4. [Webhook Tables](#webhook-tables)
5. [Monitoring Tables](#monitoring-tables)
6. [Views and Aggregates](#views-and-aggregates)
7. [Indexes](#indexes)
8. [Triggers](#triggers)

---

## 🏗️ Core Tables

### venues
Stores exchange/venue information.

```sql
CREATE TABLE venues (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE, -- 'polymarket', 'kalshi', 'limitless'
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    api_base_url TEXT,
    websocket_url TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Fields:**
- `id`: Primary key
- `name`: Unique venue identifier
- `display_name`: Human-readable name
- `description`: Venue description
- `api_base_url`: Base URL for API calls
- `websocket_url`: WebSocket connection URL
- `is_active`: Whether venue is active
- `created_at`: Record creation timestamp
- `updated_at`: Record update timestamp

### events
Stores prediction market events.

```sql
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id INTEGER NOT NULL REFERENCES venues(id),
    venue_event_id VARCHAR(255) NOT NULL,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    tags TEXT[],
    status VARCHAR(50) NOT NULL DEFAULT 'active', -- 'active', 'paused', 'closed', 'settled'
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    resolution_criteria TEXT,
    outcome VARCHAR(50), -- 'YES', 'NO', 'CANCELLED'
    raw_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(venue_id, venue_event_id)
);
```

**Fields:**
- `id`: Primary key (UUID)
- `venue_id`: Foreign key to venues
- `venue_event_id`: Event ID from venue
- `title`: Event title
- `description`: Event description
- `category`: Event category
- `tags`: Array of tags
- `status`: Event status
- `start_time`: Event start time
- `end_time`: Event end time
- `resolution_criteria`: How event will be resolved
- `outcome`: Final outcome
- `raw_data`: Original venue data
- `created_at`: Record creation timestamp
- `updated_at`: Record update timestamp

### markets
Stores individual prediction markets.

```sql
CREATE TABLE markets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id INTEGER NOT NULL REFERENCES venues(id),
    event_id UUID NOT NULL REFERENCES events(id),
    venue_market_id VARCHAR(255) NOT NULL,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'active', -- 'active', 'paused', 'closed', 'settled'
    accepting_orders BOOLEAN NOT NULL DEFAULT TRUE,
    min_order_size DECIMAL(20,8) NOT NULL DEFAULT 1,
    tick_size DECIMAL(20,8) NOT NULL DEFAULT 0.01,
    max_order_size DECIMAL(20,8),
    liquidity DECIMAL(20,8) DEFAULT 0,
    volume_24h DECIMAL(20,8) DEFAULT 0,
    volume_total DECIMAL(20,8) DEFAULT 0,
    raw_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(venue_id, venue_market_id)
);
```

**Fields:**
- `id`: Primary key (UUID)
- `venue_id`: Foreign key to venues
- `event_id`: Foreign key to events
- `venue_market_id`: Market ID from venue
- `title`: Market title
- `description`: Market description
- `status`: Market status
- `accepting_orders`: Whether accepting new orders
- `min_order_size`: Minimum order size
- `tick_size`: Price tick size
- `max_order_size`: Maximum order size
- `liquidity`: Current liquidity
- `volume_24h`: 24-hour volume
- `volume_total`: Total volume
- `raw_data`: Original venue data
- `created_at`: Record creation timestamp
- `updated_at`: Record update timestamp

### tokens
Stores market tokens (YES/NO outcomes).

```sql
CREATE TABLE tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id UUID NOT NULL REFERENCES markets(id),
    venue_token_id VARCHAR(255) NOT NULL,
    side VARCHAR(10) NOT NULL, -- 'YES', 'NO'
    token_address VARCHAR(255),
    decimals INTEGER DEFAULT 18,
    raw_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(market_id, side)
);
```

**Fields:**
- `id`: Primary key (UUID)
- `market_id`: Foreign key to markets
- `venue_token_id`: Token ID from venue
- `side`: Token side (YES/NO)
- `token_address`: Blockchain token address
- `decimals`: Token decimals
- `raw_data`: Original venue data
- `created_at`: Record creation timestamp
- `updated_at`: Record update timestamp

---

## 💼 Trading Tables

### users
Stores user accounts.

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    role VARCHAR(50) NOT NULL DEFAULT 'user', -- 'user', 'admin'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Fields:**
- `id`: Primary key (UUID)
- `email`: User email (unique)
- `username`: Username (unique)
- `password_hash`: Hashed password
- `first_name`: User first name
- `last_name`: User last name
- `is_active`: Whether user is active
- `is_verified`: Whether user is verified
- `role`: User role
- `created_at`: Record creation timestamp
- `updated_at`: Record update timestamp

### wallets
Stores user wallet addresses for each venue.

```sql
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    venue_id INTEGER NOT NULL REFERENCES venues(id),
    address VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, venue_id)
);
```

**Fields:**
- `id`: Primary key (UUID)
- `user_id`: Foreign key to users
- `venue_id`: Foreign key to venues
- `address`: Wallet address
- `is_active`: Whether wallet is active
- `created_at`: Record creation timestamp
- `updated_at`: Record update timestamp

### orders
Stores user trading orders.

```sql
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    venue_id INTEGER NOT NULL REFERENCES venues(id),
    token_id UUID NOT NULL REFERENCES tokens(id),
    venue_order_id VARCHAR(255),
    side VARCHAR(10) NOT NULL, -- 'BUY', 'SELL'
    order_type VARCHAR(20) NOT NULL, -- 'MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'
    price DECIMAL(20,8),
    size_usd DECIMAL(20,8) NOT NULL,
    size_tokens DECIMAL(20,8),
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'REJECTED'
    filled_size_usd DECIMAL(20,8) DEFAULT 0,
    filled_size_tokens DECIMAL(20,8) DEFAULT 0,
    average_fill_price DECIMAL(20,8),
    time_in_force VARCHAR(20) NOT NULL DEFAULT 'GTC', -- 'GTC', 'IOC', 'FOK'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    filled_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    venue_tx_hash VARCHAR(255),
    raw_data JSONB
);
```

**Fields:**
- `id`: Primary key (UUID)
- `user_id`: Foreign key to users
- `venue_id`: Foreign key to venues
- `token_id`: Foreign key to tokens
- `venue_order_id`: Order ID from venue
- `side`: Order side (BUY/SELL)
- `order_type`: Order type
- `price`: Order price
- `size_usd`: Order size in USD
- `size_tokens`: Order size in tokens
- `status`: Order status
- `filled_size_usd`: Filled size in USD
- `filled_size_tokens`: Filled size in tokens
- `average_fill_price`: Average fill price
- `time_in_force`: Time in force
- `created_at`: Record creation timestamp
- `updated_at`: Record update timestamp
- `filled_at`: Fill timestamp
- `cancelled_at`: Cancellation timestamp
- `venue_tx_hash`: Venue transaction hash
- `raw_data`: Original venue data

### trades
Stores executed trades.

```sql
CREATE TABLE trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    venue_id INTEGER NOT NULL REFERENCES venues(id),
    token_id UUID NOT NULL REFERENCES tokens(id),
    venue_trade_id VARCHAR(255),
    side VARCHAR(10) NOT NULL, -- 'BUY', 'SELL'
    price DECIMAL(20,8) NOT NULL,
    size_usd DECIMAL(20,8) NOT NULL,
    size_tokens DECIMAL(20,8) NOT NULL,
    fee_usd DECIMAL(20,8) DEFAULT 0,
    fee_tokens DECIMAL(20,8) DEFAULT 0,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    venue_tx_hash VARCHAR(255),
    raw_data JSONB
);
```

**Fields:**
- `id`: Primary key (UUID)
- `order_id`: Foreign key to orders
- `user_id`: Foreign key to users
- `venue_id`: Foreign key to venues
- `token_id`: Foreign key to tokens
- `venue_trade_id`: Trade ID from venue
- `side`: Trade side (BUY/SELL)
- `price`: Trade price
- `size_usd`: Trade size in USD
- `size_tokens`: Trade size in tokens
- `fee_usd`: Fee in USD
- `fee_tokens`: Fee in tokens
- `executed_at`: Execution timestamp
- `created_at`: Record creation timestamp
- `venue_tx_hash`: Venue transaction hash
- `raw_data`: Original venue data

### positions
Stores user positions in markets.

```sql
CREATE TABLE positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_id UUID NOT NULL REFERENCES tokens(id),
    side VARCHAR(10) NOT NULL, -- 'YES', 'NO'
    quantity DECIMAL(20,8) NOT NULL DEFAULT 0,
    average_price DECIMAL(20,8) NOT NULL DEFAULT 0,
    unrealized_pnl_usd DECIMAL(20,8) DEFAULT 0,
    realized_pnl_usd DECIMAL(20,8) DEFAULT 0,
    market_value DECIMAL(20,8) DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, token_id)
);
```

**Fields:**
- `id`: Primary key (UUID)
- `user_id`: Foreign key to users
- `token_id`: Foreign key to tokens
- `side`: Position side (YES/NO)
- `quantity`: Position quantity
- `average_price`: Average entry price
- `unrealized_pnl_usd`: Unrealized P&L in USD
- `realized_pnl_usd`: Realized P&L in USD
- `market_value`: Current market value
- `created_at`: Record creation timestamp
- `updated_at`: Record update timestamp

---

## 📈 Price History Tables

### price_history
Stores historical price data.

```sql
CREATE TABLE price_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID NOT NULL REFERENCES tokens(id),
    timestamp TIMESTAMPTZ NOT NULL,
    resolution VARCHAR(10) NOT NULL, -- '1m', '5m', '1h', '1d', '1w'
    open DECIMAL(20,8) NOT NULL,
    high DECIMAL(20,8) NOT NULL,
    low DECIMAL(20,8) NOT NULL,
    close DECIMAL(20,8) NOT NULL,
    volume DECIMAL(20,8) DEFAULT 0,
    trade_count INTEGER DEFAULT 0,
    best_bid DECIMAL(20,8),
    best_ask DECIMAL(20,8),
    spread DECIMAL(20,8),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(token_id, timestamp, resolution)
);
```

**Fields:**
- `id`: Primary key (UUID)
- `token_id`: Foreign key to tokens
- `timestamp`: Price timestamp
- `resolution`: Time resolution
- `open`: Opening price
- `high`: High price
- `low`: Low price
- `close`: Closing price
- `volume`: Trading volume
- `trade_count`: Number of trades
- `best_bid`: Best bid price
- `best_ask`: Best ask price
- `spread`: Bid-ask spread
- `created_at`: Record creation timestamp

### book_top
Stores top of order book data.

```sql
CREATE TABLE book_top (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID NOT NULL REFERENCES tokens(id),
    timestamp TIMESTAMPTZ NOT NULL,
    resolution VARCHAR(10) NOT NULL DEFAULT '1m',
    best_bid DECIMAL(20,8),
    best_bid_size DECIMAL(20,8),
    best_ask DECIMAL(20,8),
    best_ask_size DECIMAL(20,8),
    spread DECIMAL(20,8),
    mid_price DECIMAL(20,8),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Fields:**
- `id`: Primary key (UUID)
- `token_id`: Foreign key to tokens
- `timestamp`: Data timestamp
- `resolution`: Time resolution
- `best_bid`: Best bid price
- `best_bid_size`: Best bid size
- `best_ask`: Best ask price
- `best_ask_size`: Best ask size
- `spread`: Bid-ask spread
- `mid_price`: Mid price
- `created_at`: Record creation timestamp

### last_trade
Stores last trade data.

```sql
CREATE TABLE last_trade (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id UUID NOT NULL REFERENCES tokens(id),
    timestamp TIMESTAMPTZ NOT NULL,
    resolution VARCHAR(10) NOT NULL DEFAULT '1m',
    price DECIMAL(20,8) NOT NULL,
    size DECIMAL(20,8) NOT NULL,
    side VARCHAR(10) NOT NULL, -- 'BUY', 'SELL'
    trade_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Fields:**
- `id`: Primary key (UUID)
- `token_id`: Foreign key to tokens
- `timestamp`: Trade timestamp
- `resolution`: Time resolution
- `price`: Trade price
- `size`: Trade size
- `side`: Trade side (BUY/SELL)
- `trade_id`: Trade ID
- `created_at`: Record creation timestamp

---

## 🔗 Webhook Tables

### webhooks
Stores webhook configurations.

```sql
CREATE TABLE webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    url TEXT NOT NULL,
    events TEXT[] NOT NULL, -- Array of event types
    auth_method VARCHAR(50) NOT NULL DEFAULT 'none', -- 'none', 'bearer', 'hmac', 'api_key'
    auth_config JSONB, -- Stores auth configuration
    retry_policy JSONB NOT NULL DEFAULT '{"maxRetries": 3, "retryDelay": 5000, "backoffMultiplier": 2, "maxRetryDelay": 60000}',
    status VARCHAR(50) NOT NULL DEFAULT 'active', -- 'active', 'paused', 'disabled', 'failed'
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Fields:**
- `id`: Primary key (UUID)
- `user_id`: Foreign key to users
- `name`: Webhook name
- `description`: Webhook description
- `url`: Webhook URL
- `events`: Array of event types
- `auth_method`: Authentication method
- `auth_config`: Authentication configuration
- `retry_policy`: Retry policy configuration
- `status`: Webhook status
- `is_active`: Whether webhook is active
- `created_at`: Record creation timestamp
- `updated_at`: Record update timestamp

### webhook_events
Stores webhook events.

```sql
CREATE TABLE webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_type VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'succeeded', 'failed'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Fields:**
- `id`: Primary key (UUID)
- `webhook_id`: Foreign key to webhooks
- `event_type`: Event type
- `payload`: Event payload
- `status`: Event status
- `created_at`: Record creation timestamp
- `updated_at`: Record update timestamp

### webhook_delivery_attempts
Stores webhook delivery attempts.

```sql
CREATE TABLE webhook_delivery_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    status_code INTEGER,
    response_body TEXT,
    error_message TEXT,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_attempt_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Fields:**
- `id`: Primary key (UUID)
- `event_id`: Foreign key to webhook_events
- `attempt_number`: Attempt number
- `status_code`: HTTP status code
- `response_body`: Response body
- `error_message`: Error message
- `attempted_at`: Attempt timestamp
- `next_attempt_at`: Next attempt timestamp
- `created_at`: Record creation timestamp

---

## 📊 Monitoring Tables

### metrics
Stores system metrics.

```sql
CREATE TABLE metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service VARCHAR(255) NOT NULL,
    metric_name VARCHAR(255) NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    labels JSONB DEFAULT '{}',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Fields:**
- `id`: Primary key (UUID)
- `service`: Service name
- `metric_name`: Metric name
- `value`: Metric value
- `labels`: Metric labels
- `timestamp`: Metric timestamp

### health_checks
Stores health check results.

```sql
CREATE TABLE health_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL, -- 'healthy', 'degraded', 'unhealthy', 'unknown'
    message TEXT,
    details JSONB,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Fields:**
- `id`: Primary key (UUID)
- `service`: Service name
- `status`: Health status
- `message`: Status message
- `details`: Additional details
- `timestamp`: Check timestamp

### alert_definitions
Stores alert definitions.

```sql
CREATE TABLE alert_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    severity VARCHAR(50) NOT NULL, -- 'info', 'warning', 'critical'
    conditions JSONB NOT NULL, -- Alert conditions
    actions JSONB NOT NULL, -- Alert actions
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Fields:**
- `id`: Primary key (UUID)
- `name`: Alert name (unique)
- `description`: Alert description
- `severity`: Alert severity
- `conditions`: Alert conditions
- `actions`: Alert actions
- `is_active`: Whether alert is active
- `created_at`: Record creation timestamp
- `updated_at`: Record update timestamp

### alert_instances
Stores alert instances.

```sql
CREATE TABLE alert_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_definition_id UUID NOT NULL REFERENCES alert_definitions(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL, -- 'firing', 'resolved', 'acknowledged', 'silenced'
    severity VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL,
    silenced_until TIMESTAMPTZ,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Fields:**
- `id`: Primary key (UUID)
- `alert_definition_id`: Foreign key to alert_definitions
- `status`: Alert status
- `severity`: Alert severity
- `title`: Alert title
- `description`: Alert description
- `fired_at`: Alert fired timestamp
- `resolved_at`: Alert resolved timestamp
- `acknowledged_by`: User who acknowledged
- `silenced_until`: Silence until timestamp
- `metadata`: Additional metadata
- `created_at`: Record creation timestamp
- `updated_at`: Record update timestamp

---

## 📊 Views and Aggregates

### price_aggregations_1m
1-minute price aggregations.

```sql
CREATE MATERIALIZED VIEW price_aggregations_1m AS
SELECT 
    token_id,
    time_bucket('1 minute', timestamp) AS bucket,
    resolution,
    first(open, timestamp) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, timestamp) AS close,
    sum(volume) AS volume,
    sum(trade_count) AS trade_count,
    avg(best_bid) AS avg_best_bid,
    avg(best_ask) AS avg_best_ask,
    avg(spread) AS avg_spread
FROM price_history
GROUP BY token_id, bucket, resolution;
```

### price_aggregations_5m
5-minute price aggregations.

```sql
CREATE MATERIALIZED VIEW price_aggregations_5m AS
SELECT 
    token_id,
    time_bucket('5 minutes', timestamp) AS bucket,
    resolution,
    first(open, timestamp) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, timestamp) AS close,
    sum(volume) AS volume,
    sum(trade_count) AS trade_count,
    avg(best_bid) AS avg_best_bid,
    avg(best_ask) AS avg_best_ask,
    avg(spread) AS avg_spread
FROM price_history
GROUP BY token_id, bucket, resolution;
```

### price_aggregations_1h
1-hour price aggregations.

```sql
CREATE MATERIALIZED VIEW price_aggregations_1h AS
SELECT 
    token_id,
    time_bucket('1 hour', timestamp) AS bucket,
    resolution,
    first(open, timestamp) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, timestamp) AS close,
    sum(volume) AS volume,
    sum(trade_count) AS trade_count,
    avg(best_bid) AS avg_best_bid,
    avg(best_ask) AS avg_best_ask,
    avg(spread) AS avg_spread
FROM price_history
GROUP BY token_id, bucket, resolution;
```

### price_aggregations_1d
1-day price aggregations.

```sql
CREATE MATERIALIZED VIEW price_aggregations_1d AS
SELECT 
    token_id,
    time_bucket('1 day', timestamp) AS bucket,
    resolution,
    first(open, timestamp) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, timestamp) AS close,
    sum(volume) AS volume,
    sum(trade_count) AS trade_count,
    avg(best_bid) AS avg_best_bid,
    avg(best_ask) AS avg_best_ask,
    avg(spread) AS avg_spread
FROM price_history
GROUP BY token_id, bucket, resolution;
```

### price_aggregations_1w
1-week price aggregations.

```sql
CREATE MATERIALIZED VIEW price_aggregations_1w AS
SELECT 
    token_id,
    time_bucket('1 week', timestamp) AS bucket,
    resolution,
    first(open, timestamp) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, timestamp) AS close,
    sum(volume) AS volume,
    sum(trade_count) AS trade_count,
    avg(best_bid) AS avg_best_bid,
    avg(best_ask) AS avg_best_ask,
    avg(spread) AS avg_spread
FROM price_history
GROUP BY token_id, bucket, resolution;
```

### price_aggregations_1M
1-month price aggregations.

```sql
CREATE MATERIALIZED VIEW price_aggregations_1M AS
SELECT 
    token_id,
    time_bucket('1 month', timestamp) AS bucket,
    resolution,
    first(open, timestamp) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, timestamp) AS close,
    sum(volume) AS volume,
    sum(trade_count) AS trade_count,
    avg(best_bid) AS avg_best_bid,
    avg(best_ask) AS avg_best_ask,
    avg(spread) AS avg_spread
FROM price_history
GROUP BY token_id, bucket, resolution;
```

---

## 🔍 Indexes

### Primary Indexes
```sql
-- Core tables
CREATE INDEX idx_events_venue_id ON events(venue_id);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_end_time ON events(end_time);

CREATE INDEX idx_markets_venue_id ON markets(venue_id);
CREATE INDEX idx_markets_event_id ON markets(event_id);
CREATE INDEX idx_markets_status ON markets(status);

CREATE INDEX idx_tokens_market_id ON tokens(market_id);
CREATE INDEX idx_tokens_side ON tokens(side);

-- Trading tables
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_token_id ON orders(token_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);

CREATE INDEX idx_trades_user_id ON trades(user_id);
CREATE INDEX idx_trades_token_id ON trades(token_id);
CREATE INDEX idx_trades_executed_at ON trades(executed_at);

CREATE INDEX idx_positions_user_id ON positions(user_id);
CREATE INDEX idx_positions_token_id ON positions(token_id);

-- Price history tables
CREATE INDEX idx_price_history_token_id ON price_history(token_id);
CREATE INDEX idx_price_history_timestamp ON price_history(timestamp);
CREATE INDEX idx_price_history_resolution ON price_history(resolution);

CREATE INDEX idx_book_top_token_id ON book_top(token_id);
CREATE INDEX idx_book_top_timestamp ON book_top(timestamp);

CREATE INDEX idx_last_trade_token_id ON last_trade(token_id);
CREATE INDEX idx_last_trade_timestamp ON last_trade(timestamp);

-- Webhook tables
CREATE INDEX idx_webhooks_user_id ON webhooks(user_id);
CREATE INDEX idx_webhooks_status ON webhooks(status);

CREATE INDEX idx_webhook_events_webhook_id ON webhook_events(webhook_id);
CREATE INDEX idx_webhook_events_status ON webhook_events(status);
CREATE INDEX idx_webhook_events_event_type ON webhook_events(event_type);

CREATE INDEX idx_webhook_delivery_attempts_event_id ON webhook_delivery_attempts(event_id);
CREATE INDEX idx_webhook_delivery_attempts_next_attempt_at ON webhook_delivery_attempts(next_attempt_at);

-- Monitoring tables
CREATE INDEX idx_metrics_service ON metrics(service);
CREATE INDEX idx_metrics_metric_name ON metrics(metric_name);
CREATE INDEX idx_metrics_timestamp ON metrics(timestamp);

CREATE INDEX idx_health_checks_service ON health_checks(service);
CREATE INDEX idx_health_checks_status ON health_checks(status);
CREATE INDEX idx_health_checks_timestamp ON health_checks(timestamp);

CREATE INDEX idx_alert_instances_alert_definition_id ON alert_instances(alert_definition_id);
CREATE INDEX idx_alert_instances_status ON alert_instances(status);
CREATE INDEX idx_alert_instances_fired_at ON alert_instances(fired_at);
```

### Composite Indexes
```sql
-- Composite indexes for common queries
CREATE INDEX idx_price_history_token_timestamp ON price_history(token_id, timestamp);
CREATE INDEX idx_price_history_token_resolution_timestamp ON price_history(token_id, resolution, timestamp);

CREATE INDEX idx_orders_user_status_created ON orders(user_id, status, created_at);
CREATE INDEX idx_trades_user_executed ON trades(user_id, executed_at);

CREATE INDEX idx_webhook_events_webhook_status ON webhook_events(webhook_id, status);
CREATE INDEX idx_webhook_delivery_attempts_event_attempt ON webhook_delivery_attempts(event_id, attempt_number);
```

---

## ⚡ Triggers

### Update Positions on Trade
```sql
CREATE OR REPLACE FUNCTION update_positions_on_trade()
RETURNS TRIGGER AS $$
BEGIN
    -- Update or insert position based on trade
    INSERT INTO positions (user_id, token_id, side, quantity, average_price, market_value)
    VALUES (
        NEW.user_id,
        NEW.token_id,
        CASE WHEN NEW.side = 'BUY' THEN 'YES' ELSE 'NO' END,
        NEW.size_tokens,
        NEW.price,
        NEW.size_usd
    )
    ON CONFLICT (user_id, token_id)
    DO UPDATE SET
        quantity = positions.quantity + NEW.size_tokens,
        average_price = (positions.quantity * positions.average_price + NEW.size_tokens * NEW.price) / (positions.quantity + NEW.size_tokens),
        market_value = positions.market_value + NEW.size_usd,
        updated_at = NOW();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_positions_on_trade
    AFTER INSERT ON trades
    FOR EACH ROW
    EXECUTE FUNCTION update_positions_on_trade();
```

### Update Wallet Balances on Trade
```sql
CREATE OR REPLACE FUNCTION update_wallet_balances_on_trade()
RETURNS TRIGGER AS $$
BEGIN
    -- Update wallet balances based on trade
    -- This would typically involve updating a wallet_balances table
    -- For now, we'll just log the trade
    INSERT INTO wallet_balance_changes (user_id, venue_id, amount, change_type, trade_id)
    VALUES (
        NEW.user_id,
        NEW.venue_id,
        NEW.size_usd,
        CASE WHEN NEW.side = 'BUY' THEN 'DEBIT' ELSE 'CREDIT' END,
        NEW.id
    );
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_wallet_balances_on_trade
    AFTER INSERT ON trades
    FOR EACH ROW
    EXECUTE FUNCTION update_wallet_balances_on_trade();
```

---

## 📊 Data Types Reference

### Common Data Types
- `UUID`: Universally unique identifier
- `TIMESTAMPTZ`: Timestamp with timezone
- `DECIMAL(20,8)`: High precision decimal for prices and amounts
- `VARCHAR(n)`: Variable character string
- `TEXT`: Unlimited text
- `JSONB`: Binary JSON for flexible data storage
- `BOOLEAN`: True/false values
- `INTEGER`: Whole numbers
- `DOUBLE PRECISION`: Floating point numbers

### Enums and Constants
- **Order Status**: PENDING, FILLED, PARTIALLY_FILLED, CANCELLED, REJECTED
- **Order Side**: BUY, SELL
- **Order Type**: MARKET, LIMIT, STOP, STOP_LIMIT
- **Time in Force**: GTC, IOC, FOK
- **Token Side**: YES, NO
- **Market Status**: active, paused, closed, settled
- **Event Status**: active, paused, closed, settled
- **Webhook Status**: active, paused, disabled, failed
- **Health Status**: healthy, degraded, unhealthy, unknown
- **Alert Status**: firing, resolved, acknowledged, silenced
- **Alert Severity**: info, warning, critical

---

This comprehensive database schema documentation provides everything needed to understand the data structure, relationships, and constraints of the Hunch platform database.