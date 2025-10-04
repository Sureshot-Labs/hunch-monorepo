// Main entry point for trading engine service
import { TradingEngine } from './services/trading-engine';
import { logger } from '@hunch/shared';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables
config({ path: resolve(process.cwd(), '../../.env'), override: true });

// Default risk parameters
const defaultRiskParameters = {
  // Position limits
  maxPositionSizeUsd: 10000,
  maxPositionSizePerToken: 5000,
  maxTotalExposureUsd: 50000,
  
  // Order limits
  maxOrderSizeUsd: 1000,
  maxOrdersPerMinute: 10,
  maxOrdersPerHour: 100,
  maxOrdersPerDay: 1000,
  
  // Loss limits
  maxDailyLossUsd: 1000,
  maxTotalLossUsd: 5000,
  stopLossPercentage: 10,
  
  // Concentration limits
  maxConcentrationPerToken: 20, // 20% of total portfolio
  maxConcentrationPerCategory: 30, // 30% of total portfolio
  
  // Time-based limits
  tradingHoursStart: 0, // 24/7 trading
  tradingHoursEnd: 23,
  tradingDays: [0, 1, 2, 3, 4, 5, 6], // All days
};

// Create and start the trading engine
async function main() {
  const tradingEngine = new TradingEngine(defaultRiskParameters);

  // Setup event handlers
  tradingEngine.on('order:created', (order) => {
    logger.info('Order created', { 
      orderId: order.id, 
      userId: order.userId, 
      venue: order.venue,
      side: order.side,
      size: order.sizeUsd 
    });
  });

  tradingEngine.on('order:executed', (order, trades) => {
    logger.info('Order executed', { 
      orderId: order.id, 
      tradesCount: trades.length,
      totalSize: trades.reduce((sum, trade) => sum + trade.sizeUsd, 0)
    });
  });

  tradingEngine.on('order:cancelled', (order) => {
    logger.info('Order cancelled', { orderId: order.id });
  });

  tradingEngine.on('position:updated', (position) => {
    logger.debug('Position updated', { 
      positionId: position.id,
      userId: position.userId,
      quantity: position.quantity,
      unrealizedPnl: position.unrealizedPnlUsd
    });
  });

  tradingEngine.on('risk:violation', (violation, userId) => {
    logger.warn('Risk violation detected', { 
      violation, 
      userId,
      severity: violation.severity 
    });
  });

  tradingEngine.on('error', (error, context) => {
    logger.error('Trading engine error', { 
      error: error.message, 
      context,
      stack: error.stack 
    });
  });

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    try {
      await tradingEngine.stop();
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
    const healthCheckPort = parseInt(process.env.HEALTH_CHECK_PORT || '3003');
    
    // Simple HTTP server for health checks
    const http = await import('http');
    const server = http.createServer(async (req, res) => {
      if (req.url === '/health') {
        try {
          const health = tradingEngine.healthCheck();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(health));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Health check failed' }));
        }
      } else if (req.url === '/stats') {
        try {
          const stats = tradingEngine.getStats();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(stats));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Stats check failed' }));
        }
      } else if (req.url === '/risk-parameters') {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(defaultRiskParameters));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to get risk parameters' }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    server.listen(healthCheckPort, () => {
      logger.info(`Trading engine health check server listening on port ${healthCheckPort}`);
    });
  }

  try {
    await tradingEngine.start();
    logger.info('Trading engine started successfully');
  } catch (error) {
    logger.error('Failed to start trading engine', error);
    process.exit(1);
  }
}

// Start the service
main().catch((error) => {
  logger.error('Unhandled error in main', error);
  process.exit(1);
});
