// Main entry point for price history service
import { PriceHistoryService } from './services/price-history-service';
import { logger } from '@hunch/shared';
import { config } from 'dotenv';
import { resolve } from 'path';
import Fastify from 'fastify';

// Load environment variables
config({ path: resolve(process.cwd(), '../../.env'), override: true });

// Configuration
const priceHistoryConfig = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://hunch:hunch@localhost:5432/hunch',
  enableAggregation: process.env.ENABLE_AGGREGATION === 'true',
  aggregationInterval: parseInt(process.env.AGGREGATION_INTERVAL || '60000'), // 1 minute
  retentionDays: parseInt(process.env.RETENTION_DAYS || '90'),
  compressionDays: parseInt(process.env.COMPRESSION_DAYS || '7'),
};

// Create Fastify app
const app = Fastify({ logger: true });

// Create and start the price history service
async function main() {
  const priceHistoryService = new PriceHistoryService(priceHistoryConfig);

  // Setup event handlers
  priceHistoryService.on('price:recorded', (priceData) => {
    logger.debug('Price data recorded', { 
      tokenId: priceData.tokenId, 
      resolution: priceData.resolution 
    });
  });

  priceHistoryService.on('aggregation:completed', (tokenId, resolution) => {
    logger.debug('Aggregation completed', { tokenId, resolution });
  });

  priceHistoryService.on('error', (error, context) => {
    logger.error('Price history service error', { error: error.message, context });
  });

  // API Routes
  app.get('/health', async () => {
    const health = await priceHistoryService.healthCheck();
    return health;
  });

  app.get('/stats', async () => {
    const stats = await priceHistoryService.getStats();
    return stats;
  });

  // Get chart data
  app.get('/chart/:tokenId', async (request, reply) => {
    try {
      const { tokenId } = request.params as { tokenId: string };
      const { resolution, startTime, endTime } = request.query as {
        resolution?: string;
        startTime?: string;
        endTime?: string;
      };

      if (!resolution || !startTime || !endTime) {
        return reply.code(400).send({ error: 'resolution, startTime, and endTime are required' });
      }

      const chartData = await priceHistoryService.getChartData(
        tokenId as any,
        resolution as any,
        new Date(startTime),
        new Date(endTime)
      );

      return chartData;
    } catch (error) {
      logger.error('Failed to get chart data', error);
      return reply.code(500).send({ error: 'Failed to get chart data' });
    }
  });

  // Get latest price
  app.get('/price/:tokenId/latest', async (request, reply) => {
    try {
      const { tokenId } = request.params as { tokenId: string };
      const latestPrice = await priceHistoryService.getLatestPrice(tokenId as any);
      
      if (!latestPrice) {
        return reply.code(404).send({ error: 'No price data found' });
      }

      return latestPrice;
    } catch (error) {
      logger.error('Failed to get latest price', error);
      return reply.code(500).send({ error: 'Failed to get latest price' });
    }
  });

  // Get price statistics
  app.get('/stats/:tokenId', async (request, reply) => {
    try {
      const { tokenId } = request.params as { tokenId: string };
      const { resolution, startTime, endTime } = request.query as {
        resolution?: string;
        startTime?: string;
        endTime?: string;
      };

      if (!resolution || !startTime || !endTime) {
        return reply.code(400).send({ error: 'resolution, startTime, and endTime are required' });
      }

      const stats = await priceHistoryService.getPriceStatistics(
        tokenId as any,
        resolution as any,
        new Date(startTime),
        new Date(endTime)
      );

      return stats;
    } catch (error) {
      logger.error('Failed to get price statistics', error);
      return reply.code(500).send({ error: 'Failed to get price statistics' });
    }
  });

  // Record price data (for internal use)
  app.post('/price', async (request, reply) => {
    try {
      const priceData = request.body as any;
      await priceHistoryService.recordPriceData(priceData);
      return { success: true };
    } catch (error) {
      logger.error('Failed to record price data', error);
      return reply.code(500).send({ error: 'Failed to record price data' });
    }
  });

  // Cleanup old data
  app.post('/cleanup', async (request, reply) => {
    try {
      await priceHistoryService.cleanupOldData();
      return { success: true };
    } catch (error) {
      logger.error('Failed to cleanup old data', error);
      return reply.code(500).send({ error: 'Failed to cleanup old data' });
    }
  });

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    try {
      await priceHistoryService.stop();
      await app.close();
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    // Start price history service
    await priceHistoryService.start();

    // Start Fastify server
    const port = parseInt(process.env.PRICE_HISTORY_PORT || '3004');
    await app.listen({ port, host: '0.0.0.0' });

    logger.info(`Price history service started on port ${port}`);
  } catch (error) {
    logger.error('Failed to start price history service', error);
    process.exit(1);
  }
}

// Start the service
main().catch((error) => {
  logger.error('Unhandled error in main', error);
  process.exit(1);
});
