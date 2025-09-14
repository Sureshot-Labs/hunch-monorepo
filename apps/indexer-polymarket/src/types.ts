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

export type TEvent = z.infer<typeof GammaEvent>;
export type TMarket = z.infer<typeof GammaMarket>;
