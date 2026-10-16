import type { PoolClient } from "@hunch/infra";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import {
  fundingClassificationRevisionsAreCurrent,
  type FundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../reconciliation/owned-route-destination-observer.js";
import type { FundingEvidenceWorkContext } from "../reconciliation/funding-reducer.js";
import { fundingEvidencePageToken } from "../reconciliation/funding-evidence-budget.js";
import { supportsRefundSourceEnvelope } from "../reconciliation/relay-refund-source-candidates.js";
import { refundCanonicalEventKey } from "../reconciliation/relay-exact-refund-classification.js";
import {
  readSessionlessFundingRoleArbitrationInTransaction,
  advanceSessionlessFundingRoleScanInTransaction,
  checkpointSessionlessFundingRoleArbitrationInTransaction,
  readProtectedRefundRoleArbitrationInTransaction,
  advanceProtectedRefundRoleScanInTransaction,
  checkpointProtectedRefundRoleArbitrationInTransaction,
  type SessionlessFundingRoleScanInput,
  type ProtectedRefundRoleScanInput,
} from "./receive-refund-scan.js";
import type { ProtectedRecordedRefundRoleProof } from "../reconciliation/relay-owned-refund-ownership.js";
import type { ReceiveEventClassification } from "./receive-event-classification.js";
import type { ReceiveRefundRoleEvidence } from "./receive-role-arbitration.js";
import { receiveRoleEventFingerprint } from "./receive-role-progress.js";

export type SessionlessRolePublicationPhase =
  | Readonly<{ kind: "pending"; reason: string }>
  | Readonly<{
      kind: "checkpoint";
      reason: string;
      scan: SessionlessFundingRoleScanInput & {
        refundEvidence?: ReceiveRefundRoleEvidence;
        protectedRefundProof?: ProtectedRecordedRefundRoleProof;
      };
    }>
  | Readonly<{
      kind: "ready";
      decisions: ReadonlyMap<string, ReceiveEventClassification>;
      dependencies: readonly FundingClassificationRevision[];
      scans: readonly SessionlessFundingRoleScanInput[];
    }>;

/** Pure role phase AFTER the caller prelocks its ENTIRE raw E footprint, and
 * BEFORE any O/U/effects. No transaction ownership, new scheduler or generic
 * alreadyLocked escape. Native/unsupported paths retain their existing reader.
 */
export async function readSessionlessRolePublicationPhase(
  db: PoolClient,
  input: {
    operationId: string;
    userId: string;
    events: readonly OwnedRouteCanonicalDestinationEvent[];
    now: Date;
    work?: FundingEvidenceWorkContext & Readonly<{ limit: number }>;
    pageOrdinal: number;
    referenceCodec: Pick<RelayReferenceCodec, "fingerprint">;
    transactionReferenceCodec?: Pick<
      FundingTransactionReferenceCodec,
      "fingerprint" | "keyVersion" | "decrypt"
    >;
    refundEvidence?: ReadonlyMap<string, ReceiveRefundRoleEvidence>;
    protectedRefundProofs?: ReadonlyMap<
      string,
      ProtectedRecordedRefundRoleProof
    >;
  },
): Promise<SessionlessRolePublicationPhase> {
  const decisions = new Map<string, ReceiveEventClassification>();
  const dependencies: FundingClassificationRevision[] = [];
  const scans: SessionlessFundingRoleScanInput[] = [];
  for (const event of input.events) {
    if (!supportsRefundSourceEnvelope(event)) continue;
    if (!input.work)
      return { kind: "pending", reason: "role_work_context_pending" };
    if (event.ledgerHeight === null || event.blockHash === null)
      throw Error("role_canonical_proof_missing");
    const key = refundCanonicalEventKey(event);
    const scan: SessionlessFundingRoleScanInput & {
      refundEvidence?: ReceiveRefundRoleEvidence;
      protectedRefundProof?: ProtectedRecordedRefundRoleProof;
    } = {
      operationId: input.operationId,
      userId: input.userId,
      event: {
        ...event,
        ledgerHeight: event.ledgerHeight,
        blockHash: event.blockHash,
        now: input.now,
      },
      limit: input.work.limit,
      progressToken: fundingEvidencePageToken({
        progressToken: input.work.progressToken,
        eventFingerprint: receiveRoleEventFingerprint(event),
        pageOrdinal: input.pageOrdinal,
      }),
      referenceCodec: input.referenceCodec,
      transactionReferenceCodec: input.transactionReferenceCodec,
      ...(input.refundEvidence?.has(key)
        ? { refundEvidence: input.refundEvidence.get(key) }
        : {}),
      ...(input.protectedRefundProofs?.has(key)
        ? { protectedRefundProof: input.protectedRefundProofs.get(key) }
        : {}),
    };
    const decision = scan.protectedRefundProof
      ? await readProtectedRefundRoleArbitrationInTransaction(
          db,
          scan as ProtectedRefundRoleScanInput,
        )
      : await readSessionlessFundingRoleArbitrationInTransaction(db, scan);
    const stale =
      decision.kind === "ready_for_fence" &&
      !(await fundingClassificationRevisionsAreCurrent(
        db,
        decision.dependencies,
      ));
    if (
      decision.kind === "incomplete" ||
      decision.classification.kind === "recovery_required" ||
      stale
    ) {
      const reason = stale
        ? "candidate_facts_changed"
        : decision.kind === "incomplete"
          ? decision.reason
          : decision.classification.kind === "recovery_required"
            ? decision.classification.reason
            : "role_evidence_pending";
      return { kind: "checkpoint", scan, reason };
    }
    scans.push(scan);
    decisions.set(key, decision.classification);
    dependencies.push(...decision.dependencies);
  }
  return { kind: "ready", decisions, dependencies, scans };
}

/** Derived branch ONLY: full E -> U NOWAIT -> bounded page/checkpoint. Caller
 * MUST commit immediately and start a fresh transaction before any O/effects,
 * regardless of whether the checkpoint's final read now happens to be ready. */
export async function checkpointSessionlessRolePublicationPhase(
  db: PoolClient,
  phase: Extract<SessionlessRolePublicationPhase, { kind: "checkpoint" }>,
): Promise<void> {
  if (phase.scan.protectedRefundProof) {
    const scan = phase.scan as ProtectedRefundRoleScanInput;
    await advanceProtectedRefundRoleScanInTransaction(db, scan);
    await checkpointProtectedRefundRoleArbitrationInTransaction(db, scan);
    return;
  }
  await advanceSessionlessFundingRoleScanInTransaction(db, phase.scan);
  await checkpointSessionlessFundingRoleArbitrationInTransaction(
    db,
    phase.scan,
  );
}
