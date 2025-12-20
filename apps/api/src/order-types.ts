// Order Management Types and Interfaces
// This file defines the core types and interfaces for order management

export interface Order {
  id: string;
  userId: string;
  venue: "polymarket" | "kalshi" | "limitless";
  venueOrderId?: string;

  tokenId: string;
  side: "BUY" | "SELL";
  orderType: "GTC" | "GTD" | "FAK" | "FOK";
  price: number;
  size: number;

  status: OrderStatus;
  filledSize: number;
  averageFillPrice?: number;

  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  filledAt?: Date;
  cancelledAt?: Date;

  errorMessage?: string;
  rawError?: string;
}

export interface OrderFill {
  id: string;
  orderId: string;
  venueFillId?: string;

  fillSize: number;
  fillPrice: number;
  fillSide: "BUY" | "SELL";

  filledAt: Date;
  createdAt: Date;

  venueTradeId?: string;
  fees: number;
}

export interface Position {
  id: string;
  userId: string;
  venue: "polymarket" | "kalshi" | "limitless";
  tokenId: string;

  side: "LONG" | "SHORT" | "FLAT";
  size: number;
  averagePrice?: number;
  unrealizedPnl: number;
  realizedPnl: number;
  estimatedPayout?: number;
  estimatedProfit?: number;

  lastUpdatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderLog {
  id: string;
  orderId?: string;
  userId: string;
  venue: string;

  logLevel: "INFO" | "WARN" | "ERROR" | "DEBUG";
  message: string;
  rawData?: unknown;

  action: string;
  venueOrderId?: string;

  createdAt: Date;
}

export type OrderStatus =
  | "pending"
  | "submitted"
  | "live"
  | "matched"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "expired"
  | "delayed"
  | "unmatched";

export interface PlaceOrderRequest {
  tokenId: string;
  side: "BUY" | "SELL";
  orderType: "GTC" | "GTD" | "FAK" | "FOK";
  price: number;
  size: number;
  expiresAt?: Date;
  l1Signature?: string;
  l1Timestamp?: string;
  l1Nonce?: string;
}

export interface PlaceOrderResponse {
  success: boolean;
  orderId?: string;
  venueOrderId?: string;
  status?: OrderStatus;
  errorMessage?: string;
  rawError?: string;
}

export interface CancelOrderResponse {
  success: boolean;
  errorMessage?: string;
  rawError?: string;
}

export interface GetOrderResponse {
  success: boolean;
  order?: Order;
  errorMessage?: string;
}

export interface GetActiveOrdersResponse {
  success: boolean;
  orders: Order[];
  errorMessage?: string;
}

export interface GetPositionsResponse {
  success: boolean;
  positions: Position[];
  errorMessage?: string;
}

// Venue Order Manager Interface
export interface VenueOrderManager {
  venue: "polymarket" | "kalshi" | "limitless";

  // Order operations
  placeOrder(
    userId: string,
    walletAddress: string,
    headers: unknown,
    request: PlaceOrderRequest & {
      l1Signature?: string;
      l1Timestamp?: string;
      l1Nonce?: string;
    },
  ): Promise<PlaceOrderResponse>;
  cancelOrder(
    userId: string,
    walletAddress: string,
    orderId: string,
  ): Promise<CancelOrderResponse>;
  getOrder(
    userId: string,
    walletAddress: string,
    orderId: string,
  ): Promise<GetOrderResponse>;
  getActiveOrders(
    userId: string,
    walletAddress: string,
  ): Promise<GetActiveOrdersResponse>;

  // Position operations
  getPositions(
    userId: string,
    walletAddress: string,
  ): Promise<GetPositionsResponse>;

  // Utility methods
  validateOrder(request: PlaceOrderRequest): { valid: boolean; error?: string };
  mapVenueStatus(venueStatus: string): OrderStatus;
  mapVenueError(venueError: string): string;
}

// Polymarket specific types
export interface PolymarketOrder {
  salt: number;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: number;
  signatureType: number;
  signature: string;
}

export interface PolymarketOrderResponse {
  success: boolean;
  errorMsg?: string;
  orderId?: string;
  orderHashes?: string[];
}

export interface PolymarketOrderStatus {
  orderId: string;
  status: "matched" | "live" | "delayed" | "unmatched";
  filledSize?: number;
  averageFillPrice?: number;
}

// Error mapping for user-friendly messages
export const VENUE_ERROR_MAPPING: Record<string, string> = {
  INVALID_ORDER_MIN_TICK_SIZE:
    "Order price is not accurate to the minimum tick size",
  INVALID_ORDER_MIN_SIZE: "Order size is below the minimum required",
  INVALID_ORDER_DUPLICATED: "This order has already been placed",
  INVALID_ORDER_NOT_ENOUGH_BALANCE: "Insufficient balance to place this order",
  INVALID_ORDER_EXPIRATION: "Order expiration time is invalid",
  INVALID_ORDER_ERROR: "Order could not be processed",
  EXECUTION_ERROR: "Order execution failed",
  ORDER_DELAYED: "Order placement is delayed due to market conditions",
  DELAYING_ORDER_ERROR: "Error occurred while delaying the order",
  FOK_ORDER_NOT_FILLED_ERROR: "Fill-or-Kill order could not be fully filled",
  MARKET_NOT_READY: "Market is not ready to process orders",
};

// Status mapping from venue to internal
export const VENUE_STATUS_MAPPING: Record<string, OrderStatus> = {
  matched: "matched",
  live: "live",
  delayed: "delayed",
  unmatched: "unmatched",
  pending: "pending",
  submitted: "submitted",
  partially_filled: "partially_filled",
  filled: "filled",
  cancelled: "cancelled",
  rejected: "rejected",
  expired: "expired",
};
