// Venue Order Manager Factory
// This factory creates venue-specific order managers

import { VenueOrderManager, PlaceOrderRequest, PlaceOrderResponse, CancelOrderResponse, GetOrderResponse, GetActiveOrdersResponse, GetPositionsResponse } from './order-types.js';
import { PolymarketOrderManager } from './polymarket-order-manager.js';

export class VenueOrderManagerFactory {
  private static managers: Map<string, VenueOrderManager> = new Map();

  static getManager(venue: 'polymarket' | 'kalshi' | 'limitless'): VenueOrderManager {
    if (!this.managers.has(venue)) {
      switch (venue) {
        case 'polymarket':
          this.managers.set(venue, new PolymarketOrderManager());
          break;
        case 'kalshi':
          throw new Error('Kalshi order manager not yet implemented');
        case 'limitless':
          throw new Error('Limitless order manager not yet implemented');
        default:
          throw new Error(`Unknown venue: ${venue}`);
      }
    }

    return this.managers.get(venue)!;
  }

  static async placeOrder(
    venue: 'polymarket' | 'kalshi' | 'limitless',
    userId: string,
    walletAddress: string,
    request: PlaceOrderRequest & {
      l1Signature?: string;
      l1Timestamp?: string;
      l1Nonce?: string;
    }
  ): Promise<PlaceOrderResponse> {
    const manager = this.getManager(venue);
    return manager.placeOrder(userId, walletAddress, request);
  }

  static async cancelOrder(
    venue: 'polymarket' | 'kalshi' | 'limitless',
    userId: string,
    walletAddress: string,
    orderId: string
  ): Promise<CancelOrderResponse> {
    const manager = this.getManager(venue);
    return manager.cancelOrder(userId, walletAddress, orderId);
  }

  static async getOrder(
    venue: 'polymarket' | 'kalshi' | 'limitless',
    userId: string,
    walletAddress: string,
    orderId: string
  ): Promise<GetOrderResponse> {
    const manager = this.getManager(venue);
    return manager.getOrder(userId, walletAddress, orderId);
  }

  static async getActiveOrders(
    venue: 'polymarket' | 'kalshi' | 'limitless',
    userId: string,
    walletAddress: string
  ): Promise<GetActiveOrdersResponse> {
    const manager = this.getManager(venue);
    return manager.getActiveOrders(userId, walletAddress);
  }

  static async getPositions(
    venue: 'polymarket' | 'kalshi' | 'limitless',
    userId: string,
    walletAddress: string
  ): Promise<GetPositionsResponse> {
    const manager = this.getManager(venue);
    return manager.getPositions(userId, walletAddress);
  }

  static validateOrder(
    venue: 'polymarket' | 'kalshi' | 'limitless',
    request: PlaceOrderRequest
  ): { valid: boolean; error?: string } {
    const manager = this.getManager(venue);
    return manager.validateOrder(request);
  }
}
