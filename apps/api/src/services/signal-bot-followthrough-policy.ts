import type { DbQuery } from "../db.js";

export type SignalBotFollowthroughType =
  | "resolved_loss"
  | "resolved_win"
  | "stats";

export type SignalBotFollowthroughDataQuality = "any" | "clean" | "usable";

export type SignalBotFollowthroughPolicy = {
  enabled: boolean;
  types: SignalBotFollowthroughType[];
  minAgeHours: number;
  maxPerTick: number;
  minJoinedOrAdded: number;
  minNetFlowUsd: number;
  minPriceMoveCents: number;
  requirePositiveFlowForStats: boolean;
  minDataQuality: SignalBotFollowthroughDataQuality;
  terminalInitialCutoff: string | null;
};

export const DEFAULT_SIGNAL_BOT_FOLLOWTHROUGH_TYPES: SignalBotFollowthroughType[] =
  ["stats", "resolved_win", "resolved_loss"];

function normalizeSignalBotFollowthroughTypes(
  input: SignalBotFollowthroughType[],
): SignalBotFollowthroughType[] {
  const types = Array.from(new Set(input.filter(isSignalBotFollowthroughType)));
  if (types.length === 0) return DEFAULT_SIGNAL_BOT_FOLLOWTHROUGH_TYPES;

  // Terminal outcomes are an atomic track-record feature. Legacy runtime
  // policies commonly enabled only resolved_win; preserving that shape would
  // selectively publish winners and silently suppress losses.
  if (types.includes("resolved_win") || types.includes("resolved_loss")) {
    if (!types.includes("resolved_win")) types.push("resolved_win");
    if (!types.includes("resolved_loss")) types.push("resolved_loss");
  }
  return types;
}

function isSignalBotFollowthroughType(
  value: string,
): value is SignalBotFollowthroughType {
  return (
    value === "stats" || value === "resolved_win" || value === "resolved_loss"
  );
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const asInt = Math.trunc(parsed);
  return asInt > 0 ? asInt : fallback;
}

function parseSignalBotFollowthroughTypes(
  value: string | undefined,
  fallback: SignalBotFollowthroughType[],
): SignalBotFollowthroughType[] {
  if (!value) return fallback;
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(isSignalBotFollowthroughType);
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function parseSignalBotFollowthroughDataQuality(
  value: unknown,
  fallback: SignalBotFollowthroughDataQuality,
): SignalBotFollowthroughDataQuality {
  return value === "any" || value === "usable" || value === "clean"
    ? value
    : fallback;
}

function clampSignalBotNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeSignalBotFollowthroughPolicy(
  policy: SignalBotFollowthroughPolicy,
): SignalBotFollowthroughPolicy {
  return {
    enabled: Boolean(policy.enabled),
    types: normalizeSignalBotFollowthroughTypes(policy.types),
    minAgeHours: clampSignalBotNumber(
      Math.trunc(policy.minAgeHours),
      1,
      24 * 365,
    ),
    maxPerTick: clampSignalBotNumber(Math.trunc(policy.maxPerTick), 1, 100),
    minJoinedOrAdded: clampSignalBotNumber(
      Math.trunc(policy.minJoinedOrAdded),
      1,
      1_000,
    ),
    minNetFlowUsd: clampSignalBotNumber(policy.minNetFlowUsd, 0, 100_000_000),
    minPriceMoveCents: clampSignalBotNumber(policy.minPriceMoveCents, 0, 100),
    requirePositiveFlowForStats: Boolean(policy.requirePositiveFlowForStats),
    minDataQuality: parseSignalBotFollowthroughDataQuality(
      policy.minDataQuality,
      "any",
    ),
    terminalInitialCutoff: parseIsoDate(policy.terminalInitialCutoff),
  };
}

export function defaultSignalBotFollowthroughPolicy(
  env: NodeJS.ProcessEnv = process.env,
): SignalBotFollowthroughPolicy {
  return normalizeSignalBotFollowthroughPolicy({
    enabled: parseBool(env.HUNCH_SIGNAL_BOT_FOLLOWTHROUGH_ENABLED, false),
    types: parseSignalBotFollowthroughTypes(
      env.HUNCH_SIGNAL_BOT_FOLLOWTHROUGH_TYPES,
      DEFAULT_SIGNAL_BOT_FOLLOWTHROUGH_TYPES,
    ),
    minAgeHours: parsePositiveInt(
      env.HUNCH_SIGNAL_BOT_FOLLOWTHROUGH_MIN_AGE_HOURS,
      24,
    ),
    maxPerTick: parsePositiveInt(
      env.HUNCH_SIGNAL_BOT_FOLLOWTHROUGH_MAX_PER_TICK,
      3,
    ),
    minJoinedOrAdded: parsePositiveInt(
      env.HUNCH_SIGNAL_BOT_FOLLOWTHROUGH_MIN_JOINED_OR_ADDED,
      2,
    ),
    minNetFlowUsd: parsePositiveInt(
      env.HUNCH_SIGNAL_BOT_FOLLOWTHROUGH_MIN_NET_FLOW_USD,
      10_000,
    ),
    minPriceMoveCents: parsePositiveInt(
      env.HUNCH_SIGNAL_BOT_FOLLOWTHROUGH_MIN_PRICE_MOVE_CENTS,
      10,
    ),
    requirePositiveFlowForStats: parseBool(
      env.HUNCH_SIGNAL_BOT_FOLLOWTHROUGH_REQUIRE_POSITIVE_FLOW_FOR_STATS,
      false,
    ),
    minDataQuality: parseSignalBotFollowthroughDataQuality(
      env.HUNCH_SIGNAL_BOT_FOLLOWTHROUGH_MIN_DATA_QUALITY,
      "any",
    ),
    terminalInitialCutoff: parseIsoDate(
      env.HUNCH_SIGNAL_BOT_TERMINAL_INITIAL_CUTOFF,
    ),
  });
}

export function mergeSignalBotFollowthroughPolicy(
  defaults: SignalBotFollowthroughPolicy,
  override: unknown,
): SignalBotFollowthroughPolicy {
  const raw = asObject(override);
  const types = Array.isArray(raw.signalBotFollowthroughTypes)
    ? raw.signalBotFollowthroughTypes
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(isSignalBotFollowthroughType)
    : defaults.types;
  return normalizeSignalBotFollowthroughPolicy({
    enabled:
      typeof raw.signalBotFollowthroughEnabled === "boolean"
        ? raw.signalBotFollowthroughEnabled
        : defaults.enabled,
    types,
    minAgeHours:
      toNumber(raw.signalBotFollowthroughMinAgeHours) ?? defaults.minAgeHours,
    maxPerTick:
      toNumber(raw.signalBotFollowthroughMaxPerTick) ?? defaults.maxPerTick,
    minJoinedOrAdded:
      toNumber(raw.signalBotFollowthroughMinJoinedOrAdded) ??
      defaults.minJoinedOrAdded,
    minNetFlowUsd:
      toNumber(raw.signalBotFollowthroughMinNetFlowUsd) ??
      defaults.minNetFlowUsd,
    minPriceMoveCents:
      toNumber(raw.signalBotFollowthroughMinPriceMoveCents) ??
      defaults.minPriceMoveCents,
    requirePositiveFlowForStats:
      typeof raw.signalBotFollowthroughRequirePositiveFlowForStats === "boolean"
        ? raw.signalBotFollowthroughRequirePositiveFlowForStats
        : defaults.requirePositiveFlowForStats,
    minDataQuality: parseSignalBotFollowthroughDataQuality(
      raw.signalBotFollowthroughMinDataQuality,
      defaults.minDataQuality,
    ),
    terminalInitialCutoff:
      "signalBotTerminalInitialCutoff" in raw
        ? parseIsoDate(raw.signalBotTerminalInitialCutoff)
        : defaults.terminalInitialCutoff,
  });
}

export async function resolveSignalBotFollowthroughPolicy(
  db: DbQuery,
  defaults: SignalBotFollowthroughPolicy,
): Promise<SignalBotFollowthroughPolicy> {
  try {
    const { rows } = await db.query<{ payload: unknown }>(
      `
        select payload
        from runtime_policies
        where policy_key = 'holder_research'
          and effective_at <= now()
        order by effective_at desc, created_at desc
        limit 1
      `,
    );
    return mergeSignalBotFollowthroughPolicy(defaults, rows[0]?.payload);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "42P01"
    ) {
      return defaults;
    }
    throw error;
  }
}
