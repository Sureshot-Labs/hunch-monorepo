import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import { storeExecution } from "../repos/executions-repo.js";
import { dflowRequest, extractDflowErrorMessage } from "../services/dflow-client.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaTokenBalanceByOwnerAndMint,
  formatUiAmount,
  sendSolanaRawTransaction,
} from "../services/solana-rpc.js";
import {
  dflowExecutionBodySchema,
  dflowOrderQuerySchema,
  dflowQuoteQuerySchema,
  dflowSubmitBodySchema,
  dflowSwapBodySchema,
} from "../schemas/dflow.js";

const SOL_DECIMALS = 9;

function isSolanaWallet(address: string): boolean {
  return !address.startsWith("0x");
}

function ensureDflowReady(reply: { code: (status: number) => void; send: (payload: unknown) => void }): boolean {
  if (!env.dflowRequireApiKey) return true;
  if (env.dflowApiKey && env.dflowApiKey.trim().length > 0) return true;
  reply.code(400);
  reply.send({ error: "Missing DFLOW_API_KEY" });
  return false;
}

// Mounted under /trade/kalshi and /trade/dflow (alias).
export const dflowPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

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
          message: error instanceof Error ? error.message : "Unknown error",
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
      const userPublicKey =
        query.userPublicKey?.trim() || walletAddress.trim();
      if (userPublicKey !== walletAddress.trim()) {
        reply.code(400);
        return reply.send({
          error: "userPublicKey must match the selected wallet",
        });
      }

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
        reply.code(502);
        return reply.send({
          error: "DFlow order failed",
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
          ...(query.platformFeeMode ? { platformFeeMode: query.platformFeeMode } : {}),
          ...(query.feeAccount ? { feeAccount: query.feeAccount } : {}),
        },
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "DFlow quote failed",
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
          message: error instanceof Error ? error.message : "Unknown error",
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
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isSolanaWallet(walletAddress)) {
        reply.code(400);
        return reply.send({
          error: "DFlow execution tracking requires a Solana wallet address",
        });
      }

      const body = request.body;

      try {
        const execution = await storeExecution(pool, {
          userId: user.id,
          walletAddress,
          venue: "kalshi",
          unifiedMarketId: body.marketId ?? null,
          side: body.side ?? null,
          inputMint: body.inputMint ?? null,
          outputMint: body.outputMint ?? null,
          amountIn: body.amountIn ?? null,
          amountOut: body.amountOut ?? null,
          quoteId: body.quoteId ?? null,
          txSignature: body.txSignature ?? null,
          status: body.status ?? null,
          raw: body.raw ?? null,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
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
              execution.amount_out != null ? Number(execution.amount_out) : null,
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
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );
};
