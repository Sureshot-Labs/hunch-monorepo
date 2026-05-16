import { z } from "zod";
import { zVenue } from "./common.js";

export const agentIntentKindSchema = z.enum([
  "trade",
  "bridge",
  "cancel_order",
  "redeem",
]);

const zOptionalString = z
  .string()
  .trim()
  .transform((value) => (value.length ? value : undefined))
  .optional();

const zRequiredIdempotencyKey = z
  .string()
  .trim()
  .min(8, "idempotencyKey is required")
  .max(160);

const zBaseIntent = z.object({
  kind: agentIntentKindSchema,
  idempotencyKey: zRequiredIdempotencyKey,
  venue: zVenue.optional(),
  walletAddress: zOptionalString,
  marketId: zOptionalString,
  eventId: zOptionalString,
  note: zOptionalString,
});

const zTradeIntent = zBaseIntent
  .extend({
    kind: z.literal("trade"),
    side: z.enum(["BUY", "SELL"]),
    outcome: z.enum(["YES", "NO"]).optional(),
    tokenId: zOptionalString,
    amountType: z.enum(["usd", "shares"]),
    amount: z.coerce.number().positive(),
    orderType: z.enum(["market", "limit"]).default("market"),
    limitPrice: z.coerce.number().positive().optional(),
    slippageBps: z.coerce.number().int().min(0).max(10_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.orderType === "limit" && value.limitPrice == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["limitPrice"],
        message: "limitPrice is required for limit intents",
      });
    }
  });

const zCancelOrderIntent = zBaseIntent.extend({
  kind: z.literal("cancel_order"),
  orderId: z.string().trim().min(1, "orderId is required"),
});

const zBridgeIntent = zBaseIntent.extend({
  kind: z.literal("bridge"),
  venue: zVenue.optional(),
  srcChainId: zOptionalString,
  dstChainId: zOptionalString,
  srcToken: zOptionalString,
  dstToken: zOptionalString,
  amountIn: zOptionalString,
});

const zRedeemIntent = zBaseIntent.extend({
  kind: z.literal("redeem"),
  venue: zVenue,
  tokenId: zOptionalString,
  outcome: z.enum(["YES", "NO"]).optional(),
});

export const agentIntentRequestSchema = z.discriminatedUnion("kind", [
  zTradeIntent,
  zBridgeIntent,
  zCancelOrderIntent,
  zRedeemIntent,
]);

export const agentFundingPlanBodySchema = z.object({
  venue: zVenue.optional(),
  walletAddress: zOptionalString,
  wallets: z.array(z.string().trim().min(1)).optional(),
  marketId: zOptionalString,
  eventId: zOptionalString,
  asset: zOptionalString,
  amount: z.coerce.number().positive().optional(),
});

export const agentIntentParamsSchema = z.object({
  id: z.string().uuid(),
});

export const agentIntentReviewParamsSchema = z.object({
  reviewToken: z.string().trim().min(16),
});

export type AgentIntentRequest = z.infer<typeof agentIntentRequestSchema>;
export type AgentFundingPlanRequest = z.infer<
  typeof agentFundingPlanBodySchema
>;
