// Webhook integration service for connecting webhooks with other services
import { EventEmitter } from 'events';
import { logger } from '@hunch/shared';
import { 
  UnifiedOrder, 
  UnifiedTrade, 
  UnifiedPosition, 
  UnifiedTokenId 
} from '@hunch/shared';
import { WebhookManager } from './webhook-manager';
import {
  WebhookEventType,
  OrderCreatedData,
  OrderUpdatedData,
  OrderFilledData,
  OrderCancelledData,
  OrderRejectedData,
  TradeExecutedData,
  PositionUpdatedData,
  PriceUpdatedData,
  MarketStatusChangedData,
  UserBalanceUpdatedData,
  RiskViolationData,
  AnalyticsSignalGeneratedData,
  AnalyticsRecommendationUpdatedData,
} from '../types/webhook';

// Integration events
export interface WebhookIntegrationEvents {
  'order:created': (order: UnifiedOrder) => void;
  'order:updated': (order: UnifiedOrder, previousStatus: string) => void;
  'order:filled': (order: UnifiedOrder, trades: UnifiedTrade[]) => void;
  'order:cancelled': (order: UnifiedOrder, reason?: string) => void;
  'order:rejected': (order: UnifiedOrder, reason: string) => void;
  'trade:executed': (trade: UnifiedTrade, order: UnifiedOrder) => void;
  'position:updated': (position: UnifiedPosition, previousQuantity: number, previousAveragePrice: number) => void;
  'price:updated': (tokenId: UnifiedTokenId, price: number, previousPrice: number, volume: number) => void;
  'market:status_changed': (marketId: string, venue: string, previousStatus: string, currentStatus: string) => void;
  'user:balance_updated': (userId: string, venue: string, previousBalance: number, currentBalance: number) => void;
  'risk:violation': (userId: string, violationType: string, violationValue: number, limitValue: number, severity: string) => void;
  'analytics:signal_generated': (tokenId: UnifiedTokenId, signal: string, strength: number, timeframe: string) => void;
  'analytics:recommendation_updated': (tokenId: UnifiedTokenId, recommendations: any[]) => void;
}

export class WebhookIntegrationService extends EventEmitter {
  private webhookManager: WebhookManager;
  private priceCache: Map<UnifiedTokenId, number> = new Map();
  private positionCache: Map<string, { quantity: number; averagePrice: number }> = new Map();
  private balanceCache: Map<string, number> = new Map();

  constructor(webhookManager: WebhookManager) {
    super();
    this.webhookManager = webhookManager;
    this.setupEventHandlers();
  }

  // Order events
  public async onOrderCreated(order: UnifiedOrder): Promise<void> {
    try {
      const data: OrderCreatedData = {
        order,
        venue: order.venue,
        tokenId: order.tokenId,
      };

      await this.webhookManager.queueEvent('order.created', data, order.userId, order.tokenId);
      this.emit('order:created', order);

      logger.info('Order created webhook triggered', { 
        orderId: order.id, 
        userId: order.userId,
        venue: order.venue 
      });
    } catch (error) {
      logger.error('Failed to trigger order created webhook', { error, orderId: order.id });
    }
  }

  public async onOrderUpdated(order: UnifiedOrder, previousStatus: string): Promise<void> {
    try {
      const data: OrderUpdatedData = {
        order,
        previousStatus,
        currentStatus: order.status,
        venue: order.venue,
        tokenId: order.tokenId,
      };

      await this.webhookManager.queueEvent('order.updated', data, order.userId, order.tokenId);
      this.emit('order:updated', order, previousStatus);

      logger.info('Order updated webhook triggered', { 
        orderId: order.id, 
        previousStatus,
        currentStatus: order.status 
      });
    } catch (error) {
      logger.error('Failed to trigger order updated webhook', { error, orderId: order.id });
    }
  }

  public async onOrderFilled(order: UnifiedOrder, trades: UnifiedTrade[]): Promise<void> {
    try {
      const totalFilled = trades.reduce((sum, trade) => sum + trade.sizeUsd, 0);
      const averagePrice = trades.length > 0 
        ? trades.reduce((sum, trade) => sum + trade.price, 0) / trades.length 
        : 0;

      const data: OrderFilledData = {
        order,
        trades,
        totalFilled,
        averagePrice,
        venue: order.venue,
        tokenId: order.tokenId,
      };

      await this.webhookManager.queueEvent('order.filled', data, order.userId, order.tokenId);
      this.emit('order:filled', order, trades);

      logger.info('Order filled webhook triggered', { 
        orderId: order.id, 
        tradesCount: trades.length,
        totalFilled 
      });
    } catch (error) {
      logger.error('Failed to trigger order filled webhook', { error, orderId: order.id });
    }
  }

  public async onOrderCancelled(order: UnifiedOrder, reason?: string): Promise<void> {
    try {
      const data: OrderCancelledData = {
        order,
        reason,
        venue: order.venue,
        tokenId: order.tokenId,
      };

      await this.webhookManager.queueEvent('order.cancelled', data, order.userId, order.tokenId);
      this.emit('order:cancelled', order, reason);

      logger.info('Order cancelled webhook triggered', { 
        orderId: order.id, 
        reason 
      });
    } catch (error) {
      logger.error('Failed to trigger order cancelled webhook', { error, orderId: order.id });
    }
  }

  public async onOrderRejected(order: UnifiedOrder, reason: string): Promise<void> {
    try {
      const data: OrderRejectedData = {
        order,
        reason,
        venue: order.venue,
        tokenId: order.tokenId,
      };

      await this.webhookManager.queueEvent('order.rejected', data, order.userId, order.tokenId);
      this.emit('order:rejected', order, reason);

      logger.info('Order rejected webhook triggered', { 
        orderId: order.id, 
        reason 
      });
    } catch (error) {
      logger.error('Failed to trigger order rejected webhook', { error, orderId: order.id });
    }
  }

  // Trade events
  public async onTradeExecuted(trade: UnifiedTrade, order: UnifiedOrder): Promise<void> {
    try {
      const data: TradeExecutedData = {
        trade,
        order,
        venue: trade.venue,
        tokenId: trade.tokenId,
      };

      await this.webhookManager.queueEvent('trade.executed', data, trade.userId, trade.tokenId);
      this.emit('trade:executed', trade, order);

      logger.info('Trade executed webhook triggered', { 
        tradeId: trade.id, 
        orderId: order.id,
        price: trade.price,
        size: trade.sizeUsd 
      });
    } catch (error) {
      logger.error('Failed to trigger trade executed webhook', { error, tradeId: trade.id });
    }
  }

  // Position events
  public async onPositionUpdated(
    position: UnifiedPosition, 
    previousQuantity: number, 
    previousAveragePrice: number
  ): Promise<void> {
    try {
      const data: PositionUpdatedData = {
        position,
        previousQuantity,
        previousAveragePrice,
        unrealizedPnl: position.unrealizedPnlUsd,
        realizedPnl: position.realizedPnlUsd,
        venue: this.extractVenueFromTokenId(position.tokenId),
        tokenId: position.tokenId,
      };

      await this.webhookManager.queueEvent('position.updated', data, position.userId, position.tokenId);
      this.emit('position:updated', position, previousQuantity, previousAveragePrice);

      logger.info('Position updated webhook triggered', { 
        positionId: position.id, 
        userId: position.userId,
        quantity: position.quantity,
        unrealizedPnl: position.unrealizedPnlUsd 
      });
    } catch (error) {
      logger.error('Failed to trigger position updated webhook', { error, positionId: position.id });
    }
  }

  // Price events
  public async onPriceUpdated(
    tokenId: UnifiedTokenId, 
    price: number, 
    volume: number = 0
  ): Promise<void> {
    try {
      const previousPrice = this.priceCache.get(tokenId) || price;
      const priceChange = price - previousPrice;
      const priceChangePercent = previousPrice > 0 ? (priceChange / previousPrice) * 100 : 0;

      const data: PriceUpdatedData = {
        tokenId,
        price,
        previousPrice,
        priceChange,
        priceChangePercent,
        volume,
        timestamp: new Date(),
        venue: this.extractVenueFromTokenId(tokenId),
      };

      await this.webhookManager.queueEvent('price.updated', data, undefined, tokenId);
      this.emit('price:updated', tokenId, price, previousPrice, volume);

      // Update cache
      this.priceCache.set(tokenId, price);

      logger.debug('Price updated webhook triggered', { 
        tokenId, 
        price, 
        previousPrice,
        priceChangePercent 
      });
    } catch (error) {
      logger.error('Failed to trigger price updated webhook', { error, tokenId });
    }
  }

  // Market events
  public async onMarketStatusChanged(
    marketId: string, 
    venue: string, 
    previousStatus: string, 
    currentStatus: string,
    title: string,
    acceptingOrders: boolean
  ): Promise<void> {
    try {
      const data: MarketStatusChangedData = {
        marketId,
        venue,
        previousStatus,
        currentStatus,
        title,
        acceptingOrders,
      };

      await this.webhookManager.queueEvent('market.status_changed', data);
      this.emit('market:status_changed', marketId, venue, previousStatus, currentStatus);

      logger.info('Market status changed webhook triggered', { 
        marketId, 
        venue, 
        previousStatus, 
        currentStatus 
      });
    } catch (error) {
      logger.error('Failed to trigger market status changed webhook', { error, marketId });
    }
  }

  // User balance events
  public async onUserBalanceUpdated(
    userId: string, 
    venue: string, 
    currentBalance: number, 
    currency: string = 'USD'
  ): Promise<void> {
    try {
      const cacheKey = `${userId}:${venue}`;
      const previousBalance = this.balanceCache.get(cacheKey) || currentBalance;
      const balanceChange = currentBalance - previousBalance;

      const data: UserBalanceUpdatedData = {
        userId,
        venue,
        previousBalance,
        currentBalance,
        balanceChange,
        currency,
      };

      await this.webhookManager.queueEvent('user.balance_updated', data, userId);
      this.emit('user:balance_updated', userId, venue, previousBalance, currentBalance);

      // Update cache
      this.balanceCache.set(cacheKey, currentBalance);

      logger.info('User balance updated webhook triggered', { 
        userId, 
        venue, 
        previousBalance, 
        currentBalance,
        balanceChange 
      });
    } catch (error) {
      logger.error('Failed to trigger user balance updated webhook', { error, userId });
    }
  }

  // Risk violation events
  public async onRiskViolation(
    userId: string, 
    violationType: string, 
    violationValue: number, 
    limitValue: number, 
    severity: 'low' | 'medium' | 'high' | 'critical',
    description: string
  ): Promise<void> {
    try {
      const data: RiskViolationData = {
        userId,
        violationType,
        violationValue,
        limitValue,
        severity,
        description,
        timestamp: new Date(),
      };

      await this.webhookManager.queueEvent('risk.violation', data, userId);
      this.emit('risk:violation', userId, violationType, violationValue, limitValue, severity);

      logger.warn('Risk violation webhook triggered', { 
        userId, 
        violationType, 
        violationValue, 
        limitValue,
        severity 
      });
    } catch (error) {
      logger.error('Failed to trigger risk violation webhook', { error, userId });
    }
  }

  // Analytics events
  public async onAnalyticsSignalGenerated(
    tokenId: UnifiedTokenId, 
    signal: string, 
    strength: number, 
    timeframe: string,
    indicators: {
      rsi: string;
      macd: string;
      bollinger: string;
      stochastic: string;
      movingAverage: string;
    }
  ): Promise<void> {
    try {
      const data: AnalyticsSignalGeneratedData = {
        tokenId,
        signal,
        strength,
        timeframe,
        indicators,
        timestamp: new Date(),
      };

      await this.webhookManager.queueEvent('analytics.signal_generated', data, undefined, tokenId);
      this.emit('analytics:signal_generated', tokenId, signal, strength, timeframe);

      logger.info('Analytics signal generated webhook triggered', { 
        tokenId, 
        signal, 
        strength, 
        timeframe 
      });
    } catch (error) {
      logger.error('Failed to trigger analytics signal generated webhook', { error, tokenId });
    }
  }

  public async onAnalyticsRecommendationUpdated(
    tokenId: UnifiedTokenId, 
    recommendations: Array<{
      action: string;
      confidence: number;
      reasoning: string[];
      targetPrice?: number;
      stopLoss?: number;
      timeHorizon: string;
      riskLevel: string;
    }>
  ): Promise<void> {
    try {
      const data: AnalyticsRecommendationUpdatedData = {
        tokenId,
        recommendations,
        timestamp: new Date(),
      };

      await this.webhookManager.queueEvent('analytics.recommendation_updated', data, undefined, tokenId);
      this.emit('analytics:recommendation_updated', tokenId, recommendations);

      logger.info('Analytics recommendation updated webhook triggered', { 
        tokenId, 
        recommendationsCount: recommendations.length 
      });
    } catch (error) {
      logger.error('Failed to trigger analytics recommendation updated webhook', { error, tokenId });
    }
  }

  // Batch operations
  public async onBatchOrderEvents(orders: UnifiedOrder[], eventType: 'created' | 'updated' | 'filled' | 'cancelled' | 'rejected'): Promise<void> {
    try {
      for (const order of orders) {
        switch (eventType) {
          case 'created':
            await this.onOrderCreated(order);
            break;
          case 'updated':
            await this.onOrderUpdated(order, 'unknown'); // Previous status unknown in batch
            break;
          case 'filled':
            await this.onOrderFilled(order, []); // Trades would need to be provided separately
            break;
          case 'cancelled':
            await this.onOrderCancelled(order);
            break;
          case 'rejected':
            await this.onOrderRejected(order, 'Batch rejection');
            break;
        }
      }

      logger.info('Batch order events processed', { 
        eventType, 
        ordersCount: orders.length 
      });
    } catch (error) {
      logger.error('Failed to process batch order events', { error, eventType });
    }
  }

  public async onBatchPriceUpdates(priceUpdates: Array<{ tokenId: UnifiedTokenId; price: number; volume?: number }>): Promise<void> {
    try {
      for (const update of priceUpdates) {
        await this.onPriceUpdated(update.tokenId, update.price, update.volume || 0);
      }

      logger.info('Batch price updates processed', { 
        updatesCount: priceUpdates.length 
      });
    } catch (error) {
      logger.error('Failed to process batch price updates', { error });
    }
  }

  // Cache management
  public clearPriceCache(): void {
    this.priceCache.clear();
    logger.info('Price cache cleared');
  }

  public clearPositionCache(): void {
    this.positionCache.clear();
    logger.info('Position cache cleared');
  }

  public clearBalanceCache(): void {
    this.balanceCache.clear();
    logger.info('Balance cache cleared');
  }

  public clearAllCaches(): void {
    this.clearPriceCache();
    this.clearPositionCache();
    this.clearBalanceCache();
    logger.info('All webhook caches cleared');
  }

  // Helper methods
  private extractVenueFromTokenId(tokenId: UnifiedTokenId): string {
    const parts = tokenId.split(':');
    return parts[0] || 'unknown';
  }

  private setupEventHandlers(): void {
    this.on('order:created', (order) => {
      logger.debug('Order created event emitted', { orderId: order.id });
    });

    this.on('order:updated', (order, previousStatus) => {
      logger.debug('Order updated event emitted', { orderId: order.id, previousStatus });
    });

    this.on('order:filled', (order, trades) => {
      logger.debug('Order filled event emitted', { orderId: order.id, tradesCount: trades.length });
    });

    this.on('order:cancelled', (order, reason) => {
      logger.debug('Order cancelled event emitted', { orderId: order.id, reason });
    });

    this.on('order:rejected', (order, reason) => {
      logger.debug('Order rejected event emitted', { orderId: order.id, reason });
    });

    this.on('trade:executed', (trade, order) => {
      logger.debug('Trade executed event emitted', { tradeId: trade.id, orderId: order.id });
    });

    this.on('position:updated', (position, previousQuantity, previousAveragePrice) => {
      logger.debug('Position updated event emitted', { 
        positionId: position.id, 
        previousQuantity, 
        previousAveragePrice 
      });
    });

    this.on('price:updated', (tokenId, price, previousPrice, volume) => {
      logger.debug('Price updated event emitted', { tokenId, price, previousPrice, volume });
    });

    this.on('market:status_changed', (marketId, venue, previousStatus, currentStatus) => {
      logger.debug('Market status changed event emitted', { 
        marketId, 
        venue, 
        previousStatus, 
        currentStatus 
      });
    });

    this.on('user:balance_updated', (userId, venue, previousBalance, currentBalance) => {
      logger.debug('User balance updated event emitted', { 
        userId, 
        venue, 
        previousBalance, 
        currentBalance 
      });
    });

    this.on('risk:violation', (userId, violationType, violationValue, limitValue, severity) => {
      logger.debug('Risk violation event emitted', { 
        userId, 
        violationType, 
        violationValue, 
        limitValue, 
        severity 
      });
    });

    this.on('analytics:signal_generated', (tokenId, signal, strength, timeframe) => {
      logger.debug('Analytics signal generated event emitted', { 
        tokenId, 
        signal, 
        strength, 
        timeframe 
      });
    });

    this.on('analytics:recommendation_updated', (tokenId, recommendations) => {
      logger.debug('Analytics recommendation updated event emitted', { 
        tokenId, 
        recommendationsCount: recommendations.length 
      });
    });
  }

  // Get service statistics
  public getStats(): {
    priceCacheSize: number;
    positionCacheSize: number;
    balanceCacheSize: number;
  } {
    return {
      priceCacheSize: this.priceCache.size,
      positionCacheSize: this.positionCache.size,
      balanceCacheSize: this.balanceCache.size,
    };
  }
}
