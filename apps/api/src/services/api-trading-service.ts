import type {
  ApiBotTradingExecutor,
  ApiTradingApplicationServiceInput,
  ApiVenueTradingExecutor,
  SupportedBotTradingVenue,
} from "./api-trading-types.js";
import {
  assertFundingReservationReadyForTrade,
  releaseFundingReservationForAbandonedTrade,
} from "../funding/persistence/funding-evidence-repository.js";
import { createKalshiTradingExecutionService } from "./kalshi-trading-execution-service.js";
import { createLimitlessTradingExecutionService } from "./limitless-trading-execution-service.js";
import { createPolymarketTradingExecutionService } from "./polymarket-trading-execution-service.js";
import {
  normalizeTradingError,
  TradingServiceError,
} from "./trading-errors.js";
import type { TradeIntent, TradingVenue } from "./trading-types.js";
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

  const assertIntentAllowed = async (intent: TradeIntent): Promise<void> => {
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
  const assertFundingReady = async (intent: TradeIntent): Promise<void> => {
    if (!intent.fundingReservation) return;
    if (intent.action !== "BUY") {
      throw new TradingServiceError({
        code: "invalid_trade_request",
        message: "A funding reservation can only be linked to a buy.",
        statusCode: 409,
        venue: intent.venue,
      });
    }
    try {
      await assertFundingReservationReadyForTrade(input.pool, {
        userId: intent.actor.userId,
        link: intent.fundingReservation,
        venue: intent.venue,
        marketId: intent.target.marketId,
      });
    } catch (error) {
      throw new TradingServiceError({
        code: "insufficient_readiness",
        message:
          error instanceof Error
            ? error.message
            : "Funding reservation is unavailable.",
        statusCode: 409,
        venue: intent.venue,
      });
    }
  };
  const assertReadyIntent = async (intent: TradeIntent): Promise<void> => {
    await assertIntentAllowed(intent);
    await assertFundingReady(intent);
  };

  return {
    applyTradeEffects: (effectsInput) =>
      executorFor(effectsInput.intent.venue).applyTradeEffects(effectsInput),
    executePreparedTrade: async (executeInput) => {
      const intent = executeInput.prepared.intent;
      await assertReadyIntent(intent);
      const executed = await executorFor(
        executeInput.prepared.venue,
      ).executePreparedTrade(executeInput);
      if (
        intent.fundingReservation &&
        ["cancelled", "failed", "no_fill"].includes(
          executed.submitResult.status,
        )
      ) {
        await releaseFundingReservationForAbandonedTrade(input.pool, {
          userId: intent.actor.userId,
          link: intent.fundingReservation,
          outcomeReason: `trade_${executed.submitResult.status}`,
        });
      }
      return executed;
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
      await assertReadyIntent(prepareInput.intent);
      return executorFor(prepareInput.intent.venue).prepareTrade(prepareInput);
    },
    quote: async (quoteInput) => {
      await assertReadyIntent(quoteInput.intent);
      return executorFor(quoteInput.intent.venue).quote(quoteInput);
    },
    submitPreparedTrade: async (submitInput) => {
      await assertReadyIntent(submitInput.prepared.intent);
      return executorFor(submitInput.prepared.venue).submitPreparedTrade(
        submitInput,
      );
    },
  };
}
