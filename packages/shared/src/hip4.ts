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
    settledNamedOutcomes: z.array(z.unknown()).optional(),
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

// One flat policy can be merged and validated by API and sidecar without API env.
export const hip4ReadPolicySchema = z
  .object({
    version: z.literal(1).default(1),
    enabled: z.boolean().default(false),
    environment: hip4EnvironmentSchema.default("mainnet"),
    outcomeAllowlist: z.array(indexSchema).max(100).default([]),
    pollMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
    bookMaxAgeMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
    metadataMaxAgeMs: z
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
    requestWeightPerMinute: z.number().int().min(20).max(1200).default(600),
    maxOutcomesPerCycle: z.number().int().min(1).max(100).default(6),
    maxTradesPerResponse: z.number().int().min(1).max(2000).default(1000),
    pageSize: z.number().int().min(1).max(100).default(20),
    metadataStreamEnabled: z.boolean().default(true),
    streamHeartbeatMs: z.number().int().min(1_000).max(30_000).default(20_000),
    streamIdleMs: z.number().int().min(30_001).max(300_000).default(60_000),
    streamRetryMs: z.number().int().min(100).max(60_000).default(1_000),
    streamRetryMaxMs: z.number().int().min(60_000).max(300_000).default(60_000),
    minRefreshMs: z.number().int().min(1_000).max(60_000).default(10_000),
  })
  .strict();
export type Hip4ReadPolicy = z.infer<typeof hip4ReadPolicySchema>;
export const DEFAULT_HIP4_READ_POLICY = hip4ReadPolicySchema.parse({});

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
        bookState: z.enum(["missing", "fresh", "stale", "empty", "error"]),
      }),
    )
    .length(2),
  settlement: z
    .object({
      source: z.literal("settledOutcome"),
      observedAt: z.string(),
      details: z.string(),
    })
    .nullable(),
  coverage: z.object({
    metadata: z.enum(["fresh", "stale"]),
    trades: z.enum(["recent_window", "missing", "error"]),
    tradeObservedAt: z.string().nullable(),
    tradeWindowStart: z.string().nullable(),
    tradeWindowEnd: z.string().nullable(),
    ranking: z.literal("unavailable"),
    candles: z.literal("unavailable"),
  }),
  volumeUsd: z.null(),
  openInterest: z.null(),
  capabilities: z.object({
    read: z.literal(true),
    trade: z.literal(false),
    copy: z.literal(false),
    funding: z.literal(false),
    automation: z.literal(false),
  }),
});
export type Hip4ReadMarket = z.infer<typeof hip4ReadMarketSchema>;
export const hip4ReadResponseSchema = z.object({
  version: z.literal(1),
  refreshAfterMs: z.number().int().positive(),
  policyRevision: z.string(),
  environment: hip4EnvironmentSchema,
  markets: z.array(hip4ReadMarketSchema),
  nextOutcome: z.number().int().nullable(),
});
