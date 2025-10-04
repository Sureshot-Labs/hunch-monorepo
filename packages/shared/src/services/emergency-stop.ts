// Emergency stop service for trading
// Allows admins to immediately pause all trading with broadcast to all workers

import { Pool } from 'pg';
import { Redis } from 'ioredis';

export interface TradingStatus {
  tradingEnabled: boolean;
  reason?: string;
  disabledBy?: string;
  disabledAt?: Date;
  venueId?: number | null;
}

export interface EmergencyStopOptions {
  reason: string;
  disabledBy: string;
  venueId?: number | null; // null = global, number = specific venue
}

export class EmergencyStopService {
  private redis: Redis;
  private pool: Pool;
  private readonly REDIS_CHANNEL = 'trading:control:changes';
  private readonly CACHE_TTL = 10; // 10 seconds cache

  constructor(redis: Redis, pool: Pool) {
    this.redis = redis;
    this.pool = pool;
  }

  /**
   * Check if trading is enabled (checks cache first, then DB)
   */
  async isTradingEnabled(venueId?: number): Promise<boolean> {
    const cacheKey = venueId !== undefined 
      ? `trading:enabled:venue:${venueId}`
      : 'trading:enabled:global';

    // Check cache first
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) {
      return cached === 'true';
    }

    // Check database
    const result = await this.pool.query(
      'SELECT is_trading_enabled($1) as enabled',
      [venueId !== undefined ? venueId : null]
    );

    const enabled = result.rows[0].enabled;

    // Cache the result
    await this.redis.setex(cacheKey, this.CACHE_TTL, enabled ? 'true' : 'false');

    return enabled;
  }

  /**
   * EMERGENCY STOP - Disable trading globally or for specific venue
   */
  async emergencyStop(options: EmergencyStopOptions): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Get or create trading control record
      const { venueId, reason, disabledBy } = options;
      
      await client.query(`
        INSERT INTO trading_controls (venue_id, trading_enabled, reason, disabled_by, disabled_at)
        VALUES ($1, FALSE, $2, $3, NOW())
        ON CONFLICT (venue_id)
        DO UPDATE SET
          trading_enabled = FALSE,
          reason = EXCLUDED.reason,
          disabled_by = EXCLUDED.disabled_by,
          disabled_at = NOW(),
          updated_at = NOW()
      `, [venueId !== undefined ? venueId : null, reason, disabledBy]);

      await client.query('COMMIT');

      // Clear cache
      if (venueId !== undefined && venueId !== null) {
        await this.clearCache(venueId);
      }

      // Broadcast to all workers via Redis pub/sub
      await this.broadcastChange({
        tradingEnabled: false,
        reason,
        disabledBy,
        venueId: venueId !== undefined ? venueId : null,
        disabledAt: new Date(),
      });

      console.log(`[EMERGENCY STOP] Trading disabled ${venueId !== undefined ? `for venue ${venueId}` : 'globally'} by ${disabledBy}: ${reason}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Resume trading (enable)
   */
  async resumeTrading(options: { venueId?: number; reason: string; enabledBy: string }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { venueId, reason, enabledBy } = options;
      
      await client.query(`
        INSERT INTO trading_controls (venue_id, trading_enabled, reason, disabled_by, enabled_at)
        VALUES ($1, TRUE, $2, $3, NOW())
        ON CONFLICT (venue_id)
        DO UPDATE SET
          trading_enabled = TRUE,
          reason = EXCLUDED.reason,
          disabled_by = EXCLUDED.disabled_by,
          enabled_at = NOW(),
          updated_at = NOW()
      `, [venueId !== undefined ? venueId : null, reason, enabledBy]);

      await client.query('COMMIT');

      // Clear cache
      await this.clearCache(venueId);

      // Broadcast to all workers
      await this.broadcastChange({
        tradingEnabled: true,
        reason,
        disabledBy: enabledBy,
        venueId: venueId !== undefined ? venueId : null,
      });

      console.log(`[TRADING RESUMED] Trading enabled ${venueId !== undefined ? `for venue ${venueId}` : 'globally'} by ${enabledBy}: ${reason}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get current trading status
   */
  async getTradingStatus(venueId?: number): Promise<TradingStatus> {
    const result = await this.pool.query(`
      SELECT trading_enabled, reason, disabled_by, disabled_at, enabled_at, venue_id
      FROM trading_controls
      WHERE venue_id IS NOT DISTINCT FROM $1
    `, [venueId !== undefined ? venueId : null]);

    if (result.rows.length === 0) {
      // No record means trading is enabled
      return { tradingEnabled: true };
    }

    const row = result.rows[0];
    return {
      tradingEnabled: row.trading_enabled,
      reason: row.reason,
      disabledBy: row.disabled_by,
      disabledAt: row.disabled_at,
      venueId: row.venue_id,
    };
  }

  /**
   * Get audit log of trading control changes
   */
  async getAuditLog(options?: { venueId?: number; limit?: number }): Promise<any[]> {
    const { venueId, limit = 100 } = options || {};
    
    const query = venueId !== undefined
      ? 'SELECT * FROM trading_control_audit WHERE venue_id = $1 ORDER BY created_at DESC LIMIT $2'
      : 'SELECT * FROM trading_control_audit ORDER BY created_at DESC LIMIT $1';
    
    const params = venueId !== undefined ? [venueId, limit] : [limit];
    
    const result = await this.pool.query(query, params);
    return result.rows;
  }

  /**
   * Subscribe to trading control changes
   * Useful for workers to listen for emergency stop broadcasts
   */
  async subscribeToChanges(callback: (status: TradingStatus) => void): Promise<void> {
    const subscriber = this.redis.duplicate();
    await subscriber.connect();

    await subscriber.subscribe(this.REDIS_CHANNEL, (err: Error | null | undefined, message: unknown) => {
      try {
        const status: TradingStatus = JSON.parse(message as string);
        callback(status);
      } catch (error) {
        console.error('Failed to parse trading control change:', error);
      }
    });
  }

  /**
   * Broadcast trading control change to all workers via Redis pub/sub
   */
  private async broadcastChange(status: TradingStatus): Promise<void> {
    await this.redis.publish(this.REDIS_CHANNEL, JSON.stringify(status));
  }

  /**
   * Clear cache for trading status
   */
  private async clearCache(venueId?: number): Promise<void> {
    const cacheKey = venueId !== undefined 
      ? `trading:enabled:venue:${venueId}`
      : 'trading:enabled:global';
    
    await this.redis.del(cacheKey);
    
    // Also clear global cache if venue-specific was changed
    if (venueId !== undefined) {
      await this.redis.del('trading:enabled:global');
    }
  }

  /**
   * Force refresh cache from database
   */
  async refreshCache(venueId?: number): Promise<void> {
    await this.clearCache(venueId);
    await this.isTradingEnabled(venueId);
  }
}

/**
 * Helper to throw error if trading is disabled
 */
export async function assertTradingEnabled(
  emergencyStop: EmergencyStopService,
  venueId?: number
): Promise<void> {
  const enabled = await emergencyStop.isTradingEnabled(venueId);
  
  if (!enabled) {
    const status = await emergencyStop.getTradingStatus(venueId);
    const venueName = venueId !== undefined ? `venue ${venueId}` : 'globally';
    throw new Error(
      `Trading is currently disabled ${venueName}. Reason: ${status.reason || 'No reason provided'}. Contact admin to resume.`
    );
  }
}

