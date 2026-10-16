import { tx, type Pool } from "@hunch/infra";
import { isRecord } from "../../lib/type-guards.js";
import {
  commitFundingClassificationTransaction,
  FundingClassificationChangedError,
  lockFundingClassificationOperations,
} from "../persistence/funding-classification-revisions.js";
import { lockFundingReceiveCanonicalEvents } from "../persistence/funding-receive-session-repository.js";
import { fundingPhysicalEventIsBusy } from "../persistence/funding-physical-event-gate.js";
import { prepareReceiveAnchors } from "../receive/prepare-receive-anchors.js";
import type { inspectEvmFundingReceiveAnchor } from "../receive/evm-receive-anchor-proof.js";
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
import {
  readRecordedRelayRefundRoleEvidence,
  refundCanonicalEventKey,
} from "./relay-exact-refund-classification.js";
import {
  applyRelayExactRefundReceiptsInTransaction,
  prepareRelayExactRefundReceipts,
  recordRelayExactRefundReceiptsInTransaction,
  relayExactRefundCanonicalEvents,
  RelayExactRefundSnapshotChanged,
  revalidateRelayExactRefundReceipts,
  type RecordRelayExactRefundInput,
  type RecordRelayExactRefundResult,
} from "./relay-exact-refund-receipts.js";
import { relayExactRefundRoleEvidence } from "./relay-exact-refund-proposal.js";
import { supportsRefundSourceEnvelope } from "./relay-refund-source-candidates.js";

/** Existing job/provider observation, not a new scheduler or financial action.
 * Provider evidence is immutable for this invocation; bounded checkpoint drains
 * reuse the SAME work identity/deadline and never repeat provider requests.
 */
export async function publishRelayExactRefundReceipts(
  pool: Pool,
  input: RecordRelayExactRefundInput & {
    work?: FundingEvidenceWorkContext & Readonly<{ limit: number }>;
    inspectCanonicalAnchor?: typeof inspectEvmFundingReceiveAnchor;
  },
): Promise<RecordRelayExactRefundResult> {
  const pending = (reason: string) => ({ kind: "pending" as const, reason });
  if (
    input.work &&
    (!Number.isFinite(input.work.deadlineMs) ||
      Date.now() >= input.work.deadlineMs)
  )
    return pending("role_work_budget_exhausted");
  try {
    const initial = await prepareRelayExactRefundReceipts(pool, input);
    if (initial.kind !== "prepared") return initial;
    const supported = initial.verification.verified.events.filter(
      supportsRefundSourceEnvelope,
    );
    if (supported.length === 0) {
      // Native/unsupported protocols retain their exact existing contract. Do
      // not invent EVM membership or widen a native ledger key into a session.
      if (!input.work || relayExactRefundCanonicalEvents(initial).length > 0)
        return await tx(pool, (db) =>
          recordRelayExactRefundReceiptsInTransaction(db, input),
        );
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set transaction isolation level read committed");
        const db = fundingEvidenceBudgetClient(client, input.work.deadlineMs);
        await lockFundingClassificationOperations(db, [initial.facts]);
        const result = await recordRelayExactRefundReceiptsInTransaction(
          db,
          input,
        );
        await setFundingEvidenceQueryBudget(client, input.work.deadlineMs);
        await commitFundingClassificationTransaction(client, [initial.facts]);
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    if (supported.length !== initial.verification.verified.events.length)
      return pending("refund_mixed_role_envelopes");
    if (!input.work) return pending("role_work_context_pending");
    if (
      (await prepareReceiveAnchors(pool, {
        events: relayExactRefundCanonicalEvents(initial),
        deadlineMs: input.work.deadlineMs,
        inspect: input.inspectCanonicalAnchor,
      })) !== "ready"
    )
      return pending("role_canonical_anchor_pending");
    let progressPages = 0;
    for (;;) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set transaction isolation level read committed");
        const db = fundingEvidenceBudgetClient(client, input.work.deadlineMs);
        const prepared = await prepareRelayExactRefundReceipts(db, input);
        if (prepared.kind !== "prepared") {
          await client.query("commit");
          return prepared;
        }
        const canonicalEvents = relayExactRefundCanonicalEvents(prepared);
        // Full raw E first; no filtering by classification before the lock.
        // Revalidation below MUST NOT discover/acquire another E under O.
        await lockFundingReceiveCanonicalEvents(db, canonicalEvents);
        const byKey = new Map(
          prepared.verification.verified.events.map((event) => [
            refundCanonicalEventKey(event),
            event,
          ]),
        );
        const events = [...byKey.values()];
        const recorded = await readRecordedRelayRefundRoleEvidence(db, {
          userId: prepared.facts.userId,
          events,
        });
        const phase = await readSessionlessRolePublicationPhase(db, {
          operationId: input.operationId,
          userId: prepared.facts.userId,
          events,
          now: input.now,
          work: input.work,
          pageOrdinal: progressPages,
          referenceCodec: input.referenceCodec,
          transactionReferenceCodec: input.transactionReferenceCodec,
          refundEvidence: relayExactRefundRoleEvidence(prepared, recorded),
        });
        if (phase.kind !== "ready") {
          if (phase.kind === "pending" || progressPages >= input.work.limit) {
            await client.query("commit");
            return pending(phase.reason);
          }
          await checkpointSessionlessRolePublicationPhase(db, phase);
          await client.query("commit");
          progressPages++;
          continue;
        }
        for (const event of events) {
          const decision = phase.decisions.get(refundCanonicalEventKey(event));
          if (
            decision?.kind !== "internal_refund" ||
            decision.match.operationId !== input.operationId ||
            decision.match.segmentId !== input.segmentId
          ) {
            await client.query("commit");
            return pending("internal_event_classification_conflict");
          }
        }
        const dependencies = [prepared.facts, ...phase.dependencies];
        await lockFundingClassificationOperations(db, dependencies);
        for (const scan of phase.scans)
          await lockSessionlessFundingRoleMembershipForPublication(db, scan);
        const revalidated = await revalidateRelayExactRefundReceipts(
          db,
          prepared,
        );
        const result = await applyRelayExactRefundReceiptsInTransaction(
          db,
          revalidated,
        );
        await setFundingEvidenceQueryBudget(client, input.work.deadlineMs);
        // Raw final F immediately followed by COMMIT. No budget proxy, IO or
        // diagnostic write between them. A failed fence rolls back ALL effects.
        await commitFundingClassificationTransaction(client, dependencies);
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  } catch (error) {
    // All transactional E/O/U/effects have rolled back before retry is exposed.
    if (error instanceof RelayExactRefundSnapshotChanged)
      return pending(error.reason);
    if (error instanceof FundingClassificationChangedError)
      return pending("candidate_facts_changed");
    if (fundingPhysicalEventIsBusy(error))
      return pending("role_physical_evidence_busy");
    if (
      error instanceof FundingEvidenceBudgetExpiredError ||
      (input.work &&
        Date.now() >= input.work.deadlineMs &&
        isRecord(error) &&
        ["57014", "55P03"].includes(String(error.code)))
    )
      return pending("role_work_budget_exhausted");
    throw error;
  }
}
