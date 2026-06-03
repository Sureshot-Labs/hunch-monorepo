import { createHash, randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { fetchActiveDebridgeConfig } from "../repos/debridge-config.js";
import { getRedis } from "../redis.js";
import {
  embeddedEvmExecuteBodySchema,
  embeddedEvmPrepareBodySchema,
  embeddedSolanaExecuteBodySchema,
  embeddedSolanaPrepareBodySchema,
  solanaPrefundExecuteBodySchema,
  solanaPrefundPrepareBodySchema,
  solanaReadinessBodySchema,
} from "../schemas/embedded-wallets.js";
import {
  debridgeRequest,
  extractDebridgeErrorMessage,
} from "../services/debridge-client.js";
import {
  executeEmbeddedEthereumTransactionRequests,
  prepareEmbeddedEthereumTransactionRequests,
  resolveEmbeddedEthereumWalletContext,
} from "../services/embedded-ethereum.js";
import {
  buildEmbeddedExecutionSingleFlightKey,
  runEmbeddedExecutionSingleFlight,
} from "../services/embedded-execution-singleflight.js";
import {
  buildEmbeddedSolanaSignAndSendRequest,
  executeEmbeddedSolanaTransactionRequests,
  prepareEmbeddedSolanaTransactionRequests,
  resolveEmbeddedSolanaWalletContext,
  type EmbeddedPrivyAuthorizationRequest,
} from "../services/embedded-solana.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaTokenBalanceByOwnerAndMint,
  formatUiAmount,
} from "../services/solana-rpc.js";

const EMBEDDED_SOLANA_PREPARED_TTL_SEC = 300;
const SOLANA_PREFUND_PREPARED_TTL_SEC = 300;
const SOLANA_CHAIN_ID = "7565164";
const SOLANA_NATIVE_ADDRESS = "11111111111111111111111111111111";
const SOL_DECIMALS = 9;
const DEFAULT_SOLANA_PREFUND_SLIPPAGE = 0.5;

type EmbeddedSolanaPreparedCacheEntry = {
  expiresAt: number;
  requests: EmbeddedPrivyAuthorizationRequest[];
};

type SolanaPrefundOperation =
  | "dflow_buy"
  | "dflow_sell"
  | "dflow_redeem"
  | "across"
  | "debridge"
  | "direct_transfer";

type SolanaPrefundPreparedCacheEntry = {
  expiresAt: number;
  signer: string;
  operation: SolanaPrefundOperation;
  amountInRaw: string;
  estimatedOutLamports: string;
  request: EmbeddedPrivyAuthorizationRequest;
  providerPayload: unknown;
};

type RouteLogger = {
  warn: (obj: object, message?: string) => void;
};

const embeddedSolanaPreparedMemory = new Map<
  string,
  EmbeddedSolanaPreparedCacheEntry
>();
const solanaPrefundPreparedMemory = new Map<
  string,
  SolanaPrefundPreparedCacheEntry
>();

const SOLANA_PREFUND_OPERATION_FLOORS: Record<
  SolanaPrefundOperation,
  { minSolLamports: bigint; targetSolLamports: bigint }
> = {
  dflow_buy: { minSolLamports: 5_000_000n, targetSolLamports: 30_000_000n },
  dflow_sell: { minSolLamports: 5_000_000n, targetSolLamports: 10_000_000n },
  dflow_redeem: { minSolLamports: 5_000_000n, targetSolLamports: 10_000_000n },
  across: { minSolLamports: 3_000_000n, targetSolLamports: 10_000_000n },
  debridge: { minSolLamports: 3_000_000n, targetSolLamports: 10_000_000n },
  direct_transfer: {
    minSolLamports: 1_000_000n,
    targetSolLamports: 5_000_000n,
  },
};

function pruneExpiredEmbeddedSolanaPreparedMemory(now = Date.now()): void {
  for (const [key, entry] of embeddedSolanaPreparedMemory) {
    if (entry.expiresAt <= now) embeddedSolanaPreparedMemory.delete(key);
  }
}

function pruneExpiredSolanaPrefundPreparedMemory(now = Date.now()): void {
  for (const [key, entry] of solanaPrefundPreparedMemory) {
    if (entry.expiresAt <= now) solanaPrefundPreparedMemory.delete(key);
  }
}

function normalizeEvmAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

function isSolanaAddress(value: string | null | undefined): value is string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return false;
  try {
    new PublicKey(trimmed);
    return true;
  } catch {
    return false;
  }
}

function normalizeSolanaAddress(value: string): string {
  return new PublicKey(value.trim()).toBase58();
}

function parsePositiveBigInt(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : null;
}

function readRecordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length
    ? value.trim()
    : null;
}

function readBridgeTokenAmountRaw(value: unknown): bigint | null {
  if (!isRecord(value)) return null;
  const raw =
    readRecordString(value, "minAmount") ??
    readRecordString(value, "amount") ??
    readRecordString(value, "amountRaw") ??
    readRecordString(value, "amount_raw");
  if (!raw || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

function readDebridgeTxData(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.tx)) return null;
  return readRecordString(payload.tx, "data");
}

function decodeSerializedSolanaTransaction(payload: string): Buffer | null {
  if (payload.startsWith("0x")) {
    const hex = payload.slice(2);
    if (!hex.length || hex.length % 2 !== 0) return null;
    return Buffer.from(hex, "hex");
  }
  try {
    return Buffer.from(payload, "base64");
  } catch {
    return null;
  }
}

function getSolanaTransactionRequiredSigners(payload: string): string[] | null {
  const raw = decodeSerializedSolanaTransaction(payload);
  if (!raw) return null;
  try {
    const tx = VersionedTransaction.deserialize(raw);
    return tx.message.staticAccountKeys
      .slice(0, tx.message.header.numRequiredSignatures)
      .map((key) => key.toBase58());
  } catch {
    return null;
  }
}

function normalizeSerializedSolanaTransactionBase64(
  payload: string,
): string | null {
  const raw = decodeSerializedSolanaTransaction(payload);
  if (!raw) return null;
  try {
    VersionedTransaction.deserialize(raw);
  } catch {
    return null;
  }
  return raw.toString("base64");
}

function digestSolanaTransactionPayload(payload: string): string {
  return createHash("sha256")
    .update(decodeSerializedSolanaTransaction(payload) ?? payload)
    .digest("hex");
}

function getAllowedSolanaPrefundInputMints(): Set<string> {
  const configured = env.solanaPrefundAllowedInputMints.length
    ? env.solanaPrefundAllowedInputMints
    : [env.solanaUsdcMint];
  return new Set(configured.map((mint) => mint.trim()).filter(Boolean));
}

function buildDebridgeSolanaPrefundQuery(inputs: {
  walletAddress: string;
  amountInRaw: string;
}) {
  return {
    chainId: SOLANA_CHAIN_ID,
    tokenIn: env.solanaUsdcMint,
    tokenInAmount: inputs.amountInRaw,
    tokenOut: SOLANA_NATIVE_ADDRESS,
    tokenOutRecipient: inputs.walletAddress,
    senderAddress: inputs.walletAddress,
    slippage: DEFAULT_SOLANA_PREFUND_SLIPPAGE,
  };
}

async function getDebridgeDlnBase(): Promise<string> {
  const row = await fetchActiveDebridgeConfig(pool);
  return row?.dln_base?.trim() || env.debridgeDlnBase;
}

async function isKalshiMarketInitialized(
  marketId: string | null | undefined,
): Promise<boolean | null> {
  const id = marketId?.trim();
  if (!id) return null;
  const { rows } = await pool.query<{ is_initialized: boolean | null }>(
    `
      select is_initialized
      from unified_markets
      where venue = 'kalshi'
        and (id = $1 or venue_market_id = $1 or condition_id = $1)
      order by updated_at_db desc nulls last
      limit 1
    `,
    [id],
  );
  return rows[0]?.is_initialized ?? null;
}

function buildEmbeddedSolanaPreparedCacheKey(inputs: {
  signer: string;
  executionKey: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `embedded-solana:prepared:${inputs.signer.trim()}:${inputs.executionKey.trim()}`,
    )
    .digest("hex");
  return `embedded-solana:prepared:${digest}`;
}

function buildSolanaPrefundPreparedCacheKey(inputs: {
  signer: string;
  executionKey: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `solana-prefund:prepared:${inputs.signer.trim()}:${inputs.executionKey.trim()}`,
    )
    .digest("hex");
  return `solana-prefund:prepared:${digest}`;
}

function parseEmbeddedSolanaPreparedRequests(
  raw: string | null,
): EmbeddedPrivyAuthorizationRequest[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { requests?: unknown }).requests)
    ) {
      return null;
    }
    return (parsed as { requests: EmbeddedPrivyAuthorizationRequest[] })
      .requests;
  } catch {
    return null;
  }
}

function parseSolanaPrefundPreparedEntry(
  raw: string | null,
): SolanaPrefundPreparedCacheEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.request)) return null;
    if (
      typeof parsed.signer !== "string" ||
      typeof parsed.operation !== "string" ||
      typeof parsed.amountInRaw !== "string" ||
      typeof parsed.estimatedOutLamports !== "string"
    ) {
      return null;
    }
    return parsed as SolanaPrefundPreparedCacheEntry;
  } catch {
    return null;
  }
}

async function cacheEmbeddedSolanaPreparedRequests(inputs: {
  signer: string;
  executionKey: string | null | undefined;
  requests: EmbeddedPrivyAuthorizationRequest[];
  log: RouteLogger;
}): Promise<void> {
  const executionKey = inputs.executionKey?.trim() ?? "";
  if (!executionKey) return;

  pruneExpiredEmbeddedSolanaPreparedMemory();

  const key = buildEmbeddedSolanaPreparedCacheKey({
    signer: inputs.signer,
    executionKey,
  });
  embeddedSolanaPreparedMemory.set(key, {
    expiresAt: Date.now() + EMBEDDED_SOLANA_PREPARED_TTL_SEC * 1000,
    requests: inputs.requests,
  });

  try {
    const redis = await getRedis();
    if (!redis) return;
    await redis.set(key, JSON.stringify({ requests: inputs.requests }), {
      EX: EMBEDDED_SOLANA_PREPARED_TTL_SEC,
    });
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to cache prepared embedded Solana requests in Redis",
    );
  }
}

async function cacheSolanaPrefundPreparedRequest(inputs: {
  signer: string;
  executionKey: string;
  entry: SolanaPrefundPreparedCacheEntry;
  log: RouteLogger;
}): Promise<void> {
  pruneExpiredSolanaPrefundPreparedMemory();
  const key = buildSolanaPrefundPreparedCacheKey({
    signer: inputs.signer,
    executionKey: inputs.executionKey,
  });
  solanaPrefundPreparedMemory.set(key, inputs.entry);

  try {
    const redis = await getRedis();
    if (!redis) return;
    await redis.set(key, JSON.stringify(inputs.entry), {
      EX: SOLANA_PREFUND_PREPARED_TTL_SEC,
    });
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to cache prepared Solana prefund request in Redis",
    );
  }
}

async function readCachedEmbeddedSolanaPreparedRequests(inputs: {
  signer: string;
  executionKey: string;
  log: RouteLogger;
}): Promise<EmbeddedPrivyAuthorizationRequest[] | null> {
  const key = buildEmbeddedSolanaPreparedCacheKey({
    signer: inputs.signer,
    executionKey: inputs.executionKey,
  });

  try {
    const redis = await getRedis();
    if (redis) {
      const cached = parseEmbeddedSolanaPreparedRequests(await redis.get(key));
      if (cached) return cached;
    }
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to read prepared embedded Solana requests from Redis",
    );
  }

  const memoryEntry = embeddedSolanaPreparedMemory.get(key);
  if (!memoryEntry) return null;
  if (memoryEntry.expiresAt <= Date.now()) {
    embeddedSolanaPreparedMemory.delete(key);
    return null;
  }
  return memoryEntry.requests;
}

async function readCachedSolanaPrefundPreparedRequest(inputs: {
  signer: string;
  executionKey: string;
  log: RouteLogger;
}): Promise<SolanaPrefundPreparedCacheEntry | null> {
  const key = buildSolanaPrefundPreparedCacheKey({
    signer: inputs.signer,
    executionKey: inputs.executionKey,
  });

  try {
    const redis = await getRedis();
    if (redis) {
      const cached = parseSolanaPrefundPreparedEntry(await redis.get(key));
      if (cached) return cached;
    }
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to read prepared Solana prefund request from Redis",
    );
  }

  const memoryEntry = solanaPrefundPreparedMemory.get(key);
  if (!memoryEntry) return null;
  if (memoryEntry.expiresAt <= Date.now()) {
    solanaPrefundPreparedMemory.delete(key);
    return null;
  }
  return memoryEntry;
}

async function deleteCachedSolanaPrefundPreparedRequest(inputs: {
  signer: string;
  executionKey: string;
  log: RouteLogger;
}): Promise<void> {
  const key = buildSolanaPrefundPreparedCacheKey({
    signer: inputs.signer,
    executionKey: inputs.executionKey,
  });
  solanaPrefundPreparedMemory.delete(key);
  try {
    const redis = await getRedis();
    if (redis) await redis.del(key);
  } catch (error) {
    inputs.log.warn(
      { error, signer: inputs.signer },
      "Failed to delete prepared Solana prefund request from Redis",
    );
  }
}

async function prepareSolanaPrefundRequest(inputs: {
  user: NonNullable<FastifyRequest["user"]>;
  signer: string;
  operation: SolanaPrefundOperation;
  amountInRaw: string;
  executionKey: string;
}): Promise<{
  request: EmbeddedPrivyAuthorizationRequest;
  providerPayload: unknown;
  estimatedOutLamports: bigint;
  transactionDigest: string;
}> {
  if (!env.solanaPrefundEnabled) {
    throw new Error("Solana prefund is disabled.");
  }

  const allowedInputMints = getAllowedSolanaPrefundInputMints();
  if (!allowedInputMints.has(env.solanaUsdcMint)) {
    throw new Error("Solana prefund is not configured for USDC input.");
  }

  const amountInRaw = parsePositiveBigInt(inputs.amountInRaw);
  if (!amountInRaw) {
    throw new Error("Prefund amount must be greater than zero.");
  }

  const usdc = await fetchSolanaTokenBalanceByOwnerAndMint({
    rpcUrls: env.solanaRpcUrls,
    timeoutMs: env.solanaRpcTimeoutMs,
    owner: inputs.signer,
    mint: env.solanaUsdcMint,
  });
  if (!usdc || usdc.amount < amountInRaw) {
    throw new Error("Insufficient Solana USDC for SOL prefund.");
  }

  const upstream = await debridgeRequest({
    baseUrl: await getDebridgeDlnBase(),
    timeoutMs: 20_000,
    method: "GET",
    requestPath: "/chain/transaction",
    query: buildDebridgeSolanaPrefundQuery({
      walletAddress: inputs.signer,
      amountInRaw: inputs.amountInRaw,
    }),
  });
  if (!upstream.ok) {
    throw new Error(extractDebridgeErrorMessage(upstream.payload) || "deBridge prefund order failed");
  }

  const upstreamTxData = readDebridgeTxData(upstream.payload);
  if (!upstreamTxData) {
    throw new Error("deBridge prefund response did not include a Solana transaction.");
  }
  const txData = normalizeSerializedSolanaTransactionBase64(upstreamTxData);
  if (!txData) {
    throw new Error("deBridge prefund response did not include a valid serialized Solana transaction.");
  }

  const requiredSigners = getSolanaTransactionRequiredSigners(txData);
  if (!requiredSigners || !requiredSigners.includes(inputs.signer)) {
    throw new Error("deBridge prefund transaction signer does not match selected wallet.");
  }

  const estimatedOutLamports = readBridgeTokenAmountRaw(
    isRecord(upstream.payload) ? upstream.payload.tokenOut : null,
  );
  if (!estimatedOutLamports || estimatedOutLamports <= 0n) {
    throw new Error("deBridge prefund response did not include a SOL output amount.");
  }
  if (estimatedOutLamports > env.solanaPrefundMaxTopUpLamports) {
    throw new Error("SOL prefund amount exceeds configured maximum.");
  }

  const context = await resolveEmbeddedSolanaWalletContext({
    user: inputs.user,
    signer: inputs.signer,
  });
  const request = buildEmbeddedSolanaSignAndSendRequest({
    context,
    executionKey: inputs.executionKey,
    transaction: {
      id: "solana-prefund",
      label: "Add SOL for Solana operations",
      transaction: txData,
      encoding: "base64",
      sponsor: true,
    },
    embeddedSolanaSponsorshipEnabled: true,
  });

  return {
    request,
    providerPayload: upstream.payload,
    estimatedOutLamports,
    transactionDigest: digestSolanaTransactionPayload(txData),
  };
}

export const embeddedWalletRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.post(
    "/wallets/solana/readiness",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: solanaReadinessBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signerRaw = request.walletAddress;
      if (!user || !signerRaw) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const requestedWallet = request.body.walletAddress?.trim() || signerRaw;
        if (!isSolanaAddress(requestedWallet) || !isSolanaAddress(signerRaw)) {
          reply.code(400);
          return reply.send({
            error: "Solana readiness requires a Solana wallet address",
          });
        }
        const signer = normalizeSolanaAddress(signerRaw);
        const walletAddress = normalizeSolanaAddress(requestedWallet);
        if (walletAddress !== signer) {
          reply.code(400);
          return reply.send({
            error: "walletAddress must match the selected wallet",
          });
        }

        const operation = request.body.operation;
        const floor = SOLANA_PREFUND_OPERATION_FLOORS[operation];
        const [solBalanceLamports, usdc, marketInitialized] =
          await Promise.all([
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
            operation === "dflow_buy"
              ? isKalshiMarketInitialized(request.body.marketId)
              : Promise.resolve<boolean | null>(null),
          ]);

        const usdcAmount = usdc?.amount ?? 0n;
        const marketBlocksOperation = marketInitialized === false;
        const needsPrefund =
          !marketBlocksOperation && solBalanceLamports < floor.minSolLamports;
        const prefundAvailable =
          needsPrefund && env.solanaPrefundEnabled && usdcAmount > 0n;
        const blockingReason = marketBlocksOperation
          ? "market_not_initialized"
          : needsPrefund && !env.solanaPrefundEnabled
            ? "prefund_disabled"
            : needsPrefund && usdcAmount <= 0n
              ? "insufficient_usdc_for_prefund"
              : null;

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          walletAddress,
          operation,
          solBalanceLamports: solBalanceLamports.toString(),
          solBalance: formatUiAmount(solBalanceLamports, SOL_DECIMALS),
          usdcBalanceRaw: usdcAmount.toString(),
          usdcBalance: formatUiAmount(usdcAmount, usdc?.decimals ?? 6),
          minSolLamports: floor.minSolLamports.toString(),
          targetSolLamports: floor.targetSolLamports.toString(),
          maxTopUpLamports: env.solanaPrefundMaxTopUpLamports.toString(),
          needsPrefund,
          prefundAvailable,
          blockingReason,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer: signerRaw },
          "Failed to compute Solana readiness",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to compute Solana readiness",
        });
      }
    },
  );

  z.post(
    "/wallets/solana/prefund/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: solanaPrefundPrepareBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signerRaw = request.walletAddress;
      if (!user || !signerRaw) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const requestedWallet = request.body.walletAddress?.trim() || signerRaw;
        if (!isSolanaAddress(requestedWallet) || !isSolanaAddress(signerRaw)) {
          reply.code(400);
          return reply.send({
            error: "Solana prefund requires a Solana wallet address",
          });
        }
        const signer = normalizeSolanaAddress(signerRaw);
        const walletAddress = normalizeSolanaAddress(requestedWallet);
        if (walletAddress !== signer) {
          reply.code(400);
          return reply.send({
            error: "walletAddress must match the selected wallet",
          });
        }

        const executionKey = `solana-prefund:${randomUUID()}`;
        const prepared = await prepareSolanaPrefundRequest({
          user,
          signer,
          operation: request.body.operation,
          amountInRaw: request.body.amountInRaw,
          executionKey,
        });
        const entry: SolanaPrefundPreparedCacheEntry = {
          expiresAt: Date.now() + SOLANA_PREFUND_PREPARED_TTL_SEC * 1000,
          signer,
          operation: request.body.operation,
          amountInRaw: request.body.amountInRaw,
          estimatedOutLamports: prepared.estimatedOutLamports.toString(),
          request: prepared.request,
          providerPayload: prepared.providerPayload,
        };
        await cacheSolanaPrefundPreparedRequest({
          signer,
          executionKey,
          entry,
          log: app.log,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signer,
          executionKey,
          operation: request.body.operation,
          amountInRaw: request.body.amountInRaw,
          estimatedOutLamports: prepared.estimatedOutLamports.toString(),
          transactionDigest: prepared.transactionDigest,
          quote: prepared.providerPayload,
          requests: [prepared.request],
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer: signerRaw },
          "Failed to prepare Solana prefund",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare Solana prefund",
        });
      }
    },
  );

  z.post(
    "/wallets/solana/prefund/execute",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: solanaPrefundExecuteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signerRaw = request.walletAddress;
      if (!user || !signerRaw) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const requestedWallet = request.body.walletAddress?.trim() || signerRaw;
        if (!isSolanaAddress(requestedWallet) || !isSolanaAddress(signerRaw)) {
          reply.code(400);
          return reply.send({
            error: "Solana prefund requires a Solana wallet address",
          });
        }
        const signer = normalizeSolanaAddress(signerRaw);
        const walletAddress = normalizeSolanaAddress(requestedWallet);
        if (walletAddress !== signer) {
          reply.code(400);
          return reply.send({
            error: "walletAddress must match the selected wallet",
          });
        }

        const result = await runEmbeddedExecutionSingleFlight({
          key: buildEmbeddedExecutionSingleFlightKey(
            "solana-prefund",
            "solana",
            signer,
            SOLANA_CHAIN_ID,
            request.body.executionKey,
          ),
          run: async () => {
            const entry = await readCachedSolanaPrefundPreparedRequest({
              signer,
              executionKey: request.body.executionKey,
              log: app.log,
            });
            if (!entry) {
              throw new Error(
                "Prepared Solana prefund expired. Refresh and try again.",
              );
            }
            await deleteCachedSolanaPrefundPreparedRequest({
              signer,
              executionKey: request.body.executionKey,
              log: app.log,
            });
            const signatures = await executeEmbeddedSolanaTransactionRequests({
              requests: [entry.request],
              signatures: request.body.signedRequests,
            });
            return {
              ok: true,
              signer,
              operation: entry.operation,
              amountInRaw: entry.amountInRaw,
              estimatedOutLamports: entry.estimatedOutLamports,
              signatures,
            };
          },
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            executionKey: request.body.executionKey,
            signer: signerRaw,
          },
          "Failed to execute Solana prefund",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to execute Solana prefund",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/ethereum/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedEvmPrepareBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedEthereumWalletContext({
          user,
          signer,
        });
        const requests = prepareEmbeddedEthereumTransactionRequests({
          context,
          chainId: request.body.chainId,
          transactions: request.body.transactions,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signer: context.signer,
          chainId: request.body.chainId,
          requests,
        });
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            signer: normalizeEvmAddress(signer),
          },
          "Failed to prepare embedded EVM transactions",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare embedded EVM transactions",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/ethereum/execute",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedEvmExecuteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedEthereumWalletContext({
          user,
          signer,
        });
        const result = await runEmbeddedExecutionSingleFlight({
          key: buildEmbeddedExecutionSingleFlightKey(
            "embedded-wallets",
            "ethereum",
            context.signer,
            request.body.chainId,
            request.body.executionKey,
          ),
          run: async () => {
            const requests = prepareEmbeddedEthereumTransactionRequests({
              context,
              chainId: request.body.chainId,
              transactions: request.body.transactions,
            });
            const transactionHashes =
              await executeEmbeddedEthereumTransactionRequests({
                chainId: request.body.chainId,
                requests,
                signatures: request.body.signedRequests,
              });
            return {
              ok: true,
              signer: context.signer,
              chainId: request.body.chainId,
              transactionHashes,
            };
          },
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            signer: normalizeEvmAddress(signer),
          },
          "Failed to execute embedded EVM transactions",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to execute embedded EVM transactions",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/solana/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedSolanaPrepareBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedSolanaWalletContext({
          user,
          signer,
        });
        const executionKey = request.body.executionKey ?? null;
        const requests = await prepareEmbeddedSolanaTransactionRequests({
          context,
          executionKey,
          transactions: request.body.transactions,
          embeddedSolanaSponsorshipEnabled: false,
          onSponsorBalanceFetchError: (error) => {
            app.log.warn(
              { error, userId: user.id, signer: context.signer },
              "Embedded Solana balance fetch failed",
            );
          },
        });
        await cacheEmbeddedSolanaPreparedRequests({
          signer: context.signer,
          executionKey,
          requests,
          log: app.log,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signer: context.signer,
          requests,
        });
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            signer,
          },
          "Failed to prepare embedded Solana transactions",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare embedded Solana transactions",
        });
      }
    },
  );

  z.post(
    "/wallets/embedded/solana/execute",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: embeddedSolanaExecuteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedSolanaWalletContext({
          user,
          signer,
        });
        const result = await runEmbeddedExecutionSingleFlight({
          key: buildEmbeddedExecutionSingleFlightKey(
            "embedded-wallets",
            "solana",
            context.signer,
            request.body.executionKey,
          ),
          run: async () => {
            const requests = await readCachedEmbeddedSolanaPreparedRequests({
              signer: context.signer,
              executionKey: request.body.executionKey,
              log: app.log,
            });
            if (!requests) {
              throw new Error(
                "Prepared Solana authorization expired. Refresh quote and try again.",
              );
            }
            const signatures = await executeEmbeddedSolanaTransactionRequests({
              requests,
              signatures: request.body.signedRequests,
            });
            return {
              ok: true,
              signer: context.signer,
              signatures,
            };
          },
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            executionKey: request.body.executionKey,
            signer,
          },
          "Failed to execute embedded Solana transactions",
        );
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to execute embedded Solana transactions",
        });
      }
    },
  );
};
