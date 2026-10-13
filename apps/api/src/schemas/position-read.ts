import { z } from "zod";
import { hip4ReadMarketSchema } from "@hunch/shared";
import { zVenue } from "./common.js";
import {
  positionReadVenueSchema,
  positionsReadQuerySchema,
  positionsByTokenReadQuerySchema,
  positionsPnlReadQuerySchema,
} from "./positions.js";

const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const timestamp = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.string().datetime(),
);
export const hip4PortfolioPositionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  walletAddress: z.string(),
  venue: z.literal("hyperliquid"),
  tokenId: z.string(),
  side: z.literal("LONG"),
  size: z.number().finite().nonnegative(),
  sizeRaw: decimal,
  averagePrice: z.null(),
  unrealizedPnl: z.null(),
  realizedPnl: z.null(),
  lastUpdatedAt: z.string().datetime(),
  instrument: z.object({
    environment: z.enum(["mainnet", "testnet"]),
    marketId: z.string(),
    outcome: z.number().int().nonnegative(),
    sideIndex: z.union([z.literal(0), z.literal(1)]),
    coin: z.string(),
  }),
  observation: z.object({
    state: z.enum(["fresh", "stale"]),
    validUntil: z.string().datetime(),
  }),
  valuation: z.object({
    markPrice: decimal.nullable(),
    marketValue: decimal.nullable(),
    source: z.enum(["book_bid", "official_payout"]).nullable(),
    observedAt: z.string().datetime().nullable(),
    validUntil: z.string().datetime().nullable(),
  }),
  marketSummary: z
    .object({
      eventId: z.string(),
      title: z.string(),
      eventTitle: z.string(),
      outcomeLabel: z.string(),
      expiry: z.string().datetime().nullable(),
      status: hip4ReadMarketSchema.shape.status,
    })
    .nullable(),
  capabilities: z.object({
    sell: z.literal(false),
    redeem: z.literal(false),
    hide: z.literal(false),
  }),
});
export type Hip4PortfolioPosition = z.infer<typeof hip4PortfolioPositionSchema>;

// Existing optional/frozen asset metadata remains intact. The HIP branch has
// an explicit read identity, never a fabricated Polymarket asset context.
const legacyPositionSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    walletAddress: z.string().nullable(),
    venue: zVenue,
    tokenId: z.string(),
    positionContract: z.string().optional(),
    assetContext: z.record(z.string(), z.unknown()).optional(),
    side: z.enum(["LONG", "SHORT", "FLAT"]),
    size: z.number(),
    sizeRaw: z.string().optional(),
    averagePrice: z.number().optional(),
    averagePriceRaw: z.string().optional(),
    unrealizedPnl: z.number(),
    realizedPnl: z.number(),
    estimatedPayout: z.number().optional(),
    estimatedProfit: z.number().optional(),
    isHidden: z.boolean().optional(),
    hiddenReason: z.string().optional(),
    hiddenAt: timestamp.optional(),
    lastUpdatedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .passthrough();
export const positionReadSchema = z.union([
  legacyPositionSchema,
  hip4PortfolioPositionSchema,
]);
export const positionReadErrorSchema = z.object({ error: z.string() });
export const hip4PortfolioCoverageSchema = z.object({
  state: z.enum(["disabled", "ready", "partial", "unavailable"]),
  policyRevision: z.string().nullable(),
  accounts: z.number().int().nonnegative(),
  missingAccounts: z.number().int().nonnegative(),
  staleAccounts: z.number().int().nonnegative(),
  unresolvedBalances: z.number().int().nonnegative(),
  missingCostBasis: z.number().int().nonnegative(),
  unpricedPositions: z.number().int().nonnegative(),
});
export const positionsReadResponseSchema = z.object({
  positions: z.array(positionReadSchema),
  venue: positionReadVenueSchema.optional(),
  marketsByToken: z.array(z.record(z.string(), z.unknown())).optional(),
  coverage: z.object({ hyperliquid: hip4PortfolioCoverageSchema }).optional(),
});
export const positionsPnlReadResponseSchema = z.object({
  venue: positionReadVenueSchema.optional(),
  summary: z.object({
    openPositionsCount: z.number(),
    positionsCount: z.number(),
    realizedPnlAllTime: z.number().nullable(),
    unrealizedCostBasisCurrent: z.number().nullable(),
    unrealizedPnlCurrent: z.number().nullable(),
    unrealizedPnlPercentCurrent: z.number().nullable(),
  }),
  coverage: z.object({ hyperliquid: hip4PortfolioCoverageSchema }).optional(),
});

const readErrors = {
  400: positionReadErrorSchema,
  401: positionReadErrorSchema,
  500: positionReadErrorSchema,
};
// Shared by the real authenticated routes and offline OpenAPI generation.
export const positionReadRouteSchemas = {
  "/positions": {
    querystring: positionsReadQuerySchema,
    response: { 200: positionsReadResponseSchema, ...readErrors },
  },
  "/positions/by-token": {
    querystring: positionsByTokenReadQuerySchema,
    response: { 200: positionsReadResponseSchema, ...readErrors },
  },
  "/positions/pnl": {
    querystring: positionsPnlReadQuerySchema,
    response: { 200: positionsPnlReadResponseSchema, ...readErrors },
  },
};
