import { z } from "zod";

import {
  canonicalIdSchema,
  opaqueIdSchema,
} from "../funding/domain/schemas.js";
import { normalizedActionSchema } from "../funding/domain/schemas.js";
import { actionSummarySchema, fundingReasonCodeSchema } from "./funding.js";

const positionActionKindSchema = z.literal("redeem");
const positionActionVenueSchema = canonicalIdSchema;
const positionActionStatusSchema = z.enum([
  "prepared",
  "awaiting_user",
  "submitting",
  "submitted",
  "reconcile_required",
  "confirmed",
  "completed",
  "failed",
  "cancelled",
]);

const positionActionRequestBaseSchema = z
  .object({
    action: positionActionKindSchema,
    venueId: positionActionVenueSchema,
    positionRef: z.string().uuid(),
    ownerBindingId: opaqueIdSchema,
  })
  .strict();

export const positionActionInspectRequestSchema =
  positionActionRequestBaseSchema;

export const positionActionPrepareRequestSchema =
  positionActionRequestBaseSchema
    .extend({
      expectedInspectionRevision: opaqueIdSchema,
      idempotencyKey: z.string().trim().min(16).max(192),
    })
    .strict();

export const positionActionOperationParamsSchema = z
  .object({ id: z.string().uuid() })
  .strict();

export const positionActionSubmissionReportSchema = z
  .object({
    attemptNumber: z.number().int().positive(),
    outcome: z.enum(["submitted", "ambiguous", "not_broadcast", "failed"]),
    submissionFingerprint: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/)
      .nullable(),
    errorCode: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();

const preparationCheckEvidenceSchema = z
  .object({
    checkId: z.string().trim().min(1).max(160),
    status: z.enum([
      "satisfied",
      "action_required",
      "user_action_required",
      "pending",
      "unavailable",
      "unsupported",
    ]),
    safeLabel: z.string().trim().min(1).max(240),
    reasonCode: fundingReasonCodeSchema.nullable(),
  })
  .strict();

export const positionActionReadinessSchema = z
  .object({
    ready: z.boolean(),
    action: positionActionKindSchema,
    venueId: positionActionVenueSchema,
    positionRef: z.string().uuid(),
    ownerBindingId: opaqueIdSchema,
    inspectionRevision: opaqueIdSchema,
    inspectedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    requiredActions: z.array(actionSummarySchema).max(16),
    postconditions: z
      .array(
        z
          .object({
            kind: z.string().trim().min(1).max(160),
            safeLabel: z.string().trim().min(1).max(240),
          })
          .strict(),
      )
      .max(16),
    reasonCodes: z.array(fundingReasonCodeSchema).max(32),
    evidence: z
      .object({
        facts: z.record(z.string(), z.unknown()),
        checks: z.array(preparationCheckEvidenceSchema).max(32),
      })
      .strict(),
  })
  .strict();

export const positionActionPublicSchema = z
  .object({
    operationId: z.string().uuid(),
    venueId: positionActionVenueSchema,
    action: positionActionKindSchema,
    positionRef: z.string().uuid(),
    ownerBindingId: opaqueIdSchema,
    executionMode: z.enum([
      "web_client",
      "privy_authorization",
      "privy_delegated",
      "venue_relayer",
    ]),
    status: positionActionStatusSchema,
    submissionFingerprint: z.string().nullable(),
    broadcastMayHaveOccurred: z.boolean(),
    receiptStatus: z.enum([
      "unobserved",
      "pending",
      "success",
      "reverted",
      "unknown",
    ]),
    postconditionStatus: z.enum([
      "pending",
      "satisfied",
      "failed",
      "unavailable",
    ]),
    lastErrorCode: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();

export const positionActionInspectResponseSchema = z
  .object({
    ok: z.literal(true),
    readiness: positionActionReadinessSchema,
  })
  .strict();

export const positionActionPrepareResponseSchema = z
  .object({
    ok: z.literal(true),
    operation: positionActionPublicSchema,
    actions: z.array(normalizedActionSchema).max(16),
    replayed: z.boolean(),
  })
  .strict();

export const positionActionOperationResponseSchema = z
  .object({
    ok: z.literal(true),
    operation: positionActionPublicSchema,
  })
  .strict();

export const positionActionSubmissionClaimResponseSchema = z
  .object({
    ok: z.literal(true),
    claimed: z.boolean(),
    attemptNumber: z.number().int().positive().nullable(),
    reason: z.enum(["claimed", "already_broadcast", "terminal"]),
    operation: positionActionPublicSchema,
  })
  .strict();

export const positionActionReconcileResponseSchema = z
  .object({
    ok: z.literal(true),
    result: z
      .object({
        status: z.enum([
          "in_progress",
          "completed",
          "reconcile_required",
          "failed",
        ]),
        submissionFingerprint: z.string().nullable(),
        reasonCodes: z.array(fundingReasonCodeSchema).max(32),
      })
      .strict(),
  })
  .strict();

export const positionActionApiErrorSchema = z
  .object({
    error: z.string(),
    code: z.string(),
  })
  .strict();
