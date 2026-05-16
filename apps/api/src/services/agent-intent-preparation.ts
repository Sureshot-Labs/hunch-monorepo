import type { Pool } from "@hunch/infra";
import { AuthService, type User, type UserWallet } from "../auth.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { dflowRequest } from "./dflow-client.js";
import { fetchLimitlessAmmQuote } from "./limitless-onchain.js";
import { buildLimitlessRedemptionPlan } from "./limitless-redemption-plan.js";
import { polymarketClient } from "./polymarket-client.js";
import { buildPolymarketRedemptionPlan } from "./polymarket-redemption-plan.js";
import { fetchPolymarketMarketInfo } from "../repos/polymarket-markets.js";
import type { MarketDetailsRow } from "../repos/unified-read.js";
import type { AgentWalletVenue } from "./agent-deposit-targets.js";
import type { AgentIntentRequest } from "../schemas/agent-intents.js";

type TradeIntentRequest = Extract<AgentIntentRequest, { kind: "trade" }>;
type BridgeIntentRequest = Extract<AgentIntentRequest, { kind: "bridge" }>;
type RedeemIntentRequest = Extract<AgentIntentRequest, { kind: "redeem" }>;
type TradeOutcome = "YES" | "NO";
type TradeSide = "BUY" | "SELL";
type BridgeSwapType = "same_chain" | "cross_chain";

export type AgentPreparedTradeQuote = {
  quote: Record<string, unknown> | null;
  notionalUsd: number | null;
  blockers: string[];
  warnings: string[];
};

export type AgentPreparedBridgeQuote = {
  quote: Record<string, unknown> | null;
  fundingPlan: Record<string, unknown>;
  blockers: string[];
  warnings: string[];
};

export type AgentPreparedRedeemPlan = {
  quote: Record<string, unknown> | null;
  blockers: string[];
  warnings: string[];
};

export type AgentTradeQuoteProvider = (input: {
  db: Pool;
  user: User;
  wallet: UserWallet;
  market: MarketDetailsRow;
  venue: AgentWalletVenue;
  request: TradeIntentRequest;
  outcome: TradeOutcome;
  tokenId: string;
}) => Promise<AgentPreparedTradeQuote>;

export type AgentBridgeQuoteProvider = (input: {
  db: Pool;
  user: User;
  wallet: UserWallet | null;
  venue: AgentWalletVenue | undefined;
  request: BridgeIntentRequest;
  swapType: BridgeSwapType;
}) => Promise<Record<string, unknown> | null>;

export type AgentRedemptionPlanProvider = (input: {
  db: Pool;
  user: User;
  wallet: UserWallet;
  market: MarketDetailsRow | null;
  venue: AgentWalletVenue;
  request: RedeemIntentRequest;
}) => Promise<Record<string, unknown> | null>;

export type AgentIntentPreparationDeps = {
  tradeQuoteProvider?: AgentTradeQuoteProvider;
  bridgeQuoteProvider?: AgentBridgeQuoteProvider;
  redemptionPlanProvider?: AgentRedemptionPlanProvider;
};

function asNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function removeSolPrefix(tokenId: string): string {
  return tokenId.toLowerCase().startsWith("sol:") ? tokenId.slice(4) : tokenId;
}

function toMicroAmount(value: number): string {
  return Math.max(0, Math.floor(value * 1_000_000)).toString();
}

function parseMarketMetadata(row: MarketDetailsRow): Record<string, unknown> {
  return isRecord(row.market_metadata) ? row.market_metadata : {};
}

function normalizeEvmAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed : null;
}

function parseOrderbookSide(
  value: unknown,
): Array<{ price: number; size: number }> {
  if (!Array.isArray(value)) return [];
  const rows: Array<{ price: number; size: number }> = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const price = asNumber(item.price);
    const size = asNumber(item.size);
    if (price == null || size == null) continue;
    rows.push({ price, size });
  }
  return rows;
}

function readPolymarketOrderbook(payload: unknown): {
  bestBid: number | null;
  bestAsk: number | null;
  tickSize: number | null;
  minOrderSize: number | null;
  negRisk: boolean | null;
} | null {
  if (!isRecord(payload)) return null;
  const raw = isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(raw)) return null;
  const bids = parseOrderbookSide(
    Array.isArray(raw.bids) ? raw.bids : raw.buys,
  );
  const asks = parseOrderbookSide(
    Array.isArray(raw.asks) ? raw.asks : raw.sells,
  );
  const bestBid = bids.reduce<number | null>(
    (best, bid) => (best == null || bid.price > best ? bid.price : best),
    null,
  );
  const bestAsk = asks.reduce<number | null>(
    (best, ask) => (best == null || ask.price < best ? ask.price : best),
    null,
  );
  const negRisk =
    typeof raw.neg_risk === "boolean"
      ? raw.neg_risk
      : typeof raw.negRisk === "boolean"
        ? raw.negRisk
        : null;
  return {
    bestBid,
    bestAsk,
    tickSize: asNumber(raw.tick_size ?? raw.tickSize),
    minOrderSize: asNumber(raw.min_order_size ?? raw.minOrderSize),
    negRisk,
  };
}

function priceForOutcome(
  row: MarketDetailsRow,
  side: TradeSide,
  outcome: TradeOutcome | undefined,
): number | null {
  const yes = outcome !== "NO";
  const raw =
    side === "BUY"
      ? yes
        ? (row.best_ask_yes ?? row.best_ask ?? row.last_price)
        : (row.best_ask_no ?? row.last_price)
      : yes
        ? (row.best_bid_yes ?? row.best_bid ?? row.last_price)
        : (row.best_bid_no ?? row.last_price);
  return asNumber(raw);
}

export function resolveAgentTradeOutcomeToken(
  row: MarketDetailsRow,
  outcome: TradeOutcome | undefined,
): string | null {
  return outcome === "NO" ? row.token_no : row.token_yes;
}

export function resolveAgentTradeOutcomeSide(input: {
  row: MarketDetailsRow;
  outcome: TradeOutcome | undefined;
  tokenId: string | undefined;
}): TradeOutcome | undefined {
  if (input.outcome) return input.outcome;
  if (!input.tokenId) return "YES";
  if (input.tokenId === input.row.token_yes) return "YES";
  if (input.tokenId === input.row.token_no) return "NO";
  return undefined;
}

function buildSnapshotTradeQuote(input: {
  market: MarketDetailsRow;
  request: TradeIntentRequest;
  outcome: TradeOutcome;
  tokenId: string;
}): AgentPreparedTradeQuote {
  const price =
    input.request.orderType === "limit"
      ? (input.request.limitPrice ?? null)
      : priceForOutcome(input.market, input.request.side, input.outcome);
  const blockers: string[] = [];
  if (price == null || price <= 0) blockers.push("quote_unavailable");
  const shares =
    price != null && price > 0
      ? input.request.amountType === "usd"
        ? input.request.amount / price
        : input.request.amount
      : null;
  const notionalUsd =
    input.request.amountType === "usd"
      ? input.request.amount
      : shares != null && price != null
        ? shares * price
        : null;
  return {
    quote: {
      source: "unified_market_snapshot",
      quoteStatus: blockers.length ? "unavailable" : "estimated",
      side: input.request.side,
      outcome: input.outcome,
      tokenId: input.tokenId,
      amountType: input.request.amountType,
      amount: input.request.amount,
      estimatedPrice: price,
      estimatedShares: shares,
      estimatedNotionalUsd: notionalUsd,
      orderType: input.request.orderType,
      limitPrice: input.request.limitPrice ?? null,
      slippageBps: input.request.slippageBps ?? null,
    },
    notionalUsd,
    blockers,
    warnings: blockers.length
      ? []
      : ["Quote is based on the latest indexed market snapshot."],
  };
}

export async function prepareAgentTradeQuote(input: {
  db: Pool;
  user: User;
  wallet: UserWallet | null;
  market: MarketDetailsRow;
  venue: AgentWalletVenue | undefined;
  request: TradeIntentRequest;
  outcome: TradeOutcome;
  tokenId: string;
  preparation?: AgentIntentPreparationDeps;
}): Promise<AgentPreparedTradeQuote> {
  if (input.wallet && input.venue && input.preparation?.tradeQuoteProvider) {
    try {
      return await input.preparation.tradeQuoteProvider({
        db: input.db,
        user: input.user,
        wallet: input.wallet,
        market: input.market,
        venue: input.venue,
        request: input.request,
        outcome: input.outcome,
        tokenId: input.tokenId,
      });
    } catch (error) {
      return {
        quote: {
          source: "venue_quote_prepare",
          quoteStatus: "failed",
          side: input.request.side,
          outcome: input.outcome,
          tokenId: input.tokenId,
          error: error instanceof Error ? error.message : "quote_failed",
        },
        notionalUsd:
          input.request.amountType === "usd" ? input.request.amount : null,
        blockers: ["quote_unavailable"],
        warnings: ["Unable to prepare a venue quote for this intent."],
      };
    }
  }
  return buildSnapshotTradeQuote({
    market: input.market,
    request: input.request,
    outcome: input.outcome,
    tokenId: input.tokenId,
  });
}

export function resolveAgentBridgeSwapType(input: {
  srcChainId: string;
  dstChainId: string;
  swapType?: BridgeSwapType | null;
}): BridgeSwapType | null {
  if (input.swapType) {
    if (
      input.swapType === "same_chain" &&
      input.srcChainId !== input.dstChainId
    ) {
      return null;
    }
    if (
      input.swapType === "cross_chain" &&
      input.srcChainId === input.dstChainId
    ) {
      return null;
    }
    return input.swapType;
  }
  return input.srcChainId === input.dstChainId ? "same_chain" : "cross_chain";
}

export async function prepareAgentBridgeQuote(input: {
  db: Pool;
  user: User;
  wallet: UserWallet | null;
  venue: AgentWalletVenue | undefined;
  request: BridgeIntentRequest;
  preparation?: AgentIntentPreparationDeps;
}): Promise<AgentPreparedBridgeQuote> {
  const blockers: string[] = [];
  for (const key of [
    "srcChainId",
    "dstChainId",
    "srcToken",
    "dstToken",
    "amountIn",
  ] as const) {
    if (!input.request[key]) blockers.push(`missing_${key}`);
  }
  const swapType =
    input.request.srcChainId && input.request.dstChainId
      ? resolveAgentBridgeSwapType({
          srcChainId: input.request.srcChainId,
          dstChainId: input.request.dstChainId,
        })
      : null;
  if (!swapType && input.request.srcChainId && input.request.dstChainId) {
    blockers.push("swap_type_mismatch");
  }

  let quote: Record<string, unknown> | null = null;
  const warnings: string[] = [];
  if (!blockers.length && swapType && input.preparation?.bridgeQuoteProvider) {
    try {
      quote = await input.preparation.bridgeQuoteProvider({
        db: input.db,
        user: input.user,
        wallet: input.wallet,
        venue: input.venue,
        request: input.request,
        swapType,
      });
    } catch (error) {
      blockers.push("bridge_quote_unavailable");
      warnings.push(
        error instanceof Error
          ? `Bridge quote failed: ${error.message}`
          : "Bridge quote failed.",
      );
    }
  }

  if (!quote) {
    quote = {
      source: "bridge_quote_prepare",
      quoteStatus: blockers.length ? "blocked" : "not_quoted",
      provider: "auto",
      swapType,
      srcChainId: input.request.srcChainId ?? null,
      dstChainId: input.request.dstChainId ?? null,
      srcToken: input.request.srcToken ?? null,
      dstToken: input.request.dstToken ?? null,
      amountIn: input.request.amountIn ?? null,
    };
  }

  return {
    quote,
    fundingPlan: {
      source: {
        chainId: input.request.srcChainId ?? null,
        token: input.request.srcToken ?? null,
        amountIn: input.request.amountIn ?? null,
        walletAddress: input.wallet?.walletAddress ?? null,
      },
      destination: {
        chainId: input.request.dstChainId ?? null,
        token: input.request.dstToken ?? null,
        venue: input.venue ?? null,
      },
      bridgeQuote: quote,
      blockers: uniqueStrings(blockers),
      warnings: uniqueStrings(warnings),
      note: "Bridge preview freezes route and quote inputs only; no bridge order was created.",
    },
    blockers: uniqueStrings(blockers),
    warnings: uniqueStrings(warnings),
  };
}

export async function prepareAgentRedeemPlan(input: {
  db: Pool;
  user: User;
  wallet: UserWallet | null;
  market: MarketDetailsRow | null;
  venue: AgentWalletVenue | undefined;
  request: RedeemIntentRequest;
  preparation?: AgentIntentPreparationDeps;
}): Promise<AgentPreparedRedeemPlan> {
  if (!input.wallet) {
    return {
      quote: null,
      blockers: ["missing_wallet"],
      warnings: [],
    };
  }
  if (!input.venue) {
    return {
      quote: null,
      blockers: ["venue_required"],
      warnings: [],
    };
  }
  if (input.preparation?.redemptionPlanProvider) {
    try {
      const plan = await input.preparation.redemptionPlanProvider({
        db: input.db,
        user: input.user,
        wallet: input.wallet,
        market: input.market,
        venue: input.venue,
        request: input.request,
      });
      const blockers =
        isRecord(plan) && plan.redeemable === false
          ? [String(plan.reason ?? "not_redeemable")]
          : [];
      return {
        quote: {
          action: "redeem",
          source: "venue_redemption_plan",
          redemptionPlan: plan,
        },
        blockers: uniqueStrings(blockers),
        warnings: [],
      };
    } catch (error) {
      return {
        quote: {
          action: "redeem",
          source: "venue_redemption_plan",
          redemptionPlan: null,
          error:
            error instanceof Error
              ? error.message
              : "redemption_plan_unavailable",
        },
        blockers: ["redemption_plan_unavailable"],
        warnings: ["Unable to prepare redemption plan for this intent."],
      };
    }
  }

  const blockers: string[] = [];
  if (!input.request.marketId && !input.request.tokenId) {
    blockers.push("market_or_token_required");
  }
  if (
    input.market?.redemption_status &&
    input.market.redemption_status !== "redeemable"
  ) {
    blockers.push("not_redeemable");
  }
  return {
    quote: {
      action: "redeem",
      source: "market_redemption_snapshot",
      redemptionStatus: input.market?.redemption_status ?? null,
    },
    blockers: uniqueStrings(blockers),
    warnings: ["Redemption preview used indexed market redemption state only."],
  };
}

async function quotePolymarketTrade(
  input: Parameters<AgentTradeQuoteProvider>[0],
) {
  const orderbookPayload = await polymarketClient.getOrderBook(input.tokenId);
  const marketInfo = await fetchPolymarketMarketInfo(input.db, {
    tokenId: input.tokenId,
  });
  const orderbook = readPolymarketOrderbook(orderbookPayload);
  if (!orderbook) throw new Error("invalid_orderbook");
  if (marketInfo?.accepting_orders === false) {
    throw new Error("market_not_accepting_orders");
  }
  const isLimitOrder = input.request.orderType === "limit";
  const topPrice =
    input.request.side === "BUY" ? orderbook.bestAsk : orderbook.bestBid;
  const basePrice = isLimitOrder ? input.request.limitPrice : topPrice;
  if (basePrice == null || basePrice <= 0 || basePrice >= 1) {
    throw new Error("quote_unavailable");
  }
  const slippageBps = isLimitOrder ? null : (input.request.slippageBps ?? null);
  const slippageMultiplier =
    slippageBps == null
      ? 1
      : input.request.side === "BUY"
        ? 1 + slippageBps / 10_000
        : 1 - slippageBps / 10_000;
  const price = isLimitOrder ? basePrice : basePrice * slippageMultiplier;
  const shares =
    input.request.amountType === "usd"
      ? input.request.amount / price
      : input.request.amount;
  const notionalUsd =
    input.request.amountType === "usd" ? input.request.amount : shares * price;
  return {
    quote: {
      source: "polymarket_clob_quote",
      quoteStatus: "quoted",
      side: input.request.side,
      outcome: input.outcome,
      tokenId: input.tokenId,
      amountType: input.request.amountType,
      amount: input.request.amount,
      estimatedPrice: price,
      estimatedShares: shares,
      estimatedNotionalUsd: notionalUsd,
      orderType: input.request.orderType,
      limitPrice: input.request.limitPrice ?? null,
      slippageBps,
      bestBid: orderbook.bestBid,
      bestAsk: orderbook.bestAsk,
      orderPriceMinTickSize:
        orderbook.tickSize ?? asNumber(marketInfo?.order_price_min_tick_size),
      orderMinSize:
        orderbook.minOrderSize ?? asNumber(marketInfo?.order_min_size),
      negRisk:
        orderbook.negRisk ??
        (marketInfo?.neg_risk != null ? Boolean(marketInfo.neg_risk) : null),
    },
    notionalUsd,
    blockers: [],
    warnings: [],
  };
}

async function quoteKalshiTrade(input: Parameters<AgentTradeQuoteProvider>[0]) {
  const settlementMint = input.market.settlement_mint ?? env.solanaUsdcMint;
  const tokenMint = removeSolPrefix(input.tokenId);
  const inputMint = input.request.side === "BUY" ? settlementMint : tokenMint;
  const outputMint = input.request.side === "BUY" ? tokenMint : settlementMint;
  if (
    (input.request.side === "BUY" && input.request.amountType !== "usd") ||
    (input.request.side === "SELL" && input.request.amountType !== "shares")
  ) {
    throw new Error("unsupported_dflow_quote_amount_type");
  }
  const amount = toMicroAmount(input.request.amount);
  const payload = await dflowRequest({
    baseUrl: env.dflowQuoteBase,
    timeoutMs: 10_000,
    method: "GET",
    requestPath: "/quote",
    apiKey: env.dflowApiKey,
    query: {
      inputMint,
      outputMint,
      amount,
      ...(input.request.slippageBps != null
        ? { slippageBps: input.request.slippageBps }
        : {}),
    },
  });
  if (!payload.ok) throw new Error("dflow_quote_failed");
  const quotePayload = isRecord(payload.payload) ? payload.payload : {};
  const outAmount = asNumber(
    quotePayload.outAmount ??
      quotePayload.amountOut ??
      quotePayload.outputAmount,
  );
  const inAmount = asNumber(
    quotePayload.inAmount ?? quotePayload.amountIn ?? quotePayload.inputAmount,
  );
  const estimatedShares =
    input.request.side === "BUY"
      ? outAmount != null
        ? outAmount / 1_000_000
        : null
      : input.request.amount;
  const estimatedNotionalUsd =
    input.request.side === "BUY"
      ? input.request.amount
      : outAmount != null
        ? outAmount / 1_000_000
        : null;
  const estimatedPrice =
    estimatedShares != null &&
    estimatedNotionalUsd != null &&
    estimatedShares > 0
      ? estimatedNotionalUsd / estimatedShares
      : null;
  return {
    quote: {
      source: "dflow_quote",
      quoteStatus: "quoted",
      side: input.request.side,
      outcome: input.outcome,
      tokenId: input.tokenId,
      inputMint,
      outputMint,
      amount,
      amountType: input.request.amountType,
      estimatedPrice,
      estimatedShares,
      estimatedNotionalUsd,
      raw: quotePayload,
      inputAmountRaw: inAmount != null ? String(inAmount) : amount,
      outputAmountRaw: outAmount != null ? String(outAmount) : null,
    },
    notionalUsd: estimatedNotionalUsd,
    blockers: estimatedPrice == null ? ["quote_unavailable"] : [],
    warnings: [],
  };
}

async function quoteLimitlessTrade(
  input: Parameters<AgentTradeQuoteProvider>[0],
) {
  const metadata = parseMarketMetadata(input.market);
  const marketAddress = normalizeEvmAddress(metadata.address);
  const tradeType =
    typeof metadata.tradeType === "string" ? metadata.tradeType : null;
  if (tradeType !== "amm" || !marketAddress) {
    return buildSnapshotTradeQuote({
      market: input.market,
      request: input.request,
      outcome: input.outcome,
      tokenId: input.tokenId,
    });
  }

  const outcomeIndex = input.outcome === "YES" ? 0 : 1;
  if (
    (input.request.side === "BUY" && input.request.amountType !== "usd") ||
    (input.request.side === "SELL" && input.request.amountType !== "shares")
  ) {
    throw new Error("unsupported_limitless_amm_quote_amount_type");
  }
  const quote = await fetchLimitlessAmmQuote({
    rpcUrl: env.baseRpcUrl,
    timeoutMs: env.baseRpcTimeoutMs,
    marketAddress,
    outcomeIndex,
    side: input.request.side,
    amountUsdRaw:
      input.request.side === "BUY"
        ? BigInt(toMicroAmount(input.request.amount))
        : null,
    amountSharesRaw:
      input.request.side === "SELL"
        ? BigInt(toMicroAmount(input.request.amount))
        : null,
  });
  const estimatedShares =
    quote.sharesRaw != null ? Number(quote.sharesRaw) / 1_000_000 : null;
  const estimatedNotionalUsd =
    input.request.side === "BUY"
      ? input.request.amount
      : quote.returnAmountRaw != null
        ? Number(quote.returnAmountRaw) / 1_000_000
        : null;
  const estimatedPrice =
    estimatedShares != null &&
    estimatedNotionalUsd != null &&
    estimatedShares > 0
      ? estimatedNotionalUsd / estimatedShares
      : null;
  return {
    quote: {
      source: "limitless_amm_quote",
      quoteStatus: "quoted",
      side: input.request.side,
      outcome: input.outcome,
      tokenId: input.tokenId,
      marketAddress,
      outcomeIndex,
      estimatedPrice,
      estimatedShares,
      estimatedNotionalUsd,
      sharesRaw: quote.sharesRaw?.toString() ?? null,
      returnAmountRaw: quote.returnAmountRaw?.toString() ?? null,
    },
    notionalUsd: estimatedNotionalUsd,
    blockers: estimatedPrice == null ? ["quote_unavailable"] : [],
    warnings: [],
  };
}

async function buildDefaultRedemptionPlan(
  input: Parameters<AgentRedemptionPlanProvider>[0],
) {
  if (input.venue === "kalshi") {
    return {
      ok: true,
      venue: "kalshi",
      redeemable: false,
      reason: "unsupported_redeem_venue",
      reasonMessage: "Kalshi redemption is not prepared by agent intents yet.",
    };
  }
  if (!input.market) {
    return {
      ok: true,
      venue: input.venue,
      redeemable: false,
      reason: "market_required",
      reasonMessage: "Market context is required for redemption preview.",
    };
  }
  const outcome =
    input.request.outcome ??
    resolveAgentTradeOutcomeSide({
      row: input.market,
      outcome: undefined,
      tokenId: input.request.tokenId,
    }) ??
    "YES";
  const tokenId =
    input.request.tokenId ??
    resolveAgentTradeOutcomeToken(input.market, outcome);
  if (!tokenId) {
    return {
      ok: true,
      venue: input.venue,
      redeemable: false,
      reason: "missing_token_id",
      reasonMessage: "Token id is required for redemption preview.",
    };
  }
  if (input.venue === "polymarket") {
    const creds = await AuthService.getVenueCredentialsInfo(
      input.user.id,
      "polymarket",
      input.wallet.walletAddress,
    );
    return buildPolymarketRedemptionPlan({
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
      funder: creds?.funderAddress ?? input.wallet.walletAddress,
      conditionalTokensAddress: env.polymarketConditionalTokensAddress,
      collateralTokenAddress: env.polymarketUsdcAddress,
      legacyCollateralTokenAddress: env.polymarketUsdceAddress,
      negRiskAdapterAddress: env.polymarketNegRiskAdapterAddress ?? null,
      outcome,
      positionTokenId: tokenId,
      conditionId: input.market.condition_id ?? null,
      questionId: input.market.pm_question_id ?? null,
      negRiskParentConditionId:
        input.market.pm_neg_risk_parent_condition_id ?? null,
      negRiskRequestId: input.market.pm_neg_risk_request_id ?? null,
      isNegRisk: input.market.pm_neg_risk === true,
    });
  }
  return buildLimitlessRedemptionPlan({
    rpcUrl: env.baseRpcUrl,
    timeoutMs: env.baseRpcTimeoutMs,
    owner: input.wallet.walletAddress,
    conditionId: input.market.condition_id ?? "",
    tokenId,
    outcome,
    isNegRisk: input.market.pm_neg_risk === true,
    adapterAddress: null,
  });
}

export function createDefaultAgentIntentPreparationDeps(): AgentIntentPreparationDeps {
  return {
    tradeQuoteProvider: async (input) => {
      if (input.venue === "polymarket") return quotePolymarketTrade(input);
      if (input.venue === "kalshi") return quoteKalshiTrade(input);
      if (input.venue === "limitless") return quoteLimitlessTrade(input);
      return buildSnapshotTradeQuote({
        market: input.market,
        request: input.request,
        outcome: input.outcome,
        tokenId: input.tokenId,
      });
    },
    redemptionPlanProvider: buildDefaultRedemptionPlan,
  };
}
