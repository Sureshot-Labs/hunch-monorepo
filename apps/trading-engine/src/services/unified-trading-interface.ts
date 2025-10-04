// Unified trading interface that works with all three exchanges
import { EventEmitter } from 'events';
import { logger } from '@hunch/shared';
import { 
  UnifiedOrder, 
  UnifiedTrade, 
  UnifiedPosition,
  Venue 
} from '@hunch/shared';
import { PolymarketTradingClient } from '../clients/polymarket-trading-client';
import { KalshiTradingClient } from '../clients/kalshi-trading-client';
import { LimitlessTradingClient } from '../clients/limitless-trading-client';

// Trading interface events
export interface UnifiedTradingEvents {
  'order:created': (order: UnifiedOrder) => void;
  'order:executed': (order: UnifiedOrder, trades: UnifiedTrade[]) => void;
  'order:cancelled': (order: UnifiedOrder) => void;
  'position:updated': (position: UnifiedPosition) => void;
  'venue:connected': (venue: Venue) => void;
  'venue:disconnected': (venue: Venue) => void;
  'error': (error: Error, venue: Venue) => void;
}

// User configuration for each venue
export interface VenueUserConfig {
  polymarket?: {
    walletAddress: string;
    privateKey?: string; // For server-side signing
    apiKey?: string;
  };
  kalshi?: {
    userId: string;
    apiKey: string;
    username?: string;
  };
  limitless?: {
    userId: string;
    apiKey: string;
    walletAddress?: string;
  };
}

export class UnifiedTradingInterface extends EventEmitter {
  private tradingClients: Map<Venue, any> = new Map();
  private userConfigs: Map<string, VenueUserConfig> = new Map();
  private isInitialized: boolean = false;

  constructor() {
    super();
    this.setupEventHandlers();
  }

  // Initialize trading clients for all venues
  public async initialize(config: {
    polymarketBaseUrl?: string;
    kalshiBaseUrl?: string;
    limitlessBaseUrl?: string;
  }): Promise<void> {
    try {
      logger.info('Initializing unified trading interface');

      // Initialize Polymarket client
      const polymarketClient = new PolymarketTradingClient({
        baseUrl: config.polymarketBaseUrl || 'https://clob.polymarket.com',
      });
      this.tradingClients.set('polymarket', polymarketClient);

      // Initialize Kalshi client
      const kalshiClient = new KalshiTradingClient({
        baseUrl: config.kalshiBaseUrl || 'https://trading-api.kalshi.com',
      });
      this.tradingClients.set('kalshi', kalshiClient);

      // Initialize Limitless client
      const limitlessClient = new LimitlessTradingClient({
        baseUrl: config.limitlessBaseUrl || 'https://api.limitless.com',
      });
      this.tradingClients.set('limitless', limitlessClient);

      this.isInitialized = true;

      logger.info('Unified trading interface initialized successfully', {
        venues: Array.from(this.tradingClients.keys()),
      });
    } catch (error) {
      logger.error('Failed to initialize unified trading interface', error);
      throw error;
    }
  }

  // Set user configuration for a specific venue
  public setUserConfig(userId: string, venue: Venue, config: any): void {
    const userConfig = this.userConfigs.get(userId) || {};
    
    switch (venue) {
      case 'polymarket':
        userConfig.polymarket = config;
        break;
      case 'kalshi':
        userConfig.kalshi = config;
        break;
      case 'limitless':
        userConfig.limitless = config;
        break;
      default:
        throw new Error(`Unsupported venue: ${venue}`);
    }

    this.userConfigs.set(userId, userConfig);

    // Configure the trading client
    const client = this.tradingClients.get(venue);
    if (client) {
      if (venue === 'polymarket') {
        client.setWallet(config);
      } else {
        client.setUser(config);
      }
    }

    logger.info('User configuration set', { userId, venue });
  }

  // Create order on any venue
  public async createOrder(order: UnifiedOrder): Promise<UnifiedOrder> {
    if (!this.isInitialized) {
      throw new Error('Trading interface not initialized');
    }

    const client = this.tradingClients.get(order.venue);
    if (!client) {
      throw new Error(`Trading client not available for venue: ${order.venue}`);
    }

    try {
      logger.info('Creating unified order', {
        orderId: order.id,
        venue: order.venue,
        tokenId: order.tokenId,
        side: order.side,
        size: order.sizeUsd,
      });

      // Create order on venue
      const venueResponse = await client.createOrder(order);

      // Update order with venue response
      order.venueOrderId = this.extractVenueOrderId(venueResponse, order.venue);
      order.status = this.mapVenueStatus(venueResponse.status, order.venue);
      order.updatedAt = new Date();

      // Handle fills if any
      if (venueResponse.fills && venueResponse.fills.length > 0) {
        const trades = client.convertOrderToTrade(order, venueResponse);
        
        // Update order with fill information
        order.filledSizeUsd = trades.reduce((sum, trade) => sum + trade.sizeUsd, 0);
        order.filledSizeTokens = trades.reduce((sum, trade) => sum + (trade.sizeTokens || 0), 0);
        order.averageFillPrice = trades.length > 0 
          ? trades.reduce((sum, trade) => sum + trade.price, 0) / trades.length 
          : undefined;

        if (order.status === 'FILLED') {
          order.filledAt = new Date();
        }

        this.emit('order:executed', order, trades);
      }

      this.emit('order:created', order);

      logger.info('Unified order created successfully', {
        orderId: order.id,
        venueOrderId: order.venueOrderId,
        status: order.status,
      });

      return order;
    } catch (error) {
      logger.error('Failed to create unified order', { error, order });
      this.emit('error', error as Error, order.venue);
      throw error;
    }
  }

  // Cancel order on any venue
  public async cancelOrder(orderId: string, venue: Venue, venueOrderId: string): Promise<boolean> {
    if (!this.isInitialized) {
      throw new Error('Trading interface not initialized');
    }

    const client = this.tradingClients.get(venue);
    if (!client) {
      throw new Error(`Trading client not available for venue: ${venue}`);
    }

    try {
      logger.info('Cancelling unified order', { orderId, venue, venueOrderId });

      const success = await client.cancelOrder(venueOrderId);

      if (success) {
        this.emit('order:cancelled', { id: orderId, venue } as UnifiedOrder);
      }

      logger.info('Unified order cancelled', { orderId, success });
      return success;
    } catch (error) {
      logger.error('Failed to cancel unified order', { error, orderId, venue });
      this.emit('error', error as Error, venue);
      throw error;
    }
  }

  // Get order status from any venue
  public async getOrderStatus(venue: Venue, venueOrderId: string): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Trading interface not initialized');
    }

    const client = this.tradingClients.get(venue);
    if (!client) {
      throw new Error(`Trading client not available for venue: ${venue}`);
    }

    try {
      logger.debug('Getting unified order status', { venue, venueOrderId });

      const response = await client.getOrderStatus(venueOrderId);
      return response;
    } catch (error) {
      logger.error('Failed to get unified order status', { error, venue, venueOrderId });
      this.emit('error', error as Error, venue);
      throw error;
    }
  }

  // Get user's orders from any venue
  public async getUserOrders(userId: string, venue: Venue): Promise<any[]> {
    if (!this.isInitialized) {
      throw new Error('Trading interface not initialized');
    }

    const client = this.tradingClients.get(venue);
    if (!client) {
      throw new Error(`Trading client not available for venue: ${venue}`);
    }

    try {
      logger.debug('Getting unified user orders', { userId, venue });

      const response = await client.getOpenOrders();
      return response;
    } catch (error) {
      logger.error('Failed to get unified user orders', { error, userId, venue });
      this.emit('error', error as Error, venue);
      throw error;
    }
  }

  // Get user's positions from any venue
  public async getUserPositions(userId: string, venue: Venue): Promise<any[]> {
    if (!this.isInitialized) {
      throw new Error('Trading interface not initialized');
    }

    const client = this.tradingClients.get(venue);
    if (!client) {
      throw new Error(`Trading client not available for venue: ${venue}`);
    }

    try {
      logger.debug('Getting unified user positions', { userId, venue });

      const response = await client.getPositions();
      return response;
    } catch (error) {
      logger.error('Failed to get unified user positions', { error, userId, venue });
      this.emit('error', error as Error, venue);
      throw error;
    }
  }

  // Get user's balance from any venue
  public async getUserBalance(userId: string, venue: Venue): Promise<{ balance: number; currency: string }> {
    if (!this.isInitialized) {
      throw new Error('Trading interface not initialized');
    }

    const client = this.tradingClients.get(venue);
    if (!client) {
      throw new Error(`Trading client not available for venue: ${venue}`);
    }

    try {
      logger.debug('Getting unified user balance', { userId, venue });

      const response = await client.getBalance();
      return {
        balance: parseFloat(response.balance.toString()),
        currency: response.currency || 'USD',
      };
    } catch (error) {
      logger.error('Failed to get unified user balance', { error, userId, venue });
      this.emit('error', error as Error, venue);
      throw error;
    }
  }

  // Health check for all venues
  public async healthCheck(): Promise<Record<Venue, boolean>> {
    const health: Record<Venue, boolean> = {} as Record<Venue, boolean>;

    for (const [venue, client] of this.tradingClients) {
      try {
        health[venue] = await client.healthCheck();
      } catch (error) {
        logger.error(`Health check failed for venue: ${venue}`, error);
        health[venue] = false;
      }
    }

    return health;
  }

  // Get statistics for all venues
  public getStats(): {
    isInitialized: boolean;
    connectedVenues: Venue[];
    configuredUsers: number;
  } {
    return {
      isInitialized: this.isInitialized,
      connectedVenues: Array.from(this.tradingClients.keys()),
      configuredUsers: this.userConfigs.size,
    };
  }

  // Extract venue order ID from response
  private extractVenueOrderId(response: any, venue: Venue): string {
    switch (venue) {
      case 'polymarket':
        return response.order_id;
      case 'kalshi':
        return response.order_id;
      case 'limitless':
        return response.order_id;
      default:
        throw new Error(`Unsupported venue: ${venue}`);
    }
  }

  // Map venue status to unified status
  private mapVenueStatus(venueStatus: string, venue: Venue): any {
    switch (venue) {
      case 'polymarket':
        return this.mapPolymarketStatus(venueStatus);
      case 'kalshi':
        return this.mapKalshiStatus(venueStatus);
      case 'limitless':
        return this.mapLimitlessStatus(venueStatus);
      default:
        return 'PENDING';
    }
  }

  private mapPolymarketStatus(status: string): any {
    switch (status.toUpperCase()) {
      case 'PENDING':
        return 'PENDING';
      case 'FILLED':
        return 'FILLED';
      case 'PARTIALLY_FILLED':
        return 'PARTIALLY_FILLED';
      case 'CANCELLED':
        return 'CANCELLED';
      case 'REJECTED':
        return 'REJECTED';
      default:
        return 'PENDING';
    }
  }

  private mapKalshiStatus(status: string): any {
    switch (status.toLowerCase()) {
      case 'resting':
        return 'PENDING';
      case 'filled':
        return 'FILLED';
      case 'cancelled':
        return 'CANCELLED';
      case 'rejected':
        return 'REJECTED';
      default:
        return 'PENDING';
    }
  }

  private mapLimitlessStatus(status: string): any {
    switch (status.toLowerCase()) {
      case 'pending':
        return 'PENDING';
      case 'filled':
        return 'FILLED';
      case 'cancelled':
        return 'CANCELLED';
      case 'rejected':
        return 'REJECTED';
      default:
        return 'PENDING';
    }
  }

  // Setup event handlers
  private setupEventHandlers(): void {
    this.on('order:created', (order) => {
      logger.info('Unified order created', { orderId: order.id, venue: order.venue });
    });

    this.on('order:executed', (order, trades) => {
      logger.info('Unified order executed', { 
        orderId: order.id, 
        venue: order.venue,
        tradesCount: trades.length 
      });
    });

    this.on('order:cancelled', (order) => {
      logger.info('Unified order cancelled', { orderId: order.id, venue: order.venue });
    });

    this.on('venue:connected', (venue) => {
      logger.info('Venue connected', { venue });
    });

    this.on('venue:disconnected', (venue) => {
      logger.warn('Venue disconnected', { venue });
    });

    this.on('error', (error, venue) => {
      logger.error('Unified trading interface error', { error: error.message, venue });
    });
  }
}
