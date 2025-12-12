import { z } from "zod";

const num = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "string" ? parseFloat(v) : v));

export const KalshiMarket = z
  .object({
    ticker: z.string(),
    event_ticker: z.string(),
    title: z.string().optional().nullable(),
    status: z.string().optional().default("open"),
    open_time: z.string().optional().nullable(),
    close_time: z.string().optional().nullable(),
    expiration_time: z.string().optional().nullable(),
    yes_price: num.optional().nullable(),
    no_price: num.optional().nullable(),
    liquidity: num.optional().nullable(),
    volume_24h: num.optional().nullable(),
    volume: num.optional().nullable(), // <-- add this
  })
  .passthrough();

// Events are keyed by event_ticker (not "ticker")
export const KalshiEvent = z
  .object({
    event_ticker: z.string(),
    title: z.string(),
    category: z.string().optional().nullable(),
    open_time: z.string().optional().nullable(),
    close_time: z.string().optional().nullable(),
    expiration_time: z.string().optional().nullable(),
    latest_expiration_time: z.string().optional().nullable(),
    series_ticker: z.string().optional().nullable(),
    // NEW: embed markets if requested
    markets: z.array(KalshiMarket).optional().default([]),
  })
  .passthrough();

export const KalshiEventsPage = z.object({
  events: z.array(KalshiEvent).default([]),
  cursor: z.string().optional().nullable(),
});

export const KalshiMarketsPage = z.object({
  markets: z.array(KalshiMarket).default([]),
  cursor: z.string().optional().nullable(),
});

// Orderbook returns bids-only; dollars arrays are string prices.
// Yes/no may be [price] or [price, qty] depending on endpoint churn.
// Be permissive.
// price level as [cents, qty], but qty may be missing in some responses
const PriceLevelCents = z.union([
  z.tuple([num, num]),
  z.tuple([num]).transform(([p]) => [p, 0] as [number, number]),
]);

// helper that coerces null/undefined/non-arrays -> []
const Levels = z.preprocess(
  (v) => (Array.isArray(v) ? v : []),
  z.array(PriceLevelCents),
);
const DollarLevels = z.preprocess(
  (v) => (Array.isArray(v) ? v : []),
  z.array(z.tuple([z.string(), num])),
);

export const KalshiOrderbook = z.object({
  orderbook: z.preprocess(
    // sometimes the whole thing is null
    (v) => v ?? {},
    z
      .object({
        yes: Levels,
        no: Levels,
        yes_dollars: DollarLevels.optional().default([]),
        no_dollars: DollarLevels.optional().default([]),
      })
      .passthrough(),
  ),
});
