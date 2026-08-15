#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { AssetRef, SourceOption } from "./funding/domain/types.js";
import {
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
} from "./funding/execution/delegated-funding-profile-ids.js";
import {
  BASE_USDC,
  POLYGON_PUSD,
} from "./funding-providers/relay/rehearsal.js";
import { resolveTelegramTradeShortfallExecutionProfile } from "./services/telegram-trade-shortfall-funding.js";

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

console.log(
  "[telegram-trade-shortfall-funding-tests] Slice C and bidirectional Relay profile selection passed",
);
