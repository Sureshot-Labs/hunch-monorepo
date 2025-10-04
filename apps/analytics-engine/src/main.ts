// Main entry point for analytics engine service
import { MarketAnalysisService } from './services/market-analysis';
import { logger } from '@hunch/shared';
import { config } from 'dotenv';
import { resolve } from 'path';
import Fastify from 'fastify';
import { Pool } from 'pg';

// Load environment variables
config({ path: resolve(process.cwd(), '../../.env'), override: true });

// Configuration
const analyticsConfig = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://hunch:hunch@localhost:5432/hunch',
  port: parseInt(process.env.ANALYTICS_PORT || '3005'),
  enableHealthCheck: process.env.ENABLE_HEALTH_CHECK === 'true',
  healthCheckPort: parseInt(process.env.ANALYTICS_HEALTH_PORT || '3006'),
};

// Create Fastify app
const app = Fastify({ logger: true });

// Create database connection
const pool = new Pool({ connectionString: analyticsConfig.databaseUrl });

// Create analytics service
const analyticsService = new MarketAnalysisService(pool);

// Setup event handlers
analyticsService.on('analysis:completed', (analysis) => {
  logger.info('Market analysis completed', { 
    tokenId: analysis.tokenId,
    overallSignal: analysis.technicalSignals.overallSignal,
    signalStrength: analysis.technicalSignals.signalStrength
  });
});

analyticsService.on('signal:generated', (tokenId, signal) => {
  logger.info('Technical signal generated', { 
    tokenId, 
    signal: signal.overallSignal,
    strength: signal.signalStrength
  });
});

analyticsService.on('recommendation:updated', (tokenId, recommendations) => {
  logger.info('Trading recommendations updated', { 
    tokenId, 
    recommendationsCount: recommendations.length,
    actions: recommendations.map(r => r.action)
  });
});

analyticsService.on('error', (error, context) => {
  logger.error('Analytics service error', { error: error.message, context });
});

// API Routes
app.get('/health', async () => {
  try {
    await pool.query('SELECT 1');
    return {
      status: 'healthy',
      database: true,
      service: 'analytics-engine',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      database: false,
      service: 'analytics-engine',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    };
  }
});

app.get('/stats', async () => {
  try {
    const stats = analyticsService.getStats();
    return {
      service: 'analytics-engine',
      stats,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    };
  }
});

// Analyze market endpoint
app.get('/analyze/:tokenId', async (request, reply) => {
  try {
    const { tokenId } = request.params as { tokenId: string };
    const { timeframe } = request.query as { timeframe?: string };

    const analysis = await analyticsService.analyzeMarket(
      tokenId as any,
      (timeframe as any) || '1d'
    );

    return {
      success: true,
      data: analysis,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Market analysis failed', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Analysis failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Get technical indicators endpoint
app.get('/indicators/:tokenId', async (request, reply) => {
  try {
    const { tokenId } = request.params as { tokenId: string };
    const { timeframe, period } = request.query as { 
      timeframe?: string; 
      period?: string;
    };

    // Get price data
    const query = `
      SELECT 
        timestamp,
        open_price as open,
        high_price as high,
        low_price as low,
        close_price as close,
        volume_usd as volume
      FROM price_history
      WHERE token_id = $1 
        AND resolution = $2
        AND timestamp >= NOW() - INTERVAL '90 days'
      ORDER BY timestamp ASC
    `;

    const result = await pool.query(query, [tokenId, timeframe || '1d']);
    const data = result.rows.map(row => ({
      timestamp: row.timestamp,
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume),
    }));

    if (data.length < 20) {
      return reply.code(400).send({
        success: false,
        error: 'Insufficient data for technical analysis',
        timestamp: new Date().toISOString()
      });
    }

    // Calculate technical indicators
    const { TechnicalIndicators } = await import('./services/technical-indicators');
    const indicators = new TechnicalIndicators(data);
    const allIndicators = indicators.getAllIndicators();

    return {
      success: true,
      data: {
        tokenId,
        timeframe: timeframe || '1d',
        dataPoints: data.length,
        indicators: allIndicators,
        lastUpdate: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Technical indicators calculation failed', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Indicators calculation failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Get trading signals endpoint
app.get('/signals/:tokenId', async (request, reply) => {
  try {
    const { tokenId } = request.params as { tokenId: string };
    const { timeframe } = request.query as { timeframe?: string };

    const analysis = await analyticsService.analyzeMarket(
      tokenId as any,
      (timeframe as any) || '1d'
    );

    return {
      success: true,
      data: {
        tokenId,
        timeframe: timeframe || '1d',
        signals: analysis.technicalSignals,
        recommendations: analysis.recommendations,
        timestamp: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Trading signals generation failed', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Signals generation failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Get market sentiment endpoint
app.get('/sentiment/:tokenId', async (request, reply) => {
  try {
    const { tokenId } = request.params as { tokenId: string };
    const { timeframe } = request.query as { timeframe?: string };

    const analysis = await analyticsService.analyzeMarket(
      tokenId as any,
      (timeframe as any) || '1d'
    );

    return {
      success: true,
      data: {
        tokenId,
        timeframe: timeframe || '1d',
        sentiment: analysis.marketSentiment,
        timestamp: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Market sentiment analysis failed', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Sentiment analysis failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Get risk metrics endpoint
app.get('/risk/:tokenId', async (request, reply) => {
  try {
    const { tokenId } = request.params as { tokenId: string };
    const { timeframe } = request.query as { timeframe?: string };

    const analysis = await analyticsService.analyzeMarket(
      tokenId as any,
      (timeframe as any) || '1d'
    );

    return {
      success: true,
      data: {
        tokenId,
        timeframe: timeframe || '1d',
        riskMetrics: analysis.riskMetrics,
        timestamp: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Risk metrics calculation failed', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Risk metrics calculation failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Get cached analysis endpoint
app.get('/cache/:tokenId', async (request, reply) => {
  try {
    const { tokenId } = request.params as { tokenId: string };
    const { timeframe } = request.query as { timeframe?: string };

    const cachedAnalysis = analyticsService.getCachedAnalysis(
      tokenId as any,
      timeframe || '1d'
    );

    if (!cachedAnalysis) {
      return reply.code(404).send({
        success: false,
        error: 'No cached analysis found',
        timestamp: new Date().toISOString()
      });
    }

    return {
      success: true,
      data: cachedAnalysis,
      cached: true,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Cache retrieval failed', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Cache retrieval failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Clear cache endpoint
app.post('/cache/clear', async (request, reply) => {
  try {
    analyticsService.clearCache();
    return {
      success: true,
      message: 'Cache cleared successfully',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Cache clear failed', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Cache clear failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Batch analysis endpoint
app.post('/analyze/batch', async (request, reply) => {
  try {
    const { tokenIds, timeframe } = request.body as {
      tokenIds: string[];
      timeframe?: string;
    };

    if (!tokenIds || !Array.isArray(tokenIds) || tokenIds.length === 0) {
      return reply.code(400).send({
        success: false,
        error: 'tokenIds array is required',
        timestamp: new Date().toISOString()
      });
    }

    const analyses = await Promise.allSettled(
      tokenIds.map(tokenId => 
        analyticsService.analyzeMarket(tokenId as any, timeframe || '1d')
      )
    );

    const results = analyses.map((result, index) => ({
      tokenId: tokenIds[index],
      success: result.status === 'fulfilled',
      data: result.status === 'fulfilled' ? result.value : null,
      error: result.status === 'rejected' ? result.reason.message : null
    }));

    return {
      success: true,
      data: {
        total: tokenIds.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Batch analysis failed', error);
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Batch analysis failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Graceful shutdown handling
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down gracefully`);
  try {
    await pool.end();
    await app.close();
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', error);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Health check endpoint
if (analyticsConfig.enableHealthCheck) {
  const healthCheckPort = analyticsConfig.healthCheckPort;
  
  // Simple HTTP server for health checks
  const http = await import('http');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      try {
        await pool.query('SELECT 1');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'healthy',
          database: true,
          service: 'analytics-engine',
          timestamp: new Date().toISOString()
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'unhealthy',
          database: false,
          service: 'analytics-engine',
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }));
      }
    } else if (req.url === '/stats') {
      try {
        const stats = analyticsService.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: 'analytics-engine',
          stats,
          timestamp: new Date().toISOString()
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : 'Stats check failed',
          timestamp: new Date().toISOString()
        }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(healthCheckPort, () => {
    logger.info(`Analytics engine health check server listening on port ${healthCheckPort}`);
  });
}

try {
  // Start Fastify server
  await app.listen({ port: analyticsConfig.port, host: '0.0.0.0' });

  logger.info(`Analytics engine started successfully on port ${analyticsConfig.port}`);
} catch (error) {
  logger.error('Failed to start analytics engine', error);
  process.exit(1);
}
