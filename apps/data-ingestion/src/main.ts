// Main entry point for data ingestion service
import { DataIngestionService } from './services/ingestion-service';
import { logger } from '@hunch/shared';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables
config({ path: resolve(process.cwd(), '../../.env'), override: true });

// Configuration
const ingestionConfig = {
  venues: ['polymarket', 'kalshi', 'limitless'] as const,
  queueConfig: {
    concurrency: 8,
    interval: 1000, // 1 second
    intervalCap: 50,
    retryAttempts: 3,
    retryDelay: 1000,
  },
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  enablePriceHistory: true,
  enableRealTimeUpdates: true,
};

// Create and start the ingestion service
async function main() {
  const ingestionService = new DataIngestionService(ingestionConfig);

  // Setup event handlers
  ingestionService.on('market:created', (market) => {
    logger.info('New market created', { marketId: market.id, venue: market.venue });
  });

  ingestionService.on('market:updated', (market) => {
    logger.debug('Market updated', { marketId: market.id, venue: market.venue });
  });

  ingestionService.on('price:updated', (priceData) => {
    logger.debug('Price updated', { tokenId: priceData.tokenId });
  });

  ingestionService.on('error', (error, venue) => {
    logger.error('Ingestion error', { error: error.message, venue });
  });

  ingestionService.on('venue:connected', (venue) => {
    logger.info('Venue connected', { venue });
  });

  ingestionService.on('venue:disconnected', (venue) => {
    logger.warn('Venue disconnected', { venue });
  });

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    try {
      await ingestionService.stop();
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Health check endpoint
  if (process.env.ENABLE_HEALTH_CHECK === 'true') {
    const healthCheckPort = parseInt(process.env.HEALTH_CHECK_PORT || '3002');
    
    // Simple HTTP server for health checks
    const http = await import('http');
    const server = http.createServer(async (req, res) => {
      if (req.url === '/health') {
        try {
          const health = await ingestionService.healthCheck();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(health));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Health check failed' }));
        }
      } else if (req.url === '/stats') {
        try {
          const stats = await ingestionService.getStats();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(stats));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Stats check failed' }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    server.listen(healthCheckPort, () => {
      logger.info(`Health check server listening on port ${healthCheckPort}`);
    });
  }

  try {
    await ingestionService.start();
    logger.info('Data ingestion service started successfully');
  } catch (error) {
    logger.error('Failed to start data ingestion service', error);
    process.exit(1);
  }
}

// Start the service
main().catch((error) => {
  logger.error('Unhandled error in main', error);
  process.exit(1);
});
