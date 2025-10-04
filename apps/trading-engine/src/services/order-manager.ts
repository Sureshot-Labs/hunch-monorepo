// Order management service for handling trade orders
import { EventEmitter } from 'events';
import { logger } from '@hunch/shared';
import { 
  UnifiedOrder, 
  UnifiedTrade, 
  OrderStatus, 
  OrderSide, 
  OrderType,
  Venue 
} from '@hunch/shared';
import { PolymarketTradingClient } from '../clients/polymarket-trading-client';

// Order events
export interface OrderEvents {
  'order:created': (order: UnifiedOrder) => void;
  'order:updated': (order: UnifiedOrder) => void;
  'order:cancelled': (order: UnifiedOrder) => void;
  'order:filled': (order: UnifiedOrder, trades: UnifiedTrade[]) => void;
  'order:rejected': (order: UnifiedOrder, reason: string) => void;
  'error': (error: Error, orderId: string) => void;
}

export class OrderManager extends EventEmitter {
  private tradingClients: Map<Venue, PolymarketTradingClient> = new Map();
  private orderCache: Map<string, UnifiedOrder> = new Map();
  private isProcessing: boolean = false;
  private processingQueue: string[] = [];

  constructor() {
    super();
    this.setupEventHandlers();
  }

  // Initialize trading client for a venue
  public initializeVenue(venue: Venue, client: PolymarketTradingClient): void {
    this.tradingClients.set(venue, client);
    logger.info(`Trading client initialized for venue: ${venue}`);
  }

  // Create a new order
  public async createOrder(orderData: Omit<UnifiedOrder, 'id' | 'createdAt' | 'updatedAt'>): Promise<UnifiedOrder> {
    try {
      // Validate order data
      this.validateOrderData(orderData);

      // Create unified order
      const order: UnifiedOrder = {
        ...orderData,
        id: this.generateOrderId(),
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'PENDING',
        filledSizeUsd: 0,
        filledSizeTokens: 0,
      };

      // Store in cache
      this.orderCache.set(order.id, order);

      // Add to processing queue
      this.processingQueue.push(order.id);

      // Start processing if not already running
      if (!this.isProcessing) {
        this.processQueue();
      }

      this.emit('order:created', order);
      logger.info('Order created', { orderId: order.id, venue: order.venue });

      return order;
    } catch (error) {
      logger.error('Failed to create order', { error, orderData });
      throw error;
    }
  }

  // Cancel an existing order
  public async cancelOrder(orderId: string): Promise<boolean> {
    try {
      const order = this.orderCache.get(orderId);
      if (!order) {
        throw new Error(`Order not found: ${orderId}`);
      }

      if (order.status === 'CANCELLED') {
        logger.warn('Order already cancelled', { orderId });
        return true;
      }

      if (order.status === 'FILLED') {
        throw new Error('Cannot cancel filled order');
      }

      // Get trading client for venue
      const client = this.tradingClients.get(order.venue);
      if (!client) {
        throw new Error(`Trading client not available for venue: ${order.venue}`);
      }

      // Cancel order on venue
      const success = await client.cancelOrder(order.venueOrderId || orderId);

      if (success) {
        // Update order status
        order.status = 'CANCELLED';
        order.updatedAt = new Date();
        order.cancelledAt = new Date();

        this.orderCache.set(orderId, order);
        this.emit('order:cancelled', order);

        logger.info('Order cancelled', { orderId });
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Failed to cancel order', { error, orderId });
      this.emit('error', error as Error, orderId);
      throw error;
    }
  }

  // Get order by ID
  public getOrder(orderId: string): UnifiedOrder | undefined {
    return this.orderCache.get(orderId);
  }

  // Get orders for user
  public getUserOrders(userId: string, status?: OrderStatus): UnifiedOrder[] {
    const orders = Array.from(this.orderCache.values())
      .filter(order => order.userId === userId);

    if (status) {
      return orders.filter(order => order.status === status);
    }

    return orders;
  }

  // Get orders for token
  public getTokenOrders(tokenId: string, status?: OrderStatus): UnifiedOrder[] {
    const orders = Array.from(this.orderCache.values())
      .filter(order => order.tokenId === tokenId);

    if (status) {
      return orders.filter(order => order.status === status);
    }

    return orders;
  }

  // Process order queue
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.processingQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.processingQueue.length > 0) {
      const orderId = this.processingQueue.shift();
      if (!orderId) continue;

      try {
        await this.processOrder(orderId);
      } catch (error) {
        logger.error('Error processing order', { error, orderId });
        this.emit('error', error as Error, orderId);
      }
    }

    this.isProcessing = false;
  }

  // Process individual order
  private async processOrder(orderId: string): Promise<void> {
    const order = this.orderCache.get(orderId);
    if (!order) {
      logger.warn('Order not found in cache', { orderId });
      return;
    }

    try {
      // Get trading client for venue
      const client = this.tradingClients.get(order.venue);
      if (!client) {
        throw new Error(`Trading client not available for venue: ${order.venue}`);
      }

      // Execute order on venue
      const venueResponse = await client.createOrder(order);

      // Update order with venue response
      order.venueOrderId = venueResponse.order_id;
      order.status = this.mapVenueStatus(venueResponse.status);
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

        this.emit('order:filled', order, trades);
      }

      // Update cache
      this.orderCache.set(orderId, order);
      this.emit('order:updated', order);

      logger.info('Order processed', { 
        orderId, 
        status: order.status,
        venueOrderId: order.venueOrderId 
      });

    } catch (error) {
      // Mark order as rejected
      order.status = 'REJECTED';
      order.updatedAt = new Date();
      this.orderCache.set(orderId, order);

      this.emit('order:rejected', order, (error as Error).message);
      logger.error('Order processing failed', { error, orderId });
    }
  }

  // Validate order data
  private validateOrderData(orderData: Omit<UnifiedOrder, 'id' | 'createdAt' | 'updatedAt'>): void {
    if (!orderData.userId) {
      throw new Error('User ID is required');
    }

    if (!orderData.venue) {
      throw new Error('Venue is required');
    }

    if (!orderData.tokenId) {
      throw new Error('Token ID is required');
    }

    if (!orderData.side || !['BUY', 'SELL'].includes(orderData.side)) {
      throw new Error('Valid side (BUY/SELL) is required');
    }

    if (!orderData.orderType || !['MARKET', 'LIMIT', 'STOP'].includes(orderData.orderType)) {
      throw new Error('Valid order type is required');
    }

    if (!orderData.sizeUsd || orderData.sizeUsd <= 0) {
      throw new Error('Valid size is required');
    }

    if (orderData.orderType === 'LIMIT' && (!orderData.price || orderData.price <= 0 || orderData.price > 1)) {
      throw new Error('Valid price (0-1) is required for limit orders');
    }

    // Check if trading client is available
    if (!this.tradingClients.has(orderData.venue)) {
      throw new Error(`Trading client not available for venue: ${orderData.venue}`);
    }
  }

  // Map venue status to unified status
  private mapVenueStatus(venueStatus: string): OrderStatus {
    switch (venueStatus.toUpperCase()) {
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

  // Generate unique order ID
  private generateOrderId(): string {
    return `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Setup event handlers
  private setupEventHandlers(): void {
    this.on('order:created', (order) => {
      logger.info('Order created event', { orderId: order.id });
    });

    this.on('order:updated', (order) => {
      logger.debug('Order updated event', { orderId: order.id, status: order.status });
    });

    this.on('order:cancelled', (order) => {
      logger.info('Order cancelled event', { orderId: order.id });
    });

    this.on('order:filled', (order, trades) => {
      logger.info('Order filled event', { 
        orderId: order.id, 
        tradesCount: trades.length,
        totalSize: trades.reduce((sum, trade) => sum + trade.sizeUsd, 0)
      });
    });

    this.on('order:rejected', (order, reason) => {
      logger.warn('Order rejected event', { orderId: order.id, reason });
    });

    this.on('error', (error, orderId) => {
      logger.error('Order manager error', { error: error.message, orderId });
    });
  }

  // Get statistics
  public getStats(): {
    totalOrders: number;
    ordersByStatus: Record<OrderStatus, number>;
    ordersByVenue: Record<Venue, number>;
    processingQueue: number;
  } {
    const orders = Array.from(this.orderCache.values());
    
    const ordersByStatus = orders.reduce((acc, order) => {
      acc[order.status] = (acc[order.status] || 0) + 1;
      return acc;
    }, {} as Record<OrderStatus, number>);

    const ordersByVenue = orders.reduce((acc, order) => {
      acc[order.venue] = (acc[order.venue] || 0) + 1;
      return acc;
    }, {} as Record<Venue, number>);

    return {
      totalOrders: orders.length,
      ordersByStatus,
      ordersByVenue,
      processingQueue: this.processingQueue.length,
    };
  }

  // Health check
  public healthCheck(): { status: string; clients: Record<Venue, boolean> } {
    const clients: Record<Venue, boolean> = {};
    
    for (const [venue, client] of this.tradingClients) {
      clients[venue] = true; // Would need to implement actual health check
    }

    return {
      status: 'healthy',
      clients,
    };
  }
}
