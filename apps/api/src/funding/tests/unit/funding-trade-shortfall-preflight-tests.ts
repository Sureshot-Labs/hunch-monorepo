#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { AccountValueReadModel } from "../../../account-value/runtime-service.js";
import type {
  FundingDiscoveryRequest,
  IntentLiquidityProjection,
} from "../../domain/types.js";
import { POLYGON_PUSD } from "../../../funding-providers/relay/rehearsal.js";
import {
  deriveTrustedTradeShortfallRequest,
  preflightTrustedTradeShortfall,
} from "../../planner/trade-shortfall-preflight.js";
import { fundingDestinationAmountForRequest } from "../../planner/trade-shortfall-amount.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const CONTROLLER_WALLET_ID = "20000000-0000-4000-8000-000000000002";
const REQUESTED_DESTINATION_AMOUNT = {
  asset: {
    networkId: "evm:137",
    assetId: POLYGON_PUSD,
    decimals: 6,
  },
  raw: "14201601",
} as const;
const POLYGON_PROFILE = {
  walletId: "wallet_profile_12345678",
  controllerWalletRef: CONTROLLER_WALLET_ID,
  networkId: "evm:137",
  address: "0x09c88f1d3cdd98c356a21434cd4af40cce795314",
  source: "embedded",
  signingModes: ["privy_authorization"],
  serverWalletRef: "privy_wallet_12345678",
  sponsorshipPolicyIds: [],
} as const;
const REQUEST: FundingDiscoveryRequest = {
  purpose: "trade_shortfall",
  requestedDestinationAmount: REQUESTED_DESTINATION_AMOUNT,
  confirmedSourceAmount: null,
  marketContextId: "token-yes",
  consumerIntent: {
    venueId: "polymarket",
    marketId: "polymarket:market-1",
    marketContextId: "token-yes",
    side: "BUY",
    spend: {
      asset: {
        networkId: "evm:137",
        assetId: POLYGON_PUSD,
        decimals: 6,
      },
      raw: "14201601",
    },
  },
  destinationOptionId: "destination_poly_12345678",
  withdrawalRecipientId: null,
  venueBindingOptionId: "binding_poly_12345678",
  controllerWalletRef: CONTROLLER_WALLET_ID,
  maxFeeUsd: null,
  maxSlippageBps: null,
  deadline: null,
};

function readiness(controlledFundsRaw: string) {
  return {
    ready: true,
    executable: true,
    reasonCode: null,
    message: null,
    setupRequired: false,
    capabilities: {
      venue: "polymarket" as const,
      supportsBuy: true,
      supportsSell: true,
      supportsCancel: true,
      supportsOrderSync: true,
      supportsPositionSync: true,
      supportsExecutionSync: true,
      supportsSetup: true,
      authorizationModes: [],
    },
    raw: {
      kind: "polymarket_funds_v1",
      controlledFundsRaw,
      executableFundsRaw: "12407208",
    },
  };
}

function projection(): IntentLiquidityProjection {
  return {
    liquidityProjectionId: "projection_00000000-0000-4000-8000-000000000001",
    marketContextId: "token-yes",
    venueId: "polymarket",
    venueBindingOptionId: "binding_poly_12345678",
    destinationOptionId: "destination_poly_12345678",
    collateralAsset: REQUESTED_DESTINATION_AMOUNT.asset,
    requestedCollateralRaw: "14201601",
    availableNowRaw: "12407208",
    shortfallRaw: "500000",
    convertibleRaw: "0",
    requestedUsd: "14.201601",
    availableNowUsd: "12.407208",
    shortfallUsd: "0.5",
    convertibleUsd: "0",
    mode: "prepare_first",
    eta: null,
    requiredActions: [],
    sourceOptions: [],
    asOf: "2026-08-17T12:37:00.000Z",
    expiresAt: "2026-08-17T12:38:00.000Z",
    policyVersion: 1,
    completeness: "complete",
    freshness: "fresh",
    errors: [],
    reasonCodes: [],
    destinationOptions: [],
  };
}

function account(): AccountValueReadModel {
  return {
    ownership: {
      wallets: [POLYGON_PROFILE],
      locations: [],
    },
  } as unknown as AccountValueReadModel;
}

function accountWithBaseProfileFirst(): AccountValueReadModel {
  const baseProfile = {
    ...POLYGON_PROFILE,
    networkId: "evm:8453",
    serverWalletRef: "privy_wallet_base_12345678",
  };
  return {
    ownership: {
      wallets: [baseProfile, POLYGON_PROFILE],
      locations: [],
    },
  } as unknown as AccountValueReadModel;
}

const derived = deriveTrustedTradeShortfallRequest({
  readiness: readiness("13701601"),
  request: REQUEST,
});
assert.equal(derived.fundingRequired, true);
assert.equal(derived.additionalDestinationAmount?.raw, "500000");
assert.equal(derived.request.serverAdditionalDestinationAmount?.raw, "500000");
assert.equal(
  fundingDestinationAmountForRequest(derived.request)?.raw,
  "500000",
  "funding commits must quote the exact shortfall, not the later Buy ceiling",
);
assert.equal(
  fundingDestinationAmountForRequest(REQUEST)?.raw,
  REQUESTED_DESTINATION_AMOUNT.raw,
  "requests without a derived shortfall retain their destination amount",
);

const alreadyCovered = deriveTrustedTradeShortfallRequest({
  readiness: readiness("14201601"),
  request: REQUEST,
});
assert.equal(alreadyCovered.fundingRequired, false);
assert.equal(
  alreadyCovered.request.serverAdditionalDestinationAmount,
  undefined,
);

const observedRequests: FundingDiscoveryRequest[] = [];
const result = await preflightTrustedTradeShortfall({
  account: account(),
  liquidity: async (request) => {
    observedRequests.push(request);
    return projection();
  },
  request: REQUEST,
  trading: {
    getReadiness: async () => readiness("13701601"),
  },
  userId: USER_ID,
});
assert.equal(result.fundingRequired, true);
assert.equal(result.additionalDestinationAmount?.raw, "500000");
const observedRequest = observedRequests[0];
assert.ok(observedRequest);
assert.equal(observedRequest.serverAdditionalDestinationAmount?.raw, "500000");

let observedPrivyWalletId: string | null = null;
await preflightTrustedTradeShortfall({
  account: accountWithBaseProfileFirst(),
  liquidity: async () => projection(),
  request: REQUEST,
  trading: {
    getReadiness: async (readinessInput) => {
      observedPrivyWalletId = readinessInput.privyWalletId ?? null;
      return readiness("13701601");
    },
  },
  userId: USER_ID,
});
assert.equal(
  observedPrivyWalletId,
  "privy_wallet_12345678",
  "Polygon pUSD preflight must not choose a same-controller Base wallet profile",
);

console.log(
  "[funding-trade-shortfall-preflight-tests] server-derived shortfall preflight passed",
);
