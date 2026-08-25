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

/**
 * `/orders/status/batch` wraps an order one level deeper than submit does:
 * `{ status: "found", data: { order: { order, execution } } }`. Normalize
 * only that known shape, retaining the older submit/receipt envelopes.
 */
function statusOrderRoot(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (
    isRecord(payload.data) &&
    isRecord(payload.data.order) &&
    isRecord(payload.data.order.order)
  ) {
    return payload.data.order;
  }
  return payload;
}

function executionRecord(payload: unknown): Record<string, unknown> | null {
  const root = statusOrderRoot(payload);
  if (!root) return null;
  if (isRecord(root.execution)) return root.execution;
  if (isRecord(root.order) && isRecord(root.order.execution)) {
    return root.order.execution;
  }
  if (isRecord(root.data)) {
    if (isRecord(root.data.execution)) return root.data.execution;
    if (isRecord(root.data.order) && isRecord(root.data.order.execution)) {
      return root.data.order.execution;
    }
  }
  return null;
}

function orderRecord(payload: unknown): Record<string, unknown> | null {
  const root = statusOrderRoot(payload);
  if (!root) return null;
  if (isRecord(root.order)) return root.order;
  if (isRecord(root.data) && isRecord(root.data.order)) {
    return root.data.order;
  }
  if (isRecord(root.data)) return root.data;
  return root;
}

function rawMicroAmount(value: unknown): number | null {
  const normalized = readNonEmptyString(value);
  if (!normalized || !/^\d+$/.test(normalized)) return null;
  const raw = Number(normalized);
  if (!Number.isSafeInteger(raw) || raw <= 0) return null;
  return raw / 1_000_000;
}

function makerMatchRecords(payload: unknown): Record<string, unknown>[] {
  const root = statusOrderRoot(payload);
  if (!root) return [];
  const data = isRecord(root.data) ? root.data : null;
  const order = isRecord(root.order) ? root.order : null;
  const matches =
    root.makerMatches ?? data?.makerMatches ?? order?.makerMatches ?? null;
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
    // `matched: false` is also emitted while a Limitless FOK order is still
    // queued with settlementStatus=DELAYED. Only an explicit terminal status
    // proves no fill; otherwise keep the order on the reconciliation path.
    explicitNoFill:
      isLimitlessUnmatchedStatus(status) ||
      isLimitlessUnmatchedStatus(settlementStatus),
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
