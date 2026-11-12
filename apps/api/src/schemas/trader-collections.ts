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
// Ordered from shared admission checks to the most specific tab-level rule.
export const rejectionCodes = [
  "no_catalog_category",
  "unclassified_evidence",
  "history_too_short",
  "wallet_profit_not_positive",
  "too_few_closes",
  "category_evidence_gap",
  "unknown_category_profit_30d",
  "category_profit_not_positive",
  "open_losses_offset_profit",
  "open_loss_mark_unavailable",
  "no_completed_position_in_window",
  "no_recent_position_increase",
  "move_below_minimum",
  "remaining_position_dust",
  "market_or_quote_unavailable",
  "exposure_uncertain",
  "price_not_comparable",
  "paired_exposure",
  "typical_stake_unknown",
  "below_typical_stake",
  "daily_profit_unknown",
  "daily_profit_not_positive",
  "too_few_observed_wins",
  "streak_interrupted_by_loss",
  "streak_order_ambiguous",
  "streak_boundary_unknown",
  "quote_expired_before_publication",
  "wallet_not_public_trader",
  "balance_not_comparable",
  "increase_not_retained",
] as const;
export type RejectionCode = (typeof rejectionCodes)[number];
export const sourceFailureCodes = [
  "incomplete_pages",
  "wallet_request_budget",
  "wallet_activity_capacity",
  "wallet_page_capacity",
  "market_lookup_timeout",
  "local_activity_timeout",
  "provider_protocol_contract",
  "owner_mismatch",
  "repeated_cursor",
  "invalid_cursor",
  "wallet_timeout",
  "provider_error",
  "source_unavailable",
] as const;
export type SourceFailure = (typeof sourceFailureCodes)[number];
const diagnostics = z.object({
  scope: z.enum([
    "whole_shortlist_at_ranking",
    "all_public_position_increases",
  ]),
  selectedWallets: count,
  attemptedWallets: count,
  pendingWallets: count,
  observedWallets: count,
  qualifiedWallets: count,
  sourceFailures: z.array(
    z.object({ code: z.enum(sourceFailureCodes), wallets: count }),
  ),
  exclusions: z.array(
    z.object({ code: z.enum(rejectionCodes), wallets: count }),
  ),
});
const instrument = z.object({
  marketId: z.string(),
  eventId: z.string(),
  // Pre-release snapshots can omit this field during the short cache handoff.
  eventTitle: z.string().nullable().optional(),
  title: z.string(),
  venue: z.literal("polymarket"),
  tokenId: z.string(),
  generation: z.string(),
  side: z.enum(["YES", "NO"]),
  outcomeLabel: z.string(),
});
export type Instrument = z.infer<typeof instrument>;
export const observedCloseSchema = z.object({
  basis: z.enum(["observed_exit", "inferred_settlement"]).optional(),
  instrument,
  completedAt: date,
  estimatedEpisodePnlUsd: amount,
  result: z.enum(["win", "loss", "flat"]),
  qualifiesForStreak: z.boolean(),
});
export type ObservedClose = z.infer<typeof observedCloseSchema>;
export const walletCloseHistorySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    windowStart: date.nullable(),
    windowEnd: date,
    coverage: z.enum(["observed_only", "known_gaps"]),
    items: z.array(observedCloseSchema).max(10),
  }),
  z.object({
    status: z.enum(["preparing", "busy", "unavailable", "unsupported"]),
    items: z.null(),
  }),
]);
// Existing wallet properties remain open: this is an additive profile field.
export const walletWithRecentClosesSchema = z.object({
  ok: z.literal(true),
  wallet: z.object({ recentCloses: walletCloseHistorySchema }).passthrough(),
});
export const walletProfileErrorSchema = z.object({ error: z.string() });
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
  estimatedIncreaseUsd: amount,
  sharesBefore: amount,
  sharesAfter: amount,
  observationPrice: amount,
  observedAt: date,
  positionAsOf: date,
  openAtLastObservation: z.literal(true),
  quote,
  liquidityUsd: amount.nullable(),
  relativeToTypical: amount.nullable(),
});
const earnings = z.object({
  kind: z.literal("top_earner_24h"),
  estimatedNetPnl24hUsd: amount,
  completedPositionCount24h: count.nullable(),
  closeDetailsComplete: z.boolean(),
  largestProfitableClose: z
    .object({ instrument, estimatedEpisodePnlUsd: amount, completedAt: date })
    .nullable(),
  roi30d: amount.nullable(),
});
const streak = z.object({
  kind: z.literal("winning_streak"),
  lengthIsLowerBound: z.boolean(),
  currentLength: count,
  estimatedStreakPnlUsd: amount,
  qualifyingCompletedPositions: count,
  latestWinAt: date,
  latestWinInstrument: instrument.optional(),
  recentResults: z.array(observedCloseSchema).max(10).optional(),
});
export const itemSchema = z.object({
  trader: z.object({
    traderId: z.string().uuid(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  estimatedClosedPnl30dUsd: amount.nullable(),
  estimatedCategoryClosedPnl30dUsd: amount.nullable(),
  completedPositions: count.nullable(),
  historyDays: count.nullable(),
  rank: z.number().int().min(1).max(3),
  achievement: z.discriminatedUnion("kind", [move, earnings, streak]),
  latestOpenPosition: z
    .object({
      instrument,
      shares: amount,
      observedPrice: amount,
      quote,
      positionAsOf: date,
      lastObservedIncreaseAt: date,
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
  policyVersion: z.union([z.literal(1), z.literal(2)]),
  methodologyVersion: z.literal(2),
  freshness: z.enum(["fresh", "stale"]),
  /** Missing on older snapshots. No economically valid ranking is implied during handoff. */
  availability: z.enum(["ranked", "between_windows", "preparing"]).optional(),
  // Older still-valid cached responses do not have trustworthy reason counters.
  diagnostics: diagnostics.optional(),
  groups: z.array(
    z.object({
      category: z.string(),
      status: z.enum(["ready", "insufficient_evidence", "unsupported"]),
      sourceAsOf: date,
      coverage: z.object({
        venues: z.array(z.literal("polymarket")),
        universe: z.enum([
          "recent_active_tracked_shortlist",
          "all_public_wallet_intel",
        ]),
        resultScope: z.literal("servable_hunch_catalog_positions"),
        selectedWallets: count,
        observedWallets: count,
        eligibleWallets: count,
        basis: z.enum([
          "observed_position_deltas",
          "estimated_realizations",
          "inferred_closed_positions",
        ]),
      }),
      items: z.array(itemSchema).max(3),
    }),
  ),
});
export type CollectionResponse = z.infer<typeof collectionSchema>;
