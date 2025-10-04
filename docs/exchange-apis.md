# Exchange APIs Documentation

Complete API documentation for Polymarket, Kalshi, and Limitless exchanges with input/output schemas and examples.

## 📋 Table of Contents

1. [Polymarket API](#polymarket-api)
2. [Kalshi API](#kalshi-api)
3. [Limitless API](#limitless-api)
4. [WebSocket Connections](#websocket-connections)
5. [Authentication](#authentication)
6. [Rate Limits](#rate-limits)
7. [Error Handling](#error-handling)

---

## 🏛️ Polymarket API

**Base URL:** `https://gamma-api.polymarket.com`

### Authentication
```http
Authorization: Bearer <api_key>
Content-Type: application/json
```

### Get Events
```http
GET /events
GET /events?active=true
GET /events?category=politics
```

**Query Parameters:**
- `active`: Filter active events (boolean)
- `category`: Filter by category
- `limit`: Number of results (default: 50)
- `offset`: Pagination offset (default: 0)

**Response:**
```json
{
  "data": [
    {
      "id": "0x123...",
      "question": "Will Biden win 2024 election?",
      "description": "Prediction market for 2024 US Presidential Election",
      "category": "politics",
      "subcategory": "elections",
      "end_date_iso": "2024-11-05T23:59:59Z",
      "start_date_iso": "2024-01-01T00:00:00Z",
      "image": "https://example.com/image.jpg",
      "tokens": [
        {
          "id": "0x456...",
          "outcome": "Yes",
          "price": 0.65
        },
        {
          "id": "0x789...",
          "outcome": "No",
          "price": 0.35
        }
      ],
      "volume": 1000000,
      "volume_24h": 50000,
      "liquidity": 500000,
      "active": true,
      "archived": false,
      "closed": false,
      "resolved": false
    }
  ],
  "total": 150,
  "page": 1,
  "limit": 50
}
```

### Get Markets
```http
GET /markets
GET /markets?event_id=0x123...
GET /markets?active=true
```

**Response:**
```json
{
  "data": [
    {
      "id": "0xabc...",
      "event_id": "0x123...",
      "question": "Will Biden win 2024 election?",
      "description": "Prediction market for 2024 US Presidential Election",
      "end_date_iso": "2024-11-05T23:59:59Z",
      "start_date_iso": "2024-01-01T00:00:00Z",
      "active": true,
      "archived": false,
      "closed": false,
      "resolved": false,
      "tokens": [
        {
          "id": "0x456...",
          "outcome": "Yes",
          "price": 0.65,
          "volume": 500000,
          "volume_24h": 25000
        },
        {
          "id": "0x789...",
          "outcome": "No",
          "price": 0.35,
          "volume": 500000,
          "volume_24h": 25000
        }
      ],
      "volume": 1000000,
      "volume_24h": 50000,
      "liquidity": 500000,
      "min_order_size": 1,
      "tick_size": 0.01,
      "max_order_size": 100000
    }
  ]
}
```

### Get Order Book
```http
POST /orderbook
```

**Request Body:**
```json
{
  "token_ids": ["0x456...", "0x789..."]
}
```

**Response:**
```json
{
  "data": {
    "0x456...": {
      "bids": [
        { "price": 0.64, "size": 1000 },
        { "price": 0.63, "size": 2000 }
      ],
      "asks": [
        { "price": 0.66, "size": 1500 },
        { "price": 0.67, "size": 2500 }
      ]
    },
    "0x789...": {
      "bids": [
        { "price": 0.34, "size": 1000 },
        { "price": 0.33, "size": 2000 }
      ],
      "asks": [
        { "price": 0.36, "size": 1500 },
        { "price": 0.37, "size": 2500 }
      ]
    }
  }
}
```

### Get Recent Trades
```http
GET /trades
GET /trades?token_id=0x456...
GET /trades?limit=100
```

**Response:**
```json
{
  "data": [
    {
      "id": "0xdef...",
      "token_id": "0x456...",
      "price": 0.65,
      "size": 1000,
      "side": "BUY",
      "timestamp": "2024-01-01T12:00:00Z",
      "tx_hash": "0x123...",
      "block_number": 12345678
    }
  ]
}
```

### Place Order
```http
POST /orders
```

**Request Body:**
```json
{
  "token_id": "0x456...",
  "side": "BUY",
  "order_type": "LIMIT",
  "price": 0.65,
  "size": 1000,
  "time_in_force": "GTC"
}
```

**Response:**
```json
{
  "data": {
    "id": "0xorder123...",
    "token_id": "0x456...",
    "side": "BUY",
    "order_type": "LIMIT",
    "price": 0.65,
    "size": 1000,
    "filled_size": 0,
    "status": "PENDING",
    "created_at": "2024-01-01T12:00:00Z",
    "updated_at": "2024-01-01T12:00:00Z"
  }
}
```

### Cancel Order
```http
DELETE /orders/{order_id}
```

**Response:**
```json
{
  "data": {
    "id": "0xorder123...",
    "status": "CANCELLED",
    "cancelled_at": "2024-01-01T12:01:00Z"
  }
}
```

### Get User Orders
```http
GET /user/orders
GET /user/orders?status=PENDING
GET /user/orders?token_id=0x456...
```

**Response:**
```json
{
  "data": [
    {
      "id": "0xorder123...",
      "token_id": "0x456...",
      "side": "BUY",
      "order_type": "LIMIT",
      "price": 0.65,
      "size": 1000,
      "filled_size": 0,
      "status": "PENDING",
      "created_at": "2024-01-01T12:00:00Z",
      "updated_at": "2024-01-01T12:00:00Z"
    }
  ]
}
```

### Get User Positions
```http
GET /user/positions
```

**Response:**
```json
{
  "data": [
    {
      "token_id": "0x456...",
      "side": "YES",
      "quantity": 1000,
      "average_price": 0.65,
      "unrealized_pnl": 50,
      "realized_pnl": 0,
      "market_value": 650
    }
  ]
}
```

### Get User Portfolio
```http
GET /user/portfolio
```

**Response:**
```json
{
  "data": {
    "total_value": 1000,
    "total_pnl": 150,
    "total_pnl_percent": 15.0,
    "positions": [
      {
        "token_id": "0x456...",
        "quantity": 1000,
        "average_price": 0.65,
        "current_price": 0.70,
        "market_value": 700,
        "unrealized_pnl": 50,
        "unrealized_pnl_percent": 7.14
      }
    ],
    "cash_balance": 300
  }
}
```

---

## 🎯 Kalshi API

**Base URL:** `https://trading-api.kalshi.com`

### Authentication
```http
Authorization: Bearer <api_key>
Content-Type: application/json
```

### Get Events
```http
GET /events
GET /events?status=open
GET /events?category=politics
```

**Query Parameters:**
- `status`: Filter by status (open, closed, settled)
- `category`: Filter by category
- `limit`: Number of results (default: 50)
- `offset`: Pagination offset (default: 0)

**Response:**
```json
{
  "events": [
    {
      "id": "event123",
      "title": "Will Biden win 2024 election?",
      "description": "Prediction market for 2024 US Presidential Election",
      "category": "politics",
      "status": "open",
      "open_time": "2024-01-01T00:00:00Z",
      "close_time": "2024-11-05T23:59:59Z",
      "settle_time": "2024-11-06T00:00:00Z",
      "ticker": "BIDEN-2024",
      "image": "https://example.com/image.jpg",
      "volume": 1000000,
      "volume_24h": 50000,
      "liquidity": 500000,
      "markets": [
        {
          "id": "market123",
          "ticker": "BIDEN-2024",
          "status": "open",
          "yes_price": 0.65,
          "no_price": 0.35,
          "volume": 500000,
          "volume_24h": 25000,
          "liquidity": 250000,
          "min_order_size": 1,
          "tick_size": 0.01,
          "max_order_size": 100000
        }
      ]
    }
  ],
  "total": 150,
  "page": 1,
  "limit": 50
}
```

### Get Markets
```http
GET /markets
GET /markets?event_id=event123
GET /markets?status=open
```

**Response:**
```json
{
  "markets": [
    {
      "id": "market123",
      "event_id": "event123",
      "ticker": "BIDEN-2024",
      "title": "Will Biden win 2024 election?",
      "description": "Prediction market for 2024 US Presidential Election",
      "status": "open",
      "open_time": "2024-01-01T00:00:00Z",
      "close_time": "2024-11-05T23:59:59Z",
      "settle_time": "2024-11-06T00:00:00Z",
      "yes_price": 0.65,
      "no_price": 0.35,
      "volume": 500000,
      "volume_24h": 25000,
      "liquidity": 250000,
      "min_order_size": 1,
      "tick_size": 0.01,
      "max_order_size": 100000,
      "orderbook": {
        "yes": {
          "bids": [
            { "price": 0.64, "size": 1000 },
            { "price": 0.63, "size": 2000 }
          ],
          "asks": [
            { "price": 0.66, "size": 1500 },
            { "price": 0.67, "size": 2500 }
          ]
        },
        "no": {
          "bids": [
            { "price": 0.34, "size": 1000 },
            { "price": 0.33, "size": 2000 }
          ],
          "asks": [
            { "price": 0.36, "size": 1500 },
            { "price": 0.37, "size": 2500 }
          ]
        }
      }
    }
  ]
}
```

### Get Order Book
```http
GET /markets/{market_id}/orderbook
```

**Response:**
```json
{
  "market_id": "market123",
  "orderbook": {
    "yes": {
      "bids": [
        { "price": 0.64, "size": 1000 },
        { "price": 0.63, "size": 2000 }
      ],
      "asks": [
        { "price": 0.66, "size": 1500 },
        { "price": 0.67, "size": 2500 }
      ]
    },
    "no": {
      "bids": [
        { "price": 0.34, "size": 1000 },
        { "price": 0.33, "size": 2000 }
      ],
      "asks": [
        { "price": 0.36, "size": 1500 },
        { "price": 0.37, "size": 2500 }
      ]
    }
  },
  "timestamp": "2024-01-01T12:00:00Z"
}
```

### Get Recent Trades
```http
GET /markets/{market_id}/trades
GET /markets/{market_id}/trades?limit=100
```

**Response:**
```json
{
  "trades": [
    {
      "id": "trade123",
      "market_id": "market123",
      "side": "yes",
      "price": 0.65,
      "size": 1000,
      "timestamp": "2024-01-01T12:00:00Z",
      "buyer": "user123",
      "seller": "user456"
    }
  ]
}
```

### Place Order
```http
POST /orders
```

**Request Body:**
```json
{
  "market_id": "market123",
  "side": "yes",
  "order_type": "limit",
  "price": 0.65,
  "size": 1000,
  "time_in_force": "gtc"
}
```

**Response:**
```json
{
  "order": {
    "id": "order123",
    "market_id": "market123",
    "side": "yes",
    "order_type": "limit",
    "price": 0.65,
    "size": 1000,
    "filled_size": 0,
    "status": "pending",
    "created_at": "2024-01-01T12:00:00Z",
    "updated_at": "2024-01-01T12:00:00Z"
  }
}
```

### Cancel Order
```http
DELETE /orders/{order_id}
```

**Response:**
```json
{
  "order": {
    "id": "order123",
    "status": "cancelled",
    "cancelled_at": "2024-01-01T12:01:00Z"
  }
}
```

### Get User Orders
```http
GET /user/orders
GET /user/orders?status=pending
GET /user/orders?market_id=market123
```

**Response:**
```json
{
  "orders": [
    {
      "id": "order123",
      "market_id": "market123",
      "side": "yes",
      "order_type": "limit",
      "price": 0.65,
      "size": 1000,
      "filled_size": 0,
      "status": "pending",
      "created_at": "2024-01-01T12:00:00Z",
      "updated_at": "2024-01-01T12:00:00Z"
    }
  ]
}
```

### Get User Positions
```http
GET /user/positions
```

**Response:**
```json
{
  "positions": [
    {
      "market_id": "market123",
      "side": "yes",
      "quantity": 1000,
      "average_price": 0.65,
      "unrealized_pnl": 50,
      "realized_pnl": 0,
      "market_value": 650
    }
  ]
}
```

### Get User Portfolio
```http
GET /user/portfolio
```

**Response:**
```json
{
  "portfolio": {
    "total_value": 1000,
    "total_pnl": 150,
    "total_pnl_percent": 15.0,
    "positions": [
      {
        "market_id": "market123",
        "side": "yes",
        "quantity": 1000,
        "average_price": 0.65,
        "current_price": 0.70,
        "market_value": 700,
        "unrealized_pnl": 50,
        "unrealized_pnl_percent": 7.14
      }
    ],
    "cash_balance": 300
  }
}
```

---

## 🚀 Limitless API

**Base URL:** `https://api.limitless.market`

### Authentication
```http
Authorization: Bearer <api_key>
Content-Type: application/json
```

### Get Markets
```http
GET /markets
GET /markets?status=active
GET /markets?category=politics
```

**Query Parameters:**
- `status`: Filter by status (active, closed, settled)
- `category`: Filter by category
- `limit`: Number of results (default: 50)
- `offset`: Pagination offset (default: 0)

**Response:**
```json
{
  "markets": [
    {
      "id": "market123",
      "title": "Will Biden win 2024 election?",
      "description": "Prediction market for 2024 US Presidential Election",
      "category": "politics",
      "status": "active",
      "start_time": "2024-01-01T00:00:00Z",
      "end_time": "2024-11-05T23:59:59Z",
      "resolution_time": "2024-11-06T00:00:00Z",
      "outcomes": [
        {
          "id": "outcome123",
          "name": "Yes",
          "price": 0.65,
          "volume": 500000,
          "volume_24h": 25000
        },
        {
          "id": "outcome456",
          "name": "No",
          "price": 0.35,
          "volume": 500000,
          "volume_24h": 25000
        }
      ],
      "total_volume": 1000000,
      "total_volume_24h": 50000,
      "liquidity": 500000,
      "min_order_size": 1,
      "tick_size": 0.01,
      "max_order_size": 100000
    }
  ],
  "total": 150,
  "page": 1,
  "limit": 50
}
```

### Get Market Details
```http
GET /markets/{market_id}
```

**Response:**
```json
{
  "market": {
    "id": "market123",
    "title": "Will Biden win 2024 election?",
    "description": "Prediction market for 2024 US Presidential Election",
    "category": "politics",
    "status": "active",
    "start_time": "2024-01-01T00:00:00Z",
    "end_time": "2024-11-05T23:59:59Z",
    "resolution_time": "2024-11-06T00:00:00Z",
    "outcomes": [
      {
        "id": "outcome123",
        "name": "Yes",
        "price": 0.65,
        "volume": 500000,
        "volume_24h": 25000
      },
      {
        "id": "outcome456",
        "name": "No",
        "price": 0.35,
        "volume": 500000,
        "volume_24h": 25000
      }
    ],
    "total_volume": 1000000,
    "total_volume_24h": 50000,
    "liquidity": 500000,
    "min_order_size": 1,
    "tick_size": 0.01,
    "max_order_size": 100000,
    "orderbook": {
      "outcome123": {
        "bids": [
          { "price": 0.64, "size": 1000 },
          { "price": 0.63, "size": 2000 }
        ],
        "asks": [
          { "price": 0.66, "size": 1500 },
          { "price": 0.67, "size": 2500 }
        ]
      },
      "outcome456": {
        "bids": [
          { "price": 0.34, "size": 1000 },
          { "price": 0.33, "size": 2000 }
        ],
        "asks": [
          { "price": 0.36, "size": 1500 },
          { "price": 0.37, "size": 2500 }
        ]
      }
    }
  }
}
```

### Get Order Book
```http
GET /markets/{market_id}/orderbook
```

**Response:**
```json
{
  "market_id": "market123",
  "orderbook": {
    "outcome123": {
      "bids": [
        { "price": 0.64, "size": 1000 },
        { "price": 0.63, "size": 2000 }
      ],
      "asks": [
        { "price": 0.66, "size": 1500 },
        { "price": 0.67, "size": 2500 }
      ]
    },
    "outcome456": {
      "bids": [
        { "price": 0.34, "size": 1000 },
        { "price": 0.33, "size": 2000 }
      ],
      "asks": [
        { "price": 0.36, "size": 1500 },
        { "price": 0.37, "size": 2500 }
      ]
    }
  },
  "timestamp": "2024-01-01T12:00:00Z"
}
```

### Get Recent Trades
```http
GET /markets/{market_id}/trades
GET /markets/{market_id}/trades?limit=100
```

**Response:**
```json
{
  "trades": [
    {
      "id": "trade123",
      "market_id": "market123",
      "outcome_id": "outcome123",
      "side": "buy",
      "price": 0.65,
      "size": 1000,
      "timestamp": "2024-01-01T12:00:00Z",
      "buyer": "user123",
      "seller": "user456"
    }
  ]
}
```

### Place Order
```http
POST /orders
```

**Request Body:**
```json
{
  "market_id": "market123",
  "outcome_id": "outcome123",
  "side": "buy",
  "order_type": "limit",
  "price": 0.65,
  "size": 1000,
  "time_in_force": "gtc"
}
```

**Response:**
```json
{
  "order": {
    "id": "order123",
    "market_id": "market123",
    "outcome_id": "outcome123",
    "side": "buy",
    "order_type": "limit",
    "price": 0.65,
    "size": 1000,
    "filled_size": 0,
    "status": "pending",
    "created_at": "2024-01-01T12:00:00Z",
    "updated_at": "2024-01-01T12:00:00Z"
  }
}
```

### Cancel Order
```http
DELETE /orders/{order_id}
```

**Response:**
```json
{
  "order": {
    "id": "order123",
    "status": "cancelled",
    "cancelled_at": "2024-01-01T12:01:00Z"
  }
}
```

### Get User Orders
```http
GET /user/orders
GET /user/orders?status=pending
GET /user/orders?market_id=market123
```

**Response:**
```json
{
  "orders": [
    {
      "id": "order123",
      "market_id": "market123",
      "outcome_id": "outcome123",
      "side": "buy",
      "order_type": "limit",
      "price": 0.65,
      "size": 1000,
      "filled_size": 0,
      "status": "pending",
      "created_at": "2024-01-01T12:00:00Z",
      "updated_at": "2024-01-01T12:00:00Z"
    }
  ]
}
```

### Get User Positions
```http
GET /user/positions
```

**Response:**
```json
{
  "positions": [
    {
      "market_id": "market123",
      "outcome_id": "outcome123",
      "side": "yes",
      "quantity": 1000,
      "average_price": 0.65,
      "unrealized_pnl": 50,
      "realized_pnl": 0,
      "market_value": 650
    }
  ]
}
```

### Get User Portfolio
```http
GET /user/portfolio
```

**Response:**
```json
{
  "portfolio": {
    "total_value": 1000,
    "total_pnl": 150,
    "total_pnl_percent": 15.0,
    "positions": [
      {
        "market_id": "market123",
        "outcome_id": "outcome123",
        "side": "yes",
        "quantity": 1000,
        "average_price": 0.65,
        "current_price": 0.70,
        "market_value": 700,
        "unrealized_pnl": 50,
        "unrealized_pnl_percent": 7.14
      }
    ],
    "cash_balance": 300
  }
}
```

---

## 🔌 WebSocket Connections

### Polymarket WebSocket
**URL:** `wss://gamma-api.polymarket.com/ws`

**Connection:**
```javascript
const ws = new WebSocket('wss://gamma-api.polymarket.com/ws');

// Subscribe to market updates
ws.send(JSON.stringify({
  type: 'subscribe',
  channel: 'market:0x456...'
}));
```

**Messages:**

**Price Update:**
```json
{
  "type": "price_update",
  "token_id": "0x456...",
  "price": 0.65,
  "timestamp": "2024-01-01T12:00:00Z"
}
```

**Trade Update:**
```json
{
  "type": "trade",
  "token_id": "0x456...",
  "price": 0.66,
  "size": 1000,
  "side": "BUY",
  "timestamp": "2024-01-01T12:01:00Z"
}
```

### Kalshi WebSocket
**URL:** `wss://trading-api.kalshi.com/ws`

**Connection:**
```javascript
const ws = new WebSocket('wss://trading-api.kalshi.com/ws');

// Subscribe to market updates
ws.send(JSON.stringify({
  type: 'subscribe',
  channel: 'market:market123'
}));
```

**Messages:**

**Price Update:**
```json
{
  "type": "price_update",
  "market_id": "market123",
  "yes_price": 0.65,
  "no_price": 0.35,
  "timestamp": "2024-01-01T12:00:00Z"
}
```

**Trade Update:**
```json
{
  "type": "trade",
  "market_id": "market123",
  "side": "yes",
  "price": 0.66,
  "size": 1000,
  "timestamp": "2024-01-01T12:01:00Z"
}
```

### Limitless WebSocket
**URL:** `wss://api.limitless.market/ws`

**Connection:**
```javascript
const ws = new WebSocket('wss://api.limitless.market/ws');

// Subscribe to market updates
ws.send(JSON.stringify({
  type: 'subscribe',
  channel: 'market:market123'
}));
```

**Messages:**

**Price Update:**
```json
{
  "type": "price_update",
  "market_id": "market123",
  "outcome_id": "outcome123",
  "price": 0.65,
  "timestamp": "2024-01-01T12:00:00Z"
}
```

**Trade Update:**
```json
{
  "type": "trade",
  "market_id": "market123",
  "outcome_id": "outcome123",
  "side": "buy",
  "price": 0.66,
  "size": 1000,
  "timestamp": "2024-01-01T12:01:00Z"
}
```

---

## 🔐 Authentication

### API Key Authentication
All exchanges require API key authentication:

```http
Authorization: Bearer <api_key>
```

### API Key Generation
- **Polymarket**: Generate API key in account settings
- **Kalshi**: Generate API key in trading dashboard
- **Limitless**: Generate API key in account settings

### Rate Limiting
- **Polymarket**: 100 requests per 15 minutes
- **Kalshi**: 50 requests per 15 minutes
- **Limitless**: 200 requests per 15 minutes

---

## ❌ Error Handling

### Common Error Response Format
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
    "request_id": "req_uuid"
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

This comprehensive exchange API documentation provides everything needed to integrate with Polymarket, Kalshi, and Limitless exchanges, including all endpoints, request/response schemas, WebSocket connections, and error handling.