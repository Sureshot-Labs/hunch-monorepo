// Dead Letter Queue service for failed ingestion
import { Pool } from 'pg';

export interface DLQItem {
  id: string;
  source: 'polymarket' | 'kalshi' | 'limitless';
  resourceType: 'event' | 'market' | 'token' | 'book' | 'trade';
  endpoint: string;
  requestMethod?: string;
  requestParams?: any;
  requestBody?: any;
  responseStatus?: number;
  responseBody?: string;
  errorType: string;
  errorMessage: string;
  errorStack?: string;
  rawPayload: any;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: Date;
  lastRetryAt?: Date;
  status: 'pending' | 'retrying' | 'failed' | 'resolved' | 'ignored';
  createdAt: Date;
}

export interface AddToDLQOptions {
  source: 'polymarket' | 'kalshi' | 'limitless';
  resourceType: 'event' | 'market' | 'token' | 'book' | 'trade';
  endpoint: string;
  errorType: string;
  errorMessage: string;
  rawPayload: any;
  responseStatus?: number;
  responseBody?: string;
  requestParams?: any;
  errorStack?: string;
}

export class DeadLetterQueueService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Add failed ingestion to DLQ
   */
  async addToDLQ(options: AddToDLQOptions): Promise<string> {
    const result = await this.pool.query(
      `SELECT add_to_dlq($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        options.source,
        options.resourceType,
        options.endpoint,
        options.errorType,
        options.errorMessage,
        JSON.stringify(options.rawPayload),
        options.responseStatus || null,
        options.responseBody || null,
        options.requestParams ? JSON.stringify(options.requestParams) : null,
      ]
    );

    const dlqId = result.rows[0].add_to_dlq;
    
    console.warn(`[DLQ] Added item ${dlqId} - ${options.source}/${options.resourceType}: ${options.errorMessage}`);
    
    return dlqId;
  }

  /**
   * Get items ready for retry
   */
  async getItemsForRetry(limit: number = 100): Promise<DLQItem[]> {
    const result = await this.pool.query(
      'SELECT * FROM get_dlq_items_for_retry($1)',
      [limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      source: row.source,
      resourceType: row.resource_type,
      endpoint: row.endpoint,
      rawPayload: row.raw_payload,
      retryCount: row.retry_count,
      errorMessage: row.error_message,
      errorType: '',
      maxRetries: 3,
      status: 'pending',
      createdAt: new Date(),
    }));
  }

  /**
   * Update DLQ item after retry attempt
   */
  async updateRetryAttempt(
    id: string,
    success: boolean,
    errorMessage?: string
  ): Promise<void> {
    await this.pool.query(
      'SELECT update_dlq_retry($1, $2, $3)',
      [id, success, errorMessage || null]
    );

    if (success) {
      console.log(`[DLQ] Successfully processed item ${id}`);
    } else {
      console.warn(`[DLQ] Retry failed for item ${id}: ${errorMessage}`);
    }
  }

  /**
   * Get DLQ statistics
   */
  async getStats(): Promise<any[]> {
    const result = await this.pool.query('SELECT * FROM dlq_stats ORDER BY total_count DESC');
    return result.rows;
  }

  /**
   * Get failed items by source and status
   */
  async getItems(options?: {
    source?: string;
    resourceType?: string;
    status?: string;
    limit?: number;
  }): Promise<DLQItem[]> {
    const { source, resourceType, status, limit = 100 } = options || {};

    let query = 'SELECT * FROM failed_ingestion WHERE 1=1';
    const params: any[] = [];
    let paramIdx = 1;

    if (source) {
      query += ` AND source = $${paramIdx}`;
      params.push(source);
      paramIdx++;
    }

    if (resourceType) {
      query += ` AND resource_type = $${paramIdx}`;
      params.push(resourceType);
      paramIdx++;
    }

    if (status) {
      query += ` AND status = $${paramIdx}`;
      params.push(status);
      paramIdx++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
    params.push(limit);

    const result = await this.pool.query(query, params);

    return result.rows.map(row => ({
      id: row.id,
      source: row.source,
      resourceType: row.resource_type,
      endpoint: row.endpoint,
      requestMethod: row.request_method,
      requestParams: row.request_params,
      requestBody: row.request_body,
      responseStatus: row.response_status,
      responseBody: row.response_body,
      errorType: row.error_type,
      errorMessage: row.error_message,
      errorStack: row.error_stack,
      rawPayload: row.raw_payload,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      nextRetryAt: row.next_retry_at,
      lastRetryAt: row.last_retry_at,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  /**
   * Manually mark item as ignored
   */
  async ignoreItem(
    id: string,
    ignoredBy: string,
    notes: string
  ): Promise<void> {
    await this.pool.query(
      'SELECT ignore_dlq_item($1, $2, $3)',
      [id, ignoredBy, notes]
    );

    console.log(`[DLQ] Item ${id} marked as ignored by ${ignoredBy}`);
  }

  /**
   * Clean up old resolved items
   */
  async cleanup(): Promise<number> {
    const result = await this.pool.query('SELECT cleanup_old_dlq_items()');
    const deletedCount = result.rows[0].cleanup_old_dlq_items;
    
    if (deletedCount > 0) {
      console.log(`[DLQ CLEANUP] Deleted ${deletedCount} old resolved items`);
    }
    
    return deletedCount;
  }
}

/**
 * Helper function to wrap ingestion operations with DLQ
 */
export async function withDLQ<T>(
  dlq: DeadLetterQueueService,
  operation: () => Promise<T>,
  context: {
    source: 'polymarket' | 'kalshi' | 'limitless';
    resourceType: 'event' | 'market' | 'token' | 'book' | 'trade';
    endpoint: string;
    rawPayload: any;
  }
): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    // Determine error type
    let errorType = 'UNKNOWN_ERROR';
    if (error.name === 'ZodError') {
      errorType = 'VALIDATION_ERROR';
    } else if (error.name === 'RateLimitError') {
      errorType = 'RATE_LIMIT';
    } else if (error.message?.includes('fetch')) {
      errorType = 'NETWORK_ERROR';
    } else if (error.message?.includes('parse') || error.message?.includes('JSON')) {
      errorType = 'PARSE_ERROR';
    }

    // Add to DLQ
    await dlq.addToDLQ({
      ...context,
      errorType,
      errorMessage: error.message || 'Unknown error',
      errorStack: error.stack,
      responseStatus: error.response?.status,
      responseBody: error.response?.body,
    });

    // Re-throw to allow caller to handle
    throw error;
  }
}

/**
 * Create DLQ service
 */
export function createDLQService(pool: Pool): DeadLetterQueueService {
  return new DeadLetterQueueService(pool);
}

