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
import {
  limitlessAuthLoginBodySchema,
  limitlessCancelBatchBodySchema,
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

export const limitlessPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

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

      const tokenId =
        typeof order.tokenId === "string"
          ? order.tokenId
          : String(order.tokenId ?? "");
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
        venue: "limitless",
        venueOrderId,
        tokenId: tokenId || null,
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
