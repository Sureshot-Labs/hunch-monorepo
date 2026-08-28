import type { Pool } from "@hunch/infra";

import {
  buildAccountValueReadModel,
  type AccountValueReadModel,
} from "../account-value/runtime-service.js";
import { rawForUsdCeil } from "../account-value/decimal.js";
import type {
  FundingDiscoveryRequest,
  IntentLiquidityProjection,
  Money,
} from "../funding/domain/types.js";
import { maximumInternalFundingDestinationRaw } from "../funding/planner/composite-source-options.js";
import { FundingPlanningRuntime } from "../funding/planner/runtime-service.js";
import { effectiveFundingEconomicsLimits } from "../funding/planner/source-options.js";
import { buildFundingTradeConsumerIntent } from "../funding/persistence/funding-trade-consumer-intent.js";
import { fetchPolymarketMarketInfo } from "../repos/polymarket-markets.js";
import { env } from "../env.js";
import { toChecksumAddress } from "./api-trading-common.js";
import { findMaxPolymarketMarketBuyUsdForFunds } from "./polymarket-trading-service.js";

const POLYMARKET_PUSD_DECIMALS = 6;

export type PolymarketAccountMaxSpendFunds = Readonly<{
  funderPusdRaw: bigint;
  funderPusdAvailableRaw: bigint;
  funderLockedRaw: bigint;
  signerLockedRaw: bigint;
  signerPusdTopUpRaw: bigint;
  signerUsdceTopUpRaw: bigint;
  usesSignerTopUp: boolean;
}>;

type PolymarketAccountMaxSpendLogger = Readonly<{
  warn?: (input: unknown, message?: string) => void;
}>;

type AccountMaxSpendUnavailableReason =
  | "balance_unavailable"
  | "no_executable_funds"
  | "no_liquidity"
  | "below_min_order";

function unavailable(
  reason: AccountMaxSpendUnavailableReason,
  message: string,
): Record<string, unknown> {
  return { ok: false, reason, message };
}

function accountControllerWalletRef(
  account: AccountValueReadModel,
  signer: string,
): string | null {
  const normalizedSigner = toChecksumAddress(signer);
  if (!normalizedSigner) return null;
  return (
    account.ownership?.wallets.find(
      (profile) =>
        profile.networkId === "evm:137" &&
        toChecksumAddress(profile.address) === normalizedSigner &&
        Boolean(profile.controllerWalletRef?.trim()),
    )?.controllerWalletRef ?? null
  );
}

function polymarketPusdMoney(raw: bigint): Money {
  return {
    asset: {
      networkId: "evm:137",
      assetId: env.polymarketPusdAddress,
      decimals: POLYMARKET_PUSD_DECIMALS,
    },
    raw: raw.toString(),
  };
}

function buildAccountFundingRequest(input: {
  capacityQuote: boolean;
  controllerWalletRef: string;
  directAvailableRaw: bigint;
  marketId: string;
  requestedRaw: bigint;
  slippageBps: number | null;
  tokenId: string;
}): FundingDiscoveryRequest {
  const additionalRaw =
    input.requestedRaw > input.directAvailableRaw
      ? input.requestedRaw - input.directAvailableRaw
      : 0n;
  const requestedDestinationAmount = polymarketPusdMoney(input.requestedRaw);
  return {
    purpose: "trade_shortfall",
    requestedDestinationAmount,
    confirmedSourceAmount: null,
    marketContextId: input.tokenId,
    consumerIntent: buildFundingTradeConsumerIntent({
      venueId: "polymarket",
      marketId: input.marketId,
      marketContextId: input.tokenId,
      spend: requestedDestinationAmount,
    }),
    destinationOptionId: null,
    withdrawalRecipientId: null,
    venueBindingOptionId: null,
    controllerWalletRef: input.controllerWalletRef,
    serverAdditionalDestinationAmount: polymarketPusdMoney(additionalRaw),
    ...(input.capacityQuote
      ? { serverQuoteAvailableSourceCapacity: true }
      : {}),
    maxFeeUsd: null,
    maxSlippageBps: input.slippageBps,
    deadline: null,
  };
}

function accountCapacityProbeRaw(
  account: AccountValueReadModel,
  directAvailableRaw: bigint,
): bigint {
  let valuedCashRaw = 0n;
  try {
    valuedCashRaw = BigInt(
      rawForUsdCeil({
        usd: account.cashAvailability.cashAvailableEstimatedUsd,
        decimals: POLYMARKET_PUSD_DECIMALS,
        unitPriceUsd: "1",
      }),
    );
  } catch {
    valuedCashRaw = 0n;
  }
  const observedUpperRaw =
    (valuedCashRaw > directAvailableRaw ? valuedCashRaw : directAvailableRaw) *
      2n +
    1_000_000n;
  return observedUpperRaw;
}

function directFunderAvailableRaw(input: {
  funder: string;
  funds: PolymarketAccountMaxSpendFunds;
  preview: Awaited<ReturnType<FundingPlanningRuntime["previewLiquidity"]>>;
}): Readonly<{ availableRaw: bigint; locationId: string }> | null {
  const destination = input.preview.plannerSnapshot.destination;
  if (
    !destination ||
    destination.target.kind !== "owned_location" ||
    toChecksumAddress(destination.venueBinding.accountRef) !==
      toChecksumAddress(input.funder)
  ) {
    return null;
  }
  const spendability = destination.spendability;
  try {
    const observedRaw = BigInt(spendability.observedAmount.raw);
    const funderObservedRaw =
      observedRaw < input.funds.funderPusdRaw
        ? observedRaw
        : input.funds.funderPusdRaw;
    const frozenLockedRaw = BigInt(spendability.lockedRaw);
    const openOrderLockedRaw =
      frozenLockedRaw > input.funds.funderLockedRaw
        ? frozenLockedRaw
        : input.funds.funderLockedRaw;
    const unavailableRaw =
      openOrderLockedRaw +
      BigInt(spendability.reservedRaw) +
      BigInt(spendability.submittedDebitRaw);
    return {
      availableRaw:
        funderObservedRaw > unavailableRaw
          ? funderObservedRaw - unavailableRaw
          : 0n,
      locationId: destination.target.location.locationId,
    };
  } catch {
    return null;
  }
}

function completeFreshProjection(
  projection: IntentLiquidityProjection,
): boolean {
  return (
    projection.completeness === "complete" &&
    projection.freshness === "fresh" &&
    projection.errors.length === 0 &&
    projection.destinationOptionId != null &&
    projection.venueId === "polymarket"
  );
}

function maximumPreviewInternalFundingRaw(input: {
  excludedSourceLocationId: string;
  maximumFeeBps: number;
  maximumFeeUsd: string;
  maximumSlippageBps: number;
  preview: Awaited<ReturnType<FundingPlanningRuntime["previewLiquidity"]>>;
}): bigint | null {
  const capacityFor = (
    boundary: "automatic" | "client_handoff",
  ): bigint | null =>
    maximumInternalFundingDestinationRaw({
      candidates: input.preview.plannerSnapshot.sources,
      destinationAsset: polymarketPusdMoney(0n).asset,
      destinationUnitPriceUsd: "1",
      maximumFeeUsd: input.maximumFeeUsd,
      maximumFeeBps: input.maximumFeeBps,
      maximumSlippageBps: input.maximumSlippageBps,
      executionBoundary: boundary,
      // The Deposit Wallet balance is already counted as direct executable
      // collateral. Excluding its frozen source location prevents a
      // Deposit Wallet -> controller -> Deposit Wallet loop from counting
      // the same pUSD a second time.
      excludedSourceLocationIds: [input.excludedSourceLocationId],
    });
  const automaticRaw = capacityFor("automatic");
  const clientRaw = capacityFor("client_handoff");
  if (automaticRaw == null || clientRaw == null) return null;
  return automaticRaw > clientRaw ? automaticRaw : clientRaw;
}

/**
 * Computes a fee-aware Polymarket nominal from owned account liquidity only.
 * The first preview measures every eligible source at exact input; the second
 * preview proves the chosen amount with the ordinary production route shape.
 * The caller may expose `fundingScope: account` only when this function does.
 */
export async function computePolymarketAccountMaxSpend(input: {
  funder: string;
  funds: PolymarketAccountMaxSpendFunds;
  log?: PolymarketAccountMaxSpendLogger | null;
  pool: Pool;
  signer: string;
  slippageBps: number | null;
  tokenId: string;
  userId: string;
}): Promise<Record<string, unknown>> {
  try {
    const [account, marketInfo] = await Promise.all([
      buildAccountValueReadModel({ pool: input.pool, userId: input.userId }),
      fetchPolymarketMarketInfo(input.pool, { tokenId: input.tokenId }),
    ]);
    const controllerWalletRef = accountControllerWalletRef(
      account,
      input.signer,
    );
    const marketId = marketInfo?.unified_market_id ?? null;
    const runtimePolicy = account.runtimePolicy;
    if (!controllerWalletRef || !marketId || !runtimePolicy) {
      return unavailable(
        "balance_unavailable",
        "Account-wide Polymarket funding is unavailable.",
      );
    }

    const runtime = new FundingPlanningRuntime(input.pool);
    const provisionalDirectRaw = input.funds.funderPusdAvailableRaw;
    const probeRaw = accountCapacityProbeRaw(account, provisionalDirectRaw);
    const capacityPreview = await runtime.previewLiquidity(
      input.userId,
      buildAccountFundingRequest({
        capacityQuote: true,
        controllerWalletRef,
        directAvailableRaw: provisionalDirectRaw,
        marketId,
        requestedRaw: probeRaw,
        slippageBps: input.slippageBps,
        tokenId: input.tokenId,
      }),
      account,
    );
    if (!completeFreshProjection(capacityPreview.projection)) {
      return unavailable(
        "balance_unavailable",
        "Account-wide funding balances could not be verified.",
      );
    }

    const directFunder = directFunderAvailableRaw({
      funder: input.funder,
      funds: input.funds,
      preview: capacityPreview,
    });
    if (directFunder == null) {
      return unavailable(
        "balance_unavailable",
        "Account-wide Polymarket destination balance could not be verified.",
      );
    }
    const directAvailableRaw = directFunder.availableRaw;
    const economics = effectiveFundingEconomicsLimits(runtimePolicy, {
      maximumFeeUsd: null,
      maximumSlippageBps: input.slippageBps,
    });
    const additionalCapacityRaw = maximumPreviewInternalFundingRaw({
      excludedSourceLocationId: directFunder.locationId,
      maximumFeeUsd: economics.maximumFeeUsd,
      maximumFeeBps: economics.maximumFeeBps,
      maximumSlippageBps: economics.maximumSlippageBps,
      preview: capacityPreview,
    });
    if (additionalCapacityRaw == null) {
      return unavailable(
        "balance_unavailable",
        "Account-wide funding capacity is too complex to verify safely.",
      );
    }
    const executableFundsRaw = directAvailableRaw + additionalCapacityRaw;
    if (executableFundsRaw <= 0n) {
      return unavailable(
        "no_executable_funds",
        "No account-wide Polymarket funding route is available.",
      );
    }

    const maxSpend = await findMaxPolymarketMarketBuyUsdForFunds(input.pool, {
      tokenId: input.tokenId,
      executableFundsRaw,
      slippageBps: input.slippageBps ?? undefined,
      logWarn: ({ error, tokenId: warningTokenId, conditionId }) =>
        input.log?.warn?.(
          { error, tokenId: warningTokenId, conditionId },
          "Failed to fetch Polymarket CLOB fee curve for account-wide max",
        ),
    });
    if (!maxSpend.ok) {
      return unavailable(
        maxSpend.reason,
        maxSpend.reason === "no_liquidity"
          ? "No executable Polymarket liquidity is available for account-wide max spend."
          : "Account-wide funds are below the minimum Polymarket order amount.",
      );
    }

    const totalRequiredRaw = BigInt(maxSpend.quote.totalRequiredUsdcRaw ?? "0");
    const additionalRequiredRaw =
      totalRequiredRaw > directAvailableRaw
        ? totalRequiredRaw - directAvailableRaw
        : 0n;
    if (additionalRequiredRaw > 0n) {
      const exactPreview = await runtime.previewLiquidity(
        input.userId,
        buildAccountFundingRequest({
          capacityQuote: false,
          controllerWalletRef,
          directAvailableRaw,
          marketId,
          requestedRaw: totalRequiredRaw,
          slippageBps: input.slippageBps,
          tokenId: input.tokenId,
        }),
        account,
      );
      if (
        !completeFreshProjection(exactPreview.projection) ||
        (maximumPreviewInternalFundingRaw({
          excludedSourceLocationId: directFunder.locationId,
          maximumFeeUsd: economics.maximumFeeUsd,
          maximumFeeBps: economics.maximumFeeBps,
          maximumSlippageBps: economics.maximumSlippageBps,
          preview: exactPreview,
        }) ?? -1n) < additionalRequiredRaw
      ) {
        return unavailable(
          "balance_unavailable",
          "The exact account-wide funding route could not be verified.",
        );
      }
    }

    const quote = maxSpend.quote;
    return {
      ok: true,
      reason: "ok",
      fundingScope: "account",
      tokenId: input.tokenId,
      side: "BUY",
      orderType: "FOK",
      amountType: "usd",
      maxAmountUsd: Number(maxSpend.maxAmountUsdRaw) / 1_000_000,
      maxAmountUsdRaw: maxSpend.maxAmountUsdRaw,
      totalRequiredUsdcRaw: quote.totalRequiredUsdcRaw ?? "0",
      totalFeeEstimateRaw: quote.totalFeeEstimateRaw,
      platformFeeEstimateRaw: quote.platformFeeEstimateRaw,
      builderFeeEstimateRaw: quote.builderFeeEstimateRaw,
      makerAmount: quote.makerAmount,
      takerAmount: quote.takerAmount,
      price: quote.price,
      size: quote.size,
      amountUsdUsed: quote.amountUsdUsed,
      bestBid: quote.bestBid,
      bestAsk: quote.bestAsk,
      slippageBps: quote.slippageBps,
      executableFundsRaw: executableFundsRaw.toString(),
      funderPusdRaw: input.funds.funderPusdRaw.toString(),
      funderPusdAvailableRaw: directAvailableRaw.toString(),
      funderLockedRaw: input.funds.funderLockedRaw.toString(),
      signerLockedRaw: input.funds.signerLockedRaw.toString(),
      signerPusdTopUpRaw: input.funds.signerPusdTopUpRaw.toString(),
      signerUsdceTopUpRaw: input.funds.signerUsdceTopUpRaw.toString(),
      usesSignerTopUp: input.funds.usesSignerTopUp,
    };
  } catch (error) {
    input.log?.warn?.(
      {
        error,
        userId: input.userId,
        signer: input.signer,
        tokenId: input.tokenId,
      },
      "Failed to compute account-wide Polymarket max spend",
    );
    return unavailable(
      "balance_unavailable",
      "Account-wide Polymarket funding could not be verified.",
    );
  }
}
