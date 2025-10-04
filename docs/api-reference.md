# Hunch Platform API Reference

Complete API documentation for UI integration with all endpoints, WebSocket connections, input/output schemas, and examples.

## 📋 Table of Contents

1. [Authentication](#authentication)
2. [API Gateway Endpoints](#api-gateway-endpoints)
3. [Trading Engine API](#trading-engine-api)
4. [Analytics Engine API](#analytics-engine-api)
5. [Webhook System API](#webhook-system-api)
6. [Price History API](#price-history-api)
7. [Data Ingestion API](#data-ingestion-api)
8. [Monitoring API](#monitoring-api)
9. [WebSocket Connections](#websocket-connections)
10. [Error Handling](#error-handling)
11. [Rate Limiting](#rate-limiting)

---

## 🔐 Authentication

### JWT Token Authentication

All API endpoints require JWT authentication except health checks and public endpoints.

**Headers:**
```http
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

**Token Structure:**
```json
{
  "sub": "user_uuid",
  "email": "user@example.com",
  "role": "user|admin",
  "iat": 1640995200,
  "exp": 1641081600
}
```

---

## 🌐 API Gateway Endpoints

**Base URL:** `http://localhost:3000/api`

### Health Check
```http
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T12:00:00Z",
  "services": {
    "database": "healthy",
    "redis": "healthy",
    "trading-engine": "healthy"
  },
  "uptime": 3600,
  "version": "1.0.0"
}
```

### Market Data Feed
```http
GET /markets
GET /markets?venue=polymarket
GET /markets?status=active
GET /markets?category=politics
```

**Query Parameters:**
- `venue`: polymarket, kalshi, limitless
- `status`: active, paused, closed, settled
- `category`: politics, sports, economics, etc.
- `limit`: number of results (default: 50)
- `offset`: pagination offset (default: 0)

**Response:**
```json
{
  "markets": [
    {
      "id": "polymarket:market123",
      "venue": "polymarket",
      "venueMarketId": "market123",
      "venueEventId": "event456",
      "title": "Will Biden win 2024 election?",
      "description": "Prediction market for 2024 US Presidential Election",
      "category": "politics",
      "tags": ["election", "politics", "2024"],
      "status": "active",
      "acceptingOrders": true,
      "startTime": "2024-01-01T00:00:00Z",
      "endTime": "2024-11-05T23:59:59Z",
      "yesPrice": 0.65,
      "noPrice": 0.35,
      "liquidity": 1000000,
      "volume24h": 50000,
      "volumeTotal": 500000,
      "bestBid": 0.64,
      "bestAsk": 0.66,
      "spread": 0.02,
      "midPrice": 0.65,
      "yesTokenId": "polymarket:market123:YES",
      "noTokenId": "polymarket:market123:NO",
      "minOrderSize": 1,
      "tickSize": 0.01,
      "maxOrderSize": 100000,
      "lastUpdated": "2024-01-01T12:00:00Z",
      "createdAt": "2024-01-01T00:00:00Z"
    }
  ],
  "pagination": {
    "total": 150,
    "limit": 50,
    "offset": 0,
    "hasMore": true
  }
}
```

### Market Details
```http
GET /markets/{marketId}
```

**Response:**
```json
{
  "market": {
    "id": "polymarket:market123",
    "venue": "polymarket",
    "venueMarketId": "market123",
    "venueEventId": "event456",
    "title": "Will Biden win 2024 election?",
    "description": "Prediction market for 2024 US Presidential Election",
    "category": "politics",
    "tags": ["election", "politics", "2024"],
    "status": "active",
    "acceptingOrders": true,
    "startTime": "2024-01-01T00:00:00Z",
    "endTime": "2024-11-05T23:59:59Z",
    "yesPrice": 0.65,
    "noPrice": 0.35,
    "liquidity": 1000000,
    "volume24h": 50000,
    "volumeTotal": 500000,
    "bestBid": 0.64,
    "bestAsk": 0.66,
    "spread": 0.02,
    "midPrice": 0.65,
    "yesTokenId": "polymarket:market123:YES",
    "noTokenId": "polymarket:market123:NO",
    "minOrderSize": 1,
    "tickSize": 0.01,
    "maxOrderSize": 100000,
    "orderBook": {
      "bids": [
        { "price": 0.64, "size": 1000 },
        { "price": 0.63, "size": 2000 }
      ],
      "asks": [
        { "price": 0.66, "size": 1500 },
        { "price": 0.67, "size": 2500 }
      ]
    },
    "recentTrades": [
      {
        "id": "trade123",
        "price": 0.65,
        "size": 500,
        "side": "BUY",
        "timestamp": "2024-01-01T12:00:00Z"
      }
    ],
    "lastUpdated": "2024-01-01T12:00:00Z",
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

### Price Stream (Server-Sent Events)
```http
GET /prices/stream
```

**Headers:**
```http
Accept: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**Event Stream:**
```
data: {"type":"price_update","marketId":"polymarket:market123","yesPrice":0.65,"noPrice":0.35,"timestamp":"2024-01-01T12:00:00Z"}

data: {"type":"trade","marketId":"polymarket:market123","price":0.66,"size":1000,"side":"BUY","timestamp":"2024-01-01T12:01:00Z"}
```

---

## 💼 Trading Engine API

**Base URL:** `http://localhost:3001`

### Create Order
```http
POST /orders
```

**Request Body:**
```json
{
  "venue": "polymarket",
  "tokenId": "polymarket:market123:YES",
  "side": "BUY",
  "orderType": "LIMIT",
  "price": 0.65,
  "sizeUsd": 100,
  "timeInForce": "GTC"
}
```

**Response:**
```json
{
  "order": {
    "id": "order_uuid",
    "userId": "user_uuid",
    "venue": "polymarket",
    "tokenId": "polymarket:market123:YES",
    "side": "BUY",
    "orderType": "LIMIT",
    "price": 0.65,
    "sizeUsd": 100,
    "sizeTokens": 153.85,
    "status": "PENDING",
    "filledSizeUsd": 0,
    "filledSizeTokens": 0,
    "averageFillPrice": null,
    "createdAt": "2024-01-01T12:00:00Z",
    "updatedAt": "2024-01-01T12:00:00Z",
    "filledAt": null,
    "cancelledAt": null,
    "venueOrderId": "venue_order_123",
    "venueTxHash": null,
    "rawData": {}
  }
}
```

### Get User Orders
```http
GET /orders
GET /orders?status=PENDING
GET /orders?venue=polymarket
GET /orders?tokenId=polymarket:market123:YES
```

**Query Parameters:**
- `status`: PENDING, FILLED, PARTIALLY_FILLED, CANCELLED, REJECTED
- `venue`: polymarket, kalshi, limitless
- `tokenId`: specific token ID
- `limit`: number of results (default: 50)
- `offset`: pagination offset (default: 0)

**Response:**
```json
{
  "orders": [
    {
      "id": "order_uuid",
      "userId": "user_uuid",
      "venue": "polymarket",
      "tokenId": "polymarket:market123:YES",
      "side": "BUY",
      "orderType": "LIMIT",
      "price": 0.65,
      "sizeUsd": 100,
      "sizeTokens": 153.85,
      "status": "FILLED",
      "filledSizeUsd": 100,
      "filledSizeTokens": 153.85,
      "averageFillPrice": 0.65,
      "createdAt": "2024-01-01T12:00:00Z",
      "updatedAt": "2024-01-01T12:01:00Z",
      "filledAt": "2024-01-01T12:01:00Z",
      "cancelledAt": null,
      "venueOrderId": "venue_order_123",
      "venueTxHash": "0x123...",
      "rawData": {}
    }
  ],
  "pagination": {
    "total": 25,
    "limit": 50,
    "offset": 0,
    "hasMore": false
  }
}
```

### Cancel Order
```http
DELETE /orders/{orderId}
```

**Response:**
```json
{
  "success": true,
  "order": {
    "id": "order_uuid",
    "status": "CANCELLED",
    "cancelledAt": "2024-01-01T12:02:00Z"
  }
}
```

### Get User Positions
```http
GET /positions
```

**Response:**
```json
{
  "positions": [
    {
      "id": "position_uuid",
      "userId": "user_uuid",
      "tokenId": "polymarket:market123:YES",
      "side": "YES",
      "quantity": 153.85,
      "averagePrice": 0.65,
      "unrealizedPnlUsd": 15.38,
      "realizedPnlUsd": 0,
      "marketValue": 100,
      "createdAt": "2024-01-01T12:01:00Z",
      "updatedAt": "2024-01-01T12:05:00Z"
    }
  ]
}
```

### Get User Portfolio
```http
GET /portfolio
```

**Response:**
```json
{
  "portfolio": {
    "totalValue": 1000,
    "totalPnL": 150,
    "totalPnLPercent": 15.0,
    "positions": [
      {
        "tokenId": "polymarket:market123:YES",
        "quantity": 153.85,
        "averagePrice": 0.65,
        "currentPrice": 0.70,
        "marketValue": 107.69,
        "unrealizedPnl": 7.69,
        "unrealizedPnlPercent": 7.69
      }
    ],
    "cashBalance": 892.31,
    "lastUpdated": "2024-01-01T12:05:00Z"
  }
}
```

### Get User Trades
```http
GET /trades
GET /trades?orderId=order_uuid
GET /trades?tokenId=polymarket:market123:YES
```

**Response:**
```json
{
  "trades": [
    {
      "id": "trade_uuid",
      "orderId": "order_uuid",
      "userId": "user_uuid",
      "venue": "polymarket",
      "tokenId": "polymarket:market123:YES",
      "side": "BUY",
      "price": 0.65,
      "sizeUsd": 100,
      "sizeTokens": 153.85,
      "executedAt": "2024-01-01T12:01:00Z",
      "createdAt": "2024-01-01T12:01:00Z",
      "venueTradeId": "venue_trade_123",
      "venueTxHash": "0x123...",
      "feeUsd": 0.5,
      "feeTokens": 0.77,
      "rawData": {}
    }
  ],
  "pagination": {
    "total": 10,
    "limit": 50,
    "offset": 0,
    "hasMore": false
  }
}
```

---

## 📊 Analytics Engine API

**Base URL:** `http://localhost:3003`

### Analyze Market
```http
GET /analyze/{tokenId}
GET /analyze/{tokenId}?resolution=1h&period=7d
```

**Query Parameters:**
- `resolution`: 1m, 5m, 1h, 1d, 1w
- `period`: 1d, 7d, 30d, 90d, 1y, all

**Response:**
```json
{
  "analysis": {
    "tokenId": "polymarket:market123:YES",
    "timestamp": "2024-01-01T12:00:00Z",
    "priceAnalysis": {
      "currentPrice": 0.65,
      "priceChange24h": 0.05,
      "priceChangePercent24h": 8.33,
      "allTimeHigh": 0.75,
      "allTimeLow": 0.45,
      "pricePosition": 0.67
    },
    "trendAnalysis": {
      "shortTermTrend": "bullish",
      "mediumTermTrend": "bullish",
      "longTermTrend": "sideways",
      "trendStrength": 0.75,
      "trendDuration": 3,
      "trendReversalRisk": 0.25
    },
    "volatilityAnalysis": {
      "currentVolatility": 0.12,
      "volatilityPercentile": 65,
      "volatilityTrend": "increasing",
      "averageVolatility": 0.10,
      "maxVolatility": 0.20,
      "minVolatility": 0.05
    },
    "volumeAnalysis": {
      "currentVolume": 50000,
      "volumeChange24h": 10000,
      "volumePercentile": 70,
      "volumeTrend": "increasing",
      "averageVolume": 40000,
      "volumePriceCorrelation": 0.65
    },
    "technicalSignals": {
      "rsiSignal": "neutral",
      "macdSignal": "bullish",
      "bollingerSignal": "neutral",
      "stochasticSignal": "oversold",
      "movingAverageSignal": "bullish",
      "overallSignal": "buy",
      "signalStrength": 0.75
    },
    "marketSentiment": {
      "bullishPercent": 65,
      "bearishPercent": 25,
      "neutralPercent": 10,
      "sentimentScore": 0.40,
      "sentimentTrend": "improving",
      "fearGreedIndex": 65
    },
    "riskMetrics": {
      "valueAtRisk95": 0.08,
      "valueAtRisk99": 0.12,
      "maximumDrawdown": 0.15,
      "sharpeRatio": 1.25,
      "beta": 0.85,
      "correlationToMarket": 0.70
    },
    "recommendations": [
      {
        "action": "buy",
        "confidence": 0.80,
        "reasoning": [
          "Strong bullish signal",
          "Volume increasing",
          "RSI oversold bounce"
        ],
        "targetPrice": 0.70,
        "stopLoss": 0.60,
        "timeHorizon": "medium",
        "riskLevel": "medium"
      }
    ]
  }
}
```

### Get Technical Indicators
```http
GET /indicators/{tokenId}
GET /indicators/{tokenId}?resolution=1h&period=30d
```

**Response:**
```json
{
  "indicators": {
    "tokenId": "polymarket:market123:YES",
    "resolution": "1h",
    "period": "30d",
    "movingAverages": {
      "sma5": 0.63,
      "sma10": 0.62,
      "sma20": 0.61,
      "ema5": 0.64,
      "ema10": 0.63,
      "ema20": 0.62
    },
    "rsi": {
      "rsi": 45,
      "overbought": false,
      "oversold": false
    },
    "macd": {
      "macd": 0.01,
      "signal": 0.005,
      "histogram": 0.005
    },
    "bollingerBands": {
      "upper": 0.68,
      "middle": 0.65,
      "lower": 0.62,
      "bandwidth": 0.09,
      "percentB": 0.50
    },
    "stochastic": {
      "k": 55,
      "d": 50,
      "overbought": false,
      "oversold": false
    },
    "volumeIndicators": {
      "obv": 1500000,
      "vwap": 0.64,
      "volumeSMA": 45000
    },
    "supportResistance": {
      "support": 0.60,
      "resistance": 0.70,
      "pivotPoints": {
        "pivot": 0.65,
        "r1": 0.70,
        "r2": 0.75,
        "s1": 0.60,
        "s2": 0.55
      }
    }
  }
}
```

### Get Price History
```http
GET /price-history/{tokenId}
GET /price-history/{tokenId}?resolution=1h&start=2024-01-01&end=2024-01-07
```

**Response:**
```json
{
  "priceHistory": {
    "tokenId": "polymarket:market123:YES",
    "resolution": "1h",
    "data": [
      {
        "timestamp": "2024-01-01T00:00:00Z",
        "open": 0.60,
        "high": 0.65,
        "low": 0.58,
        "close": 0.63,
        "volume": 10000,
        "tradeCount": 25
      },
      {
        "timestamp": "2024-01-01T01:00:00Z",
        "open": 0.63,
        "high": 0.67,
        "low": 0.62,
        "close": 0.65,
        "volume": 15000,
        "tradeCount": 30
      }
    ],
    "metadata": {
      "totalPoints": 168,
      "startTime": "2024-01-01T00:00:00Z",
      "endTime": "2024-01-07T23:00:00Z",
      "lastUpdated": "2024-01-01T12:00:00Z"
    }
  }
}
```

---

## 🔗 Webhook System API

**Base URL:** `http://localhost:3004`

### Create Webhook
```http
POST /webhooks
```

**Request Body:**
```json
{
  "name": "Order Updates",
  "description": "Webhook for order status updates",
  "url": "https://your-app.com/webhooks/orders",
  "events": ["order.created", "order.updated", "order.filled"],
  "authMethod": "hmac",
  "authConfig": {
    "hmacSecret": "your-secret-key",
    "hmacAlgorithm": "sha256"
  },
  "retryPolicy": {
    "maxRetries": 3,
    "retryDelay": 5000,
    "backoffMultiplier": 2,
    "maxRetryDelay": 60000
  }
}
```

**Response:**
```json
{
  "webhook": {
    "id": "webhook_uuid",
    "userId": "user_uuid",
    "name": "Order Updates",
    "description": "Webhook for order status updates",
    "url": "https://your-app.com/webhooks/orders",
    "events": ["order.created", "order.updated", "order.filled"],
    "authMethod": "hmac",
    "authConfig": {
      "hmacSecret": "your-secret-key",
      "hmacAlgorithm": "sha256"
    },
    "retryPolicy": {
      "maxRetries": 3,
      "retryDelay": 5000,
      "backoffMultiplier": 2,
      "maxRetryDelay": 60000
    },
    "status": "active",
    "isActive": true,
    "createdAt": "2024-01-01T12:00:00Z",
    "updatedAt": "2024-01-01T12:00:00Z"
  }
}
```

### Get User Webhooks
```http
GET /webhooks
```

**Response:**
```json
{
  "webhooks": [
    {
      "id": "webhook_uuid",
      "name": "Order Updates",
      "url": "https://your-app.com/webhooks/orders",
      "events": ["order.created", "order.updated", "order.filled"],
      "status": "active",
      "isActive": true,
      "lastTriggeredAt": "2024-01-01T12:00:00Z",
      "lastSuccessAt": "2024-01-01T12:00:00Z",
      "failureCount": 0,
      "successCount": 15,
      "createdAt": "2024-01-01T12:00:00Z"
    }
  ]
}
```

### Test Webhook
```http
POST /webhooks/{webhookId}/test
```

**Response:**
```json
{
  "success": true,
  "statusCode": 200,
  "duration": 150,
  "responseBody": "OK"
}
```

### Webhook Event Payload Examples

**Order Created Event:**
```json
{
  "eventType": "order.created",
  "timestamp": "2024-01-01T12:00:00Z",
  "data": {
    "order": {
      "id": "order_uuid",
      "userId": "user_uuid",
      "venue": "polymarket",
      "tokenId": "polymarket:market123:YES",
      "side": "BUY",
      "orderType": "LIMIT",
      "price": 0.65,
      "sizeUsd": 100,
      "status": "PENDING",
      "createdAt": "2024-01-01T12:00:00Z"
    }
  }
}
```

**Trade Executed Event:**
```json
{
  "eventType": "trade.executed",
  "timestamp": "2024-01-01T12:01:00Z",
  "data": {
    "trade": {
      "id": "trade_uuid",
      "orderId": "order_uuid",
      "userId": "user_uuid",
      "venue": "polymarket",
      "tokenId": "polymarket:market123:YES",
      "side": "BUY",
      "price": 0.65,
      "sizeUsd": 100,
      "executedAt": "2024-01-01T12:01:00Z"
    },
    "order": {
      "id": "order_uuid",
      "status": "FILLED",
      "filledSizeUsd": 100
    }
  }
}
```

---

## 📈 Price History API

**Base URL:** `http://localhost:3005`

### Get Price Data
```http
GET /prices/{tokenId}
GET /prices/{tokenId}?resolution=1h&start=2024-01-01&end=2024-01-07
```

**Query Parameters:**
- `resolution`: 1m, 5m, 1h, 1d, 1w
- `start`: ISO 8601 timestamp
- `end`: ISO 8601 timestamp
- `limit`: maximum number of data points (default: 1000)

**Response:**
```json
{
  "priceData": {
    "tokenId": "polymarket:market123:YES",
    "resolution": "1h",
    "data": [
      {
        "timestamp": "2024-01-01T00:00:00Z",
        "open": 0.60,
        "high": 0.65,
        "low": 0.58,
        "close": 0.63,
        "volume": 10000,
        "tradeCount": 25,
        "bestBid": 0.62,
        "bestAsk": 0.64,
        "spread": 0.02
      }
    ],
    "metadata": {
      "totalPoints": 168,
      "startTime": "2024-01-01T00:00:00Z",
      "endTime": "2024-01-07T23:00:00Z",
      "lastUpdated": "2024-01-01T12:00:00Z"
    }
  }
}
```

### Get Aggregated Data
```http
GET /aggregates/{tokenId}
GET /aggregates/{tokenId}?resolution=1d&period=30d
```

**Response:**
```json
{
  "aggregates": {
    "tokenId": "polymarket:market123:YES",
    "resolution": "1d",
    "period": "30d",
    "data": [
      {
        "timestamp": "2024-01-01T00:00:00Z",
        "open": 0.60,
        "high": 0.68,
        "low": 0.58,
        "close": 0.65,
        "volume": 100000,
        "tradeCount": 250,
        "vwap": 0.63
      }
    ],
    "statistics": {
      "averagePrice": 0.63,
      "priceChange": 0.05,
      "priceChangePercent": 8.33,
      "totalVolume": 3000000,
      "totalTrades": 7500,
      "volatility": 0.12
    }
  }
}
```

---

## 📊 Data Ingestion API

**Base URL:** `http://localhost:3006`

### Get Ingestion Status
```http
GET /status
```

**Response:**
```json
{
  "status": "running",
  "venues": {
    "polymarket": {
      "status": "active",
      "lastUpdate": "2024-01-01T12:00:00Z",
      "marketsCount": 150,
      "eventsCount": 25,
      "errorCount": 0
    },
    "kalshi": {
      "status": "active",
      "lastUpdate": "2024-01-01T12:00:00Z",
      "marketsCount": 200,
      "eventsCount": 30,
      "errorCount": 0
    },
    "limitless": {
      "status": "active",
      "lastUpdate": "2024-01-01T12:00:00Z",
      "marketsCount": 100,
      "eventsCount": 20,
      "errorCount": 0
    }
  },
  "queue": {
    "pending": 0,
    "processing": 5,
    "failed": 0
  }
}
```

### Trigger Data Refresh
```http
POST /refresh
POST /refresh?venue=polymarket
```

**Response:**
```json
{
  "success": true,
  "message": "Data refresh triggered",
  "venues": ["polymarket", "kalshi", "limitless"]
}
```

---

## 📊 Monitoring API

**Base URL:** `http://localhost:3007`

### Get System Health
```http
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T12:00:00Z",
  "services": {
    "api": "healthy",
    "trading-engine": "healthy",
    "analytics-engine": "healthy",
    "webhook-system": "healthy",
    "price-history": "healthy",
    "data-ingestion": "healthy",
    "monitoring": "healthy"
  },
  "uptime": 3600,
  "version": "1.0.0"
}
```

### Get Metrics
```http
GET /metrics
```

**Response:** Prometheus format metrics

### Get Dashboard Data
```http
GET /dashboard
```

**Response:**
```json
{
  "overview": {
    "totalServices": 7,
    "healthyServices": 7,
    "unhealthyServices": 0,
    "activeAlerts": 0,
    "totalMetrics": 150
  },
  "services": [
    {
      "name": "api",
      "status": "healthy",
      "uptime": 99.9,
      "responseTime": 50,
      "errorRate": 0.1,
      "lastCheck": "2024-01-01T12:00:00Z"
    }
  ],
  "alerts": [],
  "metrics": [
    {
      "name": "http_requests_total",
      "value": 10000,
      "trend": "up",
      "change": 5.2
    }
  ]
}
```

### Get Alerts
```http
GET /alerts
GET /alerts?status=firing
GET /alerts?severity=critical
```

**Response:**
```json
{
  "alerts": [
    {
      "id": "alert_uuid",
      "alertId": "high-cpu-usage",
      "status": "firing",
      "severity": "high",
      "title": "High CPU Usage",
      "description": "CPU usage is above 80%",
      "labels": {
        "service": "api",
        "instance": "api-1"
      },
      "startedAt": "2024-01-01T12:00:00Z",
      "value": 85,
      "threshold": 80
    }
  ]
}
```

---

## 🔌 WebSocket Connections

### Market Data WebSocket
**URL:** `ws://localhost:3000/ws/market-data`

**Connection:**
```javascript
const ws = new WebSocket('ws://localhost:3000/ws/market-data');

// Subscribe to market updates
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['market:polymarket:market123', 'price:polymarket:market123']
}));
```

**Messages:**

**Price Update:**
```json
{
  "type": "price_update",
  "marketId": "polymarket:market123",
  "yesPrice": 0.65,
  "noPrice": 0.35,
  "timestamp": "2024-01-01T12:00:00Z"
}
```

**Trade Update:**
```json
{
  "type": "trade",
  "marketId": "polymarket:market123",
  "price": 0.66,
  "size": 1000,
  "side": "BUY",
  "timestamp": "2024-01-01T12:01:00Z"
}
```

**Order Book Update:**
```json
{
  "type": "orderbook",
  "marketId": "polymarket:market123",
  "bids": [
    { "price": 0.64, "size": 1000 },
    { "price": 0.63, "size": 2000 }
  ],
  "asks": [
    { "price": 0.66, "size": 1500 },
    { "price": 0.67, "size": 2500 }
  ],
  "timestamp": "2024-01-01T12:00:00Z"
}
```

### Trading WebSocket
**URL:** `ws://localhost:3001/ws/trading`

**Connection:**
```javascript
const ws = new WebSocket('ws://localhost:3001/ws/trading');

// Authenticate
ws.send(JSON.stringify({
  type: 'auth',
  token: 'jwt_token'
}));
```

**Messages:**

**Order Update:**
```json
{
  "type": "order_update",
  "order": {
    "id": "order_uuid",
    "status": "FILLED",
    "filledSizeUsd": 100,
    "filledAt": "2024-01-01T12:01:00Z"
  }
}
```

**Position Update:**
```json
{
  "type": "position_update",
  "position": {
    "tokenId": "polymarket:market123:YES",
    "quantity": 153.85,
    "unrealizedPnlUsd": 15.38
  }
}
```

### Analytics WebSocket
**URL:** `ws://localhost:3003/ws/analytics`

**Messages:**

**Analysis Update:**
```json
{
  "type": "analysis_update",
  "tokenId": "polymarket:market123:YES",
  "analysis": {
    "technicalSignals": {
      "overallSignal": "buy",
      "signalStrength": 0.75
    },
    "recommendations": [
      {
        "action": "buy",
        "confidence": 0.80,
        "targetPrice": 0.70
      }
    ]
  }
}
```

---

## ❌ Error Handling

### Error Response Format
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request parameters",
    "details": [
      {
        "field": "price",
        "message": "Price must be between 0 and 1"
      }
    ],
    "timestamp": "2024-01-01T12:00:00Z",
    "requestId": "req_uuid"
  }
}
```

### Common Error Codes
- `VALIDATION_ERROR`: Invalid request parameters
- `AUTHENTICATION_ERROR`: Invalid or missing authentication
- `AUTHORIZATION_ERROR`: Insufficient permissions
- `NOT_FOUND`: Resource not found
- `RATE_LIMIT_EXCEEDED`: Too many requests
- `SERVICE_UNAVAILABLE`: Service temporarily unavailable
- `INTERNAL_ERROR`: Internal server error

### HTTP Status Codes
- `200`: Success
- `201`: Created
- `400`: Bad Request
- `401`: Unauthorized
- `403`: Forbidden
- `404`: Not Found
- `429`: Too Many Requests
- `500`: Internal Server Error
- `503`: Service Unavailable

---

## 🚦 Rate Limiting

### Rate Limits
- **API Gateway**: 100 requests per 15 minutes per IP
- **Trading Engine**: 50 requests per 15 minutes per user
- **Analytics Engine**: 200 requests per 15 minutes per user
- **Webhook System**: 100 requests per 15 minutes per user
- **Price History**: 500 requests per 15 minutes per user
- **Data Ingestion**: 20 requests per 15 minutes per user
- **Monitoring**: 100 requests per 15 minutes per user

### Rate Limit Headers
```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640995200
```

### Rate Limit Exceeded Response
```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded. Try again in 15 minutes.",
    "retryAfter": 900
  }
}
```

---

## 🔧 SDK Examples

### JavaScript/TypeScript SDK
```typescript
import { HunchClient } from '@hunch/sdk';

const client = new HunchClient({
  apiUrl: 'http://localhost:3000/api',
  tradingUrl: 'http://localhost:3001',
  analyticsUrl: 'http://localhost:3003',
  token: 'jwt_token'
});

// Get markets
const markets = await client.markets.list({
  venue: 'polymarket',
  status: 'active'
});

// Create order
const order = await client.trading.orders.create({
  venue: 'polymarket',
  tokenId: 'polymarket:market123:YES',
  side: 'BUY',
  orderType: 'LIMIT',
  price: 0.65,
  sizeUsd: 100
});

// Get analysis
const analysis = await client.analytics.analyze('polymarket:market123:YES');

// Subscribe to WebSocket
client.websocket.subscribe('market:polymarket:market123', (data) => {
  console.log('Price update:', data);
});
```

### Python SDK
```python
from hunch_sdk import HunchClient

client = HunchClient(
    api_url='http://localhost:3000/api',
    trading_url='http://localhost:3001',
    analytics_url='http://localhost:3003',
    token='jwt_token'
)

# Get markets
markets = client.markets.list(venue='polymarket', status='active')

# Create order
order = client.trading.orders.create(
    venue='polymarket',
    token_id='polymarket:market123:YES',
    side='BUY',
    order_type='LIMIT',
    price=0.65,
    size_usd=100
)

# Get analysis
analysis = client.analytics.analyze('polymarket:market123:YES')
```

---

## 📝 Integration Checklist

### Authentication
- [ ] Implement JWT token storage
- [ ] Handle token refresh
- [ ] Add authentication headers to all requests

### API Integration
- [ ] Implement all API endpoints
- [ ] Handle pagination
- [ ] Implement error handling
- [ ] Add request/response logging

### WebSocket Integration
- [ ] Implement WebSocket connections
- [ ] Handle connection state
- [ ] Implement reconnection logic
- [ ] Process real-time updates

### UI Components
- [ ] Market list with filtering
- [ ] Order book visualization
- [ ] Price charts with indicators
- [ ] Order management interface
- [ ] Portfolio dashboard
- [ ] Analytics and recommendations

### Error Handling
- [ ] Network error handling
- [ ] API error handling
- [ ] WebSocket error handling
- [ ] User-friendly error messages

### Performance
- [ ] Implement caching
- [ ] Optimize API calls
- [ ] Implement lazy loading
- [ ] Add loading states

---

This comprehensive API reference provides everything needed for complete UI integration with the Hunch platform. All endpoints include detailed request/response schemas, WebSocket message formats, error handling, and integration examples.