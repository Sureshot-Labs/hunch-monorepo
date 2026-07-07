import { tryRecordReferralFirstTradeConversion } from "./analytics-referrals.js";
import type {
  ApiTradingApplicationServiceInput,
  SupportedBotTradingVenue,
} from "./api-trading-types.js";
import {
  buildOrderNotification,
  createNotificationSafe,
} from "./notifications.js";
import { applyOptimisticPositionTrade } from "./positions-optimistic.js";
import type {
  ApplyTradeEffectsInput,
  TradeEffectsResult,
} from "./trading-types.js";

export async function applyOrderTradeEffects(
  ctx: ApiTradingApplicationServiceInput,
  input: ApplyTradeEffectsInput,
): Promise<TradeEffectsResult> {
  const tokenId = input.intent.target.tokenId ?? null;
  const status = input.persisted.status;
  const venue = input.intent.venue as SupportedBotTradingVenue;
  let referralFirstTrade = null;
  if (input.submitResult.status === "filled" && input.submitResult.venueOrderId) {
    referralFirstTrade = await tryRecordReferralFirstTradeConversion(ctx.pool, {
      userId: input.intent.actor.userId,
      venue,
      status,
      sourceType: "order",
      sourceId: input.submitResult.venueOrderId,
      txHash: input.submitResult.orderHash ?? null,
      logger: ctx.logger,
    });
  }

  let positionDeltaApplied = false;
  if (
    input.submitResult.status === "filled" &&
    tokenId &&
    input.submitResult.size &&
    input.submitResult.price
  ) {
    try {
      const result = await applyOptimisticPositionTrade(ctx.pool, {
        userId: input.intent.actor.userId,
        walletAddress: input.intent.walletAddress,
        venue,
        tokenId,
        side: "BUY",
        shares: input.submitResult.size,
        notionalUsd: input.submitResult.size * input.submitResult.price,
      });
      positionDeltaApplied = result.applied;
    } catch (error) {
      ctx.logger?.warn?.(
        { error, intentId: input.intent.id },
        "Bot trading optimistic position update failed",
      );
    }
  }

  if (input.submitResult.venueOrderId) {
    void createNotificationSafe(
      ctx.pool,
      buildOrderNotification({
        userId: input.intent.actor.userId,
        venue,
        status,
        side: "BUY",
        size: input.submitResult.size,
        price: input.submitResult.price,
        orderId: input.submitResult.venueOrderId,
        tokenId,
        walletAddress: input.intent.walletAddress,
      }),
      ctx.logger as never,
    );
  }

  return {
    ok: true,
    notificationsCreated: input.submitResult.venueOrderId ? 1 : 0,
    referralFirstTrade,
    positionDeltaApplied,
  };
}
