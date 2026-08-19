#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { AssetRef, SourceOption } from "./funding/domain/types.js";
import {
  POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_USDC_PROFILE_ID,
} from "./funding/execution/delegated-funding-profile-ids.js";
import {
  BASE_USDC,
  POLYGON_PUSD,
  POLYGON_USDCE_LEGACY,
} from "./funding-providers/relay/rehearsal.js";
import {
  assertTelegramTradeShortfallDelegatedRelayActionTtl,
  buildTelegramTradeShortfallCommitRequest,
  buildTelegramTradeShortfallRequest,
  resolveTelegramTradeShortfallCommitAmounts,
  resolveTelegramTradeShortfallExecutionProfile,
  selectTelegramTradeShortfallAutomatedOption,
  telegramTradeShortfallExecutionProfiles,
} from "./services/telegram-trade-shortfall-funding.js";
import { isTelegramPolymarketRouterContinuationPending } from "./funding/reconciliation/telegram-router-continuation-state.js";

assert.equal(
  isTelegramPolymarketRouterContinuationPending({
    continuationId: null,
    operationStatus: "ready",
    progressStage: "ready_for_consumer",
    rootRequiresRouterContinuation: true,
    venue: "polymarket",
  }),
  true,
  "a ready Relay root is still intermediate until its Polymarket Router child exists",
);
assert.equal(
  isTelegramPolymarketRouterContinuationPending({
    continuationId: null,
    operationStatus: "ready",
    progressStage: "ready_for_consumer",
    rootRequiresRouterContinuation: true,
    venue: "limitless",
  }),
  false,
  "a direct Limitless Relay route must not wait for a Polymarket Router child",
);

const polygonPusd: AssetRef = {
  networkId: "evm:137",
  assetId: POLYGON_PUSD,
  decimals: 6,
};
const baseUsdc: AssetRef = {
  networkId: "evm:8453",
  assetId: BASE_USDC,
  decimals: 6,
};
const polygonUsdce: AssetRef = {
  networkId: "evm:137",
  assetId: POLYGON_USDCE_LEGACY,
  decimals: 6,
};

const exactTopUpRequest = buildTelegramTradeShortfallRequest({
  authorizationId: "authorization_shortfall_fixture_12345678",
  telegramAccountId: "telegram_account_fixture_12345678",
  telegramUserId: "telegram_user_fixture_12345678",
  tradeIntentId: "trade_intent_fixture_12345678",
  userId: "user_shortfall_fixture_12345678",
  venue: "polymarket",
  marketId: "polymarket:3192057",
  marketContextId: "market_context_shortfall_fixture_12345678",
  side: "YES",
  maximumSpendUsd: "14.201601",
  additionalFundingUsd: "0.50",
  maxFeeUsd: "14.201601",
  maxSlippageBps: 500,
  deadline: "2026-08-17T12:38:00.000Z",
});
assert.equal(exactTopUpRequest.requestedDestinationAmount?.raw, "14201601");
assert.equal(
  exactTopUpRequest.serverAdditionalDestinationAmount?.raw,
  "500000",
  "Telegram must plan the consumer-confirmed top-up rather than recomputing shortfall from Deposit Wallet cash only",
);

const replayedExactTopUpRequest = buildTelegramTradeShortfallRequest({
  authorizationId: "authorization_shortfall_fixture_12345678",
  telegramAccountId: "telegram_account_fixture_12345678",
  telegramUserId: "telegram_user_fixture_12345678",
  tradeIntentId: "trade_intent_fixture_12345678",
  userId: "user_shortfall_fixture_12345678",
  venue: "polymarket",
  marketId: "polymarket:3192057",
  marketContextId: "market_context_shortfall_fixture_12345678",
  side: "YES",
  maximumSpendUsd: "14.201601",
  additionalFundingRaw: "500000",
  maxFeeUsd: "14.201601",
  maxSlippageBps: 500,
  deadline: "2026-08-17T12:38:00.000Z",
});
assert.equal(
  replayedExactTopUpRequest.serverAdditionalDestinationAmount?.raw,
  "500000",
  "a durable proposal must replay the exact raw shortfall rather than recomputing it from the full trade cap",
);

const committedExactTopUpRequest = buildTelegramTradeShortfallCommitRequest(
  {
    authorizationId: "authorization_shortfall_fixture_12345678",
    telegramAccountId: "telegram_account_fixture_12345678",
    telegramUserId: "telegram_user_fixture_12345678",
    tradeIntentId: "trade_intent_fixture_12345678",
    userId: "user_shortfall_fixture_12345678",
    venue: "polymarket",
    marketId: "polymarket:3192057",
    marketContextId: "market_context_shortfall_fixture_12345678",
    side: "YES",
    maximumSpendUsd: "14.201601",
    maxFeeUsd: "14.201601",
    maxSlippageBps: 500,
    deadline: "2026-08-17T12:38:00.000Z",
  },
  {
    requestedDestinationAmount: {
      asset: polygonPusd,
      raw: "14201601",
    },
    serverAdditionalDestinationAmount: {
      asset: polygonPusd,
      raw: "500000",
    },
    serverExecutionProfileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  },
);
assert.equal(
  committedExactTopUpRequest.serverAdditionalDestinationAmount?.raw,
  "500000",
  "commit must preserve the proposal's trusted top-up even though its full consumer spend is $14.201601",
);

const committedExactTopUpAmounts = resolveTelegramTradeShortfallCommitAmounts(
  {
    authorizationId: "authorization_shortfall_fixture_12345678",
    telegramAccountId: "telegram_account_fixture_12345678",
    telegramUserId: "telegram_user_fixture_12345678",
    tradeIntentId: "trade_intent_fixture_12345678",
    userId: "user_shortfall_fixture_12345678",
    venue: "polymarket",
    marketId: "polymarket:3192057",
    marketContextId: "market_context_shortfall_fixture_12345678",
    side: "YES",
    maximumSpendUsd: "14.201601",
    maxFeeUsd: "14.201601",
    maxSlippageBps: 500,
    deadline: "2026-08-17T12:38:00.000Z",
  },
  {
    requestedDestinationAmount: {
      asset: polygonPusd,
      raw: "14201601",
    },
    serverAdditionalDestinationAmount: {
      asset: polygonPusd,
      raw: "500000",
    },
    serverExecutionProfileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  },
);
assert.equal(
  committedExactTopUpAmounts.tradeDestinationAmount.raw,
  "14201601",
  "the trade ceiling remains bound to the proposal",
);
assert.equal(
  committedExactTopUpAmounts.fundingDestinationAmount.raw,
  "500000",
  "the frozen source option must be re-quoted with its exact funding leg, not the full trade ceiling",
);

const sequentialTtlNow = new Date("2026-08-17T12:00:00.000Z");
assert.throws(
  () =>
    assertTelegramTradeShortfallDelegatedRelayActionTtl({
      profileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
      now: sequentialTtlNow,
      plan: {
        segments: [
          {
            providerId: "relay",
            quoteExpiresAt: new Date(
              sequentialTtlNow.getTime() + 30_000,
            ).toISOString(),
          },
        ],
        steps: [],
      },
    }),
  /lacks sequential execution TTL/u,
  "shortfall must fail before commit when Relay cannot retain the approve-to-deposit window",
);
assert.doesNotThrow(
  () =>
    assertTelegramTradeShortfallDelegatedRelayActionTtl({
      profileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
      now: sequentialTtlNow,
      plan: {
        segments: [
          {
            providerId: "relay",
            quoteExpiresAt: new Date(
              sequentialTtlNow.getTime() + 45_000,
            ).toISOString(),
          },
        ],
        steps: [],
      },
    }),
  "the exact configured sequential window remains admissible",
);

assert.throws(
  () =>
    buildTelegramTradeShortfallCommitRequest(
      {
        authorizationId: "authorization_shortfall_fixture_12345678",
        telegramAccountId: "telegram_account_fixture_12345678",
        telegramUserId: "telegram_user_fixture_12345678",
        tradeIntentId: "trade_intent_fixture_12345678",
        userId: "user_shortfall_fixture_12345678",
        venue: "polymarket",
        marketId: "polymarket:3192057",
        marketContextId: "market_context_shortfall_fixture_12345678",
        side: "YES",
        maximumSpendUsd: "14.201601",
        maxFeeUsd: "14.201601",
        maxSlippageBps: 500,
        deadline: "2026-08-17T12:38:00.000Z",
      },
      {
        requestedDestinationAmount: {
          asset: polygonPusd,
          raw: "14201601",
        },
        serverAdditionalDestinationAmount: {
          asset: polygonPusd,
          raw: "0",
        },
        serverExecutionProfileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
      },
    ),
  /exact shortfall/u,
  "missing or zero stored top-up must fail closed rather than using the full trade cap",
);

function option(
  source: SourceOption["source"],
  destination: AssetRef,
  sourceAsset?: AssetRef,
): SourceOption {
  return {
    sourceOptionId: "source_shortfall_fixture_12345678",
    kind:
      source.kind === "venue_preparation"
        ? "venue_preparation"
        : "wallet_asset",
    safeLabel: "Existing Hunch balance",
    source,
    ...(sourceAsset &&
    (source.kind === "owned_location" ||
      source.kind === "external_ingress" ||
      source.kind === "venue_preparation")
      ? {
          sourceLegs: [
            {
              sourceLegId: "source_leg_shortfall_fixture_12345678",
              safeLabel: "Funding source",
              source,
              sourceAmount: { asset: sourceAsset, raw: "1000000" },
              expectedDestination: { asset: destination, raw: "1000000" },
              minimumDestination: { asset: destination, raw: "990000" },
              fees: [],
              eta: { minSeconds: 1, maxSeconds: 30 },
              requiredActions: [],
            },
          ],
        }
      : {}),
    amountMode: "exact_output",
    maximumSourceRaw: "1000000",
    expectedDestination: { asset: destination, raw: "1000000" },
    minimumDestination: { asset: destination, raw: "990000" },
    estimatedUsd: "1",
    fees: [],
    eta: { minSeconds: 1, maxSeconds: 30 },
    experienceMode: "prepare_first",
    requiredActions: [],
    expiresAt: "2026-08-15T23:59:59.000Z",
    recommended: true,
    selectable: true,
    reasonCodes: [],
  };
}

assert.equal(
  resolveTelegramTradeShortfallExecutionProfile(
    option(
      {
        kind: "venue_preparation",
        venueId: "polymarket",
        venueBindingId: "binding_polymarket_fixture_12345678",
        inputCount: 1,
      },
      polygonPusd,
      polygonUsdce,
    ),
    "polymarket",
    polygonPusd,
  ),
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  "Polygon USDC.e preparation must use Slice C instead of Relay",
);

assert.equal(
  resolveTelegramTradeShortfallExecutionProfile(
    option(
      {
        kind: "venue_preparation",
        venueId: "polymarket",
        venueBindingId: "binding_polymarket_fixture_12345678",
        inputCount: 1,
      },
      polygonPusd,
      polygonPusd,
    ),
    "polymarket",
    polygonPusd,
  ),
  POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
  "controller Polygon pUSD preparation must use the exact Funding Router profile",
);

assert.equal(
  resolveTelegramTradeShortfallExecutionProfile(
    option(
      {
        kind: "owned_location",
        location: {
          kind: "wallet",
          locationId: "location_base_usdc_fixture_12345678",
          accountId: "account_fixture_12345678",
          asset: baseUsdc,
          details: {},
        },
      },
      polygonPusd,
    ),
    "polymarket",
    polygonPusd,
  ),
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  "Base USDC to Polymarket remains the existing Slice D Relay profile",
);

assert.deepEqual(
  telegramTradeShortfallExecutionProfiles("polymarket", polygonPusd),
  [
    POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
    POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
    TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
    TELEGRAM_RELAY_POLYGON_USDC_PROFILE_ID,
  ],
  "Telegram must plan each exact Polymarket execution profile before considering manual Deposit",
);

assert.equal(
  resolveTelegramTradeShortfallExecutionProfile(
    option(
      {
        kind: "owned_location",
        location: {
          kind: "venue_account",
          locationId: "location_polygon_pusd_fixture_12345678",
          accountId: "account_fixture_12345678",
          asset: polygonPusd,
          details: { venueId: "polymarket" },
        },
      },
      baseUsdc,
    ),
    "limitless",
    baseUsdc,
  ),
  TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
  "Polymarket pUSD to Limitless remains the reverse Relay profile",
);

const depositWalletHandoff = {
  ...option(
    {
      kind: "owned_location" as const,
      location: {
        kind: "wallet" as const,
        locationId: "location_polygon_controller_fixture_12345678",
        accountId: "account_fixture_12345678",
        asset: polygonPusd,
        details: {},
      },
    },
    baseUsdc,
  ),
  requiredActions: [
    {
      kind: "external_handoff" as const,
      safeLabel: "Move Polymarket Deposit Wallet funds",
      actor: "user" as const,
      valueMoving: true,
      sponsorship: "none" as const,
    },
  ],
};
assert.equal(
  resolveTelegramTradeShortfallExecutionProfile(
    depositWalletHandoff,
    "limitless",
    baseUsdc,
  ),
  null,
  "Deposit Wallet handoff must not be advertised as unattended Relay execution",
);

const managedControllerRoute = {
  ...option(
    {
      kind: "owned_location" as const,
      location: {
        kind: "venue_account" as const,
        locationId: "location_polygon_controller_automatic_12345678",
        accountId: "account_fixture_12345678",
        asset: polygonPusd,
        details: { venueId: "polymarket" },
      },
    },
    baseUsdc,
  ),
  sourceOptionId: "source_controller_automatic_12345678",
  recommended: false,
};
const preferredDepositWalletHandoff = {
  ...depositWalletHandoff,
  sourceOptionId: "source_deposit_wallet_handoff_12345678",
  recommended: true,
};
assert.equal(
  selectTelegramTradeShortfallAutomatedOption({
    options: [preferredDepositWalletHandoff, managedControllerRoute],
    venue: "limitless",
    destination: baseUsdc,
    requiredProfileId: TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
  })?.option.sourceOptionId,
  managedControllerRoute.sourceOptionId,
  "delegated replanning must retain an automatable managed-wallet route when a Deposit Wallet handoff becomes recommended",
);

const unsupportedCompositeRoute = {
  ...option(
    {
      kind: "composite" as const,
      legCount: 2,
    },
    polygonPusd,
  ),
  sourceOptionId: "source_composite_requires_manual_fallback_12345678",
  sourceLegs: [
    {
      sourceLegId: "source_leg_polygon_pusd_12345678",
      safeLabel: "Polygon pUSD",
      sourceAmount: { asset: polygonPusd, raw: "300000" },
      expectedDestination: { asset: polygonPusd, raw: "300000" },
      minimumDestination: { asset: polygonPusd, raw: "300000" },
      source: {
        kind: "owned_location" as const,
        location: {
          kind: "wallet" as const,
          locationId: "location_polygon_pusd_12345678",
          accountId: "account_fixture_12345678",
          asset: polygonPusd,
          details: {},
        },
      },
      fees: [],
      eta: { minSeconds: 1, maxSeconds: 30 },
      requiredActions: [],
    },
    {
      sourceLegId: "source_leg_polygon_usdce_12345678",
      safeLabel: "Polygon USDC.e",
      sourceAmount: {
        asset: {
          networkId: "evm:137",
          assetId: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
          decimals: 6,
        },
        raw: "300000",
      },
      expectedDestination: { asset: polygonPusd, raw: "300000" },
      minimumDestination: { asset: polygonPusd, raw: "300000" },
      source: {
        kind: "owned_location" as const,
        location: {
          kind: "wallet" as const,
          locationId: "location_polygon_usdce_12345678",
          accountId: "account_fixture_12345678",
          asset: {
            networkId: "evm:137",
            assetId: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            decimals: 6,
          },
          details: {},
        },
      },
      fees: [],
      eta: { minSeconds: 1, maxSeconds: 30 },
      requiredActions: [],
    },
  ],
};
assert.equal(
  selectTelegramTradeShortfallAutomatedOption({
    options: [unsupportedCompositeRoute],
    venue: "polymarket",
    destination: polygonPusd,
  }),
  null,
  "a composite without one exact delegated profile must fall back to the verified Deposit flow instead of being treated as a retryable planner outage",
);

console.log(
  "[telegram-trade-shortfall-funding-tests] Slice C and bidirectional Relay profile selection passed",
);
