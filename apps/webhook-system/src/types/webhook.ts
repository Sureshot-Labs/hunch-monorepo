// Webhook system types and interfaces
import { UnifiedTokenId, UnifiedOrder, UnifiedTrade, UnifiedPosition } from '@hunch/shared';

// Webhook event types
export type WebhookEventType = 
  | 'order.created'
  | 'order.updated'
  | 'order.filled'
  | 'order.cancelled'
  | 'order.rejected'
  | 'trade.executed'
  | 'position.updated'
  | 'price.updated'
  | 'market.status_changed'
  | 'user.balance_updated'
  | 'risk.violation'
  | 'analytics.signal_generated'
  | 'analytics.recommendation_updated';

// Webhook status
export type WebhookStatus = 'active' | 'paused' | 'disabled' | 'failed';

// Webhook authentication methods
export type WebhookAuthMethod = 'none' | 'bearer' | 'hmac' | 'api_key';

// Webhook retry policy
export interface WebhookRetryPolicy {
  maxRetries: number;
  retryDelay: number; // milliseconds
  backoffMultiplier: number;
  maxRetryDelay: number; // milliseconds
}

// Webhook configuration
export interface WebhookConfig {
  id: string;
  userId: string;
  name: string;
  description?: string;
  url: string;
  events: WebhookEventType[];
  authMethod: WebhookAuthMethod;
  authConfig?: {
    bearerToken?: string;
    apiKey?: string;
    hmacSecret?: string;
    hmacAlgorithm?: string;
  };
  retryPolicy: WebhookRetryPolicy;
  status: WebhookStatus;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastTriggeredAt?: Date;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  failureCount: number;
  successCount: number;
}

// Webhook event payload
export interface WebhookEvent {
  id: string;
  webhookId: string;
  eventType: WebhookEventType;
  timestamp: Date;
  data: WebhookEventData;
  retryCount: number;
  status: 'pending' | 'delivered' | 'failed' | 'retrying';
  deliveredAt?: Date;
  failedAt?: Date;
  errorMessage?: string;
  responseStatus?: number;
  responseBody?: string;
}

// Webhook event data types
export interface OrderCreatedData {
  order: UnifiedOrder;
  venue: string;
  tokenId: UnifiedTokenId;
}

export interface OrderUpdatedData {
  order: UnifiedOrder;
  previousStatus: string;
  currentStatus: string;
  venue: string;
  tokenId: UnifiedTokenId;
}

export interface OrderFilledData {
  order: UnifiedOrder;
  trades: UnifiedTrade[];
  totalFilled: number;
  averagePrice: number;
  venue: string;
  tokenId: UnifiedTokenId;
}

export interface OrderCancelledData {
  order: UnifiedOrder;
  reason?: string;
  venue: string;
  tokenId: UnifiedTokenId;
}

export interface OrderRejectedData {
  order: UnifiedOrder;
  reason: string;
  venue: string;
  tokenId: UnifiedTokenId;
}

export interface TradeExecutedData {
  trade: UnifiedTrade;
  order: UnifiedOrder;
  venue: string;
  tokenId: UnifiedTokenId;
}

export interface PositionUpdatedData {
  position: UnifiedPosition;
  previousQuantity: number;
  previousAveragePrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  venue: string;
  tokenId: UnifiedTokenId;
}

export interface PriceUpdatedData {
  tokenId: UnifiedTokenId;
  price: number;
  previousPrice: number;
  priceChange: number;
  priceChangePercent: number;
  volume: number;
  timestamp: Date;
  venue: string;
}

export interface MarketStatusChangedData {
  marketId: string;
  venue: string;
  previousStatus: string;
  currentStatus: string;
  title: string;
  acceptingOrders: boolean;
}

export interface UserBalanceUpdatedData {
  userId: string;
  venue: string;
  previousBalance: number;
  currentBalance: number;
  balanceChange: number;
  currency: string;
}

export interface RiskViolationData {
  userId: string;
  violationType: string;
  violationValue: number;
  limitValue: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  timestamp: Date;
}

export interface AnalyticsSignalGeneratedData {
  tokenId: UnifiedTokenId;
  signal: string;
  strength: number;
  timeframe: string;
  indicators: {
    rsi: string;
    macd: string;
    bollinger: string;
    stochastic: string;
    movingAverage: string;
  };
  timestamp: Date;
}

export interface AnalyticsRecommendationUpdatedData {
  tokenId: UnifiedTokenId;
  recommendations: Array<{
    action: string;
    confidence: number;
    reasoning: string[];
    targetPrice?: number;
    stopLoss?: number;
    timeHorizon: string;
    riskLevel: string;
  }>;
  timestamp: Date;
}

// Union type for all webhook event data
export type WebhookEventData = 
  | OrderCreatedData
  | OrderUpdatedData
  | OrderFilledData
  | OrderCancelledData
  | OrderRejectedData
  | TradeExecutedData
  | PositionUpdatedData
  | PriceUpdatedData
  | MarketStatusChangedData
  | UserBalanceUpdatedData
  | RiskViolationData
  | AnalyticsSignalGeneratedData
  | AnalyticsRecommendationUpdatedData;

// Webhook delivery attempt
export interface WebhookDeliveryAttempt {
  id: string;
  webhookEventId: string;
  attemptNumber: number;
  timestamp: Date;
  status: 'pending' | 'success' | 'failed';
  responseStatus?: number;
  responseBody?: string;
  errorMessage?: string;
  duration: number; // milliseconds
  retryAfter?: number; // milliseconds
}

// Webhook statistics
export interface WebhookStats {
  totalWebhooks: number;
  activeWebhooks: number;
  pausedWebhooks: number;
  disabledWebhooks: number;
  totalEvents: number;
  deliveredEvents: number;
  failedEvents: number;
  pendingEvents: number;
  averageDeliveryTime: number; // milliseconds
  successRate: number; // percentage
  last24hEvents: number;
  last24hDeliveries: number;
  last24hFailures: number;
}

// Webhook validation result
export interface WebhookValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

// Webhook test result
export interface WebhookTestResult {
  success: boolean;
  statusCode?: number;
  responseBody?: string;
  errorMessage?: string;
  duration: number; // milliseconds
  timestamp: Date;
}

// Webhook queue configuration
export interface WebhookQueueConfig {
  concurrency: number;
  batchSize: number;
  batchTimeout: number; // milliseconds
  maxQueueSize: number;
  enableDeadLetterQueue: boolean;
  deadLetterQueueRetention: number; // milliseconds
}

// Webhook filter configuration
export interface WebhookFilter {
  userId?: string;
  venue?: string;
  tokenId?: UnifiedTokenId;
  eventTypes?: WebhookEventType[];
  status?: WebhookStatus;
  isActive?: boolean;
  createdAfter?: Date;
  createdBefore?: Date;
}

// Webhook subscription
export interface WebhookSubscription {
  id: string;
  userId: string;
  webhookId: string;
  eventTypes: WebhookEventType[];
  filters?: Record<string, any>;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Webhook rate limiting
export interface WebhookRateLimit {
  requestsPerMinute: number;
  requestsPerHour: number;
  requestsPerDay: number;
  burstLimit: number;
}

// Webhook security configuration
export interface WebhookSecurity {
  allowedIPs?: string[];
  blockedIPs?: string[];
  requireHTTPS: boolean;
  validateSSL: boolean;
  timeout: number; // milliseconds
  maxPayloadSize: number; // bytes
}
