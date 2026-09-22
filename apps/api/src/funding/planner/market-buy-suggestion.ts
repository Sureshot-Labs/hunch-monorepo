import type { Pool } from "@hunch/infra";
import { multiplyRawByUnitPrice } from "../../account-value/decimal.js";
import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import { findMaxPolymarketMarketBuyUsdForFunds } from "../../services/polymarket-trading-service.js";
import type { IntentLiquidityProjection } from "../domain/types.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import type { FundingPlanningSnapshot } from "./planning-types.js";
import { maximumInternalFundingCapacityRaw } from "./composite-source-options.js";
import { unavailableSessionSourceLocationIds } from "./session-source-account.js";
import { effectiveFundingEconomicsLimits } from "./source-options.js";
import { checkLimitlessBuyBudget } from "./limitless-buy-budget.js";

/** Advisory only. Reuse frozen quotes; never discover, reserve, or execute funds here.
 * Undefined means no applicable smaller Buy; null means the check was unavailable.
 */
export async function suggestSmallerMarketBuy(
  pool: Pool,
  snapshot: FundingPlanningSnapshot,
  account: AccountValueReadModel,
  policy: FundingRuntimePolicy,
  findMax = findMaxPolymarketMarketBuyUsdForFunds,
  checkExactInput = checkLimitlessBuyBudget,
): Promise<IntentLiquidityProjection["suggestedMarketBuy"] | null> {
  const { request, projection, destination } = snapshot;
  const original = request.marketBuyAmountUsdCents;
  if (
    !Number.isSafeInteger(original) ||
    !original ||
    original <= (request.consumerIntent?.venueId === "polymarket" ? 100 : 1) ||
    !Number.isInteger(request.marketBuySlippageBps) ||
    request.marketBuySlippageBps == null ||
    request.marketBuySlippageBps < 0 ||
    request.marketBuySlippageBps > 10_000 ||
    request.purpose !== "trade_shortfall" ||
    !request.consumerIntent ||
    !["polymarket", "limitless"].includes(request.consumerIntent.venueId) ||
    request.consumerIntent.side !== "BUY" ||
    projection.venueId !== request.consumerIntent.venueId ||
    projection.completeness !== "complete" ||
    projection.freshness !== "fresh" ||
    projection.errors.length !== 0 ||
    !projection.reasonCodes.includes("insufficient_liquidity") ||
    projection.reasonCodes.some(
      (reason) =>
        reason !== "insufficient_liquidity" &&
        // A refused optional source contributes no capacity. Verified routes
        // may still support a smaller Buy; this advice never authorizes funding.
        reason !== "provider_quote_rejected" &&
        reason !== "destination_setup_required",
    ) ||
    projection.sourceOptions.some((source) => source.selectable) ||
    destination?.target.kind !== "owned_location" ||
    !request.marketContextId ||
    projection.collateralAsset.decimals !== 6
  )
    return undefined;

  const consumerIntent = request.consumerIntent;
  const exactInput = consumerIntent.venueId === "limitless";
  // Do not infer exact-input economics from a venue name alone: the bound
  // consumer debit must equal the original Limitless market BUY input.
  if (
    exactInput &&
    request.consumerIntent.spend.raw !== (BigInt(original) * 10_000n).toString()
  )
    return undefined;

  // A quote can expire earlier than the discovery envelope. Do not offer a hint
  // past any contributing quote, or reinterpret an expired source as capacity.
  const expiresAtMs = Math.min(
    Date.parse(projection.expiresAt),
    ...snapshot.sources.map((source) => Date.parse(source.option.expiresAt)),
  );
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
  const destinationLocationId = destination.target.location.locationId;
  const capacityFor = (feeReferenceRaw: string) =>
    maximumInternalFundingCapacityRaw({
      candidates: snapshot.sources,
      destinationAsset: projection.collateralAsset,
      destinationUnitPriceUsd: "1",
      feeReferenceUsd: multiplyRawByUnitPrice({
        raw: feeReferenceRaw,
        decimals: projection.collateralAsset.decimals,
        unitPriceUsd: "1",
      }),
      ...effectiveFundingEconomicsLimits(policy, {
        maximumFeeUsd: request.maxFeeUsd,
        maximumSlippageBps: request.maxSlippageBps,
      }),
      excludedSourceLocationIds: [
        destinationLocationId,
        ...unavailableSessionSourceLocationIds(
          account,
          request.connectedExternalWalletRefs,
        ),
      ],
    });
  const available = BigInt(projection.availableNowRaw);
  const tokenId = request.marketContextId;
  const timeoutMs = exactInput ? 3_500 : 1_000;
  const deadlineMs = Math.min(expiresAtMs, Date.now() + timeoutMs);
  // Market-data requests are singleflight/shared with real quotes: do not cancel
  // those consumers, but never delay the funding response for optional advice.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let capacity = capacityFor(projection.requestedCollateralRaw);
        // Reducing the Buy also reduces its percentage fee budget. Revalidate
        // against the smaller quote's total required collateral,
        // never keep the original larger order's allowance.
        for (let pass = 0; pass < 3; pass++) {
          if (Date.now() >= deadlineMs) return null;
          if (capacity == null) return null;
          const budget = available + capacity;
          if (budget <= 0n) return undefined;
          if (exactInput) {
            // Never advise increasing the amount, even when route fee limits
            // make the original request unavailable for a non-capacity reason.
            const maximumSmallerRaw = BigInt(original - 1) * 10_000n;
            const checked = await checkExactInput(pool, {
              marketId: consumerIntent.marketId,
              tokenId,
              budgetRaw:
                budget < maximumSmallerRaw ? budget : maximumSmallerRaw,
            });
            if (checked == null) return checked;
            const verifiedCapacity = capacityFor(checked.amountRaw.toString());
            const hintExpiry = Math.min(expiresAtMs, checked.expiresAtMs);
            if (
              verifiedCapacity == null ||
              Date.now() >= deadlineMs ||
              Date.now() >= hintExpiry
            )
              return null;
            if (available + verifiedCapacity >= checked.amountRaw) {
              return {
                originalAmountUsdCents: original,
                amountUsdCents: Number(checked.amountRaw / 10_000n),
                expiresAt: new Date(hintExpiry).toISOString(),
              };
            }
            if (verifiedCapacity >= capacity) return null;
            capacity = verifiedCapacity;
            continue;
          }
          const result = await findMax(pool, {
            tokenId,
            executableFundsRaw: budget,
            slippageBps: request.marketBuySlippageBps,
          });
          if (Date.now() >= deadlineMs) return null;
          if (!result.ok)
            return result.reason === "below_min_order" ? undefined : null;
          const cents = BigInt(result.maxAmountUsdRaw) / 10_000n;
          if (cents < 100n || cents >= BigInt(original)) return undefined;
          const required = result.quote.totalRequiredUsdcRaw;
          if (required == null) return null;
          const verifiedCapacity = capacityFor(required);
          if (verifiedCapacity == null || Date.now() >= deadlineMs) return null;
          if (available + verifiedCapacity >= BigInt(required)) {
            return {
              originalAmountUsdCents: original,
              amountUsdCents: Number(cents),
              expiresAt: new Date(expiresAtMs).toISOString(),
            };
          }
          if (verifiedCapacity >= capacity) return null;
          capacity = verifiedCapacity;
        }
        return null;
      })(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.warn("[funding] market Buy suggestion timed out", {
            liquidityProjectionId: projection.liquidityProjectionId,
          });
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } catch {
    console.warn("[funding] market Buy suggestion quote unavailable", {
      liquidityProjectionId: projection.liquidityProjectionId,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
