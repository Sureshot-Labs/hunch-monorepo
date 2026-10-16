import type { RecordedRefundRoleEvidence } from "./relay-exact-refund-classification.js";
import { refundCanonicalEventKey } from "./relay-exact-refund-classification.js";
import type { PreparedRelayExactRefundReceipts } from "./relay-exact-refund-receipts.js";
import type { ReceiveRefundRoleEvidence } from "../receive/receive-role-arbitration.js";
import { receiveRoleEventFingerprint } from "../receive/receive-role-progress.js";
import type { FundingClassificationRevision } from "../persistence/funding-classification-revisions.js";
import type { OwnedRouteCanonicalDestinationEvent } from "./owned-route-destination-observer.js";

/** The exact verifier can propose the FIRST refund before its own output
 * exists. It cannot replace a recorded owner, conflict, stale envelope or even
 * a negative legacy witness. The latter carries real dependencies, not absence.
 * Missing evidence stays missing; the common arbiter never treats it as external.
 */
export function relayExactRefundRoleEvidence(
  prepared: PreparedRelayExactRefundReceipts,
  recorded: ReadonlyMap<string, RecordedRefundRoleEvidence>,
): ReadonlyMap<string, ReceiveRefundRoleEvidence> {
  return verifiedFirstRelayRefundRoleEvidence(
    {
      events: prepared.verification.verified.events,
      operationId: prepared.input.operationId,
      segmentId: prepared.input.segmentId,
      facts: prepared.facts,
    },
    recorded,
  );
}

/** Business-verifier output only. This common proposal rule deliberately has
 * no recovery/recorded-owner override; those require the protected proof. */
export function verifiedFirstRelayRefundRoleEvidence(
  input: {
    events: readonly OwnedRouteCanonicalDestinationEvent[];
    operationId: string;
    segmentId: string;
    facts: FundingClassificationRevision;
  },
  recorded: ReadonlyMap<string, RecordedRefundRoleEvidence>,
): ReadonlyMap<string, ReceiveRefundRoleEvidence> {
  const evidence = new Map<string, ReceiveRefundRoleEvidence>(recorded);
  for (const event of input.events) {
    const key = refundCanonicalEventKey(event);
    const previous = recorded.get(key);
    const eventFingerprint = receiveRoleEventFingerprint(event);
    if (
      previous?.classification.kind !== "unmatched" ||
      previous.dependencies.length !== 0 ||
      previous.eventFingerprint !== eventFingerprint
    )
      continue;
    evidence.set(key, {
      kind: "verified_proposal",
      eventFingerprint,
      classification: {
        kind: "internal",
        operationId: input.operationId,
        segmentId: input.segmentId,
      },
      dependencies: [input.facts],
    });
  }
  return evidence;
}
