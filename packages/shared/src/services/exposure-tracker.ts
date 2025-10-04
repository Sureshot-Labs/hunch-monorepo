// User exposure tracking and limit enforcement
import { Pool } from 'pg';

export interface UserExposureSummary {
  userId: string;
  inCoolingOff: boolean;
  currentLimitUsd: number | null;
  dailyVolumeUsd: number;
  availableLimitUsd: number | null;
  totalPositionValueUsd: number;
  lifetimeVolumeUsd: number;
  lifetimeTrades: number;
  userCreatedAt: Date;
}

export interface OrderLimitCheck {
  withinLimits: boolean;
  limitType: string;
  currentExposure: number;
  limitValue: number | null;
  available: number | null;
  errorMessage: string | null;
}

export interface UserLimitsConfig {
  userId: string;
  coolingOffEnabled: boolean;
  coolingOffLimitUsd: number;
  coolingOffPeriodHours: number;
  dailyLimitUsd: number;
  maxTotalExposureUsd: number | null;
  maxSingleOrderUsd: number;
  limitsDisabled: boolean;
}

export class ExposureTrackerService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Get user exposure summary
   */
  async getUserExposure(userId: string): Promise<UserExposureSummary> {
    const result = await this.pool.query(
      'SELECT * FROM get_user_exposure_summary($1)',
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error(`User ${userId} not found`);
    }

    const row = result.rows[0];
    return {
      userId: row.user_id,
      inCoolingOff: row.in_cooling_off,
      currentLimitUsd: row.current_limit_usd,
      dailyVolumeUsd: parseFloat(row.daily_volume_usd || 0),
      availableLimitUsd: row.available_limit_usd,
      totalPositionValueUsd: parseFloat(row.total_position_value_usd || 0),
      lifetimeVolumeUsd: parseFloat(row.lifetime_volume_usd || 0),
      lifetimeTrades: parseInt(row.lifetime_trades || 0),
      userCreatedAt: row.user_created_at,
    };
  }

  /**
   * Check if order is within user limits
   */
  async checkOrderLimits(
    userId: string,
    orderSizeUsd: number
  ): Promise<OrderLimitCheck> {
    const result = await this.pool.query(
      'SELECT * FROM check_order_within_limits($1, $2)',
      [userId, orderSizeUsd]
    );

    const row = result.rows[0];
    return {
      withinLimits: row.within_limits,
      limitType: row.limit_type,
      currentExposure: parseFloat(row.current_exposure || 0),
      limitValue: row.limit_value ? parseFloat(row.limit_value) : null,
      available: row.available ? parseFloat(row.available) : null,
      errorMessage: row.error_message,
    };
  }

  /**
   * Assert order is within limits (throws error if not)
   */
  async assertOrderWithinLimits(
    userId: string,
    orderSizeUsd: number
  ): Promise<void> {
    const check = await this.checkOrderLimits(userId, orderSizeUsd);

    if (!check.withinLimits) {
      throw new OrderLimitExceededError(check);
    }
  }

  /**
   * Get or create user limits
   */
  async getUserLimits(userId: string): Promise<UserLimitsConfig> {
    // Ensure user limits exist
    await this.pool.query(
      `INSERT INTO user_limits (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    const result = await this.pool.query(
      `SELECT * FROM user_limits WHERE user_id = $1`,
      [userId]
    );

    const row = result.rows[0];
    return {
      userId: row.user_id,
      coolingOffEnabled: row.cooling_off_enabled,
      coolingOffLimitUsd: parseFloat(row.cooling_off_limit_usd),
      coolingOffPeriodHours: row.cooling_off_period_hours,
      dailyLimitUsd: parseFloat(row.daily_limit_usd),
      maxTotalExposureUsd: row.max_total_exposure_usd ? parseFloat(row.max_total_exposure_usd) : null,
      maxSingleOrderUsd: parseFloat(row.max_single_order_usd),
      limitsDisabled: row.limits_disabled,
    };
  }

  /**
   * Update user limits (admin function)
   */
  async updateUserLimits(
    userId: string,
    updates: Partial<UserLimitsConfig>,
    updatedBy: string,
    reason?: string
  ): Promise<void> {
    const sets: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (updates.coolingOffEnabled !== undefined) {
      sets.push(`cooling_off_enabled = $${paramIdx++}`);
      params.push(updates.coolingOffEnabled);
    }

    if (updates.coolingOffLimitUsd !== undefined) {
      sets.push(`cooling_off_limit_usd = $${paramIdx++}`);
      params.push(updates.coolingOffLimitUsd);
    }

    if (updates.dailyLimitUsd !== undefined) {
      sets.push(`daily_limit_usd = $${paramIdx++}`);
      params.push(updates.dailyLimitUsd);
    }

    if (updates.maxSingleOrderUsd !== undefined) {
      sets.push(`max_single_order_usd = $${paramIdx++}`);
      params.push(updates.maxSingleOrderUsd);
    }

    if (updates.limitsDisabled !== undefined) {
      sets.push(`limits_disabled = $${paramIdx++}`);
      params.push(updates.limitsDisabled);
      sets.push(`override_reason = $${paramIdx++}`);
      params.push(reason || 'No reason provided');
      sets.push(`override_by = $${paramIdx++}`);
      params.push(updatedBy);
      sets.push(`override_at = NOW()`);
    }

    if (sets.length === 0) {
      throw new Error('No updates provided');
    }

    sets.push(`updated_at = NOW()`);
    params.push(userId);

    const query = `
      UPDATE user_limits
      SET ${sets.join(', ')}
      WHERE user_id = $${paramIdx}
    `;

    await this.pool.query(query, params);

    console.log(`[USER LIMITS UPDATED] User ${userId} by ${updatedBy}: ${reason || 'No reason'}`);
  }

  /**
   * Reset daily exposure for all users (should be run daily via cron)
   */
  async resetDailyExposure(): Promise<number> {
    const result = await this.pool.query(`
      UPDATE user_exposure_tracking
      SET
        daily_order_volume_usd = 0,
        daily_trade_count = 0,
        daily_reset_at = DATE_TRUNC('day', NOW()),
        updated_at = NOW()
      WHERE daily_reset_at < DATE_TRUNC('day', NOW())
    `);

    const resetCount = result.rowCount || 0;
    console.log(`[DAILY RESET] Reset exposure for ${resetCount} users`);
    return resetCount;
  }

  /**
   * Get users approaching their limits (>90% of limit used)
   */
  async getUsersApproachingLimits(): Promise<Array<{
    userId: string;
    currentVolume: number;
    limit: number;
    percentUsed: number;
  }>> {
    const result = await this.pool.query(`
      SELECT
        ue.user_id,
        ue.daily_order_volume_usd as current_volume,
        get_user_exposure_limit(ue.user_id) as limit,
        (ue.daily_order_volume_usd / NULLIF(get_user_exposure_limit(ue.user_id), 0) * 100) as percent_used
      FROM user_exposure_tracking ue
      WHERE get_user_exposure_limit(ue.user_id) IS NOT NULL
        AND ue.daily_order_volume_usd >= get_user_exposure_limit(ue.user_id) * 0.9
      ORDER BY percent_used DESC
    `);

    return result.rows.map(row => ({
      userId: row.user_id,
      currentVolume: parseFloat(row.current_volume),
      limit: parseFloat(row.limit),
      percentUsed: parseFloat(row.percent_used),
    }));
  }
}

/**
 * Custom error for limit exceeded
 */
export class OrderLimitExceededError extends Error {
  public limitCheck: OrderLimitCheck;

  constructor(limitCheck: OrderLimitCheck) {
    super(limitCheck.errorMessage || 'Order exceeds user limits');
    this.name = 'OrderLimitExceededError';
    this.limitCheck = limitCheck;
  }
}

/**
 * Create exposure tracker service
 */
export function createExposureTracker(pool: Pool): ExposureTrackerService {
  return new ExposureTrackerService(pool);
}

