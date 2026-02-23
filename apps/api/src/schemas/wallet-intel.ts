import { z } from "zod";

import { zVenue } from "./common.js";

const zChain = z.enum(["polygon", "base", "solana"]);
const filterModeSchema = z.enum(["any", "all"]).default("any");
const signalSeveritySchema = z.enum(["low", "medium", "high", "critical"]);

const csvStringArraySchema = z.preprocess(
  value => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      return value
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
    }
    return undefined;
  },
  z.array(z.string().min(1)).optional()
);

const categoriesCsvSchema = z.preprocess(
  value => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      return value
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
    }
    return undefined;
  },
  z.array(z.string().min(1)).optional()
);

export const walletFollowBodySchema = z.object({
  address: z.string().min(4),
  chain: zChain,
  label: z.string().min(1).max(120).optional(),
});

export const walletFollowParamsSchema = z.object({
  address: z.string().min(4),
});

export const walletFollowDeleteQuerySchema = z.object({
  chain: zChain,
});

export const walletFollowingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const walletProfileParamsSchema = z.object({
  walletId: z.string().uuid(),
});

export const walletActivityQuerySchema = z.object({
  walletId: z.string().uuid().optional(),
  venue: zVenue.optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const walletActivitySummaryQuerySchema = z.object({
  scope: z.enum(["following", "whales", "all"]).default("whales"),
  windowHours: z.coerce.number().int().min(1).optional(),
  topChanges: z.coerce.number().int().min(1).max(10).default(5),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z
    .enum(["last_activity", "net_change_usd", "unusual_score"])
    .default("last_activity"),
  categories: categoriesCsvSchema.optional(),
  tags: csvStringArraySchema.optional(),
  tagMode: filterModeSchema,
  primary: csvStringArraySchema.optional(),
  labels: csvStringArraySchema.optional(),
  labelMode: filterModeSchema,
  includeAttribution: z.coerce.boolean().default(true),
});

export const walletActivitySignalsQuerySchema = z.object({
  scope: z.enum(["following", "active", "all"]).default("following"),
  windowHours: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  minStakeUsd: z.coerce.number().min(0).optional(),
  maxOdds: z.coerce.number().min(0).max(1).optional(),
  minIdleDays: z.coerce.number().int().min(0).optional(),
  maxPriorMarkets: z.coerce.number().int().min(0).optional(),
  minPayoutUsd: z.coerce.number().min(0).optional(),
  minScore: z.coerce.number().min(0).max(1).optional(),
  signalType: z.enum(["longshot_large", "longshot_large_late"]).optional(),
  lateBucket: z.enum(["late", "very_late", "unknown"]).optional(),
  categories: categoriesCsvSchema.optional(),
  tags: csvStringArraySchema.optional(),
  tagMode: filterModeSchema,
  primary: csvStringArraySchema.optional(),
  labels: csvStringArraySchema.optional(),
  labelMode: filterModeSchema,
  severity: z
    .preprocess(
      value => {
        if (Array.isArray(value)) return value;
        if (typeof value === "string") {
          return value
            .split(",")
            .map(item => item.trim())
            .filter(Boolean);
        }
        return undefined;
      },
      z.array(signalSeveritySchema).optional()
    )
    .optional(),
  displayReasons: csvStringArraySchema.optional(),
  signalReasonMode: filterModeSchema,
  includeAttribution: z.coerce.boolean().default(false),
});

export const walletPositionsQuerySchema = z.object({
  walletId: z.string().uuid().optional(),
  venue: zVenue.optional(),
  since: z.string().datetime().optional(),
  latest: z.coerce.boolean().default(true),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const walletWhalesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  marketLimit: z.coerce.number().int().min(1).max(20).default(5),
  windowDays: z.coerce.number().int().min(1).max(365).default(30),
  includeSummary: z.coerce.boolean().default(false),
  windowHours: z.coerce.number().int().min(1).max(24 * 14).default(24),
  topChanges: z.coerce.number().int().min(1).max(10).default(3),
  categories: z
    .preprocess(
      value => {
        if (Array.isArray(value)) return value;
        if (typeof value === "string") {
          return value
            .split(",")
            .map(item => item.trim())
            .filter(Boolean);
        }
        return undefined;
      },
      z.array(z.string().min(1)).optional()
    )
    .optional(),
  sort: z
    .enum([
      "last_activity",
      "volume_30d",
      "trades_30d",
      "exposure_usd",
      "winrate",
      "pnl_30d",
    ])
    .default("last_activity"),
  tags: csvStringArraySchema.optional(),
  tagMode: filterModeSchema,
  primary: csvStringArraySchema.optional(),
  labels: csvStringArraySchema.optional(),
  labelMode: filterModeSchema,
  includeAttribution: z.coerce.boolean().default(true),
});
