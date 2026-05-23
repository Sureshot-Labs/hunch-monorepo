import { z } from "zod";
import type { ZodIssue } from "zod";

// numbers often come as strings; welcome to APIs.
const numish = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "string" ? (v.trim() ? Number(v) : NaN) : v));

const optionalBool = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.boolean().optional(),
);

const boolDefaultFalse = z.preprocess(
  (value) => (value == null ? false : value),
  z.boolean(),
);

// Collateral token schema
const CollateralToken = z.object({
  symbol: z.string(),
  address: z.string(),
  decimals: z.number().default(6),
});

// Creator schema
const Creator = z
  .object({
    name: z.string(),
    imageURI: z.string().nullable().optional(),
    link: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

// Trends schema
const Trends = z
  .object({
    hourly: z.object({
      rank: z.number(),
      value: z.number(),
    }),
  })
  .optional();

// Metadata schema
const Metadata = z.object({
  fee: optionalBool,
  isBannered: optionalBool,
  isPolyArbitrage: optionalBool,
  shouldMarketMake: optionalBool,
}).passthrough();

// Settings schema
const Settings = z.object({
  c: z.string(),
  minSize: z.string(),
  maxSpread: z.number(),
  dailyReward: z.string(),
  rewardsEpoch: z.string(),
});

// Tokens schema
const Tokens = z.object({
  no: z.string(),
  yes: z.string(),
});

const Venue = z
  .object({
    exchange: z.string().nullable().optional(),
    adapter: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const PositionIds = z
  .array(z.union([z.string(), z.array(z.string())]))
  .nullable();

const FeedEvent = z
  .object({
    eventType: z.string().optional(),
    timestamp: z.string().optional(),
    user: z.unknown().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

// Individual market schema (for group markets)
const LimitlessMarketItem = z
  .object({
    address: z.string().optional(),
    id: z.number(),
    logo: z.string().nullable().optional(),
    slug: z.string(),
    tags: z.array(z.string()),
    title: z.string(),
    prices: z.array(numish).optional(),
    status: z.string(),
    tokens: Tokens.optional(),
    feedEvents: z.array(FeedEvent).optional(),
    volume: z.string(),
    openInterest: numish.optional(),
    openInterestFormatted: z.string().optional(),
    liquidity: numish.optional(),
    liquidityFormatted: z.string().optional(),
    creator: Creator,
    expired: z.boolean(),
    metadata: Metadata,
    settings: Settings.optional(),
    createdAt: z.string(),
    tradeType: z.string().optional(),
    updatedAt: z.string(),
    categories: z.array(z.string()),
    marketType: z.string(),
    proxyTitle: z.string().nullable().optional(),
    conditionId: z.string(),
    description: z.string(),
    isRewardable: boolDefaultFalse,
    priorityIndex: z.number(),
    expirationDate: z.string(),
    collateralToken: CollateralToken,
    volumeFormatted: z.string(),
    negRiskRequestId: z.string().nullable().optional(),
    venue: Venue,
    expirationTimestamp: z.number(),
    winningOutcomeIndex: z.number().nullable().optional(),
    positionIds: PositionIds.optional(),
    ogImageURI: z.string().nullable().optional(),
  })
  .passthrough();

// Main market schema (can be single or group)
export const LimitlessMarket = z
  .object({
    address: z.string().optional(),
    id: z.number(),
    logo: z.string().nullable().optional(),
    slug: z.string(),
    tags: z.array(z.string()),
    title: z.string(),
    prices: z.array(numish).optional(), // Only for single markets
    status: z.string(),
    tokens: Tokens.optional(), // Only for single markets
    feedEvents: z.array(FeedEvent).optional(),
    trends: Trends,
    volume: z.string(),
    openInterest: numish.optional(),
    openInterestFormatted: z.string().optional(),
    liquidity: numish.optional(),
    liquidityFormatted: z.string().optional(),
    creator: Creator,
    expired: z.boolean(),
    metadata: Metadata,
    settings: Settings.optional(), // Only for single markets
    createdAt: z.string(),
    tradeType: z.string(),
    updatedAt: z.string(),
    categories: z.array(z.string()),
    marketType: z.string(), // 'single' or 'group'
    proxyTitle: z.string().nullable().optional(),
    conditionId: z.string().optional(),
    description: z.string().optional(),
    isRewardable: optionalBool,
    priorityIndex: z.number().optional(),
    expirationDate: z.string().optional(),
    collateralToken: CollateralToken.optional(),
    volumeFormatted: z.string(),
    negRiskRequestId: z.string().nullable().optional(),
    expirationTimestamp: z.number().optional(),
    winningOutcomeIndex: z.number().nullable().optional(),
    venue: Venue,
    // Group market specific fields
    markets: z.array(LimitlessMarketItem).optional(), // Only for group markets
    ogImageURI: z.string().nullable().optional(),
    dailyReward: z.string().optional(),
    outcomeTokens: z.array(z.string()).optional(),
    negRiskMarketId: z.string().nullable().optional(),
    positionIds: PositionIds.optional(),
  })
  .passthrough();

export const LimitlessActiveResponse = z
  .object({
    data: z.array(LimitlessMarket).default([]),
    page: z.number().optional(),
    totalPages: z.number().optional(),
    totalMarketsCount: numish.optional(),
  })
  .passthrough();

const LimitlessActiveEnvelope = z
  .object({
    data: z.array(z.unknown()).default([]),
    page: z.number().optional(),
    totalPages: z.number().optional(),
    totalMarketsCount: numish.optional(),
  })
  .passthrough();

export type TLimitlessMarket = z.infer<typeof LimitlessMarket>;
export type TLimitlessMarketItem = z.infer<typeof LimitlessMarketItem>;
export type TLimitlessActiveResponse = z.infer<typeof LimitlessActiveResponse>;

export type LimitlessActiveParseIssue = {
  index: number;
  id?: number | string;
  slug?: string;
  title?: string;
  issues: Array<{
    path: string;
    message: string;
  }>;
};

function rawMarketIdentity(raw: unknown) {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;

  return {
    id:
      typeof record.id === "string" || typeof record.id === "number"
        ? record.id
        : undefined,
    slug: typeof record.slug === "string" ? record.slug : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
  };
}

function formatZodIssues(issues: ZodIssue[]) {
  return issues.slice(0, 8).map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

export function parseLimitlessActivePayload(raw: unknown): {
  response: TLimitlessActiveResponse;
  invalidMarkets: LimitlessActiveParseIssue[];
} {
  const envelope = LimitlessActiveEnvelope.parse(raw);
  const data: TLimitlessMarket[] = [];
  const invalidMarkets: LimitlessActiveParseIssue[] = [];

  envelope.data.forEach((market, index) => {
    const parsed = LimitlessMarket.safeParse(market);
    if (parsed.success) {
      data.push(parsed.data);
      return;
    }

    invalidMarkets.push({
      index,
      ...rawMarketIdentity(market),
      issues: formatZodIssues(parsed.error.issues),
    });
  });

  return {
    response: {
      ...envelope,
      data,
    },
    invalidMarkets,
  };
}

const OrderbookEntry = z.object({
  price: numish,
  size: numish,
  side: z.string().optional(),
});

export const LimitlessOrderbook = z
  .object({
    adjustedMidpoint: numish.optional(),
    asks: z.array(OrderbookEntry).default([]),
    bids: z.array(OrderbookEntry).default([]),
    lastTradePrice: numish.nullable().optional(),
    maxSpread: numish.optional(),
    minSize: numish.optional(),
    tokenId: z.string(),
  })
  .passthrough();

export type TLimitlessOrderbook = z.infer<typeof LimitlessOrderbook>;
