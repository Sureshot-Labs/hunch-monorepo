import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { env } from "../env.js";
import type { ExecutionRow } from "../repos/executions-repo.js";
import {
  tryRecordReferralFirstTradeConversion,
  type ReferralFirstTradePayload,
} from "./analytics-referrals.js";
import {
  buildRedemptionNotification,
  buildTradeNotification,
  createNotificationSafe,
} from "./notifications.js";
import { resolveFeeEventSnapshotAtWrite } from "./rewards-fee-snapshot.js";
import { insertVolumeEventsWithMultiplier } from "./rewards-multiplier.js";
import {
  fetchSolanaTokenAccountNetDelta,
  fetchSolanaSignatureStatus,
  formatUiAmount,
} from "./solana-rpc.js";
import { dflowRequest } from "./dflow-client.js";

const DEFAULT_USDC_DECIMALS = 6;

export type KalshiExecutionStatus =
  | "submitted"
  | "open"
  | "pending_close"
  | "fulfilled"
  | "no_fill"
  | "failed";

export type KalshiExecutionPurpose = "trade" | "redeem";

type FeeExtractionResult = {
  amountRaw: string;
  feeAccount?: string | null;
};

class KalshiFeeEventImmutableMismatchError extends Error {
  constructor(sourceId: string) {
    super(`fee_events immutable economic mismatch for source_id=${sourceId}`);
    this.name = "KalshiFeeEventImmutableMismatchError";
  }
}

type Logger = {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
};

function parseNumberish(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function normalizeRawAmountToUi(
  value: string | number | null | undefined,
  decimals: number,
): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric / Math.pow(10, decimals);
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
    const amount = parseNumberish(record[key]);
    if (amount) {
      const feeAccount =
        typeof record.feeAccount === "string" ? record.feeAccount : null;
      return { amountRaw: amount, feeAccount };
    }
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
        typeof nested.feeAccount === "string" ? nested.feeAccount : null;
      return { amountRaw: nestedAmount, feeAccount };
    }
  }

  const nestedKeys = ["data", "quote", "order", "result", "swap", "route"];
  for (const key of nestedKeys) {
    const nested = record[key];
    const extracted = extractFeeFromObject(nested);
    if (extracted) return extracted;
  }

  return null;
}

function extractSettlementSignature(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const settlement = record.settlement;
  if (!settlement || typeof settlement !== "object") return null;
  const settlementRecord = settlement as Record<string, unknown>;

  for (const candidate of [settlementRecord.fills, settlementRecord.reverts]) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      if (!entry || typeof entry !== "object") continue;
      const signature = (entry as Record<string, unknown>).signature;
      if (typeof signature === "string" && signature.trim().length > 0) {
        return signature.trim();
      }
    }
  }

  return null;
}

function extractDflowFeeAmount(raw: unknown): FeeExtractionResult | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const order = record.order ?? record.quote ?? record;
  return extractFeeFromObject(order);
}

export function normalizeDflowOrderStatusPayload(
  payload: unknown,
): { status: KalshiExecutionStatus; raw: Record<string, unknown> } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const rawStatus =
    typeof record.status === "string" ? record.status.trim() : null;
  if (!rawStatus) return null;
  const fills = Array.isArray(record.fills) ? record.fills : [];

  switch (rawStatus) {
    case "submitted":
      return { status: "submitted", raw: record };
    case "open":
      return { status: "open", raw: record };
    case "pendingClose":
      return { status: "pending_close", raw: record };
    case "closed":
      return {
        status: fills.length > 0 ? "fulfilled" : "no_fill",
        raw: record,
      };
    case "failed":
      return { status: "failed", raw: record };
    default:
      return null;
  }
}

export function normalizeKalshiExecutionStatus(
  value: string | null | undefined,
): KalshiExecutionStatus | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (
    normalized === "submitted" ||
    normalized === "open" ||
    normalized === "pending_close" ||
    normalized === "fulfilled" ||
    normalized === "no_fill" ||
    normalized === "failed"
  ) {
    return normalized;
  }
  return null;
}

export function getKalshiExecutionPurpose(
  raw: unknown,
): KalshiExecutionPurpose {
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    if (record.purpose === "redeem") return "redeem";
  }
  return "trade";
}

export function mergeKalshiExecutionRaw(
  currentRaw: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base =
    currentRaw && typeof currentRaw === "object"
      ? (currentRaw as Record<string, unknown>)
      : {};
  return { ...base, ...patch };
}

export async function fetchKalshiNormalizedOrderStatus(inputs: {
  signature: string;
}): Promise<{ status: KalshiExecutionStatus; raw: Record<string, unknown> }> {
  const upstream = await dflowRequest({
    baseUrl: env.dflowQuoteBase,
    timeoutMs: 10_000,
    method: "GET",
    requestPath: "/order-status",
    apiKey: env.dflowApiKey,
    query: {
      signature: inputs.signature,
    },
  });

  if (!upstream.ok) {
    if (upstream.status === 404) {
      return {
        status: "submitted",
        raw: {
          status: "submitted",
          fills: [],
          notReady: true,
          upstreamStatus: 404,
        },
      };
    }
    throw new Error("DFlow order status failed");
  }

  const normalized = normalizeDflowOrderStatusPayload(upstream.payload);
  if (!normalized) {
    throw new Error("Unexpected DFlow order status payload");
  }

  return normalized;
}

export async function resolveKalshiExecutionSettlementStatus(inputs: {
  txSignature: string;
  executionMode: "sync" | "async" | null;
  skipTxFallbackOnOrderNotReady?: boolean;
}): Promise<{ status: KalshiExecutionStatus; settlementRaw?: unknown } | null> {
  if (inputs.executionMode === "sync") {
    const txStatus = await fetchSolanaSignatureStatus({
      rpcUrls: env.solanaRpcUrls,
      signature: inputs.txSignature,
      timeoutMs: env.solanaRpcTimeoutMs,
    });
    return txStatus ? { status: txStatus.status } : { status: "submitted" };
  }

  const orderStatus = await fetchKalshiNormalizedOrderStatus({
    signature: inputs.txSignature,
  });
  if (orderStatus.status === "submitted") {
    const rawRecord =
      orderStatus.raw && typeof orderStatus.raw === "object"
        ? (orderStatus.raw as Record<string, unknown>)
        : null;
    if (inputs.skipTxFallbackOnOrderNotReady && rawRecord?.notReady === true) {
      return { status: "submitted", settlementRaw: orderStatus.raw };
    }
    const txStatus = await fetchSolanaSignatureStatus({
      rpcUrls: env.solanaRpcUrls,
      signature: inputs.txSignature,
      timeoutMs: env.solanaRpcTimeoutMs,
    });
    if (txStatus?.status === "failed") {
      return { status: "failed", settlementRaw: orderStatus.raw };
    }
  }
  return { status: orderStatus.status, settlementRaw: orderStatus.raw };
}

async function upsertKalshiFeeEventInTx(
  client: PoolClient,
  inputs: {
    userId: string;
    walletAddress: string;
    execution: ExecutionRow;
    feeAmountUsd: string;
    txSignature: string;
    collectedAt: Date;
  },
): Promise<boolean> {
  const snapshot = await resolveFeeEventSnapshotAtWrite(client, {
    userId: inputs.userId,
    eventTime: inputs.collectedAt,
    feeUsd: inputs.feeAmountUsd,
  });
  const result = await client.query<{ id: string }>(
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
        cashback_bps_applied,
        referral_bps_applied,
        cashback_earned_usdc,
        referral_earned_usdc,
        liability_snapshot_source,
        tx_hash,
        collected_at,
        status,
        created_at,
        updated_at
      )
      values (
        gen_random_uuid(),
        $1, $2, 'kalshi', 'solana', 'execution', $3,
        $4, 'USDC', $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now()
      )
      on conflict (user_id, source_type, source_id)
      do update set
        tx_hash = excluded.tx_hash,
        collected_at = coalesce(fee_events.collected_at, excluded.collected_at),
        status = excluded.status,
        updated_at = now()
      where fee_events.fee_amount = excluded.fee_amount
        and fee_events.fee_usd = excluded.fee_usd
        and fee_events.cashback_bps_applied = excluded.cashback_bps_applied
        and fee_events.referral_bps_applied = excluded.referral_bps_applied
        and fee_events.cashback_earned_usdc = excluded.cashback_earned_usdc
        and fee_events.referral_earned_usdc = excluded.referral_earned_usdc
        and fee_events.liability_snapshot_source = excluded.liability_snapshot_source
      returning id
    `,
    [
      inputs.userId,
      inputs.walletAddress,
      inputs.execution.id,
      inputs.feeAmountUsd,
      snapshot.cashbackBpsApplied,
      snapshot.referralBpsApplied,
      snapshot.cashbackEarnedUsdc,
      snapshot.referralEarnedUsdc,
      snapshot.liabilitySnapshotSource,
      inputs.txSignature,
      inputs.collectedAt,
      "collected",
    ],
  );
  if (!result.rows.length) {
    throw new KalshiFeeEventImmutableMismatchError(inputs.execution.id);
  }
  return true;
}

export async function finalizeKalshiExecutionEffects(
  pool: Pool,
  inputs: {
    execution: ExecutionRow;
    purpose: KalshiExecutionPurpose;
    logger?: Logger;
    publishNotifications?: boolean;
    warnOnFeeVerificationDeferral?: boolean;
  },
): Promise<{
  feeEventStored: boolean;
  referralFirstTrade: ReferralFirstTradePayload | null;
}> {
  if (inputs.execution.status !== "fulfilled") {
    return { feeEventStored: false, referralFirstTrade: null };
  }
  const walletAddress = inputs.execution.wallet_address;
  if (!walletAddress) {
    return { feeEventStored: false, referralFirstTrade: null };
  }
  const notificationLogger = inputs.logger?.warn
    ? { warn: inputs.logger.warn }
    : undefined;

  const usdcMint = env.solanaUsdcMint;
  let notionalUsd: number | null = null;
  if (
    inputs.execution.input_mint === usdcMint &&
    inputs.execution.amount_in != null
  ) {
    const decimals = inputs.execution.input_decimals ?? DEFAULT_USDC_DECIMALS;
    notionalUsd = Number(inputs.execution.amount_in) / Math.pow(10, decimals);
  } else if (
    inputs.execution.output_mint === usdcMint &&
    inputs.execution.amount_out != null
  ) {
    const decimals = inputs.execution.output_decimals ?? DEFAULT_USDC_DECIMALS;
    notionalUsd = Number(inputs.execution.amount_out) / Math.pow(10, decimals);
  }

  const inputDecimals =
    inputs.execution.input_decimals ?? DEFAULT_USDC_DECIMALS;
  const outputDecimals =
    inputs.execution.output_decimals ?? DEFAULT_USDC_DECIMALS;
  const inputAmountUi = normalizeRawAmountToUi(
    inputs.execution.amount_in ?? null,
    inputDecimals,
  );
  const outputAmountUi = normalizeRawAmountToUi(
    inputs.execution.amount_out ?? null,
    outputDecimals,
  );

  if (
    inputs.purpose === "trade" &&
    notionalUsd != null &&
    Number.isFinite(notionalUsd) &&
    notionalUsd > 0
  ) {
    await insertVolumeEventsWithMultiplier(pool, {
      userId: inputs.execution.user_id,
      walletAddress,
      venue: "kalshi",
      sourceType: "execution",
      events: [
        {
          sourceId: inputs.execution.id,
          notionalUsd,
          createdAt: inputs.execution.created_at,
        },
      ],
    });
  }

  let referralFirstTrade: ReferralFirstTradePayload | null = null;
  if (
    inputs.purpose === "trade" &&
    notionalUsd != null &&
    Number.isFinite(notionalUsd) &&
    notionalUsd > 0
  ) {
    referralFirstTrade = await tryRecordReferralFirstTradeConversion(pool, {
      userId: inputs.execution.user_id,
      venue: "kalshi",
      status: "fulfilled",
      sourceType: "execution",
      sourceId: inputs.execution.id,
      txHash: inputs.execution.tx_signature ?? null,
      logger: inputs.logger ?? null,
    });
  }

  if (inputs.purpose === "trade") {
    void createNotificationSafe(
      pool,
      buildTradeNotification({
        userId: inputs.execution.user_id,
        venue: "kalshi",
        side: inputs.execution.side ?? null,
        amountUsd: notionalUsd,
        marketId: inputs.execution.unified_market_id ?? null,
        txHash: inputs.execution.tx_signature ?? null,
        walletAddress,
      }),
      notificationLogger,
      { publish: inputs.publishNotifications !== false },
    );
  } else {
    const redemptionAmountUsd =
      inputs.execution.output_mint === usdcMint
        ? outputAmountUi
        : inputs.execution.input_mint === usdcMint
          ? inputAmountUi
          : null;
    void createNotificationSafe(
      pool,
      buildRedemptionNotification({
        userId: inputs.execution.user_id,
        venue: "kalshi",
        amountUsd: redemptionAmountUsd,
        marketId: inputs.execution.unified_market_id ?? null,
        tokenId:
          inputs.execution.output_mint ?? inputs.execution.input_mint ?? null,
        txHash: inputs.execution.tx_signature ?? null,
        walletAddress,
      }),
      notificationLogger,
      { publish: inputs.publishNotifications !== false },
    );
  }

  const feeAccount = env.dflowFeeAccount?.trim() || "";
  const feeBps = env.feeBpsKalshi;
  const feeScale = env.feeScaleKalshi;
  const hasFeeBps = Number.isFinite(feeBps) && feeBps > 0;
  const hasFeeScale = Number.isFinite(feeScale) && feeScale > 0;
  const feeConfigActive = feeAccount.length > 0 && (hasFeeBps || hasFeeScale);
  if (inputs.purpose !== "trade" || !feeConfigActive) {
    return { feeEventStored: false, referralFirstTrade };
  }

  const rawFee = extractDflowFeeAmount(inputs.execution.raw);
  const rawFeeAccount = rawFee?.feeAccount ?? null;
  if (rawFeeAccount && feeAccount && rawFeeAccount !== feeAccount) {
    inputs.logger?.warn?.(
      { rawFeeAccount, feeAccount, userId: inputs.execution.user_id },
      "Skipping DFlow fee event (fee account mismatch)",
    );
    return { feeEventStored: false, referralFirstTrade };
  }

  const verificationSignature =
    extractSettlementSignature(inputs.execution.raw) ??
    inputs.execution.tx_signature?.trim() ??
    "";
  if (!verificationSignature) {
    if (inputs.warnOnFeeVerificationDeferral !== false) {
      inputs.logger?.warn?.(
        {
          executionId: inputs.execution.id,
          txSignature: null,
        },
        "Deferring Kalshi fee event until source transaction is available",
      );
    }
    return { feeEventStored: false, referralFirstTrade };
  }

  const statusResult = await fetchSolanaSignatureStatus({
    rpcUrls: env.solanaRpcUrls,
    signature: verificationSignature,
    timeoutMs: env.solanaRpcTimeoutMs,
  });
  if (statusResult?.status !== "fulfilled") {
    if (inputs.warnOnFeeVerificationDeferral !== false) {
      inputs.logger?.warn?.(
        {
          executionId: inputs.execution.id,
          txSignature: verificationSignature,
          txStatus: statusResult?.status ?? null,
        },
        "Deferring Kalshi fee event until source transaction is finalized",
      );
    }
    return { feeEventStored: false, referralFirstTrade };
  }

  const delta = await fetchSolanaTokenAccountNetDelta({
    rpcUrls: env.solanaRpcUrls,
    signature: verificationSignature,
    tokenAccount: feeAccount,
    expectedMint: env.solanaUsdcMint,
    timeoutMs: env.solanaRpcTimeoutMs,
  });

  if (delta.status !== "verified") {
    if (inputs.warnOnFeeVerificationDeferral !== false) {
      inputs.logger?.warn?.(
        {
          executionId: inputs.execution.id,
          txSignature: verificationSignature,
          deltaStatus: delta.status,
          mint: delta.mint ?? null,
        },
        "Deferring Kalshi fee event until fee-account delta is verifiable",
      );
    }
    return { feeEventStored: false, referralFirstTrade };
  }

  if (delta.deltaRaw <= 0n) {
    if (inputs.warnOnFeeVerificationDeferral !== false) {
      inputs.logger?.warn?.(
        {
          executionId: inputs.execution.id,
          txSignature: verificationSignature,
          deltaRaw: delta.deltaRaw.toString(),
        },
        "Skipping Kalshi fee event (non-positive verified fee delta)",
      );
    }
    return { feeEventStored: false, referralFirstTrade };
  }

  const feeAmountUsd = formatUiAmount(delta.deltaRaw, delta.decimals);
  const feeAmountNumber = Number(feeAmountUsd);
  if (!Number.isFinite(feeAmountNumber) || feeAmountNumber <= 0) {
    return { feeEventStored: false, referralFirstTrade };
  }

  const collectedAt = new Date();

  return tx(pool, async (client) => {
    try {
      const stored = await upsertKalshiFeeEventInTx(client, {
        userId: inputs.execution.user_id,
        walletAddress,
        execution: inputs.execution,
        feeAmountUsd,
        txSignature: verificationSignature,
        collectedAt,
      });
      return { feeEventStored: stored, referralFirstTrade };
    } catch (error) {
      if (error instanceof KalshiFeeEventImmutableMismatchError) {
        inputs.logger?.warn?.(
          {
            executionId: inputs.execution.id,
            txSignature: inputs.execution.tx_signature,
            error: error.message,
          },
          "Keeping existing immutable Kalshi fee event",
        );
        return { feeEventStored: false, referralFirstTrade };
      }
      throw error;
    }
  });
}
