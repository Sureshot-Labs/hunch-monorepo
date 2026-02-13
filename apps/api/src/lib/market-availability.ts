type ComputeAcceptingOrdersInput = {
  status: string | null | undefined;
  closeTime?: unknown;
  expirationTime?: unknown;
  pmAcceptingOrders?: boolean | null;
  nowMs?: number;
};

function parseTimestampMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

export function computeAcceptingOrders(
  input: ComputeAcceptingOrdersInput,
): boolean {
  const nowMs = input.nowMs ?? Date.now();
  const status = input.status ?? null;
  const normalizedStatus =
    typeof status === "string" ? status.toUpperCase() : null;
  const inactiveByStatus =
    normalizedStatus != null && normalizedStatus !== "ACTIVE";

  const closeMs = parseTimestampMs(input.closeTime);
  const expirationMs = parseTimestampMs(input.expirationTime);
  const closedByTime =
    (closeMs != null && closeMs <= nowMs) ||
    (expirationMs != null && expirationMs <= nowMs);

  const activeByUnified =
    normalizedStatus == null
      ? !closedByTime
      : normalizedStatus === "ACTIVE" && !closedByTime;

  // Fail-closed override for Polymarket-specific availability.
  if (input.pmAcceptingOrders === false) return false;

  // If Polymarket explicitly says orders are accepted, trust that signal unless
  // unified status is explicitly non-active.
  if (input.pmAcceptingOrders === true) {
    if (inactiveByStatus) return false;
    return true;
  }

  return activeByUnified;
}
