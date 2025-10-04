// Main trading engine service that orchestrates all trading operations
import { EventEmitter } from 'events';
import { logger } from '@hunch/shared';
import { 
  UnifiedOrder, 
  UnifiedTrade, 
  UnifiedPosition,
  UnifiedUser,
  Venue 
} from '@hunch/shared';
import { OrderManager, OrderEvents } from './order-manager';
import { PositionManager, PositionEvents } from './position-manager';
import { RiskManager, RiskEvents, RiskParameters } from './risk-manager';
import { PolymarketTradingClient } from '../clients/polymarket-trading-client';

// Trading engine events
export interface TradingEngineEvents {
  'order:created': (order: UnifiedOrder) => void;
  'order:executed': (order: UnifiedOrder, trades: UnifiedTrade[]) => void;
  'order:cancelled': (order: UnifiedOrder) => void;
  'position:updated': (position: UnifiedPosition) => void;
  'risk:violation': (violation: any, userId: string) => void;
  'error': (error: Error, context: string) => void;
}

export class TradingEngine extends EventEmitter {
  private orderManager: OrderManager;
  private positionManager: PositionManager;
  private riskManager: RiskManager;
  private tradingClients: Map<Venue, PolymarketTradingClient> = new Map();
  private isRunning: boolean = false;

  constructor(defaultRiskParameters: RiskParameters) {
    super();
    
    // Initialize services
    this.orderManager = new OrderManager();
    this.positionManager = new PositionManager();
    this.riskManager = new RiskManager(defaultRiskParameters);
    
    this.setupEventHandlers();
    this.setupServiceIntegration();
  }

  // Start the trading engine
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Trading engine is already running');
      return;
    }

    try {
      logger.info('Starting trading engine');
      
      // Initialize trading clients
      await this.initializeTradingClients();
      
      this.isRunning = true;
      
      logger.info('Trading engine started successfully');
    } catch (error) {
      logger.error('Failed to start trading engine', error);
      throw error;
    }
  }

  // Stop the trading engine
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Trading engine is not running');
      return;
    }

    try {
      logger.info('Stopping trading engine');
      
      // Close trading clients
      for (const [venue, client] of this.tradingClients) {
        try {
          // Close any open connections
          logger.info(`Closing trading client for venue: ${venue}`);
        } catch (error) {
          logger.error(`Error closing trading client for venue: ${venue}`, error);
        }
      }
      
      this.isRunning = false;
      
      logger.info('Trading engine stopped successfully');
    } catch (error) {
      logger.error('Error stopping trading engine', error);
    }
  }

  // Create a new order
  public async createOrder(orderData: Omit<UnifiedOrder, 'id' | 'createdAt' | 'updatedAt'>): Promise<UnifiedOrder> {
    try {
      logger.info('Creating new order', { 
        userId: orderData.userId, 
        venue: orderData.venue, 
        tokenId: orderData.tokenId,
        side: orderData.side,
        size: orderData.sizeUsd 
      });

      // Get user positions for risk validation
      const userPositions = this.positionManager.getUserPositions(orderData.userId);
      
      // Validate order against risk parameters
      const riskValidation = await this.riskManager.validateOrder(orderData, userPositions);
      
      if (!riskValidation.isValid) {
        const violationMessages = riskValidation.violations.map(v => v.message).join(', ');
        throw new Error(`Order rejected due to risk violations: ${violationMessages}`);
      }

      // Record order for frequency tracking
      this.riskManager.recordOrder(orderData.userId);

      // Create order through order manager
      const order = await this.orderManager.createOrder(orderData);
      
      this.emit('order:created', order);
      
      return order;
    } catch (error) {
      logger.error('Failed to create order', { error, orderData });
      this.emit('error', error as Error, 'createOrder');
      throw error;
    }
  }

  // Cancel an existing order
  public async cancelOrder(orderId: string): Promise<boolean> {
    try {
      logger.info('Cancelling order', { orderId });
      
      const success = await this.orderManager.cancelOrder(orderId);
      
      if (success) {
        const order = this.orderManager.getOrder(orderId);
        if (order) {
          this.emit('order:cancelled', order);
        }
      }
      
      return success;
    } catch (error) {
      logger.error('Failed to cancel order', { error, orderId });
      this.emit('error', error as Error, 'cancelOrder');
      throw error;
    }
  }

  // Get order by ID
  public getOrder(orderId: string): UnifiedOrder | undefined {
    return this.orderManager.getOrder(orderId);
  }

  // Get user orders
  public getUserOrders(userId: string, status?: any): UnifiedOrder[] {
    return this.orderManager.getUserOrders(userId, status);
  }

  // Get user positions
  public getUserPositions(userId: string): UnifiedPosition[] {
    return this.positionManager.getUserPositions(userId);
  }

  // Get user portfolio summary
  public getUserPortfolio(userId: string): any {
    return this.positionManager.getPortfolioSummary(userId);
  }

  // Update price feed for position calculations
  public updatePriceFeed(tokenId: string, price: number): void {
    this.positionManager.updatePriceFeed(tokenId as any, price);
  }

  // Set risk parameters for user
  public setUserRiskParameters(userId: string, parameters: Partial<RiskParameters>): void {
    this.riskManager.setUserRiskParameters(userId, parameters);
  }

  // Get risk metrics for user
  public async getUserRiskMetrics(userId: string): Promise<any> {
    const positions = this.getUserPositions(userId);
    return await this.riskManager.updateRiskMetrics(userId, positions);
  }

  // Suspend user trading
  public suspendUser(userId: string, reason: string): void {
    this.riskManager.suspendUser(userId, reason);
  }

  // Resume user trading
  public resumeUser(userId: string): void {
    this.riskManager.resumeUser(userId);
  }

  // Initialize trading clients for supported venues
  private async initializeTradingClients(): Promise<void> {
    try {
      // Initialize Polymarket client
      const polymarketClient = new PolymarketTradingClient({
        baseUrl: process.env.POLYMARKET_CLOB_BASE || 'https://clob.polymarket.com',
        apiKey: process.env.POLYMARKET_API_KEY,
      });

      this.tradingClients.set('polymarket', polymarketClient);
      this.orderManager.initializeVenue('polymarket', polymarketClient);

      logger.info('Trading clients initialized', { 
        venues: Array.from(this.tradingClients.keys()) 
      });
    } catch (error) {
      logger.error('Failed to initialize trading clients', error);
      throw error;
    }
  }

  // Setup event handlers for internal services
  private setupEventHandlers(): void {
    // Order manager events
    this.orderManager.on('order:created', (order) => {
      this.emit('order:created', order);
    });

    this.orderManager.on('order:updated', (order) => {
      logger.debug('Order updated', { orderId: order.id, status: order.status });
    });

    this.orderManager.on('order:cancelled', (order) => {
      this.emit('order:cancelled', order);
    });

    this.orderManager.on('order:filled', (order, trades) => {
      // Update positions based on trades
      for (const trade of trades) {
        this.positionManager.updatePositionFromTrade(trade);
      }
      
      this.emit('order:executed', order, trades);
    });

    this.orderManager.on('order:rejected', (order, reason) => {
      logger.warn('Order rejected', { orderId: order.id, reason });
    });

    this.orderManager.on('error', (error, orderId) => {
      this.emit('error', error, `orderManager:${orderId}`);
    });

    // Position manager events
    this.positionManager.on('position:created', (position) => {
      logger.info('Position created', { positionId: position.id });
    });

    this.positionManager.on('position:updated', (position) => {
      this.emit('position:updated', position);
    });

    this.positionManager.on('position:closed', (position) => {
      logger.info('Position closed', { positionId: position.id });
    });

    this.positionManager.on('error', (error, userId) => {
      this.emit('error', error, `positionManager:${userId}`);
    });

    // Risk manager events
    this.riskManager.on('violation:detected', (violation, userId) => {
      this.emit('risk:violation', violation, userId);
      
      // Auto-suspend user for critical violations
      if (violation.severity === 'CRITICAL') {
        this.suspendUser(userId, `Critical risk violation: ${violation.message}`);
      }
    });

    this.riskManager.on('risk:updated', (userId, metrics) => {
      logger.debug('Risk metrics updated', { userId, metrics });
    });

    this.riskManager.on('trading:suspended', (userId, reason) => {
      logger.warn('User trading suspended', { userId, reason });
    });

    this.riskManager.on('trading:resumed', (userId) => {
      logger.info('User trading resumed', { userId });
    });

    this.riskManager.on('error', (error, userId) => {
      this.emit('error', error, `riskManager:${userId}`);
    });
  }

  // Setup integration between services
  private setupServiceIntegration(): void {
    // This method can be used to set up additional integrations
    // between services as needed
  }

  // Get engine statistics
  public getStats(): {
    isRunning: boolean;
    orderStats: any;
    positionStats: any;
    riskStats: any;
    tradingClients: string[];
  } {
    return {
      isRunning: this.isRunning,
      orderStats: this.orderManager.getStats(),
      positionStats: this.positionManager.getStats(),
      riskStats: this.riskManager.getStats(),
      tradingClients: Array.from(this.tradingClients.keys()),
    };
  }

  // Health check
  public healthCheck(): {
    status: string;
    isRunning: boolean;
    services: {
      orderManager: any;
      positionManager: any;
      riskManager: any;
    };
    tradingClients: Record<string, boolean>;
  } {
    const orderManagerHealth = this.orderManager.healthCheck();
    const positionManagerHealth = this.positionManager.healthCheck();
    const riskManagerHealth = this.riskManager.healthCheck();

    const tradingClients: Record<string, boolean> = {};
    for (const [venue, client] of this.tradingClients) {
      tradingClients[venue] = true; // Would implement actual health check
    }

    const allServicesHealthy = 
      orderManagerHealth.status === 'healthy' &&
      positionManagerHealth.status === 'healthy' &&
      riskManagerHealth.status === 'healthy';

    return {
      status: allServicesHealthy ? 'healthy' : 'unhealthy',
      isRunning: this.isRunning,
      services: {
        orderManager: orderManagerHealth,
        positionManager: positionManagerHealth,
        riskManager: riskManagerHealth,
      },
      tradingClients,
    };
  }
}
