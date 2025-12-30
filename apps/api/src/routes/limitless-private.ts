import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";
import { AuthService, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { storeOrder } from "../repos/orders-repo.js";
import { fetchEvmCode } from "../services/polygon-rpc.js";
import { fetchLimitlessOnchainSnapshot } from "../services/limitless-onchain.js";
import {
  extractLimitlessMessage,
  limitlessRequest,
} from "../services/limitless-client.js";
import { recomputePositionMetricsForWallet } from "../services/positions-metrics.js";
import {
  syncLimitlessHistoryForWallet,
} from "../services/limitless-history.js";
import {
  limitlessAuthLoginBodySchema,
  limitlessCancelBatchBodySchema,
  limitlessHistoryQuerySchema,
  limitlessOpenOrdersQuerySchema,
  limitlessOrderBodySchema,
  limitlessOrderIdParamsSchema,
  limitlessSlugParamsSchema,
} from "../schemas/limitless-private.js";

type LimitlessProfile = {
  id?: number;
  account?: string;
  client?: string;
  rank?: { feeRateBps?: number; name?: string };
};

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
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

function normalizeOrderSide(value: unknown): "BUY" | "SELL" | null {
  if (typeof value === "string") {
    const trimmed = value.trim().toUpperCase();
    if (trimmed === "BUY" || trimmed === "SELL") return trimmed;
    if (trimmed === "0") return "BUY";
    if (trimmed === "1") return "SELL";
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 0) return "BUY";
    if (value === 1) return "SELL";
  }
  return null;
}

function extractProfile(value: unknown): LimitlessProfile | null {
  if (!isRecord(value)) return null;
  const profileRaw = isRecord(value.profile) ? value.profile : value;
  if (!isRecord(profileRaw)) return null;
  const id = typeof profileRaw.id === "number" ? profileRaw.id : null;
  const account =
    typeof profileRaw.account === "string" ? profileRaw.account : null;
  const client =
    typeof profileRaw.client === "string" ? profileRaw.client : null;
  const rankRaw = isRecord(profileRaw.rank) ? profileRaw.rank : null;
  const rank = rankRaw
    ? {
        feeRateBps:
          typeof rankRaw.feeRateBps === "number"
            ? rankRaw.feeRateBps
            : undefined,
        name: typeof rankRaw.name === "string" ? rankRaw.name : undefined,
      }
    : undefined;
  return {
    ...(id != null ? { id } : {}),
    ...(account ? { account } : {}),
    ...(client ? { client } : {}),
    ...(rank ? { rank } : {}),
  };
}

function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

function isEvmWallet(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function deriveSize(
  orderType: string,
  side: "BUY" | "SELL" | null,
  makerAmount: number | null,
  takerAmount: number | null,
): number | null {
  if (!side) return null;
  if (orderType !== "GTC") return null;
  const shares = side === "BUY" ? takerAmount : makerAmount;
  if (shares == null) return null;
  return shares / 1_000_000;
}

function readOrderField(
  record: Record<string, unknown>,
  keys: string[],
): unknown | null {
  for (const key of keys) {
    if (record[key] != null) return record[key];
  }
  if (isRecord(record.order)) {
    for (const key of keys) {
      if (record.order[key] != null) return record.order[key];
    }
  }
  return null;
}

function extractLimitlessOrders(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  if (isRecord(payload)) {
    const collection =
      payload.orders ?? payload.data ?? payload.items ?? payload.results;
    if (Array.isArray(collection)) {
      return collection.filter(isRecord);
    }
    if (isRecord(collection)) {
      return [collection];
    }
    if (payload.id || payload.orderId || payload.order_id) {
      return [payload];
    }
  }
  return [];
}

function normalizeOrderId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString();
  }
  return null;
}

function normalizeLimitlessTokenId(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("limitless:") ? trimmed : `limitless:${trimmed}`;
}

function extractLimitlessOrderId(record: Record<string, unknown>): string | null {
  return normalizeOrderId(readOrderField(record, ["id", "orderId", "order_id"]));
}

function extractLimitlessTokenId(
  record: Record<string, unknown>,
): string | null {
  const raw = normalizeOrderId(
    readOrderField(record, ["tokenId", "token_id", "outcomeTokenId"]),
  );
  return normalizeLimitlessTokenId(raw);
}

function extractLimitlessOrderSide(
  record: Record<string, unknown>,
): "BUY" | "SELL" | null {
  return normalizeOrderSide(readOrderField(record, ["side", "orderSide"]));
}

function extractLimitlessOrderType(
  record: Record<string, unknown>,
): "GTC" | "FOK" | null {
  const value = readOrderField(record, ["orderType", "type"]);
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    if (upper === "GTC" || upper === "FOK") return upper;
  }
  return null;
}

function extractLimitlessOrderStatus(record: Record<string, unknown>): string {
  const value = readOrderField(record, ["status", "orderStatus"]);
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim().toLowerCase();
    if (normalized === "open" || normalized === "active" || normalized === "live") {
      return "live";
    }
    if (normalized === "cancelled" || normalized === "canceled") {
      return "cancelled";
    }
    if (normalized === "filled" || normalized === "complete") {
      return "filled";
    }
    return normalized;
  }
  return "live";
}

function extractLimitlessCanceledIds(
  payload: unknown,
  fallback: string[],
): string[] {
  if (!isRecord(payload)) return fallback;
  const candidates =
    payload.canceled ??
    payload.cancelled ??
    payload.canceledOrders ??
    payload.cancelledOrders;
  if (!Array.isArray(candidates)) return fallback;
  const ids = candidates
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (isRecord(entry)) {
        return normalizeOrderId(
          entry.orderId ?? entry.order_id ?? entry.id ?? null,
        );
      }
      return null;
    })
    .filter((entry): entry is string => Boolean(entry));
  return ids.length ? ids : fallback;
}

export const limitlessPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  const resolveWalletAddresses = async (
    userId: string,
    walletAddress: string | undefined,
    requestedWallets: string[] | undefined,
  ): Promise<string[]> => {
    if (requestedWallets && requestedWallets.length) {
      const wallets = await AuthService.getUserWallets(userId);
      const walletMap = new Map(
        wallets.map((wallet) => [
          wallet.walletAddress.toLowerCase(),
          wallet.walletAddress,
        ]),
      );
      const resolved = requestedWallets
        .map((address) => address.trim().toLowerCase())
        .map((address) => walletMap.get(address))
        .filter((address): address is string => Boolean(address));
      return Array.from(new Set(resolved));
    }

    if (!walletAddress) return [];
    return [walletAddress];
  };

  /**
   * GET /auth/signing-message
   */
  z.get(
    "/auth/signing-message",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: "/auth/signing-message",
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless signing message failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const message = extractLimitlessMessage(upstream.payload);
      if (!message) {
        reply.code(502);
        return reply.send({
          error: "Limitless signing message invalid",
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, message });
    },
  );

  /**
   * POST /auth/login
   */
  z.post(
    "/auth/login",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessAuthLoginBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless login requires an EVM wallet address",
        });
      }

      const body = request.body;

      const headerAccount = getHeaderValue(request.headers, "x-account");
      const headerMessage = getHeaderValue(request.headers, "x-signing-message");
      const headerSignature = getHeaderValue(request.headers, "x-signature");

      const account = headerAccount ?? body.account;
      const signingMessage = headerMessage ?? body.signingMessage;
      const signature = headerSignature ?? body.signature;

      if (!account || !signingMessage || !signature) {
        reply.code(400);
        return reply.send({
          error: "Missing x-account, x-signing-message, or x-signature",
        });
      }

      if (normalizeAddress(account) !== normalizeAddress(signer)) {
        reply.code(400);
        return reply.send({
          error: "x-account must match the selected wallet",
        });
      }

      const referralCode =
        (typeof body.referralCode === "string" && body.referralCode.trim()) ||
        (typeof body.r === "string" && body.r.trim()) ||
        undefined;

      const upstream = await limitlessRequest({
        method: "POST",
        requestPath: "/auth/login",
        headers: {
          "x-account": account,
          "x-signing-message": signingMessage,
          "x-signature": signature,
        },
        body: {
          client: body.client ?? "eoa",
          ...(body.smartWallet ? { smartWallet: body.smartWallet } : {}),
          ...(referralCode ? { r: referralCode } : {}),
        },
        captureSessionCookie: true,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless login failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const sessionCookie = upstream.sessionCookie;
      if (!sessionCookie) {
        reply.code(502);
        return reply.send({
          error: "Limitless login did not return a session cookie",
          payload: upstream.payload,
        });
      }

      const profile = extractProfile(upstream.payload);
      const profileSafe: LimitlessProfile | null = profile
        ? profile
        : { account };

      try {
        await AuthService.createOrUpdateVenueCredentials(
          user.id,
          signer,
          "limitless",
          profileSafe?.account ?? account,
          sessionCookie,
          profileSafe ? { profile: profileSafe } : undefined,
        );
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to store Limitless credentials",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to store Limitless credentials",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        profile: profileSafe,
      });
    },
  );

  /**
   * GET /auth/verify
   */
  z.get(
    "/auth/verify",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({ error: "Limitless session not found" });
      }

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: "/auth/verify-auth",
        sessionCookie,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless verify failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        account: upstream.payload,
      });
    },
  );

  /**
   * POST /auth/logout
   */
  z.post(
    "/auth/logout",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({ error: "Limitless session not found" });
      }

      const upstream = await limitlessRequest({
        method: "POST",
        requestPath: "/auth/logout",
        sessionCookie,
        body: {},
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless logout failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );

  /**
   * GET /account
   * Returns a wallet-scoped Limitless account snapshot (Base on-chain reads).
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

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless account snapshot requires an EVM wallet address",
        });
      }

      const credsInfo = await AuthService.getVenueCredentialsInfo(
        user.id,
        "limitless",
        signer,
      );
      const profile = extractProfile(credsInfo?.additionalData ?? null);

      try {
        const [code, snapshot] = await Promise.all([
          fetchEvmCode({
            rpcUrl: env.baseRpcUrl,
            timeoutMs: env.baseRpcTimeoutMs,
            address: signer,
          }),
          fetchLimitlessOnchainSnapshot({
            rpcUrl: env.baseRpcUrl,
            timeoutMs: env.baseRpcTimeoutMs,
            owner: signer,
            clobAddress: env.limitlessClobAddress,
            negRiskAddress: env.limitlessNegRiskAddress,
          }),
        ]);

        const usdcBalance = snapshot.usdcBalance;
        const allowanceClob = snapshot.allowanceClob;
        const allowanceNegRisk = snapshot.allowanceNegRisk;

        const isContract = typeof code === "string" && code.length > 2;

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          venue: "limitless",
          chainId: 8453,
          signer,
          signerIsContract: isContract,
          rpcUrl: env.baseRpcUrl,
          usdc: {
            tokenAddress: env.limitlessUsdcAddress,
            decimals: 6,
            balance: ethers.formatUnits(usdcBalance, 6),
            balanceRaw: usdcBalance.toString(),
            allowance: {
              ...(env.limitlessClobAddress
                ? {
                    clob: {
                      spender: env.limitlessClobAddress,
                      allowance: ethers.formatUnits(allowanceClob ?? 0n, 6),
                      allowanceRaw: (allowanceClob ?? 0n).toString(),
                    },
                  }
                : {}),
              ...(env.limitlessNegRiskAddress
                ? {
                    negRisk: {
                      spender: env.limitlessNegRiskAddress,
                      allowance: ethers.formatUnits(allowanceNegRisk ?? 0n, 6),
                      allowanceRaw: (allowanceNegRisk ?? 0n).toString(),
                    },
                  }
                : {}),
            },
          },
          profile: profile ?? null,
          hasCredentials: Boolean(credsInfo),
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to fetch Limitless account snapshot",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to fetch Limitless account snapshot",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /order
   */
  z.post(
    "/order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless order requires an EVM wallet address",
        });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      const profile = extractProfile(creds?.additionalData ?? null);
      const ownerId = request.body.ownerId ?? profile?.id;
      if (!ownerId) {
        reply.code(400);
        return reply.send({
          error: "Limitless ownerId not available (connect first)",
        });
      }

      const order = request.body.order;
      const orderSigner =
        typeof order.signer === "string" ? order.signer : "";
      if (normalizeAddress(orderSigner) !== normalizeAddress(signer)) {
        reply.code(400);
        return reply.send({
          error: "Order signer must match the selected wallet",
        });
      }

      const maker = typeof order.maker === "string" ? order.maker : "";
      if (normalizeAddress(maker) !== normalizeAddress(signer)) {
        reply.code(400);
        return reply.send({
          error: "Order maker must match the selected wallet",
        });
      }

      const side = normalizeOrderSide(order.side);
      if (!side) {
        reply.code(400);
        return reply.send({
          error: "Order side must be BUY/SELL (or 0/1)",
        });
      }

      const orderPayload = {
        order: request.body.order,
        orderType: request.body.orderType,
        marketSlug: request.body.marketSlug,
        ownerId,
      };

      const upstream = await limitlessRequest({
        method: "POST",
        requestPath: "/orders",
        sessionCookie,
        body: orderPayload,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless order placement failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const venueOrderId =
        (isRecord(upstream.payload) &&
          isRecord(upstream.payload.order) &&
          typeof upstream.payload.order.id === "string" &&
          upstream.payload.order.id) ||
        null;

      if (!venueOrderId) {
        reply.code(502);
        return reply.send({
          error: "Limitless order placed but no orderId returned",
          payload: upstream.payload,
        });
      }

      const tokenId = normalizeLimitlessTokenId(
        typeof order.tokenId === "string"
          ? order.tokenId
          : String(order.tokenId ?? ""),
      );
      const makerAmount = parseNumberish(order.makerAmount);
      const takerAmount = parseNumberish(order.takerAmount);
      const price = parseNumberish(order.price);
      const size = deriveSize(request.body.orderType, side, makerAmount, takerAmount);
      const status =
        (isRecord(upstream.payload) &&
          isRecord(upstream.payload.order) &&
          typeof upstream.payload.order.status === "string" &&
          upstream.payload.order.status) ||
        "submitted";

      await storeOrder(pool, {
        userId: user.id,
        walletAddress: signer,
        signerAddress: signer,
        venue: "limitless",
        venueOrderId,
        tokenId: tokenId ?? null,
        side,
        orderType: request.body.orderType,
        price,
        size,
        status,
        errorMessage: null,
        rawError: null,
        orderPayload,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        orderId: venueOrderId,
        payload: upstream.payload,
      });
    },
  );

  /**
   * POST /orders/sync
   * Fetch open orders from Limitless and upsert them into `orders`.
   */
  z.post(
    "/orders/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessOpenOrdersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: `/markets/${encodeURIComponent(
          request.query.slug,
        )}/user-orders`,
        sessionCookie,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless orders sync failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const ordersRaw = extractLimitlessOrders(upstream.payload);
      let storedNew = 0;
      let alreadyKnown = 0;
      let skippedNoId = 0;
      const orderIds: string[] = [];

      for (const order of ordersRaw) {
        const venueOrderId = extractLimitlessOrderId(order);
        if (!venueOrderId) {
          skippedNoId += 1;
          continue;
        }
        orderIds.push(venueOrderId);

        const tokenId = extractLimitlessTokenId(order);
        const side = extractLimitlessOrderSide(order);
        const orderType = extractLimitlessOrderType(order);
        const status = extractLimitlessOrderStatus(order);

        const result = await storeOrder(pool, {
          userId: user.id,
          walletAddress: signer,
          signerAddress: signer,
          venue: "limitless",
          venueOrderId,
          tokenId: tokenId ?? null,
          side,
          orderType: orderType ?? undefined,
          price: null,
          size: null,
          status,
          errorMessage: null,
          rawError: null,
        });

        if (result.kind === "stored") storedNew += 1;
        if (result.kind === "exists") alreadyKnown += 1;
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "limitless",
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
   * POST /orders/history/sync
   * Fetch portfolio history from Limitless and upsert into `orders`.
   */
  z.post(
    "/orders/history/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessHistoryQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const walletAddresses = await resolveWalletAddresses(
        user.id,
        signer,
        query.wallets,
      );

      if (walletAddresses.length === 0) {
        reply.code(400);
        return reply.send({ error: "No wallets available to sync." });
      }

      const results: Array<{
        walletAddress: string;
        status: "ok" | "error" | "skipped";
        fetched?: number;
        storedNew?: number;
        alreadyKnown?: number;
        skippedNoId?: number;
        skippedNoSide?: number;
        skippedNoOutcome?: number;
        skippedNoMarket?: number;
        skippedNoToken?: number;
        error?: string;
        sampleVenueOrderIds?: string[];
      }> = [];

      let synced = 0;
      let skipped = 0;
      let errors = 0;

      for (const wallet of walletAddresses) {
        if (!isEvmWallet(wallet)) {
          skipped += 1;
          results.push({
            walletAddress: wallet,
            status: "skipped",
            error: "EVM wallet required for Limitless.",
          });
          continue;
        }

        const creds = await AuthService.getVenueCredentials(
          user.id,
          "limitless",
          wallet,
        );
        const sessionCookie = creds?.apiSecret?.trim();
        if (!sessionCookie) {
          errors += 1;
          results.push({
            walletAddress: wallet,
            status: "error",
            error: "Limitless session not found (connect first).",
          });
          continue;
        }

        let stats;
        try {
          stats = await syncLimitlessHistoryForWallet(pool, {
            userId: user.id,
            walletAddress: wallet,
            sessionCookie,
            page: query.page,
            limit: query.limit,
            from: query.from,
            to: query.to,
          });
        } catch (error) {
          errors += 1;
          results.push({
            walletAddress: wallet,
            status: "error",
            error:
              error instanceof Error
                ? error.message
                : "Limitless history sync failed.",
          });
          continue;
        }

        try {
          await recomputePositionMetricsForWallet(pool, {
            userId: user.id,
            walletAddress: wallet,
            venue: "limitless",
          });
        } catch (error) {
          app.log.error(
            { error, userId: user.id, walletAddress: wallet },
            "Limitless position metrics update failed",
          );
        }

        synced += 1;
        results.push({
          walletAddress: wallet,
          status: "ok",
          fetched: stats.fetched,
          storedNew: stats.storedNew,
          alreadyKnown: stats.alreadyKnown,
          skippedNoId: stats.skippedNoId,
          skippedNoSide: stats.skippedNoSide,
          skippedNoOutcome: stats.skippedNoOutcome,
          skippedNoMarket: stats.skippedNoMarket,
          skippedNoToken: stats.skippedNoToken,
          sampleVenueOrderIds: stats.sampleVenueOrderIds,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "limitless",
        page: query.page,
        limit: query.limit,
        results,
        summary: {
          synced,
          skipped,
          errors,
        },
      });
    },
  );

  /**
   * GET /orders/:orderId
   */
  z.get(
    "/orders/:orderId",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: limitlessOrderIdParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: `/orders/${request.params.orderId}`,
        sessionCookie,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless order fetch failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );

  /**
   * DELETE /order/:orderId
   */
  z.delete(
    "/order/:orderId",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: limitlessOrderIdParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      const upstream = await limitlessRequest({
        method: "DELETE",
        requestPath: `/orders/${request.params.orderId}`,
        sessionCookie,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless cancel failed",
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
            and (wallet_address = $2 or signer_address = $2)
            and venue = 'limitless'
            and venue_order_id = $3
        `,
        [user.id, signer, request.params.orderId],
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );

  /**
   * POST /orders/cancel-batch
   */
  z.post(
    "/orders/cancel-batch",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessCancelBatchBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      const upstream = await limitlessRequest({
        method: "POST",
        requestPath: "/orders/cancel-batch",
        sessionCookie,
        body: { orderIds: request.body.orderIds },
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless cancel batch failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const cancelledIds = extractLimitlessCanceledIds(
        upstream.payload,
        request.body.orderIds,
      );
      if (cancelledIds.length) {
        await pool.query(
          `
            update orders
            set status = 'cancelled',
                cancelled_at = now(),
                last_update = now()
            where user_id = $1
              and (wallet_address = $2 or signer_address = $2)
              and venue = 'limitless'
              and venue_order_id = ANY($3::text[])
          `,
          [user.id, signer, cancelledIds],
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );

  /**
   * DELETE /orders/all/:slug
   */
  z.delete(
    "/orders/all/:slug",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: limitlessSlugParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      let openOrderIds: string[] = [];
      const openOrders = await limitlessRequest({
        method: "GET",
        requestPath: `/markets/${encodeURIComponent(
          request.params.slug,
        )}/user-orders`,
        sessionCookie,
      });
      if (openOrders.ok) {
        openOrderIds = extractLimitlessOrders(openOrders.payload)
          .map((order) => extractLimitlessOrderId(order))
          .filter((orderId): orderId is string => Boolean(orderId));
      } else {
        app.log.warn(
          {
            status: openOrders.status,
            payload: openOrders.payload,
            slug: request.params.slug,
          },
          "Limitless cancel all: failed to fetch open orders",
        );
      }

      const upstream = await limitlessRequest({
        method: "DELETE",
        requestPath: `/orders/all/${request.params.slug}`,
        sessionCookie,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless cancel all failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const cancelledIds = extractLimitlessCanceledIds(
        upstream.payload,
        openOrderIds,
      );
      if (cancelledIds.length) {
        await pool.query(
          `
            update orders
            set status = 'cancelled',
                cancelled_at = now(),
                last_update = now()
            where user_id = $1
              and (wallet_address = $2 or signer_address = $2)
              and venue = 'limitless'
              and venue_order_id = ANY($3::text[])
          `,
          [user.id, signer, cancelledIds],
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );

  /**
   * GET /orders/open
   */
  z.get(
    "/orders/open",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessOpenOrdersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: `/markets/${request.query.slug}/user-orders`,
        sessionCookie,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless open orders failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );
};
