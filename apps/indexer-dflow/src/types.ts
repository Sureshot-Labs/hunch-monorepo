import { z } from "zod";

export const DflowMarketAccount = z
  .object({
    isInitialized: z.boolean().optional().nullable(),
    yesMint: z.string().optional().nullable(),
    noMint: z.string().optional().nullable(),
    marketLedger: z.string().optional().nullable(),
    redemptionStatus: z.string().optional().nullable(),
  })
  .passthrough();

export const DflowMarket = z
  .object({
    ticker: z.string(),
    title: z.string().optional().nullable(),
    status: z.string().optional().nullable(),

    yesBid: z.union([z.number(), z.string()]).optional().nullable(),
    yesAsk: z.union([z.number(), z.string()]).optional().nullable(),
    noBid: z.union([z.number(), z.string()]).optional().nullable(),
    noAsk: z.union([z.number(), z.string()]).optional().nullable(),

    volume24h: z.union([z.number(), z.string()]).optional().nullable(),
    volume: z.union([z.number(), z.string()]).optional().nullable(),
    liquidity: z.union([z.number(), z.string()]).optional().nullable(),
    openInterest: z.union([z.number(), z.string()]).optional().nullable(),

    openTime: z.union([z.string(), z.number()]).optional().nullable(),
    closeTime: z.union([z.string(), z.number()]).optional().nullable(),
    expirationTime: z.union([z.string(), z.number()]).optional().nullable(),

    accounts: z.record(z.string(), DflowMarketAccount).optional().nullable(),
  })
  .passthrough();

export const DflowEvent = z
  .object({
    ticker: z.string().optional().nullable(),
    eventTicker: z.string().optional().nullable(),
    event_ticker: z.string().optional().nullable(),
    id: z.string().optional().nullable(),

    title: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    startDate: z.union([z.string(), z.number()]).optional().nullable(),
    endDate: z.union([z.string(), z.number()]).optional().nullable(),

    markets: z.array(DflowMarket).optional().nullable(),
  })
  .passthrough();

export const DflowEventsResponse = z
  .object({
    events: z.array(DflowEvent).optional().nullable(),
    cursor: z.union([z.string(), z.number()]).optional().nullable(),
    nextCursor: z.union([z.string(), z.number()]).optional().nullable(),
  })
  .passthrough();

export type TDflowMarketAccount = z.infer<typeof DflowMarketAccount>;
export type TDflowMarket = z.infer<typeof DflowMarket>;
export type TDflowEvent = z.infer<typeof DflowEvent>;
export type TDflowEventsResponse = z.infer<typeof DflowEventsResponse>;
