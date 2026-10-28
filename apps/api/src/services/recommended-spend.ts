import { createHash } from "node:crypto";
import type { ApiTradeMarket } from "./api-trading-market-repo.js";
import type { PolymarketQuoteContext } from "./polymarket-quote.js";
import { calculatePolymarketQuote } from "./polymarket-quote.js";
import { normalizeLimitlessRawTokenId } from "../lib/limitless-token.js";
import { isLimitlessAmmMarketMetadata } from "./limitless-market-mode.js";
import { extractLimitlessMarketExchangeAddress } from "./limitless-market-contracts.js";
import { isRecord } from "../lib/type-guards.js";
import type { TradingBookSnapshot } from "./trading-book-cache.js";
import {
  capSpendByFunds,
  exactBuyNotionalStep,
  readSpendLevels,
  spendDepth,
  usd,
  walkSpend,
} from "./recommended-spend-math.js";
import type {
  RecommendedSpendInput,
  RecommendedSpendResponse,
} from "../schemas/recommended-spend.js";

export class RecommendedSpendError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409,
    readonly code: string,
  ) {
    super(code);
  }
}
export type ReadySpendFunds = {
  status:
    | "ready"
    | "balance_unavailable"
    | "wallet_selection_required"
    | "wallet_unavailable";
  walletId: string | null;
  availableRaw: bigint | null;
  asOf: string | null;
  openOrderCoverage?: "venue_live_and_hunch" | "hunch_recorded";
};
export type RecommendedSpendDependencies = {
  market: (id: string) => Promise<ApiTradeMarket | null>;
  orderable: (market: ApiTradeMarket) => Promise<boolean>;
  polyContext: (token: string) => Promise<PolymarketQuoteContext>;
  limitlessBook: (slug: string) => Promise<TradingBookSnapshot>;
  funds: (
    input: RecommendedSpendInput,
    user: { userId: string; signer: string | null },
    market: ApiTradeMarket,
    context: PolymarketQuoteContext | null,
  ) => Promise<ReadySpendFunds>;
  now?: () => number;
};

const emptyEconomics = {
  expectedShares: null,
  averagePrice: null,
  worstPrice: null,
  feesUsd: null,
  totalDebitUsd: null,
  feeTreatment: "unknown" as const,
};

/** Only instrument/routing identity, not changing volume, prices or UI metadata. */
function instrumentRevision(market: ApiTradeMarket): string {
  const metadata = isRecord(market.metadata) ? market.metadata : {};
  return createHash("sha256")
    .update(
      JSON.stringify([
        market.id,
        market.venue,
        market.slug,
        market.token_yes,
        market.token_no,
        market.condition_id,
        market.neg_risk,
        market.clob_token_ids,
        metadata.polymarketProtocol,
        metadata.version,
        metadata.positionIds,
        extractLimitlessMarketExchangeAddress(metadata),
        isLimitlessAmmMarketMetadata(metadata),
        metadata.negRisk,
        metadata.neg_risk,
        metadata.adapter,
        metadata.adapterAddress,
        metadata.adapter_address,
        metadata.negRiskAdapter,
        metadata.neg_risk_adapter,
      ]),
    )
    .digest("hex");
}
async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("recommendation_timeout")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function createRecommendedSpendService(
  deps: RecommendedSpendDependencies,
) {
  const now = deps.now ?? Date.now;
  return {
    async read(
      input: RecommendedSpendInput,
      user?: { userId: string; signer: string | null },
    ): Promise<RecommendedSpendResponse> {
      const market = await deps.market(input.marketId);
      if (!market) throw new RecommendedSpendError(404, "market_not_found");
      if (market.venue !== "polymarket" && market.venue !== "limitless")
        throw new RecommendedSpendError(400, "unsupported_venue");
      const venue = market.venue;
      const normalize = (value: string | null) =>
        venue === "limitless"
          ? normalizeLimitlessRawTokenId(value)
          : (value?.trim() ?? null);
      const token = normalize(input.tokenId);
      const side =
        token && token === normalize(market.token_yes)
          ? "YES"
          : token && token === normalize(market.token_no)
            ? "NO"
            : null;
      if (!side || !token)
        throw new RecommendedSpendError(409, "instrument_mismatch");
      let labels: unknown = [];
      try {
        labels = JSON.parse(market.outcomes ?? "[]");
      } catch {
        /* exact side remains available */
      }
      const label = Array.isArray(labels)
        ? labels[side === "YES" ? 0 : 1]
        : null;
      const revision = instrumentRevision(market);
      const result: RecommendedSpendResponse = {
        marketId: market.id,
        tokenId: token,
        venue,
        outcome: side,
        outcomeLabel: typeof label === "string" && label.trim() ? label : side,
        instrumentRevision: revision,
        slippageBps: input.slippageBps,
        market: {
          ...emptyEconomics,
          status: "unavailable",
          maxOrderAmountUsd: null,
          bestAsk: null,
          priceLimit: null,
          observedAt: null,
          sourceAsOf: null,
          expiresAt: null,
          depthCoverage: "observed",
          priceProtection:
            venue === "polymarket"
              ? "requires_bounded_order"
              : "not_enforced_by_current_fok",
        },
        account: null,
        warnings: ["not_reserved", "not_investment_advice"],
      };
      if (venue === "limitless")
        result.warnings.push(
          "limitless_fok_price_not_enforced",
          "shares_before_fees",
        );
      if (!(await deps.orderable(market))) {
        result.market.status = "market_unavailable";
        return result;
      }
      if (
        venue === "limitless" &&
        isLimitlessAmmMarketMetadata(market.metadata)
      ) {
        result.market.status = "unsupported_market_type";
        return result;
      }
      let snapshot: TradingBookSnapshot;
      let context: PolymarketQuoteContext | null = null;
      let tick: string;
      const fundsPromise = user
        ? bounded(deps.funds(input, user, market, null), 3_500).catch(
            (): ReadySpendFunds => ({
              status: "balance_unavailable",
              walletId: null,
              availableRaw: null,
              asOf: null,
            }),
          )
        : null;
      try {
        if (venue === "polymarket") {
          context = await bounded(deps.polyContext(token), 3_000);
          if (
            !context.bookSnapshot ||
            (context.assetContext && context.assetContext.assetId !== token)
          )
            throw new Error("invalid_context");
          snapshot = context.bookSnapshot;
          const step =
            context.orderbook.tickSize ??
            Number(context.marketInfo?.order_price_min_tick_size);
          if (!Number.isFinite(step) || step <= 0)
            throw new Error("unknown_tick");
          tick = String(step);
        } else {
          if (!market.slug) throw new Error("missing_slug");
          snapshot = await bounded(deps.limitlessBook(market.slug), 3_000);
          let raw = snapshot.payload as Record<string, unknown>;
          if (raw?.data && typeof raw.data === "object")
            raw = raw.data as Record<string, unknown>;
          if (raw?.orderbook && typeof raw.orderbook === "object")
            raw = raw.orderbook as Record<string, unknown>;
          const rawToken = raw?.tokenId ?? raw?.token_id;
          const bookToken =
            typeof rawToken === "string" || typeof rawToken === "number"
              ? normalizeLimitlessRawTokenId(rawToken)
              : null;
          if (!bookToken || bookToken !== normalize(market.token_yes))
            throw new Error("instrument_mismatch");
          tick = "0.001";
        }
        result.market.observedAt = snapshot.observedAt;
        result.market.sourceAsOf = snapshot.sourceAsOf;
        result.market.expiresAt = snapshot.expiresAt;
        if (!snapshot.sourceAsOf)
          result.warnings.push("source_timestamp_unavailable");
        if (Date.parse(snapshot.expiresAt) <= now()) {
          result.market.status = "stale_book";
          return result;
        }
        const depth = spendDepth(
          readSpendLevels(
            snapshot.payload,
            venue,
            venue === "limitless" && side === "NO",
          ),
          tick,
          input.slippageBps,
        );
        const amountStep =
          venue === "polymarket" && input.slippageBps === 0 && depth.priceLimit
            ? exactBuyNotionalStep(depth.priceLimit)
            : 10_000n;
        const maxRaw = (depth.capacityRaw / amountStep) * amountStep;
        // Resting book minOrderSize does not apply to an immediate FOK buy.
        const minRaw = venue === "polymarket" ? 1_000_000n : 10_000n;
        const required = (amountRaw: bigint): bigint | null => {
          if (venue === "limitless") return amountRaw; // exact-input fees reduce received shares, not collateral debit
          if (amountRaw > BigInt(Number.MAX_SAFE_INTEGER)) return null; // legacy fee helper uses number internally
          if (!context) return null;
          try {
            const quote = calculatePolymarketQuote({
              tokenId: token,
              side: "BUY",
              orderType: "FOK",
              amountType: "usd",
              amountUsdRawInput: amountRaw,
              slippageBps: input.slippageBps,
              strictSlippage: true,
              context,
            });
            return quote.totalRequiredUsdcRaw == null
              ? null
              : BigInt(quote.totalRequiredUsdcRaw);
          } catch {
            return null;
          }
        };
        const economics = (amountRaw: bigint) => {
          const debit = amountRaw === 0n ? 0n : required(amountRaw);
          return {
            ...walkSpend(depth, amountRaw),
            feesUsd:
              venue === "polymarket" && debit != null
                ? usd(debit - amountRaw)
                : null,
            totalDebitUsd: debit == null ? null : usd(debit),
            feeTreatment:
              venue === "polymarket"
                ? ("additional_collateral" as const)
                : ("deducted_from_shares" as const),
          };
        };
        result.market = {
          ...result.market,
          ...economics(maxRaw < minRaw ? 0n : maxRaw),
          bestAsk: depth.bestAsk,
          priceLimit: depth.priceLimit,
          maxOrderAmountUsd: usd(maxRaw < minRaw ? 0n : maxRaw),
          status:
            maxRaw === 0n
              ? "no_liquidity"
              : maxRaw < minRaw
                ? "below_min_order"
                : "ready",
        };
        if (result.market.feesUsd == null) result.warnings.push("fees_unknown");
        if (user && fundsPromise) {
          const funds = await fundsPromise;
          result.account = {
            ...emptyEconomics,
            status: funds.status,
            walletId: funds.walletId,
            openOrderCoverage: funds.openOrderCoverage ?? "unknown",
            balanceAsOf: funds.asOf,
            availableCollateralUsd:
              funds.availableRaw == null ? null : usd(funds.availableRaw),
            recommendedOrderAmountUsd: null,
            limitingFactor: null,
          };
          if (funds.openOrderCoverage === "hunch_recorded")
            result.warnings.push("external_orders_not_included");
          if (funds.status === "ready" && funds.availableRaw != null) {
            const capped = capSpendByFunds(
              maxRaw,
              funds.availableRaw,
              required,
              minRaw,
              amountStep,
            );
            if (capped == null) result.account.status = "fees_unavailable";
            else {
              const amount = capped < minRaw ? 0n : capped;
              Object.assign(result.account, economics(amount), {
                status: amount > 0n ? "ready" : "below_min_order",
                recommendedOrderAmountUsd: usd(amount),
                limitingFactor:
                  amount === 0n
                    ? "minimum_order"
                    : amount < maxRaw
                      ? "balance"
                      : "liquidity",
              });
            }
          }
        }
        const current = await deps.market(input.marketId);
        if (
          !current ||
          current.token_yes !== market.token_yes ||
          current.token_no !== market.token_no ||
          current.condition_id !== market.condition_id ||
          instrumentRevision(current) !== revision ||
          !(await deps.orderable(current))
        ) {
          result.market.status = "market_unavailable";
          result.market.maxOrderAmountUsd = null;
          if (result.account) {
            result.account.status = "market_unavailable";
            result.account.recommendedOrderAmountUsd = null;
          }
        }
        // A slow balance probe must not make an expired book appear fresh.
        if (Date.parse(snapshot.expiresAt) <= now()) {
          result.market.status = "stale_book";
          result.market.maxOrderAmountUsd = null;
          if (result.account) {
            result.account.status = "market_unavailable";
            result.account.recommendedOrderAmountUsd = null;
          }
        }
        return result;
      } catch {
        result.market.status = "unavailable";
        result.market.maxOrderAmountUsd = null;
        if (result.account) {
          result.account.status = "market_unavailable";
          result.account.recommendedOrderAmountUsd = null;
        }
        return result;
      }
    },
  };
}
