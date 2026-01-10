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
  fetchSolanaBalanceLamports,
  fetchSolanaSignatureStatus,
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
const DEFAULT_USDC_DECIMALS = 6;

type FeeExtractionResult = {
  amountRaw: string;
  feeAccount?: string | null;
};

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

function parseNumberish(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed;
  }
  return null;
}

function parseBigInt(value: string): bigint | null {
  try {
    if (!/^\d+$/.test(value)) return null;
    return BigInt(value);
  } catch {
    return null;
  }
}

function extractFeeFromObject(value: unknown): FeeExtractionResult | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const amountKeys = [
    "platformFeeAmount",
    "platform_fee_amount",
    "feeAmount",
    "fee_amount",
  ];

  for (const key of amountKeys) {
    const raw = record[key];
    const amount = parseNumberish(raw);
    if (amount) return { amountRaw: amount, feeAccount: null };
  }

  const objectKeys = ["platformFee", "platform_fee", "fee"];
  for (const key of objectKeys) {
    const raw = record[key];
    if (!raw || typeof raw !== "object") continue;
    const nested = raw as Record<string, unknown>;
    const nestedAmount =
      parseNumberish(nested.amount) ??
      parseNumberish(nested.feeAmount) ??
      parseNumberish(nested.platformFeeAmount);
    if (nestedAmount) {
      const feeAccount =
        (typeof nested.feeAccount === "string" && nested.feeAccount.trim()) ||
        (typeof nested.fee_account === "string" && nested.fee_account.trim()) ||
        null;
      return { amountRaw: nestedAmount, feeAccount };
    }
  }

  const nestedKeys = [
    "data",
    "quote",
    "order",
    "result",
    "swap",
    "route",
  ];
  for (const key of nestedKeys) {
    const nested = record[key];
    const result = extractFeeFromObject(nested);
    if (result) return result;
  }

  return null;
}

function extractDflowFeeAmount(raw: unknown): FeeExtractionResult | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const order = record.order ?? record.quote ?? record;
  return extractFeeFromObject(order);
}

function computeFeeFromBps(inputs: {
  amountRaw: string;
  decimals: number;
  feeBps: number;
}): string | null {
  if (!inputs.amountRaw) return null;
  if (!Number.isFinite(inputs.feeBps) || inputs.feeBps <= 0) return null;
  const amountBig = parseBigInt(inputs.amountRaw);
  if (amountBig != null) {
    const feeRaw = (amountBig * BigInt(inputs.feeBps)) / 10_000n;
    return formatUiAmount(feeRaw, inputs.decimals);
  }

  const amountNum = Number(inputs.amountRaw);
  if (!Number.isFinite(amountNum)) return null;
  const feeNum = (amountNum * inputs.feeBps) / 10_000;
  return (feeNum / Math.pow(10, inputs.decimals)).toString();
}

// Mounted under /trade/kalshi and /trade/dflow (alias).
export const dflowPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();
  const geoFenceConfig: GeoFenceConfig = {
    enabled: env.dflowGeoBlockEnabled,
    blockedCountries: env.dflowGeoBlockCountries,
    defaultPolicy: env.dflowGeoBlockDefault,
    trustProxy: env.trustProxy,
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
          inputDecimals: body.inputDecimals ?? null,
          outputDecimals: body.outputDecimals ?? null,
          quoteId: body.quoteId ?? null,
          txSignature: body.txSignature ?? null,
          status: body.status ?? null,
          raw: body.raw ?? null,
        });

        const usdcMint = env.solanaUsdcMint;
        let notionalUsd: number | null = null;
        if (body.inputMint === usdcMint && body.amountIn != null) {
          const decimals = body.inputDecimals ?? 6;
          notionalUsd = Number(body.amountIn) / Math.pow(10, decimals);
        } else if (body.outputMint === usdcMint && body.amountOut != null) {
          const decimals = body.outputDecimals ?? 6;
          notionalUsd = Number(body.amountOut) / Math.pow(10, decimals);
        }

        if (notionalUsd != null && Number.isFinite(notionalUsd) && notionalUsd > 0) {
          await pool.query(
            `
              insert into volume_events (
                id,
                user_id,
                wallet_address,
                venue,
                source_type,
                source_id,
                notional_usd,
                created_at
              )
              values (
                gen_random_uuid(),
                $1, $2, 'kalshi', 'execution', $3, $4, now()
              )
              on conflict (user_id, source_type, source_id) do nothing
            `,
            [user.id, walletAddress, execution.id, notionalUsd],
          );
        }

        const feeAccount = env.dflowFeeAccount?.trim() || null;
        const feeBps = env.feeBpsKalshi;
        const feeScale = env.feeScaleKalshi;
        const hasFeeBps = Number.isFinite(feeBps) && feeBps > 0;
        const hasFeeScale = Number.isFinite(feeScale) && feeScale > 0;
        const feeConfigActive = Boolean(feeAccount) && (hasFeeBps || hasFeeScale);

        if (feeConfigActive) {
          const rawFee = extractDflowFeeAmount(body.raw);
          const rawFeeAccount = rawFee?.feeAccount ?? null;
          if (rawFeeAccount && feeAccount && rawFeeAccount !== feeAccount) {
            app.log.warn(
              { rawFeeAccount, feeAccount, userId: user.id },
              "Skipping DFlow fee event (fee account mismatch)",
            );
          } else {
            const inputDecimals = body.inputDecimals ?? DEFAULT_USDC_DECIMALS;
            const outputDecimals = body.outputDecimals ?? inputDecimals;
            const isInputUsdc = body.inputMint === env.solanaUsdcMint;
            const isOutputUsdc = body.outputMint === env.solanaUsdcMint;
            const feeDecimals = isInputUsdc
              ? inputDecimals
              : isOutputUsdc
                ? outputDecimals
                : DEFAULT_USDC_DECIMALS;
            let feeAmountUi: string | null = null;

            if (rawFee?.amountRaw) {
              const trimmed = rawFee.amountRaw.trim();
              if (trimmed.includes(".")) {
                feeAmountUi = trimmed;
              } else {
                const feeBig = parseBigInt(trimmed);
                if (feeBig != null) {
                  feeAmountUi = formatUiAmount(feeBig, feeDecimals);
                } else {
                  const feeNum = Number(trimmed);
                  if (Number.isFinite(feeNum)) {
                    feeAmountUi = (
                      feeNum / Math.pow(10, feeDecimals)
                    ).toString();
                  }
                }
              }
            }

            if (!feeAmountUi && hasFeeBps && !hasFeeScale) {
              const baseAmountRaw = isInputUsdc
                ? parseNumberish(body.amountIn)
                : isOutputUsdc
                  ? parseNumberish(body.amountOut)
                  : null;
              if (baseAmountRaw) {
                feeAmountUi = computeFeeFromBps({
                  amountRaw: baseAmountRaw,
                  decimals: feeDecimals,
                  feeBps,
                });
              }
            }

            const feeAmountNumber =
              feeAmountUi != null ? Number(feeAmountUi) : NaN;
            if (Number.isFinite(feeAmountNumber) && feeAmountNumber > 0) {
              const signature = body.txSignature?.trim() || "";
              const statusResult = signature
                ? await fetchSolanaSignatureStatus({
                    rpcUrls: env.solanaRpcUrls,
                    signature,
                    timeoutMs: env.solanaRpcTimeoutMs,
                  })
                : null;
              const status =
                statusResult?.status === "fulfilled"
                  ? "collected"
                  : statusResult?.status === "failed"
                    ? "failed"
                    : "pending";
              const collectedAt = status === "collected" ? new Date() : null;

              await pool.query(
                `
                  insert into fee_events (
                    id,
                    user_id,
                    wallet_address,
                    venue,
                    chain_id,
                    source_type,
                    source_id,
                    fee_amount,
                    fee_asset,
                    fee_usd,
                    tx_hash,
                    collected_at,
                    status,
                    created_at,
                    updated_at
                  )
                  values (
                    gen_random_uuid(),
                    $1, $2, 'kalshi', 'solana', 'execution', $3,
                    $4, 'USDC', $4, $5, $6, $7, now(), now()
                  )
                  on conflict (user_id, source_type, source_id)
                  do update set
                    fee_amount = excluded.fee_amount,
                    fee_usd = excluded.fee_usd,
                    tx_hash = excluded.tx_hash,
                    collected_at = excluded.collected_at,
                    status = excluded.status,
                    updated_at = now()
                `,
                [
                  user.id,
                  walletAddress,
                  execution.id,
                  feeAmountUi,
                  signature || null,
                  collectedAt,
                  status,
                ],
              );
            }
          }
        }

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
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );
};
