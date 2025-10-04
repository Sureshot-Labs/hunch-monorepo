// Cursor-based pagination utilities
// Better than offset pagination for large datasets

export interface CursorPaginationParams {
  limit?: number;
  cursor?: string;
  maxLimit?: number;
  defaultLimit?: number;
}

export interface CursorPaginationResult<T> {
  data: T[];
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
    limit: number;
  };
}

export interface DecodedCursor {
  timestamp: string;
  id: string;
}

/**
 * Encode cursor from timestamp and ID
 */
export function encodeCursor(timestamp: Date | string, id: string): string {
  const ts = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
  const data = JSON.stringify({ timestamp: ts, id });
  return Buffer.from(data).toString('base64');
}

/**
 * Decode cursor to timestamp and ID
 */
export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const data = Buffer.from(cursor, 'base64').toString('utf-8');
    const parsed = JSON.parse(data);
    
    if (!parsed.timestamp || !parsed.id) {
      return null;
    }
    
    return {
      timestamp: parsed.timestamp,
      id: parsed.id,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Validate and normalize pagination params
 */
export function normalizePaginationParams(
  params: CursorPaginationParams
): {
  limit: number;
  cursor: DecodedCursor | null;
} {
  const { 
    limit, 
    cursor, 
    maxLimit = 500, 
    defaultLimit = 50 
  } = params;

  // Normalize limit
  const normalizedLimit = Math.min(
    Math.max(limit || defaultLimit, 1),
    maxLimit
  );

  // Decode cursor
  const decodedCursor = cursor ? decodeCursor(cursor) : null;

  return {
    limit: normalizedLimit,
    cursor: decodedCursor,
  };
}

/**
 * Build SQL WHERE clause for cursor pagination
 * For descending order (most common)
 */
export function buildCursorWhereClause(
  cursor: DecodedCursor | null,
  timestampColumn: string = 'created_at',
  idColumn: string = 'id'
): { where: string; params: any[] } {
  if (!cursor) {
    return { where: '', params: [] };
  }

  // For DESC order: (timestamp, id) < (cursor_timestamp, cursor_id)
  return {
    where: `(${timestampColumn}, ${idColumn}) < ($1::timestamptz, $2::uuid)`,
    params: [cursor.timestamp, cursor.id],
  };
}

/**
 * Build SQL WHERE clause for cursor pagination (ascending order)
 */
export function buildCursorWhereClauseAsc(
  cursor: DecodedCursor | null,
  timestampColumn: string = 'created_at',
  idColumn: string = 'id'
): { where: string; params: any[] } {
  if (!cursor) {
    return { where: '', params: [] };
  }

  // For ASC order: (timestamp, id) > (cursor_timestamp, cursor_id)
  return {
    where: `(${timestampColumn}, ${idColumn}) > ($1::timestamptz, $2::uuid)`,
    params: [cursor.timestamp, cursor.id],
  };
}

/**
 * Create pagination response with next cursor
 */
export function createPaginationResponse<T extends { id: string; [key: string]: any }>(
  data: T[],
  limit: number,
  timestampField: string = 'createdAt'
): CursorPaginationResult<T> {
  const hasMore = data.length === limit;
  
  // Generate next cursor from last item
  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const lastItem = data[data.length - 1];
    const timestamp = lastItem[timestampField];
    nextCursor = encodeCursor(timestamp, lastItem.id);
  }

  return {
    data,
    pagination: {
      nextCursor,
      hasMore,
      limit,
    },
  };
}

/**
 * Example SQL query with cursor pagination:
 * 
 * const { limit, cursor } = normalizePaginationParams(params);
 * const { where, params: whereParams } = buildCursorWhereClause(cursor, 'created_at', 'id');
 * 
 * const query = `
 *   SELECT * FROM events
 *   WHERE ${where || '1=1'}
 *   ORDER BY created_at DESC, id DESC
 *   LIMIT $${whereParams.length + 1}
 * `;
 * 
 * const result = await pool.query(query, [...whereParams, limit]);
 * const response = createPaginationResponse(result.rows, limit, 'created_at');
 */

