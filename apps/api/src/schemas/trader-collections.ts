import { z } from "zod";

export const collections = [
  "big-moves",
  "top-earners-today",
  "winning-streaks",
] as const;
export type Collection = (typeof collections)[number];
const date = z.string().datetime();
const amount = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const count = z.number().int().nonnegative();
const instrument = z.object({
  marketId: z.string(),
  eventId: z.string(),
  title: z.string(),
  venue: z.literal("polymarket"),
  tokenId: z.string(),
  generation: z.string(),
  side: z.enum(["YES", "NO"]),
  outcomeLabel: z.string(),
});
export type Instrument = z.infer<typeof instrument>;
const quote = z.object({
  ask: amount,
  asOf: date,
  validUntil: date,
  status: z.literal("fresh"),
  basis: z.literal("top_of_book_not_execution_quote"),
});
const move = z.object({
  kind: z.literal("big_move"),
  eventType: z.enum(["new_position", "position_increased"]),
  instrument,
  committedUsd: amount,
  sharesBefore: amount,
  sharesAfter: amount,
  fillVwap: amount,
  transactionAt: date,
  positionAsOf: date,
  stillOpen: z.literal(true),
  quote,
  liquidityUsd: amount.nullable(),
  relativeToTypical: amount,
});
const earnings = z.object({
  kind: z.literal("top_earner_24h"),
  netRealized24hUsd: amount,
  completedPositionCount24h: count.nullable(),
  closeDetailsComplete: z.boolean(),
  largestProfitableClose: z
    .object({ instrument, episodeNetRealizedUsd: amount, completedAt: date })
    .nullable(),
  roi30d: amount.nullable(),
});
const streak = z.object({
  kind: z.literal("winning_streak"),
  currentLength: count,
  streakNetRealizedUsd: amount,
  qualifyingCompletedPositions: count,
  latestWinAt: date,
});
export const itemSchema = z.object({
  trader: z.object({
    traderId: z.string().uuid(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  realized30dUsd: amount.nullable(),
  categoryRealized30dUsd: amount,
  completedPositions: count,
  historyDays: count,
  rank: z.number().int().min(1).max(3),
  achievement: z.discriminatedUnion("kind", [move, earnings, streak]),
  latestOpenPosition: z
    .object({
      instrument,
      shares: amount,
      entryPrice: amount,
      quote,
      positionAsOf: date,
      lastConfirmedIncreaseAt: date,
      liquidityUsd: amount.nullable(),
      priceDrift: z.literal("within_policy"),
    })
    .nullable(),
  summary: z.string(),
  evidenceAsOf: date,
  flags: z.array(z.string()),
});
export type TraderItem = z.infer<typeof itemSchema>;
export const querySchema = z
  .object({
    category: z
      .string()
      .regex(/^[a-z0-9_-]{1,48}$/)
      .optional(),
  })
  .strict();
export const collectionSchema = z.object({
  collection: z.enum(collections),
  snapshotId: z.string(),
  generatedAt: date,
  windowStart: date.nullable(),
  windowEnd: date,
  policyVersion: z.literal(1),
  methodologyVersion: z.literal(1),
  freshness: z.enum(["fresh", "stale"]),
  groups: z.array(
    z.object({
      category: z.string(),
      status: z.enum(["ready", "insufficient_evidence", "unsupported"]),
      sourceAsOf: date,
      coverage: z.object({
        venues: z.array(z.literal("polymarket")),
        universe: z.literal("recent_active_tracked_shortlist"),
        resultScope: z.literal("servable_hunch_catalog_positions"),
        selectedWallets: count,
        observedWallets: count,
        eligibleWallets: count,
        basis: z.enum([
          "verified_fills",
          "verified_realizations",
          "verified_episodes",
        ]),
      }),
      items: z.array(itemSchema).max(3),
    }),
  ),
});
export type CollectionResponse = z.infer<typeof collectionSchema>;
