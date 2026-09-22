#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import {
  calculatePolymarketQuote,
  findMaxPolymarketLimitBuyShares,
  validatePolymarketLimitBuy,
  calculatePolymarketSignedBuyRequiredSpendRaw,
  calculatePolymarketSignedFokBuyRequiredSpendRaw,
  findMaxPolymarketMarketBuyUsd,
  findMaxPolymarketMarketBuyUsdDetailed,
  normalizeOrderTypeForClob,
  parsePolymarketPlatformFeeCurve,
  PolymarketQuoteError,
  type PolymarketQuoteContext,
} from "./services/polymarket-quote.js";
import {
  computePolymarketClobOpenOrderLocks,
  computePolymarketExecutableFunds,
  computePolymarketFundingRouterPusdAvailableRaw,
  evaluatePolymarketBuyApprovalReadiness,
  POLYMARKET_BUY_APPROVAL_THRESHOLD,
  polymarketAllowanceSatisfiesBuyApproval,
} from "./services/polymarket-max-spend.js";
import type { PolymarketFeePolicySnapshot } from "./services/polymarket-builder-fees.js";
import {
  buildPolymarketFundingPlan,
  decodePolymarketFundingCalldata,
  PolymarketFundingPlanError,
} from "./services/polymarket-funding-router.js";
import { polymarketMaxSpendBodySchema } from "./schemas/polymarket-private.js";
import {
  buildAccountValueObservation,
  type buildAccountValueReadModel,
  type AccountValueReadModel,
} from "./account-value/runtime-service.js";
import { stableWalletOpaqueId } from "./account-value/canonical.js";
import { projectCashAvailability } from "./account-value/cash-availability-projector.js";
import {
  PYTH_SOL_USD_PRICE_POLICY_ID,
  ValuationService,
} from "./account-value/valuation-service.js";
import type { PriceAdapter } from "./funding/domain/contracts.js";
import { SOLANA_NATIVE_ASSET } from "./funding/domain/network-fees.js";
import {
  computePolymarketAccountMaxSpend,
  externalWalletSourceLocationIds,
} from "./services/polymarket-account-max-spend.js";
import { unavailableSessionSourceLocationIds } from "./funding/planner/session-source-account.js";
import { DEFAULT_FUNDING_RUNTIME_POLICY } from "./funding/policies/funding-policy.js";
import type {
  AssetLocation,
  AssetRef,
  FundingDiscoveryRequest,
  FundingSourceRef,
  Money,
  SourceOption,
} from "./funding/domain/types.js";
import type { FundingCommitPlan } from "./funding/persistence/funding-operation-repository.js";
import type { FundingLiquidityPreview } from "./funding/planner/runtime-service.js";
import type { PlannedSourceOption } from "./funding/planner/planning-types.js";
import { env } from "./env.js";
import { suggestSmallerMarketBuy } from "./funding/planner/market-buy-suggestion.js";
import { classifyProvenCashShortfall } from "./funding/planner/proven-cash-shortfall.js";
import { checkLimitlessBuyBudget } from "./funding/planner/limitless-buy-budget.js";
import type { ApiTradeMarket } from "./services/api-trading-market-repo.js";
import { quoteLimitlessClobMarket } from "./services/limitless-clob-quote.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const SIGNER = "0x0000000000000000000000000000000000000011";
const DEPOSIT = "0x0000000000000000000000000000000000000022";
const ROUTER = "0x0000000000000000000000000000000000000033";

const noFeePolicy: PolymarketFeePolicySnapshot = {
  venue: "polymarket",
  collectionMode: "none",
  builderCode: ZERO_BYTES32,
  builderTakerFeeBps: 0,
  builderMakerFeeBps: 0,
  builderRateSource: "none",
  builderEnabled: false,
  legacyFeeBps: 0,
  feePolicyId: null,
  capturedAt: new Date(0).toISOString(),
};

const baseMarketInfo: NonNullable<PolymarketQuoteContext["marketInfo"]> = {
  polymarket_id: "pm-test",
  unified_market_id: "market-test",
  condition_id: "condition-test",
  clob_token_ids: JSON.stringify(["token-yes", "token-no"]),
  neg_risk: false,
  order_price_min_tick_size: "0.01",
  order_min_size: "5",
  accepting_orders: true,
  taker_fee_bps: "500",
  maker_fee_bps: "0",
};

function builderFeePolicy(
  builderTakerFeeBps: number,
): PolymarketFeePolicySnapshot {
  return {
    ...noFeePolicy,
    collectionMode: "builder",
    builderCode:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    builderTakerFeeBps,
    builderRateSource: "fallback",
    builderEnabled: true,
  };
}

function quoteContext(
  overrides: Partial<PolymarketQuoteContext> = {},
): PolymarketQuoteContext {
  return {
    orderbook: {
      bids: [{ price: 0.49, size: 10_000 }],
      asks: [{ price: 0.5, size: 10_000 }],
      tickSize: 0.01,
      minOrderSize: 5,
      negRisk: false,
    },
    marketInfo: baseMarketInfo,
    feePolicySnapshot: noFeePolicy,
    platformFeeCurve: null,
    ...overrides,
  };
}

function takerOnlyPlatformFeeCurve(rate: number, exponent: number) {
  return {
    rate,
    exponent,
    takerOnly: true,
    makerBaseFeeBps: 0,
    takerBaseFeeBps: 0,
  } as const;
}

function noFeeNoMinContext(): PolymarketQuoteContext {
  return quoteContext({
    orderbook: {
      bids: [{ price: 0.49, size: 10_000 }],
      asks: [{ price: 0.5, size: 10_000 }],
      tickSize: 0.01,
      minOrderSize: 0,
      negRisk: false,
    },
    marketInfo: {
      ...baseMarketInfo,
      order_min_size: "0",
      taker_fee_bps: "0",
      maker_fee_bps: "0",
    },
  });
}

function accountMaxRelaySource(input: {
  destinationAsset: AssetRef;
  destinationRaw: string;
}): PlannedSourceOption {
  const sourceLocation: AssetLocation = {
    kind: "wallet",
    locationId: "location_remaining_base_cash_12345678",
    accountId: "account_after_completed_trade_12345678",
    asset: {
      networkId: "evm:8453",
      assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      decimals: 6,
    },
    details: {
      address: "0x0000000000000000000000000000000000000044",
      walletId: "wallet_embedded_base_12345678",
    },
  };
  const source: FundingSourceRef = {
    kind: "owned_location",
    location: sourceLocation,
  };
  const sourceAmount: Money = {
    asset: sourceLocation.asset,
    raw: input.destinationRaw,
  };
  const destinationAmount: Money = {
    asset: input.destinationAsset,
    raw: input.destinationRaw,
  };
  const option: SourceOption = {
    sourceOptionId: "source_remaining_base_cash_12345678",
    kind: "wallet_asset",
    safeLabel: "Remaining Base USDC",
    source,
    amountMode: "exact_input",
    maximumSourceRaw: input.destinationRaw,
    expectedDestination: destinationAmount,
    minimumDestination: destinationAmount,
    estimatedUsd: "4.43",
    fees: [
      {
        kind: "relay_fee",
        amount: { asset: sourceLocation.asset, raw: "10000" },
        estimatedUsd: "0.01",
      },
    ],
    eta: { minSeconds: 5, maxSeconds: 15 },
    experienceMode: "inline_funding",
    requiredActions: [
      {
        kind: "evm_transaction",
        safeLabel: "Fund Polymarket",
        actor: "user",
        valueMoving: true,
        sponsorship: "requested",
      },
    ],
    expiresAt: "2026-09-01T12:00:00.000Z",
    recommended: false,
    selectable: true,
    reasonCodes: [],
  };
  const plan: FundingCommitPlan = {
    operation: {
      purpose: "trade_shortfall",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "inline",
      planKind: "wallet_route",
      sourceSnapshot: option,
      destinationTargetSnapshot: {
        kind: "owned_location",
        location: {
          kind: "venue_account",
          locationId: "location_polymarket_after_trade_12345678",
          accountId: "account_after_completed_trade_12345678",
          asset: input.destinationAsset,
          details: { address: DEPOSIT, venueId: "polymarket" },
        },
      },
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: "polymarket:market-test",
      marketContextSnapshot: null,
      venueBindingSnapshot: {
        venueBindingOptionId: "binding_option_after_trade_12345678",
      },
      walletExecutionSnapshot: {
        walletId: "wallet_embedded_base_12345678",
      },
      placementSnapshot: { decision: "route" },
      requestedSourceAmount: sourceAmount,
      requestedDestinationAmount: destinationAmount,
      supportMetadata: {
        routeId: "route_remaining_base_cash_12345678",
      },
    },
    segments: [
      {
        providerId: "relay",
        adapterId: "relay_quote_v2",
        adapterVersion: 1,
        segmentKind: "cross_network_transfer",
        status: "planned",
        sourceSnapshot: source,
        destinationTargetSnapshot: {
          kind: "owned_location",
          location: {
            kind: "venue_account",
            locationId: "location_polymarket_after_trade_12345678",
            accountId: "account_after_completed_trade_12345678",
            asset: input.destinationAsset,
            details: { address: DEPOSIT, venueId: "polymarket" },
          },
        },
        quotedInput: sourceAmount,
        quotedExpectedOutput: destinationAmount,
        quotedMinOutput: destinationAmount,
        providerQuoteRefCiphertext: "ciphertext_remaining_base_cash_12345678",
        providerQuoteRefLookupHmac:
          "hmac_remaining_base_cash_12345678_abcdefghijklmnopqrstuvwxyz",
        depositAddressCiphertext: null,
        depositAddressLookupHmac: null,
        lookupKeyVersion: 1,
        refundLocationSnapshot: sourceLocation,
        quoteExpiresAt: option.expiresAt,
      },
    ],
    steps: [
      {
        ordinal: 0,
        segmentOrdinal: 0,
        stepKind: "transaction",
        state: "action_required",
        actionFingerprint: "fingerprint_remaining_base_cash_12345678",
        executorId: "wallet_profile_evm_v1",
        payerRequirement: "privy_sponsor",
        dependsOnOrdinal: null,
        normalizedAction: { kind: "evm_transaction" },
        actionValidationResult: { validatorId: "exact_test_v1" },
      },
    ],
    reservations: [
      {
        segmentOrdinal: 0,
        componentId: "component_remaining_base_cash_12345678",
        locationId: sourceLocation.locationId,
        networkId: sourceLocation.asset.networkId,
        assetId: sourceLocation.asset.assetId,
        assetDecimals: sourceLocation.asset.decimals,
        rawAmount: input.destinationRaw,
        mode: "subtract_available",
        expiresAt: option.expiresAt,
      },
    ],
  };
  return {
    option,
    commitPlan: plan,
    routeId: "route_remaining_base_cash_12345678",
    providerId: "relay",
    compositeEligible: true,
  };
}

const tests: TestCase[] = [
  {
    name: "Limitless market reduction binds the outcome and rounds down without resting-order minima or Polymarket fees",
    run: async () => {
      const market: ApiTradeMarket = {
        id: "limitless:1",
        venue: "limitless",
        venue_market_id: "1",
        event_id: "event",
        event_title: "Event",
        event_end_time: null,
        title: "Market",
        slug: "market",
        status: "ACTIVE",
        accepting_orders: true,
        close_time: null,
        expiration_time: null,
        outcomes: '["Yes","No"]',
        metadata: {},
        is_initialized: true,
        token_yes: "limitless:101",
        token_no: "limitless:102",
        clob_token_ids: null,
        best_ask: "0.5",
        best_bid: "0.49",
        last_price: "0.5",
        updated_at: new Date(),
      };
      let calls = 0;
      let minimum = 1;
      const input = {
        marketId: market.id,
        tokenId: "limitless:101",
        budgetRaw: 1_909_999n,
      };
      const dependencies: NonNullable<
        Parameters<typeof checkLimitlessBuyBudget>[2]
      > = {
        findMarket: async () => market,
        quoteClob: async (quoteInput) => {
          calls++;
          assert.equal(quoteInput.amountUsd, 1.9);
          assert.equal(quoteInput.tokenId, "101");
          return {
            status: "ready",
            tokenId: "101",
            side: "BUY",
            asOf: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 5_000).toISOString(),
            averagePrice: 0.5,
            worstPrice: 0.5,
            executableShares: 3.8,
            availableShares: 100,
            minOrderNotionalUsd: minimum,
            totalNotional: 1.9,
          };
        },
        quoteAmm: async () => {
          throw new Error("CLOB must not use AMM");
        },
      };
      const result = await checkLimitlessBuyBudget(
        {} as Pool,
        input,
        dependencies,
      );
      assert.equal(result?.amountRaw, 1_900_000n);
      minimum = 100;
      assert.equal(
        (await checkLimitlessBuyBudget({} as Pool, input, dependencies))
          ?.amountRaw,
        1_900_000n,
      );
      const executableBelowRestingMinimum = await checkLimitlessBuyBudget(
        {} as Pool,
        input,
        {
          ...dependencies,
          quoteClob: (quoteInput) =>
            quoteLimitlessClobMarket(quoteInput, {
              requestOrderbook: async () => ({
                ok: true,
                payload: {
                  tokenId: "101",
                  minSize: "100000000",
                  asks: [{ price: 0.5, size: 100_000_000 }],
                  bids: [],
                },
              }),
            }),
        },
      );
      assert.equal(executableBelowRestingMinimum?.amountRaw, 1_900_000n);
      const before = calls;
      assert.equal(
        await checkLimitlessBuyBudget(
          {} as Pool,
          { ...input, tokenId: "limitless:999" },
          dependencies,
        ),
        null,
      );
      assert.equal(calls, before);
      market.status = "CLOSED";
      assert.equal(
        await checkLimitlessBuyBudget({} as Pool, input, dependencies),
        null,
      );
      assert.equal(calls, before);
      market.status = "ACTIVE";
      market.metadata = { amm: true, marketAddress: DEPOSIT };
      const amm = await checkLimitlessBuyBudget(
        {} as Pool,
        { ...input, tokenId: "limitless:102" },
        {
          ...dependencies,
          quoteAmm: async (quoteInput) => {
            assert.equal(quoteInput.outcomeIndex, 1);
            assert.equal(quoteInput.amountUsdRaw, 1_900_000n);
            return {
              marketAddress: DEPOSIT,
              side: "BUY",
              outcomeIndex: 1,
              sharesRaw: "3500000",
              returnAmountRaw: null,
            };
          },
        },
      );
      assert.equal(amm?.amountRaw, 1_900_000n);
      assert.equal(calls, before);
    },
  },
  {
    name: "limit MAX includes fees at the chosen price and returns the largest normalized shares",
    run: () => {
      const context = quoteContext({
        marketInfo: { ...baseMarketInfo, taker_fee_bps: "0" },
        feePolicySnapshot: builderFeePolicy(820),
      });
      for (const orderType of ["GTC", "GTD"] as const) {
        const result = findMaxPolymarketLimitBuyShares({
          context,
          tokenId: "yes",
          executableFundsRaw: 4_000_000n,
          limitPrice: 0.23,
          orderType,
        });
        assert.equal(result.ok, true);
        if (!result.ok) throw new Error("Expected a limit maximum");
        assert.equal(result.quote.orderType, orderType);
        assert.equal(result.quote.price, 0.23);
        assert.ok(result.quote.totalRequiredUsdcRaw != null);
        assert.ok(BigInt(result.quote.totalRequiredUsdcRaw) <= 4_000_000n);
        assert.ok(result.quote.size < 17.3913);
        const next = calculatePolymarketQuote({
          context,
          tokenId: "yes",
          side: "BUY",
          orderType,
          amountType: "shares",
          limitPrice: 0.23,
          amountSharesRawInput: BigInt(result.quote.takerAmount) + 10_000n,
        });
        assert.ok(next.totalRequiredUsdcRaw != null);
        assert.ok(BigInt(next.totalRequiredUsdcRaw) > 4_000_000n);
      }
    },
  },
  {
    name: "limit MAX preserves marketable notional and share minima without importing FOK rules",
    run: () => {
      const context = quoteContext({
        marketInfo: { ...baseMarketInfo, taker_fee_bps: "0" },
      });
      const max = (budget: bigint, limitPrice: number) =>
        findMaxPolymarketLimitBuyShares({
          context,
          tokenId: "yes",
          executableFundsRaw: budget,
          limitPrice,
        });
      assert.equal(max(999_999n, 0.5).ok, false);
      // Resting limit below $1 remains valid when it meets the market's shares minimum.
      assert.equal(max(900_000n, 0.15).ok, true);
      const fiveShares = max(2_500_000n, 0.5);
      assert.equal(fiveShares.ok, true);
      assert.equal(max(2_499_999n, 0.5).ok, false);
      assert.equal(max(0n, 0.23).ok, false);
      const crossing = {
        ...context,
        orderbook: {
          ...context.orderbook,
          minOrderSize: 1,
          asks: [{ price: 0.5, size: 100 }],
        },
      };
      assert.equal(
        findMaxPolymarketLimitBuyShares({
          context: crossing,
          tokenId: "yes",
          executableFundsRaw: 999_999n,
          limitPrice: 0.5,
        }).ok,
        false,
      );
      assert.equal(
        findMaxPolymarketLimitBuyShares({
          context: crossing,
          tokenId: "yes",
          executableFundsRaw: 1_000_000n,
          limitPrice: 0.5,
        }).ok,
        true,
      );
    },
  },
  {
    name: "account MAX remains executable after a completed trade with venue cash plus internal funding",
    run: async () => {
      const destinationAsset: AssetRef = {
        networkId: "evm:137",
        assetId: env.polymarketPusdAddress,
        decimals: 6,
      };
      const routeSource = accountMaxRelaySource({
        destinationAsset,
        destinationRaw: "4430000",
      });
      const destinationLocation = {
        kind: "venue_account" as const,
        locationId: "location_polymarket_after_trade_12345678",
        accountId: "account_after_completed_trade_12345678",
        asset: destinationAsset,
        details: { address: DEPOSIT, venueId: "polymarket" },
      };
      const preview = {
        projection: {
          completeness: "complete",
          freshness: "fresh",
          errors: [],
          destinationOptionId: "destination_polymarket_after_trade_12345678",
          venueId: "polymarket",
          reasonCodes: [],
          sourceOptions: [routeSource.option],
        },
        plannerSnapshot: {
          destination: {
            target: {
              kind: "owned_location",
              location: destinationLocation,
            },
            venueBinding: {
              accountRef: DEPOSIT,
            },
            spendability: {
              observedAmount: { asset: destinationAsset, raw: "430000" },
              lockedRaw: "0",
              reservedRaw: "0",
              submittedDebitRaw: "0",
              availableAmount: { asset: destinationAsset, raw: "430000" },
            },
          },
          sources: [routeSource],
        },
      } as unknown as FundingLiquidityPreview;
      const account = {
        ownership: {
          wallets: [
            {
              walletId: "wallet_controller_after_trade_12345678",
              source: "embedded",
              networkId: "evm:137",
              address: SIGNER,
              controllerWalletRef: "controller_after_trade_12345678",
            },
          ],
        },
        cashAvailability: { cashAvailableEstimatedUsd: "4.86" },
        projection: { components: [] },
        runtimePolicy: DEFAULT_FUNDING_RUNTIME_POLICY,
      } as unknown as AccountValueReadModel;
      const previewRequests: FundingDiscoveryRequest[] = [];
      const connectedExternalWalletRefs = [
        "3c9a8727-00e9-4cdd-8fd4-2e4e52c79252",
      ];
      let quotedFundsRaw: bigint | null = null;
      const requestInput: Parameters<
        typeof computePolymarketAccountMaxSpend
      >[0] = {
        connectedExternalWalletRefs,
        funder: DEPOSIT,
        funds: {
          funderPusdRaw: 430_000n,
          funderPusdAvailableRaw: 430_000n,
          funderLockedRaw: 0n,
          signerLockedRaw: 0n,
          signerPusdTopUpRaw: 0n,
          signerUsdceTopUpRaw: 0n,
          usesSignerTopUp: false,
        },
        pool: {} as Pool,
        signer: SIGNER,
        slippageBps: 100,
        tokenId: "token-yes",
        userId: "account_after_completed_trade_12345678",
        dependencies: {
          buildAccountValueReadModel: async (input) => {
            assert.equal(input.additionalPriceAdapters, undefined);
            return account;
          },
          fetchPolymarketMarketInfo: async () =>
            ({
              ...baseMarketInfo,
              unified_market_id: "polymarket:market-test",
            }) as never,
          createFundingRuntime: () => ({
            previewLiquidity: async (
              _userId: string,
              request: FundingDiscoveryRequest,
            ) => {
              previewRequests.push(request);
              return preview;
            },
          }),
          findMaxPolymarketMarketBuyUsdForFunds: async (_pool, input) => {
            quotedFundsRaw = input.executableFundsRaw;
            assert.ok(input.context);
            return findMaxPolymarketMarketBuyUsdDetailed({
              context: input.context,
              tokenId: input.tokenId,
              executableFundsRaw: input.executableFundsRaw,
              slippageBps: input.slippageBps,
              requireOrderbookDepth: true,
            });
          },
          loadPolymarketQuoteContext: async () => quoteContext(),
        },
      };
      const result = await computePolymarketAccountMaxSpend(requestInput);

      // Reuse the ordinary discovery's frozen sources, not another capacity probe.
      const suggestionSnapshot: FundingLiquidityPreview["plannerSnapshot"] = {
        ...preview.plannerSnapshot,
        request: {
          purpose: "trade_shortfall",
          marketBuyAmountUsdCents: 908,
          marketBuySlippageBps: 0,
          marketContextId: "token-yes",
          consumerIntent: {
            venueId: "polymarket",
            marketId: "polymarket:market-test",
            marketContextId: "token-yes",
            side: "BUY",
            spend: { asset: destinationAsset, raw: "9620000" },
          },
          requestedDestinationAmount: {
            asset: destinationAsset,
            raw: "9620000",
          },
          confirmedSourceAmount: null,
          destinationOptionId: null,
          venueBindingOptionId: null,
          withdrawalRecipientId: null,
          maxFeeUsd: null,
          maxSlippageBps: null,
          deadline: null,
        },
        projection: {
          ...preview.projection,
          collateralAsset: destinationAsset,
          availableNowRaw: "430000",
          requestedCollateralRaw: "9620000",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          reasonCodes: ["insufficient_liquidity"],
          sourceOptions: [{ ...routeSource.option, selectable: false }],
        },
        sources: [
          {
            ...routeSource,
            option: {
              ...routeSource.option,
              selectable: false,
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
        ],
      };
      let suggestionQuoteCalls = 0;
      let suggestionBudget = 0n;
      const quoteSuggestion: NonNullable<
        Parameters<typeof suggestSmallerMarketBuy>[4]
      > = async (_pool, input) => {
        suggestionQuoteCalls++;
        suggestionBudget = input.executableFundsRaw;
        return findMaxPolymarketMarketBuyUsdDetailed({
          ...input,
          context: quoteContext(),
          requireOrderbookDepth: true,
        });
      };
      const suggest = (snapshot = suggestionSnapshot) =>
        suggestSmallerMarketBuy(
          {} as Pool,
          snapshot,
          account,
          DEFAULT_FUNDING_RUNTIME_POLICY,
          quoteSuggestion,
        );
      const callsBeforeSuggestion = previewRequests.length;
      let suggestedSlippage: number | null | undefined;
      await suggestSmallerMarketBuy(
        {} as Pool,
        {
          ...suggestionSnapshot,
          request: { ...suggestionSnapshot.request, marketBuySlippageBps: 500 },
        },
        account,
        DEFAULT_FUNDING_RUNTIME_POLICY,
        async (_pool, input) => {
          suggestedSlippage = input.slippageBps;
          return { ok: false, reason: "below_min_order" };
        },
      );
      assert.equal(
        suggestedSlippage,
        500,
        "smaller Buy must retain the reviewed price-movement budget",
      );
      const suggestion = await suggest();
      assert.ok(suggestion);
      assert.equal(suggestionBudget, 4_860_000n);
      assert.ok(suggestionSnapshot.request.consumerIntent);
      const limitlessSuggestionSnapshot = {
        ...suggestionSnapshot,
        request: {
          ...suggestionSnapshot.request,
          consumerIntent: {
            ...suggestionSnapshot.request.consumerIntent,
            venueId: "limitless",
            marketId: "limitless:market-test",
            spend: { asset: destinationAsset, raw: "9080000" },
          },
        },
        projection: { ...suggestionSnapshot.projection, venueId: "limitless" },
      };
      let limitlessChecks = 0;
      const smallerLimitless = await suggestSmallerMarketBuy(
        {} as Pool,
        limitlessSuggestionSnapshot,
        account,
        DEFAULT_FUNDING_RUNTIME_POLICY,
        async () => {
          throw new Error(
            "Must not use Polymarket fee calculation for Limitless",
          );
        },
        async (_pool, input) => {
          limitlessChecks++;
          assert.equal(input.marketId, "limitless:market-test");
          assert.equal(input.budgetRaw, 4_860_000n);
          return { amountRaw: 4_860_000n, expiresAtMs: Date.now() + 2_000 };
        },
      );
      assert.equal(limitlessChecks, 1);
      assert.equal(smallerLimitless?.amountUsdCents, 486);
      assert.ok(smallerLimitless);
      assert.ok(Date.parse(smallerLimitless.expiresAt) < Date.now() + 3_000);
      const mismatchedVenue = await suggestSmallerMarketBuy(
        {} as Pool,
        {
          ...limitlessSuggestionSnapshot,
          projection: suggestionSnapshot.projection,
        },
        account,
        DEFAULT_FUNDING_RUNTIME_POLICY,
        quoteSuggestion,
        async () => {
          throw new Error("Cross-venue advice must not quote");
        },
      );
      assert.equal(mismatchedVenue, undefined);
      const externalReservation = routeSource.commitPlan.reservations[0];
      assert.ok(externalReservation);
      const sessionSuggestionAccount = {
        ...account,
        ownership: {
          ...account.ownership,
          wallets: [
            {
              walletId: "suggestion-external",
              source: "external",
              controllerWalletRef: "suggestion-ref",
            },
          ],
        },
        projection: {
          ...account.projection,
          components: [
            {
              location: {
                kind: "wallet",
                locationId: externalReservation.locationId,
                details: { walletId: "suggestion-external" },
              },
            },
          ],
        },
      } as unknown as AccountValueReadModel;
      for (const refs of [[], ["suggestion-ref"]]) {
        await suggestSmallerMarketBuy(
          {} as Pool,
          {
            ...suggestionSnapshot,
            request: {
              ...suggestionSnapshot.request,
              connectedExternalWalletRefs: refs,
            },
          },
          sessionSuggestionAccount,
          DEFAULT_FUNDING_RUNTIME_POLICY,
          async (_pool, input) => {
            assert.equal(
              input.executableFundsRaw,
              refs.length ? 4_860_000n : 430_000n,
            );
            return { ok: false, reason: "below_min_order" };
          },
        );
      }
      assert.ok(
        suggestion.amountUsdCents < 486,
        "trading fees come out of the destination budget",
      );
      assert.equal(
        previewRequests.length,
        callsBeforeSuggestion,
        "suggestion must not perform any Relay discovery",
      );
      assert.equal(suggestionQuoteCalls, 1);
      for (const cents of [0, 1, 99, 100]) {
        const small = await suggestSmallerMarketBuy(
          {} as Pool,
          {
            ...suggestionSnapshot,
            sources: [],
            projection: {
              ...suggestionSnapshot.projection,
              availableNowRaw: (BigInt(cents) * 10_000n).toString(),
            },
          },
          account,
          DEFAULT_FUNDING_RUNTIME_POLICY,
          async (_pool, input) =>
            findMaxPolymarketMarketBuyUsdDetailed({
              ...input,
              context: noFeeNoMinContext(),
              requireOrderbookDepth: true,
            }),
        );
        assert.equal(
          small?.amountUsdCents,
          cents === 100 ? 100 : undefined,
          "never offer a sub-dollar Buy",
        );
      }
      assert.equal(
        await suggestSmallerMarketBuy(
          {} as Pool,
          suggestionSnapshot,
          account,
          DEFAULT_FUNDING_RUNTIME_POLICY,
          async () => {
            throw new Error("CLOB fixture unavailable");
          },
        ),
        null,
      );
      const started = Date.now();
      assert.equal(
        await suggestSmallerMarketBuy(
          {} as Pool,
          suggestionSnapshot,
          account,
          DEFAULT_FUNDING_RUNTIME_POLICY,
          () => new Promise(() => {}),
        ),
        null,
      );
      assert.ok(
        Date.now() - started < 2_000,
        "optional advice must not hold the funding response for CLOB timeout",
      );
      assert.equal(
        suggestion.expiresAt,
        suggestionSnapshot.sources[0]?.option.expiresAt,
      );
      const beforeInvalid = suggestionQuoteCalls;
      const shortageAccount = {
        ...account,
        projection: { ...account.projection, collectorErrors: [] },
        cashAvailability: {
          ...account.cashAvailability,
          completeness: "complete" as const,
          freshness: "fresh" as const,
          collectorErrors: [],
          components: [
            {
              availableRaw: "1723368",
              amount: { asset: destinationAsset },
              freshness: "fresh",
              reasonCodes: [],
            },
            {
              availableRaw: "16634",
              amount: {
                asset: {
                  networkId: "evm:8453",
                  assetId: env.limitlessUsdcAddress,
                  decimals: 6,
                },
              },
              freshness: "fresh",
              reasonCodes: [],
            },
          ],
        },
      } as unknown as AccountValueReadModel;
      const shortageRequest = {
        ...suggestionSnapshot.request,
        marketBuyAmountUsdCents: 500,
        requestedDestinationAmount: { asset: destinationAsset, raw: "5297502" },
      };
      const shortageReasons = classifyProvenCashShortfall(
        shortageAccount,
        shortageRequest,
        ["insufficient_liquidity", "provider_quote_rejected"],
      );
      assert.deepEqual(shortageReasons, ["insufficient_liquidity"]);
      const shortageHint = await suggestSmallerMarketBuy(
        {} as Pool,
        {
          ...suggestionSnapshot,
          request: shortageRequest,
          sources: [],
          projection: {
            ...suggestionSnapshot.projection,
            sourceOptions: [],
            availableNowRaw: "1723368",
            requestedCollateralRaw: "5297502",
            reasonCodes: shortageReasons,
          },
        },
        shortageAccount,
        DEFAULT_FUNDING_RUNTIME_POLICY,
        async (_pool, input) => {
          assert.equal(
            input.executableFundsRaw,
            1723368n,
            "rejected Base cash must not inflate executable Reduce",
          );
          return findMaxPolymarketMarketBuyUsdDetailed({
            ...input,
            context: quoteContext({ feePolicySnapshot: builderFeePolicy(595) }),
            requireOrderbookDepth: true,
          });
        },
      );
      assert.equal(shortageHint?.amountUsdCents, 162);
      // MAR41/42: nominal cash covers the order, but the verified Solana
      // output does not. A rejected Base dust route must not suppress advice.
      const partialRoute = accountMaxRelaySource({
        destinationAsset,
        destinationRaw: "1922596",
      });
      const mixedSnapshot = {
        ...suggestionSnapshot,
        request: {
          ...suggestionSnapshot.request,
          marketBuyAmountUsdCents: 476,
        },
        projection: {
          ...suggestionSnapshot.projection,
          availableNowRaw: "2996173",
          requestedCollateralRaw: "4997811",
          reasonCodes: [
            "insufficient_liquidity",
            "provider_quote_rejected",
          ] as const,
        },
        sources: [
          {
            ...partialRoute,
            option: {
              ...partialRoute.option,
              selectable: false,
              reasonCodes: ["minimum_output_not_met"] as const,
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
        ],
      };
      const mixedHint = await suggestSmallerMarketBuy(
        {} as Pool,
        mixedSnapshot,
        account,
        DEFAULT_FUNDING_RUNTIME_POLICY,
        async (_pool, input) => {
          assert.equal(input.executableFundsRaw, 4918769n);
          return findMaxPolymarketMarketBuyUsdDetailed({
            ...input,
            context: quoteContext({ feePolicySnapshot: builderFeePolicy(500) }),
            requireOrderbookDepth: true,
          });
        },
      );
      assert.ok(mixedHint && mixedHint.amountUsdCents < 476);
      for (const reason of [
        "provider_status_unknown",
        "rpc_unavailable",
        "provider_quote_invalid",
        "insufficient_gas",
      ] as const) {
        assert.equal(
          await suggestSmallerMarketBuy(
            {} as Pool,
            {
              ...mixedSnapshot,
              projection: {
                ...mixedSnapshot.projection,
                reasonCodes: [...mixedSnapshot.projection.reasonCodes, reason],
              },
            },
            account,
            DEFAULT_FUNDING_RUNTIME_POLICY,
            async () => {
              throw new Error("Unsafe advice must not request a quote");
            },
          ),
          undefined,
        );
      }
      const belowFloorRoute = accountMaxRelaySource({
        destinationAsset,
        destinationRaw: "377645",
      });
      const refillFloorHint = await suggestSmallerMarketBuy(
        {} as Pool,
        {
          ...suggestionSnapshot,
          request: {
            ...suggestionSnapshot.request,
            marketBuyAmountUsdCents: 235,
          },
          projection: {
            ...suggestionSnapshot.projection,
            availableNowRaw: "2117991",
            requestedCollateralRaw: "2489827",
          },
          sources: [
            {
              ...belowFloorRoute,
              option: {
                ...belowFloorRoute.option,
                expiresAt: new Date(Date.now() + 30_000).toISOString(),
              },
            },
          ],
        },
        account,
        DEFAULT_FUNDING_RUNTIME_POLICY,
        async (_pool, input) => {
          assert.equal(
            input.executableFundsRaw,
            2117991n,
            "a route below the refill floor cannot increase Reduce",
          );
          return findMaxPolymarketMarketBuyUsdDetailed({
            ...input,
            context: quoteContext({ feePolicySnapshot: builderFeePolicy(595) }),
            requireOrderbookDepth: true,
          });
        },
      );
      assert.equal(refillFloorHint?.amountUsdCents, 199);
      for (const [feeUsd, expectedCents, expectedBudgets] of [
        ["0.04", 500, [5_000_000n]],
        ["1.10", 492, [5_000_000n, 4_920_000n]],
      ] as const) {
        const tinyRoute = accountMaxRelaySource({
          destinationAsset,
          destinationRaw: "80000",
        });
        const budgets: bigint[] = [];
        const reduced = await suggestSmallerMarketBuy(
          {} as Pool,
          {
            ...suggestionSnapshot,
            projection: {
              ...suggestionSnapshot.projection,
              availableNowRaw: "4920000",
            },
            sources: [
              {
                ...tinyRoute,
                option: {
                  ...tinyRoute.option,
                  expiresAt: new Date(Date.now() + 30_000).toISOString(),
                  fees: tinyRoute.option.fees.map((fee) => ({
                    ...fee,
                    estimatedUsd: feeUsd,
                  })),
                },
              },
            ],
          },
          account,
          {
            ...DEFAULT_FUNDING_RUNTIME_POLICY,
            placement: {
              ...DEFAULT_FUNDING_RUNTIME_POLICY.placement,
              minimumDestinationUsd: "0",
            },
          },
          async (_pool, input) => {
            budgets.push(input.executableFundsRaw);
            return findMaxPolymarketMarketBuyUsdDetailed({
              ...input,
              context: noFeeNoMinContext(),
              requireOrderbookDepth: true,
            });
          },
        );
        assert.equal(
          reduced?.amountUsdCents,
          expectedCents,
          "with the refill floor disabled, Reduce still rechecks the smaller Buy fee budget",
        );
        assert.deepEqual(budgets, expectedBudgets);
      }
      assert.equal(
        await suggestSmallerMarketBuy(
          {} as Pool,
          suggestionSnapshot,
          account,
          DEFAULT_FUNDING_RUNTIME_POLICY,
          async () => ({ ok: false, reason: "no_liquidity" }),
        ),
        null,
        "missing book liquidity is not evidence that a deposit will help",
      );
      for (const projection of [
        { ...suggestionSnapshot.projection, completeness: "partial" as const },
        { ...suggestionSnapshot.projection, freshness: "stale" as const },
        {
          ...suggestionSnapshot.projection,
          errors: [{ code: "provider_status_unknown", retryable: true }],
        },
        {
          ...suggestionSnapshot.projection,
          reasonCodes: [
            "insufficient_liquidity",
            "provider_quote_economics_rejected",
          ] as const,
        },
        {
          ...suggestionSnapshot.projection,
          expiresAt: new Date(0).toISOString(),
        },
        {
          ...suggestionSnapshot.projection,
          sourceOptions: [{ ...routeSource.option, selectable: true }],
        },
      ])
        assert.equal(
          await suggest({ ...suggestionSnapshot, projection }),
          Date.parse(projection.expiresAt) <= Date.now() ? null : undefined,
        );
      assert.equal(
        await suggest({
          ...suggestionSnapshot,
          request: {
            ...suggestionSnapshot.request,
            marketBuyAmountUsdCents: undefined,
          },
        }),
        undefined,
        "legacy/limit clients stay unchanged",
      );
      assert.equal(
        suggestionQuoteCalls,
        beforeInvalid,
        "unavailable evidence does not load an orderbook",
      );
      assert.equal(
        await suggest({
          ...suggestionSnapshot,
          request: {
            ...suggestionSnapshot.request,
            marketBuyAmountUsdCents: 1,
          },
        }),
        undefined,
        "never increase an entered amount",
      );
      await suggest({
        ...suggestionSnapshot,
        sources: [...suggestionSnapshot.sources, ...suggestionSnapshot.sources],
      });
      assert.equal(
        suggestionBudget,
        4_860_000n,
        "overlapping source quotes are not added together",
      );
      await suggest({
        ...suggestionSnapshot,
        sources: suggestionSnapshot.sources.map((source) => ({
          ...source,
          commitPlan: {
            ...source.commitPlan,
            reservations: source.commitPlan.reservations.map((reservation) => ({
              ...reservation,
              locationId: destinationLocation.locationId,
            })),
          },
        })),
      });
      assert.equal(
        suggestionBudget,
        430_000n,
        "direct destination cash cannot be counted twice",
      );
      assert.equal(
        await suggestSmallerMarketBuy(
          {} as Pool,
          suggestionSnapshot,
          account,
          DEFAULT_FUNDING_RUNTIME_POLICY,
          async () => ({ ok: false, reason: "below_min_order" }),
        ),
        undefined,
      );

      assert.equal(result.ok, true);
      assert.equal(quotedFundsRaw, 4_860_000n);
      const estimateAccount = {
        ...account,
        projection: {
          ...account.projection,
          components: [
            {
              componentId: "cash",
              location: {
                kind: "wallet",
                locationId: "internal",
                details: { walletId: "wallet_controller_after_trade_12345678" },
              },
            },
          ],
        },
        cashAvailability: {
          ...account.cashAvailability,
          components: [{ componentId: "cash", availableEstimatedUsd: "5.78" }],
        },
      } as unknown as AccountValueReadModel;
      const amountEstimate = await computePolymarketAccountMaxSpend({
        ...requestInput,
        amountEstimateOnly: true,
        dependencies: {
          ...requestInput.dependencies,
          buildAccountValueReadModel: async () => estimateAccount,
          createFundingRuntime: () => {
            throw new Error(
              "Amount MAX must never query Relay or funding planner",
            );
          },
        },
      });
      assert.equal(amountEstimate.ok, true);
      assert.equal(amountEstimate.executableFundsRaw, "5780000");
      const limitEstimate = await computePolymarketAccountMaxSpend({
        ...requestInput,
        amountEstimateOnly: true,
        orderType: "GTC",
        limitPrice: 0.23,
        dependencies: {
          ...requestInput.dependencies,
          buildAccountValueReadModel: async () => estimateAccount,
          createFundingRuntime: () => {
            throw new Error("Limit Max must not query Relay");
          },
          findMaxPolymarketMarketBuyUsdForFunds: async () => {
            throw new Error("Limit Max must not use FOK prices");
          },
        },
      });
      assert.equal(limitEstimate.ok, true);
      assert.equal(limitEstimate.orderType, "GTC");
      assert.equal(limitEstimate.amountType, "shares");
      assert.ok(BigInt(String(limitEstimate.maxSharesRaw)) > 0n);
      assert.ok(
        BigInt(String(limitEstimate.totalRequiredUsdcRaw)) <= 5_780_000n,
      );
      const sessionEstimateAccount = {
        ...estimateAccount,
        ownership: {
          ...estimateAccount.ownership,
          wallets: [
            ...(estimateAccount.ownership?.wallets ?? []),
            {
              walletId: "external-estimate",
              source: "external",
              controllerWalletRef: "external-ref",
            },
          ],
        },
        projection: {
          ...estimateAccount.projection,
          components: [
            ...estimateAccount.projection.components,
            {
              componentId: "external-cash",
              location: {
                kind: "wallet",
                locationId: "external-location",
                details: { walletId: "external-estimate" },
              },
            },
          ],
        },
        cashAvailability: {
          ...estimateAccount.cashAvailability,
          components: [
            ...estimateAccount.cashAvailability.components,
            { componentId: "external-cash", availableEstimatedUsd: "3.33" },
          ],
        },
      } as unknown as AccountValueReadModel;
      for (const refs of [undefined, [], ["foreign-ref"], ["external-ref"]]) {
        const estimate = await computePolymarketAccountMaxSpend({
          ...requestInput,
          amountEstimateOnly: true,
          connectedExternalWalletRefs: refs,
          dependencies: {
            ...requestInput.dependencies,
            buildAccountValueReadModel: async () => sessionEstimateAccount,
            createFundingRuntime: () => {
              throw new Error("MAX must not query Relay");
            },
          },
        });
        assert.equal(estimate.ok, true);
        assert.equal(
          estimate.executableFundsRaw,
          refs?.includes("external-ref") ? "9110000" : "5780000",
        );
      }
      assert.ok(
        BigInt(String(amountEstimate.totalRequiredUsdcRaw)) <= 5_780_000n,
      );
      // Exercise the actual valuation/projector chain, not a pre-priced SOL
      // mock: MAX must install the display adapter, while strict planning above
      // must remain independent of display prices.
      let solUsd: string | null = "10";
      const solPriceAdapter: PriceAdapter = {
        adapterId: PYTH_SOL_USD_PRICE_POLICY_ID,
        value: async ({ policyId, observedAt }) =>
          policyId === PYTH_SOL_USD_PRICE_POLICY_ID && solUsd != null
            ? {
                value: solUsd,
                asOf: observedAt,
                confidence: "high",
                priceSource: PYTH_SOL_USD_PRICE_POLICY_ID,
                policyId,
              }
            : null,
      };
      const solObservation = buildAccountValueObservation({
        accountId: requestInput.userId,
        resolution: {
          walletAddress: "11111111111111111111111111111111",
          walletType: "solana",
          linkedWalletAddress: "11111111111111111111111111111111",
          source: "linked",
        },
        balance: {
          chainId: "7565164",
          address: SOLANA_NATIVE_ASSET.assetId,
          symbol: "SOL",
          name: "Solana",
          decimals: 9,
          balance: "1",
          balanceRaw: "1000000000",
          isNative: true,
          observedAt: new Date().toISOString(),
        },
        entry: {
          asset: SOLANA_NATIVE_ASSET,
          category: "cash",
          symbol: "SOL",
          venueId: null,
          pricePolicyId: PYTH_SOL_USD_PRICE_POLICY_ID,
          verified: true,
        },
      });
      let includeStable = false;
      const solEstimateDependencies = {
        ...requestInput.dependencies,
        amountEstimatePriceAdapters: [solPriceAdapter],
        createFundingRuntime: () => {
          throw new Error("SOL amount MAX must never query Relay");
        },
        buildAccountValueReadModel: async (
          input: Parameters<typeof buildAccountValueReadModel>[0],
        ) => {
          assert.deepEqual(input.additionalPriceAdapters, [solPriceAdapter]);
          const components = await new ValuationService({
            policies: [
              {
                asset: SOLANA_NATIVE_ASSET,
                category: "cash",
                pricePolicyId: PYTH_SOL_USD_PRICE_POLICY_ID,
                maximumObservationAgeMs: 60_000,
                executionEligibility: "unknown",
              },
            ],
            adapters: input.additionalPriceAdapters ?? [],
          }).value([solObservation]);
          const cashAvailability = projectCashAvailability({
            components,
            adjustments: [],
            asOf: solObservation.observedAt,
          });
          return {
            ...estimateAccount,
            projection: {
              ...estimateAccount.projection,
              components: [
                ...components,
                ...(includeStable ? estimateAccount.projection.components : []),
              ],
            },
            cashAvailability: {
              ...cashAvailability,
              components: [
                ...cashAvailability.components,
                ...(includeStable
                  ? estimateAccount.cashAvailability.components
                  : []),
              ],
            },
          } as AccountValueReadModel;
        },
      };
      const solOnlyMax = await computePolymarketAccountMaxSpend({
        ...requestInput,
        amountEstimateOnly: true,
        dependencies: solEstimateDependencies,
      });
      assert.equal(solOnlyMax.ok, true);
      assert.equal(solOnlyMax.executableFundsRaw, "10000000");
      includeStable = true;
      const mixedMax = await computePolymarketAccountMaxSpend({
        ...requestInput,
        amountEstimateOnly: true,
        dependencies: solEstimateDependencies,
      });
      assert.equal(mixedMax.ok, true);
      assert.equal(mixedMax.executableFundsRaw, "15780000");
      solUsd = null;
      const missingSolPrice = await computePolymarketAccountMaxSpend({
        ...requestInput,
        amountEstimateOnly: true,
        dependencies: solEstimateDependencies,
      });
      assert.equal(missingSolPrice.ok, true);
      assert.equal(missingSolPrice.executableFundsRaw, "5780000");
      assert.equal(result.fundingScope, "account");
      assert.equal(result.executableFundsRaw, "4860000");
      assert.equal(previewRequests.length, 2);
      for (const request of previewRequests) {
        assert.equal(
          request.maxSlippageBps,
          null,
          "funding uses ordinary Buy policy, not order slippage",
        );
        assert.deepEqual(
          request.connectedExternalWalletRefs,
          connectedExternalWalletRefs,
          "capacity and exact Buy proof must use the same connected owner capabilities",
        );
      }
      assert.equal(
        previewRequests[1]?.serverAdditionalDestinationAmount?.raw,
        (BigInt(String(result.totalRequiredUsdcRaw)) - 430_000n).toString(),
      );
      assert.ok(BigInt(String(result.maxAmountUsdRaw)) >= 2_500_000n);
      for (const failureAt of [1, 2]) {
        let calls = 0;
        const recovered = await computePolymarketAccountMaxSpend({
          ...requestInput,
          dependencies: {
            ...requestInput.dependencies,
            createFundingRuntime: () => ({
              previewLiquidity: async () => {
                calls++;
                return calls === failureAt
                  ? {
                      ...preview,
                      projection: {
                        ...preview.projection,
                        completeness: "partial",
                        freshness: "stale",
                        reasonCodes: ["provider_status_unknown"],
                      },
                    }
                  : preview;
              },
            }),
          },
        });
        assert.equal(
          recovered.ok,
          true,
          "transient provider failure must recover in either phase",
        );
        assert.equal(calls, 3);
      }
      let persistentCalls = 0;
      const persistentFailure = await computePolymarketAccountMaxSpend({
        ...requestInput,
        dependencies: {
          ...requestInput.dependencies,
          createFundingRuntime: () => ({
            previewLiquidity: async () => {
              persistentCalls++;
              return {
                ...preview,
                projection: {
                  ...preview.projection,
                  completeness: "partial",
                  freshness: "stale",
                  reasonCodes: ["provider_status_unknown"],
                },
              };
            },
          }),
        },
      });
      assert.equal(persistentFailure.ok, false);
      assert.equal(
        persistentCalls,
        2,
        "persistent outages must not create retry storms",
      );
      const unavailableRoute = await computePolymarketAccountMaxSpend({
        ...requestInput,
        dependencies: {
          ...requestInput.dependencies,
          createFundingRuntime: () => ({
            previewLiquidity: async () => ({
              ...preview,
              projection: {
                ...preview.projection,
                sourceOptions: [
                  {
                    ...routeSource.option,
                    selectable: false,
                    reasonCodes: ["fee_limit_exceeded"],
                  },
                ],
              },
            }),
          }),
        },
      });
      assert.equal(
        unavailableRoute.ok,
        false,
        "aggregate capacity cannot certify an unavailable ordinary Buy route",
      );
      const verifiedLimit = await computePolymarketAccountMaxSpend({
        ...requestInput,
        orderType: "GTC",
        limitPrice: 0.23,
      });
      assert.equal(verifiedLimit.ok, true);
      assert.equal(verifiedLimit.orderType, "GTC");
      assert.ok(
        BigInt(String(verifiedLimit.totalRequiredUsdcRaw)) <= 4_860_000n,
      );
      assert.ok(BigInt(String(verifiedLimit.maxSharesRaw)) > 0n);
    },
  },
  {
    name: "account MAX excludes connected external wallet source locations",
    run: () => {
      const account = {
        ownership: {
          wallets: [
            {
              walletId: "wallet_external",
              source: "external",
              controllerWalletRef: "external-ref",
            },
            { walletId: "wallet_internal", source: "embedded" },
          ],
        },
        projection: {
          components: [
            {
              location: {
                kind: "wallet",
                locationId: "location_external",
                details: { walletId: "wallet_external" },
              },
            },
            {
              location: {
                kind: "wallet",
                locationId: "location_internal",
                details: { walletId: "wallet_internal" },
              },
            },
            {
              location: {
                kind: "venue_account",
                locationId: "location_external_venue",
                details: { controllerWalletId: "wallet_external" },
              },
            },
            {
              location: {
                kind: "venue_account",
                locationId: "location_owned_safe",
                details: {
                  controllerWalletId: "wallet_external",
                  venueId: "polymarket",
                  polymarketFunderKind: "safe",
                },
              },
            },
          ],
        },
      } as unknown as AccountValueReadModel;
      assert.deepEqual(externalWalletSourceLocationIds(account), [
        "location_external",
        "location_external_venue",
      ]);
      for (const refs of [undefined, [], ["unrelated-ref"]])
        assert.deepEqual(unavailableSessionSourceLocationIds(account, refs), [
          "location_external",
          "location_external_venue",
          "location_owned_safe",
        ]);
      assert.deepEqual(
        unavailableSessionSourceLocationIds(account, ["external-ref"]),
        [],
      );
    },
  },
  {
    name: "account MAX resolves external controllers from real derived-funder observations",
    run: () => {
      const controller = "0x0000000000000000000000000000000000000044";
      const asset: AssetRef = {
        networkId: "evm:137",
        assetId: env.polymarketPusdAddress,
        decimals: 6,
      };
      const observation = buildAccountValueObservation({
        accountId: "account_external_funder",
        resolution: {
          walletAddress: DEPOSIT,
          walletType: "ethereum",
          linkedWalletAddress: controller,
          source: "derived_funder",
          polymarketFunderKind: "deposit_wallet",
        },
        balance: {
          chainId: "137",
          address: asset.assetId,
          symbol: "pUSD",
          name: "Polymarket USD",
          decimals: 6,
          balanceRaw: "100000000",
          balance: "100",
          isNative: false,
          observedAt: new Date().toISOString(),
        },
        entry: {
          asset,
          category: "cash",
          symbol: "pUSD",
          venueId: "polymarket",
          pricePolicyId: "exact-stable-policy-v1",
          verified: true,
        },
      });
      const controllerWalletId = stableWalletOpaqueId({
        walletType: "ethereum",
        networkId: "evm:137",
        address: controller,
      });
      assert.equal(
        observation.location.details.controllerWalletId,
        controllerWalletId,
      );
      assert.notEqual(
        observation.location.details.walletId,
        controllerWalletId,
      );
      const account = {
        ownership: {
          wallets: [
            {
              walletId: controllerWalletId,
              source: "external",
              networkId: "evm:137",
              address: controller,
            },
            {
              walletId: observation.location.details.walletId,
              source: "smart",
              networkId: "evm:137",
              address: DEPOSIT,
            },
          ],
        },
        projection: { components: [observation] },
      } as unknown as AccountValueReadModel;
      assert.deepEqual(externalWalletSourceLocationIds(account), [
        observation.location.locationId,
      ]);
      // Older inventory snapshots have only linkedAddress, not controllerWalletId.
      const legacyShape = structuredClone(account);
      const legacyComponent = legacyShape.projection.components[0];
      assert.ok(legacyComponent);
      delete (legacyComponent.location.details as Record<string, unknown>)
        .controllerWalletId;
      assert.deepEqual(externalWalletSourceLocationIds(legacyShape), [
        observation.location.locationId,
      ]);
      const ownedSafe = structuredClone(account);
      const safeComponent = ownedSafe.projection.components[0];
      assert.ok(safeComponent);
      (
        safeComponent.location.details as Record<string, unknown>
      ).polymarketFunderKind = "safe";
      assert.deepEqual(externalWalletSourceLocationIds(ownedSafe), []);
    },
  },
  {
    name: "max-spend accepts the explicit account funding scope without changing legacy requests",
    run: () => {
      const account = polymarketMaxSpendBodySchema.parse({
        tokenId: "token-yes",
        side: "BUY",
        orderType: "FOK",
        amountType: "usd",
        fundingScope: "account",
        executableFundsRaw: "999999999999",
      });
      assert.equal(account.fundingScope, "account");
      const legacy = polymarketMaxSpendBodySchema.parse({
        tokenId: "token-yes",
        side: "BUY",
      });
      assert.equal(legacy.fundingScope, undefined);
    },
  },
  {
    name: "signed FOK Buy recomputes the same fee-inclusive collateral bound",
    run: () => {
      const context = quoteContext({
        orderbook: {
          bids: [{ price: 0.5, size: 10_000 }],
          asks: [{ price: 0.51, size: 10_000 }],
          tickSize: 0.01,
          minOrderSize: 5,
          negRisk: false,
        },
        feePolicySnapshot: builderFeePolicy(100),
      });
      const quote = calculatePolymarketQuote({
        amountType: "usd",
        amountUsdRawInput: 5_000_000n,
        context,
        orderType: "FOK",
        side: "BUY",
        slippageBps: 500,
        tokenId: "token-yes",
      });
      const requiredSpendRaw = calculatePolymarketSignedFokBuyRequiredSpendRaw({
        context,
        makerAmountRaw: BigInt(quote.makerAmount),
        takerAmountRaw: BigInt(quote.takerAmount),
      });
      assert.equal(requiredSpendRaw?.toString(), quote.totalRequiredUsdcRaw);
      assert.ok((requiredSpendRaw ?? 0n) > BigInt(quote.makerAmount));
    },
  },
  {
    name: "FAK remains partial-fill and uses the immediate taker debit bound",
    run: () => {
      const context = quoteContext({
        feePolicySnapshot: builderFeePolicy(100),
        platformFeeCurve: takerOnlyPlatformFeeCurve(0.25, 2),
      });
      const quote = calculatePolymarketQuote({
        amountType: "usd",
        amountUsdRawInput: 5_000_000n,
        context,
        orderType: "FAK",
        side: "BUY",
        slippageBps: 500,
        tokenId: "token-yes",
      });

      assert.equal(normalizeOrderTypeForClob("FAK"), "FAK");
      assert.equal(quote.orderType, "FAK");
      assert.equal(quote.feeRoleAssumption, "taker");
      assert.equal(quote.postOnly, false);
      assert.equal(
        calculatePolymarketSignedBuyRequiredSpendRaw({
          context,
          makerAmountRaw: BigInt(quote.makerAmount),
          orderType: "FAK",
          postOnly: false,
          takerAmountRaw: BigInt(quote.takerAmount),
        })?.toString(),
        quote.totalRequiredUsdcRaw,
      );
      assert.throws(
        () =>
          calculatePolymarketQuote({
            amountType: "usd",
            amountUsdRawInput: 5_000_000n,
            context,
            orderType: "FAK",
            postOnly: true,
            side: "BUY",
            tokenId: "token-yes",
          }),
        (error) =>
          error instanceof PolymarketQuoteError &&
          error.reason === "invalid_order_options",
      );
    },
  },
  {
    name: "ordinary GTC Buy reserves the larger maker-or-taker debit",
    run: () => {
      const context = quoteContext({
        feePolicySnapshot: {
          ...builderFeePolicy(100),
          builderMakerFeeBps: 25,
          builderRateSource: "polymarket",
        },
        platformFeeCurve: takerOnlyPlatformFeeCurve(0.25, 2),
      });
      const postOnly = calculatePolymarketQuote({
        amountType: "usd",
        amountUsdRawInput: 5_000_000n,
        context,
        limitPrice: 0.6,
        orderType: "GTC",
        postOnly: true,
        side: "BUY",
        tokenId: "token-yes",
      });
      const marketable = calculatePolymarketQuote({
        amountType: "usd",
        amountUsdRawInput: 5_000_000n,
        context,
        limitPrice: 0.6,
        orderType: "GTC",
        postOnly: false,
        side: "BUY",
        tokenId: "token-yes",
      });

      assert.equal(postOnly.feeRoleAssumption, "maker");
      assert.equal(postOnly.postOnly, true);
      assert.equal(postOnly.platformFeeEstimateRaw, "0");
      assert.equal(postOnly.builderFeeBoundBps, 25);
      assert.equal(marketable.feeRoleAssumption, "maker_or_taker");
      assert.equal(marketable.postOnly, false);
      assert.equal(marketable.builderFeeBoundBps, 100);
      assert.ok(
        BigInt(marketable.totalRequiredUsdcRaw ?? "0") >
          BigInt(postOnly.totalRequiredUsdcRaw ?? "0"),
      );

      for (const quote of [postOnly, marketable]) {
        const recomputed = calculatePolymarketSignedBuyRequiredSpendRaw({
          context,
          makerAmountRaw: BigInt(quote.makerAmount),
          orderType: "GTC",
          postOnly: quote.postOnly,
          takerAmountRaw: BigInt(quote.takerAmount),
        });
        assert.equal(recomputed?.toString(), quote.totalRequiredUsdcRaw);
      }
    },
  },
  {
    name: "post-only GTC fails closed when live fee role metadata is unavailable",
    run: () => {
      const context = quoteContext({
        marketInfo: { ...baseMarketInfo, maker_fee_bps: "900" },
        platformFeeCurveUnavailable: true,
      });
      assert.throws(
        () =>
          calculatePolymarketQuote({
            amountType: "usd",
            amountUsdRawInput: 5_000_000n,
            context,
            limitPrice: 0.4,
            orderType: "GTC",
            postOnly: true,
            side: "BUY",
            tokenId: "token-yes",
          }),
        (error) =>
          error instanceof PolymarketQuoteError &&
          error.reason === "fee_unavailable",
      );
      assert.throws(
        () =>
          calculatePolymarketQuote({
            amountType: "usd",
            amountUsdRawInput: 5_000_000n,
            context,
            orderType: "FOK",
            side: "BUY",
            tokenId: "token-yes",
          }),
        (error) =>
          error instanceof PolymarketQuoteError &&
          error.reason === "fee_unavailable",
      );
    },
  },
  {
    name: "post-only GTC honors authoritative CLOB fee role metadata",
    run: () => {
      const sharedCurve = parsePolymarketPlatformFeeCurve({
        fd: { r: 0.25, e: 2 },
        mbf: 0,
        tbf: 0,
      });
      assert.equal(sharedCurve.takerOnly, false);
      const sharedCurveQuote = calculatePolymarketQuote({
        amountType: "usd",
        amountUsdRawInput: 5_000_000n,
        context: quoteContext({ platformFeeCurve: sharedCurve }),
        limitPrice: 0.6,
        orderType: "GTC",
        postOnly: true,
        side: "BUY",
        tokenId: "token-yes",
      });
      assert.ok(BigInt(sharedCurveQuote.platformFeeEstimateRaw) > 0n);

      const takerOnlyWithMakerBase = parsePolymarketPlatformFeeCurve({
        fd: { r: 0.25, e: 2, to: true },
        mbf: 900,
        tbf: 0,
      });
      assert.equal(takerOnlyWithMakerBase.takerOnly, true);
      const makerBaseQuote = calculatePolymarketQuote({
        amountType: "usd",
        amountUsdRawInput: 5_000_000n,
        context: quoteContext({
          platformFeeCurve: takerOnlyWithMakerBase,
        }),
        limitPrice: 0.6,
        orderType: "GTC",
        postOnly: true,
        side: "BUY",
        tokenId: "token-yes",
      });
      assert.ok(BigInt(makerBaseQuote.platformFeeEstimateRaw) > 0n);

      assert.throws(
        () =>
          parsePolymarketPlatformFeeCurve({
            fd: { r: 0.25, e: 2, to: true },
            mbf: Number.MAX_VALUE,
            tbf: 0,
          }),
        /Invalid Polymarket base fee parameters/,
      );
      assert.throws(
        () =>
          calculatePolymarketQuote({
            amountType: "usd",
            amountUsdRawInput: 5_000_000n,
            context: quoteContext({
              platformFeeCurve: {
                rate: Number.MAX_VALUE,
                exponent: 2,
                takerOnly: false,
                makerBaseFeeBps: 0,
                takerBaseFeeBps: 0,
              },
            }),
            limitPrice: 0.6,
            orderType: "GTC",
            postOnly: true,
            side: "BUY",
            tokenId: "token-yes",
          }),
        (error) =>
          error instanceof PolymarketQuoteError &&
          error.reason === "fee_unavailable",
      );
    },
  },
  {
    name: "signed FOK Buy reserves the maximum fee over every allowed execution price",
    run: () => {
      const context = quoteContext({
        orderbook: {
          bids: [{ price: 0.09, size: 10_000 }],
          asks: [{ price: 0.1, size: 10_000 }],
          tickSize: 0.01,
          minOrderSize: 5,
          negRisk: false,
        },
        marketInfo: { ...baseMarketInfo, taker_fee_bps: "0" },
        platformFeeCurve: takerOnlyPlatformFeeCurve(0.25, 2),
      });
      const quote = calculatePolymarketQuote({
        amountType: "usd",
        amountUsdRawInput: 5_000_000n,
        context,
        orderType: "FOK",
        side: "BUY",
        slippageBps: 500,
        tokenId: "token-yes",
      });
      const requiredSpendRaw = calculatePolymarketSignedFokBuyRequiredSpendRaw({
        context,
        makerAmountRaw: BigInt(quote.makerAmount),
        takerAmountRaw: BigInt(quote.takerAmount),
      });
      assert.equal(requiredSpendRaw?.toString(), quote.totalRequiredUsdcRaw);
      const reservedFeeRaw =
        (requiredSpendRaw ?? 0n) - BigInt(quote.makerAmount);
      const maximumPriceCents = Math.round(quote.price * 100);
      let feeAtCurrentAskRaw = 0n;
      for (
        let priceCents = 1;
        priceCents <= maximumPriceCents;
        priceCents += 1
      ) {
        const priceRaw = BigInt(priceCents * 10_000);
        const sizeRaw =
          (BigInt(quote.makerAmount) * 1_000_000n + priceRaw - 1n) / priceRaw;
        const price = priceCents / 100;
        const actualFeeRaw = BigInt(
          Math.ceil(
            (Number(sizeRaw) / 1_000_000) *
              0.25 *
              Math.pow(price * (1 - price), 2) *
              1_000_000,
          ),
        );
        assert.ok(reservedFeeRaw >= actualFeeRaw);
        if (priceCents === 10) feeAtCurrentAskRaw = actualFeeRaw;
      }
      assert.ok(reservedFeeRaw > feeAtCurrentAskRaw);
    },
  },
  {
    name: "signed FOK Buy fails closed when authoritative fee context is unavailable",
    run: () => {
      const requiredSpendRaw = calculatePolymarketSignedFokBuyRequiredSpendRaw({
        context: quoteContext({ platformFeeCurveUnavailable: true }),
        makerAmountRaw: 5_000_000n,
        takerAmountRaw: 10_000_000n,
      });
      assert.equal(requiredSpendRaw, null);
    },
  },
  {
    name: "signed FOK Buy rejects non-computable finite fee curves",
    run: () => {
      const requiredSpendRaw = calculatePolymarketSignedFokBuyRequiredSpendRaw({
        context: quoteContext({
          marketInfo: { ...baseMarketInfo, taker_fee_bps: "0" },
          platformFeeCurve: takerOnlyPlatformFeeCurve(Number.MAX_VALUE, 2),
        }),
        makerAmountRaw: 5_000_000n,
        takerAmountRaw: 10_000_000n,
      });
      assert.equal(requiredSpendRaw, null);
    },
  },
  {
    name: "max spend preserves exact cent raw amounts without float drift",
    run: () => {
      const context = noFeeNoMinContext();
      for (const cents of [29n, 57n, 116n]) {
        const expectedRaw = cents * 10_000n;
        const max = findMaxPolymarketMarketBuyUsd({
          context,
          tokenId: "token-yes",
          executableFundsRaw: expectedRaw,
        });

        assert.ok(max);
        assert.equal(max.maxAmountUsdRaw, expectedRaw.toString());
        assert.equal(max.quote.makerAmount, expectedRaw.toString());
        assert.equal(max.quote.totalRequiredUsdcRaw, expectedRaw.toString());
        assert.equal(max.quote.amountUsdUsed, Number(expectedRaw) / 1_000_000);
      }
    },
  },
  {
    name: "max spend is lower than visible funds when quote fees exceed funds",
    run: () => {
      const context = quoteContext();
      const executableFundsRaw = 848_860_000n;
      const fullQuote = calculatePolymarketQuote({
        tokenId: "token-yes",
        side: "BUY",
        orderType: "FOK",
        amountType: "usd",
        amountUsdInput: 848.86,
        context,
      });
      assert.ok(
        BigInt(fullQuote.totalRequiredUsdcRaw ?? "0") > executableFundsRaw,
      );

      const max = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw,
      });
      assert.ok(max);
      assert.ok(Number(max.maxAmountUsdRaw) < Number(executableFundsRaw));
      assert.ok(
        BigInt(max.quote.totalRequiredUsdcRaw ?? "0") <= executableFundsRaw,
      );
    },
  },
  {
    name: "account max converts 0.43 direct plus 4.43 routed into one fee-aware nominal",
    run: () => {
      const context = quoteContext();
      const directRaw = 430_000n;
      const routedMinimumRaw = 4_430_000n;
      const executableFundsRaw = directRaw + routedMinimumRaw;
      const max = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw,
      });

      assert.ok(max);
      assert.ok(BigInt(max.maxAmountUsdRaw) < executableFundsRaw);
      assert.ok(
        BigInt(max.quote.totalRequiredUsdcRaw ?? "0") <= executableFundsRaw,
      );
    },
  },
  {
    name: "deposit wallet executable funds include funder pUSD plus signer pUSD and USDC.e",
    run: () => {
      const funds = computePolymarketExecutableFunds({
        signer: "0x1111111111111111111111111111111111111111",
        funder: "0x2222222222222222222222222222222222222222",
        funderExecutionKind: "deposit_wallet",
        funderPusdRaw: 6_150_000n,
        signerPusdRaw: 800_000_000n,
        signerUsdceRaw: 42_710_000n,
      });

      assert.equal(funds.usesSignerTopUp, true);
      assert.equal(funds.executableFundsRaw, 848_860_000n);
      assert.equal(funds.signerLockedRaw, 0n);
      assert.equal(funds.signerPusdTopUpRaw, 800_000_000n);
      assert.equal(funds.signerUsdceTopUpRaw, 42_710_000n);
    },
  },
  {
    name: "controller pUSD requires observed Router allowance unless exact approval can be prepared",
    run: () => {
      assert.equal(
        computePolymarketFundingRouterPusdAvailableRaw({
          controllerPusdAvailableRaw: 1_000_000n,
          controllerRouterAllowanceRaw: 250_000n,
        }),
        250_000n,
      );
      assert.equal(
        computePolymarketFundingRouterPusdAvailableRaw({
          controllerPusdAvailableRaw: 1_000_000n,
          controllerRouterAllowanceRaw: 0n,
        }),
        0n,
      );
      assert.equal(
        computePolymarketFundingRouterPusdAvailableRaw({
          controllerPusdAvailableRaw: 1_000_000n,
          controllerRouterAllowanceRaw: 0n,
          controllerRouterApprovalCanBePrepared: true,
        }),
        1_000_000n,
      );
      assert.equal(
        computePolymarketFundingRouterPusdAvailableRaw({
          controllerPusdAvailableRaw: 1_000_000n,
          controllerRouterAllowanceRaw: null,
          controllerRouterApprovalCanBePrepared: true,
        }),
        0n,
      );
    },
  },
  {
    name: "safe funder excludes signer top-up funds",
    run: () => {
      const funds = computePolymarketExecutableFunds({
        signer: "0x1111111111111111111111111111111111111111",
        funder: "0x2222222222222222222222222222222222222222",
        funderExecutionKind: "safe",
        funderPusdRaw: 6_150_000n,
        signerPusdRaw: 800_000_000n,
        signerUsdceRaw: 42_710_000n,
      });

      assert.equal(funds.usesSignerTopUp, false);
      assert.equal(funds.executableFundsRaw, 6_150_000n);
      assert.equal(funds.signerLockedRaw, 0n);
      assert.equal(funds.signerPusdTopUpRaw, 0n);
      assert.equal(funds.signerUsdceTopUpRaw, 0n);
    },
  },
  {
    name: "open-order locked collateral reduces executable funder balance",
    run: () => {
      const funds = computePolymarketExecutableFunds({
        signer: "0x1111111111111111111111111111111111111111",
        funder: "0x2222222222222222222222222222222222222222",
        funderExecutionKind: "safe",
        funderPusdRaw: 100_000_000n,
        funderLockedRaw: 40_000_000n,
        signerPusdRaw: 900_000_000n,
        signerUsdceRaw: 900_000_000n,
      });

      assert.equal(funds.funderPusdAvailableRaw, 60_000_000n);
      assert.equal(funds.executableFundsRaw, 60_000_000n);
    },
  },
  {
    name: "signer pUSD top-up is reduced by signer open-order locks",
    run: () => {
      const funds = computePolymarketExecutableFunds({
        signer: "0x1111111111111111111111111111111111111111",
        funder: "0x2222222222222222222222222222222222222222",
        funderExecutionKind: "deposit_wallet",
        funderPusdRaw: 6_150_000n,
        funderLockedRaw: 1_000_000n,
        signerPusdRaw: 800_000_000n,
        signerLockedRaw: 100_000_000n,
        signerUsdceRaw: 42_710_000n,
      });

      assert.equal(funds.funderPusdAvailableRaw, 5_150_000n);
      assert.equal(funds.signerLockedRaw, 100_000_000n);
      assert.equal(funds.signerPusdTopUpRaw, 700_000_000n);
      assert.equal(funds.signerUsdceTopUpRaw, 42_710_000n);
      assert.equal(funds.executableFundsRaw, 747_860_000n);
    },
  },
  {
    name: "marketable limit Buys enforce nominal minimum independently of fees",
    run: () => {
      const context = quoteContext();
      context.orderbook.asks = [{ price: 0.15, size: 100 }];
      context.orderbook.minOrderSize = 5;
      for (const price of [0.15, 0.17]) {
        for (const orderType of ["GTC", "GTD"] as const) {
          const quote = calculatePolymarketQuote({
            context,
            tokenId: "token-yes",
            side: "BUY",
            orderType,
            amountType: "shares",
            amountSharesInput: 5,
            limitPrice: price,
          });
          assert.equal(quote.violatesMinOrderSize, false);
          assert.equal(
            quote.limitOrderValidation?.code,
            "below_marketable_buy_notional",
          );
          assert.ok(quote.limitOrderValidation);
          const minimum = BigInt(quote.limitOrderValidation.minimumSharesRaw);
          const accepted = calculatePolymarketQuote({
            context,
            tokenId: "token-yes",
            side: "BUY",
            orderType,
            amountType: "shares",
            amountSharesRawInput: minimum,
            limitPrice: price,
          });
          assert.equal(accepted.limitOrderValidation?.valid, true);
          assert.ok(BigInt(accepted.makerAmount) >= 1_000_000n);
        }
      }
      const check = (nominal: bigint, overrides = {}) =>
        validatePolymarketLimitBuy({
          context,
          side: "BUY",
          orderType: "GTC",
          postOnly: false,
          makerAmountRaw: nominal,
          takerAmountRaw: 5_000_000n,
          ...overrides,
        });
      assert.equal(check(1_000_000n)?.valid, true);
      assert.equal(check(999_999n)?.code, "below_marketable_buy_notional");
      assert.equal(check(750_000n, { postOnly: true })?.valid, true);
      assert.equal(check(750_000n, { orderType: "FOK" }), undefined);
      assert.equal(check(750_000n, { orderType: "FAK" }), undefined);
      assert.equal(check(750_000n, { side: "SELL" }), undefined);
      context.orderbook.asks = [{ price: 0.3, size: 100 }];
      assert.equal(check(750_000n)?.valid, true);
      context.orderbook.asks = [];
      assert.equal(check(750_000n)?.valid, true);
      context.orderbook.minOrderSize = 10;
      assert.equal(check(1_000_000n)?.code, "below_min_shares");
    },
  },
  {
    name: "FOK max accepts fewer than book minimum shares while limit quotes retain it",
    run: () => {
      const context = quoteContext({
        marketInfo: { ...baseMarketInfo, taker_fee_bps: "0" },
      });
      const belowMin = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 1_760_000n,
      });
      const atMin = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 2_500_000n,
      });

      assert.ok(belowMin);
      assert.equal(belowMin.maxAmountUsdRaw, "1760000");
      assert.ok(belowMin.quote.size < 5);
      assert.equal(belowMin.quote.violatesMinOrderSize, false);
      for (const orderType of ["GTC", "GTD"] as const) {
        const limit = calculatePolymarketQuote({
          context,
          tokenId: "token-yes",
          side: "BUY",
          orderType,
          amountType: "usd",
          amountUsdInput: 1.76,
          limitPrice: 0.5,
        });
        assert.equal(limit.violatesMinOrderSize, true);
      }
      assert.equal(
        findMaxPolymarketMarketBuyUsd({
          context,
          tokenId: "token-yes",
          executableFundsRaw: 1n,
        }),
        null,
      );
      assert.ok(atMin);
      assert.equal(atMin.maxAmountUsdRaw, "2500000");
      assert.equal(atMin.quote.violatesMinOrderSize, false);
    },
  },
  {
    name: "max spend can be capped by available ask depth",
    run: () => {
      const context = noFeeNoMinContext();
      context.orderbook.asks = [{ price: 0.5, size: 8 }];

      const capped = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 10_000_000n,
        requireOrderbookDepth: true,
      });
      const uncapped = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 10_000_000n,
      });

      assert.ok(capped);
      assert.ok(uncapped);
      assert.equal(capped.maxAmountUsdRaw, "4000000");
      assert.equal(capped.quote.takerAmount, "8000000");
      assert.equal(uncapped.maxAmountUsdRaw, "10000000");
    },
  },
  {
    name: "CLOB open-order locks include requested BUY wallet collateral only",
    run: () => {
      const locks = computePolymarketClobOpenOrderLocks({
        wallets: ["0xFunder000000000000000000000000000000000000"],
        orders: [
          {
            maker_address: "0xFunder000000000000000000000000000000000000",
            side: "BUY",
            price: "0.4",
            original_size: "10",
            size_matched: "2",
            type: "GTC",
          },
          {
            maker_address: "0xFunder000000000000000000000000000000000000",
            side: "SELL",
            price: "0.4",
            original_size: "10",
            size_matched: "0",
            type: "GTC",
          },
          {
            maker_address: "0xFunder000000000000000000000000000000000000",
            side: "BUY",
            price: "0.4",
            original_size: "10",
            size_matched: "0",
            type: "FOK",
          },
          {
            maker_address: "0xOther0000000000000000000000000000000000000",
            side: "BUY",
            price: "0.4",
            original_size: "10",
            size_matched: "0",
            type: "GTC",
          },
        ],
      });

      assert.equal(
        locks.get("0xfunder000000000000000000000000000000000000"),
        3_200_000n,
      );
      assert.equal(locks.size, 1);
    },
  },
  {
    name: "builder fee lowers max spend",
    run: () => {
      const executableFundsRaw = 100_000_000n;
      const withoutBuilder = findMaxPolymarketMarketBuyUsd({
        context: quoteContext({
          marketInfo: { ...baseMarketInfo, taker_fee_bps: "0" },
        }),
        tokenId: "token-yes",
        executableFundsRaw,
      });
      const withBuilder = findMaxPolymarketMarketBuyUsd({
        context: quoteContext({
          marketInfo: { ...baseMarketInfo, taker_fee_bps: "0" },
          feePolicySnapshot: builderFeePolicy(100),
        }),
        tokenId: "token-yes",
        executableFundsRaw,
      });

      assert.ok(withoutBuilder);
      assert.ok(withBuilder);
      assert.ok(
        Number(withBuilder.maxAmountUsdRaw) <
          Number(withoutBuilder.maxAmountUsdRaw),
      );
    },
  },
  {
    name: "market buy slippage is reflected in final quote price and size",
    run: () => {
      const context = quoteContext({
        marketInfo: { ...baseMarketInfo, taker_fee_bps: "0" },
      });
      const normal = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 100_000_000n,
      });
      const slipped = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 100_000_000n,
        slippageBps: 200,
      });

      assert.ok(normal);
      assert.ok(slipped);
      assert.ok(slipped.quote.price > normal.quote.price);
      assert.ok(slipped.quote.size < normal.quote.size);
    },
  },
  {
    name: "no liquidity throws explicit quote error",
    run: () => {
      assert.throws(
        () =>
          findMaxPolymarketMarketBuyUsd({
            context: quoteContext({
              orderbook: {
                bids: [],
                asks: [],
                tickSize: 0.01,
                minOrderSize: 5,
                negRisk: false,
              },
            }),
            tokenId: "token-yes",
            executableFundsRaw: 100_000_000n,
          }),
        (error) =>
          error instanceof PolymarketQuoteError &&
          error.reason === "missing_top_of_book",
      );
    },
  },
  {
    name: "buy approval helper uses high allowance threshold",
    run: () => {
      assert.equal(
        polymarketAllowanceSatisfiesBuyApproval(
          POLYMARKET_BUY_APPROVAL_THRESHOLD - 1n,
        ),
        false,
      );
      assert.equal(
        polymarketAllowanceSatisfiesBuyApproval(
          POLYMARKET_BUY_APPROVAL_THRESHOLD,
        ),
        true,
      );
    },
  },
  {
    name: "normal market approval readiness requires only normal exchange",
    run: () => {
      assert.deepEqual(
        evaluatePolymarketBuyApprovalReadiness({
          allowanceExchange: POLYMARKET_BUY_APPROVAL_THRESHOLD,
          allowanceNegRisk: 0n,
          allowanceNegRiskAdapter: 0n,
          negRisk: false,
          negRiskAdapterConfigured: true,
        }),
        { missing: [], ok: true },
      );
    },
  },
  {
    name: "neg-risk approval readiness requires exchange and adapter",
    run: () => {
      assert.deepEqual(
        evaluatePolymarketBuyApprovalReadiness({
          allowanceExchange: POLYMARKET_BUY_APPROVAL_THRESHOLD,
          allowanceNegRisk: POLYMARKET_BUY_APPROVAL_THRESHOLD,
          allowanceNegRiskAdapter: 0n,
          negRisk: true,
          negRiskAdapterConfigured: true,
        }),
        { missing: ["negRiskAdapter"], ok: false },
      );
    },
  },
  {
    name: "unknown market approval readiness fails closed for both venues",
    run: () => {
      assert.deepEqual(
        evaluatePolymarketBuyApprovalReadiness({
          allowanceExchange: 0n,
          allowanceNegRisk: 0n,
          allowanceNegRiskAdapter: null,
          negRisk: null,
          negRiskAdapterConfigured: false,
        }),
        { missing: ["exchange", "negRiskExchange"], ok: false },
      );
    },
  },
  {
    name: "funding planner creates one mixed router call for the exact shortfall",
    run: () => {
      const plan = buildPolymarketFundingPlan({
        signer: SIGNER,
        depositWallet: DEPOSIT,
        routerAddress: ROUTER,
        routerNonce: 7n,
        requiredRaw: 1_060_000n,
        depositPusdRaw: 100_000n,
        depositLockedRaw: 20_000n,
        signerPusdRaw: 400_000n,
        signerLockedRaw: 50_000n,
        signerUsdceRaw: 630_000n,
        routerPusdAllowanceRaw: 350_000n,
        routerUsdceAllowanceRaw: 630_000n,
        fundingCapRaw: 2_200_000n,
      });
      assert.ok(plan);
      assert.equal(plan.depositAvailableRaw, "80000");
      assert.equal(plan.totalAmountRaw, "980000");
      assert.equal(plan.pUsdAmountRaw, "350000");
      assert.equal(plan.usdceAmountRaw, "630000");
      assert.deepEqual(decodePolymarketFundingCalldata(plan.calldata), {
        expectedNonce: 7n,
        totalAmount: 980_000n,
        pUsdAmount: 350_000n,
      });
    },
  },
  {
    name: "funding planner returns no operation when deposit funds are sufficient",
    run: () => {
      assert.equal(
        buildPolymarketFundingPlan({
          signer: SIGNER,
          depositWallet: DEPOSIT,
          routerAddress: ROUTER,
          routerNonce: 0n,
          requiredRaw: 1_000_000n,
          depositPusdRaw: 1_200_000n,
          depositLockedRaw: 100_000n,
          signerPusdRaw: 0n,
          signerUsdceRaw: 0n,
          routerPusdAllowanceRaw: 0n,
          routerUsdceAllowanceRaw: 0n,
          fundingCapRaw: 2_200_000n,
        }),
        null,
      );
    },
  },
  {
    name: "funding planner sources Router collateral only from the controller",
    run: () => {
      const plan = buildPolymarketFundingPlan({
        signer: SIGNER,
        depositWallet: DEPOSIT,
        routerAddress: ROUTER,
        routerNonce: 3n,
        requiredRaw: 1_060_000n,
        depositPusdRaw: 60_000n,
        signerPusdRaw: 200_000n,
        signerUsdceRaw: 800_000n,
        routerPusdAllowanceRaw: 200_000n,
        routerUsdceAllowanceRaw: 800_000n,
        fundingCapRaw: 2_200_000n,
      });
      assert.ok(plan);
      assert.equal(plan.totalAmountRaw, "1000000");
      assert.equal(plan.pUsdAmountRaw, "200000");
      assert.equal(plan.signerUsdceAmountRaw, "800000");
      assert.equal(plan.usdceAmountRaw, "800000");
    },
  },
  {
    name: "funding planner fails closed on cap, balance, and allowance",
    run: () => {
      const base = {
        signer: SIGNER,
        depositWallet: DEPOSIT,
        routerAddress: ROUTER,
        routerNonce: 0n,
        requiredRaw: 1_060_000n,
        depositPusdRaw: 0n,
        signerPusdRaw: 500_000n,
        signerUsdceRaw: 560_000n,
        routerPusdAllowanceRaw: 500_000n,
        routerUsdceAllowanceRaw: 560_000n,
        fundingCapRaw: 2_200_000n,
      };
      assert.throws(
        () => buildPolymarketFundingPlan({ ...base, fundingCapRaw: 1n }),
        (error) =>
          error instanceof PolymarketFundingPlanError &&
          error.code === "cap_exceeded",
      );
      assert.throws(
        () => buildPolymarketFundingPlan({ ...base, signerUsdceRaw: 1n }),
        (error) =>
          error instanceof PolymarketFundingPlanError &&
          error.code === "insufficient_balance",
      );
      assert.throws(
        () =>
          buildPolymarketFundingPlan({
            ...base,
            routerUsdceAllowanceRaw: 1n,
          }),
        (error) =>
          error instanceof PolymarketFundingPlanError &&
          error.code === "allowance_missing",
      );
    },
  },
];

let passed = 0;
for (const test of tests) {
  await test.run();
  passed += 1;
  console.log(`[polymarket-max-spend-tests] ok ${test.name}`);
}

console.log(`[polymarket-max-spend-tests] passed ${passed}/${tests.length}`);
