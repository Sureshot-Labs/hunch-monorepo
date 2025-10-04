// Technical indicators for market analysis
import { ChartDataPoint } from '@hunch/shared';
import { logger } from '@hunch/shared';

// Moving Average types
export interface MovingAverageResult {
  sma: number[];
  ema: number[];
  wma: number[];
}

// RSI result
export interface RSIResult {
  rsi: number[];
  overbought: boolean[];
  oversold: boolean[];
}

// MACD result
export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

// Bollinger Bands result
export interface BollingerBandsResult {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];
  percentB: number[];
}

// Stochastic result
export interface StochasticResult {
  k: number[];
  d: number[];
  overbought: boolean[];
  oversold: boolean[];
}

// Volume indicators
export interface VolumeIndicators {
  obv: number[]; // On-Balance Volume
  vwap: number[]; // Volume Weighted Average Price
  volumeSMA: number[]; // Volume Simple Moving Average
}

// Support and Resistance levels
export interface SupportResistance {
  support: number[];
  resistance: number[];
  pivotPoints: {
    pivot: number;
    r1: number;
    r2: number;
    r3: number;
    s1: number;
    s2: number;
    s3: number;
  };
}

export class TechnicalIndicators {
  private data: ChartDataPoint[];

  constructor(data: ChartDataPoint[]) {
    this.data = data;
    if (data.length === 0) {
      throw new Error('No data provided for technical analysis');
    }
  }

  // Simple Moving Average
  public simpleMovingAverage(period: number): number[] {
    if (this.data.length < period) {
      logger.warn(`Insufficient data for SMA period ${period}`);
      return [];
    }

    const sma: number[] = [];
    for (let i = period - 1; i < this.data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += this.data[i - j].close;
      }
      sma.push(sum / period);
    }

    return sma;
  }

  // Exponential Moving Average
  public exponentialMovingAverage(period: number): number[] {
    if (this.data.length < period) {
      logger.warn(`Insufficient data for EMA period ${period}`);
      return [];
    }

    const ema: number[] = [];
    const multiplier = 2 / (period + 1);

    // First EMA value is SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += this.data[i].close;
    }
    ema.push(sum / period);

    // Calculate subsequent EMA values
    for (let i = period; i < this.data.length; i++) {
      const emaValue = (this.data[i].close - ema[ema.length - 1]) * multiplier + ema[ema.length - 1];
      ema.push(emaValue);
    }

    return ema;
  }

  // Weighted Moving Average
  public weightedMovingAverage(period: number): number[] {
    if (this.data.length < period) {
      logger.warn(`Insufficient data for WMA period ${period}`);
      return [];
    }

    const wma: number[] = [];
    const weights = Array.from({ length: period }, (_, i) => i + 1);
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

    for (let i = period - 1; i < this.data.length; i++) {
      let weightedSum = 0;
      for (let j = 0; j < period; j++) {
        weightedSum += this.data[i - j].close * weights[j];
      }
      wma.push(weightedSum / weightSum);
    }

    return wma;
  }

  // Relative Strength Index (RSI)
  public relativeStrengthIndex(period: number = 14): RSIResult {
    if (this.data.length < period + 1) {
      logger.warn(`Insufficient data for RSI period ${period}`);
      return { rsi: [], overbought: [], oversold: [] };
    }

    const gains: number[] = [];
    const losses: number[] = [];

    // Calculate price changes
    for (let i = 1; i < this.data.length; i++) {
      const change = this.data[i].close - this.data[i - 1].close;
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? Math.abs(change) : 0);
    }

    const rsi: number[] = [];
    const overbought: boolean[] = [];
    const oversold: boolean[] = [];

    // Calculate initial average gain and loss
    let avgGain = gains.slice(0, period).reduce((sum, gain) => sum + gain, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((sum, loss) => sum + loss, 0) / period;

    for (let i = period; i < gains.length; i++) {
      // Calculate RSI
      const rs = avgGain / avgLoss;
      const rsiValue = 100 - (100 / (1 + rs));
      rsi.push(rsiValue);

      // Check overbought/oversold conditions
      overbought.push(rsiValue > 70);
      oversold.push(rsiValue < 30);

      // Update averages using Wilder's smoothing
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }

    return { rsi, overbought, oversold };
  }

  // MACD (Moving Average Convergence Divergence)
  public macd(fastPeriod: number = 12, slowPeriod: number = 26, signalPeriod: number = 9): MACDResult {
    if (this.data.length < slowPeriod) {
      logger.warn(`Insufficient data for MACD`);
      return { macd: [], signal: [], histogram: [] };
    }

    const fastEMA = this.exponentialMovingAverage(fastPeriod);
    const slowEMA = this.exponentialMovingAverage(slowPeriod);

    // Calculate MACD line
    const macd: number[] = [];
    const startIndex = slowPeriod - fastPeriod;
    for (let i = 0; i < fastEMA.length; i++) {
      if (i >= startIndex) {
        macd.push(fastEMA[i] - slowEMA[i - startIndex]);
      }
    }

    // Calculate signal line (EMA of MACD)
    const signal = this.calculateEMAFromArray(macd, signalPeriod);

    // Calculate histogram
    const histogram: number[] = [];
    const signalStartIndex = macd.length - signal.length;
    for (let i = 0; i < signal.length; i++) {
      histogram.push(macd[i + signalStartIndex] - signal[i]);
    }

    return { macd, signal, histogram };
  }

  // Bollinger Bands
  public bollingerBands(period: number = 20, standardDeviations: number = 2): BollingerBandsResult {
    if (this.data.length < period) {
      logger.warn(`Insufficient data for Bollinger Bands period ${period}`);
      return { upper: [], middle: [], lower: [], bandwidth: [], percentB: [] };
    }

    const sma = this.simpleMovingAverage(period);
    const upper: number[] = [];
    const lower: number[] = [];
    const bandwidth: number[] = [];
    const percentB: number[] = [];

    for (let i = period - 1; i < this.data.length; i++) {
      // Calculate standard deviation
      let sum = 0;
      for (let j = 0; j < period; j++) {
        const diff = this.data[i - j].close - sma[i - period + 1];
        sum += diff * diff;
      }
      const stdDev = Math.sqrt(sum / period);

      const upperBand = sma[i - period + 1] + (standardDeviations * stdDev);
      const lowerBand = sma[i - period + 1] - (standardDeviations * stdDev);

      upper.push(upperBand);
      lower.push(lowerBand);

      // Calculate bandwidth
      bandwidth.push((upperBand - lowerBand) / sma[i - period + 1] * 100);

      // Calculate %B
      const currentPrice = this.data[i].close;
      percentB.push((currentPrice - lowerBand) / (upperBand - lowerBand) * 100);
    }

    return {
      upper,
      middle: sma,
      lower,
      bandwidth,
      percentB,
    };
  }

  // Stochastic Oscillator
  public stochastic(kPeriod: number = 14, dPeriod: number = 3): StochasticResult {
    if (this.data.length < kPeriod) {
      logger.warn(`Insufficient data for Stochastic period ${kPeriod}`);
      return { k: [], d: [], overbought: [], oversold: [] };
    }

    const k: number[] = [];
    const overbought: boolean[] = [];
    const oversold: boolean[] = [];

    for (let i = kPeriod - 1; i < this.data.length; i++) {
      let highestHigh = this.data[i].high;
      let lowestLow = this.data[i].low;

      // Find highest high and lowest low in the period
      for (let j = 0; j < kPeriod; j++) {
        highestHigh = Math.max(highestHigh, this.data[i - j].high);
        lowestLow = Math.min(lowestLow, this.data[i - j].low);
      }

      const currentClose = this.data[i].close;
      const kValue = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
      k.push(kValue);

      overbought.push(kValue > 80);
      oversold.push(kValue < 20);
    }

    // Calculate %D (SMA of %K)
    const d = this.calculateSMAFromArray(k, dPeriod);

    return { k, d, overbought, oversold };
  }

  // Volume indicators
  public volumeIndicators(period: number = 20): VolumeIndicators {
    const obv: number[] = [];
    const vwap: number[] = [];
    const volumeSMA: number[] = [];

    let obvValue = 0;
    let cumulativeVolumePrice = 0;
    let cumulativeVolume = 0;

    for (let i = 0; i < this.data.length; i++) {
      const point = this.data[i];
      const typicalPrice = (point.high + point.low + point.close) / 3;

      // On-Balance Volume
      if (i > 0) {
        if (point.close > this.data[i - 1].close) {
          obvValue += point.volume;
        } else if (point.close < this.data[i - 1].close) {
          obvValue -= point.volume;
        }
      }
      obv.push(obvValue);

      // VWAP
      cumulativeVolumePrice += typicalPrice * point.volume;
      cumulativeVolume += point.volume;
      vwap.push(cumulativeVolumePrice / cumulativeVolume);
    }

    // Volume SMA
    for (let i = period - 1; i < this.data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += this.data[i - j].volume;
      }
      volumeSMA.push(sum / period);
    }

    return { obv, vwap, volumeSMA };
  }

  // Support and Resistance levels
  public supportResistance(): SupportResistance {
    if (this.data.length < 2) {
      return { support: [], resistance: [], pivotPoints: { pivot: 0, r1: 0, r2: 0, r3: 0, s1: 0, s2: 0, s3: 0 } };
    }

    const support: number[] = [];
    const resistance: number[] = [];

    // Simple support/resistance detection based on local minima/maxima
    for (let i = 1; i < this.data.length - 1; i++) {
      const prev = this.data[i - 1];
      const current = this.data[i];
      const next = this.data[i + 1];

      // Local minimum (potential support)
      if (current.low < prev.low && current.low < next.low) {
        support.push(current.low);
      }

      // Local maximum (potential resistance)
      if (current.high > prev.high && current.high > next.high) {
        resistance.push(current.high);
      }
    }

    // Calculate pivot points for the last period
    const lastPoint = this.data[this.data.length - 1];
    const pivot = (lastPoint.high + lastPoint.low + lastPoint.close) / 3;
    const r1 = 2 * pivot - lastPoint.low;
    const r2 = pivot + (lastPoint.high - lastPoint.low);
    const r3 = lastPoint.high + 2 * (pivot - lastPoint.low);
    const s1 = 2 * pivot - lastPoint.high;
    const s2 = pivot - (lastPoint.high - lastPoint.low);
    const s3 = lastPoint.low - 2 * (lastPoint.high - pivot);

    return {
      support,
      resistance,
      pivotPoints: { pivot, r1, r2, r3, s1, s2, s3 },
    };
  }

  // Helper method to calculate EMA from array
  private calculateEMAFromArray(data: number[], period: number): number[] {
    if (data.length < period) return [];

    const ema: number[] = [];
    const multiplier = 2 / (period + 1);

    // First EMA value is SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += data[i];
    }
    ema.push(sum / period);

    // Calculate subsequent EMA values
    for (let i = period; i < data.length; i++) {
      const emaValue = (data[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1];
      ema.push(emaValue);
    }

    return ema;
  }

  // Helper method to calculate SMA from array
  private calculateSMAFromArray(data: number[], period: number): number[] {
    if (data.length < period) return [];

    const sma: number[] = [];
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j];
      }
      sma.push(sum / period);
    }

    return sma;
  }

  // Get all indicators at once
  public getAllIndicators(): {
    movingAverages: MovingAverageResult;
    rsi: RSIResult;
    macd: MACDResult;
    bollingerBands: BollingerBandsResult;
    stochastic: StochasticResult;
    volumeIndicators: VolumeIndicators;
    supportResistance: SupportResistance;
  } {
    return {
      movingAverages: {
        sma: this.simpleMovingAverage(20),
        ema: this.exponentialMovingAverage(20),
        wma: this.weightedMovingAverage(20),
      },
      rsi: this.relativeStrengthIndex(14),
      macd: this.macd(12, 26, 9),
      bollingerBands: this.bollingerBands(20, 2),
      stochastic: this.stochastic(14, 3),
      volumeIndicators: this.volumeIndicators(20),
      supportResistance: this.supportResistance(),
    };
  }
}
