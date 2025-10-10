import { z } from "zod";

// numbers often come as strings; welcome to APIs.
const numish = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "string" ? (v.trim() ? Number(v) : NaN) : v));

// Collateral token schema
const CollateralToken = z.object({
  symbol: z.string(),
  address: z.string(),
  decimals: z.number().default(6),
});

// Creator schema
const Creator = z.object({
  name: z.string(),
  imageURI: z.string(),
  link: z.string(),
});

// Trends schema
const Trends = z.object({
  hourly: z.object({
    rank: z.number(),
    value: z.number(),
  }),
}).optional();

// Metadata schema
const Metadata = z.object({
  fee: z.boolean().optional(),
  isBannered: z.boolean().optional(),
  isPolyArbitrage: z.boolean().optional(),
  shouldMarketMake: z.boolean().optional(),
});

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

// Individual market schema (for group markets)
const LimitlessMarketItem = z.object({
  id: z.number(),
  logo: z.string().nullable().optional(),
  slug: z.string(),
  tags: z.array(z.string()),
  title: z.string(),
  prices: z.array(numish),
  status: z.string(),
  tokens: Tokens,
  volume: z.string(),
  creator: Creator,
  expired: z.boolean(),
  metadata: Metadata,
  settings: Settings,
  createdAt: z.string(),
  tradeType: z.string(),
  updatedAt: z.string(),
  categories: z.array(z.string()),
  marketType: z.string(),
  proxyTitle: z.string().nullable().optional(),
  conditionId: z.string(),
  description: z.string(),
  isRewardable: z.boolean(),
  priorityIndex: z.number(),
  expirationDate: z.string(),
  collateralToken: CollateralToken,
  volumeFormatted: z.string(),
  negRiskRequestId: z.string().nullable().optional(),
  expirationTimestamp: z.number(),
  winningOutcomeIndex: z.number().nullable().optional(),
});

// Main market schema (can be single or group)
export const LimitlessMarket = z.object({
  id: z.number(),
  logo: z.string().nullable().optional(),
  slug: z.string(),
  tags: z.array(z.string()),
  title: z.string(),
  prices: z.array(numish).optional(), // Only for single markets
  status: z.string(),
  tokens: Tokens.optional(), // Only for single markets
  trends: Trends,
  volume: z.string(),
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
  isRewardable: z.boolean().optional(),
  priorityIndex: z.number().optional(),
  expirationDate: z.string().optional(),
  collateralToken: CollateralToken.optional(),
  volumeFormatted: z.string(),
  negRiskRequestId: z.string().nullable().optional(),
  expirationTimestamp: z.number().optional(),
  winningOutcomeIndex: z.number().nullable().optional(),
  // Group market specific fields
  markets: z.array(LimitlessMarketItem).optional(), // Only for group markets
  ogImageURI: z.string().nullable().optional(),
  dailyReward: z.string().optional(),
  outcomeTokens: z.array(z.string()).optional(),
  negRiskMarketId: z.string().optional(),
});

export const LimitlessActiveResponse = z
  .object({
    data: z.array(LimitlessMarket).default([]),
    page: z.number().optional(),
    totalPages: z.number().optional(),
  })
  .passthrough();

export type TLimitlessMarket = z.infer<typeof LimitlessMarket>;
export type TLimitlessMarketItem = z.infer<typeof LimitlessMarketItem>;
