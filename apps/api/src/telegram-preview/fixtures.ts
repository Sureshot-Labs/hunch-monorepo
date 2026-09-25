import type { TelegramPositionDetail } from "../services/telegram-bot-positions.js";
import type { AccountValueReadModel } from "../account-value/runtime-service.js";
import {
  projectAccountValue,
  resolveEffectiveHeadline,
} from "../account-value/account-value-projector.js";
import { projectCashAvailability } from "../account-value/cash-availability-projector.js";
import { fundingSidecarRuntimeConfig } from "../funding/runtime/sidecar-runtime-config.js";
import type { ValuedAssetComponent } from "../funding/domain/types.js";
import { telegramBotRewardsTestHooks } from "../services/telegram-bot-rewards.js";
import { AS_OF, ID, market } from "./trading.js";

export function position(
  redemptionStatus = "market_open",
): TelegramPositionDetail {
  return {
    averagePrice: 0.25,
    currentValueUsd: 41,
    eventId: market.event_id,
    eventTitle: market.event_title,
    marketId: market.id,
    marketOrderable: redemptionStatus === "market_open",
    marketTitle: market.title,
    markPrice: 0.41,
    pnlPercent: 64,
    pnlUsd: 16,
    redemptionStatus,
    side: "YES",
    position: {
      id: ID,
      userId: ID,
      averagePrice: 0.25,
      createdAt: new Date(AS_OF),
      lastUpdatedAt: new Date(AS_OF),
      updatedAt: new Date(AS_OF),
      realizedPnl: 0,
      unrealizedPnl: 16,
      side: "LONG",
      size: 100,
      tokenId: "111",
      venue: "polymarket",
      walletAddress: "0x0000000000000000000000000000000000000000",
    },
  };
}

export function account(): AccountValueReadModel {
  const components: ValuedAssetComponent[] = [
    {
      networkId: "evm:137",
      assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
      venueId: "polymarket",
      value: "125",
    },
    {
      networkId: "evm:8453",
      assetId: fundingSidecarRuntimeConfig.limitlessUsdcAddress,
      venueId: "limitless",
      value: "50",
    },
  ].map((item) => {
    const asset = {
      assetId: item.assetId,
      networkId: item.networkId,
      decimals: 6,
    };
    return {
      amount: { asset, raw: String(Number(item.value) * 1e6) },
      category: "cash",
      componentId: item.venueId,
      estimatedUsd: {
        asOf: AS_OF,
        confidence: "high",
        policyId: "exact-stable",
        priceSource: "demo",
        value: item.value,
      },
      executionEligibility: "eligible",
      location: {
        accountId: ID,
        asset,
        details: { venueId: item.venueId, balanceClass: item.venueId },
        kind: "venue_account",
        locationId: item.venueId,
      },
      observationError: null,
      observationFreshness: "fresh",
      observedAt: AS_OF,
      reasonCodes: [],
      valuationEligibility: "included",
    };
  });
  const projection = projectAccountValue({
    accountId: ID,
    asOf: AS_OF,
    collectorErrors: [],
    components,
    headlineMode: "liquid_only",
    positionComponents: [],
  });
  const cashAvailability = projectCashAvailability({
    adjustments: components.map((c) => ({
      componentId: c.componentId,
      lockedRaw: "0",
      reservedRaw: "0",
      submittedDebitRaw: "0",
      venueBindingId: c.componentId,
      venueId: c.componentId,
    })),
    asOf: AS_OF,
    collectorErrors: [],
    components,
  });
  const balance = (value: string) => ({
    cashAvailableEstimatedUsd: value,
    cashEstimatedUsd: value,
    positionsEstimatedUsd: "0",
    totalPortfolioEstimatedUsd: value,
  });
  return {
    assetPreferences: {},
    cashAvailability,
    duplicateAssetObservationCount: 0,
    headline: resolveEffectiveHeadline(projection),
    ownershipEvidenceRevision: "demo",
    policy: {
      creationMode: "on",
      invalidStoredPolicy: false,
      revision: "demo",
      source: "db",
    },
    projection,
    venues: {
      polymarket: balance("125"),
      limitless: balance("50"),
      kalshi: balance("0"),
    },
  };
}

export const rewards: Parameters<
  typeof telegramBotRewardsTestHooks.buildOverviewMessage
>[0]["summary"] = {
  cashback: {
    bps: 2500,
    byChain: { "137": { claimable: 8.26, collected: 12, pending: 1 } },
    claimable: 8.26,
    collected: 12,
    pending: 1,
  },
  clout: {
    points: 312,
    qualificationPoints: 312,
    tierPoints: 312,
    volumeUsd: 312,
  },
  inboundReferral: null,
  multiplier: {
    asOf: new Date(AS_OF),
    label: null,
    referralCode: null,
    source: "global",
    value: 1,
  },
  nextTier: { cashbackBps: 2500, name: "Observer", points: 500, tier: 1 },
  policy: {
    effectiveAt: null,
    referralBonus: [{ bonusBps: 500, minReferrals: 3 }],
    referralQualification: { pointsRequired: 500 },
    tiers: [
      { cashbackBps: 0, name: "Novice", points: 0, tier: 0 },
      { cashbackBps: 2500, name: "Observer", points: 500, tier: 1 },
    ],
  },
  progress: { pct: 0.624, remaining: 188 },
  referralBonus: {
    bonusBps: 500,
    byChain: { "137": { collected: 4.18, pending: 1.1 } },
    collected: 4.18,
    pending: 1.1,
    qualifiedCount: 3,
  },
  tier: { cashbackBps: 0, name: "Novice", points: 0, tier: 0 },
};
