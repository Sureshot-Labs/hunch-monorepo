// Comprehensive Zod validation schemas for API endpoints
import { z } from 'zod';

// ============================================================
// Common schemas
// ============================================================

export const UUIDSchema = z.string().uuid('Invalid UUID format');

export const VenueSchema = z.enum(['polymarket', 'kalshi', 'limitless'], 
  'Invalid venue. Must be polymarket, kalshi, or limitless'
);

export const OrderSideSchema = z.enum(['BUY', 'SELL'], 
  'Invalid side. Must be BUY or SELL'
);

export const OrderTypeSchema = z.enum(['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'], 
  'Invalid order type'
);

export const OrderStatusSchema = z.enum([
  'PENDING',
  'SUBMITTED',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELLED',
  'REJECTED',
]);

export const TimeInForceSchema = z.enum(['GTC', 'IOC', 'FOK'], 
  'Invalid time in force. Must be GTC, IOC, or FOK'
);

// ============================================================
// Price and amount validation
// ============================================================

export const PriceSchema = z.number()
  .min(0, 'Price must be non-negative')
  .max(1, 'Price must be between 0 and 1')
  .finite('Price must be a finite number');

export const AmountUSDSchema = z.number()
  .positive('Amount must be positive')
  .max(1000000, 'Amount cannot exceed $1,000,000')
  .finite('Amount must be a finite number');

export const PositiveNumberSchema = z.number()
  .positive('Must be a positive number')
  .finite('Must be a finite number');

// ============================================================
// Trading schemas
// ============================================================

export const CreateOrderSchema = z.object({
  venue: VenueSchema,
  tokenId: z.string().min(1, 'Token ID is required'),
  side: OrderSideSchema,
  orderType: OrderTypeSchema,
  price: PriceSchema.optional(),
  sizeUsd: AmountUSDSchema,
  timeInForce: TimeInForceSchema.default('GTC'),
  idempotencyKey: z.string().optional(),
}).refine(
  (data) => {
    // LIMIT orders require a price
    if (data.orderType === 'LIMIT' && data.price === undefined) {
      return false;
    }
    return true;
  },
  {
    message: 'LIMIT orders require a price',
    path: ['price'],
  }
);

export const CancelOrderSchema = z.object({
  orderId: UUIDSchema,
  reason: z.string().max(500).optional(),
});

export const GetOrdersSchema = z.object({
  status: OrderStatusSchema.optional(),
  venue: VenueSchema.optional(),
  tokenId: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).default(50),
  offset: z.coerce.number().min(0).default(0),
});

// ============================================================
// Feed / Market Data schemas
// ============================================================

export const FeedQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(500).default(50),
  offset: z.coerce.number().min(0).default(0).optional(),
  cursor: z.string().optional(),
  min_volume24hr: z.coerce.number().min(0).optional(),
  min_liquidity: z.coerce.number().min(0).optional(),
  venue: VenueSchema.optional(),
  category: z.string().max(100).optional(),
  filter: z.enum(['newest', 'endingsoon', 'active', 'popular']).optional(),
  sort: z.enum(['totalvol', 'liquidity', 'newest', 'endingsoon', 'starttime']).default('starttime'),
});

export const PriceStreamSchema = z.object({
  token_id: z.union([
    z.string().min(1),
    z.array(z.string().min(1)),
  ]).transform(val => Array.isArray(val) ? val : [val]),
});

// ============================================================
// Analytics schemas
// ============================================================

export const ResolutionSchema = z.enum(['1m', '5m', '1h', '1d', '1w'], 
  'Invalid resolution. Must be 1m, 5m, 1h, 1d, or 1w'
);

export const PeriodSchema = z.enum(['1d', '7d', '30d', '90d', '1y', 'all'], 
  'Invalid period'
);

export const AnalyzeMarketSchema = z.object({
  tokenId: z.string().min(1, 'Token ID is required'),
  resolution: ResolutionSchema.default('1h'),
  period: PeriodSchema.default('7d'),
});

export const PriceHistorySchema = z.object({
  tokenId: z.string().min(1, 'Token ID is required'),
  resolution: ResolutionSchema.default('1h'),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(10000).default(1000),
});

// ============================================================
// Webhook schemas
// ============================================================

export const WebhookEventTypeSchema = z.enum([
  'order.created',
  'order.updated',
  'order.filled',
  'order.cancelled',
  'trade.executed',
  'position.updated',
  'price.updated',
  'market.updated',
]);

export const WebhookAuthMethodSchema = z.enum(['none', 'bearer', 'hmac', 'api_key']);

export const CreateWebhookSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().max(1000).optional(),
  url: z.string().url('Invalid webhook URL'),
  events: z.array(WebhookEventTypeSchema).min(1, 'At least one event type is required'),
  authMethod: WebhookAuthMethodSchema.default('none'),
  authConfig: z.record(z.string(), z.any()).optional(),
  retryPolicy: z.object({
    maxRetries: z.number().min(0).max(10).default(3),
    retryDelay: z.number().min(1000).max(300000).default(5000),
    backoffMultiplier: z.number().min(1).max(10).default(2),
    maxRetryDelay: z.number().min(1000).max(600000).default(60000),
  }),
});

// ============================================================
// Admin schemas
// ============================================================

export const EmergencyStopSchema = z.object({
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
  venueId: z.number().optional(),
  disabledBy: z.string().min(1, 'DisabledBy is required'),
});

export const UpdateUserLimitsSchema = z.object({
  userId: UUIDSchema,
  coolingOffEnabled: z.boolean().optional(),
  coolingOffLimitUsd: z.number().positive().optional(),
  dailyLimitUsd: z.number().positive().optional(),
  maxSingleOrderUsd: z.number().positive().optional(),
  limitsDisabled: z.boolean().optional(),
  updatedBy: z.string().min(1),
  reason: z.string().optional(),
});

// ============================================================
// Validation helper function
// ============================================================

export function validateOrThrow<T extends z.ZodType>(
  schema: T,
  data: unknown
): z.infer<T> {
  const result = schema.safeParse(data);
  
  if (!result.success) {
    const error = new ValidationError('Validation failed', result.error.issues);
    throw error;
  }
  
  return result.data;
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public issues: z.ZodIssue[]
  ) {
    super(message);
    this.name = 'ValidationError';
  }

  toJSON() {
    return {
      error: this.message,
      details: this.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    };
  }
}

