# Hunch Trading Platform API Documentation

## Table of Contents
1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Base URL](#base-url)
4. [System Endpoints](#system-endpoints)
5. [Market Data Endpoints](#market-data-endpoints)
6. [Authentication & User Management](#authentication--user-management)
7. [Order Management](#order-management)
8. [Watchlist Management](#watchlist-management)
9. [Error Handling](#error-handling)
10. [Rate Limiting](#rate-limiting)
11. [WebSocket Streaming](#websocket-streaming)

## Overview

The Hunch Trading Platform API provides a comprehensive interface for trading on multiple prediction markets including Polymarket, Kalshi, and Limitless. The API supports real-time market data, order management, user authentication, and position tracking.

### Key Features
- **Multi-venue support**: Polymarket, Kalshi, Limitless
- **Real-time data**: Live price feeds and order book updates
- **Order management**: Place, cancel, and track orders
- **User authentication**: Wallet-based authentication with JWT tokens
- **Position tracking**: Real-time position and P&L monitoring
- **Rate limiting**: Intelligent rate limiting to prevent API abuse

## Base URL

```
Production: https://api.hunch.trading
Development: http://localhost:3000
```

## Authentication

The API uses JWT-based authentication with Privy wallet integration. Most endpoints require authentication via the `Authorization` header.

### Authentication Flow

1. **Get Privy Access Token**: Authenticate with Privy to get an access token
2. **Verify Privy Token**: Submit Privy access token to get JWT token
3. **Use Token**: Include token in subsequent requests

### Headers

```javascript
// For authenticated requests
headers: {
  'Authorization': 'Bearer <jwt_token>',
  'Content-Type': 'application/json'
}

// For Polymarket L1 authentication (when placing orders)
headers: {
  'Authorization': 'Bearer <jwt_token>',
  'poly_signature': '<l1_signature>',
  'poly_timestamp': '<timestamp>',
  'poly_nonce': '<nonce>',
  'Content-Type': 'application/json'
}
```

---

## System Endpoints

### 1. Health Check

**Endpoint**: `GET /health`

**Description**: Check if the API is running and healthy.

**Example Response**:
```json
{
  "ok": true
}
```

### 2. Metrics

**Endpoint**: `GET /metrics`

**Description**: Get API metrics and performance statistics.

**Example Response**:
```json
{
  "requests": {
    "total": 12345,
    "successful": 12000,
    "failed": 345
  },
  "responseTime": {
    "average": 150,
    "p95": 300,
    "p99": 500
  }
}
```

### 3. Price History Status

**Endpoint**: `GET /price-history/status`

**Description**: Get the current status of the Polymarket rate limiter, including queue length and processing status.

**Example Response**:
```json
{
  "polymarketRateLimiter": {
    "queueLength": 5,
    "isProcessing": true,
    "requestCount": 45,
    "windowStart": 1705312200000,
    "timeUntilReset": 3500
  },
  "timestamp": "2024-01-15T10:30:00Z"
}
```

---

## Market Data Endpoints

### 1. Get Market Feed

**Endpoint**: `GET /feed`

**Description**: Get a paginated list of markets with real-time pricing data, volume, and liquidity information. Default sorting uses a trending algorithm that balances multiple factors for optimal market discovery.

**Query Parameters**:
- `limit` (optional): Number of results per page (default: 20, max: 100)
- `offset` (optional): Pagination offset (default: 0)
- `min_volume24hr` (optional): Minimum 24h volume filter (default: 0)
- `min_liquidity` (optional): Minimum liquidity filter (default: 0)
- `venue` (optional): Filter by venue ("polymarket", "kalshi")
- `category` (optional): Filter by category (exact match). Categories are extracted from market titles for Polymarket, provided by Kalshi/Limitless APIs
- `filter` (optional): Special filters ("newest", "endingsoon"). When used, automatically applies appropriate sorting (newest first for "newest", ending soonest first for "endingsoon")
- `sort` (optional): Sort order ("totalvol", "liquidity", default: trending)

**Trending Algorithm (Default)**:
The default sorting uses a weighted scoring system to identify trending markets:
- **40%** - 24h Volume: Recent trading activity
- **30%** - Liquidity: Market depth and ease of trading  
- **20%** - New Events: Events created in the last 7 days get a boost
- **10%** - Ending Soon: Events ending within 7 days get a smaller boost

This creates a balanced view that highlights active, liquid markets while giving visibility to new and time-sensitive events.

**Response Fields**:
- **eventVolume**: Total volume across all markets for an event
- **eventLiquidity**: Total liquidity across all markets for an event  
- **eventOpenInterest**: Total open interest/wager across all markets for an event (available for Polymarket and Kalshi)
- **eventSlug**: URL-friendly identifier for the event (available for Polymarket and Limitless)
- **volume24h**: 24-hour trading volume for the specific market
- **volumeTotal**: Total trading volume for the specific market
- **openInterest**: Open interest/wager for the specific market (available for Polymarket and Kalshi)
- **marketSlug**: URL-friendly identifier for the market (available for Polymarket and Limitless)
- **liquidity**: Market depth and ease of trading

**Available Categories**:
- **Politics**: Elections, government, policy, candidates
- **Crypto**: Bitcoin, Ethereum, DeFi, NFTs, blockchain
- **Sports**: NFL, NBA, MLB, soccer, championships
- **Economics**: GDP, inflation, Fed rates, unemployment
- **Technology**: AI, Apple, Google, Tesla, tech companies
- **Entertainment**: Movies, Oscars, Netflix, celebrities
- **Weather**: Hurricanes, climate, temperature
- **Health**: COVID, vaccines, medical topics

Categories are automatically extracted from market titles for Polymarket, while Kalshi and Limitless provide native category data.

**Example Requests**:
```javascript
// Get trending crypto markets
GET /feed?category=Crypto&limit=20

// Get politics markets from Kalshi
GET /feed?category=Politics&venue=kalshi

// Get sports markets with high volume
GET /feed?category=Sports&min_volume24hr=1000&sort=totalvol

// Get all markets (default trending)
GET /feed

// Get new technology markets (sorted by newest first)
GET /feed?category=Technology&filter=newest

// Get events ending soon (sorted by ending soonest first)
GET /feed?filter=endingsoon

// Get newest crypto markets (sorted by newest first)
GET /feed?category=Crypto&filter=newest&limit=10
```

**Example Response**:
```json
{
  "count": 10,
  "limit": 10,
  "offset": 0,
  "minVolume24h": 1000,
  "data": [
    {
      "eventId": "uuid",
      "eventTitle": "Will Bitcoin reach $100k by end of 2024?",
      "category": "Crypto",
      "startTime": "2024-01-01T00:00:00Z",
      "endTime": "2024-12-31T23:59:59Z",
      "eventLiquidity": 50000,
      "eventVolume": 25000,
      "eventOpenInterest": 12000,
      "eventSlug": "bitcoin-100k-2024",
      "markets": [
        {
          "venue": "polymarket",
          "marketId": "market-123",
          "marketTitle": "Bitcoin $100k by 2024",
          "marketSlug": "bitcoin-100k-by-2024",
          "volume24h": 5000,
          "volumeTotal": 15000,
          "openInterest": 3000,
          "liquidity": 25000,
          "acceptingOrders": true,
          "tokens": {
            "yes": "token-yes-123",
            "no": "token-no-123"
          },
          "top": {
            "yesBid": 0.65,
            "yesAsk": 0.67,
            "noBid": 0.33,
            "noAsk": 0.35
          },
          "lastUpdate": "2024-01-15T10:30:00Z"
        }
      ]
    }
  ]
}
```

### 2. Get Price History

**Endpoint**: `GET /price-history`

**Description**: Get historical price data for multiple tokens with intelligent caching and downsampling.

**Query Parameters**:
- `tokens` (required): Comma-separated token IDs
- `venue` (optional): Venue name (default: "polymarket")
- `startTs` (optional): Start timestamp (Unix seconds)
- `endTs` (optional): End timestamp (Unix seconds)
- `interval` (optional): Time interval ("1h", "6h", "1d", "1w", "1m", "6m", "max")
- `fidelity` (optional): Resolution in minutes

**Example Request**:
```javascript
GET /price-history?tokens=token-123,token-456&interval=1d&venue=polymarket
```

**Example Response**:
```json
{
  "venue": "polymarket",
  "tokens": {
    "token-123": {
      "token_id": "token-123",
      "history": [
        {
          "t": 1704067200,
          "o": 0.60,
          "h": 0.65,
          "l": 0.58,
          "c": 0.63,
          "v": 1000
        }
      ],
      "metadata": {
        "requestedInterval": "1d",
        "actualStartTs": 1704067200,
        "actualEndTs": 1704153600,
        "originalDataPoints": 1440,
        "filteredDataPoints": 1440,
        "finalDataPoints": 24,
        "fidelityMinutes": 60
      }
    }
  },
  "metadata": {
    "requestedTokens": 2,
    "successfulTokens": 2,
    "failedTokens": 0,
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

### 3. Get Order Book

**Endpoint**: `GET /orderbook/{tokenId}`

**Description**: Get order book data for a specific token.

**Path Parameters**:
- `tokenId`: The token ID to get order book for

**Example Request**:
```javascript
GET /orderbook/token-123
```

**Example Response**:
```json
{
  "tokenId": "token-123",
  "data": {
    "bids": [
      { "price": 0.65, "size": 100 },
      { "price": 0.64, "size": 200 }
    ],
    "asks": [
      { "price": 0.67, "size": 150 },
      { "price": 0.68, "size": 300 }
    ],
    "timestamp": "2024-01-15T10:30:00Z"
  },
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### 4. Get Batch Order Books

**Endpoint**: `POST /orderbook/batch`

**Description**: Get order books for multiple tokens in a single request.

**Request Body**:
```json
{
  "tokenIds": ["token-123", "token-456", "token-789"]
}
```

**Example Response**:
```json
{
  "tokenIds": ["token-123", "token-456", "token-789"],
  "data": [
    {
      "token_id": "token-123",
      "bids": [...],
      "asks": [...]
    }
  ],
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### 5. Get Current Price

**Endpoint**: `GET /price/{tokenId}?side={BUY|SELL}`

**Description**: Get current bid or ask price for a token.

**Path Parameters**:
- `tokenId`: The token ID

**Query Parameters**:
- `side`: "BUY" or "SELL"

**Example Request**:
```javascript
GET /price/token-123?side=BUY
```

**Example Response**:
```json
{
  "tokenId": "token-123",
  "side": "BUY",
  "data": {
    "price": 0.65,
    "size": 100,
    "timestamp": "2024-01-15T10:30:00Z"
  },
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### 6. Get Batch Prices

**Endpoint**: `POST /price/batch`

**Description**: Get current prices for multiple tokens and sides.

**Request Body**:
```json
{
  "requests": [
    { "token_id": "token-123", "side": "BUY" },
    { "token_id": "token-123", "side": "SELL" },
    { "token_id": "token-456", "side": "BUY" }
  ]
}
```

### 7. Get Midpoint Price

**Endpoint**: `GET /midpoint/{tokenId}`

**Description**: Get the midpoint price between best bid and ask.

**Example Response**:
```json
{
  "tokenId": "token-123",
  "data": {
    "midpoint": 0.66,
    "bid": 0.65,
    "ask": 0.67,
    "spread": 0.02
  },
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### 8. Get Bid-Ask Spreads

**Endpoint**: `POST /spreads`

**Description**: Get bid-ask spreads for multiple tokens.

**Request Body**:
```json
{
  "tokenIds": ["token-123", "token-456"]
}
```

**Example Response**:
```json
{
  "spreads": [
    {
      "tokenId": "token-123",
      "bid": 0.65,
      "ask": 0.67,
      "spread": 0.02,
      "spreadPercent": 3.03
    }
  ],
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### 9. Get Market Details

**Endpoint**: `GET /markets/:marketId`

**Description**: Get detailed information for a specific market, including event information.

**Path Parameters**:
- `marketId`: The market ID (can be the unified market ID or venue-specific market ID)

**Example Request**:
```javascript
GET /markets/polymarket:0x123...
```

**Example Response**:
```json
{
  "marketId": "polymarket:0x123...",
  "venue": "polymarket",
  "venueMarketId": "0x123...",
  "marketTitle": "Will Bitcoin reach $100k by end of 2024?",
  "marketDescription": "Market description...",
  "marketType": "BINARY",
  "openTime": "2024-01-01T00:00:00Z",
  "closeTime": null,
  "expirationTime": "2024-12-31T23:59:59Z",
  "volume24h": 5000,
  "liquidity": 25000,
  "bestBid": 0.65,
  "bestAsk": 0.67,
  "lastPrice": 0.66,
  "outcomes": null,
  "tokens": {
    "yes": "token-yes-123",
    "no": "token-no-123"
  },
  "conditionId": "0x456...",
  "category": "Crypto",
  "marketSlug": "bitcoin-100k-by-2024",
  "marketImage": "https://...",
  "marketIcon": "https://...",
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-15T10:30:00Z",
  "event": {
    "eventId": "event-uuid",
    "eventTitle": "Bitcoin Price Predictions 2024",
    "eventDescription": "Event description...",
    "category": "Crypto",
    "startTime": "2024-01-01T00:00:00Z",
    "endTime": "2024-12-31T23:59:59Z",
    "eventLiquidity": 50000,
    "eventVolume": 25000,
    "eventImage": "https://...",
    "eventIcon": "https://..."
  }
}
```

### 10. Get Event Details

**Endpoint**: `GET /events/:eventId`

**Description**: Get detailed information for a specific event with all associated markets.

**Path Parameters**:
- `eventId`: The event ID (can be the unified event ID or venue-specific event ID)

**Example Request**:
```javascript
GET /events/event-uuid
```

**Example Response**:
```json
{
  "eventId": "event-uuid",
  "venue": "polymarket",
  "venueEventId": "polymarket-event-123",
  "eventTitle": "Bitcoin Price Predictions 2024",
  "eventDescription": "Event description...",
  "category": "Crypto",
  "startTime": "2024-01-01T00:00:00Z",
  "endTime": "2024-12-31T23:59:59Z",
  "status": "ACTIVE",
  "eventLiquidity": 50000,
  "eventVolume": 25000,
  "eventVolume24h": 5000,
  "eventOpenInterest": 12000,
  "eventSlug": "bitcoin-price-predictions-2024",
  "image": "https://...",
  "icon": "https://...",
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-15T10:30:00Z",
  "markets": [
    {
      "marketId": "polymarket:0x123...",
      "venue": "polymarket",
      "venueMarketId": "0x123...",
      "marketTitle": "Will Bitcoin reach $100k by end of 2024?",
      "marketDescription": "Market description...",
      "marketType": "BINARY",
      "status": "ACTIVE",
      "volume24h": 5000,
      "volumeTotal": 15000,
      "openInterest": 3000,
      "liquidity": 25000,
      "bestBid": 0.65,
      "bestAsk": 0.67,
      "lastPrice": 0.66,
      "outcomes": null,
      "tokens": {
        "yes": "token-yes-123",
        "no": "token-no-123"
      },
      "conditionId": "0x456...",
      "category": "Crypto",
      "marketSlug": "bitcoin-100k-by-2024",
      "marketImage": "https://...",
      "marketIcon": "https://...",
      "acceptingOrders": true,
      "top": {
        "yesBid": 0.65,
        "yesAsk": 0.67,
        "noBid": 0.35,
        "noAsk": 0.33
      },
      "openTime": "2024-01-01T00:00:00Z",
      "closeTime": null,
      "expirationTime": "2024-12-31T23:59:59Z",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-15T10:30:00Z",
      "lastUpdate": "2024-01-15T10:30:00Z"
    }
  ]
}
```

---

## Authentication & User Management

### 1. Privy Authentication

**Endpoint**: `POST /auth/privy`

**Description**: Authenticate using Privy access token. This is the primary authentication method.

**Request Body**:
```json
{
  "accessToken": "privy_access_token_here"
}
```

**Example Response**:
```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "username": "trader123",
    "displayName": "John Trader",
    "avatarUrl": "https://...",
    "isActive": true,
    "isVerified": true,
    "createdAt": "2024-01-01T00:00:00Z",
    "lastLoginAt": "2024-01-15T10:30:00Z"
  },
  "session": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresAt": "2024-01-16T10:30:00Z"
  },
  "walletAddresses": [
    "0x1234567890123456789012345678901234567890"
  ],
  "primaryWalletAddress": "0x1234567890123456789012345678901234567890",
  "privyUserId": "privy-user-id"
}
```

### 2. Get Current User

**Endpoint**: `GET /auth/me`

**Description**: Get current authenticated user information.

**Headers**: `Authorization: Bearer <token>`

**Example Response**:
```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "username": "trader123",
    "displayName": "John Trader",
    "avatarUrl": "https://...",
    "isActive": true,
    "isVerified": true,
    "createdAt": "2024-01-01T00:00:00Z",
    "lastLoginAt": "2024-01-15T10:30:00Z"
  },
  "wallets": [
    {
      "id": "wallet-uuid",
      "walletAddress": "0x1234567890123456789012345678901234567890",
      "walletType": "ethereum",
      "isPrimary": true,
      "isVerified": true,
      "createdAt": "2024-01-01T00:00:00Z"
    }
  ],
  "polymarketCredentials": {
    "id": "creds-uuid",
    "walletAddress": "0x1234567890123456789012345678901234567890",
    "isActive": true,
    "createdAt": "2024-01-01T00:00:00Z",
    "lastUsedAt": "2024-01-15T10:30:00Z"
  },
  "currentWallet": "0x1234567890123456789012345678901234567890"
}
```

### 3. Logout

**Endpoint**: `POST /auth/logout`

**Description**: Logout user and invalidate session.

**Headers**: `Authorization: Bearer <token>`

**Example Response**:
```json
{
  "message": "Successfully logged out"
}
```

### 4. Set Venue Credentials

**Endpoint**: `POST /auth/venue-credentials`

**Description**: Set API credentials for trading venues.

**Headers**: `Authorization: Bearer <token>`

**Request Body**:
```json
{
  "venue": "polymarket",
  "apiKey": "your-api-key",
  "apiSecret": "your-api-secret",
  "additionalData": {
    "endpoint": "https://clob.polymarket.com"
  }
}
```

**Example Response**:
```json
{
  "message": "polymarket credentials updated successfully",
  "credentials": {
    "id": "creds-uuid",
    "venue": "polymarket",
    "walletAddress": "0x1234567890123456789012345678901234567890",
    "isActive": true,
    "createdAt": "2024-01-15T10:30:00Z",
    "lastUsedAt": "2024-01-15T10:30:00Z"
  }
}
```

### 5. Get Venue Credentials

**Endpoint**: `GET /auth/venue-credentials`

**Description**: Get all venue credentials for the user.

**Headers**: `Authorization: Bearer <token>`

**Example Response**:
```json
{
  "credentials": [
    {
      "id": "creds-uuid",
      "venue": "polymarket",
      "walletAddress": "0x1234567890123456789012345678901234567890",
      "isActive": true,
      "createdAt": "2024-01-15T10:30:00Z",
      "lastUsedAt": "2024-01-15T10:30:00Z",
      "additionalData": {}
    }
  ]
}
```

### 6. Set Polymarket Credentials

**Endpoint**: `POST /auth/polymarket-credentials`

**Description**: Set Polymarket API credentials for the authenticated user.

**Headers**: `Authorization: Bearer <token>`

**Request Body**:
```json
{
  "apiKey": "your-api-key",
  "apiSecret": "your-api-secret"
}
```

**Example Response**:
```json
{
  "message": "Polymarket credentials updated successfully",
  "credentials": {
    "id": "creds-uuid",
    "venue": "polymarket",
    "walletAddress": "0x1234567890123456789012345678901234567890",
    "isActive": true,
    "createdAt": "2024-01-15T10:30:00Z",
    "lastUsedAt": "2024-01-15T10:30:00Z"
  }
}
```

### 7. Get User Wallets

**Endpoint**: `POST /auth/wallets`

**Description**: Add a new wallet to user account.

**Headers**: `Authorization: Bearer <token>`

**Request Body**:
```json
{
  "walletAddress": "0x9876543210987654321098765432109876543210",
  "walletType": "ethereum",
  "verificationSignature": "0x..."
}
```

### 8. Add Wallet

**Endpoint**: `POST /auth/wallets`

**Description**: Add a new wallet to user account.

**Headers**: `Authorization: Bearer <token>`

**Request Body**:
```json
{
  "walletAddress": "0x9876543210987654321098765432109876543210",
  "walletType": "ethereum",
  "verificationSignature": "0x..."
}
```

**Example Response**:
```json
{
  "message": "Wallet added successfully",
  "wallet": {
    "id": "wallet-uuid",
    "walletAddress": "0x9876543210987654321098765432109876543210",
    "walletType": "ethereum",
    "isPrimary": false,
    "isVerified": true,
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

---

## Order Management

### 1. Place Order

**Endpoint**: `POST /orders`

**Description**: Place a new order on any supported venue.

**Headers**: 
- `Authorization: Bearer <token>`
- `poly_signature: <l1_signature>` (for Polymarket L1 orders)
- `poly_timestamp: <timestamp>`
- `poly_nonce: <nonce>`

**Request Body**:
```json
{
  "venue": "polymarket",
  "tokenId": "token-123",
  "side": "BUY",
  "orderType": "GTC",
  "price": 0.65,
  "size": 100,
  "expiresAt": "2024-01-16T10:30:00Z",
  "l1Signature": "0x...",
  "l1Timestamp": "1705312200",
  "l1Nonce": "nonce-123"
}
```

**Order Types**:
- `GTC`: Good Till Cancelled
- `GTD`: Good Till Date
- `FAK`: Fill And Kill (partial fills allowed)
- `FOK`: Fill Or Kill (must fill completely or cancel)

**Example Response**:
```json
{
  "message": "Order placed successfully",
  "orderId": "order-uuid",
  "venueOrderId": "venue-order-123",
  "status": "submitted"
}
```

### 2. Get Active Orders

**Endpoint**: `GET /orders`

**Description**: Get all active orders for the user.

**Headers**: `Authorization: Bearer <token>`

**Query Parameters**:
- `venue` (optional): Filter by venue ("polymarket", "kalshi", "limitless")

**Example Response**:
```json
{
  "orders": [
    {
      "id": "order-uuid",
      "userId": "user-uuid",
      "venue": "polymarket",
      "venueOrderId": "venue-order-123",
      "tokenId": "token-123",
      "side": "BUY",
      "orderType": "GTC",
      "price": 0.65,
      "size": 100,
      "status": "live",
      "filledSize": 0,
      "averageFillPrice": null,
      "expiresAt": "2024-01-16T10:30:00Z",
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:30:00Z"
    }
  ]
}
```

### 3. Get Order Details

**Endpoint**: `GET /orders/{id}`

**Description**: Get specific order details.

**Headers**: `Authorization: Bearer <token>`

**Path Parameters**:
- `id`: Order ID

**Example Response**:
```json
{
  "order": {
    "id": "order-uuid",
    "userId": "user-uuid",
    "venue": "polymarket",
    "venueOrderId": "venue-order-123",
    "tokenId": "token-123",
    "side": "BUY",
    "orderType": "GTC",
    "price": 0.65,
    "size": 100,
    "status": "live",
    "filledSize": 0,
    "averageFillPrice": null,
    "expiresAt": "2024-01-16T10:30:00Z",
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}
```

### 4. Cancel Order

**Endpoint**: `DELETE /orders/{id}`

**Description**: Cancel an active order.

**Headers**: `Authorization: Bearer <token>`

**Path Parameters**:
- `id`: Order ID

**Example Response**:
```json
{
  "message": "Order cancelled successfully"
}
```

### 5. Get Order History

**Endpoint**: `GET /orders/history`

**Description**: Get order history with pagination and filtering.

**Headers**: `Authorization: Bearer <token>`

**Query Parameters**:
- `venue` (optional): Filter by venue
- `status` (optional): Filter by status
- `limit` (optional): Number of results (default: 50, max: 100)
- `offset` (optional): Pagination offset

**Example Response**:
```json
{
  "orders": [
    {
      "id": "order-uuid",
      "userId": "user-uuid",
      "venue": "polymarket",
      "venueOrderId": "venue-order-123",
      "tokenId": "token-123",
      "side": "BUY",
      "orderType": "GTC",
      "price": 0.65,
      "size": 100,
      "status": "filled",
      "filledSize": 100,
      "averageFillPrice": 0.64,
      "expiresAt": "2024-01-16T10:30:00Z",
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:30:00Z",
      "filledAt": "2024-01-15T10:35:00Z"
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "hasMore": true
  }
}
```

### 6. Get Positions

**Endpoint**: `GET /positions`

**Description**: Get user positions across all venues.

**Headers**: `Authorization: Bearer <token>`

**Query Parameters**:
- `venue` (optional): Filter by venue ("polymarket", "kalshi", "limitless")

**Example Response**:
```json
{
  "positions": [
    {
      "id": "position-uuid",
      "userId": "user-uuid",
      "venue": "polymarket",
      "tokenId": "token-123",
      "side": "LONG",
      "size": 100,
      "averagePrice": 0.64,
      "unrealizedPnl": 10.50,
      "realizedPnl": 0,
      "lastUpdatedAt": "2024-01-15T10:30:00Z",
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:30:00Z"
    }
  ],
  "venue": "polymarket"
}
```

**Note**: If no `venue` parameter is provided, positions from all venues are returned.

### 7. Store Order

**Endpoint**: `POST /orders/store`

**Description**: Store order data after user performs the order on frontend. This API stores the orderID with walletAddress for tracking purposes.

**Request Body**:
```json
{
  "walletAddress": "0x1234567890123456789012345678901234567890",
  "orderID": "venue-order-123",
  "takingAmount": "1000000000000000000",
  "makingAmount": "650000000000000000",
  "status": "live",
  "success": true,
  "errorMsg": null,
  "venue": "polymarket",
  "tokenId": "token-123",
  "side": "BUY",
  "price": 0.65,
  "size": 100
}
```

**Example Response**:
```json
{
  "message": "Order stored successfully",
  "order": {
    "id": "order-uuid",
    "orderID": "venue-order-123",
    "status": "live",
    "storedAt": "2024-01-15T10:30:00Z"
  }
}
```

### 8. Get Orders by Wallet Address

**Endpoint**: `GET /orders/user/:walletAddress`

**Description**: Get order IDs for a specific wallet address. This API fetches all order IDs associated with a wallet address.

**Path Parameters**:
- `walletAddress`: The wallet address (must be valid Ethereum address format)

**Query Parameters**:
- `limit` (optional): Number of results (default: 50, max: 100)
- `offset` (optional): Pagination offset (default: 0)
- `status` (optional): Filter by status
- `venue` (optional): Filter by venue

**Example Request**:
```javascript
GET /orders/user/0x1234567890123456789012345678901234567890?limit=20&venue=polymarket
```

**Example Response**:
```json
{
  "orders": [
    {
      "id": "order-uuid",
      "venueOrderId": "venue-order-123",
      "venue": "polymarket",
      "tokenId": "token-123",
      "side": "BUY",
      "orderType": "GTC",
      "price": 0.65,
      "size": 100,
      "status": "live",
      "filledSize": 0,
      "averageFillPrice": null,
      "postedAt": "2024-01-15T10:30:00Z",
      "lastUpdate": "2024-01-15T10:30:00Z",
      "filledAt": null,
      "cancelledAt": null
    }
  ],
  "pagination": {
    "total": 50,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  }
}
```

---

## Watchlist Management

### 1. Add to Watchlist

**Endpoint**: `POST /watchlist`

**Description**: Add a market to the user's watchlist.

**Headers**: `Authorization: Bearer <token>`

**Request Body**:
```json
{
  "marketId": "polymarket:0x123..."
}
```

**Note**: The `marketId` must be in the format `venue:venue_market_id` (e.g., `polymarket:0x123...`).

**Example Response**:
```json
{
  "message": "Market added to watchlist successfully",
  "watchlistItem": {
    "id": "watchlist-uuid",
    "marketId": "polymarket:0x123...",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

**Error Responses**:
- `400`: Invalid marketId format or market not found
- `409`: Market already in watchlist

### 2. Get Watchlist

**Endpoint**: `GET /watchlist`

**Description**: Get all markets in user's watchlist with full market and event data.

**Headers**: `Authorization: Bearer <token>`

**Query Parameters**:
- `limit` (optional): Number of results per page (default: 50, max: 100)
- `offset` (optional): Pagination offset (default: 0)
- `include_inactive` (optional): Include inactive/closed markets (default: false, set to "true" to include)

**Example Request**:
```javascript
GET /watchlist?limit=20&include_inactive=false
```

**Example Response**:
```json
{
  "count": 10,
  "total": 25,
  "limit": 20,
  "offset": 0,
  "data": [
    {
      "eventId": "event-uuid",
      "eventTitle": "Will Bitcoin reach $100k by end of 2024?",
      "category": "Crypto",
      "startTime": "2024-01-01T00:00:00Z",
      "endTime": "2024-12-31T23:59:59Z",
      "eventLiquidity": 50000,
      "eventVolume": 25000,
      "eventOpenInterest": 12000,
      "eventSlug": "bitcoin-100k-2024",
      "image": "https://...",
      "icon": "https://...",
      "markets": [
        {
          "marketId": "polymarket:0x123...",
          "venue": "polymarket",
          "venueMarketId": "0x123...",
          "marketTitle": "Bitcoin $100k by 2024",
          "marketSlug": "bitcoin-100k-by-2024",
          "volume24h": 5000,
          "volumeTotal": 15000,
          "openInterest": 3000,
          "liquidity": 25000,
          "acceptingOrders": true,
          "tokens": {
            "yes": "token-yes-123",
            "no": "token-no-123"
          },
          "top": {
            "yesBid": 0.65,
            "yesAsk": 0.67,
            "noBid": 0.35,
            "noAsk": 0.33
          },
          "lastUpdate": "2024-01-15T10:30:00Z",
          "watchlistId": "watchlist-uuid",
          "watchlistCreatedAt": "2024-01-15T10:30:00Z"
        }
      ]
    }
  ]
}
```

**Note**: Markets are grouped by event, similar to the `/feed` endpoint structure. Only active markets are included by default unless `include_inactive=true` is specified.

### 3. Remove from Watchlist

**Endpoint**: `DELETE /watchlist/:marketId`

**Description**: Remove a market from user's watchlist.

**Headers**: `Authorization: Bearer <token>`

**Path Parameters**:
- `marketId`: The market ID to remove. Can be:
  - Full composite ID: `venue:venue_market_id` (e.g., `polymarket:0x123...`)
  - Just venue_market_id: `0x123...` (will match any venue with that market_id)

**Example Request**:
```javascript
DELETE /watchlist/polymarket:0x123...
// or
DELETE /watchlist/0x123...
```

**Example Response**:
```json
{
  "message": "Market removed from watchlist successfully",
  "removedItem": {
    "id": "watchlist-uuid",
    "marketId": "polymarket:0x123..."
  }
}
```

**Error Responses**:
- `404`: Market not found in watchlist

---

## WebSocket Streaming

### Price Stream

**Endpoint**: `GET /prices/stream`

**Description**: Server-Sent Events (SSE) stream for real-time price updates.

**Query Parameters**:
- `token_id`: Token ID(s) - can be repeated or comma-separated

**Example Request**:
```javascript
GET /prices/stream?token_id=token-123&token_id=token-456
```

**Event Types**:
- `snapshot`: Initial order book snapshot
- `tick`: Real-time price updates
- `keepalive`: Heartbeat messages

**Example Events**:
```
event: snapshot
data: {"token_id": "token-123", "bids": [...], "asks": [...]}

event: tick
data: {"token_id": "token-123", "price": 0.66, "side": "BUY", "size": 50}

event: keepalive
data: 
```

---

## Error Handling

### Standard Error Response

All endpoints return errors in a consistent format:

```json
{
  "error": "Error type",
  "message": "Detailed error message"
}
```

### HTTP Status Codes

- `200`: Success
- `400`: Bad Request (invalid parameters)
- `401`: Unauthorized (invalid or missing token)
- `403`: Forbidden (insufficient permissions)
- `404`: Not Found
- `429`: Rate Limit Exceeded
- `500`: Internal Server Error

### Common Error Types

**Authentication Errors**:
```json
{
  "error": "Invalid signature",
  "message": "The provided signature is invalid"
}
```

**Validation Errors**:
```json
{
  "error": "Invalid parameters",
  "message": "tokenId is required"
}
```

**Order Errors**:
```json
{
  "error": "INVALID_ORDER_MIN_SIZE",
  "message": "Order size is below the minimum required",
  "rawError": "Detailed venue error message"
}
```

---

## Rate Limiting

The API implements intelligent rate limiting to prevent abuse:

### Client Rate Limits
- **Price History**: 100 requests/minute per IP
- **Order Book**: 100 requests/minute per IP
- **Batch Requests**: 50 requests/minute per IP
- **Price Data**: 100 requests/minute per IP

### Venue-Specific Limits
The API automatically manages venue-specific rate limits:
- **Polymarket**: 80-200 requests/10 seconds (varies by endpoint)
- **Kalshi**: Venue-specific limits
- **Limitless**: Venue-specific limits

### Rate Limit Headers
When rate limits are approached, the API includes headers:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640995200
```

### Rate Limit Exceeded Response
```json
{
  "error": "Rate limit exceeded",
  "message": "Client rate limit exceeded. Please try again later."
}
```

