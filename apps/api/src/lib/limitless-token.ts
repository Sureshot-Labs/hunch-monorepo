type LimitlessTokenInput = string | number | bigint | null | undefined;

export function normalizeLimitlessRawTokenId(
  value: LimitlessTokenInput,
): string | null {
  if (value == null) return null;
  const source =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : null;
  if (source == null) return null;
  const trimmed = source.trim();
  if (!trimmed) return null;

  const withoutPrefix = trimmed.startsWith("limitless:")
    ? trimmed.slice(10)
    : trimmed;
  const beforeOutcome = withoutPrefix.split(":")[0]?.trim() ?? "";
  if (!beforeOutcome) return null;
  if (/^\d+$/.test(beforeOutcome)) return beforeOutcome;

  const leadingDigits = beforeOutcome.match(/^(\d+)/);
  return leadingDigits?.[1] ?? null;
}

export function normalizeLimitlessScopedTokenId(
  value: LimitlessTokenInput,
): string | null {
  const raw = normalizeLimitlessRawTokenId(value);
  return raw ? `limitless:${raw}` : null;
}
