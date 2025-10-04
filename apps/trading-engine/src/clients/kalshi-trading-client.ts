// Kalshi trading client for order execution
import { logger } from '@hunch/shared';
import { UnifiedOrder, UnifiedTrade, UnifiedTokenId } from '@hunch/shared';
import { getKalshiApiKey } from '../env';

// Kalshi-specific types
export interface KalshiOrderRequest {
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  count: number;
  price: number;
  expiration_ts?: number;
  buy_max_cost?: number;
  sell_max_cost?: number;
}

export interface KalshiOrderResponse {
  order_id: string;
  status: 'resting' | 'filled' | 'cancelled' | 'rejected';
  created_time: number;
  fills?: KalshiFill[];
  ticker: string;
  side: string;
  action: string;
  count: number;
  price: number;
}

export interface KalshiFill {
  fill_id: string;
  price: number;
  count: number;
  timestamp: number;
}

export interface KalshiCancelRequest {
  order_id: string;
}

export interface KalshiUser {
  user_id: string;
  api_key: string;
  username?: string;
}

export class KalshiTradingClient {
  private baseUrl: string;
  private user?: KalshiUser;

  constructor(config: {
    baseUrl: string;
    user?: KalshiUser;
  }) {
    this.baseUrl = config.baseUrl;
    this.user = config.user;
  }

  // Set user for trading
  public setUser(user: KalshiUser): void {
    this.user = user;
    logger.info('User set for Kalshi trading', { userId: user.user_id });
  }

  // Create a new order
  public async createOrder(order: UnifiedOrder): Promise<KalshiOrderResponse> {
    if (!this.user) {
      throw new Error('User not configured for trading');
    }

    try {
      const ticker = this.extractTicker(order.tokenId);
      const side = this.extractSide(order.tokenId);
      
      const orderRequest: KalshiOrderRequest = {
        ticker,
        side: side === 'YES' ? 'yes' : 'no',
        action: order.side === 'BUY' ? 'buy' : 'sell',
        count: Math.floor(order.sizeUsd), // Kalshi uses integer counts
        price: Math.round((order.price || 0) * 100), // Convert to cents
        buy_max_cost: order.side === 'BUY' ? order.sizeUsd : undefined,
        sell_max_cost: order.side === 'SELL' ? order.sizeUsd : undefined,
      };

      logger.info('Creating Kalshi order', {
        ticker,
        side: orderRequest.side,
        action: orderRequest.action,
        count: orderRequest.count,
        price: orderRequest.price,
      });

      const response = await this.makeRequest('/trade-api/v2/orders', {
        method: 'POST',
        body: JSON.stringify(orderRequest),
      });

      return response as KalshiOrderResponse;
    } catch (error) {
      logger.error('Failed to create Kalshi order', { error, order });
      throw error;
    }
  }

  // Cancel an existing order
  public async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.user) {
      throw new Error('User not configured for trading');
    }

    try {
      logger.info('Cancelling Kalshi order', { orderId });

      await this.makeRequest(`/trade-api/v2/orders/${orderId}/cancel`, {
        method: 'POST',
      });

      return true;
    } catch (error) {
      logger.error('Failed to cancel Kalshi order', { error, orderId });
      throw error;
    }
  }

  // Get order status
  public async getOrderStatus(orderId: string): Promise<KalshiOrderResponse> {
    try {
      logger.debug('Getting Kalshi order status', { orderId });

      const response = await this.makeRequest(`/trade-api/v2/orders/${orderId}`, {
        method: 'GET',
      });

      return response as KalshiOrderResponse;
    } catch (error) {
      logger.error('Failed to get Kalshi order status', { error, orderId });
      throw error;
    }
  }

  // Get user's open orders
  public async getOpenOrders(): Promise<KalshiOrderResponse[]> {
    if (!this.user) {
      throw new Error('User not configured for trading');
    }

    try {
      logger.debug('Getting Kalshi open orders', { userId: this.user.user_id });

      const response = await this.makeRequest('/trade-api/v2/orders', {
        method: 'GET',
        params: { user_id: this.user.user_id, status: 'resting' },
      });

      return response as KalshiOrderResponse[];
    } catch (error) {
      logger.error('Failed to get Kalshi open orders', { error });
      throw error;
    }
  }

  // Get user's order history
  public async getOrderHistory(limit: number = 100, offset: number = 0): Promise<KalshiOrderResponse[]> {
    if (!this.user) {
      throw new Error('User not configured for trading');
    }

    try {
      logger.debug('Getting Kalshi order history', { 
        userId: this.user.user_id, 
        limit, 
        offset 
      });

      const response = await this.makeRequest('/trade-api/v2/orders', {
        method: 'GET',
        params: { 
          user_id: this.user.user_id, 
          limit, 
          offset 
        },
      });

      return response as KalshiOrderResponse[];
    } catch (error) {
      logger.error('Failed to get Kalshi order history', { error });
      throw error;
    }
  }

  // Get user's positions
  public async getPositions(): Promise<any[]> {
    if (!this.user) {
      throw new Error('User not configured for trading');
    }

    try {
      logger.debug('Getting Kalshi positions', { userId: this.user.user_id });

      const response = await this.makeRequest('/trade-api/v2/positions', {
        method: 'GET',
        params: { user_id: this.user.user_id },
      });

      return response as any[];
    } catch (error) {
      logger.error('Failed to get Kalshi positions', { error });
      throw error;
    }
  }

  // Get user's portfolio
  public async getPortfolio(): Promise<{ balance: number; currency: string }> {
    if (!this.user) {
      throw new Error('User not configured for trading');
    }

    try {
      logger.debug('Getting Kalshi portfolio', { userId: this.user.user_id });

      const response = await this.makeRequest('/trade-api/v2/portfolio', {
        method: 'GET',
        params: { user_id: this.user.user_id },
      });

      return {
        balance: response.balance || 0,
        currency: 'USD',
      };
    } catch (error) {
      logger.error('Failed to get Kalshi portfolio', { error });
      throw error;
    }
  }

  // Convert unified order to Kalshi trade
  public convertOrderToTrade(
    order: UnifiedOrder,
    kalshiResponse: KalshiOrderResponse
  ): UnifiedTrade[] {
    if (!kalshiResponse.fills) {
      return [];
    }

    return kalshiResponse.fills.map((fill) => ({
      id: fill.fill_id,
      orderId: order.id,
      userId: order.userId,
      venue: 'kalshi' as const,
      tokenId: order.tokenId,
      side: order.side,
      price: fill.price / 100, // Convert from cents to 0-1 range
      sizeUsd: fill.count * (fill.price / 100), // Approximate USD value
      sizeTokens: fill.count,
      executedAt: new Date(fill.timestamp * 1000), // Convert from seconds to milliseconds
      createdAt: new Date(),
      venueTradeId: fill.fill_id,
      venueTxHash: undefined, // Kalshi doesn't use blockchain
      feeUsd: 0, // Would need to calculate based on Kalshi fees
      feeTokens: 0,
      rawData: fill,
    }));
  }

  // Extract ticker from unified token ID
  private extractTicker(unifiedTokenId: UnifiedTokenId): string {
    // Convert from "kalshi:TRUMPWIN:YES" to "TRUMPWIN"
    const parts = unifiedTokenId.split(':');
    if (parts.length !== 3 || parts[0] !== 'kalshi') {
      throw new Error(`Invalid Kalshi token ID format: ${unifiedTokenId}`);
    }
    return parts[1];
  }

  // Extract side from unified token ID
  private extractSide(unifiedTokenId: UnifiedTokenId): 'YES' | 'NO' {
    const parts = unifiedTokenId.split(':');
    if (parts.length !== 3) {
      throw new Error(`Invalid token ID format: ${unifiedTokenId}`);
    }
    return parts[2] as 'YES' | 'NO';
  }

  // Make authenticated request to Kalshi API
  private async makeRequest(endpoint: string, options: RequestInit & { params?: Record<string, any> }): Promise<any> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    
    // Add query parameters
    if (options.params) {
      Object.entries(options.params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      });
    }
    
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    };

    // Add API key if available
    if (this.user?.api_key) {
      headers['Authorization'] = `Bearer ${this.user.api_key}`;
    } else {
      // Try to get API key from file if user not set
      try {
        const apiKey = await getKalshiApiKey();
        headers['Authorization'] = `Bearer ${apiKey}`;
      } catch (error) {
        logger.warn('Could not load Kalshi API key from file', error);
      }
    }

    const response = await fetch(url.toString(), {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Kalshi API error: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  // Health check
  public async healthCheck(): Promise<boolean> {
    try {
      await this.makeRequest('/trade-api/v2/health', { method: 'GET' });
      return true;
    } catch (error) {
      logger.error('Kalshi trading client health check failed', error);
      return false;
    }
  }
}
