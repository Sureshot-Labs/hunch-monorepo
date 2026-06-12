import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";
import { z as zod } from "zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { storeExecution } from "../repos/executions-repo.js";
import {
  computeAcceptingOrders,
  readDflowNativeAcceptingOrders,
} from "../lib/market-availability.js";
import {
  assertHyperliquidTradingAllowed,
  isHyperliquidTradingAllowed,
} from "../lib/hyperliquid-access.js";
import { getRedis } from "../redis.js";
import {
  syncWalletPositionsFromTokenBalances,
  type WalletTokenBalance,
} from "../repos/positions-repo.js";
import {
  buildHyperliquidCancelAction,
  buildHyperliquidOrderAction,
  buildHyperliquidTypedData,
  buildHyperliquidUsdClassTransferAction,
  buildHyperliquidWithdrawAction,
  canonicalHyperliquidVenueOrderId,
  computeHyperliquidMinExecutableOrder,
  extractHyperliquidCancelStatus,
  extractHyperliquidOrderStatus,
  fetchHyperliquidSpotState,
  formatHyperliquidDecimal,
  hyperliquidOutcomeOrderPrecision,
  hyperliquidVenueOrderIdAliases,
  hunchTokenIdFromHyperliquidCoin,
  hyperliquidAssetIdFromHunchTokenId,
  hyperliquidCoinFromHunchTokenId,
  hyperliquidInfo,
  isHyperliquidSizeAligned,
  makeHyperliquidClientOrderId,
  normalizeHyperliquidUserFills,
  normalizeHyperliquidClientOrderId,
  normalizeHyperliquidExchangeOrderId,
  roundHyperliquidSizeToLot,
  recoverHyperliquidSigner,
  recoverHyperliquidUserSignedSigner,
  submitHyperliquidExchangeAction,
  type HyperliquidAction,
  type HyperliquidOrderSide,
  type HyperliquidOrderPrecision,
  type HyperliquidOrderTif,
} from "../services/hyperliquid-trading.js";
import {
  createEmbeddedPrivyWalletRpcRequest,
  executePreparedPrivySignatureRequest,
  resolveEmbeddedPrivyWalletContext,
} from "../services/embedded-privy.js";

type HyperliquidMarketForTrade = {
  id: string;
  status: string | null;
  close_time: Date | string | null;
  expiration_time: Date | string | null;
  token_yes: string | null;
  token_no: string | null;
  best_bid: string | null;
  best_ask: string | null;
  best_bid_yes: string | null;
  best_ask_yes: string | null;
  best_bid_no: string | null;
  best_ask_no: string | null;
  last_price: string | null;
  metadata: unknown | null;
  asset_raw: unknown | null;
};

type PreparedHyperliquidAction = {
  action: HyperliquidAction;
  nonce: number;
  typedData: ReturnType<typeof buildHyperliquidTypedData>;
  tokenId: string;
  side: HyperliquidOrderSide | null;
  orderType: "GTC" | "FAK" | null;
  cloid: string | null;
  price: number | null;
  size: number | null;
  notionalUsd: number | null;
  marketId: string | null;
};

type HyperliquidInfoOrderRow = {
  venueOrderId: string | null;
  cloid: string | null;
  oid: string | null;
  tokenId: string | null;
  side: HyperliquidOrderSide | null;
  price: number | null;
  size: number | null;
  status: string;
  postedAt: Date | null;
  raw: unknown;
};

type HyperliquidOrderQuote = {
  tokenId: string;
  side: HyperliquidOrderSide;
  orderType: "GTC" | "FAK";
  price: number;
  size: number;
  notionalUsd: number;
  tif: HyperliquidOrderTif;
  marketId: string;
  minOrderNotionalUsd: number;
  minExecutableSize: number;
  minExecutableAmountUsd: number;
  sizeDecimals: number;
  priceMaxDecimals: number;
  executable: boolean;
  reason: "lot_size_rounding" | null;
};

type HyperliquidTokenContext = {
  marketId: string;
  outcome: string | null;
};

type HyperliquidLiveTop = {
  bestBid: number | null;
  bestAsk: number | null;
  tsMs: number | null;
};

const orderBaseSchema = zod.object({
  tokenId: zod.string().min(1),
  side: zod.enum(["BUY", "SELL"]),
  orderType: zod.enum(["market", "limit"]).default("market"),
  price: zod.number().positive().optional(),
  size: zod.number().positive().optional(),
  amountUsd: zod.number().positive().optional(),
  slippageBps: zod.number().int().min(0).max(5_000).optional(),
  reduceOnly: zod.boolean().optional(),
});

const orderSubmitSchema = orderBaseSchema.extend({
  nonce: zod.number().int().positive(),
  cloid: zod.string().min(1),
  signature: zod.string().min(1),
  preparedPrice: zod.number().positive(),
  preparedSize: zod.number().positive(),
});

const cancelBaseShape = {
  tokenId: zod.string().min(1),
  oid: zod.number().int().positive().optional(),
  cloid: zod.string().min(1).optional(),
} satisfies zod.ZodRawShape;

const cancelBaseSchema = zod
  .object(cancelBaseShape)
  .refine((value) => value.oid != null || value.cloid != null, {
    message: "Hyperliquid cancel requires an order id or client order id.",
  });

const cancelSubmitSchema = zod
  .object({
    ...cancelBaseShape,
    nonce: zod.number().int().positive(),
    signature: zod.string().min(1),
  })
  .refine((value) => value.oid != null || value.cloid != null, {
    message: "Hyperliquid cancel requires an order id or client order id.",
  });

const withdrawBaseSchema = zod.object({
  amount: zod.union([zod.string().min(1), zod.number().positive()]),
  destination: zod.string().min(1).optional(),
});

const withdrawSubmitSchema = withdrawBaseSchema.extend({
  nonce: zod.number().int().positive(),
  signature: zod.string().min(1),
});

const usdClassTransferBaseSchema = zod.object({
  amount: zod.union([zod.string().min(1), zod.number().positive()]),
  toPerp: zod.boolean().default(false),
});

const usdClassTransferSubmitSchema = usdClassTransferBaseSchema.extend({
  nonce: zod.number().int().positive(),
  signature: zod.string().min(1),
});

const embeddedSignTypedDataPrepareBodySchema = zod.object({
  id: zod.string().min(1),
  label: zod.string().min(1),
  typedData: zod.object({
    domain: zod.record(zod.string(), zod.unknown()),
    types: zod.record(
      zod.string(),
      zod.array(zod.object({ name: zod.string(), type: zod.string() })),
    ),
    primaryType: zod.string(),
    message: zod.record(zod.string(), zod.unknown()),
  }),
});

const embeddedSignTypedDataBodySchema =
  embeddedSignTypedDataPrepareBodySchema.extend({
    authorizationSignature: zod.string().min(1),
  });

type HyperliquidOrderBody = zod.infer<typeof orderBaseSchema>;

const localNonceByWallet = new Map<string, number>();

class HyperliquidOrderQuoteError extends Error {
  readonly code = "hyperliquid_min_lot_notional";
  readonly responsePayload: { quote: HyperliquidOrderQuote };

  constructor(message: string, quote: HyperliquidOrderQuote) {
    super(message);
    this.name = "HyperliquidOrderQuoteError";
    this.responsePayload = { quote };
  }
}

function normalizeEvmAddress(value: string): string | null {
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    return null;
  }
}

function ensureTradingEnabled(input: {
  userId: string;
  walletAddress: string;
}) {
  assertHyperliquidTradingAllowed(input);
}

async function reserveHyperliquidNonce(
  userId: string,
  walletAddress: string,
): Promise<number> {
  const normalizedWallet = walletAddress.toLowerCase();
  const base = Math.max(
    Date.now(),
    localNonceByWallet.get(normalizedWallet) ?? 0,
  );
  const redis = await getRedis().catch(() => null);

  for (let i = 0; i < 25; i += 1) {
    const candidate = base + i + 1;
    const key = `hyperliquid:nonce:${userId}:${normalizedWallet}:${candidate}`;
    if (redis) {
      const result = await redis.set(key, "1", { NX: true, EX: 120 });
      if (result !== "OK") continue;
    }
    localNonceByWallet.set(normalizedWallet, candidate);
    return candidate;
  }

  throw new Error("Failed to reserve a Hyperliquid nonce.");
}

async function resolveMarketForToken(
  tokenId: string,
): Promise<HyperliquidMarketForTrade | null> {
  const { rows } = await pool.query<HyperliquidMarketForTrade>(
    `
      select
        m.id,
        m.status::text,
        m.close_time,
        m.expiration_time,
        m.token_yes,
        m.token_no,
        m.best_bid::text,
        m.best_ask::text,
        yes_top.best_bid::text as best_bid_yes,
        yes_top.best_ask::text as best_ask_yes,
        no_top.best_bid::text as best_bid_no,
        no_top.best_ask::text as best_ask_no,
        m.last_price::text,
        m.metadata,
        asset.raw as asset_raw
      from unified_markets m
      left join hyperliquid_outcome_assets asset
        on asset.hunch_token_id = $1
      left join lateral (
        select best_bid, best_ask
        from unified_book_top
        where token_id = m.token_yes
          and venue = 'hyperliquid'
        order by ts desc
        limit 1
      ) yes_top on true
      left join lateral (
        select best_bid, best_ask
        from unified_book_top
        where token_id = m.token_no
          and venue = 'hyperliquid'
        order by ts desc
        limit 1
      ) no_top on true
      where m.venue = 'hyperliquid'
        and ($1 = m.token_yes or $1 = m.token_no)
      limit 1
    `,
    [tokenId],
  );
  return rows[0] ?? null;
}

function tokenSideForMarket(
  market: HyperliquidMarketForTrade,
  tokenId: string,
): "YES" | "NO" | null {
  if (market.token_yes === tokenId) return "YES";
  if (market.token_no === tokenId) return "NO";
  return null;
}

function parseHyperliquidBookLevelPrice(level: unknown): number | null {
  if (!level || typeof level !== "object") return null;
  const value = readString(level as Record<string, unknown>, ["px", "price"]);
  const parsed = parseNumber(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function parseHyperliquidLiveTop(payload: unknown): HyperliquidLiveTop | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const levels = Array.isArray(record.levels) ? record.levels : null;
  if (!levels || levels.length < 2) return null;
  const bids = Array.isArray(levels[0]) ? levels[0] : [];
  const asks = Array.isArray(levels[1]) ? levels[1] : [];
  const bestBid = parseHyperliquidBookLevelPrice(bids[0]);
  const bestAsk = parseHyperliquidBookLevelPrice(asks[0]);
  if (bestBid == null && bestAsk == null) return null;
  const timeRaw = readString(record, ["time", "ts", "timestamp"]);
  const tsMs = timeRaw != null ? Number(timeRaw) : null;
  return {
    bestBid,
    bestAsk,
    tsMs: tsMs != null && Number.isFinite(tsMs) ? tsMs : null,
  };
}

async function fetchLiveHyperliquidTop(
  tokenId: string,
): Promise<HyperliquidLiveTop | null> {
  const coin = hyperliquidCoinFromHunchTokenId(tokenId);
  const payload = await hyperliquidInfo({ type: "l2Book", coin });
  return parseHyperliquidLiveTop(payload);
}

function applyLiveTopToMarket(
  market: HyperliquidMarketForTrade,
  tokenSide: "YES" | "NO",
  liveTop: HyperliquidLiveTop,
): HyperliquidMarketForTrade {
  return {
    ...market,
    ...(tokenSide === "YES"
      ? {
          best_bid_yes:
            liveTop.bestBid != null ? String(liveTop.bestBid) : null,
          best_ask_yes:
            liveTop.bestAsk != null ? String(liveTop.bestAsk) : null,
        }
      : {
          best_bid_no:
            liveTop.bestBid != null ? String(liveTop.bestBid) : null,
          best_ask_no:
            liveTop.bestAsk != null ? String(liveTop.bestAsk) : null,
        }),
  };
}

function resolveTopPrice(
  market: HyperliquidMarketForTrade,
  tokenSide: "YES" | "NO",
  side: HyperliquidOrderSide,
): number | null {
  const raw =
    tokenSide === "YES"
      ? side === "BUY"
        ? (market.best_ask_yes ?? market.best_ask)
        : (market.best_bid_yes ?? market.best_bid)
      : side === "BUY"
        ? market.best_ask_no
        : market.best_bid_no;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function refreshMarketOrderLiveTop(input: {
  market: HyperliquidMarketForTrade;
  tokenId: string;
  tokenSide: "YES" | "NO";
  side: HyperliquidOrderSide;
}): Promise<HyperliquidMarketForTrade> {
  let liveTop: HyperliquidLiveTop | null = null;
  try {
    liveTop = await fetchLiveHyperliquidTop(input.tokenId);
  } catch {
    throw new Error("Unable to refresh Hyperliquid live book for this order.");
  }

  if (!liveTop) {
    throw new Error("Hyperliquid has no live book for this outcome.");
  }

  const refreshed = applyLiveTopToMarket(
    input.market,
    input.tokenSide,
    liveTop,
  );
  const crossingPrice = resolveTopPrice(
    refreshed,
    input.tokenSide,
    input.side,
  );
  if (crossingPrice == null) {
    throw new Error(
      input.side === "BUY"
        ? "Hyperliquid has no live ask liquidity for this outcome."
        : "Hyperliquid has no live bid liquidity for this outcome.",
    );
  }

  return refreshed;
}

function readHyperliquidSizeDecimals(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const raw =
    record.szDecimals ??
    record.sizeDecimals ??
    record.size_decimals ??
    record.lotSizeDecimals;
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw.trim())
        : null;
  if (
    parsed == null ||
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > 8
  ) {
    return null;
  }
  return parsed;
}

function resolveHyperliquidOrderPrecision(
  market: HyperliquidMarketForTrade,
  tokenId: string,
): HyperliquidOrderPrecision {
  const fromAssetRaw = readHyperliquidSizeDecimals(market.asset_raw);
  if (fromAssetRaw != null) {
    return hyperliquidOutcomeOrderPrecision(fromAssetRaw);
  }

  const metadata = market.metadata;
  if (metadata && typeof metadata === "object") {
    const record = metadata as Record<string, unknown>;
    const sideAssets = record.hyperliquid
      ? (record.hyperliquid as Record<string, unknown>).sideAssets
      : record.sideAssets;
    if (Array.isArray(sideAssets)) {
      const sideAsset = sideAssets.find((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const candidate = entry as Record<string, unknown>;
        return (
          candidate.hunchTokenId === tokenId || candidate.tokenId === tokenId
        );
      });
      const fromSideAsset = readHyperliquidSizeDecimals(sideAsset);
      if (fromSideAsset != null) {
        return hyperliquidOutcomeOrderPrecision(fromSideAsset);
      }
    }
  }

  // HIP-4 outcome assets currently trade in whole shares. If Hyperliquid
  // exposes per-token precision later, the metadata paths above take priority.
  return hyperliquidOutcomeOrderPrecision(0);
}

function readPositiveRecordNumber(
  value: unknown,
  keys: string[],
): number | null {
  if (!value || typeof value !== "object") return null;
  const parsed = parseNumber(readString(value as Record<string, unknown>, keys));
  return parsed != null && parsed > 0 ? parsed : null;
}

function resolveHyperliquidMinNotionalReferencePrice(
  market: HyperliquidMarketForTrade,
  tokenId: string,
): number | null {
  const fromAssetRaw = readPositiveRecordNumber(market.asset_raw, [
    "markPx",
    "mark_px",
    "midPx",
    "mid_px",
  ]);
  if (fromAssetRaw != null) return fromAssetRaw;

  const metadata = market.metadata;
  if (metadata && typeof metadata === "object") {
    const record = metadata as Record<string, unknown>;
    const hyperliquid = record.hyperliquid;
    const assetContexts =
      hyperliquid && typeof hyperliquid === "object"
        ? (hyperliquid as Record<string, unknown>).assetContexts
        : record.assetContexts;
    const coin = hyperliquidCoinFromHunchTokenId(tokenId);
    if (Array.isArray(assetContexts)) {
      for (const context of assetContexts) {
        if (!context || typeof context !== "object") continue;
        const contextRecord = context as Record<string, unknown>;
        const contextCoin = readString(contextRecord, ["coin"]);
        if (contextCoin !== coin) continue;
        const referencePrice = readPositiveRecordNumber(contextRecord, [
          "markPx",
          "mark_px",
          "midPx",
          "mid_px",
        ]);
        if (referencePrice != null) return referencePrice;
      }
    }
  }

  const fromMarket = parseNumber(market.last_price);
  return fromMarket != null && fromMarket > 0 ? fromMarket : null;
}

function applySlippage(
  price: number,
  side: HyperliquidOrderSide,
  slippageBps: number,
): number {
  const factor =
    side === "BUY" ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000;
  return Math.min(0.99999, Math.max(0.00001, price * factor));
}

function resolveOrderQuote(inputs: {
  market: HyperliquidMarketForTrade;
  tokenSide: "YES" | "NO";
  body: HyperliquidOrderBody;
  precision: HyperliquidOrderPrecision;
  fixedPrice?: number | null;
  fixedSize?: number | null;
}): HyperliquidOrderQuote {
  const tif = inputs.body.orderType === "limit" ? "Gtc" : "Ioc";
  const rawPrice =
    inputs.fixedPrice ??
    (inputs.body.orderType === "limit"
      ? inputs.body.price
      : (() => {
          const top = resolveTopPrice(
            inputs.market,
            inputs.tokenSide,
            inputs.body.side,
          );
          if (top == null) return null;
          return applySlippage(
            top,
            inputs.body.side,
            inputs.body.slippageBps ?? env.hyperliquidMarketSlippageBps,
          );
        })());
  if (
    rawPrice == null ||
    !Number.isFinite(rawPrice) ||
    rawPrice <= 0 ||
    rawPrice >= 1
  ) {
    throw new Error("Hyperliquid market has no usable price for this order.");
  }
  const price = Number(
    formatHyperliquidDecimal(rawPrice, {
      maxDecimals: inputs.precision.priceMaxDecimals,
      maxSigFigs: 5,
      label: "price",
    }),
  );
  if (inputs.fixedPrice != null && inputs.body.orderType !== "limit") {
    const liveCrossingPrice = resolveTopPrice(
      inputs.market,
      inputs.tokenSide,
      inputs.body.side,
    );
    const stillCrosses =
      liveCrossingPrice != null &&
      (inputs.body.side === "BUY"
        ? price >= liveCrossingPrice
        : price <= liveCrossingPrice);
    if (!stillCrosses) {
      throw new Error(
        "Hyperliquid live book moved beyond the signed market price. Refresh the quote and retry.",
      );
    }
  }

  const explicitSize = inputs.fixedSize ?? inputs.body.size ?? null;
  const rawSize =
    explicitSize ??
    (inputs.body.amountUsd != null ? inputs.body.amountUsd / price : null);
  const autoSized =
    rawSize != null && inputs.fixedSize == null && inputs.body.size == null;
  const size =
    autoSized
      ? roundHyperliquidSizeToLot(
          rawSize,
          inputs.precision.sizeDecimals,
          "floor",
        )
      : rawSize;
  if (size == null || !Number.isFinite(size) || size <= 0) {
    if (!autoSized) {
      throw new Error("Hyperliquid order size is required.");
    }
  }
  if (
    size != null &&
    Number.isFinite(size) &&
    size > 0 &&
    !isHyperliquidSizeAligned(size, inputs.precision.sizeDecimals)
  ) {
    const step = formatHyperliquidDecimal(
      1 / 10 ** inputs.precision.sizeDecimals,
      {
        maxDecimals: inputs.precision.sizeDecimals,
        label: "size step",
      },
    );
    throw new Error(`Hyperliquid order size must be in ${step} share steps.`);
  }

  const normalizedSize =
    size != null && Number.isFinite(size) && size > 0 ? size : 0;
  const notionalUsd = price * normalizedSize;
  const minExecutable = computeHyperliquidMinExecutableOrder({
    orderPrice: price,
    minOrderNotionalUsd: env.hyperliquidMinOrderNotionalUsd,
    sizeDecimals: inputs.precision.sizeDecimals,
    referencePrice: resolveHyperliquidMinNotionalReferencePrice(
      inputs.market,
      inputs.body.tokenId,
    ),
  });
  const minCheckNotionalUsd =
    inputs.body.side === "SELL"
      ? notionalUsd
      : minExecutable.minNotionalReferencePrice * normalizedSize;
  const executable =
    minCheckNotionalUsd >= env.hyperliquidMinOrderNotionalUsd;

  return {
    tokenId: inputs.body.tokenId,
    side: inputs.body.side,
    orderType: tif === "Gtc" ? "GTC" : "FAK",
    price,
    size: normalizedSize,
    notionalUsd,
    tif,
    marketId: inputs.market.id,
    minOrderNotionalUsd: env.hyperliquidMinOrderNotionalUsd,
    minExecutableSize: minExecutable.minExecutableSize,
    minExecutableAmountUsd: minExecutable.minExecutableAmountUsd,
    sizeDecimals: inputs.precision.sizeDecimals,
    priceMaxDecimals: inputs.precision.priceMaxDecimals,
    executable,
    reason: executable ? null : "lot_size_rounding",
  };
}

function requireExecutableOrderQuote(
  quote: HyperliquidOrderQuote,
): HyperliquidOrderQuote {
  if (quote.size <= 0 || !quote.executable) {
    if (quote.side === "SELL") {
      throw new HyperliquidOrderQuoteError(
        `Hyperliquid sell orders must be at least $${quote.minOrderNotionalUsd.toFixed(2)} at the current sell price. Current sell value is $${quote.notionalUsd.toFixed(2)}; place a higher limit sell, wait for the bid to improve, or add to the position before selling.`,
        quote,
      );
    }
    throw new HyperliquidOrderQuoteError(
      `Hyperliquid orders must be at least $${quote.minOrderNotionalUsd.toFixed(2)} after lot-size rounding. Increase amount to at least $${quote.minExecutableAmountUsd.toFixed(2)} for this market.`,
      quote,
    );
  }

  return quote;
}

async function resolveOrderContext(inputs: {
  userId: string;
  walletAddress: string;
  body: HyperliquidOrderBody;
}): Promise<{
  signer: string;
  market: HyperliquidMarketForTrade;
  tokenSide: "YES" | "NO";
  assetId: number;
  precision: HyperliquidOrderPrecision;
}> {
  const signer = normalizeEvmAddress(inputs.walletAddress);
  if (!signer) throw new Error("Hyperliquid trading requires an EVM wallet.");
  ensureTradingEnabled({ userId: inputs.userId, walletAddress: signer });

  const market = await resolveMarketForToken(inputs.body.tokenId);
  if (!market) throw new Error("Hyperliquid token is not known to Hunch.");
  const tokenSide = tokenSideForMarket(market, inputs.body.tokenId);
  if (!tokenSide) throw new Error("Hyperliquid token is not tradeable.");
  const acceptingOrders = computeAcceptingOrders({
    venue: "hyperliquid",
    status: market.status,
    closeTime: market.close_time,
    expirationTime: market.expiration_time,
    dflowNativeAcceptingOrders: readDflowNativeAcceptingOrders(market.metadata),
    hyperliquidTradingEnabled: isHyperliquidTradingAllowed({
      userId: inputs.userId,
      walletAddress: signer,
    }),
  });
  if (!acceptingOrders) {
    throw new Error("Hyperliquid market is not accepting orders.");
  }

  const marketForQuote =
    inputs.body.orderType === "limit"
      ? market
      : await refreshMarketOrderLiveTop({
          market,
          tokenId: inputs.body.tokenId,
          tokenSide,
          side: inputs.body.side,
        });

  const assetId = hyperliquidAssetIdFromHunchTokenId(inputs.body.tokenId);
  const precision = resolveHyperliquidOrderPrecision(
    marketForQuote,
    inputs.body.tokenId,
  );
  return { signer, market: marketForQuote, tokenSide, assetId, precision };
}

async function quoteOrderAction(inputs: {
  userId: string;
  walletAddress: string;
  body: HyperliquidOrderBody;
  fixedPrice?: number | null;
  fixedSize?: number | null;
}): Promise<HyperliquidOrderQuote> {
  const context = await resolveOrderContext(inputs);
  return resolveOrderQuote({
    market: context.market,
    tokenSide: context.tokenSide,
    body: inputs.body,
    precision: context.precision,
    fixedPrice: inputs.fixedPrice,
    fixedSize: inputs.fixedSize,
  });
}

async function prepareOrderAction(inputs: {
  userId: string;
  walletAddress: string;
  body: HyperliquidOrderBody;
  nonce?: number;
  cloid?: string | null;
  fixedPrice?: number | null;
  fixedSize?: number | null;
}): Promise<PreparedHyperliquidAction> {
  const context = await resolveOrderContext(inputs);
  const math = requireExecutableOrderQuote(
    resolveOrderQuote({
      market: context.market,
      tokenSide: context.tokenSide,
      body: inputs.body,
      precision: context.precision,
      fixedPrice: inputs.fixedPrice,
      fixedSize: inputs.fixedSize,
    }),
  );
  const nonce =
    inputs.nonce ??
    (await reserveHyperliquidNonce(inputs.userId, context.signer));
  const inputCloid = inputs.cloid
    ? normalizeHyperliquidClientOrderId(inputs.cloid)
    : null;
  if (inputs.cloid && !inputCloid) {
    throw new Error("Invalid Hyperliquid client order id.");
  }
  const cloid =
    inputCloid ??
    makeHyperliquidClientOrderId({
      userId: inputs.userId,
      walletAddress: context.signer,
      tokenId: inputs.body.tokenId,
      nonce,
    });
  const action = buildHyperliquidOrderAction({
    assetId: context.assetId,
    side: inputs.body.side,
    price: math.price,
    size: math.size,
    tif: math.tif,
    reduceOnly: inputs.body.reduceOnly,
    cloid,
    precision: context.precision,
  });
  const typedData = buildHyperliquidTypedData({
    action,
    nonce,
    isMainnet: env.hyperliquidChain !== "Testnet",
  });
  return {
    action,
    nonce,
    typedData,
    tokenId: inputs.body.tokenId,
    side: inputs.body.side,
    orderType: math.tif === "Gtc" ? "GTC" : "FAK",
    cloid,
    price: Number(
      formatHyperliquidDecimal(math.price, {
        maxDecimals: context.precision.priceMaxDecimals,
        maxSigFigs: 5,
      }),
    ),
    size: Number(
      formatHyperliquidDecimal(math.size, {
        maxDecimals: context.precision.sizeDecimals,
      }),
    ),
    notionalUsd: math.notionalUsd,
    marketId: context.market.id,
  };
}

function prepareCancelAction(inputs: {
  tokenId: string;
  oid?: number | null;
  cloid?: string | null;
  nonce: number;
}): PreparedHyperliquidAction {
  const assetId = hyperliquidAssetIdFromHunchTokenId(inputs.tokenId);
  const cloid = inputs.cloid
    ? normalizeHyperliquidClientOrderId(inputs.cloid)
    : null;
  if (inputs.cloid && !cloid) {
    throw new Error("Hyperliquid cancel requires a valid client order id.");
  }
  const oid = normalizeHyperliquidExchangeOrderId(inputs.oid);
  const action = buildHyperliquidCancelAction({
    assetId,
    oid: oid ? Number(oid) : null,
    cloid,
  });
  const typedData = buildHyperliquidTypedData({
    action,
    nonce: inputs.nonce,
    isMainnet: env.hyperliquidChain !== "Testnet",
  });
  return {
    action,
    nonce: inputs.nonce,
    typedData,
    tokenId: inputs.tokenId,
    side: null,
    orderType: null,
    cloid: null,
    price: null,
    size: null,
    notionalUsd: null,
    marketId: null,
  };
}

function verifySignedPreparedAction(
  prepared: PreparedHyperliquidAction,
  signature: string,
  walletAddress: string,
) {
  const recovered = recoverHyperliquidSigner(prepared.typedData, signature);
  if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error(
      "Hyperliquid signature does not match the selected wallet.",
    );
  }
}

function normalizeHyperliquidUsdAmountRaw(value: string | number): bigint {
  const raw = typeof value === "number" ? String(value) : value.trim();
  if (!raw || !/^\d+(\.\d{1,6})?$/.test(raw)) {
    throw new Error("Enter a valid Hyperliquid USDC amount.");
  }
  const parsed = ethers.parseUnits(raw, 6);
  if (parsed <= 0n)
    throw new Error("Hyperliquid USDC amount must be greater than zero.");
  return parsed;
}

function normalizeHyperliquidNonNegativeUsdAmountRaw(
  value: string | number,
): bigint {
  const raw = typeof value === "number" ? String(value) : value.trim();
  if (!raw || !/^\d+(\.\d{1,6})?$/.test(raw)) {
    throw new Error("Enter a valid Hyperliquid USDC amount.");
  }
  return ethers.parseUnits(raw, 6);
}

function hyperliquidWithdrawalFeeRaw(): bigint {
  return normalizeHyperliquidNonNegativeUsdAmountRaw(
    env.hyperliquidWithdrawalFeeUsdc,
  );
}

async function prepareWithdrawAction(input: {
  userId: string;
  walletAddress: string;
  amount: string | number;
  destination?: string | null;
  nonce?: number | null;
}) {
  ensureTradingEnabled({
    userId: input.userId,
    walletAddress: input.walletAddress,
  });
  const receiveAmountRaw = normalizeHyperliquidUsdAmountRaw(input.amount);
  const receiveAmount = ethers.formatUnits(receiveAmountRaw, 6);
  const destination = normalizeEvmAddress(
    input.destination?.trim() || input.walletAddress,
  );
  if (!destination)
    throw new Error("Enter a valid Hyperliquid withdrawal destination.");
  if (destination.toLowerCase() !== input.walletAddress.toLowerCase()) {
    throw new Error(
      "HyperCore withdrawals currently support only the controlling Arbitrum wallet destination.",
    );
  }

  const state = await fetchHyperliquidSpotState(input.walletAddress);
  const availableRaw = BigInt(state.perpUsdcWithdrawableRaw);
  const feeRaw = hyperliquidWithdrawalFeeRaw();
  const totalDebitRaw = receiveAmountRaw + feeRaw;
  if (totalDebitRaw > availableRaw) {
    throw new Error(
      `Insufficient available HyperCore USDC. Withdrawing ${receiveAmount} USDC requires ${ethers.formatUnits(totalDebitRaw, 6)} USDC including the $${env.hyperliquidWithdrawalFeeUsdc.toFixed(2)} withdrawal fee.`,
    );
  }

  const nonce =
    input.nonce ??
    (await reserveHyperliquidNonce(input.userId, input.walletAddress));
  const prepared = buildHyperliquidWithdrawAction({
    amount: receiveAmount,
    destination,
    time: nonce,
    isMainnet: env.hyperliquidChain !== "Testnet",
  });
  const feeAmount = ethers.formatUnits(feeRaw, 6);
  const totalDebitAmount = ethers.formatUnits(totalDebitRaw, 6);

  return {
    ...prepared,
    nonce,
    amount: receiveAmount,
    amountRaw: receiveAmountRaw.toString(),
    receiveAmount,
    receiveAmountRaw: receiveAmountRaw.toString(),
    feeUsd: env.hyperliquidWithdrawalFeeUsdc,
    feeAmount,
    feeRaw: feeRaw.toString(),
    totalDebitAmount,
    totalDebitAmountRaw: totalDebitRaw.toString(),
    destination,
    availableRaw: availableRaw.toString(),
    withdrawalFeeUsd: env.hyperliquidWithdrawalFeeUsdc,
    estimatedDurationLabel: env.hyperliquidWithdrawalEstimatedDurationLabel,
  };
}

async function prepareUsdClassTransferAction(input: {
  userId: string;
  walletAddress: string;
  amount: string | number;
  toPerp: boolean;
  nonce?: number | null;
}) {
  ensureTradingEnabled({
    userId: input.userId,
    walletAddress: input.walletAddress,
  });
  const amountRaw = normalizeHyperliquidUsdAmountRaw(input.amount);
  const amount = ethers.formatUnits(amountRaw, 6);
  const state = await fetchHyperliquidSpotState(input.walletAddress);
  const availableRaw = BigInt(
    input.toPerp ? state.usdcAvailableRaw : state.perpUsdcWithdrawableRaw,
  );
  if (amountRaw > availableRaw) {
    throw new Error("Insufficient available HyperCore USDC.");
  }

  const nonce =
    input.nonce ??
    (await reserveHyperliquidNonce(input.userId, input.walletAddress));
  const prepared = buildHyperliquidUsdClassTransferAction({
    amount,
    toPerp: input.toPerp,
    nonce,
    isMainnet: env.hyperliquidChain !== "Testnet",
  });

  return {
    ...prepared,
    nonce,
    amount,
    amountRaw: amountRaw.toString(),
    toPerp: input.toPerp,
    availableRaw: availableRaw.toString(),
  };
}

function verifySignedUserAction(input: {
  typedData: ReturnType<typeof buildHyperliquidWithdrawAction>["typedData"];
  signature: string;
  walletAddress: string;
}) {
  const recovered = recoverHyperliquidUserSignedSigner(
    input.typedData,
    input.signature,
  );
  if (recovered.toLowerCase() !== input.walletAddress.toLowerCase()) {
    throw new Error(
      "Hyperliquid signature does not match the selected wallet.",
    );
  }
}

function buildHyperliquidTokenBalances(
  state: Awaited<ReturnType<typeof fetchHyperliquidSpotState>>,
): WalletTokenBalance[] {
  return state.balances
    .filter((balance) => balance.tokenId && Number(balance.total) > 0)
    .map((balance) => ({
      tokenId: balance.tokenId as string,
      size: balance.total,
      averagePrice:
        balance.entryNtl && Number(balance.total) > 0
          ? String(Number(balance.entryNtl) / Number(balance.total))
          : null,
    }));
}

function mergeHyperliquidTokenBalances(
  liveBalances: WalletTokenBalance[],
  executionBalances: WalletTokenBalance[],
): WalletTokenBalance[] {
  const merged = new Map<string, WalletTokenBalance>();
  for (const balance of executionBalances) {
    merged.set(balance.tokenId, balance);
  }
  for (const balance of liveBalances) {
    merged.set(balance.tokenId, balance);
  }
  return Array.from(merged.values());
}

async function loadHyperliquidExecutionTokenBalances(input: {
  userId: string;
  walletAddress: string;
}): Promise<WalletTokenBalance[]> {
  const { rows } = await pool.query<{
    token_id: string;
    net_size: string | null;
    buy_notional: string | null;
    buy_size: string | null;
  }>(
    `
      with execution_legs as (
        select
          output_mint as token_id,
          coalesce(amount_out, 0) as size_delta,
          coalesce(amount_in, 0) as buy_notional,
          coalesce(amount_out, 0) as buy_size
        from executions
        where user_id = $1
          and lower(wallet_address) = lower($2)
          and venue = 'hyperliquid'
          and lower(coalesce(status, '')) in ('fulfilled', 'confirmed', 'filled')
          and side = 'BUY'
          and output_mint like 'hyperliquid:%'
          and output_mint <> 'hyperliquid:usdc'

        union all

        select
          input_mint as token_id,
          -coalesce(amount_in, 0) as size_delta,
          0::numeric as buy_notional,
          0::numeric as buy_size
        from executions
        where user_id = $1
          and lower(wallet_address) = lower($2)
          and venue = 'hyperliquid'
          and lower(coalesce(status, '')) in ('fulfilled', 'confirmed', 'filled')
          and side = 'SELL'
          and input_mint like 'hyperliquid:%'
          and input_mint <> 'hyperliquid:usdc'
      )
      select
        token_id,
        sum(size_delta) as net_size,
        sum(buy_notional) as buy_notional,
        sum(buy_size) as buy_size
      from execution_legs
      group by token_id
      having sum(size_delta) > 0
    `,
    [input.userId, input.walletAddress],
  );

  return rows
    .map((row): WalletTokenBalance | null => {
      const size = Number(row.net_size ?? "0");
      if (!Number.isFinite(size) || size <= 0) return null;
      const buySize = Number(row.buy_size ?? "0");
      const buyNotional = Number(row.buy_notional ?? "0");
      const averagePrice =
        Number.isFinite(buySize) &&
        buySize > 0 &&
        Number.isFinite(buyNotional)
          ? String(buyNotional / buySize)
          : null;
      return {
        tokenId: row.token_id,
        size: row.net_size ?? "0",
        averagePrice,
      };
    })
    .filter((balance): balance is WalletTokenBalance => Boolean(balance));
}

async function loadHyperliquidTokenContext(
  tokenIds: string[],
): Promise<Map<string, HyperliquidTokenContext>> {
  const uniqueTokenIds = Array.from(new Set(tokenIds.filter(Boolean)));
  if (uniqueTokenIds.length === 0) return new Map();

  const { rows } = await pool.query<{
    token_id: string;
    market_id: string;
    side: string | null;
  }>(
    `
      select token_id, market_id::text, side
      from unified_tokens
      where venue = 'hyperliquid'
        and token_id = any($1::text[])
    `,
    [uniqueTokenIds],
  );

  return new Map(
    rows.map((row) => [
      row.token_id,
      { marketId: row.market_id, outcome: row.side ?? null },
    ]),
  );
}

async function syncHyperliquidPositionsFromState(input: {
  userId: string;
  walletAddress: string;
  state?: Awaited<ReturnType<typeof fetchHyperliquidSpotState>> | null;
}) {
  const liveBalances = input.state
    ? buildHyperliquidTokenBalances(input.state)
    : [];
  const executionBalances = await loadHyperliquidExecutionTokenBalances({
    userId: input.userId,
    walletAddress: input.walletAddress,
  });
  return syncWalletPositionsFromTokenBalances(pool, {
    userId: input.userId,
    walletAddress: input.walletAddress,
    venue: "hyperliquid",
    positionScope: "own",
    tokenBalances: mergeHyperliquidTokenBalances(
      liveBalances,
      executionBalances,
    ),
    tokenIdLike: "hyperliquid:%",
  });
}

type PersistHyperliquidOrderInput = {
  userId: string;
  walletAddress: string;
  signerAddress: string;
  venueOrderId: string;
  aliases: string[];
  tokenId: string | null;
  side: HyperliquidOrderSide | null;
  orderType: "GTC" | "FAK" | null;
  price: number | null;
  size: number | null;
  status: string;
  errorMessage?: string | null;
  rawError?: string | null;
  orderPayload?: unknown | null;
  orderPayloadVersion: "hyperliquid_order_v1" | "hyperliquid_info_v1";
  postedAt?: Date | null;
  lastUpdate?: Date | null;
  filledAt?: Date | null;
  cancelledAt?: Date | null;
  filledSize?: number | null;
  averageFillPrice?: number | null;
};

async function findExistingOrder(inputs: {
  userId: string;
  walletAddress: string;
  venueOrderAliases: string[];
}): Promise<{ id: string; status: string | null } | null> {
  if (inputs.venueOrderAliases.length === 0) return null;
  const { rows } = await pool.query<{ id: string; status: string | null }>(
    `
      select id, status
      from orders
      where user_id = $1
        and venue = 'hyperliquid'
        and venue_order_id = any($2::text[])
        and (wallet_address = $3 or signer_address = $3)
      order by coalesce(posted_at, last_update) desc nulls last, id desc
      limit 1
    `,
    [inputs.userId, inputs.venueOrderAliases, inputs.walletAddress],
  );
  return rows[0] ?? null;
}

function mergeOrderPayload(input: {
  previous: unknown;
  next: unknown;
  key: string;
}): unknown {
  if (input.next == null) return input.previous;
  if (
    input.previous &&
    typeof input.previous === "object" &&
    !Array.isArray(input.previous)
  ) {
    return {
      ...(input.previous as Record<string, unknown>),
      [input.key]: input.next,
    };
  }
  if (input.previous == null) return { [input.key]: input.next };
  return { previous: input.previous, [input.key]: input.next };
}

function isTerminalOrderStatus(status: string | null | undefined): boolean {
  const normalized = (status ?? "").toLowerCase();
  return (
    normalized === "filled" ||
    normalized === "cancelled" ||
    normalized === "rejected" ||
    normalized === "failed"
  );
}

function normalizeOrderPriceForStorage(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  return value >= 0 && value <= 1 ? value : null;
}

function normalizeOrderSizeForStorage(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  return value > 0 ? value : null;
}

function hasPersistableOrderAmounts(row: HyperliquidInfoOrderRow): boolean {
  return (
    normalizeOrderPriceForStorage(row.price) != null &&
    normalizeOrderSizeForStorage(row.size) != null
  );
}

async function persistHyperliquidOrder(
  inputs: PersistHyperliquidOrderInput,
): Promise<{ id: string; status: string }> {
  const aliases = Array.from(new Set([inputs.venueOrderId, ...inputs.aliases]));
  const price = normalizeOrderPriceForStorage(inputs.price);
  const size = normalizeOrderSizeForStorage(inputs.size);
  const selected = await pool.query<{
    id: string;
    status: string;
    order_payload: unknown | null;
  }>(
    `
      select id, status, order_payload
      from orders
      where user_id = $1
        and venue = 'hyperliquid'
        and venue_order_id = any($2::text[])
        and (wallet_address = $3 or signer_address = $3)
      order by
        (venue_order_id = $4)::int desc,
        posted_at desc nulls last,
        id desc
      limit 1
    `,
    [inputs.userId, aliases, inputs.walletAddress, inputs.venueOrderId],
  );

  const existing = selected.rows[0];
  const effectiveStatus =
    existing &&
    isTerminalOrderStatus(existing.status) &&
    !isTerminalOrderStatus(inputs.status)
      ? existing.status
      : inputs.status;
  const payload = mergeOrderPayload({
    previous: existing?.order_payload ?? null,
    next: inputs.orderPayload,
    key:
      inputs.orderPayloadVersion === "hyperliquid_info_v1"
        ? "hyperliquidInfo"
        : "hyperliquidOrder",
  });
  const payloadJson = payload == null ? null : JSON.stringify(payload);

  if (existing) {
    const { rows } = await pool.query<{ id: string; status: string }>(
      `
        update orders
        set
          venue_order_id = $2,
          wallet_address = coalesce(wallet_address, $3),
          signer_address = coalesce(signer_address, $4),
          token_id = coalesce($5, token_id),
          side = coalesce($6, side),
          order_type = coalesce($7, order_type),
          price = coalesce($8, price),
          size = coalesce($9, size),
          status = $10,
          filled_size = coalesce($11, filled_size),
          average_fill_price = coalesce($12, average_fill_price),
          error_message = coalesce($13, error_message),
          raw_error = coalesce($14, raw_error),
          order_payload = coalesce($15::jsonb, order_payload),
          order_payload_version = coalesce(order_payload_version, $16),
          posted_at = coalesce(posted_at, $17, now()),
          last_update = coalesce($18, now()),
          filled_at = case
            when $10 = 'filled' then coalesce(filled_at, $19, now())
            else filled_at
          end,
          cancelled_at = case
            when $10 = 'cancelled' then coalesce(cancelled_at, $20, now())
            else cancelled_at
          end
        where id = $1
        returning id::text, status
      `,
      [
        existing.id,
        inputs.venueOrderId,
        inputs.walletAddress,
        inputs.signerAddress,
        inputs.tokenId,
        inputs.side,
        inputs.orderType,
        price,
        size,
        effectiveStatus,
        inputs.filledSize ?? null,
        inputs.averageFillPrice ?? null,
        inputs.errorMessage ?? null,
        inputs.rawError ?? null,
        payloadJson,
        inputs.orderPayloadVersion,
        inputs.postedAt ?? null,
        inputs.lastUpdate ?? null,
        inputs.filledAt ?? null,
        inputs.cancelledAt ?? null,
      ],
    );
    return rows[0] ?? { id: existing.id, status: effectiveStatus };
  }

  if (price == null || size == null) {
    throw new Error(
      "Cannot persist a new Hyperliquid order without valid price and size.",
    );
  }

  const { rows } = await pool.query<{ id: string; status: string }>(
    `
      insert into orders (
        id, user_id, wallet_address, signer_address, venue, venue_order_id,
        token_id, side, order_type, price, size, status, filled_size,
        average_fill_price, error_message, raw_error, order_payload,
        order_payload_version, filled_at, cancelled_at, posted_at, last_update
      ) values (
        gen_random_uuid(), $1, $2, $3, 'hyperliquid', $4,
        $5, $6, $7, $8, $9, $10, coalesce($11, 0),
        $12, $13, $14, $15::jsonb,
        $16, $17, $18, coalesce($19, now()), coalesce($20, now())
      )
      returning id::text, status
    `,
    [
      inputs.userId,
      inputs.walletAddress,
      inputs.signerAddress,
      inputs.venueOrderId,
      inputs.tokenId,
      inputs.side,
      inputs.orderType,
      price,
      size,
      inputs.status,
      inputs.filledSize ?? 0,
      inputs.averageFillPrice ?? null,
      inputs.errorMessage ?? null,
      inputs.rawError ?? null,
      payloadJson,
      inputs.orderPayloadVersion,
      inputs.filledAt ?? null,
      inputs.cancelledAt ?? null,
      inputs.postedAt ?? null,
      inputs.lastUpdate ?? null,
    ],
  );
  return rows[0];
}

async function markHyperliquidOrderStatus(inputs: {
  userId: string;
  walletAddress: string;
  venueOrderAliases: string[];
  status: string;
  errorMessage?: string | null;
  raw?: unknown;
}): Promise<number> {
  if (inputs.venueOrderAliases.length === 0) return 0;
  const rawError =
    inputs.raw == null
      ? null
      : JSON.stringify({
          hyperliquidExchange: inputs.raw,
          errorMessage: inputs.errorMessage ?? null,
        });
  const result = await pool.query(
    `
      update orders
      set
        status = $4,
        error_message = coalesce($5, error_message),
        raw_error = coalesce($6, raw_error),
        last_update = now(),
        filled_at = case when $4 = 'filled' then coalesce(filled_at, now()) else filled_at end,
        cancelled_at = case when $4 = 'cancelled' then coalesce(cancelled_at, now()) else cancelled_at end
      where user_id = $1
        and venue = 'hyperliquid'
        and venue_order_id = any($2::text[])
        and (wallet_address = $3 or signer_address = $3)
    `,
    [
      inputs.userId,
      inputs.venueOrderAliases,
      inputs.walletAddress,
      inputs.status,
      inputs.errorMessage ?? null,
      rawError,
    ],
  );
  return result.rowCount ?? 0;
}

function normalizeInfoOrderRows(
  payload: unknown,
  fallbackStatus: string,
): HyperliquidInfoOrderRow[] {
  const rows = Array.isArray(payload) ? payload : [];
  return rows
    .map((entry): HyperliquidInfoOrderRow | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const nested =
        record.order && typeof record.order === "object"
          ? (record.order as Record<string, unknown>)
          : record;
      const coin = readString(nested, ["coin"]);
      const tokenId = coin ? hunchTokenIdFromHyperliquidCoin(coin) : null;
      const sideRaw = readString(nested, ["side"]);
      const side =
        sideRaw === "B" || sideRaw?.toUpperCase() === "BUY"
          ? "BUY"
          : sideRaw === "A" || sideRaw?.toUpperCase() === "SELL"
            ? "SELL"
            : null;
      const oid = readString(nested, ["oid", "orderId"]);
      const cloid = normalizeHyperliquidClientOrderId(
        readString(nested, ["cloid", "clientOrderId"]),
      );
      const normalizedOid = normalizeHyperliquidExchangeOrderId(oid);
      const status = readString(record, ["status"]) ?? fallbackStatus;
      const postedRaw = readString(nested, ["timestamp", "time"]);
      const postedAt = postedRaw != null ? new Date(Number(postedRaw)) : null;
      return {
        venueOrderId: canonicalHyperliquidVenueOrderId({
          cloid,
          oid: normalizedOid,
        }),
        cloid,
        oid: normalizedOid,
        tokenId,
        side,
        price: parseNumber(readString(nested, ["limitPx", "px", "price"])),
        size: parseNumber(readString(nested, ["sz", "origSz", "size"])),
        status: normalizeOrderStatus(status),
        postedAt:
          postedAt && Number.isFinite(postedAt.getTime()) ? postedAt : null,
        raw: entry,
      };
    })
    .filter((row): row is HyperliquidInfoOrderRow =>
      Boolean(row?.venueOrderId),
    );
}

function readString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return null;
}

function parseNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOrderStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("open") || normalized.includes("resting"))
    return "live";
  if (normalized.includes("fill")) return "filled";
  if (normalized.includes("cancel")) return "cancelled";
  if (normalized.includes("reject") || normalized.includes("error"))
    return "rejected";
  return normalized || "submitted";
}

function normalizeErrorPayload(error: unknown): {
  message: string;
  status: number;
  payload?: unknown;
} {
  const message =
    error instanceof Error ? error.message : "Hyperliquid request failed.";
  const responseStatus =
    typeof (error as { responseStatus?: unknown })?.responseStatus === "number"
      ? ((error as { responseStatus: number }).responseStatus ?? 400)
      : null;
  const code = (error as { code?: unknown })?.code;
  return {
    message,
    status:
      code === "hyperliquid_trading_disabled" ||
      code === "hyperliquid_trading_not_allowed"
        ? 403
        : responseStatus != null
          ? Math.max(400, Math.min(599, responseStatus))
          : 400,
    payload: (error as { responsePayload?: unknown })?.responsePayload,
  };
}

export const hyperliquidPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.post(
    "/order/quote",
    { preHandler: createAuthMiddleware(), schema: { body: orderBaseSchema } },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = normalizeEvmAddress(request.walletAddress ?? "");
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const quote = await quoteOrderAction({
          userId: user.id,
          walletAddress,
          body: request.body,
        });
        return reply.send({ ok: true, ...quote });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({
          error: normalized.message,
          code: (error as { code?: string })?.code,
          payload: normalized.payload,
        });
      }
    },
  );

  z.post(
    "/order/prepare",
    { preHandler: createAuthMiddleware(), schema: { body: orderBaseSchema } },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = normalizeEvmAddress(request.walletAddress ?? "");
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const prepared = await prepareOrderAction({
          userId: user.id,
          walletAddress,
          body: request.body,
        });
        return reply.send({ ok: true, ...prepared });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({
          error: normalized.message,
          code: (error as { code?: string })?.code,
          payload: normalized.payload,
        });
      }
    },
  );

  z.post(
    "/order",
    { preHandler: createAuthMiddleware(), schema: { body: orderSubmitSchema } },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = normalizeEvmAddress(request.walletAddress ?? "");
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const prepared = await prepareOrderAction({
          userId: user.id,
          walletAddress,
          body: request.body,
          nonce: request.body.nonce,
          cloid: request.body.cloid,
          fixedPrice: request.body.preparedPrice,
          fixedSize: request.body.preparedSize,
        });
        verifySignedPreparedAction(
          prepared,
          request.body.signature,
          walletAddress,
        );
        const cloid = normalizeHyperliquidClientOrderId(request.body.cloid);
        if (!cloid) throw new Error("Invalid Hyperliquid client order id.");
        const venueOrderId = canonicalHyperliquidVenueOrderId({ cloid });
        if (!venueOrderId) throw new Error("Invalid Hyperliquid order id.");
        const venueOrderAliases = hyperliquidVenueOrderIdAliases({ cloid });

        const existing = await findExistingOrder({
          userId: user.id,
          walletAddress,
          venueOrderAliases,
        });
        if (
          existing &&
          existing.status !== "rejected" &&
          existing.status !== "failed"
        ) {
          return reply.send({
            ok: true,
            duplicate: true,
            venueOrderId,
            clientOrderId: cloid,
            status: existing.status ?? "submitted",
          });
        }

        const stored = await persistHyperliquidOrder({
          userId: user.id,
          walletAddress,
          signerAddress: walletAddress,
          venueOrderId,
          aliases: venueOrderAliases,
          tokenId: prepared.tokenId,
          side: prepared.side,
          orderType: prepared.orderType,
          price: prepared.price,
          size: prepared.size,
          status: "submitted",
          errorMessage: null,
          rawError: null,
          orderPayload: {
            action: prepared.action,
            nonce: prepared.nonce,
            cloid,
            typedData: prepared.typedData,
          },
          orderPayloadVersion: "hyperliquid_order_v1",
        });

        let exchange: unknown;
        try {
          exchange = await submitHyperliquidExchangeAction({
            action: prepared.action,
            nonce: prepared.nonce,
            signature: request.body.signature,
          });
        } catch (exchangeError) {
          await markHyperliquidOrderStatus({
            userId: user.id,
            walletAddress,
            venueOrderAliases,
            status: "rejected",
            errorMessage:
              exchangeError instanceof Error
                ? exchangeError.message
                : "Hyperliquid exchange submit failed.",
            raw: exchangeError,
          });
          throw exchangeError;
        }
        const status = extractHyperliquidOrderStatus(exchange);
        const reportedAliases = hyperliquidVenueOrderIdAliases({
          cloid,
          oid: status.venueOrderId,
          venueOrderId,
        });
        await persistHyperliquidOrder({
          userId: user.id,
          walletAddress,
          signerAddress: walletAddress,
          venueOrderId,
          aliases: reportedAliases,
          tokenId: prepared.tokenId,
          side: prepared.side,
          orderType: prepared.orderType,
          price: prepared.price,
          size: prepared.size,
          status: status.status,
          errorMessage: status.errorMessage,
          filledSize: status.filledSize,
          averageFillPrice: status.averageFillPrice,
          rawError: status.errorMessage ? JSON.stringify(exchange) : null,
          orderPayload: {
            exchange,
            reportedVenueOrderId: status.venueOrderId
              ? canonicalHyperliquidVenueOrderId({ oid: status.venueOrderId })
              : null,
          },
          orderPayloadVersion: "hyperliquid_order_v1",
          filledAt: status.status === "filled" ? new Date() : null,
          cancelledAt: status.status === "cancelled" ? new Date() : null,
        });

        return reply.send({
          ok: status.status !== "rejected",
          orderId: stored.id,
          venueOrderId,
          reportedVenueOrderId: status.venueOrderId
            ? canonicalHyperliquidVenueOrderId({ oid: status.venueOrderId })
            : null,
          clientOrderId: cloid,
          status: status.status,
          error: status.errorMessage,
          raw: exchange,
        });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({
          error: normalized.message,
          code: (error as { code?: string })?.code,
          payload: normalized.payload,
        });
      }
    },
  );

  z.post(
    "/cancel/prepare",
    { preHandler: createAuthMiddleware(), schema: { body: cancelBaseSchema } },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = normalizeEvmAddress(request.walletAddress ?? "");
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      try {
        ensureTradingEnabled({ userId: user.id, walletAddress });
        const nonce = await reserveHyperliquidNonce(user.id, walletAddress);
        const prepared = prepareCancelAction({
          tokenId: request.body.tokenId,
          oid: request.body.oid,
          cloid: request.body.cloid,
          nonce,
        });
        return reply.send({ ok: true, ...prepared });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({ error: normalized.message });
      }
    },
  );

  z.post(
    "/cancel",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: cancelSubmitSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = normalizeEvmAddress(request.walletAddress ?? "");
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      try {
        ensureTradingEnabled({ userId: user.id, walletAddress });
        const cloid = normalizeHyperliquidClientOrderId(request.body.cloid);
        const oid = normalizeHyperliquidExchangeOrderId(request.body.oid);
        const venueOrderAliases = hyperliquidVenueOrderIdAliases({
          cloid,
          oid,
        });
        const prepared = prepareCancelAction({
          tokenId: request.body.tokenId,
          oid: request.body.oid,
          cloid: request.body.cloid,
          nonce: request.body.nonce,
        });
        verifySignedPreparedAction(
          prepared,
          request.body.signature,
          walletAddress,
        );
        const exchange = await submitHyperliquidExchangeAction({
          action: prepared.action,
          nonce: prepared.nonce,
          signature: request.body.signature,
        });
        const cancelStatus = extractHyperliquidCancelStatus(exchange);
        if (cancelStatus.status !== "cancelled") {
          reply.code(400);
          return reply.send({
            ok: false,
            status: cancelStatus.status,
            error:
              cancelStatus.errorMessage ??
              "Hyperliquid rejected the cancel request.",
            raw: exchange,
          });
        }
        const updated = await markHyperliquidOrderStatus({
          userId: user.id,
          walletAddress,
          venueOrderAliases,
          status: "cancelled",
          raw: exchange,
        });
        if (updated === 0) {
          reply.code(409);
          return reply.send({
            ok: false,
            status: "stale",
            error:
              "Hyperliquid cancel succeeded but no local order row matched.",
            raw: exchange,
          });
        }
        return reply.send({ ok: true, status: "cancelled", raw: exchange });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({
          error: normalized.message,
          payload: normalized.payload,
        });
      }
    },
  );

  z.post(
    "/orders/sync",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = normalizeEvmAddress(request.walletAddress ?? "");
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      try {
        ensureTradingEnabled({ userId: user.id, walletAddress });
        const fillsStartTime = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const [openPayload, historicalPayload] = await Promise.all([
          hyperliquidInfo({ type: "frontendOpenOrders", user: walletAddress }),
          hyperliquidInfo({ type: "historicalOrders", user: walletAddress }),
        ]);
        const fillsPayload = await hyperliquidInfo({
          type: "userFillsByTime",
          user: walletAddress,
          startTime: fillsStartTime,
        }).catch((error) => {
          app.log.warn(
            { error, userId: user.id, walletAddress },
            "Failed to sync Hyperliquid user fills",
          );
          return [];
        });
        const rows = [
          ...normalizeInfoOrderRows(openPayload, "live"),
          ...normalizeInfoOrderRows(historicalPayload, "submitted"),
        ];
        let stored = 0;
        let skippedIncomplete = 0;
        for (const row of rows) {
          if (!row.venueOrderId || !row.tokenId) continue;
          const venueOrderAliases = hyperliquidVenueOrderIdAliases({
            cloid: row.cloid,
            oid: row.oid,
            venueOrderId: row.venueOrderId,
          });
          if (!hasPersistableOrderAmounts(row)) {
            const existing = await findExistingOrder({
              userId: user.id,
              walletAddress,
              venueOrderAliases,
            });
            if (!existing) {
              skippedIncomplete += 1;
              app.log.warn(
                {
                  userId: user.id,
                  walletAddress,
                  venueOrderId: row.venueOrderId,
                  tokenId: row.tokenId,
                  price: row.price,
                  size: row.size,
                  status: row.status,
                },
                "Skipping incomplete Hyperliquid order sync row",
              );
              continue;
            }
          }
          await persistHyperliquidOrder({
            userId: user.id,
            walletAddress,
            signerAddress: walletAddress,
            venueOrderId: row.venueOrderId,
            aliases: venueOrderAliases,
            tokenId: row.tokenId,
            side: row.side,
            orderType: "GTC",
            price: row.price,
            size: row.size,
            status: row.status,
            errorMessage: null,
            rawError: null,
            orderPayload: row.raw,
            orderPayloadVersion: "hyperliquid_info_v1",
            postedAt: row.postedAt,
            lastUpdate: new Date(),
            filledAt:
              row.status === "filled" ? (row.postedAt ?? new Date()) : null,
            cancelledAt:
              row.status === "cancelled" ? (row.postedAt ?? new Date()) : null,
          });
          stored += 1;
        }

        const fills = normalizeHyperliquidUserFills(fillsPayload);
        const fillTokenContext = await loadHyperliquidTokenContext(
          fills.map((fill) => fill.tokenId),
        );
        let executionsStored = 0;
        for (const fill of fills) {
          const tokenContext = fillTokenContext.get(fill.tokenId) ?? null;
          await storeExecution(pool, {
            userId: user.id,
            walletAddress,
            venue: "hyperliquid",
            unifiedMarketId: tokenContext?.marketId ?? null,
            side: fill.side,
            outcome: tokenContext?.outcome ?? null,
            inputMint: fill.side === "BUY" ? "hyperliquid:usdc" : fill.tokenId,
            outputMint: fill.side === "BUY" ? fill.tokenId : "hyperliquid:usdc",
            amountIn: fill.side === "BUY" ? fill.notionalUsd : fill.size,
            amountOut: fill.side === "BUY" ? fill.size : fill.notionalUsd,
            inputDecimals: fill.side === "BUY" ? 6 : null,
            outputDecimals: fill.side === "BUY" ? null : 6,
            quoteId: fill.quoteId,
            txSignature: fill.txSignature,
            venueOrderId: fill.venueOrderId,
            status: "fulfilled",
            raw: {
              hyperliquidFill: fill.raw,
              executedAt: fill.executedAt?.toISOString() ?? null,
            },
          });
          executionsStored += 1;
        }
        let positionsSynced: Awaited<
          ReturnType<typeof syncHyperliquidPositionsFromState>
        > | null = null;
        let positionsSyncError: string | null = null;
        try {
          const state = await fetchHyperliquidSpotState(walletAddress).catch(
            (error) => {
              positionsSyncError =
                error instanceof Error
                  ? error.message
                  : "Live Hyperliquid balance sync failed.";
              app.log.warn(
                { error, userId: user.id, walletAddress },
                "Failed to fetch live Hyperliquid balances during order sync",
              );
              return null;
            },
          );
          positionsSynced = await syncHyperliquidPositionsFromState({
            userId: user.id,
            walletAddress,
            state,
          });
        } catch (error) {
          positionsSyncError =
            error instanceof Error ? error.message : "Position sync failed.";
          app.log.warn(
            { error, userId: user.id, walletAddress },
            "Failed to sync Hyperliquid positions after order sync",
          );
        }
        return reply.send({
          ok: true,
          stored,
          scanned: rows.length,
          skippedIncomplete,
          executionsStored,
          positionsSynced,
          positionsSyncError,
        });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({
          error: normalized.message,
          payload: normalized.payload,
        });
      }
    },
  );

  z.post(
    "/positions/sync",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = normalizeEvmAddress(request.walletAddress ?? "");
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      try {
        ensureTradingEnabled({ userId: user.id, walletAddress });
        const state = await fetchHyperliquidSpotState(walletAddress);
        const result = await syncHyperliquidPositionsFromState({
          userId: user.id,
          walletAddress,
          state,
        });
        return reply.send({
          ok: true,
          usdc: {
            balance: state.usdcBalance,
            balanceRaw: state.usdcBalanceRaw,
            decimals: 6,
            symbol: "USDC",
          },
          ...result,
        });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({
          error: normalized.message,
          payload: normalized.payload,
        });
      }
    },
  );

  z.post(
    "/withdraw/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: withdrawBaseSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = normalizeEvmAddress(request.walletAddress ?? "");
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      try {
        const prepared = await prepareWithdrawAction({
          userId: user.id,
          walletAddress,
          amount: request.body.amount,
          destination: request.body.destination,
        });
        return reply.send({ ok: true, ...prepared });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({
          error: normalized.message,
          code: (error as { code?: string })?.code,
          payload: normalized.payload,
        });
      }
    },
  );

  z.post(
    "/usd-class-transfer/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: usdClassTransferBaseSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = normalizeEvmAddress(request.walletAddress ?? "");
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      try {
        const prepared = await prepareUsdClassTransferAction({
          userId: user.id,
          walletAddress,
          amount: request.body.amount,
          toPerp: request.body.toPerp,
        });
        return reply.send({ ok: true, ...prepared });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({
          error: normalized.message,
          code: (error as { code?: string })?.code,
          payload: normalized.payload,
        });
      }
    },
  );

  z.post(
    "/usd-class-transfer",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: usdClassTransferSubmitSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = normalizeEvmAddress(request.walletAddress ?? "");
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      try {
        const prepared = await prepareUsdClassTransferAction({
          userId: user.id,
          walletAddress,
          amount: request.body.amount,
          toPerp: request.body.toPerp,
          nonce: request.body.nonce,
        });
        verifySignedUserAction({
          typedData: prepared.typedData,
          signature: request.body.signature,
          walletAddress,
        });
        const exchange = await submitHyperliquidExchangeAction({
          action: prepared.action,
          nonce: prepared.nonce,
          signature: request.body.signature,
        });
        const state = await fetchHyperliquidSpotState(walletAddress).catch(
          () => null,
        );
        return reply.send({
          ok: true,
          status: "submitted",
          amount: prepared.amount,
          amountRaw: prepared.amountRaw,
          toPerp: prepared.toPerp,
          usdc: state
            ? {
                balance: state.usdcBalance,
                balanceRaw: state.usdcBalanceRaw,
                available: state.usdcAvailable,
                availableRaw: state.usdcAvailableRaw,
                hold: state.usdcHold,
                holdRaw: state.usdcHoldRaw,
                decimals: 6,
                symbol: "USDC",
              }
            : null,
          perpUsdc: state
            ? {
                balance: state.perpUsdcBalance,
                balanceRaw: state.perpUsdcBalanceRaw,
                available: state.perpUsdcWithdrawable,
                availableRaw: state.perpUsdcWithdrawableRaw,
                decimals: 6,
                symbol: "USDC",
              }
            : null,
          raw: exchange,
        });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({
          error: normalized.message,
          code: (error as { code?: string })?.code,
          payload: normalized.payload,
        });
      }
    },
  );

  z.post(
    "/withdraw",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: withdrawSubmitSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = normalizeEvmAddress(request.walletAddress ?? "");
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      try {
        const prepared = await prepareWithdrawAction({
          userId: user.id,
          walletAddress,
          amount: request.body.amount,
          destination: request.body.destination,
          nonce: request.body.nonce,
        });
        verifySignedUserAction({
          typedData: prepared.typedData,
          signature: request.body.signature,
          walletAddress,
        });
        const exchange = await submitHyperliquidExchangeAction({
          action: prepared.action,
          nonce: prepared.nonce,
          signature: request.body.signature,
        });
        const state = await fetchHyperliquidSpotState(walletAddress).catch(
          () => null,
        );
        return reply.send({
          ok: true,
          status: "submitted",
          amount: prepared.amount,
          amountRaw: prepared.amountRaw,
          receiveAmount: prepared.receiveAmount,
          receiveAmountRaw: prepared.receiveAmountRaw,
          feeUsd: prepared.feeUsd,
          feeAmount: prepared.feeAmount,
          feeRaw: prepared.feeRaw,
          totalDebitAmount: prepared.totalDebitAmount,
          totalDebitAmountRaw: prepared.totalDebitAmountRaw,
          destination: prepared.destination,
          withdrawalFeeUsd: prepared.withdrawalFeeUsd,
          estimatedDurationLabel: prepared.estimatedDurationLabel,
          usdc: state
            ? {
                balance: state.usdcBalance,
                balanceRaw: state.usdcBalanceRaw,
                available: state.usdcAvailable,
                availableRaw: state.usdcAvailableRaw,
                hold: state.usdcHold,
                holdRaw: state.usdcHoldRaw,
                decimals: 6,
                symbol: "USDC",
              }
            : null,
          raw: exchange,
        });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({
          error: normalized.message,
          code: (error as { code?: string })?.code,
          payload: normalized.payload,
        });
      }
    },
  );

  z.post(
    "/embedded/sign-typed-data/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedSignTypedDataPrepareBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      try {
        ensureTradingEnabled({ userId: user.id, walletAddress: signer });
        const context = await resolveEmbeddedPrivyWalletContext({
          user,
          signer,
          venueLabel: "Hyperliquid",
        });
        const requestPayload = createEmbeddedPrivyWalletRpcRequest({
          id: request.body.id,
          label: request.body.label,
          walletId: context.walletId,
          body: {
            method: "eth_signTypedData_v4",
            address: context.signer,
            chain_type: "ethereum",
            params: {
              typed_data: {
                primary_type: request.body.typedData.primaryType,
                domain: request.body.typedData.domain,
                types: request.body.typedData.types,
                message: request.body.typedData.message,
              },
            },
          },
        });
        return reply.send({ ok: true, request: requestPayload });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({ error: normalized.message });
      }
    },
  );

  z.post(
    "/embedded/sign-typed-data",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedSignTypedDataBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      try {
        ensureTradingEnabled({ userId: user.id, walletAddress: signer });
        const context = await resolveEmbeddedPrivyWalletContext({
          user,
          signer,
          venueLabel: "Hyperliquid",
        });
        const requestPayload = createEmbeddedPrivyWalletRpcRequest({
          id: request.body.id,
          label: request.body.label,
          walletId: context.walletId,
          body: {
            method: "eth_signTypedData_v4",
            address: context.signer,
            chain_type: "ethereum",
            params: {
              typed_data: {
                primary_type: request.body.typedData.primaryType,
                domain: request.body.typedData.domain,
                types: request.body.typedData.types,
                message: request.body.typedData.message,
              },
            },
          },
        });
        const signature = await executePreparedPrivySignatureRequest({
          request: requestPayload,
          authorizationSignature: request.body.authorizationSignature,
        });
        return reply.send({ ok: true, signature });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({ error: normalized.message });
      }
    },
  );
};
