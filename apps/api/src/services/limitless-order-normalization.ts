const LIMITLESS_RAW_DECIMALS = 1_000_000;

function parseNumberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isDecimalString(value: unknown): boolean {
  return typeof value === "string" && value.includes(".");
}

export function normalizeLimitlessRawAmount(
  value: number | null,
): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const normalized = value / LIMITLESS_RAW_DECIMALS;
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

export function normalizeLimitlessMaybeRawAmount(
  value: unknown,
): number | null {
  const parsed = parseNumberish(value);
  if (parsed == null || !Number.isFinite(parsed) || parsed <= 0) return null;
  if (isDecimalString(value)) return parsed;
  if (Number.isInteger(parsed) && Math.abs(parsed) >= 1_000) {
    return normalizeLimitlessRawAmount(parsed);
  }
  return parsed;
}

export function normalizeLimitlessHistoryAmount(value: unknown): number | null {
  const parsed = parseNumberish(value);
  if (parsed == null || !Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function deriveLimitlessSignedOrderSize(inputs: {
  orderType: string | null;
  side: "BUY" | "SELL" | null;
  makerAmount: number | null;
  takerAmount: number | null;
}): number | null {
  if (!inputs.side) return null;
  if (inputs.orderType !== "GTC" && inputs.orderType !== "FOK") return null;

  const shares =
    inputs.side === "BUY" ? inputs.takerAmount : inputs.makerAmount;
  if (shares == null || !Number.isFinite(shares) || shares <= 0) return null;

  if (inputs.orderType === "FOK" && inputs.side === "BUY" && shares <= 1) {
    return null;
  }

  return normalizeLimitlessRawAmount(shares);
}
