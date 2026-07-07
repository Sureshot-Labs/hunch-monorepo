import { z } from "zod";

import type { DbQuery } from "../db.js";
import { fetchActiveRuntimePolicy } from "../repos/runtime-policies.js";

export type SignalBotTradingAction = "buy" | "sell";
export type SignalBotTradingVenue = "polymarket" | "limitless" | "kalshi";

export type SignalBotPolicy = {
  tradingEnabled: boolean;
  tradingActions: SignalBotTradingAction[];
  tradingVenues: SignalBotTradingVenue[];
  buyAmountPresetsUsd: number[];
  maxTradeAmountUsd: number;
  maxSlippageBps: number;
  intentTtlSec: number;
  requireConfirmation: boolean;
};

const positiveInt = z.coerce.number().int().min(1);
const nonNegativeInt = z.coerce.number().int().min(0);
const strictBoolean = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return value;
}, z.boolean());

const signalBotTradingActionSchema = z.enum(["buy", "sell"]);
const signalBotTradingVenueSchema = z.enum([
  "polymarket",
  "limitless",
  "kalshi",
]);

export const signalBotSchema = z
  .object({
    tradingEnabled: strictBoolean,
    tradingActions: z.array(signalBotTradingActionSchema).max(8),
    tradingVenues: z.array(signalBotTradingVenueSchema).max(8),
    buyAmountPresetsUsd: z.array(positiveInt.max(10_000)).max(8),
    maxTradeAmountUsd: positiveInt.max(100_000),
    maxSlippageBps: nonNegativeInt.max(10_000),
    intentTtlSec: positiveInt.max(3_600),
    requireConfirmation: strictBoolean,
  })
  .strict()
  .partial();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return base;
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = next[key];
    if (Array.isArray(value)) {
      next[key] = value;
      continue;
    }
    if (isPlainObject(current) && isPlainObject(value)) {
      next[key] = deepMerge(current, value);
      continue;
    }
    next[key] = value;
  }
  return next as T;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getDefaultSignalBotPolicy(): SignalBotPolicy {
  return {
    tradingEnabled: false,
    tradingActions: ["buy"],
    tradingVenues: ["polymarket", "limitless", "kalshi"],
    buyAmountPresetsUsd: [10, 25, 50],
    maxTradeAmountUsd: 50,
    maxSlippageBps: 500,
    intentTtlSec: 120,
    requireConfirmation: true,
  };
}

export function sanitizeSignalBotPolicyOverride(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const record = { ...(payload as Record<string, unknown>) };
  delete record.requireConfirmation;
  return record;
}

export function normalizeSignalBotPolicy(
  policy: SignalBotPolicy,
): SignalBotPolicy {
  const tradingActions = Array.from(
    new Set(
      policy.tradingActions.filter(
        (action) => signalBotTradingActionSchema.safeParse(action).success,
      ),
    ),
  );
  const venues = Array.from(
    new Set(
      policy.tradingVenues.filter(
        (venue) => signalBotTradingVenueSchema.safeParse(venue).success,
      ),
    ),
  );
  const maxTradeAmountUsd = clamp(
    Math.trunc(policy.maxTradeAmountUsd),
    1,
    100_000,
  );
  const presets = Array.from(
    new Set(
      policy.buyAmountPresetsUsd
        .map((amount) => Math.trunc(amount))
        .filter((amount) => amount > 0 && amount <= maxTradeAmountUsd),
    ),
  ).slice(0, 8);

  return {
    tradingEnabled: Boolean(policy.tradingEnabled),
    tradingActions,
    tradingVenues: venues,
    buyAmountPresetsUsd: presets.length > 0 ? presets : [maxTradeAmountUsd],
    maxTradeAmountUsd,
    maxSlippageBps: clamp(Math.trunc(policy.maxSlippageBps), 0, 10_000),
    intentTtlSec: clamp(Math.trunc(policy.intentTtlSec), 30, 3_600),
    requireConfirmation: true,
  };
}

export async function resolveSignalBotTradingPolicyFromDb(
  pool: DbQuery,
): Promise<SignalBotPolicy> {
  const defaults = getDefaultSignalBotPolicy();
  const row = await fetchActiveRuntimePolicy(pool, "signal_bot");
  if (!row) return defaults;
  const parsed = signalBotSchema.safeParse(
    sanitizeSignalBotPolicyOverride(row.payload),
  );
  if (!parsed.success) return defaults;
  return normalizeSignalBotPolicy(deepMerge(defaults, parsed.data));
}
