import { FundingReceiveSessionObserver } from "../receive/receive-session-observer.js";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import { RECEIVE_CLASSIFICATION_RETRY_REASONS } from "../persistence/funding-receive-session-repository.js";
import type { FundingEvidenceWorkContext } from "../reconciliation/funding-reducer.js";

/** Explicit offline job lease/budget, not production publication authority. */
export function ownedRefundRoleWorkFixture(limit = 50): {
  work: FundingEvidenceWorkContext & { limit: number };
} {
  return {
    work: {
      progressToken: randomUUID(),
      deadlineMs: Date.now() + 30_000,
      limit,
    },
  };
}

/** Scope fixture-specific retry assertions without rewriting queue authority.
 * The REAL production claimant skips other retained synthetic rows while one
 * connection holds their E locks. Global fairness has separate timed coverage.
 */
export async function withCanonicalRetryFixtureQueue<T>(
  pool: Pool,
  input: { sessionId: string; through: Date },
  run: () => Promise<T>,
): Promise<T> {
  const isolation = await pool.connect();
  try {
    await isolation.query("begin");
    const otherEvents = await isolation.query(
      `select id from funding_receive_canonical_events
      where classification_receive_session_id is distinct from $1::uuid and allocation_status='recovery_required'
        and allocation_error_code=any($2::text[])
        and coalesce(classification_retry_at,first_observed_at)<=$3::timestamptz
      order by id limit 1000 for update`,
      [input.sessionId, RECEIVE_CLASSIFICATION_RETRY_REASONS, input.through],
    );
    assert.ok(
      otherEvents.rowCount !== null && otherEvents.rowCount < 1000,
      "bounded isolated fixture queue",
    );
    return await run();
  } finally {
    await isolation.query("rollback");
    isolation.release();
  }
}
import { receiveRoleEventFingerprint } from "../receive/receive-role-progress.js";
import type { inspectEvmFundingReceiveAnchor } from "../receive/evm-receive-anchor-proof.js";
import {
  fundingReceiveClassificationRetryTarget,
  lockBoundFundingReceiveClassificationRetry,
} from "../persistence/funding-receive-session-repository.js";
import { parseDirectIngressObservationVariant } from "../reconciliation/direct-ingress-observer.js";
import { loadCanonicalPolymarketHandoffClassifications } from "../receive/receive-handoff-classification.js";
import { resolveLegacyRecordedReceiveRoles } from "../receive/receive-event-classification.js";
import { classifyOwnedRouteCanonicalDestinationEvents } from "../reconciliation/owned-route-destination-observer.js";
import {
  classifyRecordedRelayExactRefundEvents,
  refundCanonicalEventKey,
} from "../reconciliation/relay-exact-refund-classification.js";

/** Existing effect/precedence fixtures intentionally inject synthetic roles,
 * not persisted financial facts. Keep that test boundary explicit now that the
 * production observer uses joint arbitration. This helper does NOT test source
 * completeness or operation fences; real-authority PG tests do that separately.
 */
export const syntheticCanonicalAnchor: typeof inspectEvmFundingReceiveAnchor =
  async ({ expected }) => ({
    kind: "canonical",
    eventFingerprint: receiveRoleEventFingerprint(expected),
  });

export function recordedRoleObserverFixture(
  dependencies: ConstructorParameters<
    typeof FundingReceiveSessionObserver
  >[0] = {},
): FundingReceiveSessionObserver {
  return new FundingReceiveSessionObserver({
    inspectCanonicalAnchor: syntheticCanonicalAnchor,
    ...dependencies,
    readRoleArbitration: async (db, input) => {
      const retry = await lockBoundFundingReceiveClassificationRetry(db, input);
      if (!retry)
        return { kind: "incomplete", reason: "candidate_context_changed" };
      const target = await fundingReceiveClassificationRetryTarget(db, retry);
      if (!target)
        return { kind: "incomplete", reason: "candidate_context_changed" };
      const variant = target.observationStartVariants
        .map(parseDirectIngressObservationVariant)
        .find((entry) => entry.variantId === target.event.variantId);
      if (!variant || !target.event.sourceAddress)
        return { kind: "incomplete", reason: "candidate_context_changed" };
      const event = {
        ...target.event,
        variant,
        blockNumber: target.event.ledgerHeight,
        sourceAddress: target.event.sourceAddress,
        observedAt: target.event.observedAt.toISOString(),
      };
      const handoffs = await loadCanonicalPolymarketHandoffClassifications(db, {
        userId: input.userId,
        events: [event],
        now: new Date(),
        transactionReferenceCodec: dependencies.transactionReferenceCodec,
        listPotentialPolymarketHandoffs:
          dependencies.listPotentialPolymarketHandoffs,
      });
      const refunds = await (
        dependencies.classifyRecordedRefunds ??
        classifyRecordedRelayExactRefundEvents
      )(db, {
        userId: input.userId,
        events: [target.event],
      });
      const destinations = dependencies.relayReferenceCodec
        ? await (
            dependencies.classifyOwnedRouteDestinations ??
            classifyOwnedRouteCanonicalDestinationEvents
          )(db, {
            userId: input.userId,
            events: [target.event],
            referenceCodec: dependencies.relayReferenceCodec,
          })
        : new Map();
      const key = refundCanonicalEventKey(target.event);
      return {
        kind: "ready_for_fence",
        classification: resolveLegacyRecordedReceiveRoles({
          handoff: handoffs.get(key),
          destination: destinations.get(key),
          refund: refunds.get(key),
        }),
        dependencies: [],
      };
    },
  });
}
