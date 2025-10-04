// Middleware to check if trading is enabled before executing trades
import { EmergencyStopService, assertTradingEnabled } from '@hunch/shared/services/emergency-stop';
import { Pool } from 'pg';
import { Redis } from 'ioredis';

let emergencyStop: EmergencyStopService | null = null;

export function initEmergencyStop(redis: Redis, pool: Pool) {
  emergencyStop = new EmergencyStopService(redis, pool);
  
  // Subscribe to trading control changes
  emergencyStop.subscribeToChanges((status) => {
    const scope = status.venueId !== undefined && status.venueId !== null 
      ? `venue ${status.venueId}` 
      : 'globally';
    
    if (status.tradingEnabled) {
      console.log(`[TRADING RESUMED] ${scope}: ${status.reason}`);
    } else {
      console.warn(`[EMERGENCY STOP] Trading disabled ${scope}: ${status.reason}`);
    }
  });
  
  return emergencyStop;
}

export function getEmergencyStop(): EmergencyStopService {
  if (!emergencyStop) {
    throw new Error('Emergency stop service not initialized. Call initEmergencyStop first.');
  }
  return emergencyStop;
}

/**
 * Middleware function to check if trading is enabled
 * Use this before executing any trade
 */
export async function checkTradingEnabled(venueId?: number): Promise<void> {
  const service = getEmergencyStop();
  await assertTradingEnabled(service, venueId);
}

/**
 * Example usage in order placement:
 * 
 * async function placeOrder(userId: string, order: OrderRequest) {
 *   // Check if trading is enabled before proceeding
 *   await checkTradingEnabled(order.venueId);
 *   
 *   // Proceed with order placement
 *   // ...
 * }
 */

