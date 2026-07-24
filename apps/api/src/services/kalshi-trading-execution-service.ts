import crypto from "node:crypto";

import { env } from "../env.js";
import {
  computeAcceptingOrders,
  readDflowNativeAcceptingOrders,
} from "../lib/market-availability.js";
import { isRecord } from "../lib/type-guards.js";
import { storeExecution } from "../repos/executions-repo.js";
import {
  amountUsd,
  buildTelegramTradeSourceMetadata,
  createCapability,
  createServerWalletClient,
  executePreparedTradeLifecycle,
  extractQuoteRaw,
  getPrivyWalletId,
  hasServerWalletClientConfig,
  loadMarketForVenue,
  normalizeSide,
  parsePreparedPayload,
  rawUsd,
  readiness,
  readString,
  SOLANA_CAIP2,
  tokenForSide,
  tradingError,
  verifyLinkedWallet,
  type PreparedPayloadBase,
} from "./api-trading-common.js";
import type {
  ApiTradingApplicationServiceInput,
  ApiVenueTradingExecutor,
} from "./api-trading-types.js";
import {
  extractDflowErrorMessage,
  extractDflowErrorCode,
  formatDflowUserMessage,
} from "./dflow-client.js";
import {
  buildDflowOrder,
  buildDflowSwap,
  quoteDflowTrade,
  submitDflowSignedTransaction,
} from "./dflow-trading-service.js";
import {
  finalizeKalshiExecutionEffects,
  type KalshiExecutionPurpose,
  mergeKalshiExecutionRaw,
  normalizeKalshiExecutionStatus,
  resolveKalshiExecutionSettlementStatus,
} from "./kalshi-executions.js";
import {
  hasFreshKalshiTradeEligibility,
  kalshiTradeEligibilityMessage,
} from "./kalshi-trade-eligibility.js";
import {
  validateKalshiDflowTransaction,
  type KalshiDflowTransactionFacts,
} from "./kalshi-dflow-transaction-safety.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaTokenBalanceByOwnerAndMint,
} from "./solana-rpc.js";
import type {
  ApplyTradeEffectsInput,
  PersistedTrade,
  PreparedTrade,
  SubmitPreparedTradeInput,
  SubmitResult,
  TradeEffectsResult,
  TradeIntent,
  KalshiTradeEligibility,
  TradeQuote,
  TradeQuoteInput,
  TradingReadiness,
  TradingReadinessInput,
} from "./trading-types.js";

type KalshiPreparedPayload = PreparedPayloadBase & {
  amountInRaw: string;
  amountOutRaw: string | null;
  inputMint: string;
  kind: "kalshi";
  outputMint: string;
  quoteId: string | null;
  quotePayload: unknown;
  swapPayload: unknown;
  transaction: string;
  validation: KalshiDflowTransactionFacts;
};

const capabilities = createCapability({
  authorizationMode: "embedded_privy_solana",
  supportsExecutionSync: true,
  venue: "kalshi",
});

const KALSHI_TX_FEE_SOL_LAMPORTS = 5_000_000n;
const KALSHI_MARKET_INIT_SOL_LAMPORTS = 20_000_000n;

export async function buildKalshiDflowOrderRoute(input: {
  query: {
    amount: string;
    feeAccount?: string | null;
    inputMint: string;
    outputMint: string;
    platformFeeBps?: number | null;
    platformFeeMode?: string | null;
    platformFeeScale?: number | null;
    slippageBps?: number | null;
    userPublicKey?: string | null;
  };
  userPublicKey: string;
}): Promise<
  | { ok: true; payload: unknown }
  | {
      ok: false;
      payload: {
        error: string;
        message?: string | null;
        payload: unknown;
        status: number;
      };
      routeNotFound: boolean;
      statusCode: number;
    }
> {
  const query = input.query;
  const upstream = await buildDflowOrder({
    baseUrl: env.dflowQuoteBase,
    timeoutMs: 15_000,
    apiKey: env.dflowApiKey,
    query: {
      inputMint: query.inputMint,
      outputMint: query.outputMint,
      amount: query.amount,
      userPublicKey: input.userPublicKey,
      ...(query.slippageBps != null ? { slippageBps: query.slippageBps } : {}),
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
    const code = extractDflowErrorCode(upstream.payload);
    const message = extractDflowErrorMessage(upstream.payload);
    const normalizedMessage = message?.toLowerCase() ?? "";
    return {
      ok: false,
      routeNotFound:
        normalizedMessage.includes("route not found") ||
        code === "route_not_found",
      statusCode: 502,
      payload: {
        error: userMessage ?? "DFlow order failed",
        status: upstream.status,
        message,
        payload: upstream.payload,
      },
    };
  }
  return { ok: true, payload: upstream.payload };
}

export async function quoteKalshiDflowRoute(input: {
  query: {
    amount: string;
    feeAccount?: string | null;
    inputMint: string;
    outputMint: string;
    platformFeeBps?: number | null;
    platformFeeMode?: string | null;
    platformFeeScale?: number | null;
    slippageBps?: number | null;
  };
}): Promise<
  | { ok: true; payload: unknown }
  | {
      ok: false;
      payload: {
        error: string;
        message?: string | null;
        payload: unknown;
        status: number;
      };
      routeNotFound: boolean;
      statusCode: number;
    }
> {
  const query = input.query;
  const upstream = await quoteDflowTrade({
    baseUrl: env.dflowQuoteBase,
    timeoutMs: 10_000,
    apiKey: env.dflowApiKey,
    query: {
      inputMint: query.inputMint,
      outputMint: query.outputMint,
      amount: query.amount,
      ...(query.slippageBps != null ? { slippageBps: query.slippageBps } : {}),
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
    const message = extractDflowErrorMessage(upstream.payload);
    const code = extractDflowErrorCode(upstream.payload);
    const normalizedMessage = message?.toLowerCase() ?? "";
    return {
      ok: false,
      routeNotFound:
        normalizedMessage.includes("route not found") ||
        code === "route_not_found",
      statusCode: 502,
      payload: {
        error: userMessage ?? "DFlow quote failed",
        status: upstream.status,
        message,
        payload: upstream.payload,
      },
    };
  }
  return { ok: true, payload: upstream.payload };
}

export async function buildKalshiDflowSwapRoute(input: {
  body: {
    dynamicComputeUnitLimit?: boolean;
    prioritizationFeeLamports?: number | string | null;
    quoteResponse: unknown;
    userPublicKey: string;
  };
}): Promise<
  | { ok: true; payload: unknown }
  | {
      ok: false;
      payload: {
        error: string;
        message?: string | null;
        payload: unknown;
        status: number;
      };
      statusCode: number;
    }
> {
  const upstream = await buildDflowSwap({
    baseUrl: env.dflowQuoteBase,
    timeoutMs: 15_000,
    apiKey: env.dflowApiKey,
    body: {
      userPublicKey: input.body.userPublicKey,
      quoteResponse: input.body.quoteResponse,
      ...(input.body.dynamicComputeUnitLimit !== undefined
        ? { dynamicComputeUnitLimit: input.body.dynamicComputeUnitLimit }
        : {}),
      ...(input.body.prioritizationFeeLamports !== undefined
        ? { prioritizationFeeLamports: input.body.prioritizationFeeLamports }
        : {}),
    },
  });
  if (!upstream.ok) {
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "DFlow swap failed",
        status: upstream.status,
        message: extractDflowErrorMessage(upstream.payload),
        payload: upstream.payload,
      },
    };
  }
  return { ok: true, payload: upstream.payload };
}

export async function submitKalshiDflowSignedTransactionRoute(input: {
  body: {
    maxRetries?: number | null;
    signedTransaction: string;
    skipPreflight?: boolean | null;
  };
}): Promise<
  | { ok: true; payload: { ok: true; signature: string } }
  | { ok: false; payload: { error: string }; statusCode: number }
> {
  try {
    const signature = await submitDflowSignedTransaction({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      signedTransaction: input.body.signedTransaction,
      ...(input.body.skipPreflight != null
        ? { skipPreflight: input.body.skipPreflight }
        : {}),
      ...(input.body.maxRetries != null
        ? { maxRetries: input.body.maxRetries }
        : {}),
    });
    return { ok: true, payload: { ok: true, signature } };
  } catch {
    return {
      ok: false,
      statusCode: 502,
      payload: { error: "DFlow submit failed" },
    };
  }
}

export async function recordKalshiDflowExecutionRoute(input: {
  body: {
    amountIn?: string | number | null;
    amountOut?: string | number | null;
    inputDecimals?: number | null;
    inputMint?: string | null;
    marketId?: string | null;
    outputDecimals?: number | null;
    outputMint?: string | null;
    purpose?: string | null;
    quoteId?: string | null;
    raw?: unknown;
    side?: string | null;
    status?: string | null;
    txSignature?: string | null;
    venueOrderId?: string | null;
  };
  logger?: ApiTradingApplicationServiceInput["logger"] | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  statusMode?: "legacy_client_status" | "verified";
  userId: string;
  walletAddress: string;
}): Promise<{
  execution: {
    amountIn: number | null;
    amountOut: number | null;
    createdAt: Date;
    id: string;
    inputDecimals: number | null;
    inputMint: string | null;
    outputDecimals: number | null;
    outputMint: string | null;
    outcome: string | null;
    quoteId: string | null;
    raw: unknown;
    side: string | null;
    status: string | null;
    txSignature: string | null;
    unifiedMarketId: string | null;
    updatedAt: Date;
    venue: string;
    venueOrderId: string | null;
  };
  ok: true;
  referralFirstTrade?: unknown;
}> {
  const clientExecutionStatus = normalizeKalshiExecutionStatus(
    input.body.status,
  );
  const executionPurpose: KalshiExecutionPurpose =
    input.body.purpose === "redeem" ? "redeem" : "trade";
  let executionStatus = clientExecutionStatus;
  let executionRaw = mergeKalshiExecutionRaw(input.body.raw, {
    clientStatus: clientExecutionStatus,
    purpose: executionPurpose,
  });
  const statusMode = input.statusMode ?? "verified";
  const txSignature = input.body.txSignature?.trim() || null;
  const isClientTerminal =
    clientExecutionStatus === "fulfilled" ||
    clientExecutionStatus === "no_fill" ||
    clientExecutionStatus === "failed";
  const rawRecord = isRecord(input.body.raw) ? input.body.raw : null;
  const executionMode =
    rawRecord?.executionMode === "sync" || rawRecord?.executionMode === "async"
      ? rawRecord.executionMode
      : null;

  if (statusMode === "verified" && txSignature) {
    try {
      const settlement = await resolveKalshiExecutionSettlementStatus({
        txSignature,
        executionMode,
        skipTxFallbackOnOrderNotReady: executionMode == null,
      });
      if (settlement) {
        executionStatus = settlement.status;
        executionRaw = mergeKalshiExecutionRaw(executionRaw, {
          settlement: settlement.settlementRaw,
        });
      }
    } catch (error) {
      if (isClientTerminal) {
        executionStatus = "submitted";
      }
      executionRaw = mergeKalshiExecutionRaw(executionRaw, {
        settlementVerificationError:
          error instanceof Error ? error.message : String(error),
      });
      input.logger?.warn?.(
        { error, txSignature, userId: input.userId },
        "Kalshi execution status verification failed",
      );
    }
  } else if (statusMode === "verified" && isClientTerminal) {
    executionStatus = "submitted";
  }
  const execution = await storeExecution(input.pool, {
    userId: input.userId,
    walletAddress: input.walletAddress,
    venue: "kalshi",
    unifiedMarketId: input.body.marketId ?? null,
    side: input.body.side ?? null,
    inputMint: input.body.inputMint ?? null,
    outputMint: input.body.outputMint ?? null,
    amountIn: input.body.amountIn ?? null,
    amountOut: input.body.amountOut ?? null,
    inputDecimals: input.body.inputDecimals ?? null,
    outputDecimals: input.body.outputDecimals ?? null,
    quoteId: input.body.quoteId ?? null,
    venueOrderId: input.body.venueOrderId ?? null,
    txSignature,
    status: executionStatus ?? null,
    raw: executionRaw,
  });
  const effects = await finalizeKalshiExecutionEffects(input.pool, {
    execution,
    purpose: executionPurpose,
    logger: input.logger ?? undefined,
  });

  return {
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
  };
}

function kalshiMarketOrderable(input: {
  acceptingOrders: boolean | null;
  closeTime: Date | null;
  expirationTime: Date | null;
  metadata: unknown;
  status: string | null;
}): boolean {
  return computeAcceptingOrders({
    venue: "kalshi",
    status: input.status,
    closeTime: input.closeTime,
    expirationTime: input.expirationTime,
    dflowNativeAcceptingOrders: readDflowNativeAcceptingOrders(input.metadata),
  });
}

function kalshiEligibilityReadiness(
  eligibility: KalshiTradeEligibility | null | undefined,
): TradingReadiness | null {
  if (hasFreshKalshiTradeEligibility(eligibility)) return null;
  const code = "kalshi_eligibility_refresh_required";
  const message = kalshiTradeEligibilityMessage(eligibility);
  return readiness("kalshi", capabilities, {
    ok: false,
    code,
    message,
    repair: { kind: "app_required", code, message },
    setupRequired: true,
  });
}

function evaluateKalshiFundingReadiness(input: {
  marketInitialized: boolean | null;
  solLamports: bigint;
  usdcAmount: bigint;
  usdcDecimals: number;
}): TradingReadiness {
  const requiredSolLamports =
    input.marketInitialized === false
      ? KALSHI_MARKET_INIT_SOL_LAMPORTS
      : KALSHI_TX_FEE_SOL_LAMPORTS;
  const maxExecutableBuyUsd =
    Number(input.usdcAmount) / 10 ** input.usdcDecimals;
  if (input.solLamports < requiredSolLamports) {
    return readiness("kalshi", capabilities, {
      ok: false,
      code: "kalshi_sol_funding_required",
      maxExecutableBuyUsd,
      message:
        input.marketInitialized === false
          ? "Kalshi wallet needs at least 0.02 SOL for market account setup."
          : "Kalshi wallet needs at least 0.005 SOL for transaction fees.",
      setupRequired: true,
    });
  }
  if (input.usdcAmount <= 0n) {
    return readiness("kalshi", capabilities, {
      ok: false,
      code: "kalshi_no_executable_funds",
      maxExecutableBuyUsd: 0,
      message: "No Kalshi USDC funds are available for bot trading.",
      setupRequired: true,
    });
  }
  return readiness("kalshi", capabilities, {
    ok: true,
    maxExecutableBuyUsd,
  });
}

export const kalshiTradingExecutionTestHooks = {
  evaluateFundingReadiness: evaluateKalshiFundingReadiness,
  eligibilityReadiness: kalshiEligibilityReadiness,
};

function requireFreshKalshiEligibility(intent: TradeIntent): void {
  if (
    hasFreshKalshiTradeEligibility(
      intent.executionAuthorization?.kalshiEligibility,
    )
  ) {
    return;
  }
  throw tradingError({
    code: "insufficient_readiness",
    message: "Open Hunch to refresh Kalshi eligibility before bot trading.",
    venue: "kalshi",
  });
}

async function getReadiness(
  ctx: ApiTradingApplicationServiceInput,
  input: TradingReadinessInput,
): Promise<TradingReadiness> {
  let targetMarket: Awaited<ReturnType<typeof loadMarketForVenue>> | null =
    null;
  if (input.action && input.action !== "BUY") {
    return readiness("kalshi", capabilities, {
      ok: false,
      code: "unsupported_capability",
      message: "Telegram bot trading currently supports buy only.",
    });
  }
  if (!input.privyWalletId) {
    return readiness("kalshi", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Selected wallet is missing a Privy wallet id.",
      setupRequired: true,
    });
  }
  if (!hasServerWalletClientConfig()) {
    return readiness("kalshi", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Server-side Privy wallet authorization is not configured.",
      setupRequired: true,
    });
  }
  if (input.walletChain !== "solana" || !input.walletAddress) {
    return readiness("kalshi", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Kalshi bot trading requires a verified Solana Trading Wallet.",
      setupRequired: true,
    });
  }
  if (
    !(await verifyLinkedWallet({
      pool: ctx.pool,
      userId: input.actor.userId,
      walletAddress: input.walletAddress,
      walletChain: input.walletChain,
    }))
  ) {
    return readiness("kalshi", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Selected wallet is no longer linked and verified.",
      setupRequired: true,
    });
  }
  if (input.target?.marketId) {
    const market = await loadMarketForVenue(
      ctx.pool,
      input.target.marketId,
      "kalshi",
    );
    targetMarket = market;
    if (
      !kalshiMarketOrderable({
        acceptingOrders: market.accepting_orders,
        closeTime: market.close_time,
        expirationTime: market.expiration_time,
        metadata: market.metadata,
        status: market.status,
      })
    ) {
      return readiness("kalshi", capabilities, {
        ok: false,
        code: "market_not_orderable",
        message: "Market is not currently open for orders.",
      });
    }
  }
  const storedEligibility = kalshiEligibilityReadiness(
    input.executionAuthorization?.kalshiEligibility,
  );
  if (storedEligibility) return storedEligibility;
  if (env.dflowRequireApiKey && !env.dflowApiKey) {
    return readiness("kalshi", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Kalshi/DFlow API key is not configured.",
      setupRequired: true,
    });
  }
  try {
    const [solLamports, usdc] = await Promise.all([
      fetchSolanaBalanceLamports({
        rpcUrls: env.solanaRpcUrls,
        timeoutMs: env.solanaRpcTimeoutMs,
        owner: input.walletAddress,
      }),
      fetchSolanaTokenBalanceByOwnerAndMint({
        rpcUrls: env.solanaRpcUrls,
        timeoutMs: env.solanaRpcTimeoutMs,
        owner: input.walletAddress,
        mint: env.solanaUsdcMint,
      }),
    ]);
    const usdcAmount = usdc?.amount ?? 0n;
    const usdcDecimals = usdc?.decimals ?? 6;
    return evaluateKalshiFundingReadiness({
      marketInitialized: targetMarket?.is_initialized ?? null,
      solLamports,
      usdcAmount,
      usdcDecimals,
    });
  } catch (error) {
    ctx.logger?.warn?.(
      {
        error,
        userId: input.actor.userId,
        walletAddress: input.walletAddress,
      },
      "Kalshi bot funding readiness check failed",
    );
    return readiness("kalshi", capabilities, {
      ok: false,
      code: "kalshi_balance_status_unavailable",
      message: "Kalshi wallet balances are temporarily unavailable.",
    });
  }
}

async function quote(
  ctx: ApiTradingApplicationServiceInput,
  input: TradeQuoteInput,
): Promise<TradeQuote> {
  const intent = input.intent;
  requireFreshKalshiEligibility(intent);
  const market = await loadMarketForVenue(
    ctx.pool,
    intent.target.marketId,
    "kalshi",
  );
  const side = normalizeSide(intent.outcome ?? intent.target.outcome);
  const tokenId = tokenForSide(market, side);
  if (
    !kalshiMarketOrderable({
      acceptingOrders: market.accepting_orders,
      closeTime: market.close_time,
      expirationTime: market.expiration_time,
      metadata: market.metadata,
      status: market.status,
    })
  ) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Market is not open for orders.",
      venue: "kalshi",
    });
  }

  const query = {
    inputMint: env.solanaUsdcMint,
    outputMint: tokenId.replace(/^sol:/, ""),
    amount: rawUsd(amountUsd(intent)),
    slippageBps: intent.slippageBps ?? 100,
  };
  const upstream = await quoteDflowTrade({
    baseUrl: env.dflowQuoteBase,
    timeoutMs: 10_000,
    apiKey: env.dflowApiKey,
    query,
  });
  if (!upstream.ok) {
    throw tradingError({
      code: "quote_unavailable",
      message:
        formatDflowUserMessage(upstream.payload) ??
        extractDflowErrorMessage(upstream.payload) ??
        "DFlow quote failed.",
      statusCode: 502,
      venue: "kalshi",
    });
  }
  return {
    venue: "kalshi",
    target: { ...intent.target, tokenId, raw: { market } },
    action: "BUY",
    amount: intent.amount,
    price: null,
    estimatedShares: null,
    estimatedNotionalUsd: amountUsd(intent),
    maxSpendUsd: amountUsd(intent),
    minReceiveShares: null,
    fees: {},
    expiresAt: new Date(Date.now() + 30_000),
    raw: { query, payload: upstream.payload },
  };
}

async function prepareTrade(
  ctx: ApiTradingApplicationServiceInput,
  input: { intent: TradeIntent; quote?: TradeQuote | null },
): Promise<PreparedTrade> {
  const intent = input.intent;
  requireFreshKalshiEligibility(intent);
  const market = await loadMarketForVenue(
    ctx.pool,
    intent.target.marketId,
    "kalshi",
  );
  const side = normalizeSide(intent.outcome ?? intent.target.outcome);
  const outputMint = tokenForSide(market, side).replace(/^sol:/, "");
  const quoted = input.quote ?? (await quote(ctx, { intent }));
  const rawQuote = extractQuoteRaw<{ payload?: unknown }>(quoted);
  const quotePayload = rawQuote?.payload ?? quoted.raw;
  const swap = await buildDflowSwap({
    baseUrl: env.dflowQuoteBase,
    timeoutMs: 15_000,
    apiKey: env.dflowApiKey,
    body: {
      userPublicKey: intent.walletAddress,
      quoteResponse: quotePayload,
      dynamicComputeUnitLimit: true,
    },
  });
  if (!swap.ok) {
    throw tradingError({
      code: "trade_submission_failed",
      message:
        extractDflowErrorMessage(swap.payload) ?? "DFlow swap build failed.",
      statusCode: 502,
      venue: "kalshi",
    });
  }
  const transaction =
    readString(isRecord(swap.payload) ? swap.payload.swapTransaction : null) ??
    readString(isRecord(swap.payload) ? swap.payload.transaction : null) ??
    readString(isRecord(swap.payload) ? swap.payload.tx : null);
  if (!transaction) {
    throw tradingError({
      code: "trade_submission_failed",
      message: "DFlow swap response did not include a transaction.",
      statusCode: 502,
      venue: "kalshi",
    });
  }
  const amountInRaw = rawUsd(amountUsd(intent));
  const amountOutRaw =
    readString(isRecord(quotePayload) ? quotePayload.outAmount : null) ??
    readString(isRecord(quotePayload) ? quotePayload.outputAmount : null);
  let validation: KalshiDflowTransactionFacts;
  try {
    validation = await validateKalshiDflowTransaction({
      amountInRaw,
      amountOutRaw,
      expectedInputMint: env.solanaUsdcMint,
      inputMint: env.solanaUsdcMint,
      outputMint,
      rpcTimeoutMs: env.solanaRpcTimeoutMs,
      rpcUrls: env.solanaRpcUrls,
      transaction,
      walletAddress: intent.walletAddress,
    });
  } catch {
    throw tradingError({
      code: "trade_submission_failed",
      message:
        "Kalshi transaction could not be validated. Refresh quote and try again.",
      statusCode: 502,
      venue: "kalshi",
    });
  }
  const payload: KalshiPreparedPayload = {
    kind: "kalshi",
    inputMint: env.solanaUsdcMint,
    outputMint,
    quotePayload,
    swapPayload: swap.payload,
    transaction,
    amountInRaw,
    amountOutRaw,
    quoteId:
      readString(isRecord(quotePayload) ? quotePayload.quoteId : null) ??
      readString(isRecord(quotePayload) ? quotePayload.id : null),
    validation,
  };
  return {
    preparedId: crypto.randomUUID(),
    venue: "kalshi",
    intent,
    quote: quoted,
    authorizationMode: "embedded_privy_solana",
    authorizationRequests: [],
    reconcileKeys: {
      amountInRaw: payload.amountInRaw,
      idempotencyKey: intent.idempotencyKey,
      inputMint: payload.inputMint,
      intentId: intent.id ?? null,
      outputMint: payload.outputMint,
      quoteId: payload.quoteId,
      transactionDigest: validation.transactionDigest,
      venue: "kalshi",
    },
    venuePayload: payload,
    expiresAt: new Date(Date.now() + 30_000),
  };
}

async function submitPreparedTrade(
  input: SubmitPreparedTradeInput,
): Promise<SubmitResult> {
  const prepared = input.prepared;
  requireFreshKalshiEligibility(prepared.intent);
  const payload = parsePreparedPayload<KalshiPreparedPayload>(
    prepared,
    "kalshi",
  );
  try {
    await validateKalshiDflowTransaction({
      amountInRaw: payload.validation.amountInRaw,
      amountOutRaw: payload.validation.amountOutRaw ?? payload.amountOutRaw,
      expectedInputMint: env.solanaUsdcMint,
      inputMint: payload.validation.inputMint,
      minOutRaw: payload.validation.minOutRaw,
      outputMint: payload.validation.outputMint,
      rpcTimeoutMs: env.solanaRpcTimeoutMs,
      rpcUrls: env.solanaRpcUrls,
      transaction: payload.transaction,
      walletAddress: prepared.intent.walletAddress,
    });
  } catch {
    throw tradingError({
      code: "trade_submission_failed",
      message:
        "Kalshi transaction could not be validated. Refresh quote and try again.",
      statusCode: 502,
      venue: "kalshi",
    });
  }
  await input.onBeforeBroadcast?.();
  const result =
    await createServerWalletClient().walletApi.solana.signAndSendTransaction({
      walletId: getPrivyWalletId(prepared.intent),
      transaction: payload.transaction,
      caip2: SOLANA_CAIP2,
    });
  if (!result.hash) {
    throw tradingError({
      code: "trade_submission_failed",
      message: "Privy did not return a Solana transaction signature.",
      venue: "kalshi",
    });
  }
  await input.onBroadcastSubmitted?.({
    venue: "kalshi",
    status: "submitted",
    venueOrderId: null,
    orderHash: null,
    txSignature: result.hash,
    price: null,
    size: null,
    raw: { prepared: payload, txSignature: result.hash },
  });
  return {
    venue: "kalshi",
    status: "submitted",
    venueOrderId: null,
    orderHash: null,
    txSignature: result.hash,
    price: null,
    size: null,
    raw: { prepared: payload, txSignature: result.hash },
  };
}

async function persistTrade(
  ctx: ApiTradingApplicationServiceInput,
  input: {
    intent: TradeIntent;
    prepared?: PreparedTrade | null;
    submitResult: SubmitResult;
  },
): Promise<PersistedTrade> {
  const payload = input.prepared
    ? parsePreparedPayload<KalshiPreparedPayload>(input.prepared, "kalshi")
    : null;
  if (!input.submitResult.txSignature || !payload) {
    throw tradingError({
      code: "trade_submission_failed",
      message: "Kalshi execution persistence requires a transaction signature.",
      venue: "kalshi",
    });
  }
  const execution = await storeExecution(ctx.pool, {
    userId: input.intent.actor.userId,
    walletAddress: input.intent.walletAddress,
    venue: "kalshi",
    unifiedMarketId: input.intent.target.marketId,
    side: input.intent.action,
    outcome: String(input.intent.outcome ?? input.intent.target.outcome ?? ""),
    inputMint: payload.inputMint,
    outputMint: payload.outputMint,
    amountIn: payload.amountInRaw,
    amountOut: payload.amountOutRaw,
    inputDecimals: 6,
    outputDecimals: 6,
    quoteId: payload.quoteId,
    txSignature: input.submitResult.txSignature,
    venueOrderId: input.submitResult.venueOrderId,
    status:
      normalizeKalshiExecutionStatus(input.submitResult.status) ?? "submitted",
    fundingReservation:
      input.submitResult.status === "no_fill"
        ? null
        : input.intent.fundingReservation,
    raw: mergeKalshiExecutionRaw(input.submitResult.raw, {
      ...buildTelegramTradeSourceMetadata(input),
      purpose: "trade",
    }),
  });
  return {
    venue: "kalshi",
    orderId: null,
    executionId: execution.id,
    venueOrderId: execution.venue_order_id,
    status: execution.status ?? "submitted",
    raw: execution,
  };
}

async function applyKalshiTradeEffects(
  ctx: ApiTradingApplicationServiceInput,
  input: ApplyTradeEffectsInput,
): Promise<TradeEffectsResult> {
  if (!input.persisted.executionId || !isRecord(input.persisted.raw)) {
    return { ok: true, notificationsCreated: 0 };
  }
  const effects = await finalizeKalshiExecutionEffects(ctx.pool, {
    execution: input.persisted.raw as Parameters<
      typeof finalizeKalshiExecutionEffects
    >[1]["execution"],
    purpose: "trade",
    logger: ctx.logger,
  });
  return {
    ok: true,
    referralFirstTrade: effects.referralFirstTrade,
    raw: effects,
  };
}

export function createKalshiTradingExecutionService(
  ctx: ApiTradingApplicationServiceInput,
): ApiVenueTradingExecutor {
  return {
    venue: "kalshi",
    capabilities: () => capabilities,
    getReadiness: (input) => getReadiness(ctx, input),
    quote: (input) => quote(ctx, input),
    prepareTrade: (input) =>
      prepareTrade(ctx, { intent: input.intent, quote: input.quote ?? null }),
    submitPreparedTrade,
    persistTrade: (input) => persistTrade(ctx, input),
    applyTradeEffects: (input) => applyKalshiTradeEffects(ctx, input),
    executePreparedTrade: (input) =>
      executePreparedTradeLifecycle({
        executeInput: input,
        submitPreparedTrade,
        persistTrade: (persistInput) => persistTrade(ctx, persistInput),
        applyTradeEffects: (effectsInput) =>
          applyKalshiTradeEffects(ctx, effectsInput),
      }),
  };
}
