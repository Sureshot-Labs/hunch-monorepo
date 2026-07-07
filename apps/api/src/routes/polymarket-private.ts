import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import crypto from "node:crypto";
import { ethers } from "ethers";
import { AuthService, createAuthMiddleware, type User } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import { requestPriceRefreshForTokens } from "../lib/price-refresh.js";
import { isRecord } from "../lib/type-guards.js";
import { fetchPolymarketMarketInfo } from "../repos/polymarket-markets.js";
import {
  polymarketBalanceAllowanceSyncBodySchema,
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
import { fetchPolymarketOnchainSnapshot } from "../services/polymarket-onchain.js";
import { buildPolymarketRedemptionPlan } from "../services/polymarket-redemption-plan.js";
import { derivePolymarketFunders } from "../services/polymarket-funder.js";
import { requestPolymarketCredentials } from "../services/polymarket-credentials.js";
import {
  buildEmbeddedPolymarketOrderRequest,
  buildEmbeddedPolymarketConnectRequest,
  buildEmbeddedPolymarketTypedDataRequest,
  executeEmbeddedPolymarketConnectRequest,
  executeEmbeddedPolymarketOrderRequest,
  executeEmbeddedPolymarketTypedDataRequest,
  executeEmbeddedSignerApprovalRequests,
  prepareEmbeddedPolymarketSignerApprovalRequests,
  resolveEmbeddedPolymarketWalletContext,
} from "../services/polymarket-embedded.js";
import {
  buildEmbeddedExecutionSingleFlightKey,
  getEmbeddedExecutionSingleFlightPromise,
  runEmbeddedExecutionSingleFlight,
} from "../services/embedded-execution-singleflight.js";
import {
  resolvePolymarketFeePolicySnapshot,
} from "../services/polymarket-builder-fees.js";
import {
  normalizeOrderTypeForClob as normalizeQuoteOrderTypeForClob,
  PolymarketQuoteError,
} from "../services/polymarket-quote.js";
import {
  quotePolymarketOrder,
} from "../services/polymarket-trading-service.js";
import {
  cancelPolymarketOrderRoute,
  computePolymarketMaxSpendRoute,
  computePolymarketOrderHashRoute,
  fetchPolymarketAccountRoute,
  fetchPolymarketOpenOrdersRoute,
  submitPolymarketClientSignedOrder,
  syncPolymarketBalanceAllowanceRoute,
  syncPolymarketOrdersRoute,
} from "../services/polymarket-trading-execution-service.js";

const EMBEDDED_APPROVAL_THRESHOLD = 1n << 255n;

function normalizeAddress(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
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

function approvalSatisfiesEmbeddedAutomation(
  value: bigint | null | undefined,
): boolean {
  return Boolean(value != null && value >= EMBEDDED_APPROVAL_THRESHOLD);
}

function normalizeEvmAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

async function resolveEmbeddedEnsureReadyState(inputs: {
  user: User;
  signer: string;
  requestedFunder?: string | null;
}) {
  const context = await resolveEmbeddedPolymarketWalletContext({
    user: inputs.user,
    signer: inputs.signer,
  });
  let credsInfo = await AuthService.getVenueCredentialsInfo(
    inputs.user.id,
    "polymarket",
    inputs.signer,
  );
  const storedFunder = credsInfo?.funderAddress ?? null;
  const funderDerivation = await derivePolymarketFunders({
    signer: inputs.signer,
    storedFunder: inputs.requestedFunder ?? storedFunder,
    includeMagicProxy: true,
    bypassCodeCache: true,
  });
  const signerNormalized = normalizeEvmAddress(inputs.signer);
  const findCandidate = (address: string | null | undefined) => {
    const normalized = normalizeEvmAddress(address);
    if (!normalized) return null;
    return (
      funderDerivation.candidates.find(
        (candidate) => normalizeEvmAddress(candidate.funder) === normalized,
      ) ?? null
    );
  };
  const requestedCandidate = findCandidate(inputs.requestedFunder ?? null);
  const storedCandidate =
    requestedCandidate &&
    storedFunder &&
    normalizeEvmAddress(storedFunder) ===
      normalizeEvmAddress(requestedCandidate.funder)
      ? requestedCandidate
      : findCandidate(storedFunder);
  const desiredDistinctCandidate =
    (requestedCandidate &&
    normalizeEvmAddress(requestedCandidate.funder) !== signerNormalized
      ? requestedCandidate
      : null) ??
    (storedCandidate &&
    normalizeEvmAddress(storedCandidate.funder) !== signerNormalized
      ? storedCandidate
      : null);
  const canPreserveDistinctCandidate = Boolean(
    desiredDistinctCandidate?.deployed &&
    (desiredDistinctCandidate.signatureType === 2 ||
      desiredDistinctCandidate.signatureType === 3 ||
      desiredDistinctCandidate.contractKind === "SAFE_LIKE"),
  );
  const effectiveDistinctFunder = canPreserveDistinctCandidate
    ? (desiredDistinctCandidate?.funder ?? null)
    : null;
  const effectiveFunder = effectiveDistinctFunder ?? inputs.signer;
  const shouldClearStoredFunder = Boolean(
    storedFunder &&
    normalizeEvmAddress(storedFunder) !== signerNormalized &&
    !effectiveDistinctFunder,
  );
  const shouldUpdateStoredFunder = Boolean(
    credsInfo &&
    effectiveDistinctFunder &&
    normalizeEvmAddress(credsInfo?.funderAddress ?? null) !==
      normalizeEvmAddress(effectiveDistinctFunder),
  );

  if (shouldClearStoredFunder) {
    await AuthService.updateVenueFunderAddress(
      inputs.user.id,
      inputs.signer,
      "polymarket",
      null,
    );
    credsInfo = await AuthService.getVenueCredentialsInfo(
      inputs.user.id,
      "polymarket",
      inputs.signer,
    );
  } else if (shouldUpdateStoredFunder && effectiveDistinctFunder) {
    await AuthService.updateVenueFunderAddress(
      inputs.user.id,
      inputs.signer,
      "polymarket",
      effectiveDistinctFunder,
    );
    credsInfo = await AuthService.getVenueCredentialsInfo(
      inputs.user.id,
      "polymarket",
      inputs.signer,
    );
  }

  const snapshot = await fetchPolymarketOnchainSnapshot({
    rpcUrl: env.polygonRpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    signer: inputs.signer,
    funder: effectiveFunder,
    includeFeeCollectorNonce: false,
    negRiskAdapterAddress: env.polymarketNegRiskAdapterAddress,
    ctfCollateralAdapterAddress: env.polymarketCtfCollateralAdapterAddress,
    negRiskCollateralAdapterAddress:
      env.polymarketNegRiskCollateralAdapterAddress,
    feeCollectorAddress: null,
  });

  const approvalRequests = prepareEmbeddedPolymarketSignerApprovalRequests({
    context,
    funder: effectiveFunder,
    currentApprovals: {
      exchangeApproved: snapshot.okExchange,
      negRiskExchangeApproved: snapshot.okNegRisk,
      negRiskAdapterApproved: env.polymarketNegRiskAdapterAddress
        ? (snapshot.okNegRiskAdapter ?? false)
        : true,
      ctfCollateralAdapterApproved: env.polymarketCtfCollateralAdapterAddress
        ? (snapshot.okCtfCollateralAdapter ?? false)
        : true,
      negRiskCollateralAdapterApproved:
        env.polymarketNegRiskCollateralAdapterAddress
          ? (snapshot.okNegRiskCollateralAdapter ?? false)
          : true,
      feeCollectorApproved: true,
      exchangeAllowanceOk: approvalSatisfiesEmbeddedAutomation(
        snapshot.allowanceExchange,
      ),
      negRiskExchangeAllowanceOk: approvalSatisfiesEmbeddedAutomation(
        snapshot.allowanceNegRisk,
      ),
      negRiskAdapterAllowanceOk: env.polymarketNegRiskAdapterAddress
        ? approvalSatisfiesEmbeddedAutomation(
            snapshot.allowanceNegRiskAdapter ?? null,
          )
        : true,
      feeCollectorAllowanceOk: true,
    },
  });

  return {
    context,
    credsInfo,
    effectiveFunder,
    effectiveDistinctFunder,
    approvalRequests,
    clearedStoredFunder: shouldClearStoredFunder,
  };
}

function buildEmbeddedEnsureReadyResponse(args: {
  signer: string;
  effectiveFunder: string;
  effectiveDistinctFunder: string | null;
  clearedStoredFunder: boolean;
  connected?: boolean;
  approvalsApplied?: boolean;
  approvalExecution?: {
    signer: string;
    funder: string;
    funderKind: "signer" | "safe" | "magic" | "deposit_wallet";
    transactionHashes: string[];
  } | null;
}) {
  return {
    ok: true,
    signer: args.signer,
    funder: args.effectiveFunder,
    funderSource: args.effectiveDistinctFunder ? "stored" : "signer",
    connected: args.connected ?? false,
    clearedStoredFunder: args.clearedStoredFunder,
    approvalsApplied: args.approvalsApplied ?? false,
    approvalExecution: args.approvalExecution ?? null,
  };
}

function exchangeAddressForNegRisk(negRisk: boolean | null): string | null {
  if (negRisk == null) return null;
  return negRisk
    ? env.polymarketNegRiskExchangeAddress
    : env.polymarketExchangeAddress;
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

        const negRisk = info.neg_risk != null ? Boolean(info.neg_risk) : null;
        const takerFeeRaw = info.taker_fee_bps ?? null;
        const makerFeeRaw = info.maker_fee_bps ?? null;
        const takerFeeBps =
          takerFeeRaw != null && takerFeeRaw !== ""
            ? Math.max(0, Number(takerFeeRaw))
            : 0;
        const makerFeeBps =
          makerFeeRaw != null && makerFeeRaw !== ""
            ? Math.max(0, Number(makerFeeRaw))
            : 0;

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
          takerFeeBps: Number.isFinite(takerFeeBps) ? takerFeeBps : 0,
          makerFeeBps: Number.isFinite(makerFeeBps) ? makerFeeBps : 0,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer, query },
          "Failed to fetch Polymarket market info",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to fetch Polymarket market info",
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

      const marketInfo = await fetchPolymarketMarketInfo(pool, { tokenId });
      const takerFeeRaw = marketInfo?.taker_fee_bps ?? null;
      const makerFeeRaw = marketInfo?.maker_fee_bps ?? null;
      const takerFeeBps =
        takerFeeRaw != null && takerFeeRaw !== ""
          ? Math.max(0, Number(takerFeeRaw))
          : 0;
      const makerFeeBps =
        makerFeeRaw != null && makerFeeRaw !== ""
          ? Math.max(0, Number(makerFeeRaw))
          : 0;

      reply.header("Content-Type", "application/json; charset=utf-8");
      const nowMs = Date.now().toString();
      const zeroBytes32 =
        "0x0000000000000000000000000000000000000000000000000000000000000000";
      const feePolicySnapshot = await resolvePolymarketFeePolicySnapshot(pool);
      return reply.send({
        ok: true,
        version: "polymarket_clob_v2",
        tokenId,
        timestamp: nowMs,
        metadata: zeroBytes32,
        builder: feePolicySnapshot.builderCode,
        exchangeAddress:
          marketInfo?.neg_risk === true
            ? env.polymarketNegRiskExchangeAddress
            : env.polymarketExchangeAddress,
        collateralAddress: env.polymarketUsdcAddress,
        takerFeeBps: Number.isFinite(takerFeeBps) ? takerFeeBps : 0,
        makerFeeBps: Number.isFinite(makerFeeBps) ? makerFeeBps : 0,
        builderCollectionMode: feePolicySnapshot.collectionMode,
        builderTakerFeeBps: feePolicySnapshot.builderTakerFeeBps,
        builderMakerFeeBps: feePolicySnapshot.builderMakerFeeBps,
        builderRateSource: feePolicySnapshot.builderRateSource,
        builderEnabled: feePolicySnapshot.builderEnabled,
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
        void requestPriceRefreshForTokens({
          tokenIds: [orderTokenId],
          venue: "polymarket",
        });
      }

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
      const refresh = parseOptionalBoolean(query?.refresh) === true;

      const result = await derivePolymarketFunders({
        signer,
        storedFunder: credsInfo?.funderAddress ?? null,
        includeMagicProxy,
        bypassCodeCache: refresh,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        ...result,
      });
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

      const body = request.body;
      const wallets = Array.from(new Set(body.wallets.map(normalizeAddress)));

      const userWallets = await AuthService.getUserWallets(user.id);
      const allowedWallets = new Set(
        userWallets.map((wallet) => normalizeAddress(wallet.walletAddress)),
      );

      for (const wallet of wallets) {
        if (!allowedWallets.has(wallet)) {
          reply.code(403);
          return reply.send({
            error: "walletAddress does not belong to the current user",
          });
        }
      }

      const includeMagicProxy = Boolean(body.includeMagicProxy);
      const refresh = body.refresh === true;

      const results: Record<string, unknown> = {};

      for (const wallet of wallets) {
        try {
          const credsInfo = await AuthService.getVenueCredentialsInfo(
            user.id,
            "polymarket",
            wallet,
          );
          const result = await derivePolymarketFunders({
            signer: wallet,
            storedFunder: credsInfo?.funderAddress ?? null,
            includeMagicProxy,
            bypassCodeCache: refresh,
          });
          results[wallet] = result;
        } catch {
          results[wallet] = {
            error: "Funder derive failed",
          };
        }
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        results,
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
      const orderType = normalizeQuoteOrderTypeForClob(body.orderType ?? "FOK");
      const amountType =
        (body.amountType ?? "usd") === "shares" ? "shares" : "usd";
      const amountUsdInput =
        amountType === "usd" ? (body.amountUsd ?? body.amount) : null;
      const amountSharesInput = amountType === "shares" ? body.amount : null;

      if (!tokenId) {
        reply.code(400);
        return reply.send({ error: "tokenId is required" });
      }

      void markHotTokens({ tokenIds: [tokenId], venue: "polymarket" });
      void requestPriceRefreshForTokens({
        tokenIds: [tokenId],
        venue: "polymarket",
      });

      try {
        const quote = await quotePolymarketOrder(pool, {
          tokenId,
          side: body.side,
          orderType,
          amountType,
          amountUsdInput,
          amountSharesInput,
          limitPrice: body.limitPrice,
          slippageBps: body.slippageBps,
          logWarn: ({ error, tokenId: warningTokenId, conditionId }) =>
            request.log.warn(
              { error, tokenId: warningTokenId, conditionId },
              "Failed to fetch Polymarket CLOB fee curve; using local fee fallback",
            ),
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(quote);
      } catch (error) {
        if (error instanceof PolymarketQuoteError) {
          reply.code(error.statusCode);
          return reply.send({ error: error.publicMessage });
        }
        app.log.error(
          { error, userId: user.id, signer, body },
          "Failed to quote Polymarket order",
        );
        reply.code(502);
        return reply.send({
          error: "Polymarket quote failed",
        });
      }
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

      const body = request.body;
      const tokenId = body.tokenId.trim();

      void markHotTokens({ tokenIds: [tokenId], venue: "polymarket" });
      void requestPriceRefreshForTokens({
        tokenIds: [tokenId],
        venue: "polymarket",
      });

      const result = await computePolymarketMaxSpendRoute({
        body,
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
      preHandler: createAuthMiddleware(),
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

      try {
        const credsInfo = await AuthService.getVenueCredentialsInfo(
          user.id,
          "polymarket",
          signer,
        );
        const funder =
          request.query.funderAddress ?? credsInfo?.funderAddress ?? signer;
        const plan = await buildPolymarketRedemptionPlan({
          rpcUrl: env.polygonRpcUrl,
          timeoutMs: env.polygonRpcTimeoutMs,
          funder,
          conditionalTokensAddress: env.polymarketConditionalTokensAddress,
          collateralTokenAddress: env.polymarketUsdcAddress,
          legacyCollateralTokenAddress: env.polymarketUsdceAddress,
          negRiskAdapterAddress: env.polymarketNegRiskAdapterAddress ?? null,
          ctfCollateralAdapterAddress:
            env.polymarketCtfCollateralAdapterAddress ?? null,
          negRiskCollateralAdapterAddress:
            env.polymarketNegRiskCollateralAdapterAddress ?? null,
          outcome: request.query.outcome,
          positionTokenId: request.query.tokenId,
          conditionId: request.query.conditionId ?? null,
          questionId: request.query.questionId ?? null,
          negRiskParentConditionId:
            request.query.negRiskParentConditionId ?? null,
          negRiskRequestId: request.query.negRiskRequestId ?? null,
          isNegRisk: request.query.negRisk === true,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(plan);
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            signer,
            tokenId: request.query.tokenId,
            outcome: request.query.outcome,
          },
          "Failed to build Polymarket redemption plan",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to prepare Polymarket redemption",
        });
      }
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

      try {
        const lockKey = normalizeEvmAddress(signer) ?? signer.toLowerCase();
        const existingExecution = getEmbeddedExecutionSingleFlightPromise<
          Record<string, unknown>
        >(
          buildEmbeddedExecutionSingleFlightKey(
            "polymarket-private",
            "embedded-ensure-ready",
            lockKey,
          ),
        );
        if (existingExecution) {
          await existingExecution;
          const settledState = await resolveEmbeddedEnsureReadyState({
            user,
            signer,
            requestedFunder: request.body.funderAddress ?? null,
          });
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: true,
            signer,
            funder: settledState.effectiveFunder,
            funderSource: settledState.effectiveDistinctFunder
              ? "stored"
              : "signer",
            clearedStoredFunder: settledState.clearedStoredFunder,
            requests: [],
          });
        }

        const state = await resolveEmbeddedEnsureReadyState({
          user,
          signer,
          requestedFunder: request.body.funderAddress ?? null,
        });

        const requests = [...state.approvalRequests];
        if (!state.credsInfo) {
          const timestamp = Math.floor(Date.now() / 1000).toString();
          const nonce = crypto.randomInt(1_000_000_000);
          requests.unshift(
            buildEmbeddedPolymarketConnectRequest({
              context: state.context,
              timestamp,
              nonce,
            }),
          );
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: true,
            signer,
            funder: state.effectiveFunder,
            funderSource: state.effectiveDistinctFunder ? "stored" : "signer",
            clearedStoredFunder: state.clearedStoredFunder,
            connectTimestamp: timestamp,
            connectNonce: nonce,
            requests,
          });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signer,
          funder: state.effectiveFunder,
          funderSource: state.effectiveDistinctFunder ? "stored" : "signer",
          clearedStoredFunder: state.clearedStoredFunder,
          requests,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to prepare embedded Polymarket readiness",
        );
        reply.code(500);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Embedded setup preparation failed",
        });
      }
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

      try {
        const lockKey = normalizeEvmAddress(signer) ?? signer.toLowerCase();
        const singleFlightKey = buildEmbeddedExecutionSingleFlightKey(
          "polymarket-private",
          "embedded-ensure-ready",
          lockKey,
        );
        const existingExecution =
          getEmbeddedExecutionSingleFlightPromise<Record<string, unknown>>(
            singleFlightKey,
          );
        if (existingExecution) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(await existingExecution);
        }

        const result = await runEmbeddedExecutionSingleFlight({
          key: singleFlightKey,
          run: async () => {
            const state = await resolveEmbeddedEnsureReadyState({
              user,
              signer,
              requestedFunder: request.body.funderAddress ?? null,
            });

            let connected = false;
            if (!state.credsInfo) {
              const connectRequest = request.body.signedRequests.find(
                (entry) => entry.id === "polymarket-connect",
              );
              if (!connectRequest?.signature?.trim()) {
                throw new Error(
                  "Missing Privy authorization signature for Polymarket connect",
                );
              }
              const connectTimestamp =
                request.body.connectTimestamp?.trim() ?? "";
              const connectNonce = request.body.connectNonce;
              if (!connectTimestamp || connectNonce == null) {
                throw new Error(
                  "Embedded Polymarket connect requires the prepared timestamp and nonce.",
                );
              }
              const preparedConnectRequest =
                buildEmbeddedPolymarketConnectRequest({
                  context: state.context,
                  timestamp: connectTimestamp,
                  nonce: connectNonce,
                });
              const connectSignature =
                await executeEmbeddedPolymarketConnectRequest({
                  request: preparedConnectRequest,
                  authorizationSignature: connectRequest.signature,
                });
              const { apiKey, apiSecret, passphrase } =
                await requestPolymarketCredentials({
                  walletAddress: signer,
                  signature: connectSignature,
                  timestamp: connectTimestamp,
                  nonce: connectNonce,
                });
              const additionalData: Record<string, unknown> = {
                passphrase,
                ...(state.effectiveDistinctFunder
                  ? { funderAddress: state.effectiveDistinctFunder }
                  : {}),
              };
              await AuthService.createOrUpdateVenueCredentials(
                user.id,
                signer,
                "polymarket",
                apiKey,
                apiSecret,
                additionalData,
              );
              connected = true;
            }

            const approvalRequests = state.approvalRequests;
            const approvalSignatures = request.body.signedRequests.filter(
              (entry) => entry.id.startsWith("approval-"),
            );
            const txHashes = await executeEmbeddedSignerApprovalRequests({
              requests: approvalRequests,
              signatures: approvalSignatures,
            });

            return buildEmbeddedEnsureReadyResponse({
              signer,
              effectiveFunder: state.effectiveFunder,
              effectiveDistinctFunder: state.effectiveDistinctFunder,
              clearedStoredFunder: state.clearedStoredFunder,
              connected,
              approvalsApplied: txHashes.length > 0,
              approvalExecution:
                txHashes.length > 0
                  ? {
                      signer,
                      funder: state.effectiveFunder,
                      funderKind: "signer",
                      transactionHashes: txHashes,
                    }
                  : null,
            });
          },
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to execute embedded Polymarket readiness",
        );
        reply.code(500);
        return reply.send({
          error:
            error instanceof Error ? error.message : "Embedded setup failed",
        });
      }
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

      try {
        const context = await resolveEmbeddedPolymarketWalletContext({
          user,
          signer,
        });
        const authorizationRequest = buildEmbeddedPolymarketOrderRequest({
          context,
          payload: request.body.order,
          exchangeAddress: request.body.exchangeAddress,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, request: authorizationRequest });
      } catch (error) {
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare order signature",
        });
      }
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

      try {
        const context = await resolveEmbeddedPolymarketWalletContext({
          user,
          signer,
        });
        const authorizationRequest = buildEmbeddedPolymarketOrderRequest({
          context,
          payload: request.body.order,
          exchangeAddress: request.body.exchangeAddress,
        });
        const signature = await executeEmbeddedPolymarketOrderRequest({
          request: authorizationRequest,
          authorizationSignature: request.body.authorizationSignature,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, signature });
      } catch (error) {
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error ? error.message : "Failed to sign order",
        });
      }
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

      try {
        const context = await resolveEmbeddedPolymarketWalletContext({
          user,
          signer,
        });
        const authorizationRequest = buildEmbeddedPolymarketTypedDataRequest({
          context,
          typedData: request.body.typedData,
          id: request.body.id,
          label: request.body.label,
          depositWalletBatchPurpose: request.body.depositWalletBatchPurpose,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, request: authorizationRequest });
      } catch (error) {
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare typed-data signature",
        });
      }
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

      try {
        const context = await resolveEmbeddedPolymarketWalletContext({
          user,
          signer,
        });
        const authorizationRequest = buildEmbeddedPolymarketTypedDataRequest({
          context,
          typedData: request.body.typedData,
          id: request.body.id,
          label: request.body.label,
          depositWalletBatchPurpose: request.body.depositWalletBatchPurpose,
        });
        const signature = await executeEmbeddedPolymarketTypedDataRequest({
          request: authorizationRequest,
          authorizationSignature: request.body.authorizationSignature,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, signature });
      } catch (error) {
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to sign typed data",
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

      const result = await submitPolymarketClientSignedOrder({
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
