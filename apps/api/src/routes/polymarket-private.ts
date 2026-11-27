import type {
  FastifyBaseLogger,
  FastifyPluginAsync,
  RouteShorthandOptions,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { stableOpaqueId } from "../account-value/canonical.js";
import { pool } from "../db.js";
import { getRedis } from "../redis.js";
import {
  polymarketBalanceAllowanceSyncBodySchema,
  polymarketDirectAttemptParams,
  polymarketDirectAttemptAuthError,
  polymarketDirectAttemptResponse,
  polymarketCancelOrderBodySchema,
  polymarketFunderDeriveBatchBodySchema,
  polymarketAccountQuerySchema,
  polymarketRedemptionPlanQuerySchema,
  polymarketEmbeddedEnsureReadyBodySchema,
  polymarketEmbeddedEnsureReadyExecuteBodySchema,
  polymarketEmbeddedSignFeeAuthBodySchema,
  polymarketEmbeddedSignOrderBodySchema,
  polymarketEmbeddedSignTypedDataBodySchema,
  polymarketFunderDeriveQuerySchema,
  polymarketMarketInfoQuerySchema,
  polymarketOrderHashBodySchema,
  polymarketOrderParamsQuerySchema,
  polymarketOrdersSyncBodySchema,
  polymarketOpenOrdersQuerySchema,
  polymarketPlaceOrderBodySchema,
  polymarketQuoteBodySchema,
  polymarketMaxSpendBodySchema,
} from "../schemas/polymarket-private.js";
import {
  buildPolymarketOrderParamsRoute,
  buildPolymarketRedemptionPlanRoute,
  cancelPolymarketOrderRoute,
  computePolymarketMaxSpendRoute,
  computePolymarketOrderHashRoute,
  derivePolymarketFundersBatchRoute,
  derivePolymarketFundersRoute,
  executeEmbeddedPolymarketEnsureReadyRoute,
  executeEmbeddedPolymarketOrderSignatureRoute,
  executeEmbeddedPolymarketTypedDataSignatureRoute,
  fetchPolymarketMarketInfoRoute,
  fetchPolymarketAccountRoute,
  fetchPolymarketOpenOrdersRoute,
  prepareEmbeddedPolymarketEnsureReadyRoute,
  prepareEmbeddedPolymarketOrderSignatureRoute,
  prepareEmbeddedPolymarketTypedDataSignatureRoute,
  quotePolymarketOrderRoute,
  submitPolymarketHttpOrder,
  getPolymarketDirectFokStatus,
  syncPolymarketBalanceAllowanceRoute,
  syncPolymarketOrdersRoute,
} from "../services/polymarket-trading-execution-service.js";
import { matchesTelegramAppHandoffV2CurrentScope } from "../services/telegram-bot-trading.js";
import { TradingServiceError } from "../services/trading-errors.js";

export function polymarketOrderSubmitLogger(
  log: FastifyBaseLogger,
  userId: string,
  operationId: string | undefined,
): FastifyBaseLogger {
  const serializeError = (error: unknown) =>
    error instanceof TradingServiceError
      ? { code: error.code, status: error.statusCode }
      : { code: "polymarket_submit_interrupted" };
  return log.child(
    {
      stage: "polymarket_order_submit",
      accountKey: stableOpaqueId("trade", userId),
      operationId,
    },
    {
      serializers: { err: serializeError, error: serializeError },
      redact: {
        paths: [
          "userId",
          "signer",
          "funder",
          "walletAddress",
          "tokenId",
          "orderHash",
          "upstreamMessage",
          "upstreamPayload",
          "input",
          "conditionId",
          "txHash",
          "sourceId",
          "orderId",
        ],
        remove: true,
      },
    },
  );
}

type WalletReadPath = "/account" | "/funder-derive";

function walletReadResultCode(path: WalletReadPath, status: number): string {
  if (status >= 200 && status < 300) return "wallet_read_ok";
  if (status === 400) return "wallet_read_invalid_request";
  if (status === 401) return "wallet_read_unauthorized";
  if (status === 403) return "wallet_not_linked";
  if (status === 429) return "wallet_read_rate_limited";
  if (status === 504) return "wallet_read_timeout";
  if (path === "/account" && status === 502)
    return "account_snapshot_unavailable";
  return status >= 500 ? "wallet_read_interrupted" : "wallet_read_rejected";
}

function polymarketWalletReadLogging(
  path: WalletReadPath,
): Pick<
  RouteShorthandOptions,
  "childLoggerFactory" | "onSend" | "preHandler" | "onResponse"
> {
  const stage =
    path === "/account" ? "polymarket_account" : "polymarket_funder_derive";
  const serializeError = (error: unknown) =>
    error instanceof TradingServiceError
      ? { code: error.code, status: error.statusCode }
      : { code: "wallet_read_interrupted" };
  return {
    // Install before Fastify logs the inbound URL, whose query can include
    // a signer or funder. Both regular and error logging keep reqId.
    childLoggerFactory: (logger, bindings, opts, rawRequest) =>
      logger.child(
        { ...bindings, stage },
        {
          ...opts,
          serializers: {
            ...opts.serializers,
            req: () => ({
              method: rawRequest.method === "HEAD" ? "HEAD" : "GET",
              url: `/trade/polymarket${path}`,
            }),
            err: serializeError,
            error: serializeError,
          },
          redact: {
            paths: [
              "userId",
              "signer",
              "funder",
              "sessionAgent",
              "requestAgent",
            ],
            remove: true,
          },
        },
      ),
    onSend: async (request, reply) => {
      reply.header("x-hunch-request-id", request.id);
    },
    preHandler: createAuthMiddleware({
      accountLogKey: (userId) => stableOpaqueId("trade", userId),
    }),
    onResponse: async (request, reply) => {
      request.log.info(
        {
          status: reply.statusCode,
          code: walletReadResultCode(path, reply.statusCode),
          durationMs: Math.round(reply.elapsedTime),
        },
        "Polymarket wallet read completed",
      );
    },
  };
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

      const result = await fetchPolymarketMarketInfoRoute({
        log: request.log,
        pool,
        query: request.query,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
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

      const result = await buildPolymarketOrderParamsRoute({
        pool,
        query: request.query,
        signer,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
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
      const result = await computePolymarketOrderHashRoute({
        body,
        log: request.log,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * GET /funder-derive
   * Returns candidate Polymarket funder/vault addresses for the selected signer.
   */
  z.get(
    "/funder-derive",
    {
      ...polymarketWalletReadLogging("/funder-derive"),
      schema: { querystring: polymarketFunderDeriveQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await derivePolymarketFundersRoute({
        authenticatedWalletAddress: request.walletAddress,
        query: request.query,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      const { candidates, recommended, warnings } = result.payload;
      request.log = request.log.child({
        candidateCount: Array.isArray(candidates)
          ? candidates.length
          : undefined,
        hasRecommendedFunder: recommended != null,
        warningCount: Array.isArray(warnings) ? warnings.length : undefined,
      });
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * POST /funder-derive/batch
   * Returns candidate Polymarket funder/vault addresses for multiple signers.
   */
  z.post(
    "/funder-derive/batch",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketFunderDeriveBatchBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await derivePolymarketFundersBatchRoute({
        body: request.body,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
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

      const result = await quotePolymarketOrderRoute({
        body: request.body,
        log: request.log,
        pool,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * POST /max-spend
   * Returns the largest market BUY FOK USD amount executable with current funds.
   */
  z.post(
    "/max-spend",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketMaxSpendBodySchema },
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
          error: "Polymarket max spend requires an EVM wallet address",
        });
      }

      const result = await computePolymarketMaxSpendRoute({
        body: request.body,
        log: request.log,
        pool,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
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
    {
      ...polymarketWalletReadLogging("/account"),
      schema: { querystring: polymarketAccountQuerySchema },
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
          error: "Polymarket account snapshot requires an EVM wallet address",
        });
      }

      const result = await fetchPolymarketAccountRoute({
        log: request.log,
        query: request.query,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      const { funderSource, funderIsContract, hasCredentials, protocolV2 } =
        result.payload;
      request.log = request.log.child({
        funderSource:
          funderSource === "query" ||
          funderSource === "credentials" ||
          funderSource === "signer"
            ? funderSource
            : undefined,
        funderIsContract:
          typeof funderIsContract === "boolean" ? funderIsContract : undefined,
        hasCredentials:
          typeof hasCredentials === "boolean" ? hasCredentials : undefined,
        hasProtocolV2Snapshot: protocolV2 != null,
      });
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  z.get(
    "/redemption-plan",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: polymarketRedemptionPlanQuerySchema },
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
          error: "Polymarket redemption requires an EVM wallet address",
        });
      }

      const result = await buildPolymarketRedemptionPlanRoute({
        log: request.log,
        pool,
        query: request.query,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  z.post(
    "/embedded/ensure-ready/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketEmbeddedEnsureReadyBodySchema },
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
          error:
            "Embedded Polymarket automation requires an EVM wallet address",
        });
      }

      const result = await prepareEmbeddedPolymarketEnsureReadyRoute({
        body: request.body,
        log: request.log,
        signer,
        user,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  z.post(
    "/embedded/ensure-ready/execute",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketEmbeddedEnsureReadyExecuteBodySchema },
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
          error:
            "Embedded Polymarket automation requires an EVM wallet address",
        });
      }

      const result = await executeEmbeddedPolymarketEnsureReadyRoute({
        body: request.body,
        log: request.log,
        redis: await getRedis(),
        signer,
        user,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  z.post(
    "/embedded/sign-order/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        body: polymarketEmbeddedSignOrderBodySchema.omit({
          authorizationSignature: true,
        }),
      },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await prepareEmbeddedPolymarketOrderSignatureRoute({
        body: request.body,
        signer,
        user,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  z.post(
    "/embedded/sign-order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketEmbeddedSignOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await executeEmbeddedPolymarketOrderSignatureRoute({
        body: request.body,
        signer,
        user,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  z.post(
    "/embedded/sign-fee-auth/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        body: polymarketEmbeddedSignFeeAuthBodySchema.omit({
          authorizationSignature: true,
        }),
      },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      reply.code(410);
      return reply.send({
        error:
          "Polymarket fee-auth signing is disabled; configure builder fees or submit without a Hunch fee.",
      });
    },
  );

  z.post(
    "/embedded/sign-fee-auth",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketEmbeddedSignFeeAuthBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      reply.code(410);
      return reply.send({
        error:
          "Polymarket fee-auth signing is disabled; configure builder fees or submit without a Hunch fee.",
      });
    },
  );

  z.post(
    "/embedded/sign-typed-data/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        body: polymarketEmbeddedSignTypedDataBodySchema.omit({
          authorizationSignature: true,
        }),
      },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await prepareEmbeddedPolymarketTypedDataSignatureRoute({
        body: request.body,
        signer,
        user,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  z.post(
    "/embedded/sign-typed-data",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketEmbeddedSignTypedDataBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await executeEmbeddedPolymarketTypedDataSignatureRoute({
        body: request.body,
        signer,
        user,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * POST /orders/sync
   * Fetch open orders from Polymarket CLOB using stored L2 credentials and upsert them into `orders`.
   */
  z.post(
    "/orders/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketOrdersSyncBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const authWalletAddress = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await syncPolymarketOrdersRoute({
        authWalletAddress,
        body: request.body ?? {},
        log: app.log,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
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

      const result = await fetchPolymarketOpenOrdersRoute({
        log: request.log,
        query: request.query,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * POST /balance-allowance/sync
   * Refresh Polymarket's CLOB balance cache after wallet funding/approvals.
   */
  z.post(
    "/balance-allowance/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketBalanceAllowanceSyncBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await syncPolymarketBalanceAllowanceRoute({
        body: request.body,
        log: request.log,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  z.get(
    "/order-attempts/:orderHash",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: polymarketDirectAttemptParams,
        response: {
          200: polymarketDirectAttemptResponse,
          401: polymarketDirectAttemptAuthError,
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer)
        return reply.code(401).send({ error: "Unauthorized" });
      reply.header("Cache-Control", "private, no-store");
      const status = await getPolymarketDirectFokStatus(pool, {
        userId: user.id,
        signer,
        orderHash: request.params.orderHash.toLowerCase(),
      });
      return reply.send({ ok: true, ...status });
    },
  );

  /**
   * POST /order
   * Place a signed Polymarket order using stored L2 credentials.
   */
  z.post(
    "/order",
    {
      onRequest: async (request, reply) => {
        reply.header("x-hunch-request-id", request.id);
      },
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

      const log = polymarketOrderSubmitLogger(
        request.log,
        user.id,
        request.body.fundingOperationId,
      );
      // Global exception logging also uses the redacted request logger.
      request.log = log;
      log.info("Polymarket order submission requested");
      const result = await submitPolymarketHttpOrder({
        assertTelegramAppHandoffV2Scope: async (sealed) => {
          return matchesTelegramAppHandoffV2CurrentScope({
            db: sealed.db,
            sealed,
          });
        },
        body: request.body,
        log,
        pool,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        log.info(
          {
            status: result.statusCode,
            code: result.payload.code ?? "polymarket_submit_rejected",
          },
          "Polymarket order submission returned an error",
        );
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
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
      const requestedWalletAddress = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await cancelPolymarketOrderRoute({
        body: request.body,
        log: request.log,
        pool,
        requestedWalletAddress,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );
};
