// Limitless trading client for order execution
import { logger } from '@hunch/shared';
import { UnifiedOrder, UnifiedTrade, UnifiedTokenId } from '@hunch/shared';

// Limitless-specific types
export interface LimitlessOrderRequest {
  market_id: number;
  side: 'buy' | 'sell';
  amount: string;
  price: string;
  order_type?: 'market' | 'limit';
}

export interface LimitlessOrderResponse {
  order_id: string;
  status: 'pending' | 'filled' | 'cancelled' | 'rejected';
  created_at: string;
  market_id: number;
  side: string;
  amount: string;
  price: string;
  fills?: LimitlessFill[];
}

export interface LimitlessFill {
  fill_id: string;
  price: string;
  amount: string;
  timestamp: string;
  tx_hash?: string;
}

export interface LimitlessCancelRequest {
  order_id: string;
}

export interface LimitlessUser {
  user_id: string;
  api_key: string;
  wallet_address?: string;
}

export class LimitlessTradingClient {
  private baseUrl: string;
  private user?: LimitlessUser;

  constructor(config: {
    baseUrl: string;
    user?: LimitlessUser;
  }) {
    this.baseUrl = config.baseUrl;
    this.user = config.user;
  }

  // Set user for trading
  public setUser(user: LimitlessUser): void {
    this.user = user;
    logger.info('User set for Limitless trading', { userId: user.user_id });
  }

  // Create a new order
  public async createOrder(order: UnifiedOrder): Promise<LimitlessOrderResponse> {
    if (!this.user) {
      throw new Error('User not configured for trading');
    }

    try {
      const marketId = this.extractMarketId(order.tokenId);
      
      const orderRequest: LimitlessOrderRequest = {
        market_id: marketId,
        side: order.side === 'BUY' ? 'buy' : 'sell',
        amount: order.sizeUsd.toString(),
        price: (order.price || 0).toString(),
        order_type: order.orderType === 'MARKET' ? 'market' : 'limit',
      };

      logger.info('Creating Limitless order', {
        marketId,
        side: orderRequest.side,
        amount: orderRequest.amount,
        price: orderRequest.price,
      });

      const response = await this.makeRequest('/orders', {
        method: 'POST',
        body: JSON.stringify(orderRequest),
      });

      return response as LimitlessOrderResponse;
    } catch (error) {
      logger.error('Failed to create Limitless order', { error, order });
      throw error;
    }
  }

  // Cancel an existing order
  public async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.user) {
      throw new Error('User not configured for trading');
    }

    try {
      logger.info('Cancelling Limitless order', { orderId });

      await this.makeRequest(`/orders/${orderId}`, {
        method: 'DELETE',
      });

      return true;
    } catch (error) {
      logger.error('Failed to cancel Limitless order', { error, orderId });
      throw error;
    }
  }

  // Get order status
  public async getOrderStatus(orderId: string): Promise<LimitlessOrderResponse> {
    try {
      logger.debug('Getting Limitless order status', { orderId });

      const response = await this.makeRequest(`/orders/${orderId}`, {
        method: 'GET',
      });

      return response as LimitlessOrderResponse;
    } catch (error) {
      logger.error('Failed to get Limitless order status', { error, orderId });
      throw error;
    }
  }

  // Get user's open orders
  public async getOpenOrders(): Promise<LimitlessOrderResponse[]> {
    if (!this.user) {
      throw new Error('User not configured for trading');
    }

    try {
      logger.debug('Getting Limitless open orders', { userId: this.user.user_id });

      const response = await this.makeRequest('/orders', {
        method: 'GET',
        params: { user_id: this.user.user_id, status: 'pending' },
      });

      return response as LimitlessOrderResponse[];
    } catch (error) {
      logger.error('Failed to get Limitless open orders', { error });
      throw error;
    }
  }

  // Get user's order history
  public async getOrderHistory(limit: number = 100, offset: number = 0): Promise<LimitlessOrderResponse[]> {
    if (!this.user) {
      throw new Error('User not configured for trading');
    }

    try {
      logger.debug('Getting Limitless order history', { 
        userId: this.user.user_id, 
        limit, 
        offset 
      });

      const response = await this.makeRequest('/orders', {
        method: 'GET',
        params: { 
          user_id: this.user.user_id, 
          limit, 
          offset 
        },
      });

      return response as LimitlessOrderResponse[];
    } catch (error) {
      logger.error('Failed to get Limitless order history', { error });
      throw error;
    }
  }

  // Get user's positions
  public async getPositions(): Promise<any[]> {
    if (!this.user) {
      throw new Error('User not configured for trading');
    }

    try {
      logger.debug('Getting Limitless positions', { userId: this.user.user_id });

      const response = await this.makeRequest('/positions', {
        method: 'GET',
        params: { user_id: this.user.user_id },
      });

      return response as any[];
    } catch (error) {
      logger.error('Failed to get Limitless positions', { error });
      throw error;
    }
  }

  // Get wallet balance
  public async getBalance(): Promise<{ balance: string; currency: string }> {
    if (!this.user) {
      throw new Error('User not configured for trading');
    }

    try {
      logger.debug('Getting Limitless balance', { userId: this.user.user_id });

      const response = await this.makeRequest('/wallet/balance', {
        method: 'GET',
      });

      return {
        balance: response.balance || '0',
        currency: response.currency || 'USD',
      };
    } catch (error) {
      logger.error('Failed to get Limitless balance', { error });
      throw error;
    }
  }

  // Convert unified order to Limitless trade
  public convertOrderToTrade(
    order: UnifiedOrder,
    limitlessResponse: LimitlessOrderResponse
  ): UnifiedTrade[] {
    if (!limitlessResponse.fills) {
      return [];
    }

    return limitlessResponse.fills.map((fill) => ({
      id: fill.fill_id,
      orderId: order.id,
      userId: order.userId,
      venue: 'limitless' as const,
      tokenId: order.tokenId,
      side: order.side,
      price: parseFloat(fill.price),
      sizeUsd: parseFloat(fill.amount),
      sizeTokens: parseFloat(fill.amount), // Assuming 1:1 for Limitless
      executedAt: new Date(fill.timestamp),
      createdAt: new Date(),
      venueTradeId: fill.fill_id,
      venueTxHash: fill.tx_hash,
      feeUsd: 0, // Would need to calculate based on Limitless fees
      feeTokens: 0,
      rawData: fill,
    }));
  }

  // Extract market ID from unified token ID
  private extractMarketId(unifiedTokenId: UnifiedTokenId): number {
    // Convert from "limitless:123:YES" to 123
    const parts = unifiedTokenId.split(':');
    if (parts.length !== 3 || parts[0] !== 'limitless') {
      throw new Error(`Invalid Limitless token ID format: ${unifiedTokenId}`);
    }
    return parseInt(parts[1], 10);
  }

  // Make authenticated request to Limitless API
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
    }

    const response = await fetch(url.toString(), {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Limitless API error: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  // Health check
  public async healthCheck(): Promise<boolean> {
    try {
      await this.makeRequest('/health', { method: 'GET' });
      return true;
    } catch (error) {
      logger.error('Limitless trading client health check failed', error);
      return false;
    }
  }
}
