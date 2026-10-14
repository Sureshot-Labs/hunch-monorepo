import { z } from "zod";
import { zCsvString } from "./common.js";
import { positionReadVenueSchema } from "./positions.js";
import { hip4AccountExecutionSchema } from "./hip4-account.js";
import { hip4OpenOrderSchema } from "../services/hip4-open-orders.js";

const zVenueOptional = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  positionReadVenueSchema.optional(),
);

const zOrderKind = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  z.enum(["order", "swap", "execution"]).optional(),
);

export function orderReadRouteSchemas(limits: {
  defaultLimit: number;
  maxLimit: number;
}) {
  const ordersQuerySchema = z.object({
    venue: zVenueOptional,
    wallets: zCsvString("wallets is required").optional(),
    q: z
      .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
      .optional()
      .transform((v) => (v && v.length ? v.slice(0, 160) : undefined)),
    eventId: z
      .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
      .optional()
      .transform((v) => (v && v.length ? v : undefined)),
    marketId: z
      .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
      .optional()
      .transform((v) => (v && v.length ? v : undefined)),
    tokenId: z
      .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
      .optional()
      .transform((v) => (v && v.length ? v : undefined)),
    status: z
      .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
      .optional()
      .transform((v) => (v && v.length ? v : undefined)),
    type: zOrderKind,
    limit: z.coerce
      .number()
      .int()
      .catch(limits.defaultLimit)
      .transform((n) => Math.min(Math.max(n, 1), limits.maxLimit)),
    offset: z.coerce
      .number()
      .int()
      .catch(0)
      .transform((n) => Math.max(n, 0)),
  });

  const ordersOpenQuerySchema = ordersQuerySchema.omit({
    status: true,
    type: true,
  });

  const orderIdParamsSchema = z.object({
    id: z.string().min(1, "id is required"),
  });

  const orderIdQuerySchema = z.object({
    wallets: zCsvString("wallets is required").optional(),
  });
  const errorResponse = z.object({ error: z.string() }).passthrough();
  const errors = {
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  };
  return {
    "/orders": {
      querystring: ordersQuerySchema,
      response: { ...errors, 200: ordersReadResponseSchema },
    },
    "/orders/open": {
      querystring: ordersOpenQuerySchema,
      response: { ...errors, 200: ordersReadResponseSchema },
    },
    "/orders/:id": {
      params: orderIdParamsSchema,
      querystring: orderIdQuerySchema,
      response: { ...errors, 200: z.object({ order: unifiedOrderReadSchema }) },
    },
  };
}

const maybeText = z.string().nullable().optional();
const maybeNumber = z.number().finite().nullable().optional();
const maybeTime = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.string().datetime().nullable().optional(),
);
export const unifiedOrderReadSchema = z.object({
  id: z.string(),
  kind: z.enum(["order", "swap", "execution", "observed_order"]),
  // Old order rows may have no venue. Do not turn one legacy row into a
  // response-wide serialization failure while adding the observed branch.
  venue: z.string().nullable(),
  walletAddress: maybeText,
  venueOrderId: maybeText,
  tokenId: maybeText,
  side: maybeText,
  outcome: maybeText,
  orderType: maybeText,
  price: maybeNumber,
  size: maybeNumber,
  status: maybeText,
  statusReason: maybeText,
  filledSize: maybeNumber,
  averageFillPrice: maybeNumber,
  expiresAt: maybeTime,
  createdAt: maybeTime,
  updatedAt: maybeTime,
  filledAt: maybeTime,
  cancelledAt: maybeTime,
  unifiedMarketId: maybeText,
  inputMint: maybeText,
  outputMint: maybeText,
  amountIn: maybeNumber,
  amountOut: maybeNumber,
  inputDecimals: maybeNumber,
  outputDecimals: maybeNumber,
  txSignature: maybeText,
  execution: hip4AccountExecutionSchema.optional(),
  observedOrder: hip4OpenOrderSchema
    .extend({
      observedAt: z.string().datetime(),
      validUntil: z.string().datetime(),
    })
    .optional(),
  actionRef: z.null().optional(),
});
export const ordersReadResponseSchema = z.object({
  orders: z.array(unifiedOrderReadSchema),
  coverage: z
    .object({ hyperliquid: z.enum(["limited", "unavailable", "disabled"]) })
    .optional(),
  openOrderCoverage: z
    .object({
      hyperliquid: z.object({
        state: z.enum(["fresh", "partial", "unavailable", "disabled"]),
        validUntil: z.string().datetime().nullable(),
      }),
    })
    .optional(),
  pagination: z.object({
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }),
});
