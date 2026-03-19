function parseNumberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function shouldScalePercentPair(
  values: Array<number | null>,
  tradeType?: string | null,
): boolean {
  const normalized = values.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  if (!normalized.length) return false;
  if (normalized.some((value) => value > 1)) return true;
  if (tradeType?.toLowerCase() === "amm") {
    const sum = normalized.reduce((acc, value) => acc + value, 0);
    if (sum > 1.5) return true;
  }
  return false;
}

export function normalizeLimitlessPricePair(
  values: Array<unknown>,
  tradeType?: string | null,
): Array<number | undefined> {
  const parsed = values.map((value) => parseNumberish(value));
  const scale = shouldScalePercentPair(parsed, tradeType);
  return parsed.map((value) => {
    if (value == null || Number.isNaN(value)) return undefined;
    return scale ? value / 100 : value;
  });
}
