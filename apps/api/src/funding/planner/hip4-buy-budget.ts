import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { hip4Identity } from "@hunch/shared";
import { quoteHip4MarketOrderWithCurrentContext } from "../../services/hip4-order-runtime.js";
import { HIP4_MAINNET_ORDER_UNITS } from "../../services/hip4-order-amounts.js";

const CENT = 10n ** BigInt(HIP4_MAINNET_ORDER_UNITS.quoteRawDecimals - 2);
type MarketQuote = Awaited<
  ReturnType<typeof quoteHip4MarketOrderWithCurrentContext>
>;
type BudgetQuote = (
  pool: Pool,
  input: Parameters<typeof quoteHip4MarketOrderWithCurrentContext>[1],
) => Promise<{
  amounts: Pick<
    MarketQuote["amounts"],
    "quantity" | "debitCapRaw" | "grossQuoteRaw"
  >;
  executionEstimate: Pick<
    MarketQuote["executionEstimate"],
    "estimatedFillQuantity"
  >;
  expiresAfter: number;
}>;

/** Adapter for the existing funding advice loop, not a second Max/funding
 * engine. Only the current ordinary quote validates policy, owner, fees, lots
 * and book. Native quote atoms must never enter the legacy USDC6 calculation.
 * Returns undefined for proven below-lot/minimum or empty depth; null for an
 * unavailable check. Neither result authorizes a trade or a funding operation. */
export async function checkHip4BuyBudget(
  pool: Pool,
  input: {
    userId: string;
    controllerWalletRef: string;
    marketId: string;
    tokenId: string;
    budgetRaw: bigint;
    slippageBps: number;
    deadlineMs: number;
  },
  quote: BudgetQuote = quoteHip4MarketOrderWithCurrentContext,
) {
  try {
    const match = /^hyperliquid:mainnet:outcome:(0|[1-9]\d*)$/u.exec(
      input.marketId,
    );
    if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
    const identity = hip4Identity("mainnet", Number(match[1]));
    const tokenId = input.tokenId.startsWith("hyperliquid:")
      ? input.tokenId
      : `hyperliquid:${input.tokenId}`;
    const outcome = identity.sides.find((side) => side.tokenId === tokenId);
    if (!outcome) return null;
    let amountRaw = (input.budgetRaw / CENT) * CENT;
    if (amountRaw <= 0n) return undefined;
    // One ordinary quote, plus at most one recheck when displayed depth can
    // support only a smaller order. No search, new routes or balance summing.
    for (let pass = 0; pass < 2; pass++) {
      if (!Number.isFinite(input.deadlineMs) || Date.now() >= input.deadlineMs)
        return null;
      const result = await quote(pool, {
        userId: input.userId,
        actor: "web_app",
        request: {
          requestKey: randomUUID(),
          controllerWalletRef: input.controllerWalletRef,
          marketId: input.marketId,
          outcomeSide: outcome.sideIndex === 0 ? "YES" : "NO",
          side: "BUY",
          consentedDebitCapRaw: amountRaw.toString(),
          slippageBps: input.slippageBps,
        },
      });
      const quantity = BigInt(result.amounts.quantity);
      const filled = BigInt(result.executionEstimate.estimatedFillQuantity);
      const requiredRaw = BigInt(result.amounts.debitCapRaw);
      const grossRaw = BigInt(result.amounts.grossQuoteRaw);
      if (
        quantity <= 0n ||
        filled < 0n ||
        filled > quantity ||
        grossRaw <= 0n ||
        grossRaw % quantity !== 0n ||
        requiredRaw < grossRaw ||
        requiredRaw <= 0n ||
        requiredRaw > amountRaw ||
        Date.now() >= input.deadlineMs ||
        !Number.isFinite(result.expiresAfter) ||
        result.expiresAfter <= Date.now()
      )
        return null;
      if (filled === 0n) return undefined;
      if (filled === quantity)
        return { amountRaw, requiredRaw, expiresAtMs: result.expiresAfter };
      // Preserve displayed whole lots when representable in editable cents:
      // four $0.303 lots need $1.22; 400 $0.00303 lots need $1.21 because
      // $1.22 would size 402 lots. Stay strictly below the next gross lot's
      // threshold. Unknown/new fees still require the ordinary recheck.
      // This candidate remains BELOW the original budget and must pass a new
      // ordinary fee/minimum/depth check. It is not a scaled fee authority.
      const roundedRequirement =
        ((requiredRaw * filled + quantity * CENT - 1n) / (quantity * CENT)) *
        CENT;
      const depthCap =
        (((grossRaw / quantity) * (filled + 1n) - 1n) / CENT) * CENT;
      const smaller =
        roundedRequirement < depthCap ? roundedRequirement : depthCap;
      if (smaller <= 0n) return undefined;
      if (smaller >= amountRaw) return null;
      amountRaw = smaller;
    }
    return null;
  } catch (error) {
    return error instanceof Error &&
      [
        "hip4_preparation_quantity_below_lot",
        "hip4_preparation_buy_below_minimum",
        "hip4_market_no_liquidity",
      ].includes(error.message)
      ? undefined
      : null;
  }
}
