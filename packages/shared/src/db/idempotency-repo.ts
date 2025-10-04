// Database repository for idempotency operations
import { Pool, PoolClient } from 'pg';

export interface IdempotencyRecord {
  idempotency_key: string;
  response: any;
  created_at: Date;
}

/**
 * Check if an idempotency key exists
 * Returns the stored data if key exists, null otherwise
 */
export async function checkIdempotency(
  pool: Pool,
  key: string
): Promise<any | null> {
  const result = await pool.query(
    'SELECT response FROM idempotency WHERE idempotency_key = $1',
    [key]
  );
  
  if (result.rows.length > 0) {
    return result.rows[0].response;
  }
  
  return null;
}

/**
 * Store idempotency record
 * This should be called within the same transaction as the main insert
 */
export async function storeIdempotency(
  client: PoolClient,
  key: string,
  data: any,
  userId?: string,
  endpoint?: string
): Promise<void> {
  await client.query(
    'INSERT INTO idempotency (idempotency_key, response, user_id, endpoint, request_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, endpoint, idempotency_key) DO NOTHING',
    [key, JSON.stringify(data), userId ?? null, endpoint || 'unknown', key]
  );
}

/**
 * Idempotent upsert helper
 * Wraps any insert/update operation with idempotency check
 */
export async function idempotentOperation<T>(
  pool: Pool,
  idempotencyKey: string,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  // Check if already processed
  const existing = await checkIdempotency(pool, idempotencyKey);
  if (existing !== null) {
    console.log(`Idempotency key ${idempotencyKey.substring(0, 12)}... already processed, returning cached result`);
    return existing as T;
  }

  // Execute operation in transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Execute the operation
    const result = await operation(client);

    // Store idempotency record
    await storeIdempotency(client, idempotencyKey, result, undefined, 'bootstrap');

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Clean up old idempotency keys (older than specified days)
 * Should be run periodically as a maintenance job
 */
export async function cleanupOldIdempotencyKeys(
  pool: Pool,
  olderThanDays: number = 7
): Promise<number> {
  const result = await pool.query(
    'DELETE FROM idempotency WHERE created_at < NOW() - INTERVAL \'$1 days\' RETURNING key',
    [olderThanDays]
  );
  
  return result.rowCount || 0;
}

/**
 * Get idempotency statistics
 */
export async function getIdempotencyStats(pool: Pool) {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_keys,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') as last_hour,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as last_24h,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as last_7d,
      MIN(created_at) as oldest_key,
      MAX(created_at) as newest_key
    FROM idempotency
  `);
  
  return result.rows[0];
}

