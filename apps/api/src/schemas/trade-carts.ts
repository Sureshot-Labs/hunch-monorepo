import { z } from "zod";
import { zVenue } from "./common.js";

export const tradeCartStatusSchema = z.enum([
  "draft",
  "executing",
  "partially_executed",
  "completed",
  "abandoned",
]);

export const tradeCartSourceTypeSchema = z.enum([
  "manual",
  "proposal",
  "session",
]);

export const tradeCartItemStatusSchema = z.enum([
  "draft",
  "skipped",
  "removed",
]);

export const tradeCartSideSchema = z.enum(["BUY", "SELL"]);
export const tradeCartOrderTypeSchema = z.enum(["GTC", "GTD", "FAK", "FOK"]);

export const uuidParamsSchema = z.object({
  cartId: z.string().uuid(),
});

export const tradeCartItemParamsSchema = z.object({
  cartId: z.string().uuid(),
  itemId: z.string().uuid(),
});

const boundedJsonObjectSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => {
    try {
      return JSON.stringify(value).length <= 20_000;
    } catch {
      return false;
    }
  }, "JSON object is too large");

const optionalNullableText = (maxLength: number) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null) return value;
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    },
    z.string().max(maxLength).nullable().optional(),
  );

const optionalUnsignedIntegerString = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return value;
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  },
  z
    .string()
    .regex(/^[0-9]+$/, "Expected an unsigned integer string")
    .nullable()
    .optional(),
);

const optionalLimitPrice = z
  .preprocess(
    (value) => {
      if (value === undefined || value === null) return value;
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length > 0 ? Number(trimmed) : null;
    },
    z.number().min(0).max(1).nullable().optional(),
  );

const optionalAllocationWeight = z
  .preprocess(
    (value) => {
      if (value === undefined || value === null) return value;
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length > 0 ? Number(trimmed) : null;
    },
    z.number().positive().nullable().optional(),
  );

export const tradeCartsListQuerySchema = z.object({
  status: tradeCartStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).catch(50),
  offset: z.coerce.number().int().min(0).catch(0),
});

export const tradeCartCreateBodySchema = z
  .object({
    name: optionalNullableText(200),
    sourceType: tradeCartSourceTypeSchema.optional(),
    sourceId: optionalNullableText(500),
    metadata: boundedJsonObjectSchema.optional(),
  })
  .strict();

export const tradeCartItemCreateBodySchema = z
  .object({
    clientItemId: z.string().trim().min(1).max(200),
    venue: zVenue,
    marketId: optionalNullableText(500),
    tokenId: optionalNullableText(500),
    marketSlug: optionalNullableText(500),
    outcome: optionalNullableText(200),
    side: tradeCartSideSchema,
    orderType: tradeCartOrderTypeSchema.nullable().optional(),
    limitPrice: optionalLimitPrice,
    amountRaw: optionalUnsignedIntegerString,
    allocationWeight: optionalAllocationWeight,
    walletAddress: optionalNullableText(500),
    signerAddress: optionalNullableText(500),
    funderAddress: optionalNullableText(500),
    intentSnapshot: boundedJsonObjectSchema.optional(),
  })
  .strict();

export const tradeCartItemPatchBodySchema = z
  .object({
    marketId: optionalNullableText(500),
    tokenId: optionalNullableText(500),
    marketSlug: optionalNullableText(500),
    outcome: optionalNullableText(200),
    orderType: tradeCartOrderTypeSchema.nullable().optional(),
    limitPrice: optionalLimitPrice,
    amountRaw: optionalUnsignedIntegerString,
    allocationWeight: optionalAllocationWeight,
    walletAddress: optionalNullableText(500),
    signerAddress: optionalNullableText(500),
    funderAddress: optionalNullableText(500),
    status: tradeCartItemStatusSchema.optional(),
    intentSnapshot: boundedJsonObjectSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export type TradeCartCreateBody = z.infer<typeof tradeCartCreateBodySchema>;
export type TradeCartItemCreateBody = z.infer<
  typeof tradeCartItemCreateBodySchema
>;
export type TradeCartItemPatchBody = z.infer<
  typeof tradeCartItemPatchBodySchema
>;
