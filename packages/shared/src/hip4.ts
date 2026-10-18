import { z } from "zod";

// Protocol constants, not rollout policy. Identities never share a namespace
// across environments, even when the provider reuses an outcome index.
export const hip4EnvironmentSchema = z.enum(["mainnet", "testnet"]);
export type Hip4Environment = z.infer<typeof hip4EnvironmentSchema>;
export function isHip4CanaryId(value: string): boolean {
  return /^hyperliquid:(?:mainnet|testnet):/.test(value);
}
const indexSchema = z.number().int().nonnegative().max(900_000_000);
export const hip4DecimalSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
export const hip4ProbabilitySchema = hip4DecimalSchema.refine(
  (value) => value.startsWith("0") || /^1(?:\.0+)?$/.test(value),
  "Expected a payout/price between zero and one",
);

export function hip4Identity(environment: Hip4Environment, outcome: number) {
  hip4EnvironmentSchema.parse(environment);
  indexSchema.parse(outcome);
  const marketId = `hyperliquid:${environment}:outcome:${outcome}`;
  return {
    version: 1 as const,
    environment,
    network: `hypercore:${environment}`,
    outcome,
    marketId,
    sides: ([0, 1] as const).map((sideIndex) => {
      const encoding = 10 * outcome + sideIndex;
      return {
        sideIndex,
        tokenId: `hyperliquid:${environment}:${encoding}`,
        coin: `#${encoding}`,
        tokenName: `+${encoding}`,
        assetId: 100_000_000 + encoding,
      };
    }),
  };
}

export function parseHip4Coin(coin: string) {
  if (!/^#(?:0|[1-9]\d*)$/.test(coin)) throw new Error("invalid_hip4_coin");
  const encoding = Number(coin.slice(1));
  const outcome = Math.floor(encoding / 10);
  const sideIndex = encoding % 10;
  indexSchema.parse(outcome);
  if (sideIndex !== 0 && sideIndex !== 1) throw new Error("invalid_hip4_side");
  return { outcome, sideIndex: sideIndex as 0 | 1 };
}

export function hip4RawUnits(value: string, decimals: number): bigint {
  hip4DecimalSchema.parse(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38)
    throw new Error("invalid_decimal_scale");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.slice(decimals).replace(/0/g, ""))
    throw new Error("inexact_amount");
  return BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, "0"));
}

export function hip4Complement(value: string): string {
  hip4ProbabilitySchema.parse(value);
  const decimals = value.split(".")[1]?.length ?? 0;
  const scale = 10n ** BigInt(decimals);
  const raw = scale - hip4RawUnits(value, decimals);
  if (!decimals) return raw.toString();
  const digits = raw.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

export function hip4BinaryPayout(value: string | null): 0 | 1 | null {
  if (value === null) return null;
  if (/^0(?:\.0+)?$/.test(value)) return 0;
  if (/^1(?:\.0+)?$/.test(value)) return 1;
  return null;
}

export const hip4OutcomeSchema = z
  .object({
    outcome: indexSchema,
    name: z.string(),
    description: z.string(),
    sideSpecs: z.tuple([
      z.object({ name: z.string() }).passthrough(),
      z.object({ name: z.string() }).passthrough(),
    ]),
    quoteToken: z.string().optional(),
    venue: z.string().optional(),
    deployerFeeScale: hip4DecimalSchema.optional(),
  })
  .passthrough();

export const hip4QuestionSchema = z
  .object({
    question: indexSchema,
    name: z.string(),
    description: z.string(),
    fallbackOutcome: indexSchema,
    namedOutcomes: z.array(indexSchema),
    settledNamedOutcomes: z.array(indexSchema).optional(),
  })
  .passthrough();

export const hip4MetadataSchema = z
  .object({
    outcomes: z.array(hip4OutcomeSchema),
    questions: z.array(hip4QuestionSchema).default([]),
    deployers: z.array(z.unknown()).default([]),
    feeScale: hip4DecimalSchema.optional(),
  })
  .passthrough();

export const hip4SettlementSchema = z
  .object({
    spec: hip4OutcomeSchema,
    settleFraction: hip4ProbabilitySchema,
    details: z.string(),
  })
  .passthrough();

export const hip4SpotMetadataSchema = z
  .object({
    tokens: z.array(
      z
        .object({
          name: z.string(),
          index: indexSchema,
          tokenId: z.string(),
          szDecimals: z.number().int().min(0).max(38),
          weiDecimals: z.number().int().min(0).max(38),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const levelSchema = z.object({
  px: hip4ProbabilitySchema,
  sz: hip4DecimalSchema,
  n: z.number().int().nonnegative(),
});
export const hip4BookSchema = z.object({
  coin: z.string(),
  time: z.number().int().nonnegative(),
  levels: z.tuple([z.array(levelSchema), z.array(levelSchema)]),
});
export const hip4TradeSchema = z.object({
  coin: z.string(),
  side: z.enum(["A", "B"]),
  px: hip4ProbabilitySchema,
  sz: hip4DecimalSchema.refine((value) => Number(value) > 0),
  time: z.number().int().nonnegative(),
  tid: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hash: z.string(),
}); // Strips participants: public read models do not need wallet addresses.

export const hip4RawSnapshotSchema = z.object({
  outcome: hip4OutcomeSchema,
  question: hip4QuestionSchema.nullable(),
  settlement: hip4SettlementSchema.nullable(),
  quote: hip4SpotMetadataSchema.shape.tokens.element.nullable(),
  feeScale: hip4DecimalSchema.nullable(),
  deployers: z.array(z.unknown()),
});
export type Hip4RawSnapshot = z.infer<typeof hip4RawSnapshotSchema>;
export const hip4AttemptSchema = z.object({
  at: z.string(),
  result: z.enum([
    "ok",
    "budget_exhausted",
    "timeout",
    "http_error",
    "transport_error",
    "invalid_response",
    "wrong_identity",
    "stale_observation",
    "response_too_large",
    "processing_limit",
    "metadata_missing",
  ]),
});
export type Hip4Attempt = z.infer<typeof hip4AttemptSchema>;

// One flat policy can be merged and validated by API and sidecar without API env.
export const hip4ReadPolicySchema = z
  .object({
    version: z.literal(1).default(1),
    // Legacy canary controls, retained to parse stored revisions/fixtures.
    // readHip4Policy derives enabled/catalog access from venue_lifecycle.
    enabled: z.boolean().default(false),
    environment: hip4EnvironmentSchema.default("mainnet"),
    outcomeAllowlist: z.array(indexSchema).max(100).default([]),
    catalogMode: z.enum(["allowlist", "all"]).default("allowlist"),
    catalogBatchSize: z.number().int().min(1).max(5000).default(500),
    pollMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
    bookMaxAgeMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
    metadataMaxAgeMs: z
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(300_000),
    volumeMaxAgeMs: z
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(300_000),
    requestTimeoutMs: z.number().int().min(100).max(60_000).default(10_000),
    responseMaxBytes: z
      .number()
      .int()
      .min(1024)
      .max(16_777_216)
      .default(4_194_304),
    requestWeightPerMinute: z.number().int().min(40).max(1200).default(600),
    // Background discovery/history must leave capacity for explicit account,
    // quote and receipt checks within the SAME provider-wide rolling budget.
    interactiveRequestWeightReserveRatio: z.number().min(0).max(1).default(0.5),
    // Quote-only fact reuse. Zero disables completed and in-flight reuse;
    // preparations and financial admission always read authoritative facts.
    quotePreviewCacheEntries: z.number().int().min(0).max(1000).default(64),
    maxOutcomesPerCycle: z.number().int().min(1).max(100).default(6),
    maxTradesPerResponse: z.number().int().min(1).max(2000).default(1000),
    pageSize: z.number().int().min(1).max(100).default(20),
    metadataStreamEnabled: z.boolean().default(true),
    streamHeartbeatMs: z.number().int().min(1_000).max(30_000).default(20_000),
    streamIdleMs: z.number().int().min(30_001).max(300_000).default(60_000),
    streamRetryMs: z.number().int().min(100).max(60_000).default(1_000),
    streamRetryMaxMs: z.number().int().min(60_000).max(300_000).default(60_000),
    minRefreshMs: z.number().int().min(1_000).max(60_000).default(10_000),
    liveEnabled: z.boolean().default(true),
    maxLiveOutcomes: z.number().int().min(1).max(30).default(6),
    // Visible demand is broader than the bounded WS subset. These are work
    // bounds, not additional provider credits; all REST reads share admission.
    maxHotOutcomes: z.number().int().min(1).max(1000).default(100),
    maxVisibleBookOutcomesPerCycle: z.number().int().min(1).max(100).default(4),
    visibleBookRefreshMs: z.number().int().min(1000).max(60000).default(5000),
    streamQueueSize: z.number().int().min(1).max(10000).default(2000),
    streamFlushMs: z.number().int().min(100).max(10000).default(1000),
    subscriptionRefreshMs: z.number().int().min(1000).max(60000).default(15000),
    policyCheckMs: z.number().int().min(100).max(30000).default(5000),
    hotDemandMaxAgeMs: z.number().int().min(1000).max(3600000).default(120000),
    historyMaxRangeMs: z
      .number()
      .int()
      .min(60000)
      .max(2592000000)
      .default(86400000),
    candlePageSize: z.number().int().min(1).max(1440).default(120),
  })
  .strict()
  .refine(
    (policy) => policy.subscriptionRefreshMs >= policy.maxLiveOutcomes * 200,
    {
      path: ["subscriptionRefreshMs"],
      message:
        "Subscription rotation must leave room within the provider message budget",
    },
  );
export type Hip4ReadPolicy = z.infer<typeof hip4ReadPolicySchema>;
export const DEFAULT_HIP4_READ_POLICY = hip4ReadPolicySchema.parse({});

export function hip4BackgroundRequestWeightLimit(
  policy: Hip4ReadPolicy,
): number {
  // Preserve admission of the mandatory metadata pair even at a small legacy
  // budget. This is a protocol cost, not an additional provider allowance.
  return Math.min(
    policy.requestWeightPerMinute,
    Math.max(
      40,
      policy.requestWeightPerMinute -
        Math.ceil(
          policy.requestWeightPerMinute *
            policy.interactiveRequestWeightReserveRatio,
        ),
    ),
  );
}

/** Refresh display observations before their deadline, independently of the
 * slower depth/history repair cadence. No freshness window is extended. */
export function hip4CatalogRefreshIntervalMs(policy: Hip4ReadPolicy): number {
  return Math.min(
    policy.pollMs,
    Math.max(policy.minRefreshMs, Math.floor(policy.bookMaxAgeMs / 2)),
  );
}

/** A class subquota, not a smaller total-admission ceiling: catalog reads
 * must not count against the repair quota or they could starve history. */
export function hip4BackgroundRepairWeightLimit(
  policy: Hip4ReadPolicy,
): number {
  const catalogReserve =
    40 * Math.ceil(60_000 / hip4CatalogRefreshIntervalMs(policy));
  return Math.max(0, hip4BackgroundRequestWeightLimit(policy) - catalogReserve);
}

export function hip4ReadOutcomeAllowed(
  policy: Hip4ReadPolicy,
  outcome: number,
) {
  return (
    indexSchema.safeParse(outcome).success &&
    (policy.catalogMode === "all" || policy.outcomeAllowlist.includes(outcome))
  );
}

export const hip4ReadMarketSchema = z.object({
  version: z.literal(1),
  venue: z.literal("hyperliquid"),
  environment: hip4EnvironmentSchema,
  marketId: z.string(),
  eventId: z.string(),
  outcome: indexSchema,
  questionId: indexSchema.nullable(),
  isFallback: z.boolean(),
  title: z.string(),
  eventTitle: z.string(),
  description: z.string(),
  expiry: z.string().nullable(),
  status: z.enum(["observed", "expired", "settled"]),
  fetchedAt: z.string(),
  generation: z.string(),
  metadataValidUntil: z.string().optional(),
  metadataAttempt: hip4AttemptSchema.nullable().optional(),
  settlementAttempt: hip4AttemptSchema.nullable().optional(),
  quoteToken: z.string().nullable(),
  quoteTokenId: z.string().nullable(),
  quoteWeiDecimals: z.number().int().nullable(),
  feeScale: z.string().nullable(),
  deployerFeeScale: z.string().nullable(),
  sides: z
    .array(
      z.object({
        sideIndex: z.union([z.literal(0), z.literal(1)]),
        label: z.string(),
        tokenId: z.string(),
        coin: z.string(),
        tokenName: z.string(),
        assetId: z.number().int(),
        szDecimals: z.number().int().nullable(),
        weiDecimals: z.number().int().nullable(),
        payout: hip4ProbabilitySchema.nullable(),
        bid: hip4ProbabilitySchema.nullable(),
        ask: hip4ProbabilitySchema.nullable(),
        bookAt: z.string().nullable(),
        bookValidUntil: z.string().nullable().optional(),
        bookAttempt: hip4AttemptSchema.nullable().optional(),
        bookState: z.enum(["missing", "fresh", "stale", "empty", "error"]),
      }),
    )
    .length(2),
  settlement: z
    .object({
      source: z.literal("settledOutcome"),
      observedAt: z.string(),
      checkedAt: z.string().optional(),
      details: z.string(),
    })
    .nullable(),
  coverage: z.object({
    metadata: z.enum(["fresh", "stale"]),
    trades: z.enum(["recent_window", "missing", "error"]),
    tradeObservedAt: z.string().nullable(),
    tradeWindowStart: z.string().nullable(),
    tradeWindowEnd: z.string().nullable(),
    tradeAttempt: hip4AttemptSchema.nullable().optional(),
    ranking: z.literal("unavailable"),
    candles: z.literal("unavailable"),
  }),
  volumeUsd: z.null(),
  // volumeUsd remains unavailable lifetime volume for older readers.
  volume24h: z
    .object({
      usd: hip4DecimalSchema,
      source: z.literal("spotMetaAndAssetCtxs"),
      basis: z.literal("primary_outcome"),
      coin: z.string(),
      observedAt: z.string().datetime(),
      validUntil: z.string().datetime(),
    })
    .nullable()
    .optional(),
  volumeAttempt: hip4AttemptSchema.nullable().optional(),
  indicativePrices: z
    .object({
      source: z.literal("spotMetaAndAssetCtxs"),
      prices: z
        .array(z.object({ coin: z.string(), price: hip4ProbabilitySchema }))
        .max(2),
      observedAt: z.string().datetime(),
      validUntil: z.string().datetime(),
    })
    .nullable()
    .optional(),
  openInterest: z.null(),
  capabilities: z.object({
    read: z.literal(true),
    trade: z.literal(false),
    copy: z.literal(false),
    funding: z.literal(false),
    automation: z.literal(false),
  }),
});

export const hip4HistoryCoverageSchema = z.object({
  source: z.literal("canonical_primary_trades"),
  complete: z.literal(false),
  intervals: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      kind: z.enum(["observed", "gap"]),
      reason: z.string(),
    }),
  ),
  truncated: z.boolean(),
});
export const hip4TradePageSchema = z.object({
  policyRevision: z.string(),
  environment: hip4EnvironmentSchema,
  marketId: z.string(),
  source: z.literal("canonical_primary_trades"),
  trades: z.array(hip4TradeSchema),
  nextCursor: z.string().nullable(),
});
export const hip4CandlePageSchema = z.object({
  policyRevision: z.string(),
  environment: hip4EnvironmentSchema,
  marketId: z.string(),
  intervalMs: z.literal(60000),
  candles: z.array(
    z.object({
      time: z.number(),
      open: hip4ProbabilitySchema,
      high: hip4ProbabilitySchema,
      low: hip4ProbabilitySchema,
      close: hip4ProbabilitySchema,
      volume: hip4DecimalSchema,
      trades: z.number().int(),
      complete: z.literal(false),
    }),
  ),
  coverage: hip4HistoryCoverageSchema,
  nextBefore: z.number().nullable(),
});
export type Hip4ReadMarket = z.infer<typeof hip4ReadMarketSchema>;
export const hip4ReadResponseSchema = z.object({
  catalogMode: z.enum(["allowlist", "all"]).optional(),
  version: z.literal(1),
  refreshAfterMs: z.number().int().positive(),
  policyRevision: z.string(),
  environment: hip4EnvironmentSchema,
  markets: z.array(hip4ReadMarketSchema),
  nextOutcome: z.number().int().nullable(),
  streamTokenIds: z.array(z.string()).default([]),
});
