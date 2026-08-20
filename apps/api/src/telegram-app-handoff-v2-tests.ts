import assert from "node:assert/strict";

import type {
  FundingDiscoveryRequest,
  IntentLiquidityProjection,
  SourceOption,
} from "./funding/domain/types.js";
import {
  buildTelegramAppHandoffV2DirectTradePlan,
  buildTelegramAppHandoffV2Plan,
  isTelegramAppHandoffV2ReadOnlyExecution,
  isTelegramAppHandoffV2Plan,
  isTelegramAppHandoffV2FundingBinding,
  parseTelegramAppHandoffV2Plan,
  resolveTelegramAppHandoffFundingCapability,
  telegramAppHandoffPlanGeneration,
  telegramAppHandoffV2FundingIdempotencyKey,
  telegramAppHandoffV2SupportsActionKind,
} from "./services/telegram-app-handoff-v2.js";
import {
  isTelegramAppHandoffV2DirectTradeVenue,
  isTelegramAppHandoffV2TradeVenue,
} from "./services/telegram-app-handoff-v2-contract.js";

const POLYGON_PUSD = {
  assetId: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  decimals: 6,
  networkId: "evm:137",
};
const BASE_USDC = {
  assetId: "0x833589fCD6EDB6E08f4c7C32D4f71b54bdA02913",
  decimals: 6,
  networkId: "evm:8453",
};

const request: FundingDiscoveryRequest = {
  confirmedSourceAmount: null,
  consumerIntent: {
    marketContextId: "market-token",
    marketId: "polymarket:market-1",
    side: "BUY",
    spend: { asset: POLYGON_PUSD, raw: "1000000" },
    venueId: "polymarket",
  },
  controllerWalletRef: null,
  deadline: "2026-08-20T12:00:00.000Z",
  destinationOptionId: null,
  marketContextId: "market-token",
  maxFeeUsd: "1",
  maxSlippageBps: 500,
  purpose: "trade_shortfall",
  requestedDestinationAmount: { asset: POLYGON_PUSD, raw: "1000000" },
  venueBindingOptionId: null,
  withdrawalRecipientId: null,
};

const trade = {
  action: "buy",
  amountUsd: 1,
  controllerWalletAddress: "0x0000000000000000000000000000000000000001",
  eventId: "event-1",
  marketId: "polymarket:market-1",
  maxSlippageBps: 500,
  maxSpendUsd: 1.05,
  outcomeTokenId: "market-token",
  side: "YES",
  venue: "polymarket",
} as const;

const evmSource: SourceOption = {
  amountMode: "exact_input",
  estimatedUsd: "0.60",
  eta: { maxSeconds: 30, minSeconds: 5 },
  experienceMode: "inline_funding",
  expiresAt: "2026-08-20T12:00:00.000Z",
  fees: [],
  kind: "wallet_asset",
  maximumSourceRaw: "600000",
  quotedSourceAmount: { asset: BASE_USDC, raw: "100000" },
  minimumDestination: { asset: POLYGON_PUSD, raw: "590000" },
  expectedDestination: { asset: POLYGON_PUSD, raw: "600000" },
  reasonCodes: [],
  recommended: true,
  requiredActions: [
    {
      actor: "user",
      kind: "evm_transaction",
      safeLabel: "Send USDC",
      sponsorship: "requested",
      valueMoving: true,
    },
  ],
  safeLabel: "Base USDC",
  selectable: true,
  source: {
    kind: "owned_location",
    location: {
      accountId: "00000000-0000-4000-8000-000000000001",
      asset: BASE_USDC,
      details: {
        address: "0x1111111111111111111111111111111111111111",
        walletId: "wallet-base",
      },
      kind: "wallet",
      locationId: "wallet-base-usdc",
    },
  },
  sourceOptionId: "source-base-usdc",
};

const solanaSource: SourceOption = {
  ...evmSource,
  maximumSourceRaw: "400000",
  quotedSourceAmount: {
    asset: {
      assetId: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
      networkId: "solana:mainnet",
    },
    raw: "400000",
  },
  recommended: false,
  requiredActions: [
    {
      actor: "user",
      kind: "svm_transaction",
      safeLabel: "Send Solana USDC",
      sponsorship: "none",
      valueMoving: true,
    },
  ],
  safeLabel: "Solana USDC",
  source: {
    kind: "owned_location",
    location: {
      accountId: "00000000-0000-4000-8000-000000000001",
      asset: {
        assetId: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
        networkId: "solana:mainnet",
      },
      details: {
        address: "4Nd1mYkS3EpnZFK4W9Ckm5yPYnXZUrzPxSbnG2qXrmnr",
        walletId: "wallet-solana",
      },
      kind: "wallet",
      locationId: "wallet-solana-usdc",
    },
  },
  sourceOptionId: "source-solana-usdc",
};

const baseOwnedSource = evmSource.source;
if (baseOwnedSource.kind !== "owned_location") {
  throw new Error("Base USDC fixture must use an owned source");
}

const compositeWithVenuePreparation: SourceOption = {
  ...evmSource,
  kind: "composite",
  source: { kind: "composite", legCount: 2 },
  sourceLegs: [
    {
      expectedDestination: { asset: POLYGON_PUSD, raw: "500000" },
      eta: { maxSeconds: 90, minSeconds: 5 },
      fees: [],
      minimumDestination: { asset: POLYGON_PUSD, raw: "500000" },
      requiredActions: [],
      safeLabel: "Prepare Polymarket funding",
      source: {
        inputCount: 1,
        kind: "venue_preparation",
        venueBindingId: "polymarket-binding",
        venueId: "polymarket",
      },
      sourceAmount: { asset: POLYGON_PUSD, raw: "500000" },
      sourceLegId: "source-leg-router-preparation",
    },
    {
      expectedDestination: { asset: BASE_USDC, raw: "100000" },
      eta: { maxSeconds: 30, minSeconds: 5 },
      fees: [],
      minimumDestination: { asset: BASE_USDC, raw: "100000" },
      requiredActions: evmSource.requiredActions,
      safeLabel: evmSource.safeLabel,
      source: baseOwnedSource,
      sourceAmount: { asset: BASE_USDC, raw: "100000" },
      sourceLegId: "source-leg-base-usdc",
    },
  ],
  sourceOptionId: "source-composite-router-preparation",
};

const projection = (
  sourceOptions: readonly SourceOption[],
): IntentLiquidityProjection => ({
  asOf: "2026-08-20T11:00:00.000Z",
  availableNowRaw: "0",
  availableNowUsd: "0",
  collateralAsset: POLYGON_PUSD,
  completeness: "complete",
  convertibleRaw: "0",
  convertibleUsd: "0",
  destinationOptionId: "destination-polymarket",
  destinationOptions: [
    {
      controllerWalletId: "wallet-polygon",
      destinationOptionId: "destination-polymarket",
      executionMode: "web_client",
      inspectionRevision: "wallet-revision-1",
      marketClass: null,
      networkLabel: "Polygon",
      preparationPurpose: "buy",
      preparationStatus: "ready",
      readinessClass: "internal_managed",
      reasonCodes: [],
      recommended: true,
      requiredAsset: POLYGON_PUSD,
      safeLabel: "Polymarket pUSD",
      selectable: true,
      topology: "polymarket-controller-pusd-v1",
      venueBindingId: "polymarket-binding",
      venueBindingOptionId: "polymarket-binding-option",
      venueId: "polymarket",
    },
  ],
  errors: [],
  eta: { maxSeconds: 45, minSeconds: 5 },
  expiresAt: "2026-08-20T12:00:00.000Z",
  freshness: "fresh",
  liquidityProjectionId: "projection-1",
  marketContextId: "market-token",
  mode: "inline_funding",
  policyVersion: 1,
  reasonCodes: [],
  requestedCollateralRaw: "1000000",
  requestedUsd: "1",
  requiredActions: sourceOptions.flatMap((option) => option.requiredActions),
  shortfallRaw: "1000000",
  shortfallUsd: "1",
  sourceOptions,
  venueBindingOptionId: "polymarket-binding-option",
  venueId: "polymarket",
});

const generic = projection([evmSource, solanaSource]);
assert.equal(isTelegramAppHandoffV2TradeVenue("polymarket"), true);
assert.equal(isTelegramAppHandoffV2TradeVenue("limitless"), true);
assert.equal(isTelegramAppHandoffV2DirectTradeVenue("polymarket"), true);
assert.equal(
  isTelegramAppHandoffV2DirectTradeVenue("limitless"),
  false,
  "Limitless V2 funding does not imply a recoverable direct Buy",
);
assert.equal(
  isTelegramAppHandoffV2TradeVenue("kalshi"),
  false,
  "a known Hunch venue is not a v2 handoff venue until its consumer exists",
);
assert.deepEqual(
  resolveTelegramAppHandoffFundingCapability({
    projection: generic,
    serverBotExact: false,
  }),
  {
    kind: "web_funding_plan",
    requiredContractVersion: 2,
  },
);
assert.deepEqual(
  resolveTelegramAppHandoffFundingCapability({
    projection: projection([compositeWithVenuePreparation]),
    serverBotExact: false,
  }),
  { kind: "unavailable", reason: "no_supported_owned_source" },
  "V2 never advertises a composite that includes an unscoped venue-preparation debit",
);

const sealed = buildTelegramAppHandoffV2Plan({
  discoveryRequest: request,
  fundingPolicyRevision: "funding-policy-1",
  projection: generic,
  trade,
});
assert.equal(sealed.version, 2);
assert.equal(sealed.funding.sourceDebits.length, 2);
assert.equal(
  sealed.funding.destination.destinationOptionId,
  "destination-polymarket",
  "the selected destination option is part of the sealed scope",
);
assert.equal(
  sealed.funding.sourceDebits.find(
    (source) => source.locationId === "wallet-base-usdc",
  )?.maximumRaw,
  "100000",
  "a v2 handoff seals the quoted debit, never the wallet's full capacity",
);
assert.equal(isTelegramAppHandoffV2Plan(sealed), true);
assert.equal(
  isTelegramAppHandoffV2Plan({
    ...sealed,
    trade: { ...sealed.trade, controllerWalletAddress: null },
  }),
  false,
  "funded plans seal the same controller boundary as direct plans",
);
assert.equal(
  isTelegramAppHandoffV2Plan({
    ...sealed,
    funding: {
      ...sealed.funding,
      destination: { ...sealed.funding.destination, venueId: "limitless" },
    },
  }),
  false,
  "a sealed funding destination cannot drift to another venue",
);

const directTrade = buildTelegramAppHandoffV2DirectTradePlan({
  controllerWalletAddress: "0x0000000000000000000000000000000000000001",
  trade,
});
assert.equal(directTrade.kind, "direct_trade");
assert.equal(isTelegramAppHandoffV2Plan(directTrade), true);
assert.equal(
  isTelegramAppHandoffV2Plan({
    ...directTrade,
    trade: { ...trade, venue: "limitless" },
  }),
  false,
  "direct V2 plans cannot represent Limitless until direct recovery exists",
);
assert.equal(
  isTelegramAppHandoffV2Plan({
    ...directTrade,
    trade: { ...trade, maxSpendUsd: 0.5 },
  }),
  false,
);
assert.equal(
  telegramAppHandoffPlanGeneration({
    ...directTrade,
    trade: { ...trade, maxSpendUsd: 0.5 },
  }),
  "v2",
  "declared v2 stays on the v2 parser even when its body is malformed",
);
assert.throws(
  () =>
    parseTelegramAppHandoffV2Plan({
      ...directTrade,
      trade: { ...trade, maxSpendUsd: 0.5 },
    }),
  /sealed trade scope is malformed/u,
);
assert.equal(
  telegramAppHandoffPlanGeneration({ version: 99 }),
  "unsupported",
  "unknown handoff generations must not reach the legacy executor",
);
assert.equal(
  telegramAppHandoffV2FundingIdempotencyKey(
    "00000000-0000-4000-8000-000000000003",
  ),
  "telegram-app-handoff:00000000-0000-4000-8000-000000000003:funding",
);
assert.equal(
  isTelegramAppHandoffV2FundingBinding({
    handoffId: "00000000-0000-4000-8000-000000000003",
    operationId: "00000000-0000-4000-8000-000000000004",
    result: {
      appHandoffFunding: {
        handoffId: "00000000-0000-4000-8000-000000000003",
        operationId: "00000000-0000-4000-8000-000000000004",
        version: 2,
      },
    },
  }),
  true,
);
assert.equal(
  isTelegramAppHandoffV2FundingBinding({
    handoffId: "00000000-0000-4000-8000-000000000003",
    operationId: "00000000-0000-4000-8000-000000000005",
    result: {
      appHandoffFunding: {
        handoffId: "00000000-0000-4000-8000-000000000003",
        operationId: "00000000-0000-4000-8000-000000000004",
        version: 2,
      },
    },
  }),
  false,
  "a stale intent pointer must not be treated as this handoff's operation",
);
assert.equal(telegramAppHandoffV2SupportsActionKind("svm_transaction"), true);
assert.equal(telegramAppHandoffV2SupportsActionKind("signature"), false);
assert.equal(
  isTelegramAppHandoffV2ReadOnlyExecution({
    handoffId: "00000000-0000-4000-8000-000000000003",
    kind: "direct_trade_in_flight",
    orderId: null,
    planFingerprint: "a".repeat(64),
    requiredContractVersion: 2,
    tradeIntentId: "00000000-0000-4000-8000-000000000004",
    venueOrderId: null,
  }),
  true,
  "status reads never require live authority after a direct order claim",
);
assert.equal(
  isTelegramAppHandoffV2ReadOnlyExecution({
    handoffId: "00000000-0000-4000-8000-000000000003",
    kind: "direct_trade_continuation_required",
    planFingerprint: "a".repeat(64),
    requiredContractVersion: 2,
    tradeIntentId: "00000000-0000-4000-8000-000000000004",
  }),
  false,
  "a fresh direct submission remains authority-gated",
);

const ownedExternalHandoff = buildTelegramAppHandoffV2Plan({
  discoveryRequest: request,
  fundingPolicyRevision: "funding-policy-1",
  projection: projection([
    {
      ...evmSource,
      requiredActions: [
        {
          actor: "user",
          kind: "external_handoff",
          safeLabel: "Authorize the Polymarket balance transfer",
          sponsorship: "none",
          valueMoving: true,
        },
        ...evmSource.requiredActions,
      ],
    },
  ]),
  trade,
});
assert.equal(
  ownedExternalHandoff.funding.sourceDebits[0]?.locationId,
  "wallet-base-usdc",
  "an external handoff from an owned wallet remains source-bound and capped",
);

const exactShortfallPlan = buildTelegramAppHandoffV2Plan({
  discoveryRequest: {
    ...request,
    serverAdditionalDestinationAmount: {
      asset: POLYGON_PUSD,
      raw: "400000",
    },
  },
  fundingPolicyRevision: "funding-policy-1",
  projection: generic,
  trade,
});
assert.equal(
  isTelegramAppHandoffV2Plan(exactShortfallPlan),
  true,
  "the exact Telegram shortfall is a sealed economic bound, not server authority",
);
assert.equal(
  isTelegramAppHandoffV2Plan({
    ...sealed,
    funding: {
      ...sealed.funding,
      discoveryRequest: {
        ...request,
        serverExecutionProfileId: "telegram_relay_polygon_pusd_v1",
      },
    },
  }),
  false,
  "a v2 client plan must never inherit a server execution profile",
);

const signatureOnly = projection([
  {
    ...evmSource,
    requiredActions: [
      {
        actor: "user",
        kind: "signature",
        safeLabel: "Sign",
        sponsorship: "none",
        valueMoving: true,
      },
    ],
  },
]);
assert.deepEqual(
  resolveTelegramAppHandoffFundingCapability({
    projection: signatureOnly,
    serverBotExact: false,
  }),
  {
    kind: "unavailable",
    reason: "no_supported_owned_source",
  },
);

const serverActionOnly = projection([
  {
    ...evmSource,
    requiredActions: [
      {
        actor: "server",
        kind: "evm_transaction",
        safeLabel: "Server transfer",
        sponsorship: "requested",
        valueMoving: true,
      },
    ],
  },
]);
assert.deepEqual(
  resolveTelegramAppHandoffFundingCapability({
    projection: serverActionOnly,
    serverBotExact: false,
  }),
  {
    kind: "unavailable",
    reason: "no_supported_owned_source",
  },
  "a Mini App plan cannot inherit a server-only action",
);

const externalDeposit = projection([
  {
    ...evmSource,
    source: {
      asset: BASE_USDC,
      controlledSender: false,
      ingressKind: "manual",
      kind: "external_ingress",
      networkId: "evm:8453",
    },
  },
]);
assert.deepEqual(
  resolveTelegramAppHandoffFundingCapability({
    projection: externalDeposit,
    serverBotExact: false,
  }),
  { kind: "external_deposit" },
);
const [externalDepositOption] = externalDeposit.sourceOptions;
assert.ok(externalDepositOption);

assert.deepEqual(
  resolveTelegramAppHandoffFundingCapability({
    projection: projection([evmSource, externalDepositOption]),
    serverBotExact: false,
  }),
  {
    kind: "web_funding_plan",
    requiredContractVersion: 2,
  },
  "a usable owned route must win over an optional manual Deposit",
);

console.log("telegram app handoff v2 tests passed");
