import { z } from "zod";

// helpers
const num = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "string" ? parseFloat(v) : v));
const strArrayOrJSONString = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => {
    if (Array.isArray(v)) return v;
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

// Legacy types for backward compatibility
export const GammaMarket = z
  .object({
    id: z.string(),
    question: z.string(),
    slug: z.string().optional().nullable(),
    conditionId: z.string().optional().nullable(),
    endDate: z.string().optional().nullable(),
    startDate: z.string().optional().nullable(),

    enableOrderBook: z.boolean().optional(),
    acceptingOrders: z.boolean().optional(),

    orderPriceMinTickSize: num.optional().nullable(),
    orderMinSize: num.optional().nullable(),

    // numbers that sometimes arrive as strings
    liquidity: num.optional().nullable(),
    volume: num.optional().nullable(),
    volume24hr: num.optional().nullable(),

    // explicit numeric fallbacks on Gamma
    liquidityNum: num.optional().nullable(),
    volumeNum: num.optional().nullable(),

    negRisk: z.boolean().optional().nullable(),
    negRiskMarketID: z.string().optional().nullable(),

    // This is the troublemaker: sometimes a JSON string
    clobTokenIds: strArrayOrJSONString.optional().default([]),

    // We don't care about the rest right now; keep loose
  })
  .passthrough();

export const GammaEvent = z
  .object({
    id: z.string(),
    ticker: z.string().optional().nullable(),
    slug: z.string().optional().nullable(),
    title: z.string(),
    description: z.string().optional().nullable(),
    startDate: z.string().optional().nullable(),
    endDate: z.string().optional().nullable(),
    active: z.boolean().optional(),
    closed: z.boolean().optional(),
    archived: z.boolean().optional(),

    liquidity: num.optional().nullable(),
    volume: num.optional().nullable(),
    volume24hr: num.optional().nullable(),

    markets: z.array(GammaMarket).default([]),
  })
  .passthrough();

// Accept BOTH shapes: {events:[...]} OR {data:[...]}
export const GammaEventsResponse = z
  .object({
    events: z.array(GammaEvent).optional(),
    data: z.array(GammaEvent).optional(),
    count: z.number().optional(),
  })
  .refine((o) => Array.isArray(o.events) || Array.isArray(o.data), {
    message: "Gamma response missing events/data array",
  });

// New Polymarket-specific types based on the provided schema
export const PolymarketMarket = z
  .object({
    id: z.string(),
    question: z.string(),
    conditionId: z.string().optional().nullable(),
    slug: z.string().optional().nullable(),
    resolutionSource: z.string().optional().nullable(),
    endDate: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    liquidity: num.optional().nullable(), // Can be number or string
    startDate: z.string().optional().nullable(),
    image: z.string().optional().nullable(),
    icon: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    outcomes: z.string().optional().nullable(), // JSON string
    outcomePrices: z.string().optional().nullable(), // JSON string
    volume: num.optional().nullable(), // Can be number or string
    active: z.boolean().optional(),
    closed: z.boolean().optional(),
    marketMakerAddress: z.string().optional().nullable(),
    createdAt: z.string().optional().nullable(),
    updatedAt: z.string().optional().nullable(),
    new: z.boolean().optional(),
    featured: z.boolean().optional(),
    submitted_by: z.string().optional().nullable(),
    archived: z.boolean().optional(),
    resolvedBy: z.string().optional().nullable(),
    restricted: z.boolean().optional(),
    groupItemTitle: z.string().optional().nullable(),
    groupItemThreshold: z.string().optional().nullable(),
    questionID: z.string().optional().nullable(),
    enableOrderBook: z.boolean().optional(),
    orderPriceMinTickSize: num.optional().nullable(),
    orderMinSize: num.optional().nullable(),
    volumeNum: num.optional().nullable(),
    liquidityNum: num.optional().nullable(),
    endDateIso: z.string().optional().nullable(),
    startDateIso: z.string().optional().nullable(),
    hasReviewedDates: z.boolean().optional(),
    volume24hr: num.optional().nullable(),
    volume1wk: num.optional().nullable(),
    volume1mo: num.optional().nullable(),
    volume1yr: num.optional().nullable(),
    clobTokenIds: strArrayOrJSONString.optional().default([]), // Can be array or JSON string
    umaBond: z.string().optional().nullable(),
    umaReward: z.string().optional().nullable(),
    volume24hrClob: num.optional().nullable(),
    volume1wkClob: num.optional().nullable(),
    volume1moClob: num.optional().nullable(),
    volume1yrClob: num.optional().nullable(),
    volumeClob: num.optional().nullable(),
    liquidityClob: num.optional().nullable(),
    customLiveness: num.optional().nullable(),
    acceptingOrders: z.boolean().optional(),
    negRisk: z.boolean().optional(),
    negRiskRequestID: z.string().optional().nullable(),
    ready: z.boolean().optional(),
    funded: z.boolean().optional(),
    acceptingOrdersTimestamp: z.string().optional().nullable(),
    cyom: z.boolean().optional(),
    competitive: num.optional().nullable(),
    pagerDutyNotificationEnabled: z.boolean().optional(),
    approved: z.boolean().optional(),
    rewardsMinSize: num.optional().nullable(),
    rewardsMaxSpread: num.optional().nullable(),
    spread: num.optional().nullable(),
    oneDayPriceChange: num.optional().nullable(),
    oneHourPriceChange: num.optional().nullable(),
    oneWeekPriceChange: num.optional().nullable(),
    oneMonthPriceChange: num.optional().nullable(),
    lastTradePrice: num.optional().nullable(),
    bestBid: num.optional().nullable(),
    bestAsk: num.optional().nullable(),
    automaticallyActive: z.boolean().optional(),
    clearBookOnStart: z.boolean().optional(),
    seriesColor: z.string().optional().nullable(),
    showGmpSeries: z.boolean().optional(),
    showGmpOutcome: z.boolean().optional(),
    manualActivation: z.boolean().optional(),
    negRiskOther: z.boolean().optional(),
    umaResolutionStatuses: z.string().optional().nullable(), // JSON string
    pendingDeployment: z.boolean().optional(),
    deploying: z.boolean().optional(),
    deployingTimestamp: z.string().optional().nullable(),
    rfqEnabled: z.boolean().optional(),
    holdingRewardsEnabled: z.boolean().optional(),
    feesEnabled: z.boolean().optional(),
  })
  .passthrough();

export const PolymarketEvent = z
  .object({
    id: z.string(),
    ticker: z.string().optional().nullable(),
    slug: z.string().optional().nullable(),
    title: z.string(),
    description: z.string().optional().nullable(),
    resolutionSource: z.string().optional().nullable(),
    startDate: z.string().optional().nullable(),
    creationDate: z.string().optional().nullable(),
    endDate: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    image: z.string().optional().nullable(),
    icon: z.string().optional().nullable(),
    active: z.boolean().optional(),
    closed: z.boolean().optional(),
    archived: z.boolean().optional(),
    new: z.boolean().optional(),
    featured: z.boolean().optional(),
    restricted: z.boolean().optional(),
    liquidity: num.optional().nullable(),
    volume: num.optional().nullable(),
    openInterest: num.optional().nullable(),
    createdBy: z.string().optional().nullable(),
    createdAt: z.string().optional().nullable(),
    updatedAt: z.string().optional().nullable(),
    competitive: num.optional().nullable(),
    volume24hr: num.optional().nullable(),
    volume1wk: num.optional().nullable(),
    volume1mo: num.optional().nullable(),
    volume1yr: num.optional().nullable(),
    enableOrderBook: z.boolean().optional(),
    liquidityClob: num.optional().nullable(),
    negRisk: z.boolean().optional(),
    commentCount: num.optional().nullable(),
    markets: z.array(PolymarketMarket).default([]),
  })
  .passthrough();

export type TEvent = z.infer<typeof GammaEvent>;
export type TMarket = z.infer<typeof GammaMarket>;
export type TPolymarketEvent = z.infer<typeof PolymarketEvent>;
export type TPolymarketMarket = z.infer<typeof PolymarketMarket>;
