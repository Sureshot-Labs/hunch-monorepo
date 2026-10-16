import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import type { FundingClassificationRevision } from "../persistence/funding-classification-revisions.js";
import type {
  OwnedRouteCanonicalDestinationClassification,
  OwnedRouteCanonicalDestinationEvent,
} from "../reconciliation/owned-route-destination-observer.js";
import type {
  RecordedExactRefundClassification,
  RecordedRefundRoleEvidence,
} from "../reconciliation/relay-exact-refund-classification.js";
import { parseCompletedRefundSourceActionResult } from "../reconciliation/relay-refund-source-action-scan.js";
import {
  handoffActionProgressSchema,
  mergeHandoffPageClassification,
  receiveHandoffReferenceContext,
} from "./receive-handoff-action-scan.js";
import {
  destinationActionProgressSchema,
  receiveDestinationReferenceContext,
  type DestinationActionProgress,
} from "./receive-destination-action-scan.js";
import {
  receiveRoleEventFingerprint,
  receiveRoleProgressBaseSchema,
} from "./receive-role-progress.js";
import {
  resolveReceiveEventClassification,
  type ReceiveEventClassification,
} from "./receive-event-classification.js";
import type { PolymarketHandoffEventClassification } from "./receive-handoff-classification.js";
import {
  receiveDestinationRoleKey,
  type ReceiveExactRoleEvidence,
} from "./receive-exact-role-evidence.js";

/** Captured DB membership, not client input or a list of only positive matches. */
export type ReceiveRoleCandidate = Readonly<{
  reservation_id: string | null;
  operation_id: string;
  segment_id: string | null;
  envelope_kind: "candidate" | "invalid" | "unrelated";
  handoff_possible: boolean;
  destination_possible: boolean;
  action_result: unknown;
  handoff_progress: unknown;
  destination_progress: unknown;
}>;

/** Verified proposals let the refund writer arbitrate BEFORE its first receipt
 * is stored. They must come from that writer's exact proof, never its status or
 * an assumed amount. Recorded misses are not negative source-role evidence. */
export type ReceiveRefundRoleEvidence =
  | RecordedRefundRoleEvidence
  | Readonly<{
      kind: "verified_proposal";
      eventFingerprint: string;
      classification: Extract<
        RecordedExactRefundClassification,
        { kind: "internal" }
      >;
      dependencies: readonly FundingClassificationRevision[];
    }>;

export type ReceiveRoleArbitration =
  | Readonly<{
      kind: "ready_for_fence";
      classification: ReceiveEventClassification;
      dependencies: readonly FundingClassificationRevision[];
    }>
  | Readonly<{
      kind: "incomplete";
      /** Bounded legacy witness pages; publication must preserve and resume
       * these before retry, not repeatedly start an uncaptured history tail. */
      pendingDestinations?: readonly DestinationActionProgress[];
      reason:
        | "source_enumeration_pending"
        | "candidate_identity_invalid"
        | "candidate_facts_pending"
        | "candidate_context_changed"
        | "mixed_facts_revision"
        | "reference_recovery_pending"
        | "refund_evidence_pending";
    }>;

/** Fold compact checked summaries, not history. An optional read-only exact
 * loader reuses checked destination summaries; no transport or financial effects
 * and no new durable layer. The full dependency set includes NEGATIVE decisions and
 * duplicate scans must agree on their revision. This result is not allocation
 * authority: the caller still proves source membership, includes indexed exact
 * fallback witnesses and owns E -> sorted O -> effects -> F -> COMMIT. In
 * particular source enumeration exhaustion is not a commit watermark. */
export async function arbitrateReceiveRoleCandidates(input: {
  userId: string;
  event: OwnedRouteCanonicalDestinationEvent;
  enumerationComplete: boolean;
  candidates:
    | Iterable<ReceiveRoleCandidate>
    | AsyncIterable<ReceiveRoleCandidate>;
  refundEvidence: ReceiveRefundRoleEvidence;
  exactRoleEvidence?: ReceiveExactRoleEvidence;
  loadExactRoleEvidence?: (
    destinations: ReadonlyMap<string, DestinationActionProgress>,
  ) => Promise<ReceiveExactRoleEvidence>;
  transactionReferenceCodec?: Pick<
    FundingTransactionReferenceCodec,
    "fingerprint" | "keyVersion"
  >;
  referenceCodec?: Pick<RelayReferenceCodec, "fingerprint">;
}): Promise<ReceiveRoleArbitration> {
  const incomplete = (
    reason: Extract<ReceiveRoleArbitration, { kind: "incomplete" }>["reason"],
  ): ReceiveRoleArbitration => ({ kind: "incomplete", reason });
  if (!input.enumerationComplete)
    return incomplete("source_enumeration_pending");
  const eventFingerprint = receiveRoleEventFingerprint(input.event);
  if (input.refundEvidence.eventFingerprint !== eventFingerprint)
    return incomplete("candidate_context_changed");
  const dependencies = new Map<string, FundingClassificationRevision>();
  function addFacts(value: FundingClassificationRevision): boolean {
    const parsed = receiveRoleProgressBaseSchema.shape.facts.safeParse(value);
    if (!parsed.success || parsed.data.userId !== input.userId) return false;
    const previous = dependencies.get(value.operationId);
    if (previous && previous.revision !== value.revision) return false;
    dependencies.set(value.operationId, parsed.data);
    return true;
  }
  for (const facts of input.refundEvidence.dependencies)
    if (!addFacts(facts)) return incomplete("mixed_facts_revision");
  const refund = input.refundEvidence.classification;
  if (refund.kind === "internal" && !dependencies.has(refund.operationId))
    return incomplete("refund_evidence_pending");
  const handoffContext = receiveHandoffReferenceContext(
    input.event,
    input.transactionReferenceCodec,
  );
  const destinationContext = receiveDestinationReferenceContext(
    input.event,
    input.referenceCodec,
  );
  let handoff: PolymarketHandoffEventClassification = {
    kind: "external",
    reason: null,
  };
  let exactDestination: { operationId: string; segmentId: string } | null =
    null;
  let ambiguousDestination = false,
    possibleDestination = false,
    pendingRefund = false;
  const checkedDestinations = new Map<string, DestinationActionProgress>();
  function addExactDestination(value: {
    operationId: string;
    segmentId: string;
  }) {
    if (
      exactDestination &&
      (exactDestination.operationId !== value.operationId ||
        exactDestination.segmentId !== value.segmentId)
    )
      ambiguousDestination = true;
    return value;
  }
  for await (const candidate of input.candidates) {
    let exactCandidateDestination = false;
    if (
      candidate.envelope_kind === "unrelated" &&
      !candidate.handoff_possible &&
      !candidate.destination_possible
    )
      return incomplete("candidate_identity_invalid");
    if (candidate.handoff_possible) {
      const decoded = handoffActionProgressSchema.safeParse(
        candidate.handoff_progress,
      );
      if (!decoded.success || decoded.data.kind !== "complete")
        return incomplete("candidate_facts_pending");
      const progress = decoded.data;
      if (
        progress.eventFingerprint !== eventFingerprint ||
        progress.facts.userId !== input.userId ||
        progress.facts.operationId !== candidate.operation_id ||
        progress.codecContext !== handoffContext.codecContext
      )
        return incomplete("candidate_context_changed");
      if (
        progress.referenceRetryRequired ||
        handoffContext.referenceRetryRequired
      )
        return incomplete("reference_recovery_pending");
      if (!addFacts(progress.facts)) return incomplete("mixed_facts_revision");
      handoff = mergeHandoffPageClassification(
        handoff,
        progress.classification,
      );
    }
    if (candidate.destination_possible) {
      const decoded = destinationActionProgressSchema.safeParse(
        candidate.destination_progress,
      );
      if (!decoded.success || decoded.data.kind !== "complete")
        return incomplete("candidate_facts_pending");
      const progress = decoded.data;
      if (
        progress.eventFingerprint !== eventFingerprint ||
        progress.facts.userId !== input.userId ||
        progress.facts.operationId !== candidate.operation_id ||
        progress.segmentId !== candidate.segment_id ||
        progress.codecContext !== destinationContext.codecContext
      )
        return incomplete("candidate_context_changed");
      if (progress.referenceRetryRequired)
        return incomplete("reference_recovery_pending");
      if (!addFacts(progress.facts)) return incomplete("mixed_facts_revision");
      checkedDestinations.set(
        receiveDestinationRoleKey(
          progress.facts.operationId,
          progress.segmentId,
        ),
        progress,
      );
      if (progress.match === "exact") {
        exactCandidateDestination = true;
        exactDestination = addExactDestination({
          operationId: progress.facts.operationId,
          segmentId: progress.segmentId,
        });
      } else if (progress.match === "possible") possibleDestination = true;
    }
    if (candidate.envelope_kind !== "unrelated") {
      if (!candidate.reservation_id)
        return incomplete("candidate_identity_invalid");
      // An exact physical receipt/proposed receipt already proves this event's
      // refund role even when partial. Do not require that very receipt to have
      // completed the entire source operation first. Competing roles and other
      // source legs are still evaluated. The exact reader supplied its facts.
      // The same applies to this leg's exact destination: requiring its first
      // destination_credit to exclude a potential refund would make publication
      // wait on its own output. The validated destination summary keeps its
      // revision; other legs and any positive refund/handoff still arbitrate.
      if (
        exactCandidateDestination ||
        (refund.kind === "internal" &&
          refund.operationId === candidate.operation_id &&
          refund.segmentId === candidate.segment_id)
      )
        continue;
      const result = parseCompletedRefundSourceActionResult(
        candidate.action_result,
      );
      if (!result || result.observationVersion !== 1)
        return incomplete("candidate_facts_pending");
      if (
        result.identity.userId !== input.userId ||
        result.identity.operationId !== candidate.operation_id ||
        result.identity.segmentId !== candidate.segment_id ||
        result.identity.reservationId !== candidate.reservation_id ||
        result.facts.userId !== input.userId ||
        result.facts.operationId !== candidate.operation_id
      )
        return incomplete("candidate_identity_invalid");
      if (!addFacts(result.facts)) return incomplete("mixed_facts_revision");
      const excluded =
        candidate.envelope_kind === "candidate" &&
        ((result.accounting.kind === "none" &&
          result.observations.kind === "empty") ||
          (result.accounting.kind === "single_debit" &&
            ["refunded", "delivered"].includes(result.observations.kind)));
      if (!excluded) pendingRefund = true;
    }
  }
  // Do not perform fallback reads while a normal source page is still pending.
  // Current completed summaries avoid rescanning negative attempt histories.
  const exactEvidence = input.loadExactRoleEvidence
    ? await input.loadExactRoleEvidence(checkedDestinations)
    : input.exactRoleEvidence;
  if (exactEvidence) {
    if (
      exactEvidence.eventFingerprint !== eventFingerprint ||
      exactEvidence.handoffCodecContext !== handoffContext.codecContext ||
      exactEvidence.destinationCodecContext !== destinationContext.codecContext
    )
      return incomplete("candidate_context_changed");
    for (const facts of exactEvidence.dependencies)
      if (!addFacts(facts)) return incomplete("mixed_facts_revision");
    if (exactEvidence.pendingDestinations.length > 0)
      return {
        kind: "incomplete",
        reason: "candidate_facts_pending",
        pendingDestinations: exactEvidence.pendingDestinations,
      };
    if (
      (exactEvidence.handoff.kind === "internal" &&
        !dependencies.has(exactEvidence.handoff.operationId)) ||
      (exactEvidence.destination.kind === "internal" &&
        !dependencies.has(exactEvidence.destination.operationId))
    )
      return incomplete("candidate_facts_pending");
    handoff = mergeHandoffPageClassification(handoff, exactEvidence.handoff);
    if (exactEvidence.destination.kind === "internal")
      exactDestination = addExactDestination(exactEvidence.destination);
    else if (exactEvidence.destination.kind === "recovery_required") {
      ambiguousDestination ||=
        exactEvidence.destination.reason ===
        "owned_route_destination_ambiguous";
      possibleDestination ||=
        exactEvidence.destination.reason ===
        "owned_route_destination_correlation_pending";
    }
  }
  let destination: OwnedRouteCanonicalDestinationClassification = {
    kind: "external",
  };
  if (ambiguousDestination)
    destination = {
      kind: "recovery_required",
      reason: "owned_route_destination_ambiguous",
    };
  else if (exactDestination) {
    if (destinationContext.fingerprint === null)
      return incomplete("reference_recovery_pending");
    destination = {
      kind: "internal",
      ...exactDestination,
      transactionReferenceFingerprint: destinationContext.fingerprint,
    };
  } else if (possibleDestination)
    destination = {
      kind: "recovery_required",
      reason: "owned_route_destination_correlation_pending",
    };
  // A verified positive cannot erase another unresolved source leg. All other
  // cross-role conflicts retain the existing common arbitration semantics.
  const classification =
    pendingRefund && refund.kind === "internal"
      ? {
          kind: "recovery_required" as const,
          reason: "internal_event_classification_conflict",
        }
      : resolveReceiveEventClassification({
          handoff,
          destination,
          refund:
            refund.kind === "unmatched"
              ? pendingRefund
                ? {
                    kind: "recovery_required",
                    reason: "exact_refund_correlation_pending",
                  }
                : { kind: "external" }
              : refund,
        });
  return {
    kind: "ready_for_fence",
    classification,
    dependencies: [...dependencies.values()].sort((a, b) =>
      a.operationId.localeCompare(b.operationId),
    ),
  };
}
