// Position management service for tracking user positions
import { EventEmitter } from 'events';
import { logger } from '@hunch/shared';
import { 
  UnifiedPosition, 
  UnifiedTrade, 
  UnifiedTokenId,
  TokenSide 
} from '@hunch/shared';

// Position events
export interface PositionEvents {
  'position:created': (position: UnifiedPosition) => void;
  'position:updated': (position: UnifiedPosition) => void;
  'position:closed': (position: UnifiedPosition) => void;
  'error': (error: Error, userId: string) => void;
}

export class PositionManager extends EventEmitter {
  private positions: Map<string, UnifiedPosition> = new Map();
  private priceFeed: Map<UnifiedTokenId, number> = new Map();

  constructor() {
    super();
    this.setupEventHandlers();
  }

  // Update position based on trade
  public updatePositionFromTrade(trade: UnifiedTrade): void {
    try {
      const positionKey = this.getPositionKey(trade.userId, trade.tokenId, this.getTokenSide(trade.side));
      let position = this.positions.get(positionKey);

      if (!position) {
        // Create new position
        position = {
          id: this.generatePositionId(),
          userId: trade.userId,
          tokenId: trade.tokenId,
          side: this.getTokenSide(trade.side),
          quantity: 0,
          averagePrice: undefined,
          unrealizedPnlUsd: 0,
          realizedPnlUsd: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.positions.set(positionKey, position);
        this.emit('position:created', position);
      }

      // Update position based on trade
      const tradeQuantity = trade.sizeTokens || trade.sizeUsd;
      const tradePrice = trade.price;

      if (trade.side === 'BUY') {
        // Adding to position
        const newQuantity = position.quantity + tradeQuantity;
        const newAveragePrice = position.quantity > 0
          ? ((position.quantity * (position.averagePrice || 0)) + (tradeQuantity * tradePrice)) / newQuantity
          : tradePrice;

        position.quantity = newQuantity;
        position.averagePrice = newAveragePrice;
      } else {
        // Reducing position
        if (position.quantity < tradeQuantity) {
          // Closing position and potentially going short
          const realizedPnl = this.calculateRealizedPnl(position, tradeQuantity, tradePrice);
          position.realizedPnlUsd += realizedPnl;
          
          // If we're selling more than we have, we're going short
          if (tradeQuantity > position.quantity) {
            const shortQuantity = tradeQuantity - position.quantity;
            position.quantity = -shortQuantity;
            position.averagePrice = tradePrice;
          } else {
            position.quantity = position.quantity - tradeQuantity;
          }
        } else {
          // Partial close
          const realizedPnl = this.calculateRealizedPnl(position, tradeQuantity, tradePrice);
          position.realizedPnlUsd += realizedPnl;
          position.quantity = position.quantity - tradeQuantity;
        }
      }

      // Update timestamps
      position.updatedAt = new Date();

      // Update unrealized PnL
      position.unrealizedPnlUsd = this.calculateUnrealizedPnl(position);

      // Store updated position
      this.positions.set(positionKey, position);

      // Emit update event
      this.emit('position:updated', position);

      // Check if position is closed
      if (Math.abs(position.quantity) < 0.0001) { // Essentially zero
        this.emit('position:closed', position);
      }

      logger.info('Position updated from trade', {
        userId: trade.userId,
        tokenId: trade.tokenId,
        side: position.side,
        quantity: position.quantity,
        averagePrice: position.averagePrice,
        realizedPnl: position.realizedPnlUsd,
        unrealizedPnl: position.unrealizedPnlUsd,
      });

    } catch (error) {
      logger.error('Failed to update position from trade', { error, trade });
      this.emit('error', error as Error, trade.userId);
    }
  }

  // Update price feed for unrealized PnL calculation
  public updatePriceFeed(tokenId: UnifiedTokenId, price: number): void {
    this.priceFeed.set(tokenId, price);
    
    // Update unrealized PnL for all positions with this token
    this.updateUnrealizedPnlForToken(tokenId);
  }

  // Get position for user and token
  public getPosition(userId: string, tokenId: UnifiedTokenId, side: TokenSide): UnifiedPosition | undefined {
    const positionKey = this.getPositionKey(userId, tokenId, side);
    return this.positions.get(positionKey);
  }

  // Get all positions for user
  public getUserPositions(userId: string): UnifiedPosition[] {
    return Array.from(this.positions.values())
      .filter(position => position.userId === userId);
  }

  // Get all positions for token
  public getTokenPositions(tokenId: UnifiedTokenId): UnifiedPosition[] {
    return Array.from(this.positions.values())
      .filter(position => position.tokenId === tokenId);
  }

  // Get all open positions (non-zero quantity)
  public getOpenPositions(): UnifiedPosition[] {
    return Array.from(this.positions.values())
      .filter(position => Math.abs(position.quantity) > 0.0001);
  }

  // Close position (set quantity to zero)
  public closePosition(userId: string, tokenId: UnifiedTokenId, side: TokenSide): boolean {
    const positionKey = this.getPositionKey(userId, tokenId, side);
    const position = this.positions.get(positionKey);

    if (!position || Math.abs(position.quantity) < 0.0001) {
      return false;
    }

    // Realize any remaining unrealized PnL
    const currentPrice = this.priceFeed.get(tokenId);
    if (currentPrice) {
      const realizedPnl = this.calculateRealizedPnl(position, position.quantity, currentPrice);
      position.realizedPnlUsd += realizedPnl;
    }

    position.quantity = 0;
    position.unrealizedPnlUsd = 0;
    position.updatedAt = new Date();

    this.positions.set(positionKey, position);
    this.emit('position:closed', position);

    logger.info('Position closed', {
      userId,
      tokenId,
      side,
      realizedPnl: position.realizedPnlUsd,
    });

    return true;
  }

  // Calculate realized PnL for a trade
  private calculateRealizedPnl(position: UnifiedPosition, tradeQuantity: number, tradePrice: number): number {
    if (!position.averagePrice || position.quantity <= 0) {
      return 0;
    }

    // For YES positions: profit when selling above average price
    // For NO positions: profit when selling below average price
    const priceDifference = position.side === 'YES' 
      ? tradePrice - position.averagePrice
      : position.averagePrice - tradePrice;

    return tradeQuantity * priceDifference;
  }

  // Calculate unrealized PnL for position
  private calculateUnrealizedPnl(position: UnifiedPosition): number {
    if (Math.abs(position.quantity) < 0.0001 || !position.averagePrice) {
      return 0;
    }

    const currentPrice = this.priceFeed.get(position.tokenId);
    if (!currentPrice) {
      return 0;
    }

    // For YES positions: profit when current price > average price
    // For NO positions: profit when current price < average price
    const priceDifference = position.side === 'YES'
      ? currentPrice - position.averagePrice
      : position.averagePrice - currentPrice;

    return Math.abs(position.quantity) * priceDifference;
  }

  // Update unrealized PnL for all positions with a specific token
  private updateUnrealizedPnlForToken(tokenId: UnifiedTokenId): void {
    const positions = this.getTokenPositions(tokenId);
    
    for (const position of positions) {
      if (Math.abs(position.quantity) > 0.0001) {
        const oldUnrealizedPnl = position.unrealizedPnlUsd;
        position.unrealizedPnlUsd = this.calculateUnrealizedPnl(position);
        position.updatedAt = new Date();

        this.positions.set(this.getPositionKey(position.userId, position.tokenId, position.side), position);

        // Emit update if PnL changed significantly
        if (Math.abs(position.unrealizedPnlUsd - oldUnrealizedPnl) > 0.01) {
          this.emit('position:updated', position);
        }
      }
    }
  }

  // Get position key for Map storage
  private getPositionKey(userId: string, tokenId: UnifiedTokenId, side: TokenSide): string {
    return `${userId}:${tokenId}:${side}`;
  }

  // Get token side from trade side
  private getTokenSide(tradeSide: 'BUY' | 'SELL'): TokenSide {
    // This is a simplification - in reality, you'd need to know which token is being traded
    // For now, assume BUY = YES, SELL = NO
    return tradeSide === 'BUY' ? 'YES' : 'NO';
  }

  // Generate unique position ID
  private generatePositionId(): string {
    return `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Setup event handlers
  private setupEventHandlers(): void {
    this.on('position:created', (position) => {
      logger.info('Position created', {
        positionId: position.id,
        userId: position.userId,
        tokenId: position.tokenId,
        side: position.side,
      });
    });

    this.on('position:updated', (position) => {
      logger.debug('Position updated', {
        positionId: position.id,
        quantity: position.quantity,
        unrealizedPnl: position.unrealizedPnlUsd,
      });
    });

    this.on('position:closed', (position) => {
      logger.info('Position closed', {
        positionId: position.id,
        realizedPnl: position.realizedPnlUsd,
      });
    });

    this.on('error', (error, userId) => {
      logger.error('Position manager error', { error: error.message, userId });
    });
  }

  // Get portfolio summary for user
  public getPortfolioSummary(userId: string): {
    totalPositions: number;
    openPositions: number;
    totalRealizedPnl: number;
    totalUnrealizedPnl: number;
    totalPnl: number;
    positions: UnifiedPosition[];
  } {
    const positions = this.getUserPositions(userId);
    const openPositions = positions.filter(p => Math.abs(p.quantity) > 0.0001);

    const totalRealizedPnl = positions.reduce((sum, p) => sum + p.realizedPnlUsd, 0);
    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnlUsd, 0);

    return {
      totalPositions: positions.length,
      openPositions: openPositions.length,
      totalRealizedPnl,
      totalUnrealizedPnl,
      totalPnl: totalRealizedPnl + totalUnrealizedPnl,
      positions,
    };
  }

  // Get statistics
  public getStats(): {
    totalPositions: number;
    openPositions: number;
    totalUsers: number;
    totalTokens: number;
  } {
    const positions = Array.from(this.positions.values());
    const openPositions = positions.filter(p => Math.abs(p.quantity) > 0.0001);
    const uniqueUsers = new Set(positions.map(p => p.userId)).size;
    const uniqueTokens = new Set(positions.map(p => p.tokenId)).size;

    return {
      totalPositions: positions.length,
      openPositions: openPositions.length,
      totalUsers: uniqueUsers,
      totalTokens: uniqueTokens,
    };
  }

  // Health check
  public healthCheck(): { status: string; positionsCount: number; priceFeedCount: number } {
    return {
      status: 'healthy',
      positionsCount: this.positions.size,
      priceFeedCount: this.priceFeed.size,
    };
  }
}
