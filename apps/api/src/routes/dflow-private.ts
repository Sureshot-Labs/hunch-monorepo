import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { publishMarketState } from "@hunch/infra";
import bs58 from "bs58";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { createAdminMiddleware, createAuthMiddleware } from "../auth.js";
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
import { storeExecution } from "../repos/executions-repo.js";
import {
  dflowRequest,
  extractDflowErrorCode,
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
  fetchSolanaLatestBlockhash,
  fetchSolanaSignatureStatus,
  fetchSolanaTokenBalanceByOwnerAndMint,
  formatUiAmount,
  sendSolanaRawTransaction,
  waitForSolanaSignatureConfirmation,
} from "../services/solana-rpc.js";
import {
  analyzeEmbeddedSolanaTransaction,
  computeEmbeddedSolanaMessageDigest,
  computeEmbeddedSolanaTransactionDigest,
  createEmbeddedSolanaSponsorshipIntent,
  readEmbeddedSolanaSponsorshipIntent,
  releaseEmbeddedSolanaSponsorshipBudget,
  reserveEmbeddedSolanaSponsorshipBudget,
  resolveEmbeddedSolanaActualSponsorshipDecision,
  shouldRequireEmbeddedSolanaSponsorshipRedis,
  type EmbeddedSolanaSponsorshipBudgetReservation,
  type EmbeddedSolanaSponsorshipLimits,
  type EmbeddedSolanaSponsorshipMode,
} from "../services/embedded-solana-sponsorship.js";
import { resolveEmbeddedSolanaWalletContext } from "../services/embedded-solana.js";
import { resolveAuthAccessPolicy } from "../services/runtime-policies.js";
import {
  KalshiLossReclaimLedgerDurabilityError,
  submitKalshiLossRentReclaim,
} from "../services/kalshi-loss-rent-reclaim.js";
import {
  DFLOW_PREDICTION_PROGRAM_ID,
  DFLOW_PROGRAM_ID,
  SOLANA_DFLOW_SPONSORSHIP_ALLOWED_PROGRAMS,
  normalizeSolanaPublicKey,
  resolveHunchSolanaSponsorKeypair,
} from "../services/solana-sponsorship-primitives.js";
import {
  dflowExecutionBodySchema,
  dflowOrderQuerySchema,
  dflowOrderStatusQuerySchema,
  dflowPredictionMarketInitBodySchema,
  dflowQuoteQuerySchema,
  dflowSponsoredSubmitBodySchema,
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

type DflowSponsorshipMarketState = {
  marketIds: string[];
  marketInitialized: boolean;
};

const DFLOW_SPONSORED_ALLOWED_PROGRAMS: ReadonlySet<string> = new Set(
  SOLANA_DFLOW_SPONSORSHIP_ALLOWED_PROGRAMS,
);
const SOLANA_TX_FEE_LAMPORTS = BigInt(5_000);
const DFLOW_SPONSORED_MAX_RETRIES = 2;
const DFLOW_SPONSORED_ATA_RENT_LAMPORTS = BigInt(2_100_000);

function normalizeKalshiMarketIdForStorage(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.includes(":") ? trimmed : `kalshi:${trimmed}`;
}

type DflowSponsorConfig = {
  enabled: boolean;
  sponsorKeypair: Keypair | null;
  sponsorAddress: string | null;
  sponsorshipMode: EmbeddedSolanaSponsorshipMode;
  sponsorshipLimits: EmbeddedSolanaSponsorshipLimits;
  decision: DflowSponsorshipDecision;
};

type DflowSponsoredValidationResult = {
  valid: boolean;
  reasons: string[];
  estimatedSponsorLamports: bigint;
  estimatedFeeLamports: bigint;
  systemCreateLamports: bigint;
};

type DflowSponsorshipDecision = {
  policyAllows: boolean;
  actualSponsorAllowed: boolean;
  reasons: string[];
};

type DflowOrderPurpose = "trade" | "redeem";

type DflowRentRecipientDecision = {
  outcomeAccountRentRecipient: string | null;
  outcomeAccountRentRecipientRole: "sponsor" | "user" | "none";
  reason:
    | "not_sponsored"
    | "sponsored_buy_new_outcome_account"
    | "unknown_provenance_user_recipient";
  outputCloseAuthority: string | null;
};

class DflowSponsoredSubmitLedgerDurabilityError extends Error {
  cause: unknown;
  signature: string;
  sponsorshipIntentId: string;
  transactionDigest: string;

  constructor(inputs: {
    signature: string;
    sponsorshipIntentId: string;
    transactionDigest: string;
    cause: unknown;
  }) {
    super("DFlow sponsored transaction submitted but ledger update failed.");
    this.name = "DflowSponsoredSubmitLedgerDurabilityError";
    this.signature = inputs.signature;
    this.sponsorshipIntentId = inputs.sponsorshipIntentId;
    this.transactionDigest = inputs.transactionDigest;
    this.cause = inputs.cause;
  }
}

type DflowOrderQueryParams = {
  inputMint: string;
  outputMint: string;
  amount: string;
  purpose?: DflowOrderPurpose;
  slippageBps?: number;
  platformFeeBps?: number;
  platformFeeScale?: number;
  platformFeeMode?: "inputMint" | "outputMint";
  feeAccount?: string;
};

type DflowOrderRequestResult =
  | { ok: true; payload: unknown }
  | { ok: false; status: number; payload: unknown };

type DflowOrderRequester = (inputs: {
  sponsored: boolean;
  query: Record<string, string | number | boolean | undefined>;
}) => Promise<DflowOrderRequestResult>;

type DflowSponsorshipOrderLogger = {
  warn: (obj: unknown, msg: string) => void;
};

type DflowSponsoredOrderFallbackReason =
  | "missing_transaction"
  | "blockhash_refresh_failed"
  | "validation_failed"
  | "budget_failed"
  | "intent_create_failed"
  | "sponsorship_error";

type DflowSponsoredOrderFinalizeResult =
  | { ok: true; payload: unknown; sponsored: true }
  | {
      ok: true;
      payload: unknown;
      sponsored: false;
      fallbackReason: DflowSponsoredOrderFallbackReason;
    }
  | {
      ok: false;
      status: number;
      payload: unknown;
      fallbackReason: DflowSponsoredOrderFallbackReason;
    };

function isSolanaWallet(address: string): boolean {
  return !address.startsWith("0x");
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function resolveDflowSponsorKeypair(): Keypair | null {
  return resolveHunchSolanaSponsorKeypair();
}

export function resolveDflowActualSponsorshipDecision(inputs: {
  embeddedSolanaSponsorship: boolean;
  dflowFlowEnabled: boolean;
  mode: EmbeddedSolanaSponsorshipMode;
  observeCanSponsor: boolean;
}): DflowSponsorshipDecision {
  return resolveEmbeddedSolanaActualSponsorshipDecision({
    embeddedSolanaSponsorship: inputs.embeddedSolanaSponsorship,
    flow: "dflow",
    flowEnabled: inputs.dflowFlowEnabled,
    mode: inputs.mode,
    observeCanSponsor: inputs.observeCanSponsor,
  });
}

async function resolveDflowSponsorConfig(): Promise<DflowSponsorConfig> {
  const policy = await resolveAuthAccessPolicy(pool);
  const decision = resolveDflowActualSponsorshipDecision({
    embeddedSolanaSponsorship:
      policy.effective.embeddedSolanaSponsorship === true,
    dflowFlowEnabled:
      policy.effective.embeddedSolanaSponsorshipFlows.dflow === true,
    mode: policy.effective.embeddedSolanaSponsorshipMode,
    observeCanSponsor: env.embeddedSolanaSponsorshipObserveCanSponsor,
  });
  if (!decision.actualSponsorAllowed) {
    return {
      enabled: false,
      sponsorKeypair: null,
      sponsorAddress: null,
      sponsorshipMode: policy.effective.embeddedSolanaSponsorshipMode,
      sponsorshipLimits: policy.effective.embeddedSolanaSponsorshipLimits,
      decision,
    };
  }

  const sponsorKeypair = resolveDflowSponsorKeypair();
  if (!sponsorKeypair) {
    throw new Error("DFlow sponsorship is enabled but sponsor key is missing");
  }
  return {
    enabled: true,
    sponsorKeypair,
    sponsorAddress: sponsorKeypair.publicKey.toBase58(),
    sponsorshipMode: policy.effective.embeddedSolanaSponsorshipMode,
    sponsorshipLimits: policy.effective.embeddedSolanaSponsorshipLimits,
    decision,
  };
}

function getIntentMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getIntentMetadataRecord(
  metadata: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getIntentMetadataBoolean(
  metadata: Record<string, unknown> | undefined,
  key: string,
): boolean {
  const value = metadata?.[key];
  return value === true;
}

function getIntentMetadataBigInt(
  metadata: Record<string, unknown> | undefined,
  key: string,
): bigint | null {
  const value = metadata?.[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return null;
}

function getIntentMetadataNonNegativeInt(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function getMaxSponsorLamports(): bigint {
  return BigInt(env.hunchSolanaSponsorMaxTxLamports);
}

function getDflowSponsoredFeeParams(inputs: {
  inputMint: string;
  outputMint: string;
}): Record<string, string | number> {
  const feeAccount = env.dflowFeeAccount?.trim() || "";
  if (!feeAccount) return {};

  const feeScale = env.feeScaleKalshi;
  if (Number.isFinite(feeScale) && feeScale > 0) {
    return { platformFeeScale: feeScale, feeAccount };
  }

  const feeBps = env.feeBpsKalshi;
  if (!Number.isFinite(feeBps) || feeBps <= 0) return {};
  const platformFeeMode =
    inputs.inputMint === env.solanaUsdcMint
      ? "inputMint"
      : inputs.outputMint === env.solanaUsdcMint
        ? "outputMint"
        : null;
  if (!platformFeeMode) return {};
  return { platformFeeBps: feeBps, platformFeeMode, feeAccount };
}

function getDflowUserFundedFeeParams(
  query: DflowOrderQueryParams,
): Record<string, string | number> {
  if (query.purpose === "redeem") return {};
  return getDflowSponsoredFeeParams({
    inputMint: query.inputMint,
    outputMint: query.outputMint,
  });
}

function resolveDflowRentRecipientDecision(inputs: {
  query: DflowOrderQueryParams;
  userPublicKey: string;
  sponsored: boolean;
  sponsorAddress?: string | null;
}): DflowRentRecipientDecision {
  const sponsorAddress = inputs.sponsorAddress?.trim() || null;
  if (!inputs.sponsored || !sponsorAddress) {
    return {
      outcomeAccountRentRecipient: null,
      outcomeAccountRentRecipientRole: "none",
      reason: "not_sponsored",
      outputCloseAuthority: null,
    };
  }

  const sponsoredBuy =
    (inputs.query.purpose ?? "trade") !== "redeem" &&
    inputs.query.inputMint === env.solanaUsdcMint &&
    inputs.query.outputMint !== env.solanaUsdcMint;
  if (sponsoredBuy) {
    return {
      outcomeAccountRentRecipient: sponsorAddress,
      outcomeAccountRentRecipientRole: "sponsor",
      reason: "sponsored_buy_new_outcome_account",
      outputCloseAuthority: sponsorAddress,
    };
  }

  return {
    outcomeAccountRentRecipient: inputs.userPublicKey,
    outcomeAccountRentRecipientRole: "user",
    reason: "unknown_provenance_user_recipient",
    outputCloseAuthority: null,
  };
}

function shouldAttributeRentToSponsor(
  metadata: Record<string, unknown> | undefined,
): boolean {
  const decision = getIntentMetadataRecord(metadata, "rentRecipientDecision");
  const role = getIntentMetadataString(
    decision ?? undefined,
    "outcomeAccountRentRecipientRole",
  );
  if (role === "sponsor") return true;
  if (role === "user" || role === "none") return false;
  return true;
}

export function buildDflowOrderRequestQuery(inputs: {
  query: DflowOrderQueryParams;
  userPublicKey: string;
  sponsored: boolean;
  sponsorAddress?: string | null;
}): Record<string, string | number | boolean | undefined> {
  const query = inputs.query;
  const sponsorAddress = inputs.sponsorAddress?.trim() || null;
  const rentRecipientDecision = resolveDflowRentRecipientDecision(inputs);
  return {
    inputMint: query.inputMint,
    outputMint: query.outputMint,
    amount: query.amount,
    userPublicKey: inputs.userPublicKey,
    ...(query.slippageBps != null ? { slippageBps: query.slippageBps } : {}),
    ...(inputs.sponsored
      ? query.purpose === "redeem"
        ? {}
        : getDflowSponsoredFeeParams({
            inputMint: query.inputMint,
            outputMint: query.outputMint,
          })
      : getDflowUserFundedFeeParams(query)),
    ...(inputs.sponsored && sponsorAddress
      ? {
          sponsor: sponsorAddress,
          sponsorExec: true,
          ...(rentRecipientDecision.outcomeAccountRentRecipient
            ? {
                outcomeAccountRentRecipient:
                  rentRecipientDecision.outcomeAccountRentRecipient,
              }
            : {}),
          ...(rentRecipientDecision.outputCloseAuthority
            ? {
                outputCloseAuthority:
                  rentRecipientDecision.outputCloseAuthority,
              }
            : {}),
        }
      : {}),
  };
}

async function requestDflowOrder(inputs: {
  query: DflowOrderQueryParams;
  userPublicKey: string;
  sponsored: boolean;
  sponsorAddress?: string | null;
  requester?: DflowOrderRequester;
}): Promise<DflowOrderRequestResult> {
  const orderQuery = buildDflowOrderRequestQuery({
    query: inputs.query,
    userPublicKey: inputs.userPublicKey,
    sponsored: inputs.sponsored,
    sponsorAddress: inputs.sponsorAddress,
  });
  if (inputs.requester) {
    return inputs.requester({ sponsored: inputs.sponsored, query: orderQuery });
  }
  return dflowRequest({
    baseUrl: env.dflowQuoteBase,
    timeoutMs: 15_000,
    method: "GET",
    requestPath: "/order",
    apiKey: env.dflowApiKey,
    query: orderQuery,
  });
}

function stripDflowSponsorshipFields(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const record = { ...(payload as Record<string, unknown>) };
  delete record.hunchSponsorshipIntentId;
  delete record.hunchSponsoredDflow;
  delete record.hunchSponsorAddress;
  return record;
}

async function fallbackToUserFundedDflowOrder(inputs: {
  query: DflowOrderQueryParams;
  userPublicKey: string;
  reason: DflowSponsoredOrderFallbackReason;
  requester: DflowOrderRequester;
}): Promise<DflowSponsoredOrderFinalizeResult> {
  const fallback = await requestDflowOrder({
    query: inputs.query,
    userPublicKey: inputs.userPublicKey,
    sponsored: false,
    requester: inputs.requester,
  });
  return fallback.ok
    ? {
        ok: true,
        payload: stripDflowSponsorshipFields(fallback.payload),
        sponsored: false,
        fallbackReason: inputs.reason,
      }
    : {
        ok: false,
        status: fallback.status,
        payload: fallback.payload,
        fallbackReason: inputs.reason,
      };
}

export async function finalizeDflowSponsoredOrderOrFallback(inputs: {
  payload: unknown;
  query: DflowOrderQueryParams;
  userId: string;
  walletAddress: string;
  userPublicKey: string;
  sponsorAddress: string;
  sponsorshipMarketState: DflowSponsorshipMarketState;
  sponsorshipLimits: EmbeddedSolanaSponsorshipLimits;
  sponsorshipMode: EmbeddedSolanaSponsorshipMode;
  requester: DflowOrderRequester;
  logger: DflowSponsorshipOrderLogger;
  refreshTransaction?: (transaction: string) => Promise<string>;
  computeMessageDigest?: (transaction: string) => string | null;
  analyzeTransaction?: typeof analyzeEmbeddedSolanaTransaction;
  validateSponsoredAnalysis?: typeof validateDflowSponsoredAnalysis;
  reserveBudget?: typeof reserveEmbeddedSolanaSponsorshipBudget;
  createIntent?: typeof createEmbeddedSolanaSponsorshipIntent;
  upsertLedger?: typeof upsertSolanaSponsorshipLedger;
  now?: () => Date;
}): Promise<DflowSponsoredOrderFinalizeResult> {
  const payloadRecord =
    inputs.payload &&
    typeof inputs.payload === "object" &&
    !Array.isArray(inputs.payload)
      ? ({ ...(inputs.payload as Record<string, unknown>) } as Record<
          string,
          unknown
        >)
      : null;
  const transactionKey = payloadRecord
    ? (["transaction", "swapTransaction", "swap_transaction"].find(
        (key) => typeof payloadRecord[key] === "string",
      ) ?? null)
    : null;
  let transaction = transactionKey
    ? String(payloadRecord?.[transactionKey])
    : null;
  if (!payloadRecord || !transaction) {
    return fallbackToUserFundedDflowOrder({
      query: inputs.query,
      userPublicKey: inputs.userPublicKey,
      reason: "missing_transaction",
      requester: inputs.requester,
    });
  }

  let budgetReservation: EmbeddedSolanaSponsorshipBudgetReservation | null =
    null;
  try {
    transaction = await (
      inputs.refreshTransaction ?? refreshUnsignedSolanaTransactionBlockhash
    )(transaction);
    payloadRecord[transactionKey ?? "transaction"] = transaction;
  } catch (error) {
    inputs.logger.warn(
      { error, userId: inputs.userId, walletAddress: inputs.walletAddress },
      "DFlow sponsored order blockhash refresh failed",
    );
    return fallbackToUserFundedDflowOrder({
      query: inputs.query,
      userPublicKey: inputs.userPublicKey,
      reason: "blockhash_refresh_failed",
      requester: inputs.requester,
    });
  }

  try {
    const maxSystemCreateLamports =
      extractNonNegativeLamportsFromRecord(payloadRecord, [
        "initPredictionMarketCost",
        "init_prediction_market_cost",
        "initPredictionMarketCostLamports",
      ]) ?? "0";
    const messageDigest = (
      inputs.computeMessageDigest ?? computeEmbeddedSolanaMessageDigest
    )(transaction);
    const rentRecipientDecision = resolveDflowRentRecipientDecision({
      query: inputs.query,
      userPublicKey: inputs.userPublicKey,
      sponsored: true,
      sponsorAddress: inputs.sponsorAddress,
    });
    const expectedAtaCreateCount =
      inputs.query.outputMint !== env.solanaUsdcMint ? 1 : 0;
    const expectedDflowOutcomeRentLamports = "0";
    const sponsorshipMetadata = {
      purpose: inputs.query.purpose ?? "trade",
      inputMint: inputs.query.inputMint,
      outputMint: inputs.query.outputMint,
      amount: inputs.query.amount,
      marketIds: inputs.sponsorshipMarketState.marketIds,
      marketInitialized: true,
      maxSystemCreateLamports: "0",
      allowAtaCreation: expectedAtaCreateCount > 0,
      maxAtaCreateCount: expectedAtaCreateCount,
      expectedDflowOutcomeRentLamports,
      messageDigest,
      sponsorAddress: inputs.sponsorAddress,
      hunchSponsoredDflow: true,
      rentRecipientDecision,
    };
    const analysis = (
      inputs.analyzeTransaction ?? analyzeEmbeddedSolanaTransaction
    )({
      signer: inputs.userPublicKey,
      transaction,
      includeRaw: false,
    });
    const validation =
      messageDigest != null
        ? (inputs.validateSponsoredAnalysis ?? validateDflowSponsoredAnalysis)({
            analysis,
            userWalletAddress: inputs.userPublicKey,
            sponsorAddress: inputs.sponsorAddress,
            metadata: sponsorshipMetadata,
            requireUserSignatureSlot: true,
          })
        : null;
    if (
      inputs.sponsorshipMarketState.marketInitialized !== true ||
      !messageDigest ||
      maxSystemCreateLamports !== "0" ||
      validation?.valid !== true
    ) {
      inputs.logger.warn(
        {
          userId: inputs.userId,
          walletAddress: inputs.walletAddress,
          validationReasons: validation?.reasons ?? [],
          maxSystemCreateLamports,
        },
        "DFlow order response was not eligible for sponsorship",
      );
      return fallbackToUserFundedDflowOrder({
        query: inputs.query,
        userPublicKey: inputs.userPublicKey,
        reason: "validation_failed",
        requester: inputs.requester,
      });
    }

    const requireDurableSponsorship =
      shouldRequireEmbeddedSolanaSponsorshipRedis({
        mode: inputs.sponsorshipMode,
        observeCanSponsor: env.embeddedSolanaSponsorshipObserveCanSponsor,
      });
    const budget = await (
      inputs.reserveBudget ?? reserveEmbeddedSolanaSponsorshipBudget
    )({
      flow: "dflow",
      walletAddress: inputs.userPublicKey,
      estimatedLamports: validation.estimatedSponsorLamports.toString(),
      limits: inputs.sponsorshipLimits,
      requireRedis: requireDurableSponsorship,
    });
    if (!budget.ok) {
      inputs.logger.warn(
        {
          userId: inputs.userId,
          walletAddress: inputs.walletAddress,
          reasons: budget.reasons,
        },
        "DFlow sponsorship budget reservation failed",
      );
      return fallbackToUserFundedDflowOrder({
        query: inputs.query,
        userPublicKey: inputs.userPublicKey,
        reason: "budget_failed",
        requester: inputs.requester,
      });
    }
    budgetReservation = budget.reservation ?? null;

    const intent = await (
      inputs.createIntent ?? createEmbeddedSolanaSponsorshipIntent
    )({
      flow: "dflow",
      userId: inputs.userId,
      signer: inputs.userPublicKey,
      transaction,
      requireDurable: requireDurableSponsorship,
      metadata: {
        ...sponsorshipMetadata,
        budgetReserved: true,
        budgetEstimatedLamports: validation.estimatedSponsorLamports.toString(),
        budgetReservedAt: (inputs.now ?? (() => new Date()))().toISOString(),
      },
    });
    if (!intent) {
      await releaseEmbeddedSolanaSponsorshipBudget(budgetReservation);
      budgetReservation = null;
      inputs.logger.warn(
        { userId: inputs.userId, walletAddress: inputs.walletAddress },
        "DFlow sponsorship intent creation failed",
      );
      return fallbackToUserFundedDflowOrder({
        query: inputs.query,
        userPublicKey: inputs.userPublicKey,
        reason: "intent_create_failed",
        requester: inputs.requester,
      });
    }

    payloadRecord.hunchSponsorshipIntentId = intent.id;
    payloadRecord.hunchSponsoredDflow = true;
    payloadRecord.hunchSponsorAddress = inputs.sponsorAddress;

    const estimatedNonFeeLamports =
      validation.estimatedSponsorLamports > validation.estimatedFeeLamports
        ? validation.estimatedSponsorLamports - validation.estimatedFeeLamports
        : BigInt(0);
    const sponsorRentRecipient =
      rentRecipientDecision.outcomeAccountRentRecipientRole === "sponsor";
    try {
      await (inputs.upsertLedger ?? upsertSolanaSponsorshipLedger)({
        userId: inputs.userId,
        walletAddress: inputs.walletAddress,
        sponsorAddress: inputs.sponsorAddress,
        intentId: intent.id,
        status: "intent_created",
        inputMint: inputs.query.inputMint,
        outputMint: inputs.query.outputMint,
        amountRaw: inputs.query.amount,
        marketId: inputs.sponsorshipMarketState.marketIds[0] ?? null,
        messageDigest,
        transactionDigest: intent.transactionDigest,
        estimatedSponsorLamports:
          validation.estimatedSponsorLamports.toString(),
        rentLamports:
          sponsorRentRecipient && estimatedNonFeeLamports > BigInt(0)
            ? estimatedNonFeeLamports.toString()
            : null,
        rentStatus:
          sponsorRentRecipient && estimatedNonFeeLamports > BigInt(0)
            ? "locked"
            : "unknown",
        metadata: {
          purpose: inputs.query.purpose ?? "trade",
          marketIds: inputs.sponsorshipMarketState.marketIds,
          maxSystemCreateLamports: "0",
          maxAtaCreateCount: expectedAtaCreateCount,
          expectedDflowOutcomeRentLamports,
          rentRecipientDecision,
          budgetReserved: true,
          budgetEstimatedLamports:
            validation.estimatedSponsorLamports.toString(),
          blockhashRefreshed: true,
        },
      });
    } catch (error) {
      await releaseEmbeddedSolanaSponsorshipBudget(budgetReservation);
      budgetReservation = null;
      throw error;
    }

    return { ok: true, payload: payloadRecord, sponsored: true };
  } catch (error) {
    await releaseEmbeddedSolanaSponsorshipBudget(budgetReservation);
    inputs.logger.warn(
      { error, userId: inputs.userId, walletAddress: inputs.walletAddress },
      "Failed to create DFlow Solana sponsorship intent",
    );
    return fallbackToUserFundedDflowOrder({
      query: inputs.query,
      userPublicKey: inputs.userPublicKey,
      reason: "sponsorship_error",
      requester: inputs.requester,
    });
  }
}

function validateDflowSponsoredAnalysis(inputs: {
  analysis: ReturnType<typeof analyzeEmbeddedSolanaTransaction>;
  userWalletAddress: string;
  sponsorAddress: string;
  metadata: Record<string, unknown> | undefined;
  requireUserSignatureSlot: boolean;
  requireOutcomeMint?: string | null;
  allowPredictionInit?: boolean;
}): DflowSponsoredValidationResult {
  const reasons: string[] = [];
  const analysis = inputs.analysis;
  const systemCreateLamports = BigInt(analysis.systemCreateLamports);
  const maxSponsorLamports = getMaxSponsorLamports();
  const ataRentLamports =
    BigInt(analysis.ataCreateCount) * DFLOW_SPONSORED_ATA_RENT_LAMPORTS;
  const expectedDflowOutcomeRentLamports =
    getIntentMetadataBigInt(
      inputs.metadata,
      "expectedDflowOutcomeRentLamports",
    ) ?? BigInt(0);
  const signatureFeeLamports =
    SOLANA_TX_FEE_LAMPORTS * BigInt(Math.max(1, analysis.signatureCount));
  const estimatedSponsorLamports =
    signatureFeeLamports +
    systemCreateLamports +
    ataRentLamports +
    expectedDflowOutcomeRentLamports;

  if (!analysis.ok) reasons.push("malformed_transaction");
  if (analysis.usesAddressLookupTables) reasons.push("address_lookup_tables");
  if (analysis.hasNativeSolTransfer) reasons.push("native_sol_transfer");
  if (analysis.hasSyncNative) reasons.push("wrapped_sol_sync");
  if (analysis.feePayer !== inputs.sponsorAddress) {
    reasons.push("fee_payer_mismatch");
  }

  const expectedSigners = inputs.requireUserSignatureSlot
    ? new Set([inputs.sponsorAddress, inputs.userWalletAddress])
    : new Set([inputs.sponsorAddress]);
  if (
    analysis.signerAddresses.length !== expectedSigners.size ||
    analysis.signerAddresses.some((signer) => !expectedSigners.has(signer))
  ) {
    reasons.push("signer_mismatch");
  }

  const unknownProgramIds = analysis.programIds.filter(
    (programId) => !DFLOW_SPONSORED_ALLOWED_PROGRAMS.has(programId),
  );
  if (unknownProgramIds.length) reasons.push("unknown_program");

  const hasDflowInstruction = analysis.instructions.some(
    (instruction) =>
      instruction.programId === DFLOW_PROGRAM_ID ||
      instruction.programId === DFLOW_PREDICTION_PROGRAM_ID,
  );
  if (!hasDflowInstruction) reasons.push("missing_dflow_instruction");

  if (inputs.allowPredictionInit === true) {
    const hasPredictionInstruction = analysis.instructions.some(
      (instruction) => instruction.programId === DFLOW_PREDICTION_PROGRAM_ID,
    );
    if (!hasPredictionInstruction) reasons.push("missing_prediction_init");
    if (
      inputs.requireOutcomeMint &&
      !analysis.instructions.some((instruction) =>
        instruction.accountAddresses.includes(inputs.requireOutcomeMint ?? ""),
      )
    ) {
      reasons.push("outcome_mint_mismatch");
    }
  }

  const maxSystemCreateLamports = getIntentMetadataBigInt(
    inputs.metadata,
    "maxSystemCreateLamports",
  );
  if (
    systemCreateLamports > BigInt(0) &&
    (maxSystemCreateLamports == null ||
      systemCreateLamports > maxSystemCreateLamports)
  ) {
    reasons.push("unpriced_system_rent");
  }

  const maxAtaCreateCount = getIntentMetadataNonNegativeInt(
    inputs.metadata,
    "maxAtaCreateCount",
  );
  const allowAtaCreation =
    getIntentMetadataBoolean(inputs.metadata, "allowAtaCreation") === true;
  if (
    analysis.ataCreateCount > 0 &&
    (!allowAtaCreation ||
      maxAtaCreateCount == null ||
      analysis.ataCreateCount > maxAtaCreateCount)
  ) {
    reasons.push("unpriced_ata_creation");
  }

  if (estimatedSponsorLamports > maxSponsorLamports) {
    reasons.push("sponsor_cost_exceeds_cap");
  }

  return {
    valid: reasons.length === 0,
    reasons,
    estimatedSponsorLamports,
    estimatedFeeLamports: signatureFeeLamports,
    systemCreateLamports,
  };
}

function getSignedTransactionSignerAddresses(
  tx: VersionedTransaction,
): string[] {
  return tx.message.staticAccountKeys
    .slice(0, tx.message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
}

function signerHasNonZeroSignature(
  tx: VersionedTransaction,
  signerAddress: string,
): boolean {
  const signerIndex =
    getSignedTransactionSignerAddresses(tx).indexOf(signerAddress);
  if (signerIndex < 0) return false;
  const signature = tx.signatures[signerIndex];
  return Boolean(signature?.some((byte) => byte !== 0));
}

function getVersionedTransactionSignature(
  tx: VersionedTransaction,
): string | null {
  const signature = tx.signatures[0];
  if (!signature || !signature.some((byte) => byte !== 0)) return null;
  return bs58.encode(Buffer.from(signature));
}

function hasAnyNonZeroSignature(tx: VersionedTransaction): boolean {
  return tx.signatures.some((signature) =>
    signature.some((byte) => byte !== 0),
  );
}

async function refreshUnsignedSolanaTransactionBlockhash(
  transaction: string,
): Promise<string> {
  const tx = VersionedTransaction.deserialize(
    Buffer.from(transaction, "base64"),
  );
  if (hasAnyNonZeroSignature(tx)) {
    throw new Error("Cannot refresh blockhash on a pre-signed transaction");
  }
  const latestBlockhash = await fetchSolanaLatestBlockhash({
    rpcUrls: env.solanaRpcUrls,
    timeoutMs: env.solanaRpcTimeoutMs,
  });
  if (!latestBlockhash) {
    throw new Error("Solana RPC did not return latest blockhash");
  }
  tx.message.recentBlockhash = latestBlockhash.blockhash;
  return encodeBase64(tx.serialize());
}

async function upsertSolanaSponsorshipLedger(inputs: {
  userId: string | null;
  walletAddress: string;
  sponsorAddress: string;
  intentId: string;
  status: string;
  inputMint?: string | null;
  outputMint?: string | null;
  amountRaw?: string | null;
  marketId?: string | null;
  messageDigest?: string | null;
  transactionDigest?: string | null;
  txSignature?: string | null;
  estimatedSponsorLamports?: string | null;
  rentLamports?: string | null;
  rentStatus?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `
      insert into solana_sponsorship_ledger (
        user_id,
        venue,
        flow,
        status,
        intent_id,
        wallet_address,
        sponsor_address,
        market_id,
        input_mint,
        output_mint,
        amount_raw,
        message_digest,
        transaction_digest,
        tx_signature,
        estimated_sponsor_lamports,
        rent_lamports,
        rent_status,
        error,
        metadata
      )
      values (
        $1, 'kalshi', 'dflow', $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17
      )
      on conflict (intent_id) where intent_id is not null
      do update set
        updated_at = now(),
        status = case
          when coalesce(
            array_position(
              array['created', 'intent_created', 'user_signed', 'submitted', 'failed', 'confirmed'],
              excluded.status
            ),
            0
          ) >= coalesce(
            array_position(
              array['created', 'intent_created', 'user_signed', 'submitted', 'failed', 'confirmed'],
              solana_sponsorship_ledger.status
            ),
            0
          )
            then excluded.status
          else solana_sponsorship_ledger.status
        end,
        tx_signature = coalesce(excluded.tx_signature, solana_sponsorship_ledger.tx_signature),
        transaction_digest = coalesce(excluded.transaction_digest, solana_sponsorship_ledger.transaction_digest),
        estimated_sponsor_lamports = greatest(
          solana_sponsorship_ledger.estimated_sponsor_lamports,
          excluded.estimated_sponsor_lamports
        ),
        rent_lamports = coalesce(excluded.rent_lamports, solana_sponsorship_ledger.rent_lamports),
        rent_status = coalesce(excluded.rent_status, solana_sponsorship_ledger.rent_status),
        error = case
          when solana_sponsorship_ledger.status = 'confirmed'
            and excluded.status = 'failed'
            then solana_sponsorship_ledger.error
          else coalesce(excluded.error, solana_sponsorship_ledger.error)
        end,
        metadata = solana_sponsorship_ledger.metadata || excluded.metadata
    `,
    [
      inputs.userId,
      inputs.status,
      inputs.intentId,
      inputs.walletAddress,
      inputs.sponsorAddress,
      inputs.marketId ?? null,
      inputs.inputMint ?? null,
      inputs.outputMint ?? null,
      inputs.amountRaw ?? null,
      inputs.messageDigest ?? null,
      inputs.transactionDigest ?? null,
      inputs.txSignature ?? null,
      inputs.estimatedSponsorLamports ?? "0",
      inputs.rentLamports ?? null,
      inputs.rentStatus ?? null,
      inputs.error ?? null,
      JSON.stringify(inputs.metadata ?? {}),
    ],
  );
}

async function signAndBroadcastSponsoredDflowTransaction(inputs: {
  userId: string;
  walletAddress: string;
  sponsorshipIntentId: string;
  signedTransaction: string;
  maxRetries?: number;
  logger?: Pick<DflowSponsorshipOrderLogger, "warn">;
}): Promise<{ signature: string; sponsoredTransaction: string }> {
  const sponsorConfig = await resolveDflowSponsorConfig();
  if (
    !sponsorConfig.enabled ||
    !sponsorConfig.sponsorKeypair ||
    !sponsorConfig.sponsorAddress
  ) {
    throw new Error("DFlow sponsorship is disabled");
  }

  const intent = await readEmbeddedSolanaSponsorshipIntent(
    inputs.sponsorshipIntentId,
  );
  if (!intent) throw new Error("Missing or expired DFlow sponsorship intent");
  if (intent.flow !== "dflow") throw new Error("Invalid sponsorship flow");
  if (intent.userId !== inputs.userId) {
    throw new Error("DFlow sponsorship intent user mismatch");
  }
  if (intent.signer !== inputs.walletAddress) {
    throw new Error("DFlow sponsorship intent wallet mismatch");
  }
  if (getIntentMetadataBoolean(intent.metadata, "marketInitialized") !== true) {
    throw new Error("Market is not initialized for gasless DFlow trading yet.");
  }
  if (getIntentMetadataBoolean(intent.metadata, "budgetReserved") !== true) {
    throw new Error("DFlow sponsorship budget was not reserved");
  }

  const sponsorKeypair = sponsorConfig.sponsorKeypair;
  const sponsorAddress = sponsorKeypair.publicKey.toBase58();
  const intentSponsorAddress = getIntentMetadataString(
    intent.metadata,
    "sponsorAddress",
  );
  if (intentSponsorAddress && intentSponsorAddress !== sponsorAddress) {
    throw new Error("DFlow sponsorship intent sponsor mismatch");
  }

  const txBytes = Buffer.from(inputs.signedTransaction.trim(), "base64");
  const tx = VersionedTransaction.deserialize(txBytes);
  const messageDigest = computeEmbeddedSolanaMessageDigest(
    inputs.signedTransaction,
  );
  const intentMessageDigest = getIntentMetadataString(
    intent.metadata,
    "messageDigest",
  );
  if (!messageDigest || messageDigest !== intentMessageDigest) {
    throw new Error("DFlow sponsorship transaction mismatch");
  }

  const signerAddresses = getSignedTransactionSignerAddresses(tx);
  if (
    signerAddresses.length !== 2 ||
    !signerAddresses.includes(inputs.walletAddress) ||
    !signerAddresses.includes(sponsorAddress)
  ) {
    throw new Error("DFlow sponsored transaction signer mismatch");
  }
  if (!signerHasNonZeroSignature(tx, inputs.walletAddress)) {
    throw new Error("DFlow sponsored transaction is not user-signed");
  }

  const analysis = analyzeEmbeddedSolanaTransaction({
    signer: inputs.walletAddress,
    transaction: inputs.signedTransaction,
    includeRaw: false,
  });
  if (!analysis.ok) {
    throw new Error(analysis.malformedReason ?? "Malformed Solana transaction");
  }
  const validation = validateDflowSponsoredAnalysis({
    analysis,
    userWalletAddress: inputs.walletAddress,
    sponsorAddress,
    metadata: intent.metadata,
    requireUserSignatureSlot: true,
  });
  if (!validation.valid) {
    throw new Error(
      `DFlow sponsored transaction rejected: ${validation.reasons[0]}`,
    );
  }
  const inputMint = getIntentMetadataString(intent.metadata, "inputMint");
  const outputMint = getIntentMetadataString(intent.metadata, "outputMint");
  const amountRaw = getIntentMetadataString(intent.metadata, "amount");
  const marketId =
    Array.isArray(intent.metadata?.marketIds) &&
    typeof intent.metadata.marketIds[0] === "string"
      ? intent.metadata.marketIds[0]
      : null;
  const estimatedSponsorLamports =
    validation.estimatedSponsorLamports.toString();
  const estimatedNonFeeLamports =
    validation.estimatedSponsorLamports > validation.estimatedFeeLamports
      ? validation.estimatedSponsorLamports - validation.estimatedFeeLamports
      : BigInt(0);
  const rentRecipientDecision = getIntentMetadataRecord(
    intent.metadata,
    "rentRecipientDecision",
  );
  const sponsorRentRecipient = shouldAttributeRentToSponsor(intent.metadata);

  const policy = await resolveAuthAccessPolicy(pool);
  if (
    policy.effective.embeddedSolanaSponsorship !== true ||
    policy.effective.embeddedSolanaSponsorshipFlows.dflow !== true ||
    (policy.effective.embeddedSolanaSponsorshipMode !== "enforce" &&
      env.embeddedSolanaSponsorshipObserveCanSponsor !== true)
  ) {
    throw new Error("DFlow sponsorship is disabled");
  }

  tx.sign([sponsorKeypair]);
  const sponsoredTransaction = encodeBase64(tx.serialize());
  const sponsoredTransactionDigest =
    computeEmbeddedSolanaTransactionDigest(sponsoredTransaction);
  const expectedSignature = getVersionedTransactionSignature(tx);
  if (!sponsoredTransactionDigest || !expectedSignature) {
    throw new Error("DFlow sponsored transaction could not be signed");
  }

  await upsertSolanaSponsorshipLedger({
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    sponsorAddress,
    intentId: intent.id,
    status: "user_signed",
    inputMint,
    outputMint,
    amountRaw,
    marketId,
    messageDigest,
    transactionDigest: sponsoredTransactionDigest,
    txSignature: expectedSignature,
    estimatedSponsorLamports,
    rentLamports:
      sponsorRentRecipient && estimatedNonFeeLamports > BigInt(0)
        ? estimatedNonFeeLamports.toString()
        : null,
    rentStatus:
      sponsorRentRecipient && estimatedNonFeeLamports > BigInt(0)
        ? "locked"
        : "unknown",
    metadata: {
      signerAddresses,
      programIds: analysis.programIds,
      ataCreateCount: analysis.ataCreateCount,
      systemCreateLamports: analysis.systemCreateLamports,
      sponsorSignedAt: new Date().toISOString(),
      ...(rentRecipientDecision ? { rentRecipientDecision } : {}),
    },
  });

  let signature: string;
  try {
    signature = await sendSolanaRawTransaction({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      signedTransaction: sponsoredTransaction,
      skipPreflight: false,
      maxRetries: Math.min(
        Math.max(
          Math.trunc(inputs.maxRetries ?? DFLOW_SPONSORED_MAX_RETRIES),
          0,
        ),
        DFLOW_SPONSORED_MAX_RETRIES,
      ),
    });
  } catch (error) {
    await upsertSolanaSponsorshipLedger({
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
      sponsorAddress,
      intentId: intent.id,
      status: "failed",
      inputMint,
      outputMint,
      amountRaw,
      marketId,
      messageDigest,
      transactionDigest: sponsoredTransactionDigest,
      txSignature: expectedSignature,
      estimatedSponsorLamports,
      rentLamports:
        sponsorRentRecipient && estimatedNonFeeLamports > BigInt(0)
          ? estimatedNonFeeLamports.toString()
          : null,
      rentStatus: "unknown",
      error: error instanceof Error ? error.message : String(error),
      metadata: {
        ...(rentRecipientDecision ? { rentRecipientDecision } : {}),
      },
    });
    throw error;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await upsertSolanaSponsorshipLedger({
        userId: inputs.userId,
        walletAddress: inputs.walletAddress,
        sponsorAddress,
        intentId: intent.id,
        status: "submitted",
        inputMint,
        outputMint,
        amountRaw,
        marketId,
        messageDigest,
        transactionDigest: sponsoredTransactionDigest,
        txSignature: signature,
        estimatedSponsorLamports,
        rentLamports:
          sponsorRentRecipient && estimatedNonFeeLamports > BigInt(0)
            ? estimatedNonFeeLamports.toString()
            : null,
        rentStatus:
          sponsorRentRecipient && estimatedNonFeeLamports > BigInt(0)
            ? "locked"
            : "unknown",
        metadata: {
          submittedAt: new Date().toISOString(),
          ...(rentRecipientDecision ? { rentRecipientDecision } : {}),
        },
      });
      break;
    } catch (error) {
      if (attempt === 1) {
        inputs.logger?.warn(
          {
            error,
            intentId: intent.id,
            signature,
            transactionDigest: sponsoredTransactionDigest,
          },
          "DFlow sponsored transaction broadcast succeeded but ledger submit update failed",
        );
        throw new DflowSponsoredSubmitLedgerDurabilityError({
          cause: error,
          signature,
          sponsorshipIntentId: intent.id,
          transactionDigest: sponsoredTransactionDigest,
        });
      }
    }
  }

  return { signature, sponsoredTransaction };
}

async function markDflowMarketInitializedByMint(inputs: {
  outcomeMint: string;
  marketId?: string | null;
  signature: string;
}): Promise<number> {
  const prefixedMint = `sol:${inputs.outcomeMint}`;
  const result = await pool.query(
    `
      update unified_markets
      set
        is_initialized = true,
        updated_at = now(),
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'dflowPreinitializedAt', now(),
          'dflowPreinitSignature', $3
      )
      where venue = 'kalshi'
        and ($4::text is null or id = $4)
        and (
          token_yes = $1
          or token_no = $1
          or token_yes = $2
          or token_no = $2
        )
    `,
    [
      prefixedMint,
      inputs.outcomeMint,
      inputs.signature,
      inputs.marketId ?? null,
    ],
  );
  return result.rowCount ?? 0;
}

type DflowPredictionMarketInitCandidate =
  | { ok: true; marketId: string }
  | { ok: false; status: number; error: string; marketIds?: string[] };

async function resolveDflowPredictionMarketInitCandidate(
  outcomeMint: string,
): Promise<DflowPredictionMarketInitCandidate> {
  const trimmed = outcomeMint.trim();
  const rawMint = normalizeSolanaPublicKey(
    trimmed.startsWith("sol:") ? trimmed.slice(4) : trimmed,
  );
  if (!rawMint) {
    return {
      ok: false,
      status: 400,
      error: "Outcome mint must be a valid Solana address",
    };
  }
  const prefixedMint = `sol:${rawMint}`;
  const { rows } = await pool.query<{
    market_id: string;
    is_initialized: boolean | null;
  }>(
    `
      with candidate_markets as (
        select m.id as market_id, m.is_initialized
        from unified_markets m
        where m.venue = 'kalshi'
          and (
            m.token_yes = any($1::text[])
            or m.token_no = any($1::text[])
          )
        union
        select m.id as market_id, m.is_initialized
        from unified_market_tokens t
        join unified_markets m
          on m.id = t.market_id
        where m.venue = 'kalshi'
          and t.token_id = any($1::text[])
      )
      select distinct market_id, is_initialized
      from candidate_markets
      order by market_id
    `,
    [[rawMint, prefixedMint]],
  );
  if (rows.length === 0) {
    return {
      ok: false,
      status: 404,
      error: "Outcome mint is not mapped to a Hunch Kalshi market",
    };
  }
  if (rows.length > 1) {
    return {
      ok: false,
      status: 409,
      error: "Outcome mint maps to multiple Hunch Kalshi markets",
      marketIds: rows.map((row) => row.market_id),
    };
  }
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      status: 404,
      error: "Outcome mint is not mapped to a Hunch Kalshi market",
    };
  }
  if (row?.is_initialized === true) {
    return {
      ok: false,
      status: 409,
      error: "DFlow prediction market is already initialized",
      marketIds: [row.market_id],
    };
  }
  return { ok: true, marketId: row.market_id };
}

async function initializeDflowPredictionMarket(inputs: {
  outcomeMint: string;
  marketId: string;
  maxRetries?: number;
}): Promise<{
  signature: string;
  status: "submitted" | "fulfilled" | "failed";
  marketRowsUpdated: number;
}> {
  const sponsorKeypair = resolveDflowSponsorKeypair();
  if (!sponsorKeypair) {
    throw new Error("DFlow sponsorship is not configured");
  }
  const sponsorAddress = sponsorKeypair.publicKey.toBase58();
  const upstream = await dflowRequest({
    baseUrl: env.dflowQuoteBase,
    timeoutMs: 15_000,
    method: "GET",
    requestPath: "/prediction-market-init",
    apiKey: env.dflowApiKey,
    query: {
      payer: sponsorAddress,
      outcomeMint: inputs.outcomeMint,
    },
  });

  if (!upstream.ok) {
    throw new Error(
      extractDflowErrorMessage(upstream.payload) ??
        "DFlow prediction market init failed",
    );
  }
  const payload =
    upstream.payload &&
    typeof upstream.payload === "object" &&
    !Array.isArray(upstream.payload)
      ? (upstream.payload as Record<string, unknown>)
      : null;
  const transaction = payload
    ? extractStringFromRecord(payload, [
        "transaction",
        "swapTransaction",
        "swap_transaction",
      ])
    : null;
  if (!transaction) {
    throw new Error(
      "DFlow prediction market init response missing transaction",
    );
  }

  const analysis = analyzeEmbeddedSolanaTransaction({
    signer: sponsorAddress,
    transaction,
    includeRaw: false,
  });
  const validation = validateDflowSponsoredAnalysis({
    analysis,
    userWalletAddress: sponsorAddress,
    sponsorAddress,
    metadata: {
      maxSystemCreateLamports: env.hunchSolanaSponsorMaxTxLamports.toString(),
      allowAtaCreation: false,
      maxAtaCreateCount: 0,
    },
    requireUserSignatureSlot: false,
    requireOutcomeMint: inputs.outcomeMint,
    allowPredictionInit: true,
  });
  if (!validation.valid) {
    throw new Error(
      `DFlow prediction market init rejected: ${validation.reasons[0]}`,
    );
  }

  const tx = VersionedTransaction.deserialize(
    Buffer.from(transaction, "base64"),
  );
  const signerAddresses = getSignedTransactionSignerAddresses(tx);
  if (
    signerAddresses.length !== 1 ||
    !signerAddresses.includes(sponsorAddress)
  ) {
    throw new Error("DFlow prediction market init missing sponsor signer");
  }
  tx.sign([sponsorKeypair]);
  const signedTransaction = encodeBase64(tx.serialize());
  const transactionDigest =
    computeEmbeddedSolanaTransactionDigest(signedTransaction);
  const expectedSignature = getVersionedTransactionSignature(tx);
  if (!transactionDigest || !expectedSignature) {
    throw new Error("DFlow prediction market init could not be signed");
  }
  const intentId = `admin-preinit:${inputs.outcomeMint}:${transactionDigest.slice(0, 32)}`;
  const estimatedSponsorLamports =
    validation.estimatedSponsorLamports.toString();
  const estimatedNonFeeLamports =
    validation.estimatedSponsorLamports > validation.estimatedFeeLamports
      ? validation.estimatedSponsorLamports - validation.estimatedFeeLamports
      : BigInt(0);

  await upsertSolanaSponsorshipLedger({
    userId: null,
    walletAddress: sponsorAddress,
    sponsorAddress,
    intentId,
    status: "user_signed",
    marketId: inputs.marketId,
    outputMint: inputs.outcomeMint,
    transactionDigest,
    txSignature: expectedSignature,
    estimatedSponsorLamports,
    rentLamports:
      estimatedNonFeeLamports > BigInt(0)
        ? estimatedNonFeeLamports.toString()
        : null,
    rentStatus: estimatedNonFeeLamports > BigInt(0) ? "locked" : "unknown",
    metadata: {
      adminPredictionMarketInit: true,
      marketId: inputs.marketId,
      outcomeMint: inputs.outcomeMint,
      programIds: analysis.programIds,
      systemCreateLamports: analysis.systemCreateLamports,
      sponsorSignedAt: new Date().toISOString(),
    },
  });

  let signature: string;
  try {
    signature = await sendSolanaRawTransaction({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      signedTransaction,
      skipPreflight: false,
      maxRetries: Math.min(
        Math.max(
          Math.trunc(inputs.maxRetries ?? DFLOW_SPONSORED_MAX_RETRIES),
          0,
        ),
        DFLOW_SPONSORED_MAX_RETRIES,
      ),
    });
  } catch (error) {
    await upsertSolanaSponsorshipLedger({
      userId: null,
      walletAddress: sponsorAddress,
      sponsorAddress,
      intentId,
      status: "failed",
      marketId: inputs.marketId,
      outputMint: inputs.outcomeMint,
      transactionDigest,
      txSignature: expectedSignature,
      estimatedSponsorLamports,
      rentStatus: "unknown",
      error: error instanceof Error ? error.message : String(error),
      metadata: {
        adminPredictionMarketInit: true,
        marketId: inputs.marketId,
        outcomeMint: inputs.outcomeMint,
      },
    });
    throw error;
  }

  await upsertSolanaSponsorshipLedger({
    userId: null,
    walletAddress: sponsorAddress,
    sponsorAddress,
    intentId,
    status: "submitted",
    marketId: inputs.marketId,
    outputMint: inputs.outcomeMint,
    transactionDigest,
    txSignature: signature,
    estimatedSponsorLamports,
    rentLamports:
      estimatedNonFeeLamports > BigInt(0)
        ? estimatedNonFeeLamports.toString()
        : null,
    rentStatus: estimatedNonFeeLamports > BigInt(0) ? "locked" : "unknown",
    metadata: {
      adminPredictionMarketInit: true,
      marketId: inputs.marketId,
      outcomeMint: inputs.outcomeMint,
      submittedAt: new Date().toISOString(),
    },
  });
  const confirmation = await waitForSolanaSignatureConfirmation({
    rpcUrls: env.solanaRpcUrls,
    signature,
    timeoutMs: 20_000,
    pollIntervalMs: 1_000,
    commitment: "confirmed",
  });
  const marketRowsUpdated =
    confirmation.status === "fulfilled"
      ? await markDflowMarketInitializedByMint({
          outcomeMint: inputs.outcomeMint,
          marketId: inputs.marketId,
          signature,
        })
      : 0;
  return { signature, status: confirmation.status, marketRowsUpdated };
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

function toDflowOutcomeTokenId(mint: string): string | null {
  const trimmed = mint.trim();
  if (!trimmed) return null;
  if (trimmed === env.solanaUsdcMint) return null;
  return trimmed.startsWith("sol:") ? trimmed : `sol:${trimmed}`;
}

async function resolveDflowSponsorshipMarketState(
  inputMint: string,
  outputMint: string,
): Promise<DflowSponsorshipMarketState | null> {
  const inputIsUsdc = inputMint === env.solanaUsdcMint;
  const outputIsUsdc = outputMint === env.solanaUsdcMint;
  if (inputIsUsdc === outputIsUsdc) return null;

  const tokenIds = Array.from(
    new Set(
      [inputMint, outputMint]
        .map(toDflowOutcomeTokenId)
        .filter((tokenId): tokenId is string => Boolean(tokenId)),
    ),
  );
  if (tokenIds.length !== 1) return null;

  const { rows } = await pool.query<{
    market_id: string;
    is_initialized: boolean | null;
  }>(
    `
      select distinct
        m.id as market_id,
        m.is_initialized
      from unified_market_tokens t
      join unified_markets m on m.id = t.market_id
      where t.token_id = any($1::text[])
        and m.venue = 'kalshi'
    `,
    [tokenIds],
  );
  if (rows.length !== 1) return null;

  return {
    marketIds: rows.map((row) => row.market_id),
    marketInitialized: rows.every((row) => row.is_initialized === true),
  };
}

function isDflowRouteNotFound(payload: unknown): boolean {
  const code = extractDflowErrorCode(payload);
  if (code === "route_not_found") return true;
  const message = extractDflowErrorMessage(payload)?.toLowerCase() ?? "";
  return message.includes("route not found");
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

function extractStringFromRecord(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractNonNegativeLamportsFromRecord(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  const raw = extractStringFromRecord(record, keys);
  if (raw && /^\d+$/.test(raw)) return raw;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value).toString();
    }
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
        void requestPriceRefreshForTokens({
          tokenIds: hotTokenIds,
          venue: "dflow",
        });
      }

      let sponsorshipMarketState: DflowSponsorshipMarketState | null = null;
      let dflowSponsoredOrder = false;
      let dflowSponsorAddress: string | null = null;
      let dflowSponsorshipConfig: DflowSponsorConfig | null = null;
      try {
        sponsorshipMarketState = await resolveDflowSponsorshipMarketState(
          query.inputMint,
          query.outputMint,
        );
        const sponsorshipConfig = await resolveDflowSponsorConfig();
        dflowSponsorshipConfig = sponsorshipConfig;
        dflowSponsoredOrder =
          sponsorshipConfig.enabled &&
          sponsorshipMarketState?.marketInitialized === true;
        if (dflowSponsoredOrder) {
          try {
            await resolveEmbeddedSolanaWalletContext({
              user,
              signer: walletAddress,
            });
          } catch (error) {
            app.log.info(
              { error, userId: user.id, walletAddress },
              "DFlow sponsorship skipped for non-embedded Solana wallet",
            );
            dflowSponsoredOrder = false;
          }
        }
        if (
          !dflowSponsoredOrder &&
          sponsorshipConfig.decision.policyAllows &&
          sponsorshipConfig.sponsorshipMode === "observe" &&
          !env.embeddedSolanaSponsorshipObserveCanSponsor &&
          sponsorshipMarketState?.marketInitialized === true
        ) {
          app.log.info(
            {
              userId: user.id,
              walletAddress,
              inputMint: query.inputMint,
              outputMint: query.outputMint,
              reasons: sponsorshipConfig.decision.reasons,
            },
            "DFlow sponsorship observe candidate",
          );
        }
        dflowSponsorAddress = dflowSponsoredOrder
          ? sponsorshipConfig.sponsorAddress
          : null;
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to resolve DFlow sponsorship configuration",
        );
        dflowSponsorshipConfig = null;
        dflowSponsoredOrder = false;
        dflowSponsorAddress = null;
      }

      const orderQuery: DflowOrderQueryParams = {
        inputMint: query.inputMint,
        outputMint: query.outputMint,
        amount: query.amount,
        purpose: query.purpose ?? "trade",
        ...(query.slippageBps != null
          ? { slippageBps: query.slippageBps }
          : {}),
      };

      const sendDflowOrderFailure = (failed: {
        status: number;
        payload: unknown;
      }) => {
        if (isDflowRouteNotFound(failed.payload)) {
          void markDflowRouteUnavailable([
            query.inputMint,
            query.outputMint,
          ]).catch((error) =>
            app.log.warn({ error }, "Failed to mark DFlow route unavailable"),
          );
        }
        const userMessage = formatDflowUserMessage(failed.payload);
        reply.code(502);
        return reply.send({
          error: userMessage ?? "DFlow order failed",
          status: failed.status,
          message: extractDflowErrorMessage(failed.payload),
          payload: failed.payload,
        });
      };

      const requestOrder: DflowOrderRequester = ({ sponsored }) =>
        requestDflowOrder({
          query: orderQuery,
          userPublicKey,
          sponsored,
          sponsorAddress: dflowSponsorAddress,
        });

      const upstream = await requestOrder({
        sponsored: dflowSponsoredOrder,
        query: {},
      });
      if (!upstream.ok) {
        return sendDflowOrderFailure(upstream);
      }

      if (
        dflowSponsoredOrder &&
        dflowSponsorAddress &&
        dflowSponsorshipConfig
      ) {
        const finalized = await finalizeDflowSponsoredOrderOrFallback({
          payload: upstream.payload,
          query: orderQuery,
          userId: user.id,
          walletAddress,
          userPublicKey,
          sponsorAddress: dflowSponsorAddress,
          sponsorshipMarketState: sponsorshipMarketState ?? {
            marketIds: [],
            marketInitialized: false,
          },
          sponsorshipLimits: dflowSponsorshipConfig.sponsorshipLimits,
          sponsorshipMode: dflowSponsorshipConfig.sponsorshipMode,
          requester: requestOrder,
          logger: app.log,
        });
        if (!finalized.ok) {
          return sendDflowOrderFailure(finalized);
        }
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(finalized.payload);
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
        void requestPriceRefreshForTokens({
          tokenIds: hotTokenIds,
          venue: "dflow",
        });
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
        if (isDflowRouteNotFound(upstream.payload)) {
          void markDflowRouteUnavailable([
            query.inputMint,
            query.outputMint,
          ]).catch((error) =>
            app.log.warn({ error }, "Failed to mark DFlow route unavailable"),
          );
        }
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
   * POST /admin/prediction-market-init
   * Admin-only utility to initialize a DFlow prediction market ahead of the
   * user trade path, paid by the dedicated Solana sponsor wallet.
   */
  z.post(
    "/admin/prediction-market-init",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermissions: ["finance:write", "sponsorship:write"],
        allowLegacyFallback: false,
      }),
      schema: { body: dflowPredictionMarketInitBodySchema },
    },
    async (request, reply) => {
      if (!ensureDflowReady(reply)) return;
      try {
        const policy = await resolveAuthAccessPolicy(pool);
        const decision = resolveDflowActualSponsorshipDecision({
          embeddedSolanaSponsorship:
            policy.effective.embeddedSolanaSponsorship === true,
          dflowFlowEnabled:
            policy.effective.embeddedSolanaSponsorshipFlows.dflow === true,
          mode: policy.effective.embeddedSolanaSponsorshipMode,
          observeCanSponsor: env.embeddedSolanaSponsorshipObserveCanSponsor,
        });
        if (!decision.actualSponsorAllowed) {
          reply.code(403);
          return reply.send({
            error: "DFlow sponsorship is disabled",
            reasons: decision.reasons,
          });
        }
        const candidate = await resolveDflowPredictionMarketInitCandidate(
          request.body.outcomeMint,
        );
        if (!candidate.ok) {
          reply.code(candidate.status);
          return reply.send({
            error: candidate.error,
            ...(candidate.marketIds ? { marketIds: candidate.marketIds } : {}),
          });
        }
        const result = await initializeDflowPredictionMarket({
          outcomeMint: request.body.outcomeMint,
          marketId: candidate.marketId,
          maxRetries: request.body.maxRetries,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          ...result,
        });
      } catch (error) {
        app.log.error(
          { error, outcomeMint: request.body.outcomeMint },
          "DFlow prediction market init failed",
        );
        reply.code(502);
        return reply.send({
          error:
            error instanceof Error && error.message
              ? error.message
              : "DFlow prediction market init failed",
        });
      }
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
   * POST /sponsored-submit
   * Add the Hunch sponsor signature to a user-signed DFlow transaction and
   * broadcast it. This path is only for backend-created DFlow sponsorship
   * intents; generic Privy Solana sponsorship stays disabled for DFlow.
   */
  z.post(
    "/sponsored-submit",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: dflowSponsoredSubmitBodySchema },
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
        await resolveEmbeddedSolanaWalletContext({
          user,
          signer: walletAddress,
        });
      } catch {
        reply.code(400);
        return reply.send({
          error: "DFlow sponsorship requires an embedded Solana Trading Wallet",
        });
      }

      try {
        const result = await signAndBroadcastSponsoredDflowTransaction({
          userId: user.id,
          walletAddress,
          sponsorshipIntentId: request.body.sponsorshipIntentId,
          signedTransaction: request.body.signedTransaction,
          maxRetries: request.body.maxRetries,
          logger: app.log,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          sponsored: true,
          signature: result.signature,
        });
      } catch (error) {
        if (error instanceof DflowSponsoredSubmitLedgerDurabilityError) {
          app.log.error(
            { error, userId: user.id, walletAddress },
            "DFlow sponsored submit ledger durability failed",
          );
          reply.code(500);
          return reply.send({
            error: "sponsorship_ledger_not_durable",
            message: error.message,
            signature: error.signature,
            sponsorshipIntentId: error.sponsorshipIntentId,
            transactionDigest: error.transactionDigest,
          });
        }
        app.log.error(
          { error, userId: user.id, walletAddress },
          "DFlow sponsored submit failed",
        );
        reply.code(502);
        return reply.send({
          error:
            error instanceof Error && error.message
              ? error.message
              : "DFlow sponsored submit failed",
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
          unifiedMarketId: normalizeKalshiMarketIdForStorage(body.marketId),
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

  z.post(
    "/loss-reclaim/sponsored-submit",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: dflowSponsoredSubmitBodySchema },
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
          error: "Kalshi loss reclaim requires a Solana wallet address",
        });
      }

      try {
        await resolveEmbeddedSolanaWalletContext({
          user,
          signer: walletAddress,
        });
      } catch {
        reply.code(400);
        return reply.send({
          error:
            "Kalshi loss reclaim requires an embedded Solana Trading Wallet",
        });
      }

      try {
        const result = await submitKalshiLossRentReclaim({
          userId: user.id,
          walletAddress,
          sponsorshipIntentId: request.body.sponsorshipIntentId,
          signedTransaction: request.body.signedTransaction,
          maxRetries: request.body.maxRetries,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        if (error instanceof KalshiLossReclaimLedgerDurabilityError) {
          app.log.error(
            { error, userId: user.id, walletAddress },
            "Kalshi loss reclaim ledger durability failed",
          );
          reply.code(500);
          return reply.send({
            error: "sponsorship_ledger_not_durable",
            message: error.message,
            signature: error.signature,
            sponsorshipIntentId: error.sponsorshipIntentId,
          });
        }
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Kalshi loss reclaim sponsored submit failed",
        );
        reply.code(502);
        return reply.send({
          error:
            error instanceof Error && error.message
              ? error.message
              : "Kalshi loss reclaim submit failed",
        });
      }
    },
  );
};
