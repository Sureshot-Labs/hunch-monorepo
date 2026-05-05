import type { Pool } from "@hunch/infra";

import {
  fetchFulfilledKalshiTradeExecutionsMissingFeeEvent,
  fetchPendingKalshiExecutions,
  storeExecution,
  type ExecutionRow,
} from "../repos/executions-repo.js";
import {
  finalizeKalshiExecutionEffects,
  getKalshiExecutionPurpose,
  mergeKalshiExecutionRaw,
  normalizeKalshiExecutionStatus,
  resolveKalshiExecutionSettlementStatus,
  type KalshiExecutionStatus,
} from "./kalshi-executions.js";

type Logger = {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
};

export type ReconcileKalshiExecutionsOptions = {
  dryRun: boolean;
  limit: number;
  minAgeSec: number;
  logger?: Logger;
};

export type ReconcileKalshiExecutionsSummary = {
  checked: number;
  updated: number;
  fulfilled: number;
  noFill: number;
  failed: number;
  feeBackfilled: number;
  skipped: number;
  errors: number;
  dryRun: boolean;
};

function getStatusRank(status: KalshiExecutionStatus | null): number {
  switch (status) {
    case "submitted":
      return 1;
    case "open":
      return 2;
    case "pending_close":
      return 3;
    case "fulfilled":
    case "no_fill":
    case "failed":
      return 4;
    default:
      return 0;
  }
}

function isTerminalStatus(status: KalshiExecutionStatus): boolean {
  return status === "fulfilled" || status === "no_fill" || status === "failed";
}

function shouldPersistStatusUpdate(
  currentStatus: KalshiExecutionStatus | null,
  nextStatus: KalshiExecutionStatus,
): boolean {
  if (currentStatus == null) return true;
  if (currentStatus === nextStatus) return false;
  return getStatusRank(nextStatus) > getStatusRank(currentStatus);
}

function getExecutionMode(raw: unknown): "sync" | "async" | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const value = record.executionMode;
  return value === "sync" || value === "async" ? value : null;
}

function buildUpdatedRaw(
  execution: ExecutionRow,
  settlementRaw: unknown,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    purpose: getKalshiExecutionPurpose(execution.raw),
  };
  if (settlementRaw !== undefined) {
    patch.settlement = settlementRaw;
  }
  return mergeKalshiExecutionRaw(execution.raw, patch);
}

async function reconcileOneExecution(
  pool: Pool,
  execution: ExecutionRow,
  options: ReconcileKalshiExecutionsOptions,
): Promise<{
  updated: boolean;
  finalStatus?: KalshiExecutionStatus;
  skipped: boolean;
}> {
  const txSignature = execution.tx_signature?.trim();
  const walletAddress = execution.wallet_address?.trim();
  if (!txSignature || !walletAddress) {
    return { updated: false, skipped: true };
  }

  const currentStatus = normalizeKalshiExecutionStatus(execution.status);
  const executionMode = getExecutionMode(execution.raw);
  const settlement = await resolveKalshiExecutionSettlementStatus({
    txSignature,
    executionMode,
    skipTxFallbackOnOrderNotReady: executionMode == null,
  });
  if (!settlement) {
    return { updated: false, skipped: true };
  }

  if (!shouldPersistStatusUpdate(currentStatus, settlement.status)) {
    return { updated: false, skipped: true };
  }

  if (options.dryRun) {
    return {
      updated: true,
      finalStatus: isTerminalStatus(settlement.status)
        ? settlement.status
        : undefined,
      skipped: false,
    };
  }

  const purpose = getKalshiExecutionPurpose(execution.raw);
  const updated = await storeExecution(pool, {
    userId: execution.user_id,
    walletAddress,
    venue: execution.venue,
    unifiedMarketId: execution.unified_market_id,
    side: execution.side,
    outcome: execution.outcome,
    inputMint: execution.input_mint,
    outputMint: execution.output_mint,
    amountIn: execution.amount_in,
    amountOut: execution.amount_out,
    inputDecimals: execution.input_decimals,
    outputDecimals: execution.output_decimals,
    quoteId: execution.quote_id,
    txSignature,
    venueOrderId: execution.venue_order_id,
    status: settlement.status,
    raw: buildUpdatedRaw(execution, settlement.settlementRaw),
  });

  if (isTerminalStatus(settlement.status)) {
    await finalizeKalshiExecutionEffects(pool, {
      execution: updated,
      purpose,
      logger: options.logger,
      publishNotifications: false,
    });
  }

  return {
    updated: true,
    finalStatus: isTerminalStatus(settlement.status)
      ? settlement.status
      : undefined,
    skipped: false,
  };
}

export async function reconcileKalshiExecutions(
  pool: Pool,
  options: ReconcileKalshiExecutionsOptions,
): Promise<ReconcileKalshiExecutionsSummary> {
  const [rows, feeBackfillRows] = await Promise.all([
    fetchPendingKalshiExecutions(pool, {
      limit: options.limit,
      minAgeSec: options.minAgeSec,
    }),
    fetchFulfilledKalshiTradeExecutionsMissingFeeEvent(pool, {
      limit: options.limit,
      minAgeSec: options.minAgeSec,
    }),
  ]);

  const summary: ReconcileKalshiExecutionsSummary = {
    checked: rows.length + feeBackfillRows.length,
    updated: 0,
    fulfilled: 0,
    noFill: 0,
    failed: 0,
    feeBackfilled: 0,
    skipped: 0,
    errors: 0,
    dryRun: options.dryRun,
  };

  for (const row of rows) {
    try {
      const result = await reconcileOneExecution(pool, row, options);
      if (result.skipped) {
        summary.skipped += 1;
        continue;
      }
      if (result.updated) {
        summary.updated += 1;
      }
      if (result.finalStatus === "fulfilled") {
        summary.fulfilled += 1;
      } else if (result.finalStatus === "no_fill") {
        summary.noFill += 1;
      } else if (result.finalStatus === "failed") {
        summary.failed += 1;
      }
    } catch (error) {
      summary.errors += 1;
      options.logger?.error?.(
        {
          error,
          executionId: row.id,
          txSignature: row.tx_signature,
        },
        "Kalshi execution reconcile failed",
      );
    }
  }

  for (const row of feeBackfillRows) {
    try {
      if (options.dryRun) {
        summary.feeBackfilled += 1;
        continue;
      }
      const result = await finalizeKalshiExecutionEffects(pool, {
        execution: row,
        purpose: getKalshiExecutionPurpose(row.raw),
        logger: options.logger,
        publishNotifications: false,
        warnOnFeeVerificationDeferral: false,
      });
      if (result.feeEventStored) {
        summary.feeBackfilled += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      summary.errors += 1;
      options.logger?.error?.(
        {
          error,
          executionId: row.id,
          txSignature: row.tx_signature,
        },
        "Kalshi fee backfill reconcile failed",
      );
    }
  }

  return summary;
}
