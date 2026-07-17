import { isRecord } from "../lib/type-guards.js";

export type LimitlessOrderResult = {
  explicitNoFill: boolean;
  matched: boolean | null;
  order: Record<string, unknown> | null;
  settlementStatus: string | null;
  status: string | null;
  terminalFill: boolean;
  txHash: string | null;
  venueOrderId: string | null;
};

export type LimitlessExecutionFill = {
  averagePrice: number;
  notionalUsd: number;
  shares: number;
};

const LIMITLESS_TERMINAL_SETTLEMENT_STATUSES = new Set(["mined", "confirmed"]);

function readNonEmptyString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function normalizeStatus(value: unknown): string | null {
  return (
    readNonEmptyString(value)
      ?.toLowerCase()
      .replace(/[\s-]+/g, "_") ?? null
  );
}

function executionRecord(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.execution)) return payload.execution;
  if (isRecord(payload.order) && isRecord(payload.order.execution)) {
    return payload.order.execution;
  }
  if (isRecord(payload.data)) {
    if (isRecord(payload.data.execution)) return payload.data.execution;
    if (
      isRecord(payload.data.order) &&
      isRecord(payload.data.order.execution)
    ) {
      return payload.data.order.execution;
    }
  }
  return null;
}

function orderRecord(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.order)) return payload.order;
  if (isRecord(payload.data) && isRecord(payload.data.order)) {
    return payload.data.order;
  }
  if (isRecord(payload.data)) return payload.data;
  return payload;
}

function rawMicroAmount(value: unknown): number | null {
  const normalized = readNonEmptyString(value);
  if (!normalized || !/^\d+$/.test(normalized)) return null;
  const raw = Number(normalized);
  if (!Number.isSafeInteger(raw) || raw <= 0) return null;
  return raw / 1_000_000;
}

function makerMatchRecords(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload)) return [];
  const data = isRecord(payload.data) ? payload.data : null;
  const order = isRecord(payload.order) ? payload.order : null;
  const matches =
    payload.makerMatches ?? data?.makerMatches ?? order?.makerMatches ?? null;
  return Array.isArray(matches) ? matches.filter(isRecord) : [];
}

export function extractLimitlessExecutionFill(
  payload: unknown,
): LimitlessExecutionFill | null {
  const execution = executionRecord(payload);
  const totals =
    execution && isRecord(execution.totalsRaw) ? execution.totalsRaw : null;
  let shares = rawMicroAmount(totals?.contractsGross);
  let notionalUsd = rawMicroAmount(totals?.usdGross);

  if (shares == null || notionalUsd == null) {
    let matchedShares = 0;
    let matchedNotionalUsd = 0;
    for (const match of makerMatchRecords(payload)) {
      const matchShares = rawMicroAmount(match.matchedSize);
      const matchNotional = rawMicroAmount(match.fillCost);
      if (matchShares == null || matchNotional == null) continue;
      matchedShares += matchShares;
      matchedNotionalUsd += matchNotional;
    }
    if (shares == null && matchedShares > 0) shares = matchedShares;
    if (notionalUsd == null && matchedNotionalUsd > 0) {
      notionalUsd = matchedNotionalUsd;
    }
  }

  if (shares == null || notionalUsd == null) return null;
  const averagePrice = notionalUsd / shares;
  if (!Number.isFinite(averagePrice) || averagePrice <= 0 || averagePrice > 1) {
    return null;
  }
  return { averagePrice, notionalUsd, shares };
}

export function isLimitlessUnmatchedStatus(value: unknown): boolean {
  const status = normalizeStatus(value);
  return status === "unmatched" || status === "no_fill";
}

export function isLimitlessFokUnmatchedMessage(
  message: string | null | undefined,
): boolean {
  const normalized = message?.trim().toLowerCase() ?? "";
  return (
    normalized.includes("market order unmatched") ||
    normalized.includes("order was not filled") ||
    normalized.includes("no fill")
  );
}

export function parseLimitlessOrderResult(
  payload: unknown,
): LimitlessOrderResult {
  const order = orderRecord(payload);
  const execution = executionRecord(payload);
  const matched =
    execution?.matched === true
      ? true
      : execution?.matched === false
        ? false
        : order?.matched === true
          ? true
          : order?.matched === false
            ? false
            : null;
  const reportedStatus =
    normalizeStatus(order?.status ?? order?.orderStatus) ??
    normalizeStatus(execution?.status ?? execution?.executionStatus);
  const settlementStatus = normalizeStatus(execution?.settlementStatus);
  const terminalFill =
    reportedStatus === "filled" ||
    reportedStatus === "matched" ||
    (matched === true &&
      settlementStatus != null &&
      LIMITLESS_TERMINAL_SETTLEMENT_STATUSES.has(settlementStatus));
  const status = terminalFill ? "filled" : reportedStatus;
  const venueOrderId = readNonEmptyString(
    order?.id ??
      order?.orderId ??
      order?.order_id ??
      execution?.orderId ??
      execution?.order_id,
  );

  return {
    explicitNoFill: matched === false || isLimitlessUnmatchedStatus(status),
    matched,
    order,
    settlementStatus,
    status,
    terminalFill,
    txHash: readNonEmptyString(
      execution?.txHash ?? execution?.transactionHash ?? execution?.tx_hash,
    ),
    venueOrderId,
  };
}
