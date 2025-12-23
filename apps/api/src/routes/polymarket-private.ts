import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";
import { AuthService, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import { isRecord } from "../lib/type-guards.js";
import { storeOrder } from "../repos/orders-repo.js";
import { fetchPolymarketMarketInfo } from "../repos/polymarket-markets.js";
import {
  polymarketCancelOrderBodySchema,
  polymarketFunderDeriveQuerySchema,
  polymarketMarketInfoQuerySchema,
  polymarketOrderHashBodySchema,
  polymarketOrderParamsQuerySchema,
  polymarketOpenOrdersQuerySchema,
  polymarketPlaceOrderBodySchema,
  polymarketQuoteBodySchema,
} from "../schemas/polymarket-private.js";
import {
  fetchErc1155IsApprovedForAll,
  fetchErc20Allowance,
  fetchErc20BalanceOf,
  fetchFeeCollectorNonce,
  fetchEvmCode,
  fetchPolymarketOrderHash,
} from "../services/polygon-rpc.js";
import { derivePolymarketFunders } from "../services/polymarket-funder.js";
import { polymarketClient } from "../services/polymarket-client.js";
import {
  extractOrderArray,
  extractOrderId,
  extractTokenId,
  polymarketL2Request,
} from "../services/polymarket-clob-l2.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const POLY_DECIMALS = 6;
const MARKET_USD_MICRO_STEP = 10_000n; // 2 decimals in 6-decimal USDC
const MARKET_USD_MICRO_STEP_5_DEC = 10n; // 5 decimals in 6-decimal USDC
const MARKET_SHARES_MICRO_STEP = 100n; // 4 decimals in 6-decimal share units
const MARKET_SHARES_MICRO_STEP_2_DEC = 10_000n; // 2 decimals in 6-decimal share units

type PolymarketSide = "BUY" | "SELL";
type PolymarketOrderType = "GTC" | "GTD" | "FAK" | "FOK";
type PolymarketClobOrderType = "GTC" | "GTD" | "FOK";
type OrderbookSummary = {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  tickSize: number | null;
  minOrderSize: number | null;
  negRisk: boolean | null;
};

const USDC_SCALE = 1_000_000n;

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeHex(value: string): string {
  return value.trim().toLowerCase();
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return undefined;
}

function normalizeOrderSide(value: unknown): PolymarketSide | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const upper = trimmed.toUpperCase();
    if (upper === "BUY" || upper === "SELL") return upper;
    if (upper === "0") return "BUY";
    if (upper === "1") return "SELL";
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 0) return "BUY";
    if (value === 1) return "SELL";
  }

  return null;
}

function normalizeNumberishString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return null;
}

function parseInteger(value: unknown): bigint | null {
  const raw = normalizeNumberishString(value);
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return BigInt(Math.trunc(parsed));
}

function normalizeSignatureType(value: unknown): number | null {
  const raw = normalizeNumberishString(value);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function normalizeOrderType(value: unknown): PolymarketOrderType | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  if (upper === "GTC" || upper === "GTD" || upper === "FAK" || upper === "FOK") {
    return upper;
  }
  return null;
}

function normalizeOrderTypeForClob(value: unknown): PolymarketClobOrderType {
  const normalized = normalizeOrderType(value);
  if (normalized === "FAK") return "FOK";
  if (normalized === "GTC" || normalized === "GTD" || normalized === "FOK") {
    return normalized;
  }
  return "GTC";
}

function parseNumberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseOrderbookSide(side: unknown): Array<{ price: number; size: number }> {
  if (!Array.isArray(side)) return [];
  const entries: Array<{ price: number; size: number }> = [];
  for (const row of side) {
    if (!isRecord(row)) continue;
    const price = parseNumberish(row.price);
    const size = parseNumberish(row.size);
    if (price == null || size == null) continue;
    entries.push({ price, size });
  }
  return entries;
}

function extractOrderbookSummary(payload: unknown): OrderbookSummary | null {
  if (!isRecord(payload)) return null;
  const raw = isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(raw)) return null;

  const bidsRaw = Array.isArray(raw.bids)
    ? raw.bids
    : Array.isArray(raw.buys)
      ? raw.buys
      : [];
  const asksRaw = Array.isArray(raw.asks)
    ? raw.asks
    : Array.isArray(raw.sells)
      ? raw.sells
      : [];

  const bids = parseOrderbookSide(bidsRaw);
  const asks = parseOrderbookSide(asksRaw);

  const tickSize =
    parseNumberish(raw.tick_size ?? raw.tickSize ?? raw.order_price_min_tick_size) ??
    null;
  const minOrderSize =
    parseNumberish(raw.min_order_size ?? raw.minOrderSize ?? raw.order_min_size) ??
    null;
  const negRisk =
    typeof raw.neg_risk === "boolean"
      ? raw.neg_risk
      : typeof raw.negRisk === "boolean"
        ? raw.negRisk
        : null;

  return { bids, asks, tickSize, minOrderSize, negRisk };
}

function findBestBid(bids: Array<{ price: number }>): number | null {
  let best: number | null = null;
  for (const bid of bids) {
    if (best == null || bid.price > best) best = bid.price;
  }
  return best;
}

function findBestAsk(asks: Array<{ price: number }>): number | null {
  let best: number | null = null;
  for (const ask of asks) {
    if (best == null || ask.price < best) best = ask.price;
  }
  return best;
}

function roundPriceToTick(price: number, tickSize: number, side: PolymarketSide): number {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) {
    return price;
  }
  const ticks = price / tickSize;
  const roundedTicks =
    side === "BUY" ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9);
  return roundedTicks * tickSize;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function lcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (a / gcd(a, b)) * b;
}

function exchangeAddressForNegRisk(negRisk: boolean | null): string | null {
  if (negRisk == null) return null;
  return negRisk ? env.polymarketNegRiskExchangeAddress : env.polymarketExchangeAddress;
}

function generatePolymarketNonce(): string {
  return "0";
}

function normalizeOrderForPayload(
  order: Record<string, unknown>,
  side: PolymarketSide,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...order };

  normalized.side = side;

  const signatureType = normalizeSignatureType(order.signatureType);
  if (signatureType !== null) {
    normalized.signatureType = signatureType;
  }

  const saltRaw = normalizeNumberishString(order.salt);
  if (saltRaw !== null) {
    const saltNumber = Number(saltRaw);
    normalized.salt = Number.isSafeInteger(saltNumber) ? saltNumber : saltRaw;
  }

  for (const key of [
    "tokenId",
    "makerAmount",
    "takerAmount",
    "expiration",
    "nonce",
    "feeRateBps",
  ]) {
    const value = normalizeNumberishString(order[key]);
    if (value !== null) normalized[key] = value;
  }

  const takerRaw = order.taker;
  if (typeof takerRaw !== "string" || takerRaw.trim().length === 0) {
    normalized.taker = ZERO_ADDRESS;
  }

  return normalized;
}

function normalizeOrderForHash(
  order: Record<string, unknown>,
  side: PolymarketSide,
): {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: number;
  signatureType: number;
  signature: string;
} | null {
  const signatureType = normalizeSignatureType(order.signatureType);
  if (signatureType == null) return null;

  const maker = typeof order.maker === "string" ? order.maker.trim() : "";
  const signer = typeof order.signer === "string" ? order.signer.trim() : "";
  if (!maker || !signer) return null;

  const salt = normalizeNumberishString(order.salt);
  const tokenId = normalizeNumberishString(order.tokenId);
  const makerAmount = normalizeNumberishString(order.makerAmount);
  const takerAmount = normalizeNumberishString(order.takerAmount);
  const expiration = normalizeNumberishString(order.expiration);
  const nonce = normalizeNumberishString(order.nonce);
  const feeRateBps = normalizeNumberishString(order.feeRateBps);
  if (
    !salt ||
    !tokenId ||
    !makerAmount ||
    !takerAmount ||
    !expiration ||
    !nonce ||
    !feeRateBps
  ) {
    return null;
  }

  const takerRaw = typeof order.taker === "string" ? order.taker.trim() : "";
  const taker = takerRaw.length ? takerRaw : ZERO_ADDRESS;

  const signature =
    typeof order.signature === "string" ? order.signature.trim() : "";
  if (!signature) return null;

  return {
    salt,
    maker,
    signer,
    taker,
    tokenId,
    makerAmount,
    takerAmount,
    expiration,
    nonce,
    feeRateBps,
    side: side === "BUY" ? 0 : 1,
    signatureType,
    signature,
  };
}

function derivePriceAndSize(
  order: Record<string, unknown>,
  side: PolymarketSide,
): { price: number | null; size: number | null } {
  const makerAmount = parseInteger(order.makerAmount);
  const takerAmount = parseInteger(order.takerAmount);
  if (!makerAmount || !takerAmount) return { price: null, size: null };
  if (makerAmount === 0n || takerAmount === 0n)
    return { price: null, size: null };

  const price =
    side === "BUY"
      ? Number(makerAmount) / Number(takerAmount)
      : Number(takerAmount) / Number(makerAmount);

  const sizeMicro = side === "BUY" ? takerAmount : makerAmount;
  const size = Number(sizeMicro) / 10 ** POLY_DECIMALS;

  if (!Number.isFinite(price) || !Number.isFinite(size)) {
    return { price: null, size: null };
  }

  return { price, size };
}

function extractOrderType(order: Record<string, unknown>): PolymarketOrderType | null {
  const raw =
    order.orderType ?? order.order_type ?? order.type ?? order.order_type;
  return normalizeOrderType(raw);
}

// Mounted under /trade/polymarket.
export const polymarketPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /market-info
   * Returns Polymarket-specific market constraints and exchange selection.
   */
  z.get(
    "/market-info",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: polymarketMarketInfoQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket market info requires an EVM wallet address",
        });
      }

      const query = request.query;

      try {
        const info = await fetchPolymarketMarketInfo(pool, {
          tokenId: query.tokenId,
          marketId: query.marketId,
          conditionId: query.conditionId,
        });

        if (!info) {
          reply.code(404);
          return reply.send({ error: "Polymarket market not found" });
        }

        let clobTokenIds: string[] | null = null;
        if (info.clob_token_ids) {
          try {
            const parsed = JSON.parse(info.clob_token_ids);
            if (Array.isArray(parsed)) {
              clobTokenIds = parsed.map((value) => String(value));
            }
          } catch {
            clobTokenIds = null;
          }
        }

        const negRisk =
          info.neg_risk != null ? Boolean(info.neg_risk) : null;

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          tokenId: query.tokenId ?? null,
          marketId: query.marketId ?? null,
          conditionId: query.conditionId ?? null,
          polymarketId: info.polymarket_id,
          unifiedMarketId: info.unified_market_id,
          clobTokenIds,
          tokenYes: clobTokenIds?.[0] ?? null,
          tokenNo: clobTokenIds?.[1] ?? null,
          negRisk,
          exchangeAddress: exchangeAddressForNegRisk(negRisk),
          orderPriceMinTickSize:
            info.order_price_min_tick_size != null
              ? Number(info.order_price_min_tick_size)
              : null,
          orderMinSize:
            info.order_min_size != null ? Number(info.order_min_size) : null,
          acceptingOrders:
            info.accepting_orders != null
              ? Boolean(info.accepting_orders)
              : null,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer, query },
          "Failed to fetch Polymarket market info",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to fetch Polymarket market info",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /order-params
   * Returns default params needed to build an order signature.
   */
  z.get(
    "/order-params",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: polymarketOrderParamsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket order params require an EVM wallet address",
        });
      }

      const tokenId = request.query.tokenId.trim();
      if (!tokenId) {
        reply.code(400);
        return reply.send({ error: "tokenId is required" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        tokenId,
        nonce: generatePolymarketNonce(),
        feeRateBps: 0,
      });
    },
  );

  /**
   * POST /order-hash
   * Compute the Polymarket exchange order hash for a signed order.
   */
  z.post(
    "/order-hash",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketOrderHashBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket order hash requires an EVM wallet address",
        });
      }

      const body = request.body;
      const order = body.order;
      const orderTokenId =
        typeof order.tokenId === "string" ? order.tokenId : "";
      if (orderTokenId) {
        void markHotTokens({ tokenIds: [orderTokenId], venue: "polymarket" });
      }

      const orderSigner = typeof order.signer === "string" ? order.signer : "";
      if (normalizeAddress(orderSigner) !== normalizeAddress(signer)) {
        reply.code(400);
        return reply.send({
          error: "Order signer must match the selected wallet",
        });
      }

      const credsInfo = await AuthService.getVenueCredentialsInfo(
        user.id,
        "polymarket",
        signer,
      );
      const funder = credsInfo?.funderAddress ?? signer;
      const maker = typeof order.maker === "string" ? order.maker : "";
      if (normalizeAddress(maker) !== normalizeAddress(funder)) {
        reply.code(400);
        return reply.send({
          error:
            "Order maker does not match the configured Polymarket funder/vault",
        });
      }

      const side = normalizeOrderSide(order.side);
      if (!side) {
        reply.code(400);
        return reply.send({
          error: "Order side must be BUY/SELL (or 0/1)",
        });
      }

      const normalizedForHash = normalizeOrderForHash(order, side);
      if (!normalizedForHash) {
        reply.code(400);
        return reply.send({
          error: "Order payload is missing required hash fields",
        });
      }

      const exchangeAddress =
        (typeof body.exchangeAddress === "string" && body.exchangeAddress) ||
        exchangeAddressForNegRisk(body.negRisk ?? null) ||
        env.polymarketExchangeAddress;

      try {
        const orderHash = await fetchPolymarketOrderHash({
          rpcUrl: env.polygonRpcUrl,
          timeoutMs: env.polygonRpcTimeoutMs,
          exchangeAddress,
          order: normalizedForHash,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          orderHash,
          exchangeAddress,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to compute Polymarket order hash",
        );
        reply.code(502);
        return reply.send({
          error: "Polymarket order hash failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /funder-derive
   * Returns candidate Polymarket funder/vault addresses for the selected signer.
   */
  z.get(
    "/funder-derive",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: polymarketFunderDeriveQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = isRecord(request.query) ? request.query : null;
      const walletOverride =
        typeof query?.walletAddress === "string"
          ? query.walletAddress.trim()
          : null;
      const signer = walletOverride || request.walletAddress;
      if (!signer) {
        reply.code(400);
        return reply.send({ error: "walletAddress is required" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket funder derive requires an EVM wallet address",
        });
      }

      if (walletOverride) {
        const walletRecord = await AuthService.getUserWalletByAddress(
          user.id,
          signer,
        );
        if (!walletRecord) {
          reply.code(403);
          return reply.send({
            error: "walletAddress does not belong to the current user",
          });
        }
      }

      const credsInfo = await AuthService.getVenueCredentialsInfo(
        user.id,
        "polymarket",
        signer,
      );

      const includeMagicProxy =
        parseOptionalBoolean(query?.includeMagicProxy) ?? false;

      const result = await derivePolymarketFunders({
        signer,
        storedFunder: credsInfo?.funderAddress ?? null,
        includeMagicProxy,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        ...result,
      });
    },
  );

  /**
   * POST /quote
   * Returns a price/size preview derived from the current orderbook.
   */
  z.post(
    "/quote",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketQuoteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket quote requires an EVM wallet address",
        });
      }

      const body = request.body;
      const tokenId = body.tokenId.trim();
      const orderType = normalizeOrderTypeForClob(body.orderType ?? "FOK");
      const amountType = (body.amountType ?? "usd") === "shares" ? "shares" : "usd";
      const amountUsdInput =
        amountType === "usd" ? (body.amountUsd ?? body.amount) : null;
      const amountSharesInput =
        amountType === "shares" ? body.amount : null;

      if (!tokenId) {
        reply.code(400);
        return reply.send({ error: "tokenId is required" });
      }

      void markHotTokens({ tokenIds: [tokenId], venue: "polymarket" });

      try {
        const [orderbookPayload, marketInfo] = await Promise.all([
          polymarketClient.getOrderBook(tokenId),
          fetchPolymarketMarketInfo(pool, { tokenId }),
        ]);

        const orderbook = extractOrderbookSummary(orderbookPayload);
        if (!orderbook) {
          reply.code(502);
          return reply.send({ error: "Invalid Polymarket orderbook response" });
        }

        const bestBid = findBestBid(orderbook.bids);
        const bestAsk = findBestAsk(orderbook.asks);
        const bestPrice = body.side === "BUY" ? bestAsk : bestBid;

        if (bestPrice == null || !Number.isFinite(bestPrice)) {
          reply.code(502);
          return reply.send({ error: "Missing top-of-book price" });
        }

        if (marketInfo?.accepting_orders === false) {
          reply.code(400);
          return reply.send({ error: "Market is not accepting orders" });
        }

        const slippageBps = body.slippageBps ?? null;
        let price = bestPrice;
        if (slippageBps != null) {
          const multiplier =
            body.side === "BUY"
              ? 1 + slippageBps / 10_000
              : 1 - slippageBps / 10_000;
          price = bestPrice * multiplier;
        }

        const tickSize =
          orderbook.tickSize ??
          (marketInfo?.order_price_min_tick_size != null
            ? Number(marketInfo.order_price_min_tick_size)
            : null);
        const minOrderSize =
          orderbook.minOrderSize ??
          (marketInfo?.order_min_size != null
            ? Number(marketInfo.order_min_size)
            : null);

        if (tickSize != null) {
          price = roundPriceToTick(price, tickSize, body.side);
        }

        if (!Number.isFinite(price) || price <= 0) {
          reply.code(400);
          return reply.send({ error: "Invalid price computed from orderbook" });
        }

        const priceMicro = BigInt(Math.round(price * 1_000_000));
        if (priceMicro <= 0n) {
          reply.code(400);
          return reply.send({ error: "Invalid price computed from orderbook" });
        }

        let sizeMicro: bigint;
        let makerAmountMicro: bigint;
        let takerAmountMicro: bigint;

        if (orderType === "FOK") {
          const shareStep =
            body.side === "SELL"
              ? MARKET_SHARES_MICRO_STEP_2_DEC
              : MARKET_SHARES_MICRO_STEP;
          const usdcStep =
            body.side === "SELL"
              ? MARKET_USD_MICRO_STEP_5_DEC
              : MARKET_USD_MICRO_STEP;
          const precisionProduct = usdcStep * USDC_SCALE;
          const stepForPrice =
            precisionProduct / gcd(priceMicro, precisionProduct);
          const step = lcm(stepForPrice, shareStep);

          if (amountType === "shares") {
            if (amountSharesInput == null) {
              reply.code(400);
              return reply.send({ error: "amount is required for shares quotes" });
            }

            const sizeMicroRaw = BigInt(
              Math.floor(amountSharesInput * 1_000_000),
            );
            sizeMicro = sizeMicroRaw - (sizeMicroRaw % step);

            if (sizeMicro <= 0n) {
              reply.code(400);
              return reply.send({ error: "Amount too small for order" });
            }

            if (body.side === "BUY") {
              makerAmountMicro = (sizeMicro * priceMicro) / USDC_SCALE;
              takerAmountMicro = sizeMicro;
            } else {
              makerAmountMicro = sizeMicro;
              takerAmountMicro = (sizeMicro * priceMicro) / USDC_SCALE;
            }
          } else {
            if (amountUsdInput == null) {
              reply.code(400);
              return reply.send({ error: "amountUsd is required for USD quotes" });
            }

            const amountUsdCents = BigInt(
              Math.floor(amountUsdInput * 100),
            );
            if (amountUsdCents <= 0n) {
              reply.code(400);
              return reply.send({ error: "Invalid amount or price" });
            }

            const makerAmountMicroMax = amountUsdCents * MARKET_USD_MICRO_STEP;
            const sizeMicroRaw =
              (makerAmountMicroMax * USDC_SCALE) / priceMicro;
            if (body.side === "BUY") {
              sizeMicro = sizeMicroRaw - (sizeMicroRaw % shareStep);
              if (sizeMicro <= 0n) {
                reply.code(400);
                return reply.send({ error: "Amount too small for order" });
              }
              makerAmountMicro = makerAmountMicroMax;
              takerAmountMicro = sizeMicro;
            } else {
              sizeMicro = sizeMicroRaw - (sizeMicroRaw % step);
              if (sizeMicro <= 0n) {
                reply.code(400);
                return reply.send({ error: "Amount too small for order" });
              }
              makerAmountMicro = sizeMicro;
              takerAmountMicro = (sizeMicro * priceMicro) / USDC_SCALE;
            }
          }
        } else {
          if (amountType === "shares") {
            reply.code(400);
            return reply.send({
              error: "amountType=shares is only supported for market orders",
            });
          }

          if (amountUsdInput == null) {
            reply.code(400);
            return reply.send({ error: "amountUsd is required for USD quotes" });
          }

          const amountUsdMicro = BigInt(
            Math.floor(amountUsdInput * 1_000_000),
          );

          if (amountUsdMicro <= 0n) {
            reply.code(400);
            return reply.send({ error: "Invalid amount or price" });
          }

          const denom = USDC_SCALE / gcd(priceMicro, USDC_SCALE);
          const sizeMicroRaw = (amountUsdMicro * USDC_SCALE) / priceMicro;
          sizeMicro = sizeMicroRaw - (sizeMicroRaw % denom);

          if (sizeMicro <= 0n) {
            reply.code(400);
            return reply.send({ error: "Amount too small for order" });
          }

          makerAmountMicro =
            body.side === "BUY"
              ? (sizeMicro * priceMicro) / USDC_SCALE
              : sizeMicro;
          takerAmountMicro =
            body.side === "BUY"
              ? sizeMicro
              : (sizeMicro * priceMicro) / USDC_SCALE;
        }

        const violatesMinOrderSize =
          minOrderSize != null
            ? sizeMicro < BigInt(Math.ceil(minOrderSize * 1_000_000))
            : null;

        const size = Number(sizeMicro) / 1_000_000;
        const amountUsdUsed =
          body.side === "BUY"
            ? Number(makerAmountMicro) / 1_000_000
            : Number(takerAmountMicro) / 1_000_000;
        const estimatedPayout = size;
        const estimatedProfit =
          body.side === "BUY"
            ? estimatedPayout - amountUsdUsed
            : amountUsdUsed - estimatedPayout;

        const negRisk =
          orderbook.negRisk ??
          (marketInfo?.neg_risk != null ? Boolean(marketInfo.neg_risk) : null);

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          tokenId,
          side: body.side,
          orderType,
          amountType,
          amountUsd: amountUsdInput ?? undefined,
          amountShares: amountSharesInput ?? undefined,
          amountUsdUsed,
          bestBid,
          bestAsk,
          price,
          size,
          makerAmount: makerAmountMicro.toString(),
          takerAmount: takerAmountMicro.toString(),
          orderPriceMinTickSize: tickSize,
          orderMinSize: minOrderSize,
          violatesMinOrderSize,
          negRisk,
          exchangeAddress: exchangeAddressForNegRisk(negRisk),
          estimatedPayout,
          estimatedProfit,
          slippageBps,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer, body },
          "Failed to quote Polymarket order",
        );
        reply.code(502);
        return reply.send({
          error: "Polymarket quote failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /account
   * Returns a wallet-scoped Polymarket account snapshot (Polygon on-chain reads).
   *
   * Notes:
   * - `X-HUNCH-WALLET` is the signer EOA (selected wallet).
   * - `funder_address` (if set) is used as the on-chain owner for balances/allowances.
   */
  z.get(
    "/account",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket account snapshot requires an EVM wallet address",
        });
      }

      const credsInfo = await AuthService.getVenueCredentialsInfo(
        user.id,
        "polymarket",
        signer,
      );

      const funder = credsInfo?.funderAddress ?? signer;
      const funderSource = credsInfo?.funderAddress ? "credentials" : "signer";

      try {
        const feeCollectorAddress = env.feeCollectorAddress?.trim() || "";
        const negRiskAdapterAddress =
          env.polymarketNegRiskAdapterAddress?.trim() || "";
        const [
          code,
          usdcBalance,
          allowanceExchange,
          allowanceNegRisk,
          okExchange,
          okNegRisk,
          okNegRiskAdapter,
          allowanceNegRiskAdapter,
          allowanceFeeCollector,
          feeCollectorNonce,
        ] = await Promise.all([
            fetchEvmCode({
              rpcUrl: env.polygonRpcUrl,
              timeoutMs: env.polygonRpcTimeoutMs,
              address: funder,
            }),
            fetchErc20BalanceOf({
              rpcUrl: env.polygonRpcUrl,
              timeoutMs: env.polygonRpcTimeoutMs,
              tokenAddress: env.polymarketUsdcAddress,
              owner: funder,
            }),
            fetchErc20Allowance({
              rpcUrl: env.polygonRpcUrl,
              timeoutMs: env.polygonRpcTimeoutMs,
              tokenAddress: env.polymarketUsdcAddress,
              owner: funder,
              spender: env.polymarketExchangeAddress,
            }),
            fetchErc20Allowance({
              rpcUrl: env.polygonRpcUrl,
              timeoutMs: env.polygonRpcTimeoutMs,
              tokenAddress: env.polymarketUsdcAddress,
              owner: funder,
              spender: env.polymarketNegRiskExchangeAddress,
            }),
            fetchErc1155IsApprovedForAll({
              rpcUrl: env.polygonRpcUrl,
              timeoutMs: env.polygonRpcTimeoutMs,
              contractAddress: env.polymarketConditionalTokensAddress,
              owner: funder,
              operator: env.polymarketExchangeAddress,
            }),
            fetchErc1155IsApprovedForAll({
              rpcUrl: env.polygonRpcUrl,
              timeoutMs: env.polygonRpcTimeoutMs,
              contractAddress: env.polymarketConditionalTokensAddress,
              owner: funder,
              operator: env.polymarketNegRiskExchangeAddress,
            }),
            negRiskAdapterAddress
              ? fetchErc1155IsApprovedForAll({
                  rpcUrl: env.polygonRpcUrl,
                  timeoutMs: env.polygonRpcTimeoutMs,
                  contractAddress: env.polymarketConditionalTokensAddress,
                  owner: funder,
                  operator: negRiskAdapterAddress,
                })
              : Promise.resolve(null),
            negRiskAdapterAddress
              ? fetchErc20Allowance({
                  rpcUrl: env.polygonRpcUrl,
                  timeoutMs: env.polygonRpcTimeoutMs,
                  tokenAddress: env.polymarketUsdcAddress,
                  owner: funder,
                  spender: negRiskAdapterAddress,
                })
              : Promise.resolve(null),
            feeCollectorAddress
              ? fetchErc20Allowance({
                  rpcUrl: env.polygonRpcUrl,
                  timeoutMs: env.polygonRpcTimeoutMs,
                  tokenAddress: env.polymarketUsdcAddress,
                  owner: funder,
                  spender: feeCollectorAddress,
                })
              : Promise.resolve(null),
            feeCollectorAddress
              ? fetchFeeCollectorNonce({
                  rpcUrl: env.polygonRpcUrl,
                  timeoutMs: env.polygonRpcTimeoutMs,
                  collectorAddress: feeCollectorAddress,
                  signer,
                })
              : Promise.resolve(null),
          ]);

        const isContract = typeof code === "string" && code.length > 2;

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          venue: "polymarket",
          chainId: 137,
          signer,
          funder,
          funderSource,
          funderUpdatedAt: credsInfo?.funderUpdatedAt ?? null,
          funderIsContract: isContract,
          rpcUrl: env.polygonRpcUrl,
          negRiskAdapterAddress: negRiskAdapterAddress || null,
          usdc: {
            tokenAddress: env.polymarketUsdcAddress,
            decimals: 6,
            balance: ethers.formatUnits(usdcBalance, 6),
            balanceRaw: usdcBalance.toString(),
            allowance: {
              exchange: {
                spender: env.polymarketExchangeAddress,
                allowance: ethers.formatUnits(allowanceExchange, 6),
                allowanceRaw: allowanceExchange.toString(),
              },
              negRiskExchange: {
                spender: env.polymarketNegRiskExchangeAddress,
                allowance: ethers.formatUnits(allowanceNegRisk, 6),
                allowanceRaw: allowanceNegRisk.toString(),
              },
              ...(negRiskAdapterAddress
                ? {
                    negRiskAdapter: {
                      spender: negRiskAdapterAddress,
                      allowance: ethers.formatUnits(
                        allowanceNegRiskAdapter ?? 0n,
                        6,
                      ),
                      allowanceRaw: (allowanceNegRiskAdapter ?? 0n).toString(),
                    },
                  }
                : {}),
              ...(feeCollectorAddress
                ? {
                    feeCollector: {
                      spender: feeCollectorAddress,
                      allowance: ethers.formatUnits(
                        allowanceFeeCollector ?? 0n,
                        6,
                      ),
                      allowanceRaw: (allowanceFeeCollector ?? 0n).toString(),
                    },
                  }
                : {}),
            },
          },
          conditionalTokens: {
            contractAddress: env.polymarketConditionalTokensAddress,
            isApprovedForAll: {
              exchange: okExchange,
              negRiskExchange: okNegRisk,
              ...(negRiskAdapterAddress
                ? { negRiskAdapter: okNegRiskAdapter }
                : {}),
            },
          },
          ...(feeCollectorAddress
            ? {
                feeCollector: {
                  address: feeCollectorAddress,
                  nonce: feeCollectorNonce?.toString() ?? null,
                },
              }
            : {}),
          hasCredentials: Boolean(credsInfo),
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer, funder },
          "Failed to fetch Polymarket account snapshot",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to fetch Polymarket account snapshot",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /orders/sync
   * Fetch open orders from Polymarket CLOB using stored L2 credentials and upsert them into `orders`.
   */
  z.post(
    "/orders/sync",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket orders sync requires an EVM wallet address",
        });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "polymarket",
        signer,
      );
      if (!creds || !creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
        reply.code(400);
        return reply.send({
          error: "Polymarket credentials not found (connect first)",
        });
      }

      // Per CLOB docs, open orders live under `/data/orders` (L2 header required).
      const requestPathAll = "/data/orders";

      const upstream = await polymarketL2Request({
        baseUrl: env.polymarketClobBase,
        timeoutMs: 10_000,
        address: signer,
        creds: {
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          apiPassphrase: creds.apiPassphrase,
        },
        method: "GET",
        requestPath: requestPathAll,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Polymarket orders sync failed",
          status: upstream.status,
          tried: { get: requestPathAll },
          payload: upstream.payload,
        });
      }

      const ordersRaw = extractOrderArray(upstream.payload);

      let storedNew = 0;
      let alreadyKnown = 0;
      let skippedNoId = 0;
      const orderIds: string[] = [];

      for (const o of ordersRaw) {
        const venueOrderId = extractOrderId(o);
        if (!venueOrderId) {
          skippedNoId += 1;
          continue;
        }
        orderIds.push(venueOrderId);

        const tokenId = extractTokenId(o);
        const orderType = isRecord(o) ? extractOrderType(o) : null;
        const sideRaw =
          typeof (o as Record<string, unknown>).side === "string"
            ? ((o as Record<string, unknown>).side as string).toUpperCase()
            : null;
        const side =
          sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : null;

        const result = await storeOrder(pool, {
          userId: user.id,
          walletAddress: signer,
          venue: "polymarket",
          venueOrderId,
          tokenId,
          side,
          orderType: orderType ?? undefined,
          price: null,
          size: null,
          status: "live",
          errorMessage: null,
          rawError: null,
        });

        if (result.kind === "stored") storedNew += 1;
        if (result.kind === "exists") alreadyKnown += 1;
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "polymarket",
        walletAddress: signer,
        fetched: ordersRaw.length,
        storedNew,
        alreadyKnown,
        skippedNoId,
        sampleVenueOrderIds: orderIds.slice(0, 10),
      });
    },
  );

  /**
   * GET /orders/open
   * Fetch open orders directly from Polymarket CLOB (no DB writes).
   */
  z.get(
    "/orders/open",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: polymarketOpenOrdersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket open orders require an EVM wallet address",
        });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "polymarket",
        signer,
      );
      if (!creds || !creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
        reply.code(400);
        return reply.send({
          error: "Polymarket credentials not found (connect first)",
        });
      }

      const query = request.query;
      const params = new URLSearchParams();

      const assetId = query.assetId ?? query.asset_id;
      if (assetId) params.set("asset_id", assetId);
      if (query.market) params.set("market", query.market);
      if (query.id) params.set("id", query.id);

      const requestPath = params.toString().length
        ? `/data/orders?${params.toString()}`
        : "/data/orders";

      const upstream = await polymarketL2Request({
        baseUrl: env.polymarketClobBase,
        timeoutMs: 10_000,
        address: signer,
        creds: {
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          apiPassphrase: creds.apiPassphrase,
        },
        method: "GET",
        requestPath,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Polymarket open orders failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const orders = extractOrderArray(upstream.payload);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "polymarket",
        count: orders.length,
        orders,
      });
    },
  );

  /**
   * POST /order
   * Place a signed Polymarket order using stored L2 credentials.
   */
  z.post(
    "/order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketPlaceOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket order placement requires an EVM wallet address",
        });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "polymarket",
        signer,
      );
      if (!creds || !creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
        reply.code(400);
        return reply.send({
          error: "Polymarket credentials not found (connect first)",
        });
      }

      const body = request.body;
      const order = body.order;

      const orderSigner = typeof order.signer === "string" ? order.signer : "";
      if (normalizeAddress(orderSigner) !== normalizeAddress(signer)) {
        reply.code(400);
        return reply.send({
          error: "Order signer must match the selected wallet",
        });
      }

      const funder = creds.funderAddress ?? signer;
      const maker = typeof order.maker === "string" ? order.maker : "";
      if (normalizeAddress(maker) !== normalizeAddress(funder)) {
        reply.code(400);
        return reply.send({
          error:
            "Order maker does not match the configured Polymarket funder/vault",
        });
      }

      const side = normalizeOrderSide(order.side);
      if (!side) {
        reply.code(400);
        return reply.send({
          error: "Order side must be BUY/SELL (or 0/1)",
        });
      }

      const normalizedOrder = normalizeOrderForPayload(order, side);
      const normalizedForHash = normalizeOrderForHash(order, side);
      const orderPayload = normalizedForHash ?? normalizedOrder;
      const orderType = normalizeOrderTypeForClob(body.orderType);

      const feeAuth = body.feeAuth;
      const feeAuthSig =
        typeof body.feeAuthSig === "string" ? body.feeAuthSig.trim() : "";
      const exchangeAddress =
        (typeof body.exchangeAddress === "string" && body.exchangeAddress) ||
        exchangeAddressForNegRisk(body.negRisk ?? null) ||
        "";
      const feeCollectorAddress =
        (typeof body.feeCollectorAddress === "string" &&
          body.feeCollectorAddress.trim()) ||
        env.feeCollectorAddress?.trim() ||
        "";

      let orderHash: string | null = null;
      let feeBps: number | null = null;
      let feeDeadline: number | null = null;
      let feeAuthStored: Record<string, unknown> | null = null;

      if (feeAuth || feeAuthSig) {
        if (!feeAuth || !feeAuthSig) {
          reply.code(400);
          return reply.send({
            error: "feeAuth and feeAuthSig are both required when using fees",
          });
        }

        if (!feeCollectorAddress) {
          reply.code(400);
          return reply.send({
            error: "Fee collector address is required for fee-auth orders",
          });
        }

        if (
          env.feeCollectorAddress &&
          normalizeAddress(feeCollectorAddress) !==
            normalizeAddress(env.feeCollectorAddress)
        ) {
          reply.code(400);
          return reply.send({
            error: "Fee collector address does not match configured policy",
          });
        }

        if (!exchangeAddress) {
          reply.code(400);
          return reply.send({
            error: "exchangeAddress (or negRisk) is required to hash the order",
          });
        }

        if (!normalizedForHash) {
          reply.code(400);
          return reply.send({
            error: "Order payload is missing required hash fields",
          });
        }

        const computedOrderHash = await fetchPolymarketOrderHash({
          rpcUrl: env.polygonRpcUrl,
          timeoutMs: env.polygonRpcTimeoutMs,
          exchangeAddress,
          order: normalizedForHash,
        });

        const feeAuthSigner =
          typeof feeAuth.signer === "string" ? feeAuth.signer : "";
        const feeAuthVault =
          typeof feeAuth.vault === "string" ? feeAuth.vault : "";
        const feeAuthExchange =
          typeof feeAuth.exchange === "string" ? feeAuth.exchange : "";
        const feeAuthOrderHash =
          typeof feeAuth.orderHash === "string" ? feeAuth.orderHash : "";
        if (normalizeAddress(feeAuthSigner) !== normalizeAddress(orderSigner)) {
          reply.code(400);
          return reply.send({
            error: "feeAuth.signer must match the order signer",
          });
        }
        if (normalizeAddress(feeAuthVault) !== normalizeAddress(maker)) {
          reply.code(400);
          return reply.send({
            error: "feeAuth.vault must match the order maker",
          });
        }
        if (
          normalizeAddress(feeAuthExchange) !== normalizeAddress(exchangeAddress)
        ) {
          reply.code(400);
          return reply.send({
            error: "feeAuth.exchange must match the order exchange",
          });
        }
        if (normalizeHex(feeAuthOrderHash) !== normalizeHex(computedOrderHash)) {
          reply.code(400);
          return reply.send({
            error: "feeAuth.orderHash does not match the computed order hash",
          });
        }

        const feeBpsRaw = parseNumberish(feeAuth.feeBps);
        feeBps = feeBpsRaw != null ? Math.trunc(feeBpsRaw) : null;
        const deadlineRaw = parseNumberish(feeAuth.deadline);
        feeDeadline = deadlineRaw != null ? Math.trunc(deadlineRaw) : null;

        orderHash = computedOrderHash;
        feeAuthStored = {
          signer: feeAuthSigner,
          vault: feeAuthVault,
          exchange: feeAuthExchange,
          orderHash: computedOrderHash,
          feeBps: normalizeNumberishString(feeAuth.feeBps) ?? feeAuth.feeBps,
          nonce: normalizeNumberishString(feeAuth.nonce) ?? feeAuth.nonce,
          deadline: normalizeNumberishString(feeAuth.deadline) ?? feeAuth.deadline,
        };
      }

      const payload = {
        order: normalizedOrder,
        owner: creds.apiKey,
        orderType,
        ...(body.deferExec !== undefined ? { deferExec: body.deferExec } : {}),
      };

      const builderCreds =
        env.polymarketBuilderApiKey &&
        env.polymarketBuilderApiSecret &&
        env.polymarketBuilderApiPassphrase
          ? {
              key: env.polymarketBuilderApiKey,
              secret: env.polymarketBuilderApiSecret,
              passphrase: env.polymarketBuilderApiPassphrase,
            }
          : undefined;

      const upstream = await polymarketL2Request({
        baseUrl: env.polymarketClobBase,
        timeoutMs: 10_000,
        address: signer,
        creds: {
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          apiPassphrase: creds.apiPassphrase,
        },
        builderCreds,
        method: "POST",
        requestPath: "/order",
        body: payload,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Polymarket order placement failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      if (isRecord(upstream.payload) && upstream.payload.success === false) {
        reply.code(400);
        return reply.send({
          error: "Polymarket order rejected",
          payload: upstream.payload,
        });
      }

      const venueOrderId = extractOrderId(upstream.payload);
      if (!venueOrderId) {
        reply.code(502);
        return reply.send({
          error: "Polymarket order placed but no orderId returned",
          payload: upstream.payload,
        });
      }

      const tokenId = extractTokenId(order);
      const { price, size } = derivePriceAndSize(order, side);
      const statusRaw =
        isRecord(upstream.payload) && typeof upstream.payload.status === "string"
          ? upstream.payload.status
          : "submitted";

        const stored = await storeOrder(pool, {
          userId: user.id,
          walletAddress: signer,
          venue: "polymarket",
          venueOrderId,
          tokenId,
          side,
          orderType,
          price,
          size,
          status: statusRaw,
          errorMessage: null,
          rawError: null,
          orderPayload,
          orderHash,
          feeBps,
          feeAuth: feeAuthStored,
          feeAuthSig: feeAuthSig || null,
          feeCollectorAddress: feeAuth ? feeCollectorAddress || null : null,
        feeDeadline,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "polymarket",
        orderId: venueOrderId,
        orderHash,
        stored: stored.kind,
        payload: upstream.payload,
      });
    },
  );

  /**
   * DELETE /order
   * Cancel a Polymarket order by venue order ID.
   */
  z.delete(
    "/order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketCancelOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket cancel requires an EVM wallet address",
        });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "polymarket",
        signer,
      );
      if (!creds || !creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
        reply.code(400);
        return reply.send({
          error: "Polymarket credentials not found (connect first)",
        });
      }

      const upstream = await polymarketL2Request({
        baseUrl: env.polymarketClobBase,
        timeoutMs: 10_000,
        address: signer,
        creds: {
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          apiPassphrase: creds.apiPassphrase,
        },
        method: "DELETE",
        requestPath: "/order",
        body: { orderID: request.body.orderID },
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Polymarket cancel failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      await pool.query(
        `
          update orders
          set status = 'cancelled',
              cancelled_at = now(),
              last_update = now()
          where user_id = $1
            and wallet_address = $2
            and venue = 'polymarket'
            and venue_order_id = $3
        `,
        [user.id, signer, request.body.orderID],
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "polymarket",
        orderId: request.body.orderID,
        payload: upstream.payload,
      });
    },
  );
};
