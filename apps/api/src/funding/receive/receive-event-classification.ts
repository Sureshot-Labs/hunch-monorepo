import type { OwnedRouteCanonicalDestinationClassification } from "../reconciliation/owned-route-destination-observer.js";
import type { RecordedExactRefundClassification } from "../reconciliation/relay-exact-refund-classification.js";

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
