export const POLYMARKET_UNCONFIRMED_STATUS = "unconfirmed" as const;
export const POLYMARKET_TRADING_PAUSED_CODE =
  "polymarket_trading_paused" as const;

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
export type PolymarketNoFillTerminalStatus = "unmatched" | "expired";

export type PolymarketTerminalReconcileStatus =
  | "matched"
  | "cancelled"
  | PolymarketNoFillTerminalStatus;

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

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Polymarket uses HTTP 503 both for failures whose submission state is unknown
 * and for an explicit venue-wide trading rejection. Only the latter proves
 * that the signed order was not accepted and may safely release a linked
 * funding reservation.
 */
export function isPolymarketTradingPausedResponse(inputs: {
  message: string | null | undefined;
  status: number;
}): boolean {
  if (inputs.status !== 503) return false;
  const message = inputs.message?.trim().toLowerCase() ?? "";
  return (
    message === "trading is disabled" ||
    message === "trading disabled" ||
    message === "trading is temporarily disabled"
  );
}

function readFirstRecordField(
  records: Array<Record<string, unknown> | null>,
  keys: readonly string[],
): unknown {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      if (key in record) return record[key];
    }
  }
  return undefined;
}

function readPositiveMicroAmount(value: unknown): number | null {
  const raw = readPositiveNumber(value);
  if (raw == null) return null;
  const amount = raw / 1_000_000;
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function normalizeImmediateFillSide(value: unknown): "BUY" | "SELL" | null {
  if (value === 0 || value === "0") return "BUY";
  if (value === 1 || value === "1") return "SELL";
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "BUY" || normalized === "SELL") return normalized;
  return null;
}

/**
 * Extracts the actual immediate fill from a CLOB response before falling back
 * to the signed order. In the V2 response, makingAmount/takingAmount are raw
 * 6-decimal asset amounts: BUY makes USDC and takes shares, while SELL makes
 * shares and takes USDC. FAK may return status=matched for a partial fill, so
 * treating missing aliases as the full signed size would overstate positions.
 */
export function extractPolymarketImmediateFill(inputs: {
  fallbackPrice: number | null;
  fallbackSize: number | null;
  payload: unknown;
  side: "BUY" | "SELL";
  status: string;
}): { fromPayload: boolean; notionalUsd: number; shares: number } | null {
  const payloadRecord = isUnknownRecord(inputs.payload) ? inputs.payload : null;
  const orderRecord =
    payloadRecord && isUnknownRecord(payloadRecord.order)
      ? payloadRecord.order
      : null;
  const records = [orderRecord, payloadRecord];

  const statusNormalized = inputs.status.trim().toLowerCase();
  const side =
    normalizeImmediateFillSide(
      readFirstRecordField(records, ["side", "orderSide", "order_side"]),
    ) ?? inputs.side;

  const officialMakingAmount = readPositiveMicroAmount(
    readFirstRecordField(records, ["makingAmount", "making_amount"]),
  );
  const officialTakingAmount = readPositiveMicroAmount(
    readFirstRecordField(records, ["takingAmount", "taking_amount"]),
  );
  if (officialMakingAmount != null && officialTakingAmount != null) {
    return side === "BUY"
      ? {
          shares: officialTakingAmount,
          notionalUsd: officialMakingAmount,
          fromPayload: true,
        }
      : {
          shares: officialMakingAmount,
          notionalUsd: officialTakingAmount,
          fromPayload: true,
        };
  }

  const payloadShares =
    readPositiveNumber(
      readFirstRecordField(records, [
        "filled_size",
        "filledSize",
        "size_matched",
        "sizeMatched",
        "matched_amount",
        "matchedAmount",
      ]),
    ) ??
    readPositiveMicroAmount(
      readFirstRecordField(
        records,
        side === "BUY"
          ? ["filled_taker_amount", "filledTakerAmount"]
          : ["filled_maker_amount", "filledMakerAmount"],
      ),
    );

  const payloadPrice = readPositiveNumber(
    readFirstRecordField(records, [
      "average_fill_price",
      "averageFillPrice",
      "fill_price",
      "fillPrice",
      "price",
    ]),
  );
  const payloadNotional =
    readPositiveMicroAmount(
      readFirstRecordField(
        records,
        side === "BUY"
          ? ["filled_maker_amount", "filledMakerAmount"]
          : ["filled_taker_amount", "filledTakerAmount"],
      ),
    ) ??
    (payloadShares != null && payloadPrice != null
      ? payloadShares * payloadPrice
      : null);

  if (payloadShares != null && payloadNotional != null) {
    return {
      shares: payloadShares,
      notionalUsd: payloadNotional,
      fromPayload: true,
    };
  }

  if (statusNormalized === "partially_filled") return null;

  if (
    inputs.fallbackPrice != null &&
    inputs.fallbackSize != null &&
    Number.isFinite(inputs.fallbackPrice) &&
    Number.isFinite(inputs.fallbackSize) &&
    inputs.fallbackPrice > 0 &&
    inputs.fallbackSize > 0
  ) {
    return {
      shares: inputs.fallbackSize,
      notionalUsd: inputs.fallbackPrice * inputs.fallbackSize,
      fromPayload: false,
    };
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
  const status = inputs.status?.trim().toLowerCase() ?? "";
  const statusHint: PolymarketClosedReasonHint =
    status === "cancelled" ||
    status === "canceled" ||
    status === "cancelled_by_user" ||
    status === "canceled_by_user"
      ? "cancelled"
      : null;
  const hasExecution =
    readPositiveNumber(inputs.sizeMatched) != null ||
    Boolean(inputs.associateTrades?.length);
  if (hasExecution) {
    return { hasExecution: true, statusHint: statusHint ?? "matched" };
  }

  return { hasExecution: false, statusHint };
}

export function resolvePolymarketTerminalReconcileStatus(inputs: {
  statusHint?: PolymarketClosedReasonHint;
  hasStoredFill?: boolean;
  storedFillKind?: "full" | "partial" | null;
  executionSummary?: Pick<
    PolymarketOnchainOrderExecutionSummary,
    "hasExecution"
  > | null;
  noFillStatus?: PolymarketNoFillTerminalStatus | null;
}): PolymarketTerminalReconcileStatus | null {
  const storedFillKind =
    inputs.storedFillKind ?? (inputs.hasStoredFill ? "full" : null);
  if (storedFillKind === "full" || inputs.executionSummary?.hasExecution) {
    return "matched";
  }
  if (storedFillKind === "partial") {
    if (inputs.noFillStatus === "expired") return "expired";
    if (inputs.statusHint === "cancelled" || inputs.noFillStatus) {
      return "cancelled";
    }
    return null;
  }
  if (inputs.statusHint === "cancelled") return "cancelled";
  return inputs.noFillStatus ?? "unmatched";
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
  cancelledAt?: Date | string | null;
}): PolymarketStoredFillSyncStatus {
  const currentStatus = inputs.currentStatus?.trim().toLowerCase() ?? "";

  const filledSize = readPositiveNumber(inputs.filledSize);
  if (filledSize != null) {
    const orderType = inputs.orderType?.trim().toUpperCase() ?? "";
    if (orderType === "FOK") return "matched";

    const orderSize = readPositiveNumber(inputs.orderSize);
    if (orderSize != null && filledSize >= orderSize) return "filled";

    if (inputs.cancelledAt != null) {
      return "cancelled";
    }

    if (
      currentStatus === "cancelled" ||
      currentStatus === "expired" ||
      currentStatus === "unmatched" ||
      currentStatus === "rejected"
    ) {
      return currentStatus;
    }

    return "partially_filled";
  }

  if (currentStatus === POLYMARKET_UNCONFIRMED_STATUS) {
    return POLYMARKET_UNCONFIRMED_STATUS;
  }

  return currentStatus || null;
}

export function isPolymarketMutableNoFillStatus(
  status: string | null | undefined,
): boolean {
  const currentStatus = status?.trim().toLowerCase() ?? "";
  return [
    "pending",
    "submitted",
    "live",
    "open",
    "delayed",
    POLYMARKET_UNCONFIRMED_STATUS,
  ].includes(currentStatus);
}

export function canApplyPolymarketNoFillTerminalStatus(inputs: {
  currentStatus?: string | null;
  hasPositiveFillRows?: boolean | null;
}): boolean {
  if (inputs.hasPositiveFillRows) return false;
  return isPolymarketMutableNoFillStatus(inputs.currentStatus);
}

export function isPolymarketUnconfirmedStatus(
  status: string | null | undefined,
): boolean {
  if (!status) return false;
  return status.trim().toLowerCase() === POLYMARKET_UNCONFIRMED_STATUS;
}
