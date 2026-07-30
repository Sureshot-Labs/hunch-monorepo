import type {
  ApiBotTradingExecutor,
  ApiTradingApplicationServiceInput,
  ApiVenueTradingExecutor,
  SupportedBotTradingVenue,
} from "./api-trading-types.js";
import { releaseFundingReservationForDefinitiveTradeFailure } from "../funding/persistence/funding-evidence-repository.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import {
  buildFundingTradeConsumerIntent,
  type FundingTradeConsumerIntent,
} from "../funding/persistence/funding-trade-consumer-intent.js";
import {
  claimFundingTradeAttempt,
  FundingTradeAttemptError,
  markFundingTradeAttemptSubmissionStarted,
  recordFundingTradeAttemptOutcome,
  type FundingTradeExecutionPath,
} from "../funding/persistence/funding-trade-attempt-repository.js";
import { isRecord } from "../lib/type-guards.js";
import { normalizeLimitlessScopedTokenId } from "../lib/limitless-token.js";
import { env } from "../env.js";
import { createKalshiTradingExecutionService } from "./kalshi-trading-execution-service.js";
import { createLimitlessTradingExecutionService } from "./limitless-trading-execution-service.js";
import { createPolymarketTradingExecutionService } from "./polymarket-trading-execution-service.js";
import {
  normalizeTradingError,
  TradingServiceError,
} from "./trading-errors.js";
import type {
  PreparedTrade,
  TradeIntent,
  TradingVenue,
} from "./trading-types.js";
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
  };
  const assertReadyIntent = async (intent: TradeIntent): Promise<void> => {
    await assertIntentAllowed(intent);
    await assertFundingReady(intent);
  };
  const executionPathResolvers: Readonly<
    Record<
      SupportedBotTradingVenue,
      (venuePayload: unknown) => FundingTradeExecutionPath
    >
  > = {
    polymarket: () => "polymarket_clob",
    kalshi: () => "kalshi_dflow",
    limitless: (venuePayload) =>
      isRecord(venuePayload) && venuePayload.tradeType === "amm"
        ? "limitless_amm"
        : "limitless_clob",
  };
  const executionPathFor = (
    venue: SupportedBotTradingVenue,
    venuePayload: unknown,
  ): FundingTradeExecutionPath => executionPathResolvers[venue](venuePayload);
  const externalReferenceFor = (input: {
    orderHash?: string | null;
    txSignature?: string | null;
    venueOrderId?: string | null;
  }): string | null =>
    input.orderHash ?? input.txSignature ?? input.venueOrderId ?? null;

  const rawInteger = (value: unknown): string | null => {
    if (typeof value === "bigint" && value > 0n) return value.toString();
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return value.toString();
    }
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return /^[1-9][0-9]*$/.test(trimmed) ? trimmed : null;
  };

  const fundingConsumerIntentForPrepared = (
    prepared: PreparedTrade,
  ): FundingTradeConsumerIntent => {
    const intent = prepared.intent;
    const payload = isRecord(prepared.venuePayload)
      ? prepared.venuePayload
      : null;
    const marketId = intent.target.marketId;
    if (!payload || !marketId) {
      throw new TradingServiceError({
        code: "invalid_trade_request",
        message: "Funding reservation trade is missing normalized venue data.",
        statusCode: 409,
        venue: intent.venue,
      });
    }
    let marketContextId: string | null = null;
    let raw: string | null = null;
    let asset: Readonly<{
      networkId: string;
      assetId: string;
      decimals: number;
    }> | null = null;
    if (prepared.venue === "polymarket") {
      const order = isRecord(payload.orderPayload)
        ? payload.orderPayload
        : null;
      marketContextId =
        (typeof payload.tokenId === "string" && payload.tokenId) ||
        intent.target.tokenId ||
        null;
      raw = rawInteger(order?.makerAmount);
      asset = {
        networkId: "evm:137",
        assetId: env.polymarketUsdcAddress,
        decimals: 6,
      };
    } else if (prepared.venue === "limitless") {
      const order = isRecord(payload.orderPayload)
        ? payload.orderPayload
        : null;
      const tokenId =
        (typeof payload.tokenId === "string" && payload.tokenId) ||
        intent.target.tokenId ||
        null;
      marketContextId = tokenId
        ? normalizeLimitlessScopedTokenId(tokenId)
        : null;
      raw =
        payload.tradeType === "amm"
          ? rawInteger(payload.amountUsdRaw)
          : rawInteger(order?.makerAmount);
      asset = {
        networkId: "evm:8453",
        assetId: env.limitlessUsdcAddress,
        decimals: 6,
      };
    } else if (prepared.venue === "kalshi") {
      marketContextId = intent.target.tokenId ?? null;
      raw = rawInteger(payload.amountInRaw);
      asset = {
        networkId: "solana:mainnet",
        assetId: env.solanaUsdcMint,
        decimals: 6,
      };
    }
    if (!marketContextId || !raw || !asset) {
      throw new TradingServiceError({
        code: "invalid_trade_request",
        message:
          "Funding reservation trade is missing its exact normalized spend.",
        statusCode: 409,
        venue: intent.venue,
      });
    }
    return buildFundingTradeConsumerIntent({
      venueId: intent.venue,
      marketId,
      marketContextId,
      spend: { asset, raw },
    });
  };

  return {
    applyTradeEffects: (effectsInput) =>
      executorFor(effectsInput.intent.venue).applyTradeEffects(effectsInput),
    executePreparedTrade: async (executeInput) => {
      const intent: TradeIntent = { ...executeInput.prepared.intent };
      const prepared = { ...executeInput.prepared, intent };
      await assertReadyIntent(intent);
      let attemptId: string | null = null;
      let attemptClaimToken: string | null = null;
      try {
        const executed = await executorFor(
          executeInput.prepared.venue,
        ).executePreparedTrade({
          ...executeInput,
          prepared,
          onBeforeBroadcast: async () => {
            if (intent.fundingReservation) {
              if (!intent.target.marketId) {
                throw new TradingServiceError({
                  code: "invalid_trade_request",
                  message:
                    "Funding reservation trade is missing an exact market.",
                  statusCode: 409,
                  venue: intent.venue,
                });
              }
              const canonicalFingerprint = canonicalJsonHash({
                action: intent.action,
                amount: intent.amount,
                idempotencyKey: intent.idempotencyKey,
                reconcileKeys: prepared.reconcileKeys,
                target: {
                  marketId: intent.target.marketId,
                  outcome: intent.target.outcome,
                  tokenId: intent.target.tokenId,
                  venueMarketId: intent.target.venueMarketId,
                },
                venue: intent.venue,
              });
              const externalReference = [
                prepared.reconcileKeys.orderHash,
                prepared.reconcileKeys.clientOrderId,
                prepared.reconcileKeys.txHash,
                prepared.reconcileKeys.txSignature,
              ].find(
                (value): value is string =>
                  typeof value === "string" && value.trim().length >= 8,
              );
              const claim = await claimFundingTradeAttempt(input.pool, {
                userId: intent.actor.userId,
                operationId: intent.fundingReservation.operationId,
                reservationId: intent.fundingReservation.reservationId,
                venueId: intent.venue,
                marketId: intent.target.marketId,
                executionPath: executionPathFor(
                  executeInput.prepared.venue,
                  prepared.venuePayload,
                ),
                idempotencyKey: `trade:${canonicalJsonHash({
                  actor: intent.actor.userId,
                  key: intent.idempotencyKey,
                })}`,
                canonicalFingerprint,
                consumerIntent: fundingConsumerIntentForPrepared(prepared),
                externalReference,
              }).catch((error: unknown) => {
                if (!(error instanceof FundingTradeAttemptError)) throw error;
                throw new TradingServiceError({
                  code:
                    error.code === "reservation_unavailable"
                      ? "insufficient_readiness"
                      : "reconcile_required",
                  message: error.message,
                  statusCode: 409,
                  venue: intent.venue,
                });
              });
              if (!claim.claimed) {
                throw new TradingServiceError({
                  code: "reconcile_required",
                  message:
                    "This funding reservation already has a trade attempt that must reconcile.",
                  statusCode: 409,
                  venue: intent.venue,
                });
              }
              attemptId = claim.attempt.id;
              attemptClaimToken = claim.attempt.claimToken;
              intent.fundingTradeAttemptId = attemptId;
            }
            try {
              await executeInput.onBeforeBroadcast?.();
            } catch (error) {
              if (intent.fundingReservation && attemptId) {
                await releaseFundingReservationForDefinitiveTradeFailure(
                  input.pool,
                  {
                    userId: intent.actor.userId,
                    link: intent.fundingReservation,
                    tradeAttemptId: attemptId,
                    outcomeReason: "trade_pre_submit_failed",
                    errorCode: "pre_submit_failed",
                    broadcastMayHaveOccurred: false,
                  },
                );
                attemptId = null;
                attemptClaimToken = null;
                intent.fundingTradeAttemptId = null;
              }
              throw error;
            }
            if (intent.fundingReservation && attemptId && attemptClaimToken) {
              await markFundingTradeAttemptSubmissionStarted(input.pool, {
                userId: intent.actor.userId,
                operationId: intent.fundingReservation.operationId,
                reservationId: intent.fundingReservation.reservationId,
                attemptId,
                claimToken: attemptClaimToken,
              }).catch((error: unknown) => {
                if (!(error instanceof FundingTradeAttemptError)) throw error;
                throw new TradingServiceError({
                  code: "reconcile_required",
                  message: error.message,
                  statusCode: 409,
                  venue: intent.venue,
                });
              });
            }
          },
        });
        if (
          intent.fundingReservation &&
          attemptId &&
          ["cancelled", "failed", "no_fill"].includes(
            executed.submitResult.status,
          )
        ) {
          await releaseFundingReservationForDefinitiveTradeFailure(input.pool, {
            userId: intent.actor.userId,
            link: intent.fundingReservation,
            tradeAttemptId: attemptId,
            outcomeReason: `trade_${executed.submitResult.status}`,
            errorCode: `trade_${executed.submitResult.status}`,
            externalReference: externalReferenceFor(executed.submitResult),
            broadcastMayHaveOccurred: true,
          });
          attemptId = null;
          attemptClaimToken = null;
          intent.fundingTradeAttemptId = null;
        } else if (
          intent.fundingReservation &&
          attemptId &&
          executed.postSubmitError &&
          !executed.persisted
        ) {
          await recordFundingTradeAttemptOutcome(input.pool, {
            userId: intent.actor.userId,
            attemptId,
            outcome: "ambiguous",
            externalReference: externalReferenceFor(executed.submitResult),
            errorCode: executed.postSubmitError.code,
            broadcastMayHaveOccurred: true,
          });
        }
        return executed;
      } catch (error) {
        if (intent.fundingReservation && attemptId) {
          await recordFundingTradeAttemptOutcome(input.pool, {
            userId: intent.actor.userId,
            attemptId,
            outcome: "ambiguous",
            errorCode: "trade_submit_state_unknown",
            broadcastMayHaveOccurred: true,
          }).catch(() => {});
        }
        throw error;
      }
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
