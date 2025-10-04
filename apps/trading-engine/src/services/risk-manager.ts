// Risk management service for enforcing trading limits and risk controls
import { EventEmitter } from 'events';
import { logger } from '@hunch/shared';
import { 
  UnifiedOrder, 
  UnifiedPosition, 
  UnifiedUser 
} from '@hunch/shared';

// Risk parameters interface
export interface RiskParameters {
  // Position limits
  maxPositionSizeUsd: number;
  maxPositionSizePerToken: number;
  maxTotalExposureUsd: number;
  
  // Order limits
  maxOrderSizeUsd: number;
  maxOrdersPerMinute: number;
  maxOrdersPerHour: number;
  maxOrdersPerDay: number;
  
  // Loss limits
  maxDailyLossUsd: number;
  maxTotalLossUsd: number;
  stopLossPercentage: number;
  
  // Concentration limits
  maxConcentrationPerToken: number; // Percentage of total portfolio
  maxConcentrationPerCategory: number; // Percentage of total portfolio
  
  // Time-based limits
  tradingHoursStart: number; // Hour of day (0-23)
  tradingHoursEnd: number; // Hour of day (0-23)
  tradingDays: number[]; // Days of week (0-6, Sunday = 0)
}

// Risk violation types
export enum RiskViolationType {
  POSITION_SIZE_EXCEEDED = 'POSITION_SIZE_EXCEEDED',
  TOTAL_EXPOSURE_EXCEEDED = 'TOTAL_EXPOSURE_EXCEEDED',
  ORDER_SIZE_EXCEEDED = 'ORDER_SIZE_EXCEEDED',
  ORDER_FREQUENCY_EXCEEDED = 'ORDER_FREQUENCY_EXCEEDED',
  DAILY_LOSS_EXCEEDED = 'DAILY_LOSS_EXCEEDED',
  TOTAL_LOSS_EXCEEDED = 'TOTAL_LOSS_EXCEEDED',
  CONCENTRATION_EXCEEDED = 'CONCENTRATION_EXCEEDED',
  TRADING_HOURS_VIOLATION = 'TRADING_HOURS_VIOLATION',
  STOP_LOSS_TRIGGERED = 'STOP_LOSS_TRIGGERED',
}

// Risk violation details
export interface RiskViolation {
  type: RiskViolationType;
  message: string;
  currentValue: number;
  limitValue: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  timestamp: Date;
}

// Risk events
export interface RiskEvents {
  'violation:detected': (violation: RiskViolation, userId: string) => void;
  'risk:updated': (userId: string, riskMetrics: RiskMetrics) => void;
  'trading:suspended': (userId: string, reason: string) => void;
  'trading:resumed': (userId: string) => void;
  'error': (error: Error, userId: string) => void;
}

// Risk metrics for a user
export interface RiskMetrics {
  userId: string;
  totalExposureUsd: number;
  totalRealizedPnlUsd: number;
  totalUnrealizedPnlUsd: number;
  dailyPnlUsd: number;
  positionCount: number;
  openOrderCount: number;
  ordersLast24h: number;
  ordersLastHour: number;
  ordersLastMinute: number;
  largestPositionUsd: number;
  concentrationRisk: number;
  lastUpdated: Date;
}

export class RiskManager extends EventEmitter {
  private userRiskParameters: Map<string, RiskParameters> = new Map();
  private userRiskMetrics: Map<string, RiskMetrics> = new Map();
  private userOrderHistory: Map<string, Date[]> = new Map();
  private suspendedUsers: Set<string> = new Map();
  private defaultRiskParameters: RiskParameters;

  constructor(defaultRiskParameters: RiskParameters) {
    super();
    this.defaultRiskParameters = defaultRiskParameters;
    this.setupEventHandlers();
  }

  // Set risk parameters for a user
  public setUserRiskParameters(userId: string, parameters: Partial<RiskParameters>): void {
    const currentParams = this.userRiskParameters.get(userId) || { ...this.defaultRiskParameters };
    const newParams = { ...currentParams, ...parameters };
    
    this.userRiskParameters.set(userId, newParams);
    
    logger.info('Risk parameters updated for user', { userId, parameters: newParams });
  }

  // Get risk parameters for a user
  public getUserRiskParameters(userId: string): RiskParameters {
    return this.userRiskParameters.get(userId) || { ...this.defaultRiskParameters };
  }

  // Validate order against risk parameters
  public async validateOrder(order: UnifiedOrder, userPositions: UnifiedPosition[]): Promise<{
    isValid: boolean;
    violations: RiskViolation[];
  }> {
    const violations: RiskViolation[] = [];
    const riskParams = this.getUserRiskParameters(order.userId);
    const riskMetrics = await this.calculateRiskMetrics(order.userId, userPositions);

    try {
      // Check if user is suspended
      if (this.suspendedUsers.has(order.userId)) {
        violations.push({
          type: RiskViolationType.TOTAL_LOSS_EXCEEDED,
          message: 'User trading is suspended',
          currentValue: 0,
          limitValue: 0,
          severity: 'CRITICAL',
          timestamp: new Date(),
        });
        return { isValid: false, violations };
      }

      // Check trading hours
      const tradingHoursViolation = this.checkTradingHours(riskParams);
      if (tradingHoursViolation) {
        violations.push(tradingHoursViolation);
      }

      // Check order size
      const orderSizeViolation = this.checkOrderSize(order, riskParams);
      if (orderSizeViolation) {
        violations.push(orderSizeViolation);
      }

      // Check order frequency
      const frequencyViolation = this.checkOrderFrequency(order.userId, riskParams);
      if (frequencyViolation) {
        violations.push(frequencyViolation);
      }

      // Check position size
      const positionSizeViolation = this.checkPositionSize(order, userPositions, riskParams);
      if (positionSizeViolation) {
        violations.push(positionSizeViolation);
      }

      // Check total exposure
      const exposureViolation = this.checkTotalExposure(order, userPositions, riskParams);
      if (exposureViolation) {
        violations.push(exposureViolation);
      }

      // Check daily loss
      const dailyLossViolation = this.checkDailyLoss(riskMetrics, riskParams);
      if (dailyLossViolation) {
        violations.push(dailyLossViolation);
      }

      // Check concentration
      const concentrationViolation = this.checkConcentration(order, userPositions, riskParams);
      if (concentrationViolation) {
        violations.push(concentrationViolation);
      }

      // Emit violations
      for (const violation of violations) {
        this.emit('violation:detected', violation, order.userId);
      }

      const isValid = violations.length === 0;
      
      logger.info('Order risk validation completed', {
        orderId: order.id,
        userId: order.userId,
        isValid,
        violationsCount: violations.length,
      });

      return { isValid, violations };

    } catch (error) {
      logger.error('Error validating order risk', { error, orderId: order.id });
      this.emit('error', error as Error, order.userId);
      
      return {
        isValid: false,
        violations: [{
          type: RiskViolationType.ORDER_SIZE_EXCEEDED,
          message: 'Risk validation error',
          currentValue: 0,
          limitValue: 0,
          severity: 'CRITICAL',
          timestamp: new Date(),
        }],
      };
    }
  }

  // Update risk metrics for a user
  public async updateRiskMetrics(userId: string, positions: UnifiedPosition[]): Promise<RiskMetrics> {
    const metrics = await this.calculateRiskMetrics(userId, positions);
    this.userRiskMetrics.set(userId, metrics);
    
    this.emit('risk:updated', userId, metrics);
    
    return metrics;
  }

  // Suspend user trading
  public suspendUser(userId: string, reason: string): void {
    this.suspendedUsers.add(userId);
    this.emit('trading:suspended', userId, reason);
    
    logger.warn('User trading suspended', { userId, reason });
  }

  // Resume user trading
  public resumeUser(userId: string): void {
    this.suspendedUsers.delete(userId);
    this.emit('trading:resumed', userId);
    
    logger.info('User trading resumed', { userId });
  }

  // Check if user is suspended
  public isUserSuspended(userId: string): boolean {
    return this.suspendedUsers.has(userId);
  }

  // Record order for frequency tracking
  public recordOrder(userId: string): void {
    const now = new Date();
    const userOrders = this.userOrderHistory.get(userId) || [];
    userOrders.push(now);
    
    // Keep only last 24 hours of orders
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const filteredOrders = userOrders.filter(date => date > cutoff);
    
    this.userOrderHistory.set(userId, filteredOrders);
  }

  // Check trading hours
  private checkTradingHours(riskParams: RiskParameters): RiskViolation | null {
    const now = new Date();
    const currentHour = now.getHours();
    const currentDay = now.getDay();

    if (!riskParams.tradingDays.includes(currentDay)) {
      return {
        type: RiskViolationType.TRADING_HOURS_VIOLATION,
        message: `Trading not allowed on day ${currentDay}`,
        currentValue: currentDay,
        limitValue: 0,
        severity: 'HIGH',
        timestamp: now,
      };
    }

    if (currentHour < riskParams.tradingHoursStart || currentHour >= riskParams.tradingHoursEnd) {
      return {
        type: RiskViolationType.TRADING_HOURS_VIOLATION,
        message: `Trading not allowed at hour ${currentHour}`,
        currentValue: currentHour,
        limitValue: riskParams.tradingHoursStart,
        severity: 'HIGH',
        timestamp: now,
      };
    }

    return null;
  }

  // Check order size
  private checkOrderSize(order: UnifiedOrder, riskParams: RiskParameters): RiskViolation | null {
    if (order.sizeUsd > riskParams.maxOrderSizeUsd) {
      return {
        type: RiskViolationType.ORDER_SIZE_EXCEEDED,
        message: `Order size ${order.sizeUsd} exceeds limit ${riskParams.maxOrderSizeUsd}`,
        currentValue: order.sizeUsd,
        limitValue: riskParams.maxOrderSizeUsd,
        severity: 'HIGH',
        timestamp: new Date(),
      };
    }

    return null;
  }

  // Check order frequency
  private checkOrderFrequency(userId: string, riskParams: RiskParameters): RiskViolation | null {
    const userOrders = this.userOrderHistory.get(userId) || [];
    const now = new Date();
    
    // Check orders per minute
    const ordersLastMinute = userOrders.filter(
      date => date > new Date(now.getTime() - 60 * 1000)
    ).length;
    
    if (ordersLastMinute >= riskParams.maxOrdersPerMinute) {
      return {
        type: RiskViolationType.ORDER_FREQUENCY_EXCEEDED,
        message: `Too many orders per minute: ${ordersLastMinute}`,
        currentValue: ordersLastMinute,
        limitValue: riskParams.maxOrdersPerMinute,
        severity: 'MEDIUM',
        timestamp: now,
      };
    }

    // Check orders per hour
    const ordersLastHour = userOrders.filter(
      date => date > new Date(now.getTime() - 60 * 60 * 1000)
    ).length;
    
    if (ordersLastHour >= riskParams.maxOrdersPerHour) {
      return {
        type: RiskViolationType.ORDER_FREQUENCY_EXCEEDED,
        message: `Too many orders per hour: ${ordersLastHour}`,
        currentValue: ordersLastHour,
        limitValue: riskParams.maxOrdersPerHour,
        severity: 'HIGH',
        timestamp: now,
      };
    }

    // Check orders per day
    const ordersLastDay = userOrders.filter(
      date => date > new Date(now.getTime() - 24 * 60 * 60 * 1000)
    ).length;
    
    if (ordersLastDay >= riskParams.maxOrdersPerDay) {
      return {
        type: RiskViolationType.ORDER_FREQUENCY_EXCEEDED,
        message: `Too many orders per day: ${ordersLastDay}`,
        currentValue: ordersLastDay,
        limitValue: riskParams.maxOrdersPerDay,
        severity: 'HIGH',
        timestamp: now,
      };
    }

    return null;
  }

  // Check position size
  private checkPositionSize(
    order: UnifiedOrder, 
    positions: UnifiedPosition[], 
    riskParams: RiskParameters
  ): RiskViolation | null {
    const tokenPosition = positions.find(p => p.tokenId === order.tokenId);
    const currentSize = tokenPosition ? Math.abs(tokenPosition.quantity) : 0;
    const newSize = currentSize + order.sizeUsd;

    if (newSize > riskParams.maxPositionSizePerToken) {
      return {
        type: RiskViolationType.POSITION_SIZE_EXCEEDED,
        message: `Position size ${newSize} exceeds limit ${riskParams.maxPositionSizePerToken}`,
        currentValue: newSize,
        limitValue: riskParams.maxPositionSizePerToken,
        severity: 'HIGH',
        timestamp: new Date(),
      };
    }

    return null;
  }

  // Check total exposure
  private checkTotalExposure(
    order: UnifiedOrder, 
    positions: UnifiedPosition[], 
    riskParams: RiskParameters
  ): RiskViolation | null {
    const totalExposure = positions.reduce((sum, pos) => sum + Math.abs(pos.quantity), 0) + order.sizeUsd;

    if (totalExposure > riskParams.maxTotalExposureUsd) {
      return {
        type: RiskViolationType.TOTAL_EXPOSURE_EXCEEDED,
        message: `Total exposure ${totalExposure} exceeds limit ${riskParams.maxTotalExposureUsd}`,
        currentValue: totalExposure,
        limitValue: riskParams.maxTotalExposureUsd,
        severity: 'CRITICAL',
        timestamp: new Date(),
      };
    }

    return null;
  }

  // Check daily loss
  private checkDailyLoss(riskMetrics: RiskMetrics, riskParams: RiskParameters): RiskViolation | null {
    if (riskMetrics.dailyPnlUsd < -riskParams.maxDailyLossUsd) {
      return {
        type: RiskViolationType.DAILY_LOSS_EXCEEDED,
        message: `Daily loss ${riskMetrics.dailyPnlUsd} exceeds limit ${riskParams.maxDailyLossUsd}`,
        currentValue: Math.abs(riskMetrics.dailyPnlUsd),
        limitValue: riskParams.maxDailyLossUsd,
        severity: 'CRITICAL',
        timestamp: new Date(),
      };
    }

    return null;
  }

  // Check concentration
  private checkConcentration(
    order: UnifiedOrder, 
    positions: UnifiedPosition[], 
    riskParams: RiskParameters
  ): RiskViolation | null {
    const totalExposure = positions.reduce((sum, pos) => sum + Math.abs(pos.quantity), 0) + order.sizeUsd;
    const tokenExposure = positions
      .filter(p => p.tokenId === order.tokenId)
      .reduce((sum, pos) => sum + Math.abs(pos.quantity), 0) + order.sizeUsd;

    if (totalExposure > 0) {
      const concentration = (tokenExposure / totalExposure) * 100;
      
      if (concentration > riskParams.maxConcentrationPerToken) {
        return {
          type: RiskViolationType.CONCENTRATION_EXCEEDED,
          message: `Token concentration ${concentration.toFixed(2)}% exceeds limit ${riskParams.maxConcentrationPerToken}%`,
          currentValue: concentration,
          limitValue: riskParams.maxConcentrationPerToken,
          severity: 'MEDIUM',
          timestamp: new Date(),
        };
      }
    }

    return null;
  }

  // Calculate risk metrics for a user
  private async calculateRiskMetrics(userId: string, positions: UnifiedPosition[]): Promise<RiskMetrics> {
    const userOrders = this.userOrderHistory.get(userId) || [];
    const now = new Date();
    
    const ordersLastMinute = userOrders.filter(
      date => date > new Date(now.getTime() - 60 * 1000)
    ).length;
    
    const ordersLastHour = userOrders.filter(
      date => date > new Date(now.getTime() - 60 * 60 * 1000)
    ).length;
    
    const ordersLast24h = userOrders.filter(
      date => date > new Date(now.getTime() - 24 * 60 * 60 * 1000)
    ).length;

    const totalExposure = positions.reduce((sum, pos) => sum + Math.abs(pos.quantity), 0);
    const totalRealizedPnl = positions.reduce((sum, pos) => sum + pos.realizedPnlUsd, 0);
    const totalUnrealizedPnl = positions.reduce((sum, pos) => sum + pos.unrealizedPnlUsd, 0);
    
    // Calculate daily PnL (simplified - would need proper date tracking)
    const dailyPnl = totalRealizedPnl + totalUnrealizedPnl;
    
    const largestPosition = Math.max(...positions.map(pos => Math.abs(pos.quantity)), 0);
    
    const concentrationRisk = totalExposure > 0 
      ? (largestPosition / totalExposure) * 100 
      : 0;

    return {
      userId,
      totalExposureUsd: totalExposure,
      totalRealizedPnlUsd: totalRealizedPnl,
      totalUnrealizedPnlUsd: totalUnrealizedPnl,
      dailyPnlUsd: dailyPnl,
      positionCount: positions.length,
      openOrderCount: 0, // Would need to track this separately
      ordersLast24h,
      ordersLastHour,
      ordersLastMinute,
      largestPositionUsd: largestPosition,
      concentrationRisk,
      lastUpdated: now,
    };
  }

  // Setup event handlers
  private setupEventHandlers(): void {
    this.on('violation:detected', (violation, userId) => {
      logger.warn('Risk violation detected', { violation, userId });
    });

    this.on('risk:updated', (userId, metrics) => {
      logger.debug('Risk metrics updated', { userId, metrics });
    });

    this.on('trading:suspended', (userId, reason) => {
      logger.warn('Trading suspended', { userId, reason });
    });

    this.on('trading:resumed', (userId) => {
      logger.info('Trading resumed', { userId });
    });

    this.on('error', (error, userId) => {
      logger.error('Risk manager error', { error: error.message, userId });
    });
  }

  // Get statistics
  public getStats(): {
    totalUsers: number;
    suspendedUsers: number;
    riskParametersSet: number;
  } {
    return {
      totalUsers: this.userRiskMetrics.size,
      suspendedUsers: this.suspendedUsers.size,
      riskParametersSet: this.userRiskParameters.size,
    };
  }

  // Health check
  public healthCheck(): { status: string; metricsCount: number } {
    return {
      status: 'healthy',
      metricsCount: this.userRiskMetrics.size,
    };
  }
}
