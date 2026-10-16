import type { PoolClient } from "@hunch/infra";
import { z } from "zod";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import {
  FundingClassificationChangedError,
  readFundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";
import { listFundingHandoffOperationPage } from "../persistence/funding-evidence-repository.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../reconciliation/owned-route-destination-observer.js";
import { assertRefundSourceActionPageLimit } from "../reconciliation/relay-refund-source-actions.js";
import { supportsRefundSourceEnvelope } from "../reconciliation/relay-refund-source-candidates.js";
import {
  classifyPolymarketHandoffEvents,
  type PolymarketHandoffEventClassification,
} from "./receive-handoff-classification.js";
import {
  receiveRoleEventFingerprint,
  receiveRoleProgressBaseSchema,
} from "./receive-role-progress.js";
import { canonicalJsonHash } from "../persistence/canonical.js";

export const handoffActionProgressSchema = receiveRoleProgressBaseSchema
  .extend({
    role: z.literal("handoff"),
    codecContext: z.string().regex(/^[0-9a-f]{64}$/),
    referenceRetryRequired: z.boolean(),
    classification: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("external"), reason: z.null() }).strict(),
      z
        .object({
          kind: z.literal("recovery_required"),
          reason: z.string().min(1).max(128),
        })
        .strict(),
      z
        .object({
          kind: z.literal("internal"),
          reason: z.null(),
          reference: z.literal("exact"),
          operationId: z.uuid(),
          attemptId: z.uuid(),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine((value) => (value.kind === "complete") === (value.cursor === null))
  .refine(
    (value) =>
      value.classification.kind !== "internal" ||
      value.classification.operationId === value.facts.operationId,
  );
export type HandoffActionProgress = z.infer<typeof handoffActionProgressSchema>;

export function receiveHandoffReferenceContext(
  event: OwnedRouteCanonicalDestinationEvent,
  codec?: Pick<FundingTransactionReferenceCodec, "fingerprint" | "keyVersion">,
) {
  let fingerprint: string | null = null;
  let referenceRetryRequired = false;
  try {
    fingerprint =
      codec?.fingerprint(event.transactionHash.toLowerCase()) ?? null;
  } catch {
    referenceRetryRequired = true;
  }
  return {
    fingerprint,
    referenceRetryRequired,
    codecContext: canonicalJsonHash({
      // Invalidate pre-fix singleton summaries through the ordinary restart
      // path; no persisted envelope-mismatch may survive changed semantics.
      contract: "event_subset_v1",
      available: !!codec,
      keyVersion: codec?.keyVersion ?? null,
      fingerprint,
    }),
  };
}

/** One event's page fold. A hash-only relation is already pending in the shared
 * classifier; only exact log proof can be internal. A second distinct attempt
 * cannot overwrite the first. Duplicate operation scans merge by exact identity.
 */
export function mergeHandoffPageClassification(
  previous: PolymarketHandoffEventClassification,
  next: PolymarketHandoffEventClassification,
): PolymarketHandoffEventClassification {
  if (
    previous.kind === "recovery_required" ||
    next.kind === "recovery_required"
  ) {
    const recoveries = [previous, next].filter(
      (
        value,
      ): value is Extract<
        PolymarketHandoffEventClassification,
        { kind: "recovery_required" }
      > => value.kind === "recovery_required",
    );
    // Match whole-set classification: a pending candidate makes an otherwise
    // exact ambiguity retryable. Page boundaries must not disable recovery.
    return (
      recoveries.find(
        (value) =>
          ![
            "handoff_candidate_ambiguity",
            "handoff_correlation_pending",
          ].includes(value.reason),
      ) ??
      recoveries.find(
        (value) => value.reason === "handoff_correlation_pending",
      ) ??
      recoveries[0]
    );
  }
  if (previous.kind === "external") return next;
  if (next.kind === "external") return previous;
  return previous.operationId === next.operationId &&
    previous.attemptId === next.attemptId
    ? previous
    : { kind: "recovery_required", reason: "handoff_candidate_ambiguity" };
}

/** One existing-worker-budget page; no provider IO or financial effects. A
 * complete negative result retains its facts revision, and is never external
 * allocation authority without the final all-role publication fence.
 */
export async function readReceiveHandoffActionPage(
  db: Pick<PoolClient, "query">,
  input: {
    userId: string;
    operationId: string;
    event: OwnedRouteCanonicalDestinationEvent;
    progress: unknown;
    limit: number;
    transactionReferenceCodec?: Pick<
      FundingTransactionReferenceCodec,
      "fingerprint" | "keyVersion" | "decrypt"
    >;
  },
): Promise<HandoffActionProgress | { kind: "restart" | "unavailable" }> {
  assertRefundSourceActionPageLimit(input.limit);
  if (!supportsRefundSourceEnvelope(input.event))
    return { kind: "unavailable" };
  const parsed = handoffActionProgressSchema.safeParse(input.progress);
  if (input.progress != null && !parsed.success) return { kind: "restart" };
  let previous = parsed.success ? parsed.data : null;
  const eventFingerprint = receiveRoleEventFingerprint(input.event);
  const context = receiveHandoffReferenceContext(
    input.event,
    input.transactionReferenceCodec,
  );
  const { fingerprint, codecContext } = context;
  let referenceRetryRequired = context.referenceRetryRequired;
  if (
    previous &&
    (previous.eventFingerprint !== eventFingerprint ||
      previous.facts.userId !== input.userId ||
      previous.facts.operationId !== input.operationId)
  )
    return { kind: "restart" };
  const facts = await readFundingClassificationRevision(db, {
    userId: input.userId,
    operationId: input.operationId,
  });
  if (!facts) return { kind: "unavailable" };
  if (previous && previous.facts.revision !== facts.revision)
    return { kind: "restart" };
  // A key/config change need not write funding facts. Transient decrypt failure
  // can also recover with the SAME key version, so a completed failed-reference
  // pass is re-read, not cached forever. Continuations remain bounded and finish
  // their pass before retrying; no arbitrary cooldown or all-history query.
  if (
    previous &&
    (previous.codecContext !== codecContext ||
      (previous.kind === "complete" && previous.referenceRetryRequired))
  )
    previous = null;
  if (previous?.kind === "complete") return previous;
  try {
    const page = await listFundingHandoffOperationPage(db, {
      facts,
      cursor: previous?.cursor ?? null,
      limit: input.limit,
    });
    const event = {
      ...input.event,
      variant: { networkId: input.event.networkId, asset: input.event.asset },
      sourceAddress: input.event.sourceAddress ?? "",
    };
    const codec = input.transactionReferenceCodec;
    if (
      !codec &&
      page.candidates.some(
        (candidate) =>
          !candidate.resolvedTransactionHash && candidate.receiptRefCiphertext,
      )
    )
      referenceRetryRequired = true;
    const classification = classifyPolymarketHandoffEvents(
      [{ event, receiptRefLookupHmac: fingerprint }],
      page.candidates,
      codec
        ? {
            decrypt(ciphertext: string) {
              try {
                return codec.decrypt(ciphertext);
              } catch (error) {
                referenceRetryRequired = true;
                throw error;
              }
            },
          }
        : null,
      { eventSubset: true },
    ).get(
      [event.variant.networkId, event.transactionHash, event.eventIndex].join(
        ":",
      ),
    );
    if (!classification) return { kind: "unavailable" };
    return {
      version: 1,
      role: "handoff",
      kind: page.nextCursor ? "continuation" : "complete",
      facts,
      eventFingerprint,
      cursor: page.nextCursor,
      codecContext,
      referenceRetryRequired:
        referenceRetryRequired || (previous?.referenceRetryRequired ?? false),
      classification: mergeHandoffPageClassification(
        previous?.classification ?? { kind: "external", reason: null },
        classification,
      ),
    };
  } catch (error) {
    if (error instanceof FundingClassificationChangedError)
      return { kind: "restart" };
    throw error;
  }
}
