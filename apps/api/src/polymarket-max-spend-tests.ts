#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import {
  calculatePolymarketQuote,
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
import type { AccountValueReadModel } from "./account-value/runtime-service.js";
import {
  computePolymarketAccountMaxSpend,
  externalWalletSourceLocationIds,
} from "./services/polymarket-account-max-spend.js";
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
      let quotedFundsRaw: bigint | null = null;
      const result = await computePolymarketAccountMaxSpend({
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
          buildAccountValueReadModel: async () => account,
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
            return findMaxPolymarketMarketBuyUsdDetailed({
              context: quoteContext(),
              tokenId: input.tokenId,
              executableFundsRaw: input.executableFundsRaw,
              slippageBps: input.slippageBps,
              requireOrderbookDepth: true,
            });
          },
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.fundingScope, "account");
      assert.equal(result.executableFundsRaw, "4860000");
      assert.equal(quotedFundsRaw, 4_860_000n);
      assert.equal(previewRequests.length, 2);
      assert.equal(
        previewRequests[1]?.serverAdditionalDestinationAmount?.raw,
        (BigInt(String(result.totalRequiredUsdcRaw)) - 430_000n).toString(),
      );
      assert.ok(BigInt(String(result.maxAmountUsdRaw)) >= 2_500_000n);
    },
  },
  {
    name: "account MAX excludes connected external wallet source locations",
    run: () => {
      const account = {
        ownership: {
          wallets: [
            { walletId: "wallet_external", source: "external" },
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
          ],
        },
      } as unknown as AccountValueReadModel;
      assert.deepEqual(externalWalletSourceLocationIds(account), [
        "location_external",
        "location_external_venue",
      ]);
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
    name: "max spend rejects below-min-order funds and accepts min-size funds",
    run: () => {
      const context = quoteContext({
        marketInfo: { ...baseMarketInfo, taker_fee_bps: "0" },
      });
      const belowMin = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 2_490_000n,
      });
      const atMin = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 2_500_000n,
      });

      assert.equal(belowMin, null);
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
