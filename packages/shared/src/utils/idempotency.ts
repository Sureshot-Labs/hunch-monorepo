// Idempotency key generation and validation utilities
import crypto from 'crypto';

export interface IdempotencyKeyComponents {
  source: 'polymarket' | 'kalshi' | 'limitless';
  resourceType: 'event' | 'market' | 'token' | 'trade' | 'book';
  resourceId: string;
  timestamp?: string | number | Date;
  additionalData?: string;
}

/**
 * Generate a deterministic idempotency key using SHA-256
 * This ensures the same data always produces the same key
 */
export function generateIdempotencyKey(components: IdempotencyKeyComponents): string {
  const parts: string[] = [
    components.source,
    components.resourceType,
    components.resourceId,
  ];

  // Add timestamp if provided (normalized to ISO string)
  if (components.timestamp) {
    const ts = components.timestamp instanceof Date 
      ? components.timestamp.toISOString()
      : new Date(components.timestamp).toISOString();
    parts.push(ts);
  }

  // Add any additional data (e.g., price, volume for price ticks)
  if (components.additionalData) {
    parts.push(components.additionalData);
  }

  // Create deterministic string and hash it
  const dataString = parts.join(':');
  return crypto.createHash('sha256').update(dataString).digest('hex');
}

/**
 * Generate idempotency key for event ingestion
 */
export function generateEventIdempotencyKey(
  source: 'polymarket' | 'kalshi' | 'limitless',
  eventId: string,
  timestamp?: string | number | Date
): string {
  return generateIdempotencyKey({
    source,
    resourceType: 'event',
    resourceId: eventId,
    timestamp,
  });
}

/**
 * Generate idempotency key for market ingestion
 */
export function generateMarketIdempotencyKey(
  source: 'polymarket' | 'kalshi' | 'limitless',
  marketId: string,
  timestamp?: string | number | Date
): string {
  return generateIdempotencyKey({
    source,
    resourceType: 'market',
    resourceId: marketId,
    timestamp,
  });
}

/**
 * Generate idempotency key for token ingestion
 */
export function generateTokenIdempotencyKey(
  source: 'polymarket' | 'kalshi' | 'limitless',
  tokenId: string
): string {
  return generateIdempotencyKey({
    source,
    resourceType: 'token',
    resourceId: tokenId,
  });
}

/**
 * Generate idempotency key for price/book top data
 */
export function generateBookIdempotencyKey(
  source: 'polymarket' | 'kalshi' | 'limitless',
  tokenId: string,
  timestamp: string | number | Date,
  price?: number
): string {
  return generateIdempotencyKey({
    source,
    resourceType: 'book',
    resourceId: tokenId,
    timestamp,
    additionalData: price !== undefined ? price.toString() : undefined,
  });
}

/**
 * Generate idempotency key for trade data
 */
export function generateTradeIdempotencyKey(
  source: 'polymarket' | 'kalshi' | 'limitless',
  tradeId: string,
  timestamp: string | number | Date
): string {
  return generateIdempotencyKey({
    source,
    resourceType: 'trade',
    resourceId: tradeId,
    timestamp,
  });
}

/**
 * Validate idempotency key format
 */
export function isValidIdempotencyKey(key: string): boolean {
  // SHA-256 hash is 64 hex characters
  return /^[a-f0-9]{64}$/.test(key);
}

/**
 * Create a short version of idempotency key for logging (first 12 chars)
 */
export function shortenIdempotencyKey(key: string): string {
  return key.substring(0, 12);
}

