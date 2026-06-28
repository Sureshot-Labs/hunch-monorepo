import { isRecord } from "../lib/type-guards.js";

export type BinaryResolvedOutcome = "YES" | "NO";

export type SafeResolutionOutcome = {
  resolvedOutcome: BinaryResolvedOutcome | null;
  resolvedOutcomePct: number | null;
};

export type PolymarketSourceRepair = {
  accepting_orders: boolean | null;
  active: boolean | null;
  archived: boolean | null;
  closed: boolean | null;
  outcome_prices: string | null;
  raw: Record<string, unknown>;
  resolution_source: string | null;
  resolved_by: string | null;
};

const EMPTY_OUTCOME: SafeResolutionOutcome = {
  resolvedOutcome: null,
  resolvedOutcomePct: null,
};

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function boolValue(
  record: Record<string, unknown>,
  keys: string[],
): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readRecordSources(record: Record<string, unknown>) {
  const sources = [record];
  const extra = parseJsonRecord(record.extra);
  if (extra) sources.push(extra);
  const account = parseJsonRecord(record.account);
  if (account) {
    sources.push(account);
    const accountExtra = parseJsonRecord(account.extra);
    if (accountExtra) sources.push(accountExtra);
  }
  return sources;
}

function readOutcomePrices(value: unknown): [number, number] | null {
  const parsed = (() => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return null;
    try {
      const decoded = JSON.parse(value);
      return Array.isArray(decoded) ? decoded : null;
    } catch {
      return null;
    }
  })();

  if (!parsed || parsed.length < 2) return null;
  const yes = parseNumber(parsed[0]);
  const no = parseNumber(parsed[1]);
  if (yes == null || no == null) return null;
  return [yes, no];
}

function polymarketOutcomePricesValue(
  market: Record<string, unknown>,
): string | null {
  const value = market.outcomePrices ?? market.outcome_prices;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (Array.isArray(value)) return JSON.stringify(value);
  return null;
}

export function resolvePolymarketGammaOutcome(
  record: Record<string, unknown>,
): SafeResolutionOutcome {
  const prices = readOutcomePrices(
    record.outcomePrices ?? record.outcome_prices,
  );
  if (!prices) return EMPTY_OUTCOME;

  const [yes, no] = prices;
  if (yes >= 0.999 && no <= 0.001) {
    return { resolvedOutcome: "YES", resolvedOutcomePct: null };
  }
  if (no >= 0.999 && yes <= 0.001) {
    return { resolvedOutcome: "NO", resolvedOutcomePct: null };
  }
  return EMPTY_OUTCOME;
}

export function buildPolymarketSourceRepair(
  market: Record<string, unknown>,
): PolymarketSourceRepair {
  return {
    accepting_orders: boolValue(market, [
      "acceptingOrders",
      "accepting_orders",
    ]),
    active: boolValue(market, ["active"]),
    archived: boolValue(market, ["archived"]),
    closed: boolValue(market, ["closed"]),
    outcome_prices: polymarketOutcomePricesValue(market),
    raw: market,
    resolution_source: stringValue(
      market.resolutionSource ?? market.resolution_source,
    ),
    resolved_by: stringValue(market.resolvedBy ?? market.resolved_by),
  };
}

export function resolveLimitlessOutcome(
  record: Record<string, unknown>,
): SafeResolutionOutcome {
  const index = parseNumber(
    record.winningOutcomeIndex ?? record.winning_outcome_index,
  );
  if (index === 0) return { resolvedOutcome: "YES", resolvedOutcomePct: null };
  if (index === 1) return { resolvedOutcome: "NO", resolvedOutcomePct: null };
  return EMPTY_OUTCOME;
}

function readScalarOutcomePct(record: Record<string, unknown>): number | null {
  const direct = parseNumber(
    record.scalarOutcomePct ?? record.scalar_outcome_pct,
  );
  if (direct != null) return direct;

  const accounts = record.accounts;
  if (!isRecord(accounts)) return null;

  const candidates = Object.values(accounts)
    .filter(isRecord)
    .map((account) =>
      parseNumber(account.scalarOutcomePct ?? account.scalar_outcome_pct),
    )
    .filter((value): value is number => value != null);

  if (candidates.length === 0) return null;
  const first = candidates[0];
  return candidates.every((candidate) => Math.abs(candidate - first) < 1e-9)
    ? first
    : null;
}

export function resolveDflowOutcome(
  record: Record<string, unknown>,
): SafeResolutionOutcome {
  const sources = readRecordSources(record);
  const result =
    sources
      .map((source) => stringValue(source.result))
      .find((value): value is string => Boolean(value))
      ?.toLowerCase() ?? null;
  const resolvedOutcome =
    result === "yes" ? "YES" : result === "no" ? "NO" : null;
  const resolvedOutcomePct =
    sources
      .map(readScalarOutcomePct)
      .find((value): value is number => value != null) ?? null;

  if (resolvedOutcome || resolvedOutcomePct != null) {
    return { resolvedOutcome, resolvedOutcomePct };
  }
  return EMPTY_OUTCOME;
}

export function hasSafeResolutionOutcome(
  outcome: SafeResolutionOutcome,
): boolean {
  return (
    outcome.resolvedOutcome !== null || outcome.resolvedOutcomePct !== null
  );
}
