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
import { venueLifecycleAllowsTradingAction } from "./venue-lifecycle.js";

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

  const assertIntentAllowed = async (intent: {
    action: "BUY" | "SELL";
    actor: { kind: string };
    venue: TradingVenue;
  }): Promise<void> => {
    const allowed = await venueLifecycleAllowsTradingAction(
      input.pool,
      intent.venue,
      intent.action,
      { automation: intent.actor.kind === "telegram_bot" },
    );
    if (allowed) return;
    throw new TradingServiceError({
      code: "venue_lifecycle_blocked",
      message:
        intent.action === "BUY"
          ? "This venue is not accepting new exposure."
          : "This venue is unavailable for position exits.",
      statusCode: 409,
      venue: intent.venue,
    });
  };

  return {
    applyTradeEffects: (effectsInput) =>
      executorFor(effectsInput.intent.venue).applyTradeEffects(effectsInput),
    executePreparedTrade: async (executeInput) => {
      await assertIntentAllowed(executeInput.prepared.intent);
      return executorFor(executeInput.prepared.venue).executePreparedTrade(
        executeInput,
      );
    },
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
    prepareTrade: async (prepareInput) => {
      await assertIntentAllowed(prepareInput.intent);
      return executorFor(prepareInput.intent.venue).prepareTrade(prepareInput);
    },
    quote: async (quoteInput) => {
      await assertIntentAllowed(quoteInput.intent);
      return executorFor(quoteInput.intent.venue).quote(quoteInput);
    },
    submitPreparedTrade: async (submitInput) => {
      await assertIntentAllowed(submitInput.prepared.intent);
      return executorFor(submitInput.prepared.venue).submitPreparedTrade(
        submitInput,
      );
    },
  };
}
