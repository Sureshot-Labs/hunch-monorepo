# Hunch Trading Platform API Documentation

## Table of Contents
1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Base URL](#base-url)
4. [Market Data Endpoints](#market-data-endpoints)
5. [Authentication & User Management](#authentication--user-management)
6. [Order Management](#order-management)
7. [Error Handling](#error-handling)
8. [Rate Limiting](#rate-limiting)
9. [WebSocket Streaming](#websocket-streaming)

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

The API uses JWT-based authentication with wallet signatures. Most endpoints require authentication via the `Authorization` header.

### Authentication Flow

1. **Generate Nonce**: Request a nonce for wallet signature
2. **Sign Message**: Sign the message with your wallet
3. **Verify & Login**: Submit signature to get JWT token
4. **Use Token**: Include token in subsequent requests

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
- `filter` (optional): Special filters ("newest", "endingsoon")
- `sort` (optional): Sort order ("totalvol", "liquidity", default: trending)

**Trending Algorithm (Default)**:
The default sorting uses a weighted scoring system to identify trending markets:
- **40%** - 24h Volume: Recent trading activity
- **30%** - Liquidity: Market depth and ease of trading  
- **20%** - New Events: Events created in the last 7 days get a boost
- **10%** - Ending Soon: Events ending within 7 days get a smaller boost

This creates a balanced view that highlights active, liquid markets while giving visibility to new and time-sensitive events.

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

// Get new technology markets
GET /feed?category=Technology&filter=newest
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
      "markets": [
        {
          "venue": "polymarket",
          "marketId": "market-123",
          "marketTitle": "Bitcoin $100k by 2024",
          "volume24h": 5000,
          "volumeTotal": 15000,
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

---

## Authentication & User Management

### 1. Generate Nonce

**Endpoint**: `POST /auth/nonce`

**Description**: Generate a nonce for wallet signature verification.

**Request Body**:
```json
{
  "walletAddress": "0x1234567890123456789012345678901234567890"
}
```

**Example Response**:
```json
{
  "nonce": "abc123def456...",
  "message": "Sign this message to authenticate with Hunch Trading Platform.\n\nNonce: abc123def456...\nWallet: 0x1234567890123456789012345678901234567890",
  "expiresIn": 300
}
```

### 2. Verify Signature & Login

**Endpoint**: `POST /auth/verify`

**Description**: Verify wallet signature and authenticate user.

**Request Body**:
```json
{
  "walletAddress": "0x1234567890123456789012345678901234567890",
  "signature": "0x...",
  "userData": {
    "email": "user@example.com",
    "username": "trader123",
    "displayName": "John Trader",
    "avatarUrl": "https://..."
  }
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
  "walletAddress": "0x1234567890123456789012345678901234567890"
}
```

### 3. Get Current User

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

### 4. Logout

**Endpoint**: `POST /auth/logout`

**Description**: Logout user and invalidate session.

**Headers**: `Authorization: Bearer <token>`

**Example Response**:
```json
{
  "message": "Successfully logged out"
}
```

### 5. Set Venue Credentials

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

### 6. Get Venue Credentials

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

### 7. Add Wallet

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

### 8. Get User Wallets

**Endpoint**: `GET /auth/wallets`

**Description**: Get all wallets associated with the user.

**Headers**: `Authorization: Bearer <token>`

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
- `venue` (optional): Filter by venue

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
  ]
}
```

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

---

## Order Status Reference

### Order Statuses
- `pending`: Order is being processed
- `submitted`: Order submitted to venue
- `live`: Order is active on the order book
- `matched`: Order has been matched
- `partially_filled`: Order partially filled
- `filled`: Order completely filled
- `cancelled`: Order cancelled
- `rejected`: Order rejected by venue
- `expired`: Order expired
- `delayed`: Order placement delayed
- `unmatched`: Order unmatched

### Position Sides
- `LONG`: Long position (bought tokens)
- `SHORT`: Short position (sold tokens)
- `FLAT`: No position

---

## SDK Examples

### JavaScript/TypeScript

```typescript
class HunchAPI {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string = 'https://api.hunch.trading') {
    this.baseUrl = baseUrl;
  }

  async authenticate(walletAddress: string, signature: string) {
    // 1. Get nonce
    const nonceResponse = await fetch(`${this.baseUrl}/auth/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress })
    });
    const { nonce, message } = await nonceResponse.json();

    // 2. Verify signature
    const verifyResponse = await fetch(`${this.baseUrl}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, signature })
    });
    const { session } = await verifyResponse.json();
    this.token = session.token;
  }

  async getFeed(params: any = {}) {
    const query = new URLSearchParams(params).toString();
    const response = await fetch(`${this.baseUrl}/feed?${query}`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    return response.json();
  }

  async placeOrder(order: any) {
    const response = await fetch(`${this.baseUrl}/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(order)
    });
    return response.json();
  }
}
```

### Python

```python
import requests
from typing import Optional, Dict, Any

class HunchAPI:
    def __init__(self, base_url: str = "https://api.hunch.trading"):
        self.base_url = base_url
        self.token: Optional[str] = None

    def authenticate(self, wallet_address: str, signature: str) -> Dict[str, Any]:
        # 1. Get nonce
        nonce_response = requests.post(
            f"{self.base_url}/auth/nonce",
            json={"walletAddress": wallet_address}
        )
        nonce_data = nonce_response.json()

        # 2. Verify signature
        verify_response = requests.post(
            f"{self.base_url}/auth/verify",
            json={"walletAddress": wallet_address, "signature": signature}
        )
        session_data = verify_response.json()
        self.token = session_data["session"]["token"]
        return session_data

    def get_feed(self, **params) -> Dict[str, Any]:
        response = requests.get(
            f"{self.base_url}/feed",
            params=params,
            headers={"Authorization": f"Bearer {self.token}"}
        )
        return response.json()

    def place_order(self, order: Dict[str, Any]) -> Dict[str, Any]:
        response = requests.post(
            f"{self.base_url}/orders",
            json=order,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json"
            }
        )
        return response.json()
```

---

## Support

For API support, please contact:
- **Email**: api-support@hunch.trading
- **Documentation**: https://docs.hunch.trading
- **Status Page**: https://status.hunch.trading

---

*Last updated: January 2024*



