import { z } from "zod";

export const discoverySections = [
  "quick-wins",
  "smart-money",
  "hidden-gems",
] as const;
export type DiscoverySection = (typeof discoverySections)[number];
export const discoveryVenueSchema = z.enum([
  "polymarket",
  "limitless",
  "kalshi",
]);
export const discoverySideSchema = z.enum(["YES", "NO"]);
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const iso = z.string().datetime();
const csv = z
  .string()
  .max(300)
  .refine(
    (value) =>
      value.split(",").every((part) => /^[a-z0-9_-]{1,40}$/.test(part.trim())),
    "Expected comma-separated identifiers",
  );
const baseQuery = {
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(2048).optional(),
  q: z.string().trim().max(100).optional(),
  categories: csv.optional(),
  venues: z
    .string()
    .regex(
      /^(polymarket|limitless|kalshi)(,(polymarket|limitless|kalshi)){0,2}$/,
    )
    .optional(),
  withResearch: z.enum(["true", "false"]).default("false"),
};
export const discoveryQuerySchema = z.object(baseQuery).strict();
export const discoveryQuickQuerySchema = discoveryQuerySchema.extend({
  horizonHours: z.coerce
    .number()
    .pipe(z.union([z.literal(24), z.literal(72), z.literal(168)]))
    .default(72),
});
export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema> & {
  horizonHours?: 24 | 72 | 168;
};

export const discoveryInstrumentSchema = z.object({
  marketId: z.string(),
  venue: discoveryVenueSchema,
  tokenId: z.string(),
  outcome: discoverySideSchema,
  generation: z.string(),
  expiry: iso.nullable(),
});
export const discoveryQuoteSchema = z.object({
  status: z.enum(["fresh", "stale", "unavailable"]),
  bid: decimal.nullable(),
  ask: decimal.nullable(),
  midpoint: decimal.nullable(),
  asOf: iso.nullable(),
});
export const discoveryResearchSchema = z.object({
  noteId: z.string().uuid(),
  createdAt: iso,
  headline: z.string(),
  summary: z.string(),
  side: discoverySideSchema,
  strength: z.enum(["strong", "good"]),
  researchedPrice: decimal.nullable(),
  researchedAt: iso.nullable(),
  sources: z.array(
    z.object({
      id: z.string(),
      headline: z.string(),
      url: z.string().url(),
      publishedAt: iso.nullable(),
    }),
  ),
  caveats: z.array(z.string()),
  instrument: discoveryInstrumentSchema.nullable(),
});
export const discoveryTraderSchema = z.object({
  walletId: z.string().uuid(),
  displayName: z.string().nullable(),
  pnl30dUsd: decimal,
  pnlIsApproximate: z.literal(true),
  resolvedObservations30d: z.number().int().nonnegative(),
  edge30d: decimal,
  metricsAsOf: iso,
});
export const discoveryReasonSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("quick-wins"),
      volume24hUsd: decimal,
      liquidityUsd: decimal,
      grossReturnIfWin: decimal,
      returnBasis: z.literal("top_ask_excludes_depth_fees_slippage"),
      resolutionClarity: z.literal("rules_provided_not_human_reviewed"),
    }),
    z.object({
      kind: z.literal("smart-money"),
      evidenceBasis: z.literal("observed_snapshot_increase"),
      ownerGroups: z.number().int().min(2),
      oppositeOwnerGroups: z.number().int().nonnegative(),
      observedIncreaseValueUsd: decimal,
      observedAt: iso,
      windowHours: z.literal(24),
      traders: z.array(discoveryTraderSchema),
      opposingViews: z.boolean(),
    }),
    z.object({
      kind: z.literal("hidden-gems"),
      strength: z.enum(["strong", "good"]),
      basis: z.literal("public_approved_research_not_proven_mispricing"),
    }),
  ])
  .meta({ discriminator: { propertyName: "kind" } });
export const discoveryItemSchema = z.object({
  id: z.string(),
  market: z.object({
    marketId: z.string(),
    eventId: z.string(),
    title: z.string(),
    eventTitle: z.string(),
    category: z.string().nullable(),
    venue: discoveryVenueSchema,
    image: z.string().nullable(),
    resolutionCondition: z.string(),
  }),
  selection: z.object({
    side: discoverySideSchema,
    outcomeLabel: z.string(),
    instrument: discoveryInstrumentSchema.nullable(),
  }),
  quote: discoveryQuoteSchema,
  timing: z.object({
    marketEndAt: iso.nullable(),
    closeAt: iso.nullable(),
    eventEndAt: iso.nullable(),
    basis: z.literal("venue_market_expiration_not_guaranteed_settlement"),
    settlementAt: z.null(),
  }),
  copyAvailable: z.boolean(),
  research: discoveryResearchSchema.nullable(),
  reason: discoveryReasonSchema,
});
export const discoveryResponseSchema = z.object({
  section: z.enum(discoverySections),
  items: z.array(discoveryItemSchema),
  nextCursor: z.string().nullable(),
  snapshotId: z.string().uuid(),
  generatedAt: iso,
  freshness: z.object({
    status: z.enum(["fresh", "stale"]),
    sourceAsOf: iso,
    projectionRefreshedAt: iso.nullable(),
    quoteMaxAgeSeconds: z.literal(300),
    warnings: z.array(z.string()),
  }),
  page: z.object({
    scannedCandidates: z.number().int().nonnegative(),
    scanBudgetReached: z.boolean(),
  }),
});
export const discoveryErrorSchema = z.object({
  error: z.string(),
  code: z.enum([
    "discovery_unavailable",
    "discovery_cursor_expired",
    "discovery_invalid_cursor",
  ]),
});
export type DiscoveryItem = z.infer<typeof discoveryItemSchema>;
export type DiscoveryResearch = z.infer<typeof discoveryResearchSchema>;
export type DiscoveryTrader = z.infer<typeof discoveryTraderSchema>;
export type DiscoveryResponse = z.infer<typeof discoveryResponseSchema>;
export type DiscoveryInstrument = z.infer<typeof discoveryInstrumentSchema>;
export type DiscoveryReason = z.infer<typeof discoveryReasonSchema>;
