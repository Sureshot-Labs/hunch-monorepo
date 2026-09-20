import { z } from "zod";

/** Venues with validated unified settlement/outcome normalization. Adding a venue
 * also requires native quote/execution coverage; lifecycle alone cannot enable it. */
export const MATCHING_SUPPORTED_VENUES = ["polymarket", "limitless"] as const;

const integer = (fallback: number, min: number, max: number) =>
  z.number().int().min(min).max(max).default(fallback);
const amount = (fallback: number, min: number, max: number) =>
  z.number().min(min).max(max).default(fallback);
const disabled = () => z.boolean().default(false);

/** Operational defaults are editable; schema bounds are release-owned safety ceilings.
 * Overrides replace the previous override, and omitted fields use these defaults.
 * No API environment imports: indexers and sidecars share exactly the same parser.
 */
export const marketMatchingPolicySchema = z
  .object({
    version: z.literal(1).default(1),
    workerEnabled: disabled(),
    lazyEnabled: disabled(),
    alternativesEnabled: disabled(),
    eventsEnabled: disabled(),
    clustersEnabled: disabled(),
    telegramEnabled: disabled(),
    signalsEnabled: disabled(),
    agentsEnabled: disabled(),
    similarEnabled: disabled(),
    sameVenueEnabled: disabled(),
    venues: z
      .array(z.enum(MATCHING_SUPPORTED_VENUES))
      .max(MATCHING_SUPPORTED_VENUES.length)
      .refine(
        (values) => new Set(values).size === values.length,
        "Duplicate venue",
      )
      .default([...MATCHING_SUPPORTED_VENUES]),
    dailyBudgetUsd: z.number().finite().nonnegative().default(1),
    dailyRequests: integer(5000, 0, 100000),
    lazyBudgetFraction: amount(0.2, 0, 0.2),
    lazyDailyRequests: integer(200, 0, 200),
    concurrency: integer(2, 1, 3),
    timeoutMs: integer(15000, 1000, 15000),
    attempts: integer(3, 1, 3),
    warmIntervalSeconds: integer(900, 60, 86400),
    warmBatchSize: integer(300, 1, 1000),
    warmTrendingCount: integer(75, 0, 1000),
    warmLimitlessCount: integer(75, 0, 1000),
    seedFeedCount: integer(60, 0, 1000),
    seedMapCount: integer(45, 0, 1000),
    seedWhalesCount: integer(45, 0, 1000),
    warmPrefixCount: integer(1000, 1, 10000),
    warmLimitlessPoolSize: integer(500, 1, 5000),
    seedFeedDepth: integer(100, 1, 200),
    seedMapDepth: integer(25, 1, 25),
    seedWhalesDepth: integer(60, 1, 100),
    seedMarketsPerEvent: integer(3, 1, 20),
    seedWhaleMarketCount: integer(5, 1, 20),
    seedWhaleChangeCount: integer(3, 1, 10),
    seedMapMinVolumeUsd: amount(1000, 0, 1e9),
    warmLimitlessMinVolumeUsd: amount(1000, 0, 1e9),
    eventCandidates: integer(2, 0, 5),
    contractCandidates: integer(3, 0, 10),
    retrievalLimit: integer(12, 1, 50),
    contextOverlap: amount(0.5, 0.5, 1),
    cooldownSeconds: integer(21600, 3600, 604800),
    revalidateCount: integer(10, 0, 100),
    revalidateIntervalSeconds: integer(60, 60, 86400),
    pendingInterests: integer(500, 1, 500),
    storedInterests: integer(5000, 1, 5000),
    lazyPendingInterests: integer(100, 0, 100),
    lazyStoredInterests: integer(1000, 0, 1000),
    queuedJobs: integer(2000, 1, 2000),
    lazyQueuedJobs: integer(400, 0, 400),
    actorHourlyMarkets: integer(5, 0, 5),
    actorDailyMarkets: integer(20, 0, 20),
    ipRequestsPerMinute: integer(30, 1, 30),
    actorRequestsPerMinute: integer(10, 1, 10),
    globalRequestsPerMinute: integer(100, 1, 100),
    eventProbability: amount(0.95, 0.95, 1),
    eventConfidence: amount(0.9, 0.9, 1),
    contractProbability: amount(0.95, 0.95, 1),
    contractConfidence: amount(0.9, 0.9, 1),
  })
  .strict()
  .superRefine((p, ctx) => {
    const invalid = (path: keyof typeof p, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (
      p.warmTrendingCount +
        p.warmLimitlessCount +
        p.seedFeedCount +
        p.seedMapCount +
        p.seedWhalesCount >
      p.warmBatchSize
    )
      invalid("warmBatchSize", "Source allocations exceed the warm batch size");
    if (p.warmTrendingCount > p.warmPrefixCount)
      invalid("warmPrefixCount", "Prefix must cover the trending allocation");
    if (p.warmLimitlessCount > p.warmLimitlessPoolSize)
      invalid(
        "warmLimitlessPoolSize",
        "Pool must cover the Limitless allocation",
      );
    if (p.pendingInterests > p.storedInterests)
      invalid("pendingInterests", "Pending capacity exceeds stored capacity");
    if (
      p.lazyPendingInterests > p.pendingInterests ||
      p.lazyPendingInterests > p.lazyStoredInterests
    )
      invalid(
        "lazyPendingInterests",
        "Lazy pending capacity exceeds total/stored capacity",
      );
    if (p.lazyStoredInterests > p.storedInterests)
      invalid(
        "lazyStoredInterests",
        "Lazy stored capacity exceeds total capacity",
      );
    if (p.lazyQueuedJobs > p.queuedJobs)
      invalid("lazyQueuedJobs", "Lazy job capacity exceeds total capacity");
    if (p.lazyDailyRequests > p.dailyRequests)
      invalid("lazyDailyRequests", "Lazy requests exceed total requests");
    if (p.actorHourlyMarkets > p.actorDailyMarkets)
      invalid("actorHourlyMarkets", "Hourly quota exceeds daily quota");
    if (Math.max(p.eventCandidates, p.contractCandidates) > p.retrievalLimit)
      invalid("retrievalLimit", "Retrieval must cover admitted candidates");
  });

export type MarketMatchingPolicy = z.infer<typeof marketMatchingPolicySchema>;
export const DEFAULT_MARKET_MATCHING_POLICY = marketMatchingPolicySchema.parse(
  {},
);
