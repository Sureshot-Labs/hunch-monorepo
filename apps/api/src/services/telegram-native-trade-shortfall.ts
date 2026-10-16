import type {
  FundingDiscoveryRequest,
  JsonObject,
  Money,
} from "../funding/domain/types.js";
import { sameAsset } from "../funding/domain/asset-identity.js";
import { HYPERCORE_MAINNET_USDC } from "../funding/domain/hypercore-identity.js";
import {
  parseTelegramAppHandoffNativeTrade,
  telegramAppHandoffNativeRequestedAmounts,
} from "./telegram-app-handoff-native-trade.js";

/** The ordinary native quote owns the required debit (including its fee cap).
 * Telegram retains those exact cash8 atoms; it must not reconstruct them from
 * display dollars, requested size or the legacy USD6 bot-funding identity.
 * This is client execution only, never a delegated bot funding grant. */
export type TelegramNativeTradeShortfallIdentity = Readonly<{
  userId: string;
  requiredSpend: Money;
  maxFeeUsd: string;
  maxSlippageBps: number;
  deadline: string;
}>;

export function buildTelegramNativeTradeShortfallRequest(
  input: TelegramNativeTradeShortfallIdentity,
  trade: JsonObject,
): FundingDiscoveryRequest {
  const native = parseTelegramAppHandoffNativeTrade(trade);
  const spend = input.requiredSpend;
  if (
    !native ||
    native.side !== "BUY" ||
    !sameAsset(spend.asset, HYPERCORE_MAINNET_USDC) ||
    !/^[1-9]\d{0,127}$/u.test(spend.raw) ||
    BigInt(spend.raw) <
      telegramAppHandoffNativeRequestedAmounts(native).grossQuoteRaw ||
    BigInt(spend.raw) > BigInt(native.consentedDebitCapRaw)
  )
    throw new Error("hip4_handoff_funding_scope_invalid");
  const marketContextId = native.outcomeTokenId.slice("hyperliquid:".length);
  return {
    purpose: "trade_shortfall",
    // The future app must attest its own connected external source wallets.
    // A Telegram callback is not such an attestation.
    connectedExternalWalletRefs: [],
    requestedDestinationAmount: {
      asset: HYPERCORE_MAINNET_USDC,
      raw: spend.raw,
    },
    confirmedSourceAmount: null,
    marketContextId,
    consumerIntent: {
      venueId: "hyperliquid",
      marketId: native.marketId,
      marketContextId,
      side: "BUY",
      spend: { asset: HYPERCORE_MAINNET_USDC, raw: spend.raw },
    },
    controllerWalletRef: native.controllerWalletRef,
    destinationOptionId: null,
    withdrawalRecipientId: null,
    venueBindingOptionId: null,
    maxFeeUsd: input.maxFeeUsd,
    maxSlippageBps: input.maxSlippageBps,
    deadline: input.deadline,
  };
}
