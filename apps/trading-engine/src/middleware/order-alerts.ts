// Order alerts integration for trading engine
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { AlertService, createAlertService, OrderAlert } from '@hunch/shared/services/alert-service';

let alertService: AlertService | null = null;

export function initAlertService(redis: Redis, pool: Pool): AlertService {
  alertService = createAlertService(pool, redis, {
    largeOrderThreshold: 10000, // $10k
    enableLogging: true,
    enableEmail: process.env.ALERT_ENABLE_EMAIL === 'true',
    enableSlack: process.env.ALERT_ENABLE_SLACK === 'true',
  });

  // Subscribe to real-time alerts
  alertService.subscribeToAlerts('large_order', (alert: OrderAlert) => {
    console.log(`[REAL-TIME ALERT] Large order: $${alert.sizeUsd} - ${alert.orderId}`);
  });

  return alertService;
}

export function getAlertService(): AlertService {
  if (!alertService) {
    throw new Error('Alert service not initialized. Call initAlertService first.');
  }
  return alertService;
}

/**
 * Check order and send alerts if needed
 * Call this when an order is placed
 */
export async function checkAndAlertOrder(order: {
  orderId: string;
  userId: string;
  venue: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  price?: number;
  sizeUsd: number;
}): Promise<void> {
  const service = getAlertService();
  
  const orderAlert: OrderAlert = {
    ...order,
    timestamp: new Date(),
    reason: order.sizeUsd >= 50000 
      ? 'Order exceeds $50k (critical threshold)' 
      : 'Order exceeds $10k (warning threshold)',
  };

  await service.checkOrderSizeAndAlert(orderAlert);
}

/**
 * Check for order anomalies (rapid trading, high exposure)
 */
export async function checkOrderAnomalies(
  userId: string,
  recentOrders: Array<{
    orderId: string;
    userId: string;
    venue: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    orderType: string;
    price?: number;
    sizeUsd: number;
    timestamp: Date;
  }>
): Promise<void> {
  const service = getAlertService();
  
  const orderAlerts: OrderAlert[] = recentOrders.map(o => ({
    ...o,
    reason: 'Order pattern analysis',
  }));

  await service.checkOrderAnomalies(userId, orderAlerts);
}

/**
 * Example usage in order manager:
 * 
 * async function createOrder(userId: string, orderRequest: OrderRequest) {
 *   // 1. Check if trading is enabled
 *   await checkTradingEnabled(orderRequest.venueId);
 *   
 *   // 2. Create the order
 *   const order = await orderRepo.create(orderRequest);
 *   
 *   // 3. Check and send alerts for large orders
 *   await checkAndAlertOrder({
 *     orderId: order.id,
 *     userId,
 *     venue: orderRequest.venue,
 *     tokenId: orderRequest.tokenId,
 *     side: orderRequest.side,
 *     orderType: orderRequest.orderType,
 *     price: orderRequest.price,
 *     sizeUsd: orderRequest.sizeUsd,
 *   });
 *   
 *   // 4. Check for anomalies
 *   const recentOrders = await orderRepo.getRecentOrders(userId, { minutes: 60 });
 *   await checkOrderAnomalies(userId, recentOrders);
 *   
 *   return order;
 * }
 */

