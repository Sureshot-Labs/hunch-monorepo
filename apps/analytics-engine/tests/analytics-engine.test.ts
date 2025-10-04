// Analytics engine comprehensive test suite
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { 
  TestUtils, 
  TestEnvironment, 
  setupGlobalTestEnvironment, 
  teardownGlobalTestEnvironment,
  TestDataFactory 
} from '@hunch/testing';
import { MarketAnalysisService } from '../src/services/market-analysis';
import { TechnicalIndicators } from '../src/services/technical-indicators';
import { ChartDataPoint } from '@hunch/shared';

describe('Analytics Engine', () => {
  let testEnvironment: TestEnvironment;
  let testUtils: TestUtils;
  let analyticsService: MarketAnalysisService;

  beforeAll(async () => {
    testEnvironment = await setupGlobalTestEnvironment();
    testUtils = new TestUtils(testEnvironment.getPool(), testEnvironment.getRedisClient());
    await testUtils.connect();
  });

  afterAll(async () => {
    await testUtils.disconnect();
    await teardownGlobalTestEnvironment();
  });

  beforeEach(async () => {
    await testUtils.clearAll();
    analyticsService = new MarketAnalysisService(testEnvironment.getPool());
  });

  afterEach(async () => {
    await testUtils.clearAll();
  });

  describe('Technical Indicators', () => {
    let testData: ChartDataPoint[];

    beforeEach(() => {
      // Create test price data
      testData = [
        { timestamp: new Date('2024-01-01T00:00:00Z'), open: 0.50, high: 0.52, low: 0.48, close: 0.51, volume: 1000 },
        { timestamp: new Date('2024-01-01T00:01:00Z'), open: 0.51, high: 0.53, low: 0.49, close: 0.52, volume: 1200 },
        { timestamp: new Date('2024-01-01T00:02:00Z'), open: 0.52, high: 0.54, low: 0.50, close: 0.53, volume: 1100 },
        { timestamp: new Date('2024-01-01T00:03:00Z'), open: 0.53, high: 0.55, low: 0.51, close: 0.54, volume: 1300 },
        { timestamp: new Date('2024-01-01T00:04:00Z'), open: 0.54, high: 0.56, low: 0.52, close: 0.55, volume: 1400 },
        { timestamp: new Date('2024-01-01T00:05:00Z'), open: 0.55, high: 0.57, low: 0.53, close: 0.56, volume: 1500 },
        { timestamp: new Date('2024-01-01T00:06:00Z'), open: 0.56, high: 0.58, low: 0.54, close: 0.57, volume: 1600 },
        { timestamp: new Date('2024-01-01T00:07:00Z'), open: 0.57, high: 0.59, low: 0.55, close: 0.58, volume: 1700 },
        { timestamp: new Date('2024-01-01T00:08:00Z'), open: 0.58, high: 0.60, low: 0.56, close: 0.59, volume: 1800 },
        { timestamp: new Date('2024-01-01T00:09:00Z'), open: 0.59, high: 0.61, low: 0.57, close: 0.60, volume: 1900 },
        { timestamp: new Date('2024-01-01T00:10:00Z'), open: 0.60, high: 0.62, low: 0.58, close: 0.61, volume: 2000 },
        { timestamp: new Date('2024-01-01T00:11:00Z'), open: 0.61, high: 0.63, low: 0.59, close: 0.62, volume: 2100 },
        { timestamp: new Date('2024-01-01T00:12:00Z'), open: 0.62, high: 0.64, low: 0.60, close: 0.63, volume: 2200 },
        { timestamp: new Date('2024-01-01T00:13:00Z'), open: 0.63, high: 0.65, low: 0.61, close: 0.64, volume: 2300 },
        { timestamp: new Date('2024-01-01T00:14:00Z'), open: 0.64, high: 0.66, low: 0.62, close: 0.65, volume: 2400 },
        { timestamp: new Date('2024-01-01T00:15:00Z'), open: 0.65, high: 0.67, low: 0.63, close: 0.66, volume: 2500 },
        { timestamp: new Date('2024-01-01T00:16:00Z'), open: 0.66, high: 0.68, low: 0.64, close: 0.67, volume: 2600 },
        { timestamp: new Date('2024-01-01T00:17:00Z'), open: 0.67, high: 0.69, low: 0.65, close: 0.68, volume: 2700 },
        { timestamp: new Date('2024-01-01T00:18:00Z'), open: 0.68, high: 0.70, low: 0.66, close: 0.69, volume: 2800 },
        { timestamp: new Date('2024-01-01T00:19:00Z'), open: 0.69, high: 0.71, low: 0.67, close: 0.70, volume: 2900 },
      ];
    });

    it('should calculate simple moving average', () => {
      // Arrange
      const indicators = new TechnicalIndicators(testData);

      // Act
      const sma = indicators.simpleMovingAverage(5);

      // Assert
      expect(sma).toBeDefined();
      expect(sma.length).toBe(testData.length - 4); // 5-period SMA
      expect(sma[0]).toBeCloseTo(0.52, 2); // First SMA value
      expect(sma[sma.length - 1]).toBeCloseTo(0.68, 2); // Last SMA value
    });

    it('should calculate exponential moving average', () => {
      // Arrange
      const indicators = new TechnicalIndicators(testData);

      // Act
      const ema = indicators.exponentialMovingAverage(5);

      // Assert
      expect(ema).toBeDefined();
      expect(ema.length).toBe(testData.length - 4); // 5-period EMA
      expect(ema[0]).toBeCloseTo(0.52, 2); // First EMA value (SMA)
      expect(ema[ema.length - 1]).toBeGreaterThan(ema[0]); // EMA should trend upward
    });

    it('should calculate weighted moving average', () => {
      // Arrange
      const indicators = new TechnicalIndicators(testData);

      // Act
      const wma = indicators.weightedMovingAverage(5);

      // Assert
      expect(wma).toBeDefined();
      expect(wma.length).toBe(testData.length - 4); // 5-period WMA
      expect(wma[0]).toBeCloseTo(0.52, 2); // First WMA value
      expect(wma[wma.length - 1]).toBeGreaterThan(wma[0]); // WMA should trend upward
    });

    it('should calculate RSI', () => {
      // Arrange
      const indicators = new TechnicalIndicators(testData);

      // Act
      const rsi = indicators.relativeStrengthIndex(14);

      // Assert
      expect(rsi.rsi).toBeDefined();
      expect(rsi.overbought).toBeDefined();
      expect(rsi.oversold).toBeDefined();
      expect(rsi.rsi.length).toBeGreaterThan(0);
      
      // RSI should be between 0 and 100
      rsi.rsi.forEach(value => {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      });
    });

    it('should calculate MACD', () => {
      // Arrange
      const indicators = new TechnicalIndicators(testData);

      // Act
      const macd = indicators.macd(12, 26, 9);

      // Assert
      expect(macd.macd).toBeDefined();
      expect(macd.signal).toBeDefined();
      expect(macd.histogram).toBeDefined();
      expect(macd.macd.length).toBeGreaterThan(0);
      expect(macd.signal.length).toBeGreaterThan(0);
      expect(macd.histogram.length).toBeGreaterThan(0);
    });

    it('should calculate Bollinger Bands', () => {
      // Arrange
      const indicators = new TechnicalIndicators(testData);

      // Act
      const bollinger = indicators.bollingerBands(20, 2);

      // Assert
      expect(bollinger.upper).toBeDefined();
      expect(bollinger.middle).toBeDefined();
      expect(bollinger.lower).toBeDefined();
      expect(bollinger.bandwidth).toBeDefined();
      expect(bollinger.percentB).toBeDefined();
      
      expect(bollinger.upper.length).toBeGreaterThan(0);
      expect(bollinger.middle.length).toBeGreaterThan(0);
      expect(bollinger.lower.length).toBeGreaterThan(0);
      
      // Upper band should be above middle, middle above lower
      for (let i = 0; i < bollinger.upper.length; i++) {
        expect(bollinger.upper[i]).toBeGreaterThan(bollinger.middle[i]);
        expect(bollinger.middle[i]).toBeGreaterThan(bollinger.lower[i]);
      }
    });

    it('should calculate Stochastic Oscillator', () => {
      // Arrange
      const indicators = new TechnicalIndicators(testData);

      // Act
      const stochastic = indicators.stochastic(14, 3);

      // Assert
      expect(stochastic.k).toBeDefined();
      expect(stochastic.d).toBeDefined();
      expect(stochastic.overbought).toBeDefined();
      expect(stochastic.oversold).toBeDefined();
      
      expect(stochastic.k.length).toBeGreaterThan(0);
      expect(stochastic.d.length).toBeGreaterThan(0);
      
      // %K and %D should be between 0 and 100
      stochastic.k.forEach(value => {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      });
    });

    it('should calculate volume indicators', () => {
      // Arrange
      const indicators = new TechnicalIndicators(testData);

      // Act
      const volumeIndicators = indicators.volumeIndicators(20);

      // Assert
      expect(volumeIndicators.obv).toBeDefined();
      expect(volumeIndicators.vwap).toBeDefined();
      expect(volumeIndicators.volumeSMA).toBeDefined();
      
      expect(volumeIndicators.obv.length).toBe(testData.length);
      expect(volumeIndicators.vwap.length).toBe(testData.length);
      expect(volumeIndicators.volumeSMA.length).toBe(testData.length - 19); // 20-period SMA
    });

    it('should calculate support and resistance levels', () => {
      // Arrange
      const indicators = new TechnicalIndicators(testData);

      // Act
      const supportResistance = indicators.supportResistance();

      // Assert
      expect(supportResistance.support).toBeDefined();
      expect(supportResistance.resistance).toBeDefined();
      expect(supportResistance.pivotPoints).toBeDefined();
      
      expect(supportResistance.pivotPoints.pivot).toBeGreaterThan(0);
      expect(supportResistance.pivotPoints.r1).toBeGreaterThan(supportResistance.pivotPoints.pivot);
      expect(supportResistance.pivotPoints.s1).toBeLessThan(supportResistance.pivotPoints.pivot);
    });

    it('should handle insufficient data gracefully', () => {
      // Arrange
      const shortData = testData.slice(0, 5); // Only 5 data points
      const indicators = new TechnicalIndicators(shortData);

      // Act
      const sma = indicators.simpleMovingAverage(10); // Request 10-period SMA

      // Assert
      expect(sma).toEqual([]); // Should return empty array
    });

    it('should calculate all indicators at once', () => {
      // Arrange
      const indicators = new TechnicalIndicators(testData);

      // Act
      const allIndicators = indicators.getAllIndicators();

      // Assert
      expect(allIndicators.movingAverages).toBeDefined();
      expect(allIndicators.rsi).toBeDefined();
      expect(allIndicators.macd).toBeDefined();
      expect(allIndicators.bollingerBands).toBeDefined();
      expect(allIndicators.stochastic).toBeDefined();
      expect(allIndicators.volumeIndicators).toBeDefined();
      expect(allIndicators.supportResistance).toBeDefined();
    });
  });

  describe('Market Analysis Service', () => {
    let user: any;
    let venueId: number;
    let eventId: string;
    let market: any;
    let tokens: any[];

    beforeEach(async () => {
      // Setup test data
      user = await testUtils.createTestUser();
      venueId = await testUtils.createTestVenue();
      eventId = await testUtils.createTestEvent(venueId);
      market = await testUtils.createTestMarket(eventId, venueId);
      tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      // Create price history
      await testUtils.createTestPriceHistory(tokens[0].tokenId, 50);
    });

    it('should analyze market successfully', async () => {
      // Act
      const analysis = await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');

      // Assert
      expect(analysis).toBeDefined();
      expect(analysis.tokenId).toBe(tokens[0].tokenId);
      expect(analysis.priceAnalysis).toBeDefined();
      expect(analysis.trendAnalysis).toBeDefined();
      expect(analysis.volatilityAnalysis).toBeDefined();
      expect(analysis.volumeAnalysis).toBeDefined();
      expect(analysis.technicalSignals).toBeDefined();
      expect(analysis.marketSentiment).toBeDefined();
      expect(analysis.riskMetrics).toBeDefined();
      expect(analysis.recommendations).toBeDefined();
    });

    it('should provide price analysis', async () => {
      // Act
      const analysis = await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');

      // Assert
      expect(analysis.priceAnalysis.currentPrice).toBeGreaterThan(0);
      expect(analysis.priceAnalysis.currentPrice).toBeLessThanOrEqual(1);
      expect(analysis.priceAnalysis.priceChange24h).toBeDefined();
      expect(analysis.priceAnalysis.priceChangePercent24h).toBeDefined();
      expect(analysis.priceAnalysis.allTimeHigh).toBeGreaterThan(0);
      expect(analysis.priceAnalysis.allTimeLow).toBeGreaterThan(0);
      expect(analysis.priceAnalysis.pricePosition).toBeGreaterThanOrEqual(0);
      expect(analysis.priceAnalysis.pricePosition).toBeLessThanOrEqual(1);
    });

    it('should provide trend analysis', async () => {
      // Act
      const analysis = await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');

      // Assert
      expect(['bullish', 'bearish', 'sideways']).toContain(analysis.trendAnalysis.shortTermTrend);
      expect(['bullish', 'bearish', 'sideways']).toContain(analysis.trendAnalysis.mediumTermTrend);
      expect(['bullish', 'bearish', 'sideways']).toContain(analysis.trendAnalysis.longTermTrend);
      expect(analysis.trendAnalysis.trendStrength).toBeGreaterThanOrEqual(0);
      expect(analysis.trendAnalysis.trendStrength).toBeLessThanOrEqual(1);
      expect(analysis.trendAnalysis.trendDuration).toBeGreaterThanOrEqual(0);
      expect(analysis.trendAnalysis.trendReversalRisk).toBeGreaterThanOrEqual(0);
      expect(analysis.trendAnalysis.trendReversalRisk).toBeLessThanOrEqual(1);
    });

    it('should provide volatility analysis', async () => {
      // Act
      const analysis = await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');

      // Assert
      expect(analysis.volatilityAnalysis.currentVolatility).toBeGreaterThanOrEqual(0);
      expect(analysis.volatilityAnalysis.volatilityPercentile).toBeGreaterThanOrEqual(0);
      expect(analysis.volatilityAnalysis.volatilityPercentile).toBeLessThanOrEqual(100);
      expect(['increasing', 'decreasing', 'stable']).toContain(analysis.volatilityAnalysis.volatilityTrend);
      expect(analysis.volatilityAnalysis.averageVolatility).toBeGreaterThanOrEqual(0);
      expect(analysis.volatilityAnalysis.maxVolatility).toBeGreaterThanOrEqual(0);
      expect(analysis.volatilityAnalysis.minVolatility).toBeGreaterThanOrEqual(0);
    });

    it('should provide volume analysis', async () => {
      // Act
      const analysis = await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');

      // Assert
      expect(analysis.volumeAnalysis.currentVolume).toBeGreaterThanOrEqual(0);
      expect(analysis.volumeAnalysis.volumeChange24h).toBeDefined();
      expect(analysis.volumeAnalysis.volumePercentile).toBeGreaterThanOrEqual(0);
      expect(analysis.volumeAnalysis.volumePercentile).toBeLessThanOrEqual(100);
      expect(['increasing', 'decreasing', 'stable']).toContain(analysis.volumeAnalysis.volumeTrend);
      expect(analysis.volumeAnalysis.averageVolume).toBeGreaterThanOrEqual(0);
      expect(analysis.volumeAnalysis.volumePriceCorrelation).toBeGreaterThanOrEqual(-1);
      expect(analysis.volumeAnalysis.volumePriceCorrelation).toBeLessThanOrEqual(1);
    });

    it('should provide technical signals', async () => {
      // Act
      const analysis = await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');

      // Assert
      expect(['overbought', 'oversold', 'neutral']).toContain(analysis.technicalSignals.rsiSignal);
      expect(['bullish', 'bearish', 'neutral']).toContain(analysis.technicalSignals.macdSignal);
      expect(['squeeze', 'expansion', 'neutral']).toContain(analysis.technicalSignals.bollingerSignal);
      expect(['overbought', 'oversold', 'neutral']).toContain(analysis.technicalSignals.stochasticSignal);
      expect(['bullish', 'bearish', 'neutral']).toContain(analysis.technicalSignals.movingAverageSignal);
      expect(['strong_buy', 'buy', 'hold', 'sell', 'strong_sell']).toContain(analysis.technicalSignals.overallSignal);
      expect(analysis.technicalSignals.signalStrength).toBeGreaterThanOrEqual(0);
      expect(analysis.technicalSignals.signalStrength).toBeLessThanOrEqual(1);
    });

    it('should provide market sentiment', async () => {
      // Act
      const analysis = await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');

      // Assert
      expect(analysis.marketSentiment.bullishPercent).toBeGreaterThanOrEqual(0);
      expect(analysis.marketSentiment.bullishPercent).toBeLessThanOrEqual(100);
      expect(analysis.marketSentiment.bearishPercent).toBeGreaterThanOrEqual(0);
      expect(analysis.marketSentiment.bearishPercent).toBeLessThanOrEqual(100);
      expect(analysis.marketSentiment.neutralPercent).toBeGreaterThanOrEqual(0);
      expect(analysis.marketSentiment.neutralPercent).toBeLessThanOrEqual(100);
      expect(analysis.marketSentiment.sentimentScore).toBeGreaterThanOrEqual(-1);
      expect(analysis.marketSentiment.sentimentScore).toBeLessThanOrEqual(1);
      expect(['improving', 'deteriorating', 'stable']).toContain(analysis.marketSentiment.sentimentTrend);
      expect(analysis.marketSentiment.fearGreedIndex).toBeGreaterThanOrEqual(0);
      expect(analysis.marketSentiment.fearGreedIndex).toBeLessThanOrEqual(100);
    });

    it('should provide risk metrics', async () => {
      // Act
      const analysis = await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');

      // Assert
      expect(analysis.riskMetrics.valueAtRisk95).toBeDefined();
      expect(analysis.riskMetrics.valueAtRisk99).toBeDefined();
      expect(analysis.riskMetrics.maximumDrawdown).toBeGreaterThanOrEqual(0);
      expect(analysis.riskMetrics.maximumDrawdown).toBeLessThanOrEqual(1);
      expect(analysis.riskMetrics.sharpeRatio).toBeDefined();
      expect(analysis.riskMetrics.beta).toBeDefined();
      expect(analysis.riskMetrics.correlationToMarket).toBeGreaterThanOrEqual(-1);
      expect(analysis.riskMetrics.correlationToMarket).toBeLessThanOrEqual(1);
    });

    it('should provide trading recommendations', async () => {
      // Act
      const analysis = await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');

      // Assert
      expect(Array.isArray(analysis.recommendations)).toBe(true);
      
      analysis.recommendations.forEach(recommendation => {
        expect(['buy', 'sell', 'hold']).toContain(recommendation.action);
        expect(recommendation.confidence).toBeGreaterThanOrEqual(0);
        expect(recommendation.confidence).toBeLessThanOrEqual(1);
        expect(Array.isArray(recommendation.reasoning)).toBe(true);
        expect(['short', 'medium', 'long']).toContain(recommendation.timeHorizon);
        expect(['low', 'medium', 'high']).toContain(recommendation.riskLevel);
      });
    });

    it('should cache analysis results', async () => {
      // Act
      const analysis1 = await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');
      const analysis2 = await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');

      // Assert
      expect(analysis1.tokenId).toBe(analysis2.tokenId);
      expect(analysis1.timestamp.getTime()).toBeLessThanOrEqual(analysis2.timestamp.getTime());
    });

    it('should handle insufficient data gracefully', async () => {
      // Arrange - Create token with no price history
      const emptyToken = 'polymarket:empty:YES' as any;

      // Act & Assert
      await expect(analyticsService.analyzeMarket(emptyToken, '1m')).rejects.toThrow();
    });

    it('should emit analysis completion events', async () => {
      // Arrange
      let eventEmitted = false;
      analyticsService.on('analysis:completed', () => {
        eventEmitted = true;
      });

      // Act
      await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');

      // Assert
      expect(eventEmitted).toBe(true);
    });

    it('should emit signal generation events', async () => {
      // Arrange
      let signalEmitted = false;
      analyticsService.on('signal:generated', () => {
        signalEmitted = true;
      });

      // Act
      await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');

      // Assert
      expect(signalEmitted).toBe(true);
    });

    it('should emit recommendation update events', async () => {
      // Arrange
      let recommendationEmitted = false;
      analyticsService.on('recommendation:updated', () => {
        recommendationEmitted = true;
      });

      // Act
      await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');

      // Assert
      expect(recommendationEmitted).toBe(true);
    });

    it('should provide service statistics', async () => {
      // Act
      const stats = analyticsService.getStats();

      // Assert
      expect(stats.cacheSize).toBeGreaterThanOrEqual(0);
      expect(stats.cacheTimeout).toBeGreaterThan(0);
    });

    it('should clear cache', async () => {
      // Arrange
      await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');
      const statsBefore = analyticsService.getStats();

      // Act
      analyticsService.clearCache();
      const statsAfter = analyticsService.getStats();

      // Assert
      expect(statsBefore.cacheSize).toBeGreaterThan(0);
      expect(statsAfter.cacheSize).toBe(0);
    });
  });

  describe('Performance', () => {
    let user: any;
    let venueId: number;
    let eventId: string;
    let market: any;
    let tokens: any[];

    beforeEach(async () => {
      user = await testUtils.createTestUser();
      venueId = await testUtils.createTestVenue();
      eventId = await testUtils.createTestEvent(venueId);
      market = await testUtils.createTestMarket(eventId, venueId);
      tokens = await testUtils.createTestTokens(market.id, market.venue, market.venueMarketId);

      // Create extensive price history
      await testUtils.createTestPriceHistory(tokens[0].tokenId, 1000);
    });

    it('should analyze market within reasonable time', async () => {
      // Act
      const startTime = Date.now();
      const analysis = await analyticsService.analyzeMarket(tokens[0].tokenId, '1m');
      const endTime = Date.now();

      // Assert
      expect(analysis).toBeDefined();
      expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
    });

    it('should handle multiple concurrent analyses', async () => {
      // Arrange
      const analysisPromises = Array.from({ length: 5 }, () =>
        analyticsService.analyzeMarket(tokens[0].tokenId, '1m')
      );

      // Act
      const startTime = Date.now();
      const analyses = await Promise.all(analysisPromises);
      const endTime = Date.now();

      // Assert
      expect(analyses).toHaveLength(5);
      expect(endTime - startTime).toBeLessThan(10000); // Should complete within 10 seconds
    });
  });
});
