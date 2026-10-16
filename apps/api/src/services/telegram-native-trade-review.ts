import type { Pool } from "@hunch/infra";
import { z } from "zod";
import type { JsonObject } from "../funding/domain/types.js";
import { HYPERCORE_MAINNET_USDC } from "../funding/domain/hypercore-identity.js";
import type { ApiTradeMarket } from "./api-trading-market-repo.js";
import {
  quoteHip4MarketOrderWithCurrentContext,
  type Hip4OrderRuntimeDependencies,
} from "./hip4-order-runtime.js";
import {
  hip4MarketOrderQuoteRequestSchema,
  type Hip4MarketOrderQuoteRequest,
} from "./hip4-market-order.js";
import { buildTelegramAppHandoffNativeAuthority } from "./telegram-app-handoff-native-authority.js";
import { telegramAppHandoffNativeTradeSchema } from "./telegram-app-handoff-native-trade.js";

export const telegramNativeTradeReviewDraftSchema = z
  .object({ version: z.literal(1), request: hip4MarketOrderQuoteRequestSchema })
  .strict();

export function readTelegramNativeTradeReviewDraft(
  result: Record<string, unknown>,
) {
  const parsed = telegramNativeTradeReviewDraftSchema.safeParse(
    result.nativeReviewDraft,
  );
  return parsed.success ? parsed.data : null;
}

/** API-owned, read-only producer adapter. Native Telegram Review is a user
 * app order, so it quotes through the ordinary web IOC implementation. It
 * never invokes the legacy bot quote, creates a preparation/nonce, reserves,
 * signs, submits or provisions a bot signer. */
export async function quoteTelegramNativeTradeReview(
  pool: Pool,
  input: {
    userId: string;
    telegramAccountLinkId: string;
    market: ApiTradeMarket;
    request: Hip4MarketOrderQuoteRequest;
  },
  dependencies: Hip4OrderRuntimeDependencies & {
    quote?: typeof quoteHip4MarketOrderWithCurrentContext;
  } = {},
) {
  const { market, request } = input;
  const outcomeTokenId =
    request.outcomeSide === "YES" ? market.token_yes : market.token_no;
  if (
    market.venue !== "hyperliquid" ||
    market.id !== request.marketId ||
    !outcomeTokenId ||
    !/^hyperliquid:mainnet:(question|outcome):(0|[1-9]\d*)$/u.test(
      market.event_id,
    )
  )
    throw new Error("hip4_handoff_market_changed");
  const quoted = await (
    dependencies.quote ?? quoteHip4MarketOrderWithCurrentContext
  )(pool, { userId: input.userId, actor: "web_app", request }, dependencies);
  const authority = buildTelegramAppHandoffNativeAuthority({
    userId: input.userId,
    telegramAccountLinkId: input.telegramAccountLinkId,
    profile: quoted.profile,
  });
  const prepared = quoted.preparationRequest;
  const nativeTrade = telegramAppHandoffNativeTradeSchema.parse({
    version: "hip4-ioc-v1",
    environment: "mainnet",
    marketId: prepared.marketId,
    outcomeTokenId,
    outcomeSide: prepared.outcomeSide,
    controllerWalletRef: prepared.controllerWalletRef,
    side: prepared.side,
    timeInForce: prepared.timeInForce,
    quantity: prepared.quantity,
    limitPrice: prepared.limitPrice,
    consentedDebitCapRaw: prepared.consentedDebitCapRaw,
  });
  if (
    nativeTrade.marketId !== request.marketId ||
    nativeTrade.outcomeSide !== request.outcomeSide ||
    nativeTrade.side !== request.side ||
    nativeTrade.controllerWalletRef !== authority.controllerWalletRef ||
    nativeTrade.controllerWalletRef !==
      request.controllerWalletRef.toLowerCase() ||
    nativeTrade.consentedDebitCapRaw !== request.consentedDebitCapRaw
  )
    throw new Error("hip4_handoff_quote_scope_changed");
  const trade: JsonObject = {
    action: nativeTrade.side.toLowerCase(),
    controllerWalletAddress: authority.walletAddress,
    eventId: market.event_id,
    eventTitle: market.event_title,
    marketId: market.id,
    marketTitle: market.title,
    outcomeTokenId,
    side: nativeTrade.outcomeSide,
    venue: "hyperliquid",
    nativeTrade,
  };
  const quoteSnapshot: JsonObject = {
    version: "hip4-ioc-v1",
    nativeTrade,
    amounts: quoted.amounts,
    feeQuote: quoted.feeQuote,
    executionEstimate: quoted.executionEstimate,
    expiresAt: new Date(quoted.expiresAfter).toISOString(),
  };
  return {
    authority,
    trade,
    quoteSnapshot,
    requiredSpend:
      nativeTrade.side === "BUY"
        ? { asset: HYPERCORE_MAINNET_USDC, raw: quoted.amounts.debitCapRaw }
        : null,
    expiresAt: new Date(quoted.expiresAfter),
  };
}
