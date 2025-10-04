// Polymarket trading client for order execution
import { logger } from '@hunch/shared';
import { UnifiedOrder, UnifiedTrade, UnifiedTokenId } from '@hunch/shared';

// Polymarket-specific types
export interface PolymarketOrderRequest {
  token_id: string;
  side: 'BUY' | 'SELL';
  price: string;
  size: string;
  nonce?: number;
  expiration?: number;
  signature?: string;
}

export interface PolymarketOrderResponse {
  order_id: string;
  status: 'PENDING' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'REJECTED';
  fills?: PolymarketFill[];
  created_at: string;
  updated_at: string;
}

export interface PolymarketFill {
  fill_id: string;
  price: string;
  size: string;
  timestamp: string;
  tx_hash?: string;
}

export interface PolymarketCancelRequest {
  order_id: string;
  nonce?: number;
  signature?: string;
}

export interface PolymarketWallet {
  address: string;
  private_key?: string; // For server-side signing
  nonce: number;
}

export class PolymarketTradingClient {
  private baseUrl: string;
  private wallet?: PolymarketWallet;
  private apiKey?: string;

  constructor(config: {
    baseUrl: string;
    wallet?: PolymarketWallet;
    apiKey?: string;
  }) {
    this.baseUrl = config.baseUrl;
    this.wallet = config.wallet;
    this.apiKey = config.apiKey;
  }

  // Set wallet for trading
  public setWallet(wallet: PolymarketWallet): void {
    this.wallet = wallet;
    logger.info('Wallet set for Polymarket trading', { address: wallet.address });
  }

  // Create a new order
  public async createOrder(order: UnifiedOrder): Promise<PolymarketOrderResponse> {
    if (!this.wallet) {
      throw new Error('Wallet not configured for trading');
    }

    try {
      const orderRequest: PolymarketOrderRequest = {
        token_id: this.extractTokenId(order.tokenId),
        side: order.side,
        price: order.price?.toString() || '0',
        size: order.sizeUsd.toString(),
        nonce: this.wallet.nonce,
        // signature would be generated here for production
      };

      logger.info('Creating Polymarket order', {
        tokenId: order.tokenId,
        side: order.side,
        price: order.price,
        size: order.sizeUsd,
      });

      const response = await this.makeRequest('/orders', {
        method: 'POST',
        body: JSON.stringify(orderRequest),
      });

      // Increment nonce for next order
      this.wallet.nonce++;

      return response as PolymarketOrderResponse;
    } catch (error) {
      logger.error('Failed to create Polymarket order', { error, order });
      throw error;
    }
  }

  // Cancel an existing order
  public async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.wallet) {
      throw new Error('Wallet not configured for trading');
    }

    try {
      const cancelRequest: PolymarketCancelRequest = {
        order_id: orderId,
        nonce: this.wallet.nonce,
        // signature would be generated here for production
      };

      logger.info('Cancelling Polymarket order', { orderId });

      await this.makeRequest(`/orders/${orderId}/cancel`, {
        method: 'POST',
        body: JSON.stringify(cancelRequest),
      });

      // Increment nonce for next operation
      this.wallet.nonce++;

      return true;
    } catch (error) {
      logger.error('Failed to cancel Polymarket order', { error, orderId });
      throw error;
    }
  }

  // Get order status
  public async getOrderStatus(orderId: string): Promise<PolymarketOrderResponse> {
    try {
      logger.debug('Getting Polymarket order status', { orderId });

      const response = await this.makeRequest(`/orders/${orderId}`, {
        method: 'GET',
      });

      return response as PolymarketOrderResponse;
    } catch (error) {
      logger.error('Failed to get Polymarket order status', { error, orderId });
      throw error;
    }
  }

  // Get user's open orders
  public async getOpenOrders(): Promise<PolymarketOrderResponse[]> {
    if (!this.wallet) {
      throw new Error('Wallet not configured for trading');
    }

    try {
      logger.debug('Getting Polymarket open orders', { address: this.wallet.address });

      const response = await this.makeRequest(`/orders?address=${this.wallet.address}&status=open`, {
        method: 'GET',
      });

      return response as PolymarketOrderResponse[];
    } catch (error) {
      logger.error('Failed to get Polymarket open orders', { error });
      throw error;
    }
  }

  // Get user's order history
  public async getOrderHistory(limit: number = 100, offset: number = 0): Promise<PolymarketOrderResponse[]> {
    if (!this.wallet) {
      throw new Error('Wallet not configured for trading');
    }

    try {
      logger.debug('Getting Polymarket order history', { 
        address: this.wallet.address, 
        limit, 
        offset 
      });

      const response = await this.makeRequest(
        `/orders?address=${this.wallet.address}&limit=${limit}&offset=${offset}`,
        {
          method: 'GET',
        }
      );

      return response as PolymarketOrderResponse[];
    } catch (error) {
      logger.error('Failed to get Polymarket order history', { error });
      throw error;
    }
  }

  // Get user's positions
  public async getPositions(): Promise<any[]> {
    if (!this.wallet) {
      throw new Error('Wallet not configured for trading');
    }

    try {
      logger.debug('Getting Polymarket positions', { address: this.wallet.address });

      const response = await this.makeRequest(`/positions?address=${this.wallet.address}`, {
        method: 'GET',
      });

      return response as any[];
    } catch (error) {
      logger.error('Failed to get Polymarket positions', { error });
      throw error;
    }
  }

  // Get wallet balance
  public async getBalance(): Promise<{ balance: string; currency: string }> {
    if (!this.wallet) {
      throw new Error('Wallet not configured for trading');
    }

    try {
      logger.debug('Getting Polymarket balance', { address: this.wallet.address });

      const response = await this.makeRequest(`/balance?address=${this.wallet.address}`, {
        method: 'GET',
      });

      return response as { balance: string; currency: string };
    } catch (error) {
      logger.error('Failed to get Polymarket balance', { error });
      throw error;
    }
  }

  // Convert unified order to Polymarket trade
  public convertOrderToTrade(
    order: UnifiedOrder,
    polymarketResponse: PolymarketOrderResponse
  ): UnifiedTrade[] {
    if (!polymarketResponse.fills) {
      return [];
    }

    return polymarketResponse.fills.map((fill) => ({
      id: fill.fill_id,
      orderId: order.id,
      userId: order.userId,
      venue: 'polymarket' as const,
      tokenId: order.tokenId,
      side: order.side,
      price: parseFloat(fill.price),
      sizeUsd: parseFloat(fill.size),
      sizeTokens: parseFloat(fill.size), // Assuming 1:1 for now
      executedAt: new Date(fill.timestamp),
      createdAt: new Date(),
      venueTradeId: fill.fill_id,
      venueTxHash: fill.tx_hash,
      feeUsd: 0, // Would need to calculate based on Polymarket fees
      feeTokens: 0,
      rawData: fill,
    }));
  }

  // Extract token ID from unified token ID
  private extractTokenId(unifiedTokenId: UnifiedTokenId): string {
    // Convert from "polymarket:542537:YES" to "542537"
    const parts = unifiedTokenId.split(':');
    if (parts.length !== 3 || parts[0] !== 'polymarket') {
      throw new Error(`Invalid Polymarket token ID format: ${unifiedTokenId}`);
    }
    return parts[1];
  }

  // Make authenticated request to Polymarket API
  private async makeRequest(endpoint: string, options: RequestInit): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    };

    // Add API key if available
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Polymarket API error: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  // Health check
  public async healthCheck(): Promise<boolean> {
    try {
      await this.makeRequest('/health', { method: 'GET' });
      return true;
    } catch (error) {
      logger.error('Polymarket trading client health check failed', error);
      return false;
    }
  }
}
