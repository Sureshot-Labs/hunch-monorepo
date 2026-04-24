import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AuthService, createAuthMiddleware } from "../auth.js";
import { env } from "../env.js";
import { getRedis } from "../redis.js";
import {
  formatUiAmount,
  fetchSolanaBalanceLamports,
  fetchSolanaMintDecimals,
  fetchSolanaLatestBlockhash,
  fetchSolanaTokenBalanceByOwnerAndMint,
  sendSolanaRawTransaction,
} from "../services/solana-rpc.js";
import {
  solanaBalanceQuerySchema,
  solanaBlockhashQuerySchema,
  solanaMintsQuerySchema,
  solanaSubmitBodySchema,
} from "../schemas/solana.js";

const DECIMALS_CACHE_TTL_SEC = 60 * 60 * 24;
const SOLANA_NATIVE_MINT = "11111111111111111111111111111111";
const SOLANA_WRAPPED_MINT = "So11111111111111111111111111111111111111112";

function isSolanaWallet(address: string): boolean {
  return !address.startsWith("0x");
}

export const solanaRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /solana/mints
   * Returns mint decimals for a list of SPL token mints.
   */
  z.get(
    "/solana/mints",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: solanaMintsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const ids = request.query.ids;
      const r = await getRedis();

      const results: Array<{ mint: string; decimals: number | null }> = [];
      for (const mint of ids) {
        const cacheKey = `solana:mint-decimals:${mint}`;
        if (r) {
          const cached = await r.get(cacheKey);
          if (cached) {
            const cachedNum = Number(cached);
            results.push({
              mint,
              decimals: Number.isFinite(cachedNum) ? cachedNum : null,
            });
            continue;
          }
        }

        let decimals: number | null = null;
        try {
          decimals = await fetchSolanaMintDecimals({
            rpcUrls: env.solanaRpcUrls,
            timeoutMs: env.solanaRpcTimeoutMs,
            mint,
          });
        } catch (error) {
          app.log.warn({ error, mint }, "Failed to fetch mint decimals");
        }

        if (r && decimals != null) {
          await r.set(cacheKey, String(decimals), {
            EX: DECIMALS_CACHE_TTL_SEC,
          });
        }

        results.push({ mint, decimals });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ mints: results });
    },
  );

  /**
   * GET /solana/balance
   * Returns SPL token balance for a given mint and wallet.
   */
  z.get(
    "/solana/balance",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: solanaBalanceQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const walletOverride =
        typeof query.walletAddress === "string"
          ? query.walletAddress.trim()
          : null;
      const owner = walletOverride || walletAddress;
      if (!owner) {
        reply.code(400);
        return reply.send({ error: "walletAddress is required" });
      }

      if (!isSolanaWallet(owner)) {
        reply.code(400);
        return reply.send({
          error: "Solana balance requires a Solana wallet address",
        });
      }

      if (walletOverride) {
        const walletRecord = await AuthService.getUserWalletByAddress(
          user.id,
          owner,
        );
        if (!walletRecord) {
          reply.code(403);
          return reply.send({
            error: "walletAddress does not belong to the current user",
          });
        }
      }

      const mint = query.mint.trim();
      let decimals: number | null = null;
      let amount = 0n;
      let uiAmountString = "0";

      try {
        if (mint === SOLANA_NATIVE_MINT) {
          const lamports = await fetchSolanaBalanceLamports({
            rpcUrls: env.solanaRpcUrls,
            timeoutMs: env.solanaRpcTimeoutMs,
            owner,
          });
          amount = lamports;
          decimals = 9;
          uiAmountString = formatUiAmount(amount, decimals);
        } else {
          const balance = await fetchSolanaTokenBalanceByOwnerAndMint({
            rpcUrls: env.solanaRpcUrls,
            timeoutMs: env.solanaRpcTimeoutMs,
            owner,
            mint,
          });
          if (balance) {
            amount = balance.amount;
            decimals = balance.decimals;
            uiAmountString = balance.uiAmountString;
          } else if (mint === SOLANA_WRAPPED_MINT) {
            const lamports = await fetchSolanaBalanceLamports({
              rpcUrls: env.solanaRpcUrls,
              timeoutMs: env.solanaRpcTimeoutMs,
              owner,
            });
            amount = lamports;
            decimals = 9;
            uiAmountString = formatUiAmount(amount, decimals);
          } else {
            decimals = await fetchSolanaMintDecimals({
              rpcUrls: env.solanaRpcUrls,
              timeoutMs: env.solanaRpcTimeoutMs,
              mint,
            });
            uiAmountString = formatUiAmount(amount, decimals);
          }
        }
      } catch (error) {
        app.log.warn({ error, mint, owner }, "Solana balance fetch failed");
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        walletAddress: owner,
        mint,
        amount: amount.toString(),
        decimals,
        uiAmountString,
      });
    },
  );

  /**
   * GET /solana/blockhash
   * Returns the latest blockhash for client-side signing.
   */
  z.get(
    "/solana/blockhash",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: solanaBlockhashQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const walletOverride =
        typeof query.walletAddress === "string"
          ? query.walletAddress.trim()
          : null;
      const owner = walletOverride || walletAddress;
      if (!owner) {
        reply.code(400);
        return reply.send({ error: "walletAddress is required" });
      }

      if (!isSolanaWallet(owner)) {
        reply.code(400);
        return reply.send({
          error: "Solana blockhash requires a Solana wallet address",
        });
      }

      if (walletOverride) {
        const walletRecord = await AuthService.getUserWalletByAddress(
          user.id,
          owner,
        );
        if (!walletRecord) {
          reply.code(403);
          return reply.send({
            error: "walletAddress does not belong to the current user",
          });
        }
      }

      try {
        const latest = await fetchSolanaLatestBlockhash({
          rpcUrls: env.solanaRpcUrls,
          timeoutMs: env.solanaRpcTimeoutMs,
        });
        if (!latest) {
          reply.code(502);
          return reply.send({ error: "Solana blockhash unavailable" });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, ...latest });
      } catch (error) {
        app.log.error({ error, userId: user.id }, "Solana blockhash failed");
        reply.code(502);
        return reply.send({
          error: "Solana blockhash failed",
        });
      }
    },
  );

  /**
   * POST /solana/submit
   * Broadcast a signed Solana transaction and return the signature.
   */
  z.post(
    "/solana/submit",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: solanaSubmitBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      const walletOverride =
        typeof body.walletAddress === "string"
          ? body.walletAddress.trim()
          : null;
      const owner = walletOverride || walletAddress;
      if (!owner) {
        reply.code(400);
        return reply.send({ error: "walletAddress is required" });
      }

      if (!isSolanaWallet(owner)) {
        reply.code(400);
        return reply.send({
          error: "Solana submit requires a Solana wallet address",
        });
      }

      if (walletOverride) {
        const walletRecord = await AuthService.getUserWalletByAddress(
          user.id,
          owner,
        );
        if (!walletRecord) {
          reply.code(403);
          return reply.send({
            error: "walletAddress does not belong to the current user",
          });
        }
      }

      try {
        const signature = await sendSolanaRawTransaction({
          rpcUrls: env.solanaRpcUrls,
          timeoutMs: env.solanaRpcTimeoutMs,
          signedTransaction: body.signedTransaction,
          skipPreflight: body.skipPreflight,
          maxRetries: body.maxRetries,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signature,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Solana submit failed",
        );
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : "Solana submit failed";
        reply.code(502);
        return reply.send({
          error: "Solana submit failed",
          message,
        });
      }
    },
  );
};
