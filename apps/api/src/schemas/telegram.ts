import { z } from "zod";
import { nativeHip4OrderReadSchema } from "./orders.js";
import { authErrorResponseSchema } from "./auth.js";

export const telegramContextBodySchema = z.object({
  initDataRaw: z
    .string()
    .trim()
    .min(1)
    .max(8 * 1024),
});

export const telegramContextSuccessResponseSchema = z.object({
  ok: z.literal(true),
  telegram: z.object({
    authDate: z.string(),
    startParam: z.string().nullable().optional(),
    user: z.object({
      id: z.string(),
      firstName: z.string().nullable().optional(),
      lastName: z.string().nullable().optional(),
      username: z.string().nullable().optional(),
      photoUrl: z.string().nullable().optional(),
    }),
  }),
});

export const telegramContextErrorResponseSchema = z.object({
  error: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
});

const telegramAppHandoffTokenSchema = z
  .string()
  .trim()
  .regex(/^th1_[A-Za-z0-9_-]{43}$/);

export const telegramAppHandoffRequestSchema = z
  .object({
    initDataRaw: z
      .string()
      .trim()
      .min(1)
      .max(8 * 1024),
    token: telegramAppHandoffTokenSchema,
  })
  .strict();

export const telegramAppHandoffCommitRequestSchema =
  telegramAppHandoffRequestSchema
    .extend({
      planFingerprint: z.string().regex(/^[0-9a-f]{64}$/i),
    })
    .strict();

export const telegramAppHandoffResponseSchema = z.object({
  handoff: z.object({
    authorityFingerprint: z.string(),
    cancelledAt: z.string().nullable(),
    claimedAt: z.string().nullable(),
    committedAt: z.string().nullable(),
    expiresAt: z.string(),
    expiredAt: z.string().nullable(),
    id: z.string().uuid(),
    planFingerprint: z.string(),
    planSnapshot: z.record(z.string(), z.unknown()),
    policyRevision: z.string(),
    quoteSnapshot: z.record(z.string(), z.unknown()),
    state: z.enum(["issued", "claimed", "committed", "cancelled", "expired"]),
    tradeIntentId: z.string().uuid(),
  }),
});

/** Returned by the only contract issued by new Telegram handoffs: v2. */
export const telegramAppHandoffClientExecutionSchema = z.object({
  execution: z.discriminatedUnion("kind", [
    z.object({
      fundingOperationId: z.string().uuid(),
      handoffId: z.string().uuid(),
      kind: z.literal("client_execution_required"),
      requiredContractVersion: z.literal(2),
    }),
    z.object({
      fundingOperationId: z.string().uuid(),
      fundingReservationId: z.string().uuid(),
      handoffId: z.string().uuid(),
      kind: z.literal("trade_continuation_required"),
      requiredContractVersion: z.literal(2),
    }),
    z.object({
      fundingOperationId: z.string().uuid(),
      fundingReservationId: z.string().uuid(),
      handoffId: z.string().uuid(),
      kind: z.literal("trade_continuation_in_flight"),
      orderId: z.string().uuid().optional(),
      venueOrderId: z.string().nullable().optional(),
      nativeOrder: nativeHip4OrderReadSchema.optional(),
      requiredContractVersion: z.literal(2),
      tradeAttemptId: z.string().uuid(),
      tradeAttemptState: z.enum([
        "accepted",
        "ambiguous",
        "claimed",
        "submission_started",
      ]),
    }),
    z.object({
      handoffId: z.string().uuid(),
      kind: z.literal("direct_trade_continuation_required"),
      planFingerprint: z.string().regex(/^[0-9a-f]{64}$/iu),
      requiredContractVersion: z.literal(2),
      tradeIntentId: z.string().uuid(),
    }),
    z.object({
      handoffId: z.string().uuid(),
      kind: z.literal("direct_trade_in_flight"),
      nativeOrder: nativeHip4OrderReadSchema.optional(),
      orderId: z.string().uuid().nullable(),
      planFingerprint: z.string().regex(/^[0-9a-f]{64}$/iu),
      requiredContractVersion: z.literal(2),
      tradeIntentId: z.string().uuid(),
      venueOrderId: z.string().nullable(),
    }),
    z.object({
      handoffId: z.string().uuid(),
      kind: z.literal("trade_terminal"),
      orderId: z.string().uuid().optional(),
      venueOrderId: z.string().nullable().optional(),
      nativeOrder: nativeHip4OrderReadSchema.optional(),
      requiredContractVersion: z.literal(2),
      status: z.enum(["cancelled", "expired", "failed", "filled"]),
      tradeIntentId: z.string().uuid(),
    }),
  ]),
  handoff: telegramAppHandoffResponseSchema.shape.handoff,
});

// The execution-bearing branch must stay first. Zod object schemas strip
// unknown keys, so parsing it after the handoff-only branch would silently
// remove `execution` from a successful v2 commit response.
export const telegramAppHandoffCommitResponseSchema = z.union([
  telegramAppHandoffClientExecutionSchema,
  telegramAppHandoffResponseSchema,
]);

export const telegramAppHandoffProjectionSchema = z.object({
  action: z.enum(["buy", "sell"]),
  amountUsd: z.number().nullable(),
  canAutoClose: z.boolean(),
  continuesInBackground: z.boolean(),
  error: z
    .object({
      code: z.string().nullable(),
      message: z.string().nullable(),
    })
    .nullable(),
  eventTitle: z.string().nullable(),
  funding: z
    .object({
      operationId: z.string().uuid(),
      progressStage: z.string().nullable(),
      status: z.string().nullable(),
    })
    .nullable(),
  marketTitle: z.string(),
  nativeOrder: nativeHip4OrderReadSchema.optional(),
  minimumReceiveRaw: z.string().regex(/^\d+$/u).nullable(),
  order: z.object({
    executionId: z.string().uuid().nullable(),
    orderId: z.string().uuid().nullable(),
    txSignature: z.string().nullable(),
    venueOrderId: z.string().nullable(),
  }),
  outcome: z.string(),
  revision: z.string().datetime(),
  sharesRaw: z.string().regex(/^\d+$/u).nullable(),
  stage: z.enum([
    "attaching",
    "failed",
    "funding",
    "reconciling",
    "submitting",
    "success",
  ]),
  status: z.string(),
  terminal: z.boolean(),
  tradeIntentId: z.string().uuid(),
  venue: z.enum(["kalshi", "limitless", "polymarket", "hyperliquid"]),
});

export const telegramAppHandoffProjectionResponseSchema = z.object({
  projection: telegramAppHandoffProjectionSchema,
});

export const telegramAppHandoffExecuteResponseSchema = z.union([
  telegramAppHandoffProjectionResponseSchema,
  telegramAppHandoffClientExecutionSchema,
]);

const telegramAppHandoffResponses = {
  200: telegramAppHandoffResponseSchema,
  400: telegramContextErrorResponseSchema,
  401: authErrorResponseSchema,
  403: telegramContextErrorResponseSchema,
  404: telegramContextErrorResponseSchema,
  409: telegramContextErrorResponseSchema,
  503: telegramContextErrorResponseSchema,
};
const telegramAppHandoffAccessRoute = {
  body: telegramAppHandoffRequestSchema,
  response: telegramAppHandoffResponses,
};
/** Actual HTTP routes and offline generation use the same schemas. Native
 * factual execution coverage must not disappear from a stale client DTO. */
export const telegramAppHandoffRouteSchemas = {
  "/telegram/app-handoffs/resolve": telegramAppHandoffAccessRoute,
  "/telegram/app-handoffs/claim": telegramAppHandoffAccessRoute,
  "/telegram/app-handoffs/cancel": telegramAppHandoffAccessRoute,
  "/telegram/app-handoffs/commit": {
    body: telegramAppHandoffCommitRequestSchema,
    response: {
      ...telegramAppHandoffResponses,
      200: telegramAppHandoffCommitResponseSchema,
    },
  },
  "/telegram/app-handoffs/projection": {
    body: telegramAppHandoffRequestSchema,
    response: {
      ...telegramAppHandoffResponses,
      200: z.union([
        telegramAppHandoffResponseSchema,
        telegramAppHandoffProjectionResponseSchema,
      ]),
    },
  },
  "/telegram/app-handoffs/execute": {
    body: telegramAppHandoffRequestSchema,
    response: {
      ...telegramAppHandoffResponses,
      200: telegramAppHandoffExecuteResponseSchema,
    },
  },
} as const;

export const telegramGroupMembershipStateSchema = z.enum([
  "member",
  "not_member",
  "telegram_not_linked",
  "unavailable",
]);

export const telegramGroupMembershipResponseSchema = z.object({
  cached: z.boolean(),
  checkedAt: z.string(),
  state: telegramGroupMembershipStateSchema,
});
