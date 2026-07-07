import type { Pool } from "@hunch/infra";

import type {
  ApplyTradeEffectsInput,
  ExecutedPreparedTrade,
  ExecutePreparedTradeInput,
  PersistedTrade,
  PersistTradeInput,
  PreparedTrade,
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
  applyTradeEffects: (
    input: ApplyTradeEffectsInput,
  ) => Promise<TradeEffectsResult>;
  executePreparedTrade: (
    input: ExecutePreparedTradeInput,
  ) => Promise<ExecutedPreparedTrade>;
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
  applyTradeEffects: (
    input: ApplyTradeEffectsInput,
  ) => Promise<TradeEffectsResult>;
  capabilities: () => VenueTradingCapabilities;
  executePreparedTrade: (
    input: ExecutePreparedTradeInput,
  ) => Promise<ExecutedPreparedTrade>;
  getReadiness: (input: TradingReadinessInput) => Promise<TradingReadiness>;
  persistTrade: (input: PersistTradeInput) => Promise<PersistedTrade>;
  prepareTrade: (input: PrepareTradeInput) => Promise<PreparedTrade>;
  quote: (input: TradeQuoteInput) => Promise<TradeQuote>;
  submitPreparedTrade: (
    input: SubmitPreparedTradeInput,
  ) => Promise<SubmitResult>;
  venue: SupportedBotTradingVenue;
};
