import type { Pool } from "@hunch/infra";

import type {
  ApplyTradeEffectsInput,
  EnsureReadinessInput,
  EnsureReadinessResult,
  ExecutedPreparedTrade,
  ExecutePreparedTradeInput,
  PersistedTrade,
  PersistTradeInput,
  PreparedTrade,
  PrepareCancelOrderInput,
  PreparedCancelOrder,
  SubmitPreparedCancelOrderInput,
  PrepareTradeInput,
  SubmitPreparedTradeInput,
  SubmitResult,
  TradeEffectsResult,
  TradeQuote,
  TradeQuoteInput,
  TradingError,
  TradingReadiness,
  TradingReadinessInput,
  TradingVenue,
  VenueTradingCapabilities,
} from "./trading-types.js";

export type SupportedBotTradingVenue = "kalshi" | "limitless" | "polymarket";

export type ApiTradingLogger = {
  warn?: (input: unknown, message?: string) => void;
};

export type ApiTradingApplicationServiceInput = {
  geoFence?: {
    kalshiAllowed?: boolean;
    kalshiMessage?: string | null;
  };
  logger?: ApiTradingLogger;
  pool: Pool;
};

export type ApiBotTradingExecutor = {
  prepareCancelOrder: (
    input: PrepareCancelOrderInput,
  ) => Promise<PreparedCancelOrder>;
  submitPreparedCancelOrder: (
    input: SubmitPreparedCancelOrderInput,
  ) => Promise<SubmitResult>;
  applyTradeEffects: (
    input: ApplyTradeEffectsInput,
  ) => Promise<TradeEffectsResult>;
  executePreparedTrade: (
    input: ExecutePreparedTradeInput,
  ) => Promise<ExecutedPreparedTrade>;
  ensureReadiness: (
    input: EnsureReadinessInput,
  ) => Promise<EnsureReadinessResult>;
  getReadiness: (input: TradingReadinessInput) => Promise<TradingReadiness>;
  listCapabilities: () => VenueTradingCapabilities[];
  normalizeError: (venue: TradingVenue, error: unknown) => TradingError;
  persistTrade: (input: PersistTradeInput) => Promise<PersistedTrade>;
  prepareTrade: (input: PrepareTradeInput) => Promise<PreparedTrade>;
  quote: (input: TradeQuoteInput) => Promise<TradeQuote>;
  submitPreparedTrade: (
    input: SubmitPreparedTradeInput,
  ) => Promise<SubmitResult>;
};

export type ApiVenueTradingExecutor = {
  prepareCancelOrder?: (
    input: PrepareCancelOrderInput,
  ) => Promise<PreparedCancelOrder>;
  submitPreparedCancelOrder?: (
    input: SubmitPreparedCancelOrderInput,
  ) => Promise<SubmitResult>;
  /** This adapter atomically owns its existing common funding claim, persisted
   * order and submission. Do not wrap it in a second generic claim/release. */
  submissionOwnership?: "durable_client_signed";
  applyTradeEffects: (
    input: ApplyTradeEffectsInput,
  ) => Promise<TradeEffectsResult>;
  capabilities: () => VenueTradingCapabilities;
  executePreparedTrade: (
    input: ExecutePreparedTradeInput,
  ) => Promise<ExecutedPreparedTrade>;
  ensureReadiness?: (
    input: EnsureReadinessInput,
  ) => Promise<EnsureReadinessResult>;
  getReadiness: (input: TradingReadinessInput) => Promise<TradingReadiness>;
  persistTrade: (input: PersistTradeInput) => Promise<PersistedTrade>;
  prepareTrade: (input: PrepareTradeInput) => Promise<PreparedTrade>;
  quote: (input: TradeQuoteInput) => Promise<TradeQuote>;
  submitPreparedTrade: (
    input: SubmitPreparedTradeInput,
  ) => Promise<SubmitResult>;
  venue: TradingVenue;
};
