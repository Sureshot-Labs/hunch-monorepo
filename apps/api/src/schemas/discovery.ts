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
export const discoveryEvidenceMetricSchema = z.object({
  kind: z.enum([
    "track_record",
    "pricing_edge",
    "volume",
    "conviction",
    "capital",
    "outside_odds",
  ]),
  scope: z.enum(["representative_wallet", "wallet_cluster", "external_market"]),
  measurement: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("scalar"),
      value: decimal,
      unit: z.enum(["usd", "probability", "wallets"]),
    }),
    z.object({
      kind: z.literal("range"),
      min: decimal,
      max: decimal,
      unit: z.enum(["usd", "probability", "wallets"]),
    }),
  ]),
  horizonDays: z.number().int().nonnegative().nullable(),
  sampleSize: z.number().int().nonnegative().nullable(),
  asOf: iso,
  basis: z.literal("saved_research_evidence_not_current_probability"),
  sourceId: z.string().nullable(),
});
export const discoveryEstimateSchema = z.object({
  status: z.enum(["available", "market_only", "unavailable"]),
  method: z.literal("research-odds-v1"),
  version: z.literal(1),
  calibrated: z.literal(false),
  side: discoverySideSchema,
  probability: decimal.nullable(),
  marketProbability: decimal.nullable(),
  representativeWalletId: z.string().uuid().nullable(),
  sampleSize: z.number().int().nonnegative().nullable(),
  researchAsOf: iso,
  metricsAsOf: iso.nullable(),
  positionAsOf: iso.nullable(),
  positionBasis: z.literal("published_research").optional(),
  currentPositionStatus: z
    .enum(["confirmed", "not_confirmed", "stale", "unavailable"])
    .optional(),
  quoteAsOf: iso.nullable(),
  calculatedAt: iso,
  reason: z.enum([
    "adjusted",
    "no_adjustment",
    "inputs_unavailable",
    "representative_unavailable",
    "side_mismatch",
    "instrument_changed",
    "quote_unavailable",
    "metrics_unavailable",
    "metrics_stale",
    "position_unavailable",
    "position_stale",
    "invalid_research_time",
  ]),
  coverage: z.enum(["saved_two_sided_support", "representative_only"]),
  warnings: z.array(z.string()),
});
export const discoveryValuationSchema = z.object({
  probabilityDifferencePp: decimal,
  modelUpsideRatio: decimal,
  grossReturnIfWin: decimal,
  basis: z.literal("top_ask_excludes_depth_fees_slippage"),
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
  sourceCount: z.number().int().nonnegative().optional(),
  contextHighlight: z
    .object({
      kind: z.literal("news"),
      sourceId: z.string(),
      headline: z.string(),
      url: z.string().url(),
      publishedAt: iso.nullable(),
    })
    .nullable()
    .optional(),
  evidenceMetrics: z.array(discoveryEvidenceMetricSchema).optional(),
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
const positioningSideSchema = z.object({
  side: discoverySideSchema,
  ownerGroups: z.number().int().nonnegative(),
  walletCount: z.number().int().nonnegative(),
  positionValueUsd: decimal,
  observedIncreaseValueUsd: decimal,
});
export const discoveryPositioningSchema = z.object({
  selected: positioningSideSchema,
  opposite: positioningSideSchema,
  selectedIncreaseShare: decimal.nullable(),
  windowHours: z.literal(24),
  oldestSnapshotAt: iso.nullable(),
  latestSnapshotAt: iso.nullable(),
  basis: z.literal("qualified_owner_groups_with_retained_snapshot_increase"),
});
export const discoveryParticipantSchema = z.object({
  groupId: z.string(),
  side: discoverySideSchema,
  walletCount: z.number().int().positive(),
  positionValueUsd: decimal,
  observedIncreaseValueUsd: decimal,
  oldestSnapshotAt: iso,
  latestSnapshotAt: iso,
  observedAt: iso,
  representative: discoveryTraderSchema,
});
export const discoveryTradersQuerySchema = z
  .object({
    snapshotId: z.string().uuid(),
    side: discoverySideSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export const discoveryTradersParamsSchema = z.object({
  marketId: z.string().min(1).max(250),
});
export const discoveryTradersResponseSchema = z.object({
  snapshotId: z.string().uuid(),
  marketId: z.string(),
  selectedSide: discoverySideSchema,
  generatedAt: iso,
  positioning: discoveryPositioningSchema,
  items: z.array(discoveryParticipantSchema),
  nextCursor: z.string().nullable(),
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
      positioning: discoveryPositioningSchema.optional(),
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
  estimate: discoveryEstimateSchema.optional(),
  valuation: discoveryValuationSchema.nullable().optional(),
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
    "discovery_market_not_found",
  ]),
});
export type DiscoveryItem = z.infer<typeof discoveryItemSchema>;
export type DiscoveryResearch = z.infer<typeof discoveryResearchSchema>;
export type DiscoveryTrader = z.infer<typeof discoveryTraderSchema>;
export type DiscoveryResponse = z.infer<typeof discoveryResponseSchema>;
export type DiscoveryInstrument = z.infer<typeof discoveryInstrumentSchema>;
export type DiscoveryReason = z.infer<typeof discoveryReasonSchema>;
export type DiscoveryEstimate = z.infer<typeof discoveryEstimateSchema>;
export type DiscoveryParticipant = z.infer<typeof discoveryParticipantSchema>;
export type DiscoveryPositioning = z.infer<typeof discoveryPositioningSchema>;
export type DiscoveryTradersQuery = z.infer<typeof discoveryTradersQuerySchema>;
export type DiscoveryTradersResponse = z.infer<
  typeof discoveryTradersResponseSchema
>;
