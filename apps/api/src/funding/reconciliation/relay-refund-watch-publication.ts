import type { Pool } from "@hunch/infra";
import { isRecord } from "../../lib/type-guards.js";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import {
  commitFundingClassificationTransaction,
  FundingClassificationChangedError,
  lockFundingClassificationOperations,
} from "../persistence/funding-classification-revisions.js";
import { fundingPhysicalEventIsBusy } from "../persistence/funding-physical-event-gate.js";
import { lockSessionlessFundingRoleMembershipForPublication } from "../receive/receive-refund-scan.js";
import {
  checkpointSessionlessRolePublicationPhase,
  readSessionlessRolePublicationPhase,
} from "../receive/receive-role-publication-phase.js";
import {
  fundingEvidenceBudgetClient,
  FundingEvidenceBudgetExpiredError,
  setFundingEvidenceQueryBudget,
} from "./funding-evidence-budget.js";
import type { FundingEvidenceWorkContext } from "./funding-reducer.js";
import { refundCanonicalEventKey } from "./relay-exact-refund-classification.js";
import {
  prelockOwnedRefundEvents,
  readProtectedRecordedRefundRoleProof,
  recordedRefundRoleEvent,
} from "./relay-owned-refund-ownership.js";
import type { RefundCanonicalProof } from "./relay-refund-canonical-proof.js";
import { restoreArbitratedRefundCanonicalProof } from "./relay-refund-watch-effects.js";
import {
  refundWatchFacts,
  type RefundWatchRow,
} from "./relay-refund-watch-context.js";

export type RefundWatchPublicationWork = Readonly<{
  work: FundingEvidenceWorkContext & { limit: number };
  referenceCodec: Pick<RelayReferenceCodec, "fingerprint">;
  transactionReferenceCodec?: Pick<
    FundingTransactionReferenceCodec,
    "fingerprint" | "keyVersion" | "decrypt"
  >;
}>;
class RefundWatchPublicationChanged extends Error {}

/** One immutable chain proof and captured post-protection snapshot. Every
 * checkpoint is a separate E/U transaction; the next attempt reconstructs its
 * protected proof under fresh E locks. No RPC, scheduler or cooldown here. */
export async function publishRefundCanonicalRestoration(
  pool: Pool,
  input: {
    operationId: string;
    row: RefundWatchRow;
    now: Date;
    canonical: Extract<RefundCanonicalProof, { kind: "canonical" }>;
    publication?: RefundWatchPublicationWork;
  },
): Promise<{ changed: boolean; reason: string | null }> {
  const pending = (reason: string) => ({ changed: false, reason });
  const publication = input.publication;
  if (!publication) return pending("role_work_context_pending");
  const previous = recordedRefundRoleEvent(
    input.row.receipt_snapshot,
    input.now,
  );
  if (!previous || !input.canonical.ledgerHeight || !input.canonical.blockHash)
    return pending("refund_watch_invalid_recorded_envelope");
  const incoming = {
    ...previous,
    ledgerHeight: input.canonical.ledgerHeight,
    blockHash: input.canonical.blockHash.toLowerCase(),
  };
  const expected = JSON.parse(input.row.receipt_snapshot);
  const facts = refundWatchFacts(input.row, input.operationId);
  let progressPages = 0;
  try {
    for (;;) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set transaction isolation level read committed");
        const db = fundingEvidenceBudgetClient(
          client,
          publication.work.deadlineMs,
        );
        const physical = await prelockOwnedRefundEvents(db, previous, incoming);
        const proof = await readProtectedRecordedRefundRoleProof(db, {
          locked: physical,
          receiptSnapshot: input.row.receipt_snapshot,
          operationId: input.operationId,
          segmentId: expected.segment_id,
          facts,
        });
        if (!proof) {
          await client.query("commit");
          return pending("refund_watch_recorded_proof_pending");
        }
        const eventKey = refundCanonicalEventKey(incoming);
        const phase = await readSessionlessRolePublicationPhase(db, {
          operationId: input.operationId,
          userId: input.row.user_id,
          events: [incoming],
          now: input.now,
          work: publication.work,
          pageOrdinal: progressPages,
          referenceCodec: publication.referenceCodec,
          transactionReferenceCodec: publication.transactionReferenceCodec,
          refundEvidence: new Map([[eventKey, proof.refundEvidence]]),
          protectedRefundProofs: new Map([[eventKey, proof]]),
        });
        if (phase.kind !== "ready") {
          if (
            phase.kind === "pending" ||
            progressPages >= publication.work.limit
          ) {
            await client.query("commit");
            return pending(phase.reason);
          }
          await checkpointSessionlessRolePublicationPhase(db, phase);
          await client.query("commit");
          progressPages++;
          continue;
        }
        const classification = phase.decisions.get(eventKey);
        if (
          classification?.kind !== "internal_refund" ||
          classification.match.operationId !== input.operationId ||
          classification.match.segmentId !== expected.segment_id
        ) {
          await client.query("commit");
          return pending("internal_event_classification_conflict");
        }
        const dependencies = [facts, ...phase.dependencies];
        await lockFundingClassificationOperations(db, dependencies);
        for (const scan of phase.scans)
          await lockSessionlessFundingRoleMembershipForPublication(db, scan);
        if (
          !(await restoreArbitratedRefundCanonicalProof(db, {
            ...input,
            physical,
            proof,
            classification,
          }))
        )
          throw new RefundWatchPublicationChanged();
        await setFundingEvidenceQueryBudget(
          client,
          publication.work.deadlineMs,
        );
        // RAW original F followed immediately by COMMIT. Never cursor writes
        // after U or a budget-proxy statement between this fence and COMMIT.
        await commitFundingClassificationTransaction(client, dependencies);
        return { changed: true, reason: null };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  } catch (error) {
    if (
      error instanceof FundingClassificationChangedError ||
      error instanceof RefundWatchPublicationChanged
    )
      return pending("refund_watch_snapshot_changed");
    if (fundingPhysicalEventIsBusy(error))
      return pending("role_physical_evidence_busy");
    if (
      error instanceof FundingEvidenceBudgetExpiredError ||
      (Date.now() >= publication.work.deadlineMs &&
        isRecord(error) &&
        ["57014", "55P03"].includes(String(error.code)))
    )
      return pending("role_work_budget_exhausted");
    throw error;
  }
}
