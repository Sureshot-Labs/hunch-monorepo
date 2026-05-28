export const POLYMARKET_UNCONFIRMED_STATUS = "unconfirmed" as const;

export type PolymarketUnconfirmedResolution =
  | "unmatched"
  | typeof POLYMARKET_UNCONFIRMED_STATUS;

export type PolymarketUnconfirmedReconcileDecision =
  | "sync_for_fill"
  | "unmatched"
  | typeof POLYMARKET_UNCONFIRMED_STATUS;

export type PolymarketOnchainOrderExecutionSummary = {
  makerAmount: bigint;
  remaining: bigint;
  makerFilled: bigint;
  isFilledOrCancelled: boolean;
  hasExecution: boolean;
};

export type PolymarketClosedReasonHint = "matched" | "cancelled" | null;

export type PolymarketTerminalReconcileStatus =
  | "matched"
  | "cancelled"
  | "unmatched";

export type PolymarketStoredFillSyncStatus =
  | "matched"
  | "filled"
  | "partially_filled"
  | typeof POLYMARKET_UNCONFIRMED_STATUS
  | string
  | null;

function readPositiveNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function summarizePolymarketOnchainOrderExecution(inputs: {
  makerAmount: bigint;
  remaining: bigint;
  isFilledOrCancelled: boolean;
}): PolymarketOnchainOrderExecutionSummary {
  const makerAmount = inputs.makerAmount >= 0n ? inputs.makerAmount : 0n;
  const remainingRaw = inputs.remaining >= 0n ? inputs.remaining : 0n;
  const remaining = remainingRaw > makerAmount ? makerAmount : remainingRaw;
  const makerFilled = makerAmount > remaining ? makerAmount - remaining : 0n;

  return {
    makerAmount,
    remaining,
    makerFilled,
    isFilledOrCancelled: inputs.isFilledOrCancelled,
    hasExecution: makerFilled > 0n,
  };
}

export function summarizePolymarketV2OnchainOrderExecution(inputs: {
  makerAmount: bigint;
  filled: boolean;
  remaining: bigint;
}): PolymarketOnchainOrderExecutionSummary {
  const isDefaultEmptyStatus = !inputs.filled && inputs.remaining === 0n;
  return summarizePolymarketOnchainOrderExecution({
    makerAmount: inputs.makerAmount,
    remaining: isDefaultEmptyStatus ? inputs.makerAmount : inputs.remaining,
    isFilledOrCancelled: inputs.filled,
  });
}

export function summarizePolymarketClobOrderExecution(inputs: {
  associateTrades?: unknown[] | null;
  sizeMatched?: number | string | null;
  status?: string | null;
}): {
  hasExecution: boolean;
  statusHint: PolymarketClosedReasonHint;
} {
  const hasExecution =
    readPositiveNumber(inputs.sizeMatched) != null ||
    Boolean(inputs.associateTrades?.length);
  if (hasExecution) {
    return { hasExecution: true, statusHint: "matched" };
  }

  const status = inputs.status?.trim().toLowerCase() ?? "";
  if (
    status === "cancelled" ||
    status === "canceled" ||
    status === "cancelled_by_user" ||
    status === "canceled_by_user"
  ) {
    return { hasExecution: false, statusHint: "cancelled" };
  }

  return { hasExecution: false, statusHint: null };
}

export function resolvePolymarketTerminalReconcileStatus(inputs: {
  statusHint?: PolymarketClosedReasonHint;
  hasStoredFill?: boolean;
  executionSummary?: Pick<
    PolymarketOnchainOrderExecutionSummary,
    "hasExecution"
  > | null;
}): PolymarketTerminalReconcileStatus {
  if (inputs.hasStoredFill || inputs.executionSummary?.hasExecution) {
    return "matched";
  }
  if (inputs.statusHint === "cancelled") return "cancelled";
  return "unmatched";
}

export function resolvePolymarketUnconfirmedStatus(
  summary: Pick<
    PolymarketOnchainOrderExecutionSummary,
    "hasExecution" | "isFilledOrCancelled"
  >,
): PolymarketUnconfirmedResolution {
  if (summary.hasExecution) return POLYMARKET_UNCONFIRMED_STATUS;
  if (summary.isFilledOrCancelled) return "unmatched";
  return POLYMARKET_UNCONFIRMED_STATUS;
}

export function resolvePolymarketUnconfirmedReconcileDecision(
  summary: Pick<
    PolymarketOnchainOrderExecutionSummary,
    "hasExecution" | "isFilledOrCancelled"
  >,
): PolymarketUnconfirmedReconcileDecision {
  if (summary.hasExecution) return "sync_for_fill";
  return resolvePolymarketUnconfirmedStatus(summary);
}

export function resolvePolymarketStoredFillSyncStatus(inputs: {
  currentStatus?: string | null;
  orderType?: string | null;
  filledSize?: number | string | null;
  orderSize?: number | string | null;
}): PolymarketStoredFillSyncStatus {
  const currentStatus = inputs.currentStatus?.trim().toLowerCase() ?? "";
  if (
    currentStatus === "cancelled" ||
    currentStatus === "rejected" ||
    currentStatus === "expired"
  ) {
    return currentStatus;
  }

  const filledSize = readPositiveNumber(inputs.filledSize);
  if (filledSize != null) {
    const orderType = inputs.orderType?.trim().toUpperCase() ?? "";
    if (orderType === "FOK") return "matched";

    const orderSize = readPositiveNumber(inputs.orderSize);
    if (orderSize != null && filledSize >= orderSize) return "filled";

    return "partially_filled";
  }

  if (currentStatus === POLYMARKET_UNCONFIRMED_STATUS) {
    return POLYMARKET_UNCONFIRMED_STATUS;
  }

  return currentStatus || null;
}

export function canApplyPolymarketNoFillTerminalStatus(inputs: {
  currentStatus?: string | null;
  hasPositiveFillRows?: boolean | null;
}): boolean {
  if (inputs.hasPositiveFillRows) return false;
  const currentStatus = inputs.currentStatus?.trim().toLowerCase() ?? "";
  return !["matched", "filled", "partially_filled"].includes(currentStatus);
}

export function isPolymarketUnconfirmedStatus(
  status: string | null | undefined,
): boolean {
  if (!status) return false;
  return status.trim().toLowerCase() === POLYMARKET_UNCONFIRMED_STATUS;
}
