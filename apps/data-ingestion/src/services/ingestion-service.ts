// Enhanced data ingestion service with unified processing
import { EventEmitter } from 'events';
import { Redis } from 'ioredis';
import { logger } from '@hunch/shared';
import { 
  UnifiedMarket, 
  UnifiedEvent, 
  UnifiedPriceData, 
  Venue,
  MapperFactory 
} from '@hunch/shared';

// Queue configuration
interface QueueConfig {
  concurrency: number;
  interval: number;
  intervalCap: number;
  retryAttempts: number;
  retryDelay: number;
}

// Ingestion service configuration
interface IngestionConfig {
  venues: Venue[];
  queueConfig: QueueConfig;
  redisUrl: string;
  enablePriceHistory: boolean;
  enableRealTimeUpdates: boolean;
}

// Data processing events
export interface IngestionEvents {
  'market:created': (market: UnifiedMarket) => void;
  'market:updated': (market: UnifiedMarket) => void;
  'price:updated': (priceData: UnifiedPriceData) => void;
  'error': (error: Error, venue: Venue) => void;
  'venue:connected': (venue: Venue) => void;
  'venue:disconnected': (venue: Venue) => void;
}

export class DataIngestionService extends EventEmitter {
  private redis: Redis;
  private config: IngestionConfig;
  private isRunning: boolean = false;
  private venueConnections: Map<Venue, any> = new Map();

  constructor(config: IngestionConfig) {
    super();
    this.config = config;
    this.redis = new Redis(config.redisUrl);
    this.setupRedisEventHandlers();
  }

  // Start the ingestion service
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Data ingestion service is already running');
      return;
    }

    logger.info('Starting data ingestion service', { venues: this.config.venues });
    this.isRunning = true;

    try {
      // Initialize venue connections
      for (const venue of this.config.venues) {
        await this.initializeVenueConnection(venue);
      }

      // Start processing queues
      await this.startQueueProcessing();

      logger.info('Data ingestion service started successfully');
    } catch (error) {
      logger.error('Failed to start data ingestion service', error);
      this.isRunning = false;
      throw error;
    }
  }

  // Stop the ingestion service
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Data ingestion service is not running');
      return;
    }

    logger.info('Stopping data ingestion service');
    this.isRunning = false;

    try {
      // Close venue connections
      for (const [venue, connection] of this.venueConnections) {
        await this.closeVenueConnection(venue, connection);
      }

      // Close Redis connection
      await this.redis.quit();

      logger.info('Data ingestion service stopped successfully');
    } catch (error) {
      logger.error('Error stopping data ingestion service', error);
    }
  }

  // Initialize connection for a specific venue
  private async initializeVenueConnection(venue: Venue): Promise<void> {
    try {
      logger.info(`Initializing connection for venue: ${venue}`);

      // Get venue-specific mapper
      const mapper = MapperFactory.getMapper(venue);

      // Create venue connection based on type
      let connection;
      switch (venue) {
        case 'polymarket':
          connection = await this.createPolymarketConnection(mapper);
          break;
        case 'kalshi':
          connection = await this.createKalshiConnection(mapper);
          break;
        case 'limitless':
          connection = await this.createLimitlessConnection(mapper);
          break;
        default:
          throw new Error(`Unsupported venue: ${venue}`);
      }

      this.venueConnections.set(venue, connection);
      this.emit('venue:connected', venue);

      logger.info(`Successfully connected to venue: ${venue}`);
    } catch (error) {
      logger.error(`Failed to connect to venue: ${venue}`, error);
      this.emit('error', error as Error, venue);
    }
  }

  // Create Polymarket connection
  private async createPolymarketConnection(mapper: any): Promise<any> {
    // This would integrate with existing Polymarket clients
    // For now, return a mock connection
    return {
      type: 'polymarket',
      mapper,
      isConnected: true,
      lastHeartbeat: new Date(),
    };
  }

  // Create Kalshi connection
  private async createKalshiConnection(mapper: any): Promise<any> {
    // This would integrate with existing Kalshi clients
    return {
      type: 'kalshi',
      mapper,
      isConnected: true,
      lastHeartbeat: new Date(),
    };
  }

  // Create Limitless connection
  private async createLimitlessConnection(mapper: any): Promise<any> {
    // This would integrate with existing Limitless clients
    return {
      type: 'limitless',
      mapper,
      isConnected: true,
      lastHeartbeat: new Date(),
    };
  }

  // Close venue connection
  private async closeVenueConnection(venue: Venue, connection: any): Promise<void> {
    try {
      logger.info(`Closing connection for venue: ${venue}`);
      
      // Close connection-specific resources
      if (connection.close) {
        await connection.close();
      }

      this.venueConnections.delete(venue);
      this.emit('venue:disconnected', venue);

      logger.info(`Successfully closed connection for venue: ${venue}`);
    } catch (error) {
      logger.error(`Error closing connection for venue: ${venue}`, error);
    }
  }

  // Start processing queues
  private async startQueueProcessing(): Promise<void> {
    // Process market data queue
    setInterval(async () => {
      await this.processMarketDataQueue();
    }, this.config.queueConfig.interval);

    // Process price data queue
    if (this.config.enablePriceHistory) {
      setInterval(async () => {
        await this.processPriceDataQueue();
      }, this.config.queueConfig.interval);
    }

    logger.info('Queue processing started');
  }

  // Process market data from queue
  private async processMarketDataQueue(): Promise<void> {
    try {
      const queueKey = 'queue:market-data';
      const batchSize = this.config.queueConfig.intervalCap;

      // Get batch of market data from queue
      const marketData = await this.redis.lrange(queueKey, 0, batchSize - 1);
      
      if (marketData.length === 0) return;

      // Remove processed items from queue
      await this.redis.ltrim(queueKey, batchSize, -1);

      // Process each market data item
      for (const data of marketData) {
        try {
          const parsedData = JSON.parse(data);
          await this.processMarketData(parsedData);
        } catch (error) {
          logger.error('Error processing market data item', { error, data });
        }
      }

      logger.debug(`Processed ${marketData.length} market data items`);
    } catch (error) {
      logger.error('Error processing market data queue', error);
    }
  }

  // Process price data from queue
  private async processPriceDataQueue(): Promise<void> {
    try {
      const queueKey = 'queue:price-data';
      const batchSize = this.config.queueConfig.intervalCap;

      // Get batch of price data from queue
      const priceData = await this.redis.lrange(queueKey, 0, batchSize - 1);
      
      if (priceData.length === 0) return;

      // Remove processed items from queue
      await this.redis.ltrim(queueKey, batchSize, -1);

      // Process each price data item
      for (const data of priceData) {
        try {
          const parsedData = JSON.parse(data);
          await this.processPriceData(parsedData);
        } catch (error) {
          logger.error('Error processing price data item', { error, data });
        }
      }

      logger.debug(`Processed ${priceData.length} price data items`);
    } catch (error) {
      logger.error('Error processing price data queue', error);
    }
  }

  // Process individual market data
  private async processMarketData(data: any): Promise<void> {
    const { venue, rawData, type } = data;
    
    try {
      const mapper = MapperFactory.getMapper(venue);
      let unifiedData: UnifiedMarket | UnifiedEvent;

      if (type === 'market') {
        unifiedData = mapper.mapMarket(rawData, data.eventId);
        this.emit('market:updated', unifiedData as UnifiedMarket);
      } else if (type === 'event') {
        unifiedData = mapper.mapEvent(rawData);
        this.emit('market:created', unifiedData as any); // Events contain markets
      }

      // Store in database (this would be handled by a separate service)
      await this.storeMarketData(unifiedData);

      logger.debug(`Processed ${type} data for venue: ${venue}`);
    } catch (error) {
      logger.error(`Error processing market data for venue: ${venue}`, error);
      this.emit('error', error as Error, venue);
    }
  }

  // Process individual price data
  private async processPriceData(data: any): Promise<void> {
    const { venue, rawData } = data;
    
    try {
      const mapper = MapperFactory.getMapper(venue);
      const unifiedPriceData = mapper.mapPriceData(rawData);

      this.emit('price:updated', unifiedPriceData);

      // Store in database
      await this.storePriceData(unifiedPriceData);

      logger.debug(`Processed price data for venue: ${venue}`);
    } catch (error) {
      logger.error(`Error processing price data for venue: ${venue}`, error);
      this.emit('error', error as Error, venue);
    }
  }

  // Store market data in database
  private async storeMarketData(data: UnifiedMarket | UnifiedEvent): Promise<void> {
    // This would integrate with the database service
    // For now, just log the action
    logger.debug('Storing market data in database', { 
      type: 'market' in data ? 'market' : 'event',
      id: data.id,
      venue: data.venue 
    });
  }

  // Store price data in database
  private async storePriceData(data: UnifiedPriceData): Promise<void> {
    // This would integrate with the database service
    logger.debug('Storing price data in database', { 
      tokenId: data.tokenId,
      timestamp: data.timestamp 
    });
  }

  // Setup Redis event handlers
  private setupRedisEventHandlers(): void {
    this.redis.on('error', (error) => {
      logger.error('Redis connection error', error);
    });

    this.redis.on('connect', () => {
      logger.info('Redis connected');
    });

    this.redis.on('disconnect', () => {
      logger.warn('Redis disconnected');
    });
  }

  // Health check
  public async healthCheck(): Promise<{ status: string; venues: any }> {
    const venueStatus: any = {};
    
    for (const [venue, connection] of this.venueConnections) {
      venueStatus[venue] = {
        connected: connection.isConnected,
        lastHeartbeat: connection.lastHeartbeat,
      };
    }

    return {
      status: this.isRunning ? 'healthy' : 'stopped',
      venues: venueStatus,
    };
  }

  // Get service statistics
  public async getStats(): Promise<any> {
    const queueLengths = await Promise.all([
      this.redis.llen('queue:market-data'),
      this.redis.llen('queue:price-data'),
    ]);

    return {
      isRunning: this.isRunning,
      connectedVenues: this.venueConnections.size,
      queueLengths: {
        marketData: queueLengths[0],
        priceData: queueLengths[1],
      },
    };
  }
}
