import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { publishMarketState } from "@hunch/infra";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { getRedis } from "../redis.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import { requestPriceRefreshForTokens } from "../lib/price-refresh.js";
import {
  buildGeoFenceResponse,
  evaluateGeoFence,
  type GeoFenceConfig,
} from "../lib/geo-fence.js";
import {
  fetchKalshiNormalizedOrderStatus,
} from "../services/kalshi-executions.js";
import { resolveKalshiProofRequirement } from "../services/kalshi-trade-eligibility.js";
import {
  buildKalshiDflowOrderRoute,
  buildKalshiDflowSwapRoute,
  quoteKalshiDflowRoute,
  recordKalshiDflowExecutionRoute,
  submitKalshiDflowSignedTransactionRoute,
} from "../services/kalshi-trading-execution-service.js";
import { verifyProofAddress } from "../services/proof-client.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaSignatureStatus,
  fetchSolanaTokenBalanceByOwnerAndMint,
  formatUiAmount,
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

type RedisMulti = {
  set: (key: string, value: string, options?: { EX?: number }) => RedisMulti;
  publish: (channel: string, message: string) => RedisMulti;
  exec: () => Promise<unknown>;
};

type PriceRedis = {
  multi: () => RedisMulti;
};

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

function buildClearedTopTick(tokenId: string, tsMs: number): string {
  return JSON.stringify({
    token_id: tokenId,
    best_bid: null,
    best_ask: null,
    mid: null,
    spread: null,
    ts: tsMs,
  });
}

async function markDflowRouteUnavailable(mints: string[]): Promise<void> {
  const tokenIds = Array.from(
    new Set(
      mints
        .map((mint) => mint.trim())
        .filter((mint) => mint && mint !== env.solanaUsdcMint)
        .map((mint) => `sol:${mint}`),
    ),
  );
  if (!tokenIds.length) return;

  const { rows: marketRows } = await pool.query<{
    market_id: string;
    venue_market_id: string | null;
    status: string | null;
    condition_id: string | null;
    resolved_outcome: string | null;
  }>(
    `
      with affected as (
        select distinct market_id
        from unified_market_tokens
        where token_id = any($1::text[])
      )
      update unified_markets m
      set
        metadata = jsonb_set(
          coalesce(m.metadata, '{}'::jsonb),
          '{dflowNativeAcceptingOrders}',
          'false'::jsonb,
          true
        ),
        best_bid = null,
        best_ask = null,
        last_price = null,
        updated_at_db = now()
      from affected a
      where m.id = a.market_id
        and m.venue = 'kalshi'
      returning
        m.id as market_id,
        m.venue_market_id,
        m.status::text as status,
        m.condition_id,
        m.resolved_outcome
    `,
    [tokenIds],
  );
  if (!marketRows.length) return;

  const marketIds = marketRows.map((row) => row.market_id);
  const { rows: tokenRows } = await pool.query<{
    token_id: string;
    market_id: string;
  }>(
    `
      select token_id, market_id
      from unified_market_tokens
      where market_id = any($1::text[])
    `,
    [marketIds],
  );
  if (!tokenRows.length) return;

  const allTokenIds = tokenRows.map((row) => row.token_id);
  await pool.query(
    `
      update unified_token_top_latest
      set
        best_bid = null,
        best_ask = null,
        mid = null,
        spread = null,
        ts = now(),
        updated_at = now()
      where token_id = any($1::text[])
    `,
    [allTokenIds],
  );

  const redis = (await getRedis()) as PriceRedis | null;
  if (!redis) return;

  const tsMs = Date.now();
  const marketById = new Map(marketRows.map((row) => [row.market_id, row]));
  await Promise.all(
    tokenRows.map(async (row) => {
      const market = marketById.get(row.market_id);
      const tickJson = buildClearedTopTick(row.token_id, tsMs);
      const multi = redis.multi();
      multi.set(
        `book:${row.token_id}`,
        JSON.stringify({
          token_id: row.token_id,
          bids: [],
          asks: [],
          timestamp: String(tsMs),
        }),
        { EX: 5 },
      );
      multi.set(`top:${row.token_id}`, tickJson, { EX: 60 });
      multi.publish(`prices:${row.token_id}`, tickJson);
      await Promise.all([
        multi.exec(),
        publishMarketState({
          redis,
          venue: "kalshi",
          tokenId: row.token_id,
          market: market?.condition_id ?? market?.venue_market_id ?? null,
          conditionId: market?.condition_id ?? null,
          status: market?.status ?? null,
          acceptingOrders: false,
          resolvedOutcome: market?.resolved_outcome ?? null,
          tsMs,
        }),
      ]);
    }),
  );
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
  const requirement = resolveKalshiProofRequirement({
    hasDeterministicIntent:
      args.hasDeterministicIntent && Boolean(args.outputMint),
    inputMint: args.inputMint,
    proofBypassed: args.user.kalshiProofBypass,
    proofEnabled: env.kalshiProofEnabled,
    usdcMint: env.solanaUsdcMint,
  });
  if (!requirement.requiresProof) return true;

  if (requirement.decision === "unknown_intent") {
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
        void requestPriceRefreshForTokens({
          tokenIds: hotTokenIds,
          venue: "dflow",
        });
      }

      const result = await buildKalshiDflowOrderRoute({
        query,
        userPublicKey,
      });
      if (!result.ok) {
        if (result.routeNotFound) {
          void markDflowRouteUnavailable([
            query.inputMint,
            query.outputMint,
          ]).catch((error) =>
            app.log.warn({ error }, "Failed to mark DFlow route unavailable"),
          );
        }
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
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
        void requestPriceRefreshForTokens({
          tokenIds: hotTokenIds,
          venue: "dflow",
        });
      }

      const result = await quoteKalshiDflowRoute({ query });
      if (!result.ok) {
        if (result.routeNotFound) {
          void markDflowRouteUnavailable([
            query.inputMint,
            query.outputMint,
          ]).catch((error) =>
              app.log.warn({ error }, "Failed to mark DFlow route unavailable"),
          );
        }
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
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

      const result = await buildKalshiDflowSwapRoute({ body });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
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

      const result = await submitKalshiDflowSignedTransactionRoute({
        body: request.body,
      });
      if (!result.ok) {
        app.log.error(
          { userId: user.id, walletAddress },
          "DFlow submit failed",
        );
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
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
      try {
        const result = await recordKalshiDflowExecutionRoute({
          body,
          logger: app.log,
          pool,
          statusMode: "legacy_client_status",
          userId: user.id,
          walletAddress: executionWalletAddress,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
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
