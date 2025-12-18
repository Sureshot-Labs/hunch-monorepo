import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";
import { AuthService, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { storeOrder } from "../repos/orders-repo.js";
import { fetchPolymarketMarketInfo } from "../repos/polymarket-markets.js";
import {
  polymarketCancelOrderBodySchema,
  polymarketMarketInfoQuerySchema,
  polymarketOpenOrdersQuerySchema,
  polymarketPlaceOrderBodySchema,
  polymarketQuoteBodySchema,
} from "../schemas/polymarket-private.js";
import {
  fetchErc1155IsApprovedForAll,
  fetchErc20Allowance,
  fetchErc20BalanceOf,
  fetchEvmCode,
} from "../services/polygon-rpc.js";
import { polymarketClient } from "../services/polymarket-client.js";
import {
  extractOrderArray,
  extractOrderId,
  extractTokenId,
  polymarketL2Request,
} from "../services/polymarket-clob-l2.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const POLY_DECIMALS = 6;

type PolymarketSide = "BUY" | "SELL";
type PolymarketOrderType = "GTC" | "GTD" | "FAK" | "FOK";
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

function exchangeAddressForNegRisk(negRisk: boolean | null): string | null {
  if (negRisk == null) return null;
  return negRisk ? env.polymarketNegRiskExchangeAddress : env.polymarketExchangeAddress;
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

  for (const key of [
    "salt",
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

export const polymarketPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /polymarket/market-info
   * Returns Polymarket-specific market constraints and exchange selection.
   */
  z.get(
    "/polymarket/market-info",
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
   * POST /polymarket/quote
   * Returns a price/size preview derived from the current orderbook.
   */
  z.post(
    "/polymarket/quote",
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

      if (!tokenId) {
        reply.code(400);
        return reply.send({ error: "tokenId is required" });
      }

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

        const amountUsdMicro = BigInt(Math.floor(body.amountUsd * 1_000_000));
        const priceMicro = BigInt(Math.round(price * 1_000_000));

        if (amountUsdMicro <= 0n || priceMicro <= 0n) {
          reply.code(400);
          return reply.send({ error: "Invalid amount or price" });
        }

        const denom = USDC_SCALE / gcd(priceMicro, USDC_SCALE);
        const sizeMicroRaw = (amountUsdMicro * USDC_SCALE) / priceMicro;
        const sizeMicro = sizeMicroRaw - (sizeMicroRaw % denom);

        if (sizeMicro <= 0n) {
          reply.code(400);
          return reply.send({ error: "Amount too small for order" });
        }

        if (minOrderSize != null) {
          const minSizeMicro = BigInt(Math.ceil(minOrderSize * 1_000_000));
          if (sizeMicro < minSizeMicro) {
            reply.code(400);
            return reply.send({
              error: "Order size below minimum",
              minOrderSize,
            });
          }
        }

        const makerAmountMicro =
          body.side === "BUY"
            ? (sizeMicro * priceMicro) / USDC_SCALE
            : sizeMicro;
        const takerAmountMicro =
          body.side === "BUY"
            ? sizeMicro
            : (sizeMicro * priceMicro) / USDC_SCALE;

        const size = Number(sizeMicro) / 1_000_000;
        const amountUsdUsed =
          body.side === "BUY"
            ? Number(makerAmountMicro) / 1_000_000
            : Number(takerAmountMicro) / 1_000_000;
        const estimatedPayout = size;
        const estimatedProfit =
          body.side === "BUY" ? estimatedPayout - amountUsdUsed : amountUsdUsed - estimatedPayout;

        const negRisk =
          orderbook.negRisk ??
          (marketInfo?.neg_risk != null ? Boolean(marketInfo.neg_risk) : null);

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          tokenId,
          side: body.side,
          orderType: body.orderType ?? "FAK",
          amountUsd: body.amountUsd,
          amountUsdUsed,
          bestBid,
          bestAsk,
          price,
          size,
          makerAmount: makerAmountMicro.toString(),
          takerAmount: takerAmountMicro.toString(),
          orderPriceMinTickSize: tickSize,
          orderMinSize: minOrderSize,
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
   * GET /polymarket/account
   * Returns a wallet-scoped Polymarket account snapshot (Polygon on-chain reads).
   *
   * Notes:
   * - `X-HUNCH-WALLET` is the signer EOA (selected wallet).
   * - `funder_address` (if set) is used as the on-chain owner for balances/allowances.
   */
  z.get(
    "/polymarket/account",
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
        const [code, usdcBalance, allowanceExchange, allowanceNegRisk, okExchange, okNegRisk] =
          await Promise.all([
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
            },
          },
          conditionalTokens: {
            contractAddress: env.polymarketConditionalTokensAddress,
            isApprovedForAll: {
              exchange: okExchange,
              negRiskExchange: okNegRisk,
            },
          },
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
   * POST /polymarket/orders/sync
   * Fetch open orders from Polymarket CLOB using stored L2 credentials and upsert them into `orders`.
   */
  z.post(
    "/polymarket/orders/sync",
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
      // Some deployments may require filtering by `asset_id`/`market`; we first try "all open orders".
      const requestPathAll = "/data/orders";

      const upstreamAll = await polymarketL2Request({
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

      let upstream = upstreamAll;
      let triedAssetIds: string[] = [];
      if (!upstream.ok && upstream.status === 400) {
        // Fallback: fetch open orders by a candidate set of assetIds (watchlist + existing positions).
        const candidateRows = await pool.query<{ token_id: string }>(
          `
            with watchlist_tokens as (
              select json_array_elements_text(m.clob_token_ids::json) as token_id
              from user_watchlist w
              join unified_markets m
                on m.id = w.market_id
              where w.user_id = $1
                and m.venue = 'polymarket'
                and m.clob_token_ids is not null
                and m.clob_token_ids <> '[]'
            ),
            position_tokens as (
              select token_id
              from positions
              where user_id = $1
                and wallet_address = $2
                and venue = 'polymarket'
            )
            select distinct token_id
            from (
              select token_id from watchlist_tokens
              union all
              select token_id from position_tokens
            ) t
            where token_id is not null
              and token_id <> ''
              and token_id ~ '^[0-9]+$'
            limit 50
          `,
          [user.id, signer],
        );

        const tokenIds = candidateRows.rows
          .map((row) => row.token_id)
          .filter((tokenId): tokenId is string => Boolean(tokenId));
        triedAssetIds = tokenIds;

        const aggregated: unknown[] = [];
        for (const tokenId of tokenIds) {
          const byAsset = await polymarketL2Request({
            baseUrl: env.polymarketClobBase,
            timeoutMs: 10_000,
            address: signer,
            creds: {
              apiKey: creds.apiKey,
              apiSecret: creds.apiSecret,
              apiPassphrase: creds.apiPassphrase,
            },
            method: "GET",
            requestPath: `/data/orders?asset_id=${encodeURIComponent(tokenId)}`,
          });

          if (!byAsset.ok) continue;
          aggregated.push(...extractOrderArray(byAsset.payload));
        }

        upstream = { ok: true, payload: aggregated };
      }

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Polymarket orders sync failed",
          status: upstream.status,
          tried: {
            get: requestPathAll,
            ...(triedAssetIds.length
              ? { assetIdFallback: triedAssetIds.slice(0, 10) }
              : {}),
          },
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
   * GET /polymarket/orders/open
   * Fetch open orders directly from Polymarket CLOB (no DB writes).
   */
  z.get(
    "/polymarket/orders/open",
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
   * POST /polymarket/order
   * Place a signed Polymarket order using stored L2 credentials.
   */
  z.post(
    "/polymarket/order",
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

      const payload = {
        order: normalizedOrder,
        owner: creds.apiKey,
        orderType: body.orderType ?? "GTC",
        ...(body.deferExec !== undefined ? { deferExec: body.deferExec } : {}),
      };

      const upstream = await polymarketL2Request({
        baseUrl: env.polymarketClobBase,
        timeoutMs: 10_000,
        address: signer,
        creds: {
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          apiPassphrase: creds.apiPassphrase,
        },
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
        orderType: body.orderType ?? "GTC",
        price,
        size,
        status: statusRaw,
        errorMessage: null,
        rawError: null,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "polymarket",
        orderId: venueOrderId,
        stored: stored.kind,
        payload: upstream.payload,
      });
    },
  );

  /**
   * DELETE /polymarket/order
   * Cancel a Polymarket order by venue order ID.
   */
  z.delete(
    "/polymarket/order",
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
