import type {
  ApiBotTradingExecutor,
  ApiTradingApplicationServiceInput,
  ApiVenueTradingExecutor,
  SupportedBotTradingVenue,
} from "./api-trading-types.js";
import { createKalshiTradingExecutionService } from "./kalshi-trading-execution-service.js";
import { createLimitlessTradingExecutionService } from "./limitless-trading-execution-service.js";
import { createPolymarketTradingExecutionService } from "./polymarket-trading-execution-service.js";
import {
  normalizeTradingError,
  TradingServiceError,
} from "./trading-errors.js";
import type { TradingVenue } from "./trading-types.js";

export type {
  ApiBotTradingExecutor,
  ApiTradingApplicationServiceInput,
} from "./api-trading-types.js";

function normalizeSupportedVenue(
  venue: TradingVenue,
): SupportedBotTradingVenue | null {
  return venue === "polymarket" || venue === "limitless" || venue === "kalshi"
    ? venue
    : null;
}

function unsupportedVenue(venue: TradingVenue): TradingServiceError {
  return new TradingServiceError({
    code: "unsupported_capability",
    message: "Venue is not supported for Telegram bot trading.",
    statusCode: 400,
    venue,
  });
}

function createExecutorRegistry(
  input: ApiTradingApplicationServiceInput,
): Map<SupportedBotTradingVenue, ApiVenueTradingExecutor> {
  return new Map([
    ["polymarket", createPolymarketTradingExecutionService(input)],
    ["limitless", createLimitlessTradingExecutionService(input)],
    ["kalshi", createKalshiTradingExecutionService(input)],
  ]);
}

export function createApiTradingApplicationService(
  input: ApiTradingApplicationServiceInput,
): ApiBotTradingExecutor {
  const executors = createExecutorRegistry(input);
  const executorFor = (venue: TradingVenue): ApiVenueTradingExecutor => {
    const supported = normalizeSupportedVenue(venue);
    if (!supported) throw unsupportedVenue(venue);
    const executor = executors.get(supported);
    if (!executor) throw unsupportedVenue(venue);
    return executor;
  };

  return {
    applyTradeEffects: (effectsInput) =>
      executorFor(effectsInput.intent.venue).applyTradeEffects(effectsInput),
    executePreparedTrade: (executeInput) =>
      executorFor(executeInput.prepared.venue).executePreparedTrade(
        executeInput,
      ),
    ensureReadiness: async (readinessInput) => {
      const executor = executorFor(readinessInput.venue);
      if (executor.ensureReadiness) {
        return executor.ensureReadiness(readinessInput);
      }
      return {
        readiness: await executor.getReadiness(readinessInput),
        changed: false,
        sideEffects: [],
      };
    },
    getReadiness: (readinessInput) =>
      executorFor(readinessInput.venue).getReadiness(readinessInput),
    listCapabilities: () =>
      Array.from(executors.values(), (executor) => executor.capabilities()),
    normalizeError: (venue, error) =>
      normalizeTradingError(error, {
        message: "Telegram bot trading failed.",
        venue,
      }),
    persistTrade: (persistInput) =>
      executorFor(persistInput.intent.venue).persistTrade(persistInput),
    prepareTrade: (prepareInput) =>
      executorFor(prepareInput.intent.venue).prepareTrade(prepareInput),
    quote: (quoteInput) =>
      executorFor(quoteInput.intent.venue).quote(quoteInput),
    submitPreparedTrade: (submitInput) =>
      executorFor(submitInput.prepared.venue).submitPreparedTrade(submitInput),
  };
}
