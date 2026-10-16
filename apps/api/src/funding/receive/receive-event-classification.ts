import type { OwnedRouteCanonicalDestinationClassification } from "../reconciliation/owned-route-destination-observer.js";
import type { RecordedExactRefundClassification } from "../reconciliation/relay-exact-refund-classification.js";
import type { PolymarketHandoffEventClassification } from "./receive-handoff-classification.js";

type HandoffDecision =
  | Readonly<{ kind: "external" }>
  | Readonly<{ kind: "recovery_required"; reason: string }>
  | Readonly<{
      kind: "internal";
      reference: "exact";
      operationId: string;
      attemptId: string;
    }>;
type RefundDecision =
  | Exclude<RecordedExactRefundClassification, { kind: "unmatched" }>
  | Readonly<{ kind: "external" }>
  | Readonly<{
      kind: "recovery_required";
      reason: "exact_refund_correlation_pending";
    }>;

export type ReceiveEventClassification =
  | Readonly<{ kind: "external" }>
  | Readonly<{ kind: "recovery_required"; reason: string }>
  | Readonly<{
      kind: "internal_handoff";
      match: Extract<HandoffDecision, { kind: "internal" }>;
    }>
  | Readonly<{
      kind: "internal_destination";
      match: Extract<
        OwnedRouteCanonicalDestinationClassification,
        { kind: "internal" }
      >;
    }>
  | Readonly<{
      kind: "internal_refund";
      match: Extract<RecordedExactRefundClassification, { kind: "internal" }>;
    }>;

/** Shared role arbitration, not proof of externality for an unexamined role.
 * The current receive path can use this for handoff/destination while exact
 * refund source enumeration is still being integrated. No first-match winner.
 */
export function receiveInternalRolesConflict(
  decisions: readonly Readonly<{ kind: string }>[],
): boolean {
  const internals = decisions.filter(
    (decision) => decision.kind === "internal",
  );
  return (
    internals.length > 1 ||
    (internals.length > 0 &&
      decisions.some((decision) => decision.kind === "recovery_required"))
  );
}

/** Compatibility adapter for the CURRENT recorded-role receive path only.
 * Preserve its recovery precedence while sharing publication effects with the
 * joint arbiter's typed decisions. A recorded miss here does NOT prove source
 * coverage: new exact-refund discovery must not use this adapter as authority.
 */
export function resolveLegacyRecordedReceiveRoles(input: {
  handoff?: PolymarketHandoffEventClassification;
  destination?: OwnedRouteCanonicalDestinationClassification;
  refund?: RecordedExactRefundClassification;
}): ReceiveEventClassification {
  const { handoff, destination, refund } = input;
  if (
    receiveInternalRolesConflict([
      handoff ?? { kind: "external" },
      destination ?? { kind: "external" },
      refund ?? { kind: "unmatched" },
    ])
  )
    return {
      kind: "recovery_required",
      reason: "internal_event_classification_conflict",
    };
  if (refund?.kind === "recovery_required") return refund;
  if (handoff?.kind === "recovery_required") return handoff;
  if (handoff?.kind === "internal")
    return { kind: "internal_handoff", match: handoff };
  if (refund?.kind === "internal")
    return { kind: "internal_refund", match: refund };
  if (destination?.kind === "recovery_required") return destination;
  if (destination?.kind === "internal")
    return { kind: "internal_destination", match: destination };
  return { kind: "external" };
}

/** Resolve all roles BEFORE mutating any receive/funding allocation. A recorded
 * refund lookup returning unmatched is deliberately not an accepted input: the
 * pending source-action pass must finish before it can claim externality. */
export function resolveReceiveEventClassification(input: {
  handoff: HandoffDecision;
  destination: OwnedRouteCanonicalDestinationClassification;
  refund: RefundDecision;
}): ReceiveEventClassification {
  const decisions = [input.handoff, input.destination, input.refund];
  const pending = decisions.find(
    (decision) => decision.kind === "recovery_required",
  );
  if (receiveInternalRolesConflict(decisions))
    return {
      kind: "recovery_required",
      reason: "internal_event_classification_conflict",
    };
  if (pending?.kind === "recovery_required")
    return {
      kind: "recovery_required",
      reason: pending.reason ?? "internal_event_classification_conflict",
    };
  if (input.handoff.kind === "internal")
    return input.handoff.reference === "exact"
      ? { kind: "internal_handoff", match: input.handoff }
      : {
          kind: "recovery_required",
          reason: "internal_event_classification_conflict",
        };
  if (input.destination.kind === "internal")
    return { kind: "internal_destination", match: input.destination };
  if (input.refund.kind === "internal")
    return { kind: "internal_refund", match: input.refund };
  return decisions.every((decision) => decision.kind === "external")
    ? { kind: "external" }
    : {
        kind: "recovery_required",
        reason: "internal_event_classification_conflict",
      };
}
