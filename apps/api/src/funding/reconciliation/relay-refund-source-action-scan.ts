import type { PoolClient } from "@hunch/infra";
import { z } from "zod";
import { readFundingRefundContract } from "../domain/refund-settlement.js";
import {
  readRefundCompletionPage,
  refundCompletionProgressSchema,
  type RefundCompletionProgress,
} from "./relay-refund-completion-scan.js";
import {
  readRefundObservationPage,
  refundObservationProgressSchema,
  type RefundObservationProgress,
} from "./relay-refund-observation-scan.js";
import {
  FundingClassificationChangedError,
  readFundingClassificationPage,
  readFundingClassificationRevision,
  type FundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";
import {
  loadRefundSourceCandidate,
  matchRefundSourceEnvelope,
  type RefundSourceCandidateIdentity,
} from "./relay-refund-source-candidates.js";
import type { OwnedRouteCanonicalDestinationEvent } from "./owned-route-destination-observer.js";
import { readRefundNativeDestination } from "./relay-refund-destination-settlement.js";
import {
  emptyRefundSourceActionFold,
  assertRefundSourceActionPageLimit,
  finishRefundSourceActions,
  finishRefundSourceAccounting,
  refundSourceDebitIdentitySchema,
  foldRefundSourceActions,
  loadRefundSourceActionFacts,
  type RefundSourceActionCursor,
  type RefundSourceActionExposure,
  type RefundSourceActionFold,
  type RefundSourceAccounting,
} from "./relay-refund-source-actions.js";

const continuationSchema = z
  .object({
    version: z.literal(2),
    identity: z
      .object({
        userId: z.uuid(),
        operationId: z.uuid(),
        segmentId: z.uuid(),
        reservationId: z.uuid(),
      })
      .strict(),
    facts: z
      .object({
        operationId: z.uuid(),
        userId: z.uuid(),
        revision: z
          .string()
          .max(19)
          .refine(
            (value) =>
              value.length <= 19 &&
              /^(0|[1-9]\d*)$/.test(value) &&
              BigInt(value) <= 9223372036854775807n,
          ),
      })
      .strict(),
    cursor: z
      .object({
        stepOrdinal: z.number().int().min(0).max(2147483647),
        attemptNumber: z.number().int().min(0).max(2147483647),
      })
      .strict(),
    fold: z
      .object({
        invalid: z.boolean(),
        depositStepId: z.uuid().nullable(),
        possible: z.boolean(),
        debit: refundSourceDebitIdentitySchema.nullable(),
        unaccounted: z.boolean(),
      })
      .strict()
      .refine((fold) =>
        fold.invalid
          ? fold.depositStepId === null &&
            !fold.possible &&
            fold.debit === null &&
            fold.unaccounted
          : ((!fold.possible && !fold.debit) || fold.depositStepId !== null) &&
            (!fold.debit || fold.possible) &&
            (!fold.possible || fold.debit !== null || fold.unaccounted),
      ),
  })
  .strict();

const completedSchema = z
  .object({
    kind: z.literal("complete"),
    version: z.literal(2),
    identity: continuationSchema.shape.identity,
    facts: continuationSchema.shape.facts,
    exposure: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("invalid") }).strict(),
      z.object({ kind: z.literal("no_live_attempt") }).strict(),
      z
        .object({
          kind: z.literal("possible"),
          stepIds: z.array(z.uuid()).length(1),
        })
        .strict(),
    ]),
    accounting: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("unaccounted") }).strict(),
      z
        .object({
          kind: z.literal("single_debit"),
          debit: refundSourceDebitIdentitySchema,
        })
        .strict(),
    ]),
    refundSet: refundCompletionProgressSchema.default({ kind: "unchecked" }),
    observationVersion: z.union([z.literal(0), z.literal(1)]).default(0),
    observations: refundObservationProgressSchema.default({
      kind: "unchecked",
    }),
  })
  .strict()
  .refine(
    (result) =>
      (result.accounting.kind === "single_debit" ||
        result.refundSet.kind === "unchecked") &&
      (result.observations.kind === "unchecked" ||
        result.accounting.kind === "none" ||
        (result.accounting.kind === "single_debit" &&
          (result.refundSet.kind === "complete_refund_set" ||
            (result.refundSet.kind === "pending" &&
              result.refundSet.reason === "no_current_receipts")))) &&
      (result.observations.kind !== "empty" ||
        result.accounting.kind === "none") &&
      (result.observations.kind !== "refunded" ||
        result.refundSet.kind === "complete_refund_set") &&
      (result.observations.kind !== "delivered" ||
        (result.refundSet.kind === "pending" &&
          result.refundSet.reason === "no_current_receipts")) &&
      (result.accounting.kind === "unaccounted" ||
        (result.accounting.kind === "none"
          ? result.exposure.kind === "no_live_attempt"
          : result.exposure.kind === "possible")),
  );

/** Decode stored derived facts without silently upgrading an old observation
 * contract. Publication must wait for the normal reader's bounded upgrade. */
export function parseCompletedRefundSourceActionResult(value: unknown) {
  const parsed = completedSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Internal derived continuation only: no raw provider/transaction payload and
 * constant size even for dense attempt history. Persist only under the existing
 * canonical-event lease/CAS. This is NOT a client-supplied or signed proof. */
export type RefundSourceActionContinuation = Readonly<{
  version: 2;
  identity: RefundSourceCandidateIdentity;
  facts: FundingClassificationRevision;
  cursor: RefundSourceActionCursor;
  fold: RefundSourceActionFold;
}>;

export function parseRefundSourceActionContinuation(
  value: unknown,
): RefundSourceActionContinuation | null {
  const result = continuationSchema.safeParse(value);
  return result.success ? result.data : null;
}

export type RefundSourceActionPageResult =
  | Readonly<{ kind: "restart" | "unavailable" }>
  | Readonly<{
      kind: "continuation";
      continuation: RefundSourceActionContinuation;
    }>
  | Readonly<{
      kind: "complete";
      version: 2;
      identity: RefundSourceCandidateIdentity;
      facts: FundingClassificationRevision;
      exposure: RefundSourceActionExposure;
      accounting: RefundSourceAccounting;
      refundSet: RefundCompletionProgress;
      observationVersion: 1;
      observations: RefundObservationProgress;
    }>;

/** One bounded DB-only pass, not a looping worker or allocation authority.
 * Every pass rehydrates the source and actions between the same revision
 * checks. A change restarts only this candidate, never unrelated enumeration.
 * Completion still needs exact source debit/settlement, source membership and
 * the full role publication fence. In particular no_live_attempt != external. */
export async function readRefundSourceActionPage(
  db: Pick<PoolClient, "query">,
  input: {
    identity: RefundSourceCandidateIdentity;
    continuation: unknown;
    completed?: unknown;
    limit: number;
    event?: OwnedRouteCanonicalDestinationEvent;
  },
): Promise<RefundSourceActionPageResult> {
  assertRefundSourceActionPageLimit(input.limit);
  const previous = parseRefundSourceActionContinuation(input.continuation);
  if (input.continuation !== null && !previous) return { kind: "restart" };
  const saved = completedSchema.safeParse(input.completed);
  const completed = saved.success
    ? {
        ...saved.data,
        observationVersion: 1 as const,
        // Recheck only this derived component after a semantics upgrade. Keep
        // valid source/action/refund pages; a formerly pending result must not
        // permanently hide the new successful-delivery proof at the same revision.
        observations:
          saved.data.observationVersion === 1
            ? saved.data.observations
            : { kind: "unchecked" as const },
      }
    : null;
  if (input.completed != null && (!completed || previous))
    return { kind: "restart" };
  const identity = input.identity;
  const checkpoint = previous ?? completed;
  if (
    checkpoint &&
    (checkpoint.identity.userId !== identity.userId ||
      checkpoint.identity.operationId !== identity.operationId ||
      checkpoint.identity.segmentId !== identity.segmentId ||
      checkpoint.identity.reservationId !== identity.reservationId ||
      checkpoint.facts.userId !== identity.userId ||
      checkpoint.facts.operationId !== identity.operationId)
  )
    return { kind: "restart" };
  const facts =
    checkpoint?.facts ??
    (await readFundingClassificationRevision(db, {
      operationId: identity.operationId,
      userId: identity.userId,
    }));
  if (!facts) return { kind: "unavailable" };
  try {
    return await readFundingClassificationPage(db, facts, async (client) => {
      const candidate = await loadRefundSourceCandidate(client, identity);
      if (!candidate) return { kind: "unavailable" } as const;
      if (
        input.event &&
        matchRefundSourceEnvelope(identity.userId, input.event, candidate)
          .kind !== "candidate"
      )
        return { kind: "unavailable" } as const;
      // Completed pages also participate in fair revision/envelope checks.
      // Read at most ONE action/refund page per visit. A complete action scan
      // is not settlement: current refund membership is checked at exactly the
      // same facts revision, under the same restart guard. Old v2 results start
      // unchecked rather than inheriting a positive refund verdict.
      if (completed) {
        if (
          completed.accounting.kind === "none" ||
          (completed.accounting.kind === "single_debit" &&
            (completed.refundSet.kind === "complete_refund_set" ||
              (completed.refundSet.kind === "pending" &&
                completed.refundSet.reason === "no_current_receipts")))
        ) {
          return {
            ...completed,
            observations: await readRefundObservationPage(client, {
              operationId: identity.operationId,
              segmentId: identity.segmentId,
              accounting: completed.accounting,
              refundSet: completed.refundSet,
              destination: readRefundNativeDestination({
                userId: identity.userId,
                operationSourceSnapshot: candidate.operation_source_snapshot,
                destination: candidate.destination_target_snapshot,
                minimum: candidate.quoted_min_output,
              }),
              progress: completed.observations,
              limit: input.limit,
            }),
          };
        }
        if (completed.accounting.kind !== "single_debit") return completed;
        const contract = readFundingRefundContract(
          candidate.refund_location_snapshot,
          {
            requestFingerprint: candidate.provider_quote_ref_lookup_hmac,
            lookupKeyVersion: candidate.lookup_key_version,
          },
        );
        const refundSet = contract
          ? await readRefundCompletionPage(client, {
              operationId: identity.operationId,
              segmentId: identity.segmentId,
              contract,
              progress: completed.refundSet,
              limit: input.limit,
            })
          : { kind: "pending" as const, reason: "invalid_receipt" as const };
        return { ...completed, refundSet };
      }
      const page = await loadRefundSourceActionFacts(client, {
        candidate,
        cursor: previous?.cursor ?? null,
        limit: input.limit,
      });
      const fold = foldRefundSourceActions(
        candidate,
        previous?.fold ?? emptyRefundSourceActionFold(),
        page.rows,
      );
      if (page.nextCursor)
        return {
          kind: "continuation",
          continuation: {
            version: 2,
            identity,
            facts,
            cursor: page.nextCursor,
            fold,
          },
        } as const;
      return {
        kind: "complete",
        version: 2,
        identity,
        facts,
        exposure: finishRefundSourceActions(fold, { complete: true }),
        accounting: finishRefundSourceAccounting(fold),
        refundSet: { kind: "unchecked" },
        observationVersion: 1,
        observations: { kind: "unchecked" },
      } as const;
    });
  } catch (error) {
    if (error instanceof FundingClassificationChangedError)
      return { kind: "restart" };
    throw error;
  }
}
