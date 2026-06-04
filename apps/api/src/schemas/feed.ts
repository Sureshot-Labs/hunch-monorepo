import { z } from "zod";
import { env } from "../env.js";
import { zVenue } from "./common.js";

const zVenueQuery = z
  .preprocess((v) => {
    const toParts = (value: unknown): string[] => {
      if (Array.isArray(value)) {
        return value
          .filter((p): p is string => typeof p === "string")
          .flatMap((p) => p.split(","))
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean);
      }
      if (typeof value === "string") {
        return value
          .split(",")
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean);
      }
      return [];
    };

    const parts = toParts(v);
    return parts.length ? parts : undefined;
  }, z.array(zVenue).optional())
  .transform((venues) => {
    if (!venues?.length) return undefined;
    const unique = Array.from(new Set(venues)).sort();
    // Treat selecting all venues the same as omitting the filter.
    return unique.length === zVenue.options.length ? undefined : unique;
  });

const zCategoriesQuery = z
  .preprocess((v) => {
    const toParts = (value: unknown): string[] => {
      if (Array.isArray(value)) {
        return value
          .filter((p): p is string => typeof p === "string")
          .flatMap((p) => p.split(","))
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean);
      }
      if (typeof value === "string") {
        return value
          .split(",")
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean);
      }
      return [];
    };

    const parts = toParts(v);
    return parts.length ? parts : undefined;
  }, z.array(z.string()).optional())
  .transform((categories) => {
    if (!categories?.length) return undefined;
    return Array.from(new Set(categories)).sort();
  });

const SUPPORTED_DURATION_MINUTES = [5, 15, 60] as const;
const supportedDurationMinuteSet = new Set<number>(SUPPORTED_DURATION_MINUTES);

export const zDurationMinutesQuery = z
  .preprocess((v) => {
    if (v == null) return undefined;
    const values = Array.isArray(v) ? v : [v];
    const out: number[] = [];
    let sawValue = false;

    for (const value of values) {
      const parts = typeof value === "string" ? value.split(",") : [value];
      for (const part of parts) {
        if (typeof part === "number") {
          if (!Number.isInteger(part) || part <= 0) return Number.NaN;
          sawValue = true;
          out.push(part);
          continue;
        }
        if (typeof part !== "string") return Number.NaN;
        const trimmed = part.trim();
        if (!trimmed) return Number.NaN;
        if (!/^\d+$/.test(trimmed)) return Number.NaN;
        sawValue = true;
        out.push(Number(trimmed));
      }
    }

    return sawValue ? out : undefined;
  }, z.array(z.number().int().positive()).optional())
  .superRefine((values, ctx) => {
    for (const value of values ?? []) {
      if (!supportedDurationMinuteSet.has(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "duration_minutes must be one of 5, 15, or 60",
        });
        return;
      }
    }
  })
  .transform((values) => {
    if (!values?.length) return undefined;
    return Array.from(new Set(values)).sort((a, b) => a - b);
  });

export const feedQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .catch(env.defaultLimit)
    .transform((n) => Math.min(Math.max(n, 1), env.maxLimit)),
  offset: z.coerce
    .number()
    .int()
    .catch(0)
    .transform((n) => Math.max(n, 0)),
  min_total_volume: z.coerce.number().optional(),
  min_volume24hr: z.coerce.number().catch(1e-9),
  min_liquidity: z.coerce.number().catch(0),
  q: z
    .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
    .optional()
    .transform((v) => (v && v.length ? v : undefined)),
  view: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.string(),
    )
    .optional()
    .transform((v) => (v === "events" || v === "markets" ? v : undefined)),
  event_scope: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.string(),
    )
    .optional()
    .transform((v) => (v === "grouped" || v === "single" ? v : undefined)),
  venue: zVenueQuery,
  category: z.string().optional(),
  categories: zCategoriesQuery,
  filter: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.string(),
    )
    .optional()
    .transform((v) => (v === "newest" || v === "endingsoon" ? v : undefined)),
  sort: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.string(),
    )
    .optional()
    .transform((v) =>
      v === "trending" ||
      v === "trending_v2" ||
      v === "totalvol" ||
      v === "liquidity" ||
      v === "openinterest" ||
      v === "change24h" ||
      v === "time"
        ? v
        : undefined,
    ),
  sort_dir: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.string(),
    )
    .optional()
    .transform((v) => (v === "asc" || v === "desc" ? v : undefined)),
  min_prob: z.coerce
    .number()
    .optional()
    .transform((v) => (v == null ? undefined : Math.min(1, Math.max(0, v)))),
  max_prob: z.coerce
    .number()
    .optional()
    .transform((v) => (v == null ? undefined : Math.min(1, Math.max(0, v)))),
  max_spread: z.coerce
    .number()
    .optional()
    .transform((v) => (v == null ? undefined : Math.min(1, Math.max(0, v)))),
  duration_minutes: zDurationMinutesQuery,
  end_within_hours: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .transform((v) => (v == null ? undefined : Math.min(24 * 365 * 5, v))),
  age_within_hours: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .transform((v) => (v == null ? undefined : Math.min(24 * 365 * 5, v))),
});

export const feedFacetQuerySchema = feedQuerySchema.pick({
  min_total_volume: true,
  min_volume24hr: true,
  min_liquidity: true,
  q: true,
  view: true,
  event_scope: true,
  venue: true,
  category: true,
  categories: true,
  filter: true,
  min_prob: true,
  max_prob: true,
  max_spread: true,
  duration_minutes: true,
  end_within_hours: true,
  age_within_hours: true,
});

export function resolveMinTotalVolumeFilter(query: {
  min_total_volume?: number;
  min_volume24hr?: number;
}): number {
  if (
    typeof query.min_total_volume === "number" &&
    Number.isFinite(query.min_total_volume)
  ) {
    return query.min_total_volume;
  }
  if (
    typeof query.min_volume24hr === "number" &&
    Number.isFinite(query.min_volume24hr)
  ) {
    return query.min_volume24hr;
  }
  return 1e-9;
}
