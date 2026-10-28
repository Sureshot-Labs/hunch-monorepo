import { z } from "zod";

const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
export const recommendedSpendParams = z.object({
  marketId: z.string().trim().min(1).max(200),
});
export const recommendedSpendQuery = z
  .object({
    tokenId: z.string().trim().min(1).max(250),
    slippageBps: z.coerce.number().int().min(0).max(10_000).default(30),
  })
  .strict();
export const recommendedSpendBody = recommendedSpendQuery
  .extend({
    marketId: z.string().trim().min(1).max(200),
    walletId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type RecommendedSpendInput = z.infer<typeof recommendedSpendBody>;

const economics = z.object({
  expectedShares: decimal.nullable(),
  averagePrice: decimal.nullable(),
  worstPrice: decimal.nullable(),
  feesUsd: decimal.nullable(),
  totalDebitUsd: decimal.nullable(),
  feeTreatment: z.enum([
    "additional_collateral",
    "deducted_from_shares",
    "unknown",
  ]),
});
export const recommendedSpendResponse = z.object({
  marketId: z.string(),
  tokenId: z.string(),
  venue: z.enum(["polymarket", "limitless"]),
  outcome: z.enum(["YES", "NO"]),
  outcomeLabel: z.string(),
  instrumentRevision: z.string(),
  slippageBps: z.number().int(),
  market: economics.extend({
    status: z.enum([
      "ready",
      "no_liquidity",
      "below_min_order",
      "market_unavailable",
      "unsupported_market_type",
      "stale_book",
      "unavailable",
    ]),
    maxOrderAmountUsd: decimal.nullable(),
    bestAsk: decimal.nullable(),
    priceLimit: decimal.nullable(),
    observedAt: z.string().nullable(),
    sourceAsOf: z.string().nullable(),
    expiresAt: z.string().nullable(),
    depthCoverage: z.literal("observed"),
    priceProtection: z.enum([
      "requires_bounded_order",
      "not_enforced_by_current_fok",
    ]),
  }),
  account: economics
    .extend({
      status: z.enum([
        "ready",
        "balance_unavailable",
        "wallet_selection_required",
        "wallet_unavailable",
        "fees_unavailable",
        "below_min_order",
        "market_unavailable",
      ]),
      walletId: z.string().nullable(),
      openOrderCoverage: z.enum([
        "venue_live_and_hunch",
        "hunch_recorded",
        "unknown",
      ]),
      availableCollateralUsd: decimal.nullable(),
      balanceAsOf: z.string().nullable(),
      recommendedOrderAmountUsd: decimal.nullable(),
      limitingFactor: z
        .enum(["balance", "liquidity", "minimum_order"])
        .nullable(),
    })
    .nullable(),
  warnings: z.array(
    z.enum([
      "not_reserved",
      "not_investment_advice",
      "fees_unknown",
      "limitless_fok_price_not_enforced",
      "source_timestamp_unavailable",
      "shares_before_fees",
      "external_orders_not_included",
    ]),
  ),
});
export type RecommendedSpendResponse = z.infer<typeof recommendedSpendResponse>;
export const recommendedSpendError = z.object({
  error: z.string(),
  code: z.string().optional(),
});
