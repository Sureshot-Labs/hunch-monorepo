#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { AssetRef, SourceOption } from "./funding/domain/types.js";
import {
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_USDC_PROFILE_ID,
} from "./funding/execution/delegated-funding-profile-ids.js";
import {
  BASE_USDC,
  POLYGON_PUSD,
} from "./funding-providers/relay/rehearsal.js";
import {
  buildTelegramTradeShortfallRequest,
  resolveTelegramTradeShortfallExecutionProfile,
  selectTelegramTradeShortfallAutomatedOption,
  telegramTradeShortfallExecutionProfiles,
} from "./services/telegram-trade-shortfall-funding.js";

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

function option(
  source: SourceOption["source"],
  destination: AssetRef,
): SourceOption {
  return {
    sourceOptionId: "source_shortfall_fixture_12345678",
    kind:
      source.kind === "venue_preparation"
        ? "venue_preparation"
        : "wallet_asset",
    safeLabel: "Existing Hunch balance",
    source,
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
