import { tryRecordReferralFirstTradeConversion } from "./analytics-referrals.js";
import type {
  ApiTradingApplicationServiceInput,
  SupportedBotTradingVenue,
} from "./api-trading-types.js";
import {
  buildOrderNotification,
  createNotificationSafe,
} from "./notifications.js";
import { applyOptimisticPositionTradeOnce } from "./positions-optimistic.js";
import type {
  ApplyTradeEffectsInput,
  TradeEffectsResult,
} from "./trading-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPersistedRawField(
  input: ApplyTradeEffectsInput,
  field: string,
): string | null {
  const raw = isRecord(input.persisted.raw) ? input.persisted.raw : null;
  if (!raw) return null;
  return readString(raw[field]);
}

function readPersistedStoredOrder(input: ApplyTradeEffectsInput): {
  id: string | null;
  positionDeltaApplied: boolean;
} {
  const raw = isRecord(input.persisted.raw) ? input.persisted.raw : null;
  const stored = raw && isRecord(raw.stored) ? raw.stored : null;
  const order = stored && isRecord(stored.order) ? stored.order : null;
  return {
    id: readString(order?.id),
    positionDeltaApplied:
      order?.position_delta_applied === true ||
      order?.positionDeltaApplied === true,
  };
}

export async function applyOrderTradeEffects(
  ctx: ApiTradingApplicationServiceInput,
  input: ApplyTradeEffectsInput,
): Promise<TradeEffectsResult> {
  const tokenId =
    readPersistedRawField(input, "tokenId") ??
    input.intent.target.tokenId ??
    null;
  const walletAddress =
    readPersistedRawField(input, "walletAddress") ?? input.intent.walletAddress;
  const status = input.persisted.status;
  const venue = input.intent.venue as SupportedBotTradingVenue;
  const storedOrder = readPersistedStoredOrder(input);
  let referralFirstTrade = null;
  if (
    input.submitResult.status === "filled" &&
    input.submitResult.venueOrderId
  ) {
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
  let positionDeltaAlreadyClaimed = false;
  if (
    input.submitResult.status === "filled" &&
    !storedOrder.positionDeltaApplied &&
    storedOrder.id &&
    tokenId &&
    input.submitResult.size &&
    input.submitResult.price
  ) {
    try {
      const result = await applyOptimisticPositionTradeOnce(ctx.pool, {
        orderId: storedOrder.id,
        userId: input.intent.actor.userId,
        walletAddress,
        venue,
        tokenId,
        side: "BUY",
        shares: input.submitResult.size,
        notionalUsd: input.submitResult.size * input.submitResult.price,
      });
      positionDeltaApplied = result.applied;
      if (result.reason === "position_delta_already_applied") {
        positionDeltaAlreadyClaimed = true;
      }
    } catch (error) {
      ctx.logger?.warn?.(
        { error, intentId: input.intent.id },
        "Bot trading optimistic position update failed",
      );
    }
  }

  const shouldNotifyOrder =
    Boolean(input.submitResult.venueOrderId) &&
    input.submitResult.status !== "no_fill";
  if (shouldNotifyOrder) {
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
        walletAddress,
      }),
      ctx.logger as never,
    );
  }

  return {
    ok: true,
    notificationsCreated: shouldNotifyOrder ? 1 : 0,
    referralFirstTrade,
    positionDeltaApplied,
    raw: storedOrder.positionDeltaApplied
      ? { positionDeltaAlreadyApplied: true }
      : positionDeltaAlreadyClaimed
        ? { positionDeltaAlreadyClaimed: true }
        : undefined,
  };
}
