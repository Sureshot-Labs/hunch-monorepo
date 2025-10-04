// Price history service for storing and retrieving historical price data
import { EventEmitter } from 'events';
import { logger } from '@hunch/shared';
import { 
  UnifiedPriceData, 
  ChartData, 
  ChartDataPoint,
  UnifiedTokenId 
} from '@hunch/shared';
import { Pool } from 'pg';

// Price history events
export interface PriceHistoryEvents {
  'price:recorded': (priceData: UnifiedPriceData) => void;
  'aggregation:completed': (tokenId: string, resolution: string) => void;
  'error': (error: Error, context: string) => void;
}

// Resolution types
export type Resolution = '1m' | '5m' | '1h' | '1d' | '1w' | '1M';

// Price history configuration
export interface PriceHistoryConfig {
  databaseUrl: string;
  enableAggregation: boolean;
  aggregationInterval: number; // milliseconds
  retentionDays: number;
  compressionDays: number;
}

export class PriceHistoryService extends EventEmitter {
  private pool: Pool;
  private config: PriceHistoryConfig;
  private aggregationTimer?: NodeJS.Timeout;
  private isRunning: boolean = false;

  constructor(config: PriceHistoryConfig) {
    super();
    this.config = config;
    this.pool = new Pool({ connectionString: config.databaseUrl });
    this.setupEventHandlers();
  }

  // Start the price history service
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Price history service is already running');
      return;
    }

    try {
      logger.info('Starting price history service');

      // Test database connection
      await this.pool.query('SELECT 1');

      // Start aggregation if enabled
      if (this.config.enableAggregation) {
        this.startAggregation();
      }

      this.isRunning = true;

      logger.info('Price history service started successfully');
    } catch (error) {
      logger.error('Failed to start price history service', error);
      throw error;
    }
  }

  // Stop the price history service
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Price history service is not running');
      return;
    }

    try {
      logger.info('Stopping price history service');

      // Stop aggregation timer
      if (this.aggregationTimer) {
        clearInterval(this.aggregationTimer);
      }

      // Close database connection
      await this.pool.end();

      this.isRunning = false;

      logger.info('Price history service stopped successfully');
    } catch (error) {
      logger.error('Error stopping price history service', error);
    }
  }

  // Record price data
  public async recordPriceData(priceData: UnifiedPriceData): Promise<void> {
    try {
      const query = `
        INSERT INTO price_history (
          token_id, timestamp, open_price, high_price, low_price, close_price,
          volume_usd, trade_count, best_bid, best_ask, spread, resolution
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (token_id, timestamp, resolution) 
        DO UPDATE SET
          open_price = EXCLUDED.open_price,
          high_price = EXCLUDED.high_price,
          low_price = EXCLUDED.low_price,
          close_price = EXCLUDED.close_price,
          volume_usd = EXCLUDED.volume_usd,
          trade_count = EXCLUDED.trade_count,
          best_bid = EXCLUDED.best_bid,
          best_ask = EXCLUDED.best_ask,
          spread = EXCLUDED.spread
      `;

      await this.pool.query(query, [
        priceData.tokenId,
        priceData.timestamp,
        priceData.open,
        priceData.high,
        priceData.low,
        priceData.close,
        priceData.volumeUsd,
        priceData.tradeCount,
        priceData.bestBid,
        priceData.bestAsk,
        priceData.spread,
        priceData.resolution,
      ]);

      this.emit('price:recorded', priceData);

      logger.debug('Price data recorded', {
        tokenId: priceData.tokenId,
        timestamp: priceData.timestamp,
        resolution: priceData.resolution,
      });
    } catch (error) {
      logger.error('Failed to record price data', { error, priceData });
      this.emit('error', error as Error, 'recordPriceData');
      throw error;
    }
  }

  // Get price history for charting
  public async getChartData(
    tokenId: UnifiedTokenId,
    resolution: Resolution,
    startTime: Date,
    endTime: Date
  ): Promise<ChartData> {
    try {
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
          AND timestamp >= $3 
          AND timestamp <= $4
        ORDER BY timestamp ASC
      `;

      const result = await this.pool.query(query, [
        tokenId,
        resolution,
        startTime,
        endTime,
      ]);

      const dataPoints: ChartDataPoint[] = result.rows.map(row => ({
        timestamp: row.timestamp,
        open: parseFloat(row.open),
        high: parseFloat(row.high),
        low: parseFloat(row.low),
        close: parseFloat(row.close),
        volume: parseFloat(row.volume),
      }));

      const totalVolume = dataPoints.reduce((sum, point) => sum + point.volume, 0);

      const chartData: ChartData = {
        tokenId,
        resolution,
        data: dataPoints,
        metadata: {
          startTime,
          endTime,
          dataPoints: dataPoints.length,
          totalVolume,
        },
      };

      logger.debug('Chart data retrieved', {
        tokenId,
        resolution,
        dataPoints: dataPoints.length,
        totalVolume,
      });

      return chartData;
    } catch (error) {
      logger.error('Failed to get chart data', { error, tokenId, resolution });
      this.emit('error', error as Error, 'getChartData');
      throw error;
    }
  }

  // Get latest price for a token
  public async getLatestPrice(tokenId: UnifiedTokenId): Promise<UnifiedPriceData | null> {
    try {
      const query = `
        SELECT 
          token_id, timestamp, open_price, high_price, low_price, close_price,
          volume_usd, trade_count, best_bid, best_ask, spread, resolution
        FROM price_history
        WHERE token_id = $1
        ORDER BY timestamp DESC
        LIMIT 1
      `;

      const result = await this.pool.query(query, [tokenId]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      const priceData: UnifiedPriceData = {
        tokenId: row.token_id,
        timestamp: row.timestamp,
        open: parseFloat(row.open_price),
        high: parseFloat(row.high_price),
        low: parseFloat(row.low_price),
        close: parseFloat(row.close_price),
        volumeUsd: parseFloat(row.volume_usd),
        tradeCount: parseInt(row.trade_count),
        bestBid: row.best_bid ? parseFloat(row.best_bid) : undefined,
        bestAsk: row.best_ask ? parseFloat(row.best_ask) : undefined,
        spread: row.spread ? parseFloat(row.spread) : undefined,
        resolution: row.resolution,
      };

      return priceData;
    } catch (error) {
      logger.error('Failed to get latest price', { error, tokenId });
      this.emit('error', error as Error, 'getLatestPrice');
      throw error;
    }
  }

  // Get price statistics for a token
  public async getPriceStatistics(
    tokenId: UnifiedTokenId,
    resolution: Resolution,
    startTime: Date,
    endTime: Date
  ): Promise<{
    min: number;
    max: number;
    avg: number;
    totalVolume: number;
    priceChange: number;
    priceChangePercent: number;
  }> {
    try {
      const query = `
        SELECT 
          MIN(low_price) as min_price,
          MAX(high_price) as max_price,
          AVG(close_price) as avg_price,
          SUM(volume_usd) as total_volume,
          FIRST_VALUE(close_price) OVER (ORDER BY timestamp ASC) as first_price,
          LAST_VALUE(close_price) OVER (ORDER BY timestamp RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_price
        FROM price_history
        WHERE token_id = $1 
          AND resolution = $2
          AND timestamp >= $3 
          AND timestamp <= $4
      `;

      const result = await this.pool.query(query, [
        tokenId,
        resolution,
        startTime,
        endTime,
      ]);

      if (result.rows.length === 0) {
        throw new Error('No price data found for the given parameters');
      }

      const row = result.rows[0];
      const firstPrice = parseFloat(row.first_price);
      const lastPrice = parseFloat(row.last_price);
      const priceChange = lastPrice - firstPrice;
      const priceChangePercent = firstPrice > 0 ? (priceChange / firstPrice) * 100 : 0;

      return {
        min: parseFloat(row.min_price),
        max: parseFloat(row.max_price),
        avg: parseFloat(row.avg_price),
        totalVolume: parseFloat(row.total_volume),
        priceChange,
        priceChangePercent,
      };
    } catch (error) {
      logger.error('Failed to get price statistics', { error, tokenId, resolution });
      this.emit('error', error as Error, 'getPriceStatistics');
      throw error;
    }
  }

  // Start aggregation process
  private startAggregation(): void {
    this.aggregationTimer = setInterval(async () => {
      try {
        await this.runAggregation();
      } catch (error) {
        logger.error('Aggregation failed', error);
        this.emit('error', error as Error, 'aggregation');
      }
    }, this.config.aggregationInterval);

    logger.info('Price aggregation started', {
      interval: this.config.aggregationInterval,
    });
  }

  // Run aggregation for all resolutions
  private async runAggregation(): Promise<void> {
    try {
      logger.debug('Running price aggregation');

      // Get all unique tokens
      const tokenResult = await this.pool.query(`
        SELECT DISTINCT token_id FROM price_history 
        WHERE timestamp >= NOW() - INTERVAL '1 hour'
      `);

      const tokens = tokenResult.rows.map(row => row.token_id);

      // Run aggregation for each token and resolution
      for (const tokenId of tokens) {
        await this.aggregateToken(tokenId, '5m');
        await this.aggregateToken(tokenId, '1h');
        await this.aggregateToken(tokenId, '1d');
      }

      logger.debug('Price aggregation completed', { tokensCount: tokens.length });
    } catch (error) {
      logger.error('Failed to run aggregation', error);
      throw error;
    }
  }

  // Aggregate price data for a specific token and resolution
  private async aggregateToken(tokenId: string, resolution: Resolution): Promise<void> {
    try {
      const intervalMap = {
        '5m': '5 minutes',
        '1h': '1 hour',
        '1d': '1 day',
      };

      const interval = intervalMap[resolution];
      if (!interval) {
        logger.warn(`Unsupported resolution for aggregation: ${resolution}`);
        return;
      }

      const query = `
        INSERT INTO price_history (
          token_id, timestamp, open_price, high_price, low_price, close_price,
          volume_usd, trade_count, best_bid, best_ask, spread, resolution
        )
        SELECT 
          token_id,
          time_bucket('${interval}', timestamp) as bucket,
          first(open_price, timestamp) as open_price,
          max(high_price) as high_price,
          min(low_price) as low_price,
          last(close_price, timestamp) as close_price,
          sum(volume_usd) as volume_usd,
          sum(trade_count) as trade_count,
          avg(best_bid) as best_bid,
          avg(best_ask) as best_ask,
          avg(spread) as spread,
          '${resolution}' as resolution
        FROM price_history
        WHERE token_id = $1 
          AND resolution = '1m'
          AND timestamp >= NOW() - INTERVAL '24 hours'
        GROUP BY token_id, bucket
        ON CONFLICT (token_id, timestamp, resolution) 
        DO UPDATE SET
          open_price = EXCLUDED.open_price,
          high_price = EXCLUDED.high_price,
          low_price = EXCLUDED.low_price,
          close_price = EXCLUDED.close_price,
          volume_usd = EXCLUDED.volume_usd,
          trade_count = EXCLUDED.trade_count,
          best_bid = EXCLUDED.best_bid,
          best_ask = EXCLUDED.best_ask,
          spread = EXCLUDED.spread
      `;

      await this.pool.query(query, [tokenId]);

      this.emit('aggregation:completed', tokenId, resolution);

      logger.debug('Token aggregation completed', { tokenId, resolution });
    } catch (error) {
      logger.error('Failed to aggregate token', { error, tokenId, resolution });
      throw error;
    }
  }

  // Clean up old data based on retention policy
  public async cleanupOldData(): Promise<void> {
    try {
      const query = `
        DELETE FROM price_history 
        WHERE timestamp < NOW() - INTERVAL '${this.config.retentionDays} days'
      `;

      const result = await this.pool.query(query);

      logger.info('Old price data cleaned up', {
        deletedRows: result.rowCount,
        retentionDays: this.config.retentionDays,
      });
    } catch (error) {
      logger.error('Failed to cleanup old data', error);
      this.emit('error', error as Error, 'cleanupOldData');
      throw error;
    }
  }

  // Setup event handlers
  private setupEventHandlers(): void {
    this.on('price:recorded', (priceData) => {
      logger.debug('Price data recorded event', {
        tokenId: priceData.tokenId,
        resolution: priceData.resolution,
      });
    });

    this.on('aggregation:completed', (tokenId, resolution) => {
      logger.debug('Aggregation completed event', { tokenId, resolution });
    });

    this.on('error', (error, context) => {
      logger.error('Price history service error', {
        error: error.message,
        context,
      });
    });
  }

  // Get service statistics
  public async getStats(): Promise<{
    isRunning: boolean;
    totalRecords: number;
    uniqueTokens: number;
    oldestRecord?: Date;
    newestRecord?: Date;
  }> {
    try {
      const statsQuery = `
        SELECT 
          COUNT(*) as total_records,
          COUNT(DISTINCT token_id) as unique_tokens,
          MIN(timestamp) as oldest_record,
          MAX(timestamp) as newest_record
        FROM price_history
      `;

      const result = await this.pool.query(statsQuery);
      const row = result.rows[0];

      return {
        isRunning: this.isRunning,
        totalRecords: parseInt(row.total_records),
        uniqueTokens: parseInt(row.unique_tokens),
        oldestRecord: row.oldest_record,
        newestRecord: row.newest_record,
      };
    } catch (error) {
      logger.error('Failed to get service statistics', error);
      throw error;
    }
  }

  // Health check
  public async healthCheck(): Promise<{ status: string; database: boolean }> {
    try {
      await this.pool.query('SELECT 1');
      return {
        status: this.isRunning ? 'healthy' : 'stopped',
        database: true,
      };
    } catch (error) {
      logger.error('Health check failed', error);
      return {
        status: 'unhealthy',
        database: false,
      };
    }
  }
}
