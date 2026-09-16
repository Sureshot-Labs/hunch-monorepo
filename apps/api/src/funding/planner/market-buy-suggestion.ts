import type { Pool } from "@hunch/infra";
import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import { findMaxPolymarketMarketBuyUsdForFunds } from "../../services/polymarket-trading-service.js";
import type { IntentLiquidityProjection } from "../domain/types.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import type { FundingPlanningSnapshot } from "./planning-types.js";
import { maximumInternalFundingCapacityRaw } from "./composite-source-options.js";
import { unavailableSessionSourceLocationIds } from "./session-source-account.js";
import { effectiveFundingEconomicsLimits } from "./source-options.js";

/** Advisory only. Reuse frozen quotes; never discover, reserve, or execute funds here. */
export async function suggestSmallerMarketBuy(
  pool: Pool,
  snapshot: FundingPlanningSnapshot,
  account: AccountValueReadModel,
  policy: FundingRuntimePolicy,
  findMax = findMaxPolymarketMarketBuyUsdForFunds,
): Promise<IntentLiquidityProjection["suggestedMarketBuy"]> {
  const { request, projection, destination } = snapshot;
  const original = request.marketBuyAmountUsdCents;
  if (
    !Number.isSafeInteger(original) ||
    !original ||
    original <= 100 ||
    !Number.isInteger(request.marketBuySlippageBps) ||
    request.marketBuySlippageBps == null ||
    request.marketBuySlippageBps < 0 ||
    request.marketBuySlippageBps > 10_000 ||
    request.purpose !== "trade_shortfall" ||
    request.consumerIntent?.venueId !== "polymarket" ||
    request.consumerIntent.side !== "BUY" ||
    projection.venueId !== "polymarket" ||
    projection.completeness !== "complete" ||
    projection.freshness !== "fresh" ||
    projection.errors.length !== 0 ||
    !projection.reasonCodes.includes("insufficient_liquidity") ||
    projection.reasonCodes.some(
      (reason) =>
        reason !== "insufficient_liquidity" &&
        reason !== "destination_setup_required",
    ) ||
    projection.sourceOptions.some((source) => source.selectable) ||
    destination?.target.kind !== "owned_location" ||
    !request.marketContextId ||
    projection.collateralAsset.decimals !== 6
  )
    return undefined;

  // A quote can expire earlier than the discovery envelope. Do not offer a hint
  // past any contributing quote, or reinterpret an expired source as capacity.
  const expiresAtMs = Math.min(
    Date.parse(projection.expiresAt),
    ...snapshot.sources.map((source) => Date.parse(source.option.expiresAt)),
  );
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now())
    return undefined;
  const capacity = maximumInternalFundingCapacityRaw({
    candidates: snapshot.sources,
    destinationAsset: projection.collateralAsset,
    destinationUnitPriceUsd: "1",
    ...effectiveFundingEconomicsLimits(policy, {
      maximumFeeUsd: request.maxFeeUsd,
      maximumSlippageBps: request.maxSlippageBps,
    }),
    excludedSourceLocationIds: [
      destination.target.location.locationId,
      ...unavailableSessionSourceLocationIds(
        account,
        request.connectedExternalWalletRefs,
      ),
    ],
  });
  if (capacity == null) return undefined;
  const budget = BigInt(projection.availableNowRaw) + capacity;
  if (budget <= 0n) return undefined;
  // Market-data requests are singleflight/shared with real quotes: do not cancel
  // those consumers, but never delay the funding response for optional advice.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Awaited<ReturnType<typeof findMax>> | undefined;
  try {
    result = await Promise.race([
      findMax(pool, {
        tokenId: request.marketContextId,
        executableFundsRaw: budget,
        slippageBps: request.marketBuySlippageBps,
      }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          console.warn("[funding] market Buy suggestion timed out", {
            liquidityProjectionId: projection.liquidityProjectionId,
          });
          resolve(undefined);
        }, 1_000);
      }),
    ]);
  } catch {
    console.warn("[funding] market Buy suggestion quote unavailable", {
      liquidityProjectionId: projection.liquidityProjectionId,
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
  if (!result?.ok || expiresAtMs <= Date.now()) return undefined;
  const cents = BigInt(result.maxAmountUsdRaw) / 10_000n;
  // Sub-dollar reductions are not a useful recovery action; keep Add funds.
  if (cents < 100n || cents >= BigInt(original)) return undefined;
  return {
    originalAmountUsdCents: original,
    amountUsdCents: Number(cents),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}
