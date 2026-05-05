import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import {
  buildGeoFenceResponse,
  evaluateGeoFence,
  type GeoFenceConfig,
} from "../lib/geo-fence.js";
import { storeExecution } from "../repos/executions-repo.js";
import {
  dflowRequest,
  extractDflowErrorMessage,
  formatDflowUserMessage,
} from "../services/dflow-client.js";
import {
  fetchKalshiNormalizedOrderStatus,
  finalizeKalshiExecutionEffects,
  mergeKalshiExecutionRaw,
  normalizeKalshiExecutionStatus,
} from "../services/kalshi-executions.js";
import { verifyProofAddress } from "../services/proof-client.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaSignatureStatus,
  fetchSolanaTokenBalanceByOwnerAndMint,
  formatUiAmount,
  sendSolanaRawTransaction,
} from "../services/solana-rpc.js";
import {
  dflowExecutionBodySchema,
  dflowOrderQuerySchema,
  dflowOrderStatusQuerySchema,
  dflowQuoteQuerySchema,
  dflowSubmitBodySchema,
  dflowSwapBodySchema,
} from "../schemas/dflow.js";
import { resolveRequestedWalletAddresses } from "../lib/resolve-wallets.js";

const SOL_DECIMALS = 9;

type MintPair = {
  inputMint: string;
  outputMint: string;
};

function isSolanaWallet(address: string): boolean {
  return !address.startsWith("0x");
}

function ensureDflowReady(reply: {
  code: (status: number) => void;
  send: (payload: unknown) => void;
}): boolean {
  if (!env.dflowRequireApiKey) return true;
  if (env.dflowApiKey && env.dflowApiKey.trim().length > 0) return true;
  reply.code(400);
  reply.send({ error: "Missing DFLOW_API_KEY" });
  return false;
}

function isBuyIntent(inputMint: string | null | undefined): boolean {
  return Boolean(inputMint && inputMint === env.solanaUsdcMint);
}

function isProofBypassed(user: { kalshiProofBypass: boolean }): boolean {
  return user.kalshiProofBypass;
}

function sendProofRequired(
  reply: {
    code: (status: number) => void;
    send: (payload: unknown) => void;
  },
  walletAddress: string,
) {
  reply.code(403);
  reply.send({
    error: "Kalshi buy requires identity verification",
    code: "proof_required",
    venue: "kalshi",
    wallet: walletAddress,
    proofUrl: "https://dflow.net/proof",
  });
}

function sendProofUnavailable(reply: {
  code: (status: number) => void;
  send: (payload: unknown) => void;
}) {
  reply.code(503);
  reply.send({
    error: "Verification service unavailable",
    code: "proof_check_unavailable",
    venue: "kalshi",
  });
}

function readMintPairFromRecord(
  record: Record<string, unknown>,
): MintPair | null {
  const inputRaw = record.inputMint ?? record.input_mint;
  const outputRaw = record.outputMint ?? record.output_mint;
  if (typeof inputRaw !== "string" || typeof outputRaw !== "string") {
    return null;
  }
  const inputMint = inputRaw.trim();
  const outputMint = outputRaw.trim();
  if (!inputMint || !outputMint) return null;
  return { inputMint, outputMint };
}

function findMintPair(value: unknown, depth = 0): MintPair | null {
  if (depth > 8) return null;
  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findMintPair(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  const direct = readMintPairFromRecord(record);
  if (direct) return direct;

  const preferredKeys = [
    "quoteResponse",
    "route",
    "quote",
    "order",
    "swap",
    "result",
    "data",
  ];
  for (const key of preferredKeys) {
    if (!(key in record)) continue;
    const nested = findMintPair(record[key], depth + 1);
    if (nested) return nested;
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findMintPair(nestedValue, depth + 1);
    if (nested) return nested;
  }

  return null;
}

async function enforceKalshiProof(args: {
  user: { id: string; kalshiProofBypass: boolean };
  walletAddress: string;
  inputMint: string | null;
  outputMint: string | null;
  hasDeterministicIntent: boolean;
  app: {
    log: {
      warn: (obj: unknown, msg: string) => void;
    };
  };
  reply: {
    code: (status: number) => void;
    send: (payload: unknown) => void;
  };
}): Promise<boolean> {
  if (!env.kalshiProofEnabled) return true;
  if (isProofBypassed(args.user)) return true;

  if (!args.hasDeterministicIntent || !args.inputMint || !args.outputMint) {
    args.app.log.warn(
      {
        userId: args.user.id,
        walletAddress: args.walletAddress,
      },
      "Kalshi proof gate denied request: unable to derive buy/sell intent",
    );
    sendProofUnavailable(args.reply);
    return false;
  }

  if (!isBuyIntent(args.inputMint)) return true;

  const proofCheck = await verifyProofAddress({
    address: args.walletAddress,
  });

  if (proofCheck.ok) {
    if (proofCheck.verified) return true;
    sendProofRequired(args.reply, args.walletAddress);
    return false;
  }

  args.app.log.warn(
    {
      userId: args.user.id,
      walletAddress: args.walletAddress,
      error: proofCheck.error,
      status: proofCheck.status,
    },
    "Kalshi proof gate verification unavailable",
  );
  sendProofUnavailable(args.reply);
  return false;
}

// Mounted under /trade/kalshi and /trade/dflow (alias).
export const dflowPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();
  const geoFenceConfig: GeoFenceConfig = {
    enabled: env.dflowGeoBlockEnabled,
    blockedCountries: env.dflowGeoBlockCountries,
    defaultPolicy: env.dflowGeoBlockDefault,
    trustProxy: env.trustProxy,
    proxySecret: env.proxySecret,
  };

  app.addHook("preHandler", async (request, reply) => {
    const decision = evaluateGeoFence(request, geoFenceConfig);
    if (decision.allowed) return;
    app.log.warn(
      {
        country: decision.country,
        reason: decision.reason,
        path: request.url,
      },
      "Kalshi geofence blocked request",
    );
    reply.code(403);
    return reply.send(buildGeoFenceResponse({ venue: "kalshi", decision }));
  });

  /**
   * GET /account
   * Returns a wallet-scoped Kalshi/DFlow account snapshot (Solana on-chain reads).
   */
  z.get(
    "/account",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isSolanaWallet(walletAddress)) {
        reply.code(400);
        return reply.send({
          error: "Kalshi account snapshot requires a Solana wallet address",
        });
      }

      try {
        const [solLamports, usdc] = await Promise.all([
          fetchSolanaBalanceLamports({
            rpcUrls: env.solanaRpcUrls,
            timeoutMs: env.solanaRpcTimeoutMs,
            owner: walletAddress,
          }),
          fetchSolanaTokenBalanceByOwnerAndMint({
            rpcUrls: env.solanaRpcUrls,
            timeoutMs: env.solanaRpcTimeoutMs,
            owner: walletAddress,
            mint: env.solanaUsdcMint,
          }),
        ]);

        const usdcDecimals = usdc?.decimals ?? 6;
        const usdcAmount = usdc?.amount ?? 0n;

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          venue: "kalshi",
          walletAddress,
          rpcUrl: env.solanaRpcUrl,
          sol: {
            decimals: SOL_DECIMALS,
            balance: formatUiAmount(solLamports, SOL_DECIMALS),
            balanceRaw: solLamports.toString(),
          },
          usdc: {
            mint: env.solanaUsdcMint,
            decimals: usdcDecimals,
            balance: formatUiAmount(usdcAmount, usdcDecimals),
            balanceRaw: usdcAmount.toString(),
          },
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to fetch Kalshi account snapshot",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to fetch Kalshi account snapshot",
        });
      }
    },
  );

  /**
   * GET /order
   * Proxy order requests to DFlow (returns unsigned transaction + quote).
   */
  z.get(
    "/order",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: dflowOrderQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isSolanaWallet(walletAddress)) {
        reply.code(400);
        return reply.send({
          error: "DFlow order requires a Solana wallet address",
        });
      }

      if (!ensureDflowReady(reply)) return;

      const query = request.query;
      const userPublicKey = query.userPublicKey?.trim() || walletAddress.trim();
      if (userPublicKey !== walletAddress.trim()) {
        reply.code(400);
        return reply.send({
          error: "userPublicKey must match the selected wallet",
        });
      }

      const proofAllowed = await enforceKalshiProof({
        user,
        walletAddress,
        inputMint: query.inputMint,
        outputMint: query.outputMint,
        hasDeterministicIntent: true,
        app,
        reply,
      });
      if (!proofAllowed) return;

      const hotTokenIds = [query.inputMint, query.outputMint]
        .filter(
          (mint): mint is string =>
            Boolean(mint) && mint !== env.solanaUsdcMint,
        )
        .map((mint) => `sol:${mint}`);
      if (hotTokenIds.length) {
        void markHotTokens({ tokenIds: hotTokenIds, venue: "dflow" });
      }

      const upstream = await dflowRequest({
        baseUrl: env.dflowQuoteBase,
        timeoutMs: 15_000,
        method: "GET",
        requestPath: "/order",
        apiKey: env.dflowApiKey,
        query: {
          inputMint: query.inputMint,
          outputMint: query.outputMint,
          amount: query.amount,
          userPublicKey,
          ...(query.slippageBps != null
            ? { slippageBps: query.slippageBps }
            : {}),
          ...(query.platformFeeBps != null
            ? { platformFeeBps: query.platformFeeBps }
            : {}),
          ...(query.platformFeeScale != null
            ? { platformFeeScale: query.platformFeeScale }
            : {}),
          ...(query.platformFeeMode
            ? { platformFeeMode: query.platformFeeMode }
            : {}),
          ...(query.feeAccount ? { feeAccount: query.feeAccount } : {}),
        },
      });

      if (!upstream.ok) {
        const userMessage = formatDflowUserMessage(upstream.payload);
        reply.code(502);
        return reply.send({
          error: userMessage ?? "DFlow order failed",
          status: upstream.status,
          message: extractDflowErrorMessage(upstream.payload),
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(upstream.payload);
    },
  );

  z.get(
    "/order-status",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: dflowOrderStatusQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!ensureDflowReady(reply)) return;
      try {
        const orderStatus = await fetchKalshiNormalizedOrderStatus({
          signature: request.query.signature,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(orderStatus.raw);
      } catch (error) {
        app.log.error(
          { error, signature: request.query.signature },
          "Failed to fetch DFlow order status",
        );
        reply.code(502);
        return reply.send({
          error: "DFlow order status failed",
        });
      }
    },
  );

  z.get(
    "/tx-status",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: dflowOrderStatusQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const status = await fetchSolanaSignatureStatus({
          rpcUrls: env.solanaRpcUrls,
          signature: request.query.signature,
          timeoutMs: env.solanaRpcTimeoutMs,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          status: status?.status ?? "submitted",
        });
      } catch (error) {
        app.log.error(
          { error, signature: request.query.signature },
          "Failed to fetch Kalshi tx status",
        );
        reply.code(502);
        return reply.send({ error: "Failed to fetch Kalshi tx status" });
      }
    },
  );

  /**
   * GET /quote
   * Proxy quote requests to DFlow (no signing).
   */
  z.get(
    "/quote",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: dflowQuoteQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isSolanaWallet(walletAddress)) {
        reply.code(400);
        return reply.send({
          error: "DFlow quote requires a Solana wallet address",
        });
      }

      if (!ensureDflowReady(reply)) return;

      const query = request.query;

      const proofAllowed = await enforceKalshiProof({
        user,
        walletAddress,
        inputMint: query.inputMint,
        outputMint: query.outputMint,
        hasDeterministicIntent: true,
        app,
        reply,
      });
      if (!proofAllowed) return;

      const hotTokenIds = [query.inputMint, query.outputMint]
        .filter(
          (mint): mint is string =>
            Boolean(mint) && mint !== env.solanaUsdcMint,
        )
        .map((mint) => `sol:${mint}`);
      if (hotTokenIds.length) {
        void markHotTokens({ tokenIds: hotTokenIds, venue: "dflow" });
      }

      const upstream = await dflowRequest({
        baseUrl: env.dflowQuoteBase,
        timeoutMs: 10_000,
        method: "GET",
        requestPath: "/quote",
        apiKey: env.dflowApiKey,
        query: {
          inputMint: query.inputMint,
          outputMint: query.outputMint,
          amount: query.amount,
          ...(query.slippageBps != null
            ? { slippageBps: query.slippageBps }
            : {}),
          ...(query.platformFeeBps != null
            ? { platformFeeBps: query.platformFeeBps }
            : {}),
          ...(query.platformFeeScale != null
            ? { platformFeeScale: query.platformFeeScale }
            : {}),
          ...(query.platformFeeMode
            ? { platformFeeMode: query.platformFeeMode }
            : {}),
          ...(query.feeAccount ? { feeAccount: query.feeAccount } : {}),
        },
      });

      if (!upstream.ok) {
        const userMessage = formatDflowUserMessage(upstream.payload);
        reply.code(502);
        return reply.send({
          error: userMessage ?? "DFlow quote failed",
          status: upstream.status,
          message: extractDflowErrorMessage(upstream.payload),
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(upstream.payload);
    },
  );

  /**
   * POST /swap
   * Returns an unsigned swap transaction from DFlow.
   */
  z.post(
    "/swap",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: dflowSwapBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isSolanaWallet(walletAddress)) {
        reply.code(400);
        return reply.send({
          error: "DFlow swap requires a Solana wallet address",
        });
      }

      if (!ensureDflowReady(reply)) return;

      const body = request.body;
      if (body.userPublicKey !== walletAddress) {
        reply.code(400);
        return reply.send({
          error: "userPublicKey must match the selected wallet",
        });
      }

      const mintPair = findMintPair(body.quoteResponse);
      const proofAllowed = await enforceKalshiProof({
        user,
        walletAddress,
        inputMint: mintPair?.inputMint ?? null,
        outputMint: mintPair?.outputMint ?? null,
        hasDeterministicIntent: Boolean(mintPair),
        app,
        reply,
      });
      if (!proofAllowed) return;

      const upstream = await dflowRequest({
        baseUrl: env.dflowQuoteBase,
        timeoutMs: 15_000,
        method: "POST",
        requestPath: "/swap",
        apiKey: env.dflowApiKey,
        body: {
          userPublicKey: body.userPublicKey,
          quoteResponse: body.quoteResponse,
          ...(body.dynamicComputeUnitLimit !== undefined
            ? { dynamicComputeUnitLimit: body.dynamicComputeUnitLimit }
            : {}),
          ...(body.prioritizationFeeLamports !== undefined
            ? { prioritizationFeeLamports: body.prioritizationFeeLamports }
            : {}),
        },
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "DFlow swap failed",
          status: upstream.status,
          message: extractDflowErrorMessage(upstream.payload),
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(upstream.payload);
    },
  );

  /**
   * POST /submit
   * Broadcast a signed Solana transaction and return the signature.
   */
  z.post(
    "/submit",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: dflowSubmitBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isSolanaWallet(walletAddress)) {
        reply.code(400);
        return reply.send({
          error: "DFlow submit requires a Solana wallet address",
        });
      }

      try {
        const signature = await sendSolanaRawTransaction({
          rpcUrls: env.solanaRpcUrls,
          timeoutMs: env.solanaRpcTimeoutMs,
          signedTransaction: request.body.signedTransaction,
          skipPreflight: request.body.skipPreflight,
          maxRetries: request.body.maxRetries,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signature,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "DFlow submit failed",
        );
        reply.code(502);
        return reply.send({
          error: "DFlow submit failed",
        });
      }
    },
  );

  /**
   * POST /executions
   * Persist DFlow execution metadata for the selected wallet.
   */
  z.post(
    "/executions",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: dflowExecutionBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      const requestedWalletAddress =
        body.walletAddress?.trim() || walletAddress;
      const resolvedWalletAddresses = await resolveRequestedWalletAddresses(
        user.id,
        walletAddress,
        requestedWalletAddress ? [requestedWalletAddress] : undefined,
      );
      const executionWalletAddress = resolvedWalletAddresses[0] ?? null;
      if (!executionWalletAddress || !isSolanaWallet(executionWalletAddress)) {
        reply.code(400);
        return reply.send({
          error:
            "DFlow execution tracking requires a linked Solana wallet address",
        });
      }
      const executionStatus = normalizeKalshiExecutionStatus(body.status);
      const executionPurpose = body.purpose ?? "trade";
      const executionRaw = mergeKalshiExecutionRaw(body.raw, {
        purpose: executionPurpose,
      });

      try {
        const execution = await storeExecution(pool, {
          userId: user.id,
          walletAddress: executionWalletAddress,
          venue: "kalshi",
          unifiedMarketId: body.marketId ?? null,
          side: body.side ?? null,
          inputMint: body.inputMint ?? null,
          outputMint: body.outputMint ?? null,
          amountIn: body.amountIn ?? null,
          amountOut: body.amountOut ?? null,
          inputDecimals: body.inputDecimals ?? null,
          outputDecimals: body.outputDecimals ?? null,
          quoteId: body.quoteId ?? null,
          venueOrderId: body.venueOrderId ?? null,
          txSignature: body.txSignature ?? null,
          status: executionStatus ?? null,
          raw: executionRaw,
        });
        const effects = await finalizeKalshiExecutionEffects(pool, {
          execution,
          purpose: executionPurpose,
          logger: app.log,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          referralFirstTrade: effects.referralFirstTrade ?? undefined,
          execution: {
            id: execution.id,
            venue: execution.venue,
            unifiedMarketId: execution.unified_market_id,
            side: execution.side,
            outcome: execution.outcome,
            inputMint: execution.input_mint,
            outputMint: execution.output_mint,
            amountIn:
              execution.amount_in != null ? Number(execution.amount_in) : null,
            amountOut:
              execution.amount_out != null
                ? Number(execution.amount_out)
                : null,
            inputDecimals: execution.input_decimals ?? null,
            outputDecimals: execution.output_decimals ?? null,
            quoteId: execution.quote_id,
            txSignature: execution.tx_signature,
            venueOrderId: execution.venue_order_id,
            status: execution.status,
            raw: execution.raw ?? null,
            createdAt: execution.created_at,
            updatedAt: execution.updated_at,
          },
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress, body },
          "Failed to store DFlow execution",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to store DFlow execution",
        });
      }
    },
  );
};
