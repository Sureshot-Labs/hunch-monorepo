// Unified data types for all exchanges
export type Venue = 'polymarket' | 'kalshi' | 'limitless';

export type MarketStatus = 'active' | 'paused' | 'closed' | 'settled';
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP';
export type OrderStatus = 'PENDING' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'REJECTED';
export type TokenSide = 'YES' | 'NO';

// Unified token ID format: venue:marketId:side
export type UnifiedTokenId = `${Venue}:${string}:${TokenSide}`;

// Core unified market data structure
export interface UnifiedMarket {
  // Core Identifiers
  id: string;                    // Our UUID
  venue: Venue;
  venueMarketId: string;         // Original market ID from venue
  venueEventId: string;         // Original event ID from venue
  
  // Market Details
  title: string;
  description?: string;
  category?: string;
  tags: string[];
  
  // Status & Timing
  status: MarketStatus;
  acceptingOrders: boolean;
  startTime?: Date;
  endTime?: Date;
  
  // Financial Data (Normalized to 0-1 range)
  yesPrice: number;             // Current YES price (0-1)
  noPrice: number;              // Current NO price (0-1)
  liquidity: number;            // Total liquidity in USD
  volume24h: number;           // 24h volume in USD
  volumeTotal: number;         // Total volume in USD
  
  // Order Book Data
  bestBid: number;             // Best bid price (0-1)
  bestAsk: number;             // Best ask price (0-1)
  spread: number;              // Ask - Bid
  midPrice: number;            // (Bid + Ask) / 2
  
  // Token Information
  yesTokenId: UnifiedTokenId;   // Unified token ID format
  noTokenId: UnifiedTokenId;   // Unified token ID format
  
  // Trading Parameters
  minOrderSize: number;        // Minimum order size in USD
  tickSize: number;            // Minimum price increment
  maxOrderSize?: number;       // Maximum order size
  
  // Metadata
  rawData: any;               // Original venue data
  lastUpdated: Date;
  createdAt: Date;
}

// Unified event data structure
export interface UnifiedEvent {
  id: string;                  // Our UUID
  venue: Venue;
  venueEventId: string;        // Original event ID from venue
  
  title: string;
  description?: string;
  category?: string;
  tags: string[];
  
  status: MarketStatus;
  startTime?: Date;
  endTime?: Date;
  
  // Aggregated financial data
  totalLiquidity: number;
  totalVolume24h: number;
  totalVolume: number;
  
  markets: UnifiedMarket[];
  
  rawData: any;
  lastUpdated: Date;
  createdAt: Date;
}

// Unified price data structure
export interface UnifiedPriceData {
  tokenId: UnifiedTokenId;
  timestamp: Date;
  
  // OHLC Data (normalized to 0-1 range)
  open: number;
  high: number;
  low: number;
  close: number;
  
  // Volume Data
  volumeUsd: number;
  tradeCount: number;
  
  // Market Data
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  
  // Resolution
  resolution: string; // '1m', '5m', '1h', '1d', etc.
}

// Unified order data structure
export interface UnifiedOrder {
  id: string;                  // Our UUID
  userId: string;
  venue: Venue;
  tokenId: UnifiedTokenId;
  
  // Order Details
  side: OrderSide;
  orderType: OrderType;
  price?: number;              // For limit orders
  sizeUsd: number;
  sizeTokens?: number;
  
  // Status Tracking
  status: OrderStatus;
  filledSizeUsd: number;
  filledSizeTokens?: number;
  averageFillPrice?: number;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  filledAt?: Date;
  cancelledAt?: Date;
  
  // External References
  venueOrderId?: string;       // Order ID from the venue
  venueTxHash?: string;        // Transaction hash from venue
  
  // Metadata
  rawData?: any;
}

// Unified trade data structure
export interface UnifiedTrade {
  id: string;                  // Our UUID
  orderId?: string;
  userId: string;
  venue: Venue;
  tokenId: UnifiedTokenId;
  
  // Trade Details
  side: OrderSide;
  price: number;
  sizeUsd: number;
  sizeTokens?: number;
  
  // Timestamps
  executedAt: Date;
  createdAt: Date;
  
  // External References
  venueTradeId?: string;
  venueTxHash?: string;
  
  // Fees
  feeUsd: number;
  feeTokens?: number;
  
  // Metadata
  rawData?: any;
}

// Unified position data structure
export interface UnifiedPosition {
  id: string;                  // Our UUID
  userId: string;
  tokenId: UnifiedTokenId;
  
  // Position Details
  side: TokenSide;
  quantity: number;
  averagePrice?: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

// User data structure
export interface UnifiedUser {
  id: string;                  // Our UUID
  email: string;
  username: string;
  firstName?: string;
  lastName?: string;
  isActive: boolean;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLogin?: Date;
}

// Wallet data structure
export interface UnifiedWallet {
  id: string;                  // Our UUID
  userId: string;
  venue: Venue;
  walletAddress?: string;
  balanceUsd: number;
  balanceTokens: number;
  tokenSymbol?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Chart data structure for frontend
export interface ChartDataPoint {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartData {
  tokenId: UnifiedTokenId;
  resolution: string;
  data: ChartDataPoint[];
  metadata: {
    startTime: Date;
    endTime: Date;
    dataPoints: number;
    totalVolume: number;
  };
}

// API Response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: Date;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// WebSocket message types
export interface PriceUpdateMessage {
  type: 'price_update';
  tokenId: UnifiedTokenId;
  price: number;
  timestamp: Date;
  volume?: number;
}

export interface OrderUpdateMessage {
  type: 'order_update';
  orderId: string;
  status: OrderStatus;
  filledSize?: number;
  timestamp: Date;
}

export interface TradeMessage {
  type: 'trade';
  tradeId: string;
  tokenId: UnifiedTokenId;
  side: OrderSide;
  price: number;
  size: number;
  timestamp: Date;
}

export type WebSocketMessage = PriceUpdateMessage | OrderUpdateMessage | TradeMessage;
