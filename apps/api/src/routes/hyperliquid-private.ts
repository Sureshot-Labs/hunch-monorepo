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
  canonicalHyperliquidVenueOrderId,
  extractHyperliquidCancelStatus,
  extractHyperliquidOrderStatus,
  fetchHyperliquidSpotState,
  formatHyperliquidDecimal,
  hyperliquidVenueOrderIdAliases,
  hunchTokenIdFromHyperliquidCoin,
  hyperliquidAssetIdFromHunchTokenId,
  hyperliquidCoinFromHunchTokenId,
  hyperliquidInfo,
  makeHyperliquidClientOrderId,
  normalizeHyperliquidUserFills,
  normalizeHyperliquidClientOrderId,
  normalizeHyperliquidExchangeOrderId,
  recoverHyperliquidSigner,
  submitHyperliquidExchangeAction,
  type HyperliquidAction,
  type HyperliquidOrderSide,
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
  metadata: unknown | null;
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

const cancelBaseSchema = zod.object(cancelBaseShape).refine(
  (value) => value.oid != null || value.cloid != null,
  {
    message: "Hyperliquid cancel requires an order id or client order id.",
  },
);

const cancelSubmitSchema = zod
  .object({
    ...cancelBaseShape,
    nonce: zod.number().int().positive(),
    signature: zod.string().min(1),
  })
  .refine((value) => value.oid != null || value.cloid != null, {
    message: "Hyperliquid cancel requires an order id or client order id.",
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

const localNonceByWallet = new Map<string, number>();

function normalizeEvmAddress(value: string): string | null {
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    return null;
  }
}

function ensureTradingEnabled(input: { userId: string; walletAddress: string }) {
  assertHyperliquidTradingAllowed(input);
}

async function reserveHyperliquidNonce(
  userId: string,
  walletAddress: string,
): Promise<number> {
  const normalizedWallet = walletAddress.toLowerCase();
  const base = Math.max(Date.now(), localNonceByWallet.get(normalizedWallet) ?? 0);
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
        id,
        status::text,
        close_time,
        expiration_time,
        token_yes,
        token_no,
        best_bid::text,
        best_ask::text,
        best_bid_yes::text,
        best_ask_yes::text,
        best_bid_no::text,
        best_ask_no::text,
        metadata
      from unified_markets
      where venue = 'hyperliquid'
        and ($1 = token_yes or $1 = token_no)
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

function applySlippage(
  price: number,
  side: HyperliquidOrderSide,
  slippageBps: number,
): number {
  const factor =
    side === "BUY" ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000;
  return Math.min(0.99999, Math.max(0.00001, price * factor));
}

function resolveOrderMath(inputs: {
  market: HyperliquidMarketForTrade;
  tokenSide: "YES" | "NO";
  body: zod.infer<typeof orderBaseSchema>;
  fixedPrice?: number | null;
  fixedSize?: number | null;
}): { price: number; size: number; notionalUsd: number; tif: HyperliquidOrderTif } {
  const tif = inputs.body.orderType === "limit" ? "Gtc" : "Ioc";
  const price =
    inputs.fixedPrice ??
    (inputs.body.orderType === "limit"
      ? inputs.body.price
      : (() => {
          const top = resolveTopPrice(inputs.market, inputs.tokenSide, inputs.body.side);
          if (top == null) return null;
          return applySlippage(
            top,
            inputs.body.side,
            inputs.body.slippageBps ?? env.hyperliquidMarketSlippageBps,
          );
        })());
  if (price == null || !Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error("Hyperliquid market has no usable price for this order.");
  }

  const size =
    inputs.fixedSize ??
    inputs.body.size ??
    (inputs.body.amountUsd != null ? inputs.body.amountUsd / price : null);
  if (size == null || !Number.isFinite(size) || size <= 0) {
    throw new Error("Hyperliquid order size is required.");
  }

  const notionalUsd = price * size;
  if (notionalUsd < env.hyperliquidMinOrderNotionalUsd) {
    throw new Error(
      `Hyperliquid orders must be at least $${env.hyperliquidMinOrderNotionalUsd.toFixed(2)}.`,
    );
  }

  return { price, size, notionalUsd, tif };
}

async function prepareOrderAction(inputs: {
  userId: string;
  walletAddress: string;
  body: zod.infer<typeof orderBaseSchema>;
  nonce?: number;
  cloid?: string | null;
  fixedPrice?: number | null;
  fixedSize?: number | null;
}): Promise<PreparedHyperliquidAction> {
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

  const assetId = hyperliquidAssetIdFromHunchTokenId(inputs.body.tokenId);
  const math = resolveOrderMath({
    market,
    tokenSide,
    body: inputs.body,
    fixedPrice: inputs.fixedPrice,
    fixedSize: inputs.fixedSize,
  });
  const nonce =
    inputs.nonce ?? (await reserveHyperliquidNonce(inputs.userId, signer));
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
      walletAddress: signer,
      tokenId: inputs.body.tokenId,
      nonce,
    });
  const action = buildHyperliquidOrderAction({
    assetId,
    side: inputs.body.side,
    price: math.price,
    size: math.size,
    tif: math.tif,
    reduceOnly: inputs.body.reduceOnly,
    cloid,
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
    price: Number(formatHyperliquidDecimal(math.price, { maxDecimals: 6, maxSigFigs: 5 })),
    size: Number(formatHyperliquidDecimal(math.size, { maxDecimals: 8 })),
    notionalUsd: math.notionalUsd,
    marketId: market.id,
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
    throw new Error("Hyperliquid signature does not match the selected wallet.");
  }
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
      order by created_at desc
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

async function persistHyperliquidOrder(
  inputs: PersistHyperliquidOrderInput,
): Promise<{ id: string; status: string }> {
  const aliases = Array.from(new Set([inputs.venueOrderId, ...inputs.aliases]));
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
    existing && isTerminalOrderStatus(existing.status) && !isTerminalOrderStatus(inputs.status)
      ? existing.status
      : inputs.status;
  const payload = mergeOrderPayload({
    previous: existing?.order_payload ?? null,
    next: inputs.orderPayload,
    key: inputs.orderPayloadVersion === "hyperliquid_info_v1" ? "hyperliquidInfo" : "hyperliquidOrder",
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
        inputs.price,
        inputs.size,
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
      inputs.price,
      inputs.size,
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

function normalizeInfoOrderRows(payload: unknown, fallbackStatus: string): HyperliquidInfoOrderRow[] {
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
    .filter((row): row is HyperliquidInfoOrderRow => Boolean(row?.venueOrderId));
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
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
  if (normalized.includes("open") || normalized.includes("resting")) return "live";
  if (normalized.includes("fill")) return "filled";
  if (normalized.includes("cancel")) return "cancelled";
  if (normalized.includes("reject") || normalized.includes("error")) return "rejected";
  return normalized || "submitted";
}

function normalizeErrorPayload(error: unknown): { message: string; status: number; payload?: unknown } {
  const message = error instanceof Error ? error.message : "Hyperliquid request failed.";
  const responseStatus =
    typeof (error as { responseStatus?: unknown })?.responseStatus === "number"
      ? ((error as { responseStatus: number }).responseStatus ?? 400)
      : null;
  const code = (error as { code?: unknown })?.code;
  return {
    message,
    status:
      code === "hyperliquid_trading_disabled"
      || code === "hyperliquid_trading_not_allowed"
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
        verifySignedPreparedAction(prepared, request.body.signature, walletAddress);
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
    { preHandler: createAuthMiddleware(), schema: { body: cancelSubmitSchema } },
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
        verifySignedPreparedAction(prepared, request.body.signature, walletAddress);
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
            error: cancelStatus.errorMessage ?? "Hyperliquid rejected the cancel request.",
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
            error: "Hyperliquid cancel succeeded but no local order row matched.",
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
        for (const row of rows) {
          if (!row.venueOrderId || !row.tokenId) continue;
          await persistHyperliquidOrder({
            userId: user.id,
            walletAddress,
            signerAddress: walletAddress,
            venueOrderId: row.venueOrderId,
            aliases: hyperliquidVenueOrderIdAliases({
              cloid: row.cloid,
              oid: row.oid,
              venueOrderId: row.venueOrderId,
            }),
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

        let executionsStored = 0;
        for (const fill of normalizeHyperliquidUserFills(fillsPayload)) {
          await storeExecution(pool, {
            userId: user.id,
            walletAddress,
            venue: "hyperliquid",
            unifiedMarketId: null,
            side: fill.side,
            inputMint:
              fill.side === "BUY" ? "hyperliquid:usdc" : fill.tokenId,
            outputMint:
              fill.side === "BUY" ? fill.tokenId : "hyperliquid:usdc",
            amountIn:
              fill.side === "BUY" ? fill.notionalUsd : fill.size,
            amountOut:
              fill.side === "BUY" ? fill.size : fill.notionalUsd,
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
        return reply.send({
          ok: true,
          stored,
          scanned: rows.length,
          executionsStored,
        });
      } catch (error) {
        const normalized = normalizeErrorPayload(error);
        reply.code(normalized.status);
        return reply.send({ error: normalized.message, payload: normalized.payload });
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
        const tokenBalances: WalletTokenBalance[] = state.balances
          .filter((balance) => balance.tokenId && Number(balance.total) > 0)
          .map((balance) => ({
            tokenId: balance.tokenId as string,
            size: balance.total,
            averagePrice:
              balance.entryNtl && Number(balance.total) > 0
                ? String(Number(balance.entryNtl) / Number(balance.total))
                : null,
          }));
        const result = await syncWalletPositionsFromTokenBalances(pool, {
          userId: user.id,
          walletAddress,
          venue: "hyperliquid",
          positionScope: "own",
          tokenBalances,
          tokenIdLike: "hyperliquid:%",
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
        return reply.send({ error: normalized.message, payload: normalized.payload });
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
