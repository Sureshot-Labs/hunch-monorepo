// DLQ Retry Worker - Processes failed ingestion items
import { Pool } from 'pg';
import { DeadLetterQueueService } from '@hunch/shared/services/dead-letter-queue';

export class DLQRetryWorker {
  private dlq: DeadLetterQueueService;
  private isRunning: boolean = false;
  private intervalMs: number;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(pool: Pool, intervalMs: number = 60000) {
    this.dlq = new DeadLetterQueueService(pool);
    this.intervalMs = intervalMs; // Default: check every 1 minute
  }

  /**
   * Start the retry worker
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('[DLQ WORKER] Already running');
      return;
    }

    this.isRunning = true;
    console.log(`[DLQ WORKER] Starting with ${this.intervalMs}ms interval`);

    // Process immediately on start
    await this.processRetries();

    // Then process on interval
    this.intervalId = setInterval(async () => {
      await this.processRetries();
    }, this.intervalMs);
  }

  /**
   * Stop the retry worker
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('[DLQ WORKER] Stopped');
  }

  /**
   * Process items ready for retry
   */
  private async processRetries(): Promise<void> {
    try {
      const items = await this.dlq.getItemsForRetry(50); // Process up to 50 items per batch

      if (items.length === 0) {
        return;
      }

      console.log(`[DLQ WORKER] Processing ${items.length} failed items`);

      for (const item of items) {
        await this.retryItem(item);
      }

      // Get stats after processing
      const stats = await this.dlq.getStats();
      const pendingCount = stats.reduce((sum, s) => s.status === 'pending' ? sum + s.total_count : sum, 0);
      
      if (pendingCount > 0) {
        console.log(`[DLQ WORKER] ${pendingCount} items still pending`);
      }
    } catch (error) {
      console.error('[DLQ WORKER] Error processing retries:', error);
    }
  }

  /**
   * Retry a single DLQ item
   */
  private async retryItem(item: any): Promise<void> {
    console.log(`[DLQ WORKER] Retrying ${item.source}/${item.resource_type} - ${item.id} (attempt ${item.retry_count + 1})`);

    try {
      // Attempt to reprocess based on resource type
      const success = await this.reprocessItem(item);

      if (success) {
        await this.dlq.updateRetryAttempt(item.id, true);
        console.log(`[DLQ WORKER] ✓ Successfully processed ${item.id}`);
      } else {
        await this.dlq.updateRetryAttempt(item.id, false, 'Reprocessing returned false');
      }
    } catch (error: any) {
      await this.dlq.updateRetryAttempt(item.id, false, error.message);
      console.error(`[DLQ WORKER] ✗ Failed to process ${item.id}:`, error.message);
    }
  }

  /**
   * Reprocess a failed item based on its type
   * This is a placeholder - actual implementation should call the appropriate mapper/processor
   */
  private async reprocessItem(item: any): Promise<boolean> {
    // TODO: Integrate with actual mapper and repo logic
    // For now, just log what we would do
    
    console.log(`[DLQ WORKER] Would reprocess ${item.source}/${item.resource_type}`);
    console.log(`[DLQ WORKER] Payload:`, JSON.stringify(item.raw_payload).substring(0, 200));

    // Placeholder logic:
    // 1. Get the appropriate mapper for the source
    // 2. Map the raw payload
    // 3. Upsert to database
    // 4. Return true if successful

    // For now, simulate success (replace with actual logic)
    return Math.random() > 0.5; // 50% success rate for testing
  }

  /**
   * Get worker status
   */
  getStatus(): { running: boolean; intervalMs: number } {
    return {
      running: this.isRunning,
      intervalMs: this.intervalMs,
    };
  }

  /**
   * Process items now (manual trigger)
   */
  async processNow(): Promise<void> {
    await this.processRetries();
  }

  /**
   * Get DLQ statistics
   */
  async getStats(): Promise<any[]> {
    return this.dlq.getStats();
  }

  /**
   * Clean up old items
   */
  async cleanup(): Promise<number> {
    return this.dlq.cleanup();
  }
}

/**
 * Singleton DLQ worker instance
 */
let dlqWorkerInstance: DLQRetryWorker | null = null;

export function initDLQWorker(pool: Pool, intervalMs?: number): DLQRetryWorker {
  if (!dlqWorkerInstance) {
    dlqWorkerInstance = new DLQRetryWorker(pool, intervalMs);
  }
  return dlqWorkerInstance;
}

export function getDLQWorker(): DLQRetryWorker {
  if (!dlqWorkerInstance) {
    throw new Error('DLQ worker not initialized. Call initDLQWorker first.');
  }
  return dlqWorkerInstance;
}

/**
 * Example integration in bootstrap or main:
 * 
 * // In apps/indexer-polymarket/src/main.ts
 * import { initDLQWorker } from '@hunch/shared/services/dead-letter-queue';
 * 
 * async function main() {
 *   const pool = createPool();
 *   
 *   // Start DLQ retry worker
 *   const dlqWorker = initDLQWorker(pool, 60000); // Check every 1 minute
 *   await dlqWorker.start();
 *   
 *   // ... rest of your code
 * }
 */

