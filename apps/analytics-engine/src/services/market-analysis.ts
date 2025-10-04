// Market analysis service for comprehensive market insights
import { EventEmitter } from 'events';
import { logger } from '@hunch/shared';
import { 
  UnifiedTokenId, 
  ChartDataPoint, 
  UnifiedPriceData 
} from '@hunch/shared';
import { Pool } from 'pg';
import { TechnicalIndicators } from './technical-indicators';

// Analysis result types
export interface MarketAnalysis {
  tokenId: UnifiedTokenId;
  timestamp: Date;
  priceAnalysis: PriceAnalysis;
  trendAnalysis: TrendAnalysis;
  volatilityAnalysis: VolatilityAnalysis;
  volumeAnalysis: VolumeAnalysis;
  technicalSignals: TechnicalSignals;
  marketSentiment: MarketSentiment;
  riskMetrics: RiskMetrics;
  recommendations: TradingRecommendation[];
}

export interface PriceAnalysis {
  currentPrice: number;
  priceChange24h: number;
  priceChangePercent24h: number;
  priceChange7d: number;
  priceChangePercent7d: number;
  allTimeHigh: number;
  allTimeLow: number;
  pricePosition: number; // Position between ATH and ATL (0-1)
  supportLevels: number[];
  resistanceLevels: number[];
}

export interface TrendAnalysis {
  shortTermTrend: 'bullish' | 'bearish' | 'sideways';
  mediumTermTrend: 'bullish' | 'bearish' | 'sideways';
  longTermTrend: 'bullish' | 'bearish' | 'sideways';
  trendStrength: number; // 0-1 scale
  trendDuration: number; // Days
  trendReversalRisk: number; // 0-1 scale
}

export interface VolatilityAnalysis {
  currentVolatility: number;
  volatilityPercentile: number; // 0-100
  volatilityTrend: 'increasing' | 'decreasing' | 'stable';
  averageVolatility: number;
  maxVolatility: number;
  minVolatility: number;
}

export interface VolumeAnalysis {
  currentVolume: number;
  volumeChange24h: number;
  volumePercentile: number; // 0-100
  volumeTrend: 'increasing' | 'decreasing' | 'stable';
  averageVolume: number;
  volumePriceCorrelation: number; // -1 to 1
}

export interface TechnicalSignals {
  rsiSignal: 'overbought' | 'oversold' | 'neutral';
  macdSignal: 'bullish' | 'bearish' | 'neutral';
  bollingerSignal: 'squeeze' | 'expansion' | 'neutral';
  stochasticSignal: 'overbought' | 'oversold' | 'neutral';
  movingAverageSignal: 'bullish' | 'bearish' | 'neutral';
  overallSignal: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
  signalStrength: number; // 0-1 scale
}

export interface MarketSentiment {
  bullishPercent: number; // 0-100
  bearishPercent: number; // 0-100
  neutralPercent: number; // 0-100
  sentimentScore: number; // -1 to 1
  sentimentTrend: 'improving' | 'deteriorating' | 'stable';
  fearGreedIndex: number; // 0-100
}

export interface RiskMetrics {
  valueAtRisk95: number; // 95% VaR
  valueAtRisk99: number; // 99% VaR
  maximumDrawdown: number;
  sharpeRatio: number;
  beta: number; // Relative to market
  correlationToMarket: number; // -1 to 1
}

export interface TradingRecommendation {
  action: 'buy' | 'sell' | 'hold';
  confidence: number; // 0-1 scale
  reasoning: string[];
  targetPrice?: number;
  stopLoss?: number;
  timeHorizon: 'short' | 'medium' | 'long';
  riskLevel: 'low' | 'medium' | 'high';
}

// Analysis events
export interface MarketAnalysisEvents {
  'analysis:completed': (analysis: MarketAnalysis) => void;
  'signal:generated': (tokenId: UnifiedTokenId, signal: TechnicalSignals) => void;
  'recommendation:updated': (tokenId: UnifiedTokenId, recommendations: TradingRecommendation[]) => void;
  'error': (error: Error, context: string) => void;
}

export class MarketAnalysisService extends EventEmitter {
  private pool: Pool;
  private analysisCache: Map<string, { analysis: MarketAnalysis; timestamp: Date }> = new Map();
  private cacheTimeout: number = 5 * 60 * 1000; // 5 minutes

  constructor(pool: Pool) {
    super();
    this.pool = pool;
    this.setupEventHandlers();
  }

  // Analyze market for a specific token
  public async analyzeMarket(
    tokenId: UnifiedTokenId,
    timeframe: '1h' | '4h' | '1d' | '1w' = '1d'
  ): Promise<MarketAnalysis> {
    try {
      // Check cache first
      const cacheKey = `${tokenId}_${timeframe}`;
      const cached = this.analysisCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp.getTime() < this.cacheTimeout) {
        logger.debug('Returning cached analysis', { tokenId, timeframe });
        return cached.analysis;
      }

      logger.info('Starting market analysis', { tokenId, timeframe });

      // Get price data
      const priceData = await this.getPriceData(tokenId, timeframe);
      if (priceData.length < 20) {
        throw new Error('Insufficient data for analysis');
      }

      // Perform analysis
      const analysis: MarketAnalysis = {
        tokenId,
        timestamp: new Date(),
        priceAnalysis: await this.analyzePrice(priceData),
        trendAnalysis: await this.analyzeTrend(priceData),
        volatilityAnalysis: await this.analyzeVolatility(priceData),
        volumeAnalysis: await this.analyzeVolume(priceData),
        technicalSignals: await this.analyzeTechnicalSignals(priceData),
        marketSentiment: await this.analyzeMarketSentiment(priceData),
        riskMetrics: await this.analyzeRiskMetrics(priceData),
        recommendations: await this.generateRecommendations(priceData),
      };

      // Cache the analysis
      this.analysisCache.set(cacheKey, { analysis, timestamp: new Date() });

      this.emit('analysis:completed', analysis);
      this.emit('signal:generated', tokenId, analysis.technicalSignals);
      this.emit('recommendation:updated', tokenId, analysis.recommendations);

      logger.info('Market analysis completed', { tokenId, timeframe });
      return analysis;
    } catch (error) {
      logger.error('Market analysis failed', { error, tokenId, timeframe });
      this.emit('error', error as Error, 'analyzeMarket');
      throw error;
    }
  }

  // Get price data for analysis
  private async getPriceData(tokenId: UnifiedTokenId, timeframe: string): Promise<ChartDataPoint[]> {
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

    const result = await this.pool.query(query, [tokenId, timeframe]);
    return result.rows.map(row => ({
      timestamp: row.timestamp,
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume),
    }));
  }

  // Analyze price movements
  private async analyzePrice(data: ChartDataPoint[]): Promise<PriceAnalysis> {
    const currentPrice = data[data.length - 1].close;
    const price24hAgo = data.length >= 24 ? data[data.length - 24].close : data[0].close;
    const price7dAgo = data.length >= 168 ? data[data.length - 168].close : data[0].close;

    const prices = data.map(d => d.close);
    const allTimeHigh = Math.max(...prices);
    const allTimeLow = Math.min(...prices);

    const priceChange24h = currentPrice - price24hAgo;
    const priceChangePercent24h = (priceChange24h / price24hAgo) * 100;
    const priceChange7d = currentPrice - price7dAgo;
    const priceChangePercent7d = (priceChange7d / price7dAgo) * 100;

    const pricePosition = (currentPrice - allTimeLow) / (allTimeHigh - allTimeLow);

    // Simple support/resistance detection
    const supportLevels = this.findSupportLevels(data);
    const resistanceLevels = this.findResistanceLevels(data);

    return {
      currentPrice,
      priceChange24h,
      priceChangePercent24h,
      priceChange7d,
      priceChangePercent7d,
      allTimeHigh,
      allTimeLow,
      pricePosition,
      supportLevels,
      resistanceLevels,
    };
  }

  // Analyze trend
  private async analyzeTrend(data: ChartDataPoint[]): Promise<TrendAnalysis> {
    const indicators = new TechnicalIndicators(data);
    const sma20 = indicators.simpleMovingAverage(20);
    const sma50 = indicators.simpleMovingAverage(Math.min(50, data.length));
    const sma200 = indicators.simpleMovingAverage(Math.min(200, data.length));

    // Determine trends based on moving averages
    const shortTermTrend = this.determineTrend(data.slice(-10), sma20.slice(-10));
    const mediumTermTrend = this.determineTrend(data.slice(-30), sma50.slice(-30));
    const longTermTrend = this.determineTrend(data.slice(-60), sma200.slice(-60));

    // Calculate trend strength
    const trendStrength = this.calculateTrendStrength(data, sma20);

    // Calculate trend duration
    const trendDuration = this.calculateTrendDuration(data);

    // Calculate trend reversal risk
    const trendReversalRisk = this.calculateTrendReversalRisk(data, sma20);

    return {
      shortTermTrend,
      mediumTermTrend,
      longTermTrend,
      trendStrength,
      trendDuration,
      trendReversalRisk,
    };
  }

  // Analyze volatility
  private async analyzeVolatility(data: ChartDataPoint[]): Promise<VolatilityAnalysis> {
    const returns = [];
    for (let i = 1; i < data.length; i++) {
      returns.push((data[i].close - data[i - 1].close) / data[i - 1].close);
    }

    const currentVolatility = this.calculateVolatility(returns.slice(-20));
    const averageVolatility = this.calculateVolatility(returns);
    const maxVolatility = Math.max(...returns.map(r => Math.abs(r)));
    const minVolatility = Math.min(...returns.map(r => Math.abs(r)));

    const volatilityPercentile = this.calculatePercentile(returns.map(r => Math.abs(r)), Math.abs(returns[returns.length - 1]));

    const volatilityTrend = this.determineVolatilityTrend(returns);

    return {
      currentVolatility,
      volatilityPercentile,
      volatilityTrend,
      averageVolatility,
      maxVolatility,
      minVolatility,
    };
  }

  // Analyze volume
  private async analyzeVolume(data: ChartDataPoint[]): Promise<VolumeAnalysis> {
    const volumes = data.map(d => d.volume);
    const currentVolume = volumes[volumes.length - 1];
    const volume24hAgo = volumes.length >= 24 ? volumes[volumes.length - 24] : volumes[0];

    const volumeChange24h = currentVolume - volume24hAgo;
    const volumePercentile = this.calculatePercentile(volumes, currentVolume);

    const volumeTrend = this.determineVolumeTrend(volumes);

    const averageVolume = volumes.reduce((sum, vol) => sum + vol, 0) / volumes.length;

    // Calculate volume-price correlation
    const prices = data.map(d => d.close);
    const volumePriceCorrelation = this.calculateCorrelation(volumes, prices);

    return {
      currentVolume,
      volumeChange24h,
      volumePercentile,
      volumeTrend,
      averageVolume,
      volumePriceCorrelation,
    };
  }

  // Analyze technical signals
  private async analyzeTechnicalSignals(data: ChartDataPoint[]): Promise<TechnicalSignals> {
    const indicators = new TechnicalIndicators(data);
    const rsi = indicators.relativeStrengthIndex(14);
    const macd = indicators.macd(12, 26, 9);
    const bollinger = indicators.bollingerBands(20, 2);
    const stochastic = indicators.stochastic(14, 3);
    const sma20 = indicators.simpleMovingAverage(20);

    // Determine signals
    const rsiSignal = this.determineRSISignal(rsi.rsi[rsi.rsi.length - 1]);
    const macdSignal = this.determineMACDSignal(macd.macd, macd.signal);
    const bollingerSignal = this.determineBollingerSignal(bollinger.bandwidth[bollinger.bandwidth.length - 1]);
    const stochasticSignal = this.determineStochasticSignal(stochastic.k[stochastic.k.length - 1]);
    const movingAverageSignal = this.determineMovingAverageSignal(data.slice(-5), sma20.slice(-5));

    // Overall signal
    const overallSignal = this.determineOverallSignal({
      rsiSignal,
      macdSignal,
      bollingerSignal,
      stochasticSignal,
      movingAverageSignal,
    });

    const signalStrength = this.calculateSignalStrength({
      rsiSignal,
      macdSignal,
      bollingerSignal,
      stochasticSignal,
      movingAverageSignal,
    });

    return {
      rsiSignal,
      macdSignal,
      bollingerSignal,
      stochasticSignal,
      movingAverageSignal,
      overallSignal,
      signalStrength,
    };
  }

  // Analyze market sentiment (placeholder - would integrate with external sentiment data)
  private async analyzeMarketSentiment(data: ChartDataPoint[]): Promise<MarketSentiment> {
    // This would typically integrate with social media, news, and other sentiment sources
    // For now, we'll use price action as a proxy for sentiment
    
    const recentReturns = [];
    for (let i = data.length - 10; i < data.length; i++) {
      if (i > 0) {
        recentReturns.push((data[i].close - data[i - 1].close) / data[i - 1].close);
      }
    }

    const avgReturn = recentReturns.reduce((sum, ret) => sum + ret, 0) / recentReturns.length;
    const sentimentScore = Math.tanh(avgReturn * 10); // Scale and normalize

    const bullishPercent = (sentimentScore + 1) * 50;
    const bearishPercent = (1 - sentimentScore) * 50;
    const neutralPercent = 100 - bullishPercent - bearishPercent;

    return {
      bullishPercent: Math.max(0, Math.min(100, bullishPercent)),
      bearishPercent: Math.max(0, Math.min(100, bearishPercent)),
      neutralPercent: Math.max(0, Math.min(100, neutralPercent)),
      sentimentScore,
      sentimentTrend: sentimentScore > 0.1 ? 'improving' : sentimentScore < -0.1 ? 'deteriorating' : 'stable',
      fearGreedIndex: (sentimentScore + 1) * 50,
    };
  }

  // Analyze risk metrics
  private async analyzeRiskMetrics(data: ChartDataPoint[]): Promise<RiskMetrics> {
    const returns = [];
    for (let i = 1; i < data.length; i++) {
      returns.push((data[i].close - data[i - 1].close) / data[i - 1].close);
    }

    const sortedReturns = returns.sort((a, b) => a - b);
    const valueAtRisk95 = sortedReturns[Math.floor(sortedReturns.length * 0.05)];
    const valueAtRisk99 = sortedReturns[Math.floor(sortedReturns.length * 0.01)];

    const maximumDrawdown = this.calculateMaximumDrawdown(data);
    const sharpeRatio = this.calculateSharpeRatio(returns);
    const beta = 1.0; // Placeholder - would calculate relative to market
    const correlationToMarket = 0.5; // Placeholder - would calculate relative to market

    return {
      valueAtRisk95,
      valueAtRisk99,
      maximumDrawdown,
      sharpeRatio,
      beta,
      correlationToMarket,
    };
  }

  // Generate trading recommendations
  private async generateRecommendations(data: ChartDataPoint[]): Promise<TradingRecommendation[]> {
    const recommendations: TradingRecommendation[] = [];
    const currentPrice = data[data.length - 1].close;

    // Technical analysis recommendation
    const technicalRecommendation = this.generateTechnicalRecommendation(data);
    if (technicalRecommendation) {
      recommendations.push(technicalRecommendation);
    }

    // Trend following recommendation
    const trendRecommendation = this.generateTrendRecommendation(data);
    if (trendRecommendation) {
      recommendations.push(trendRecommendation);
    }

    // Mean reversion recommendation
    const meanReversionRecommendation = this.generateMeanReversionRecommendation(data);
    if (meanReversionRecommendation) {
      recommendations.push(meanReversionRecommendation);
    }

    return recommendations;
  }

  // Helper methods for analysis
  private findSupportLevels(data: ChartDataPoint[]): number[] {
    const levels: number[] = [];
    for (let i = 2; i < data.length - 2; i++) {
      if (data[i].low < data[i - 1].low && data[i].low < data[i - 2].low &&
          data[i].low < data[i + 1].low && data[i].low < data[i + 2].low) {
        levels.push(data[i].low);
      }
    }
    return levels.slice(-5); // Return last 5 support levels
  }

  private findResistanceLevels(data: ChartDataPoint[]): number[] {
    const levels: number[] = [];
    for (let i = 2; i < data.length - 2; i++) {
      if (data[i].high > data[i - 1].high && data[i].high > data[i - 2].high &&
          data[i].high > data[i + 1].high && data[i].high > data[i + 2].high) {
        levels.push(data[i].high);
      }
    }
    return levels.slice(-5); // Return last 5 resistance levels
  }

  private determineTrend(prices: ChartDataPoint[], sma: number[]): 'bullish' | 'bearish' | 'sideways' {
    if (prices.length < 2 || sma.length < 2) return 'sideways';
    
    const priceSlope = (prices[prices.length - 1].close - prices[0].close) / prices.length;
    const smaSlope = (sma[sma.length - 1] - sma[0]) / sma.length;
    
    if (priceSlope > 0.001 && smaSlope > 0.001) return 'bullish';
    if (priceSlope < -0.001 && smaSlope < -0.001) return 'bearish';
    return 'sideways';
  }

  private calculateTrendStrength(data: ChartDataPoint[], sma: number[]): number {
    if (data.length < 2 || sma.length < 2) return 0;
    
    let aboveCount = 0;
    for (let i = 0; i < Math.min(data.length, sma.length); i++) {
      if (data[i].close > sma[i]) aboveCount++;
    }
    
    return aboveCount / Math.min(data.length, sma.length);
  }

  private calculateTrendDuration(data: ChartDataPoint[]): number {
    // Simplified trend duration calculation
    return data.length / 24; // Assuming hourly data
  }

  private calculateTrendReversalRisk(data: ChartDataPoint[], sma: number[]): number {
    // Simplified reversal risk calculation
    const recentVolatility = this.calculateVolatility(data.slice(-10).map(d => d.close));
    const averageVolatility = this.calculateVolatility(data.map(d => d.close));
    
    return Math.min(1, recentVolatility / averageVolatility);
  }

  private calculateVolatility(returns: number[]): number {
    if (returns.length < 2) return 0;
    
    const mean = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;
    
    return Math.sqrt(variance);
  }

  private calculatePercentile(data: number[], value: number): number {
    const sorted = data.sort((a, b) => a - b);
    const index = sorted.findIndex(d => d >= value);
    return (index / sorted.length) * 100;
  }

  private determineVolatilityTrend(returns: number[]): 'increasing' | 'decreasing' | 'stable' {
    if (returns.length < 20) return 'stable';
    
    const recentVol = this.calculateVolatility(returns.slice(-10));
    const olderVol = this.calculateVolatility(returns.slice(-20, -10));
    
    if (recentVol > olderVol * 1.1) return 'increasing';
    if (recentVol < olderVol * 0.9) return 'decreasing';
    return 'stable';
  }

  private determineVolumeTrend(volumes: number[]): 'increasing' | 'decreasing' | 'stable' {
    if (volumes.length < 20) return 'stable';
    
    const recentAvg = volumes.slice(-10).reduce((sum, vol) => sum + vol, 0) / 10;
    const olderAvg = volumes.slice(-20, -10).reduce((sum, vol) => sum + vol, 0) / 10;
    
    if (recentAvg > olderAvg * 1.1) return 'increasing';
    if (recentAvg < olderAvg * 0.9) return 'decreasing';
    return 'stable';
  }

  private calculateCorrelation(x: number[], y: number[]): number {
    if (x.length !== y.length || x.length < 2) return 0;
    
    const n = x.length;
    const sumX = x.reduce((sum, val) => sum + val, 0);
    const sumY = y.reduce((sum, val) => sum + val, 0);
    const sumXY = x.reduce((sum, val, i) => sum + val * y[i], 0);
    const sumXX = x.reduce((sum, val) => sum + val * val, 0);
    const sumYY = y.reduce((sum, val) => sum + val * val, 0);
    
    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
    
    return denominator === 0 ? 0 : numerator / denominator;
  }

  private determineRSISignal(rsi: number): 'overbought' | 'oversold' | 'neutral' {
    if (rsi > 70) return 'overbought';
    if (rsi < 30) return 'oversold';
    return 'neutral';
  }

  private determineMACDSignal(macd: number[], signal: number[]): 'bullish' | 'bearish' | 'neutral' {
    if (macd.length < 2 || signal.length < 2) return 'neutral';
    
    const macdDiff = macd[macd.length - 1] - signal[signal.length - 1];
    const prevMacdDiff = macd[macd.length - 2] - signal[signal.length - 2];
    
    if (macdDiff > 0 && prevMacdDiff <= 0) return 'bullish';
    if (macdDiff < 0 && prevMacdDiff >= 0) return 'bearish';
    return 'neutral';
  }

  private determineBollingerSignal(bandwidth: number): 'squeeze' | 'expansion' | 'neutral' {
    if (bandwidth < 0.1) return 'squeeze';
    if (bandwidth > 0.3) return 'expansion';
    return 'neutral';
  }

  private determineStochasticSignal(k: number): 'overbought' | 'oversold' | 'neutral' {
    if (k > 80) return 'overbought';
    if (k < 20) return 'oversold';
    return 'neutral';
  }

  private determineMovingAverageSignal(prices: ChartDataPoint[], sma: number[]): 'bullish' | 'bearish' | 'neutral' {
    if (prices.length < 2 || sma.length < 2) return 'neutral';
    
    const currentPrice = prices[prices.length - 1].close;
    const currentSMA = sma[sma.length - 1];
    const prevPrice = prices[prices.length - 2].close;
    const prevSMA = sma[sma.length - 2];
    
    if (currentPrice > currentSMA && prevPrice <= prevSMA) return 'bullish';
    if (currentPrice < currentSMA && prevPrice >= prevSMA) return 'bearish';
    return 'neutral';
  }

  private determineOverallSignal(signals: any): 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell' {
    let bullishCount = 0;
    let bearishCount = 0;
    
    if (signals.rsiSignal === 'oversold') bullishCount++;
    if (signals.rsiSignal === 'overbought') bearishCount++;
    if (signals.macdSignal === 'bullish') bullishCount++;
    if (signals.macdSignal === 'bearish') bearishCount++;
    if (signals.stochasticSignal === 'oversold') bullishCount++;
    if (signals.stochasticSignal === 'overbought') bearishCount++;
    if (signals.movingAverageSignal === 'bullish') bullishCount++;
    if (signals.movingAverageSignal === 'bearish') bearishCount++;
    
    if (bullishCount >= 4) return 'strong_buy';
    if (bullishCount >= 2) return 'buy';
    if (bearishCount >= 4) return 'strong_sell';
    if (bearishCount >= 2) return 'sell';
    return 'hold';
  }

  private calculateSignalStrength(signals: any): number {
    let strength = 0;
    let totalSignals = 0;
    
    // RSI strength
    if (signals.rsiSignal === 'oversold') strength += 0.8;
    else if (signals.rsiSignal === 'overbought') strength += 0.8;
    else strength += 0.2;
    totalSignals++;
    
    // MACD strength
    if (signals.macdSignal === 'bullish') strength += 0.7;
    else if (signals.macdSignal === 'bearish') strength += 0.7;
    else strength += 0.3;
    totalSignals++;
    
    // Moving average strength
    if (signals.movingAverageSignal === 'bullish') strength += 0.6;
    else if (signals.movingAverageSignal === 'bearish') strength += 0.6;
    else strength += 0.4;
    totalSignals++;
    
    return totalSignals > 0 ? strength / totalSignals : 0;
  }

  private calculateMaximumDrawdown(data: ChartDataPoint[]): number {
    let maxDrawdown = 0;
    let peak = data[0].close;
    
    for (let i = 1; i < data.length; i++) {
      if (data[i].close > peak) {
        peak = data[i].close;
      } else {
        const drawdown = (peak - data[i].close) / peak;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
      }
    }
    
    return maxDrawdown;
  }

  private calculateSharpeRatio(returns: number[]): number {
    if (returns.length < 2) return 0;
    
    const meanReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const volatility = this.calculateVolatility(returns);
    
    return volatility === 0 ? 0 : meanReturn / volatility;
  }

  private generateTechnicalRecommendation(data: ChartDataPoint[]): TradingRecommendation | null {
    const indicators = new TechnicalIndicators(data);
    const rsi = indicators.relativeStrengthIndex(14);
    const currentRSI = rsi.rsi[rsi.rsi.length - 1];
    
    if (currentRSI < 30) {
      return {
        action: 'buy',
        confidence: 0.7,
        reasoning: ['RSI indicates oversold conditions', 'Potential bounce opportunity'],
        targetPrice: data[data.length - 1].close * 1.1,
        stopLoss: data[data.length - 1].close * 0.95,
        timeHorizon: 'short',
        riskLevel: 'medium',
      };
    } else if (currentRSI > 70) {
      return {
        action: 'sell',
        confidence: 0.7,
        reasoning: ['RSI indicates overbought conditions', 'Potential pullback expected'],
        targetPrice: data[data.length - 1].close * 0.9,
        stopLoss: data[data.length - 1].close * 1.05,
        timeHorizon: 'short',
        riskLevel: 'medium',
      };
    }
    
    return null;
  }

  private generateTrendRecommendation(data: ChartDataPoint[]): TradingRecommendation | null {
    const indicators = new TechnicalIndicators(data);
    const sma20 = indicators.simpleMovingAverage(20);
    const sma50 = indicators.simpleMovingAverage(Math.min(50, data.length));
    
    if (sma20.length < 2 || sma50.length < 2) return null;
    
    const currentPrice = data[data.length - 1].close;
    const currentSMA20 = sma20[sma20.length - 1];
    const currentSMA50 = sma50[sma50.length - 1];
    
    if (currentPrice > currentSMA20 && currentSMA20 > currentSMA50) {
      return {
        action: 'buy',
        confidence: 0.6,
        reasoning: ['Price above moving averages', 'Uptrend confirmed'],
        targetPrice: currentPrice * 1.15,
        stopLoss: currentSMA20,
        timeHorizon: 'medium',
        riskLevel: 'low',
      };
    } else if (currentPrice < currentSMA20 && currentSMA20 < currentSMA50) {
      return {
        action: 'sell',
        confidence: 0.6,
        reasoning: ['Price below moving averages', 'Downtrend confirmed'],
        targetPrice: currentPrice * 0.85,
        stopLoss: currentSMA20,
        timeHorizon: 'medium',
        riskLevel: 'low',
      };
    }
    
    return null;
  }

  private generateMeanReversionRecommendation(data: ChartDataPoint[]): TradingRecommendation | null {
    const indicators = new TechnicalIndicators(data);
    const bollinger = indicators.bollingerBands(20, 2);
    
    if (bollinger.upper.length < 1) return null;
    
    const currentPrice = data[data.length - 1].close;
    const upperBand = bollinger.upper[bollinger.upper.length - 1];
    const lowerBand = bollinger.lower[bollinger.lower.length - 1];
    const middleBand = bollinger.middle[bollinger.middle.length - 1];
    
    if (currentPrice > upperBand) {
      return {
        action: 'sell',
        confidence: 0.5,
        reasoning: ['Price above upper Bollinger Band', 'Mean reversion expected'],
        targetPrice: middleBand,
        stopLoss: upperBand * 1.02,
        timeHorizon: 'short',
        riskLevel: 'high',
      };
    } else if (currentPrice < lowerBand) {
      return {
        action: 'buy',
        confidence: 0.5,
        reasoning: ['Price below lower Bollinger Band', 'Mean reversion expected'],
        targetPrice: middleBand,
        stopLoss: lowerBand * 0.98,
        timeHorizon: 'short',
        riskLevel: 'high',
      };
    }
    
    return null;
  }

  // Setup event handlers
  private setupEventHandlers(): void {
    this.on('analysis:completed', (analysis) => {
      logger.info('Market analysis completed', { tokenId: analysis.tokenId });
    });

    this.on('signal:generated', (tokenId, signal) => {
      logger.info('Technical signal generated', { tokenId, signal: signal.overallSignal });
    });

    this.on('recommendation:updated', (tokenId, recommendations) => {
      logger.info('Trading recommendations updated', { 
        tokenId, 
        recommendationsCount: recommendations.length 
      });
    });

    this.on('error', (error, context) => {
      logger.error('Market analysis error', { error: error.message, context });
    });
  }

  // Get cached analysis
  public getCachedAnalysis(tokenId: UnifiedTokenId, timeframe: string): MarketAnalysis | null {
    const cacheKey = `${tokenId}_${timeframe}`;
    const cached = this.analysisCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp.getTime() < this.cacheTimeout) {
      return cached.analysis;
    }
    
    return null;
  }

  // Clear cache
  public clearCache(): void {
    this.analysisCache.clear();
    logger.info('Analysis cache cleared');
  }

  // Get service statistics
  public getStats(): {
    cacheSize: number;
    cacheTimeout: number;
  } {
    return {
      cacheSize: this.analysisCache.size,
      cacheTimeout: this.cacheTimeout,
    };
  }
}
