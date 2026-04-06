import { z } from "zod";

export const forwardedAnalyticsEventNameSchema = z.enum([
  "hf_bridge_fail",
  "hf_bridge_submit",
  "hf_bridge_success",
  "hf_order_fail",
  "hf_order_submit",
  "hf_order_success",
  "hf_portfolio_order_cancel",
  "hf_portfolio_share_action",
  "hf_referral_link_landing",
  "hf_rewards_claim_action",
  "hf_rewards_referral_action",
]);

export const analyticsForwardBodySchema = z.object({
  event: forwardedAnalyticsEventNameSchema,
  payload: z.record(z.string(), z.unknown()),
});

export const analyticsForwardResponseSchema = z.object({
  ok: z.literal(true),
  accepted: z.boolean(),
  deduped: z.boolean().optional(),
  stored: z.boolean().optional(),
  reason: z.enum(["disabled", "invalid", "unsupported"]).optional(),
  error: z.string().optional(),
});

export const analyticsForwardTelemetryResponseSchema = z.object({
  ok: z.literal(true),
  enabled: z.boolean(),
  mode: z.enum(["database", "off"]),
  runtime: z.object({
    accepted: z.number(),
    deduped: z.number(),
    droppedDisabled: z.number(),
    droppedInvalid: z.number(),
    failed: z.number(),
  }),
  collector: z.object({
    stored: z.number(),
  }),
  byOrigin: z.array(
    z.object({
      origin: z.enum(["backend", "browser"]),
      count: z.number(),
    }),
  ),
  bySchemaVersion: z.array(
    z.object({
      version: z.string(),
      count: z.number(),
    }),
  ),
  byEvent: z.array(
    z.object({
      event: z.string(),
      count: z.number(),
    }),
  ),
});
