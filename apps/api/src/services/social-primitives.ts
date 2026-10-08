import { createHash } from "node:crypto";

export class SocialError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400,
  ) {
    super(code);
    this.name = "SocialError";
  }
}

export function graphemeLength(value: string): number {
  return [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      value,
    ),
  ].length;
}

export function socialText(
  value: string,
  maximum: number,
  allowEmpty = false,
): string {
  const normalized = value.normalize("NFC").trim();
  if ((!allowEmpty && !normalized) || graphemeLength(normalized) > maximum)
    throw new SocialError("invalid_text_length");
  return normalized;
}

export function normalizeSocialHandle(
  value: string,
  minimum: number,
  maximum: number,
): string {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[a-z0-9_]+$/.test(normalized) ||
    normalized.length < minimum ||
    normalized.length > maximum
  )
    throw new SocialError("invalid_handle");
  return normalized;
}

export function socialFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type SocialCursor = {
  version: 1;
  scope: string;
  timestamp: string;
  kind: "thesis" | "hunch" | "comment" | "user" | "report";
  id: string;
};

export function encodeSocialCursor(
  value: Omit<SocialCursor, "version">,
): string {
  return Buffer.from(JSON.stringify({ version: 1, ...value })).toString(
    "base64url",
  );
}

export function decodeSocialCursor(
  raw: string | undefined,
  scope: string,
): SocialCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as SocialCursor;
    const parts =
      typeof value.timestamp === "string"
        ? value.timestamp.slice(0, 10).split("-").map(Number)
        : [];
    const [year, month, day] = parts;
    const calendarValid =
      parts.length === 3 &&
      year > 0 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (
      value.version !== 1 ||
      value.scope !== scope ||
      !["thesis", "hunch", "comment", "user", "report"].includes(value.kind) ||
      !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(
        value.timestamp,
      ) ||
      !calendarValid ||
      !Number.isFinite(Date.parse(value.timestamp)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value.id,
      )
    )
      throw new Error("invalid");
    return value;
  } catch {
    throw new SocialError("invalid_cursor");
  }
}

// Decimal operations preserve provider quantities without an IEEE-754 round-trip.
function decimal(value: string): { units: bigint; scale: number } {
  if (!/^-?\d+(?:\.\d+)?$/.test(value))
    throw new SocialError("invalid_decimal");
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function formatDecimal(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString()
    .padStart(scale + 1, "0");
  const result = scale
    ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "")
    : digits;
  return `${negative && units !== 0n ? "-" : ""}${result || "0"}`;
}

export function compareSocialDecimal(a: string, b: string): number {
  const left = decimal(a);
  const right = decimal(b);
  const scale = Math.max(left.scale, right.scale);
  const difference =
    left.units * 10n ** BigInt(scale - left.scale) -
    right.units * 10n ** BigInt(scale - right.scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function multiplySocialDecimal(a: string, b: string): string {
  const left = decimal(a);
  const right = decimal(b);
  return formatDecimal(left.units * right.units, left.scale + right.scale);
}

export function subtractSocialDecimal(a: string, b: string): string {
  const left = decimal(a);
  const right = decimal(b);
  const scale = Math.max(left.scale, right.scale);
  return formatDecimal(
    left.units * 10n ** BigInt(scale - left.scale) -
      right.units * 10n ** BigInt(scale - right.scale),
    scale,
  );
}

export function divideSocialDecimal(
  a: string,
  b: string,
  places = 12,
): string | null {
  const left = decimal(a);
  const right = decimal(b);
  if (right.units === 0n) return null;
  const units =
    (left.units * 10n ** BigInt(right.scale + places)) /
    (right.units * 10n ** BigInt(left.scale));
  return formatDecimal(units, places);
}

export function socialPositionMetrics(input: {
  notional: string;
  grossShares: string;
  netShares: string;
  outcome: string;
  resolvedOutcome: string | null;
  resolvedOutcomePct: string | null;
  active: boolean;
  mark: string | null;
}) {
  let state: "open" | "pending" | "win" | "loss" | "fractional" | "void" =
    input.active ? "open" : "pending";
  let price: string | null = input.active ? input.mark : null;
  const official = input.resolvedOutcome?.toUpperCase();
  if (official === "YES" || official === "NO") {
    price = official === input.outcome.toUpperCase() ? "1" : "0";
    state = price === "1" ? "win" : "loss";
  } else if (official === "VOID" || official === "INVALID") {
    state = "void";
    price = null;
  } else if (
    input.resolvedOutcomePct !== null &&
    compareSocialDecimal(input.resolvedOutcomePct, "0") >= 0 &&
    compareSocialDecimal(input.resolvedOutcomePct, "10000") <= 0
  ) {
    const yes = divideSocialDecimal(input.resolvedOutcomePct, "10000") ?? "0";
    price =
      input.outcome.toUpperCase() === "NO"
        ? subtractSocialDecimal("1", yes)
        : yes;
    state = price === "1" ? "win" : price === "0" ? "loss" : "fractional";
  }
  const value =
    price === null ? null : multiplySocialDecimal(input.netShares, price);
  const pnl =
    value === null ? null : subtractSocialDecimal(value, input.notional);
  return {
    state,
    entryPrice: divideSocialDecimal(input.notional, input.grossShares),
    markPrice: price,
    markedValueUsd: value,
    pnlUsd: pnl,
    returnFraction:
      pnl === null ? null : divideSocialDecimal(pnl, input.notional),
    potentialPayoutUsd: input.netShares,
    feeTreatment: "excluded" as const,
  };
}
