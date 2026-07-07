import type { Pool } from "@hunch/infra";

import {
  normalizeTradingError,
  TradingServiceError,
} from "./trading-errors.js";
import type {
  ApplyTradeEffectsInput,
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

const BOT_EXECUTION_DISABLED_MESSAGE =
  "Direct bot trading is disabled for this venue. Open Hunch to trade.";

const BOT_EXECUTION_VENUES = [
  "polymarket",
  "limitless",
  "kalshi",
] as const satisfies readonly TradingVenue[];

export type ApiBotTradingExecutor = {
  applyTradeEffects: (
    input: ApplyTradeEffectsInput,
  ) => Promise<TradeEffectsResult>;
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

export type ApiTradingApplicationServiceInput = {
  geoFence?: {
    kalshiAllowed?: boolean;
    kalshiMessage?: string | null;
  };
  logger?: {
    warn?: (input: unknown, message?: string) => void;
  };
  pool: Pool;
};

function buildDisabledCapability(
  venue: TradingVenue,
): VenueTradingCapabilities {
  return {
    venue,
    supportsBuy: false,
    supportsSell: false,
    supportsCancel: false,
    supportsOrderSync: false,
    supportsPositionSync: false,
    supportsExecutionSync: false,
    supportsSetup: false,
    authorizationModes: ["unsupported"],
    notes: [BOT_EXECUTION_DISABLED_MESSAGE],
  };
}

function buildDisabledReadiness(venue: TradingVenue): TradingReadiness {
  return {
    ready: false,
    executable: false,
    reasonCode: "unsupported_capability",
    message: BOT_EXECUTION_DISABLED_MESSAGE,
    setupRequired: false,
    capabilities: buildDisabledCapability(venue),
  };
}

function unsupportedBotExecution(venue: TradingVenue): TradingServiceError {
  return new TradingServiceError({
    code: "unsupported_capability",
    message: BOT_EXECUTION_DISABLED_MESSAGE,
    statusCode: 501,
    venue,
  });
}

export function createApiTradingApplicationService(
  _input: ApiTradingApplicationServiceInput,
): ApiBotTradingExecutor {
  return {
    applyTradeEffects: async (input) => {
      throw unsupportedBotExecution(input.intent.venue);
    },
    getReadiness: async (input) => buildDisabledReadiness(input.venue),
    listCapabilities: () =>
      BOT_EXECUTION_VENUES.map((venue) => buildDisabledCapability(venue)),
    normalizeError: (venue, error) =>
      normalizeTradingError(error, {
        message: BOT_EXECUTION_DISABLED_MESSAGE,
        venue,
      }),
    persistTrade: async (input) => {
      throw unsupportedBotExecution(input.intent.venue);
    },
    prepareTrade: async (input) => {
      throw unsupportedBotExecution(input.intent.venue);
    },
    quote: async (input) => {
      throw unsupportedBotExecution(input.intent.venue);
    },
    submitPreparedTrade: async (input) => {
      throw unsupportedBotExecution(input.prepared.venue);
    },
  };
}
