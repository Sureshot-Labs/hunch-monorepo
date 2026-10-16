import type { PoolClient } from "@hunch/infra";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";
import {
  mapFundingHandoffCandidate,
  type FundingPolymarketHandoffCandidateDbRow,
} from "../persistence/funding-evidence-repository.js";
import {
  FundingClassificationChangedError,
  type FundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";
import type {
  OwnedRouteCanonicalDestinationEvent,
  OwnedRouteCanonicalDestinationClassification,
} from "../reconciliation/owned-route-destination-observer.js";
import { supportsRefundSourceEnvelope } from "../reconciliation/relay-refund-source-candidates.js";
import { assertRefundSourceActionPageLimit } from "../reconciliation/relay-refund-source-actions.js";
import {
  classifyPolymarketHandoffEvents,
  type PolymarketHandoffEventClassification,
} from "./receive-handoff-classification.js";
import { receiveRoleEventFingerprint } from "./receive-role-progress.js";
import { receiveHandoffReferenceContext } from "./receive-handoff-action-scan.js";
import { immutableReceiveDestinationMatches } from "./receive-role-membership.js";
import {
  receiveDestinationHeaderColumns,
  receiveDestinationReferenceContext,
  readReceiveDestinationActionPage,
  type DestinationActionProgress,
  type ReceiveDestinationHeaderRow,
} from "./receive-destination-action-scan.js";

/** Exact indexed references only. The lifetime envelope lane is already covered
 * by the durable source/action scan. Do not copy its 256-candidate overflow cap:
 * all exact witnesses (including negative ones) must participate in the fence.
 * Neither current status nor action validity may remove a witness before its
 * revision is captured in this same statement. */
export const RECEIVE_EXACT_HANDOFF_EVIDENCE_SQL = `with exact_attempt as materialized (
  select attempt_row.id from funding_operation_step_attempts attempt_row
  where attempt_row.receipt_ref_lookup_hmac=$3::text
    and attempt_row.lookup_key_version=$4::integer and attempt_row.reference_kind='transaction'
  union
  select receipt_row.attempt_id from funding_step_receipt_observations receipt_row
  where receipt_row.network_id=$2::text
    and receipt_row.evidence->>'transactionHash' ~ '^0x[0-9a-fA-F]{64}$'
    and lower(receipt_row.evidence->>'transactionHash')=$5::text
)
select step.operation_id,step.id as step_id,attempt.id as attempt_id,
  attempt.outcome as attempt_outcome,attempt.reference_kind,
  attempt.receipt_ref_ciphertext,attempt.receipt_ref_lookup_hmac,attempt.lookup_key_version,
  step.normalized_action,step.action_validation_result,
  operation_row.user_id,coalesce(revision_row.revision,0)::text as classification_revision,
  (step.normalized_action->>'kind'='external_handoff' and
    step.normalized_action->>'handoffKind' in
      ('polymarket_deposit_wallet_transfer','polymarket_safe_transfer')) as handoff_candidate,
  case when receipt.evidence->>'transactionHash' ~ '^0x[0-9a-fA-F]{64}$'
    then lower(receipt.evidence->>'transactionHash') else null end as resolved_transaction_hash,
  case when receipt.status in ('confirmed','finalized') and receipt.canonical and receipt.action_match
    and receipt.failure_code is null
    and receipt.evidence->>'transactionHash' ~ '^0x[0-9a-fA-F]{64}$'
    and receipt.evidence->>'handoffEventIndex' ~ '^(0|[1-9][0-9]*)$'
    then receipt.evidence->>'handoffEventIndex' else null end as resolved_event_index
from exact_attempt
cross join lateral(select * from funding_operation_step_attempts attempt_row
  where attempt_row.id=exact_attempt.id offset 0) attempt
cross join lateral(select * from funding_operation_steps step_row
  where step_row.id=attempt.step_id offset 0) step
cross join lateral(select id,user_id from funding_operations
  where id=step.operation_id offset 0) operation_row
left join funding_classification_revisions revision_row on revision_row.operation_id=operation_row.id
left join lateral(select * from funding_step_receipt_observations receipt_row
  where receipt_row.attempt_id=attempt.id limit 1) receipt on true
where operation_row.user_id=$1::uuid`;

/** Probe the same retained/legacy GIN indexes as ordinary destination reads,
 * but keep witnesses before mutable provider-status filtering. An old numeric
 * HMAC entry is an index hint only; the shared text predicate still decides. */
export const RECEIVE_EXACT_DESTINATION_EVIDENCE_SQL = `with exact_segment as materialized (
  select segment_row.id from funding_operation_segments segment_row
  where segment_row.provider_id='relay'
    and coalesce(segment_row.support_metadata->'relaySuccessfulDestinationReferenceHashesV1','[]'::jsonb)
      @> jsonb_build_array($2::text)
  union
  select segment_row.id from funding_operation_segments segment_row
  where segment_row.provider_id='relay'
    and (case when jsonb_typeof(segment_row.support_metadata->'relayTransactionReferenceFingerprints')='array'
      then segment_row.support_metadata->'relayTransactionReferenceFingerprints' else '[]'::jsonb end
      @> jsonb_build_array($3::text)
      or ($3::text ~ '^[0-9]{1,192}$' and
        case when jsonb_typeof(segment_row.support_metadata->'relayTransactionReferenceFingerprints')='array'
          then segment_row.support_metadata->'relayTransactionReferenceFingerprints' else '[]'::jsonb end
        @> jsonb_build_array(case when $3::text ~ '^[0-9]{1,192}$' then $3::numeric end)))
)
select ${receiveDestinationHeaderColumns("$2::text", "$3::text")},
  operation_row.id as operation_id,coalesce(revision_row.revision,0)::text as classification_revision
from exact_segment
cross join lateral(select * from funding_operation_segments exact_row
  where exact_row.id=exact_segment.id offset 0) segment_row
cross join lateral(select * from funding_operations
  where id=segment_row.operation_id offset 0) operation_row
left join funding_classification_revisions revision_row on revision_row.operation_id=operation_row.id
where operation_row.user_id=$1::uuid`;

export const receiveDestinationRoleKey = (
  operationId: string,
  segmentId: string,
) => `${operationId}:${segmentId}`;

export type ReceiveExactRoleEvidence = Readonly<{
  eventFingerprint: string;
  handoffCodecContext: string;
  destinationCodecContext: string;
  handoff: PolymarketHandoffEventClassification;
  destination: OwnedRouteCanonicalDestinationClassification;
  dependencies: readonly FundingClassificationRevision[];
  /** Caller must persist/resume these under its existing event lease. They are
   * not negative witnesses and must never authorize an external allocation. */
  pendingDestinations: readonly DestinationActionProgress[];
}>;

type FactRow = {
  operation_id: string;
  user_id: string;
  classification_revision: string;
};

/** Complements, not replaces, exhaustive immutable source membership. Queries
 * are scoped to one physical transaction, not user history. Their actual match
 * set is not truncated; resource timeouts roll back/retry the existing event.
 * Facts and payload share a statement snapshot; no fresh revision is grafted
 * onto an older classification. The final all-role fence remains mandatory. */
export async function readReceiveExactRoleEvidence(
  db: Pick<PoolClient, "query">,
  input: {
    userId: string;
    limit: number;
    event: OwnedRouteCanonicalDestinationEvent;
    transactionReferenceCodec: Pick<
      FundingTransactionReferenceCodec,
      "fingerprint" | "keyVersion" | "decrypt"
    >;
    referenceCodec: Pick<RelayReferenceCodec, "fingerprint">;
    destinationProgress?: ReadonlyMap<string, DestinationActionProgress>;
  },
): Promise<ReceiveExactRoleEvidence> {
  assertRefundSourceActionPageLimit(input.limit);
  if (
    !supportsRefundSourceEnvelope(input.event) ||
    input.event.sourceAddress === null
  )
    throw new Error(
      "Exact receive role evidence requires a supported EVM event",
    );
  const event = input.event;
  const handoffContext = receiveHandoffReferenceContext(
    event,
    input.transactionReferenceCodec,
  );
  const destinationContext = receiveDestinationReferenceContext(
    event,
    input.referenceCodec,
  );
  const hmac = handoffContext.fingerprint;
  const destinationFingerprint = destinationContext.fingerprint;
  if (hmac === null || destinationFingerprint === null)
    throw new Error("Exact receive reference codec is unavailable");
  const handoffs = (
    await db.query<
      FundingPolymarketHandoffCandidateDbRow &
        FactRow & { handoff_candidate: boolean }
    >(RECEIVE_EXACT_HANDOFF_EVIDENCE_SQL, [
      input.userId,
      event.networkId,
      hmac,
      input.transactionReferenceCodec.keyVersion,
      event.transactionHash.toLowerCase(),
    ])
  ).rows;
  const destinations = (
    await db.query<ReceiveDestinationHeaderRow & FactRow>(
      RECEIVE_EXACT_DESTINATION_EVIDENCE_SQL,
      [
        input.userId,
        relayDestinationReferenceIdentity(event.transactionHash),
        destinationFingerprint,
      ],
    )
  ).rows;
  const dependencies = [...handoffs, ...destinations].map((row) => ({
    operationId: row.operation_id,
    userId: row.user_id,
    revision: row.classification_revision,
  }));
  const handoffEvent = {
    ...event,
    sourceAddress: input.event.sourceAddress,
    variant: { networkId: event.networkId, asset: event.asset },
  };
  const handoff = classifyPolymarketHandoffEvents(
    [{ event: handoffEvent, receiptRefLookupHmac: hmac }],
    handoffs
      .filter((row) => row.handoff_candidate)
      .map(mapFundingHandoffCandidate),
    input.transactionReferenceCodec,
    { eventSubset: true },
  ).get([event.networkId, event.transactionHash, event.eventIndex].join(":"));
  if (!handoff) throw new Error("Exact handoff classification is missing");
  const exact = destinations.filter(
    (row): row is typeof row & { segment_id: string } =>
      row.segment_id !== null &&
      row.exact_reference &&
      immutableReceiveDestinationMatches(input.userId, event, row),
  );
  let possible = false;
  const pendingDestinations: DestinationActionProgress[] = [];
  // An exact destination already wins over possibles under the common venue
  // classifier. Negative exact witnesses still stay in dependencies above.
  if (exact.length === 0)
    for (const row of destinations) {
      if (
        !row.segment_id ||
        !immutableReceiveDestinationMatches(input.userId, event, row) ||
        row.destination_known ||
        ["ready", "completed", "refunded", "failed", "cancelled"].includes(
          row.operation_status,
        )
      )
        continue;
      if (row.source_may_be_moving) {
        possible = true;
        continue;
      }
      let progress = input.destinationProgress?.get(
        receiveDestinationRoleKey(row.operation_id, row.segment_id),
      );
      if (progress?.kind !== "complete") {
        const page = await readReceiveDestinationActionPage(db, {
          userId: input.userId,
          operationId: row.operation_id,
          segmentId: row.segment_id,
          event,
          progress,
          limit: input.limit,
          referenceCodec: input.referenceCodec,
        });
        if ("facts" in page) progress = page;
        else throw new FundingClassificationChangedError();
      }
      {
        if (
          progress.referenceRetryRequired ||
          progress.facts.userId !== input.userId ||
          progress.facts.operationId !== row.operation_id ||
          progress.segmentId !== row.segment_id ||
          progress.facts.revision !== row.classification_revision ||
          progress.eventFingerprint !== receiveRoleEventFingerprint(event) ||
          progress.codecContext !== destinationContext.codecContext
        )
          throw new FundingClassificationChangedError();
        if (progress.kind === "continuation")
          pendingDestinations.push(progress);
        possible ||= progress.sourceMayBeMoving;
      }
    }
  const destination: OwnedRouteCanonicalDestinationClassification =
    exact.length > 1
      ? {
          kind: "recovery_required",
          reason: "owned_route_destination_ambiguous",
        }
      : exact[0]
        ? {
            kind: "internal",
            operationId: exact[0].operation_id,
            segmentId: exact[0].segment_id,
            transactionReferenceFingerprint: destinationFingerprint,
          }
        : possible || pendingDestinations.length > 0
          ? {
              kind: "recovery_required",
              reason: "owned_route_destination_correlation_pending",
            }
          : { kind: "external" };
  return {
    eventFingerprint: receiveRoleEventFingerprint(event),
    handoffCodecContext: handoffContext.codecContext,
    destinationCodecContext: destinationContext.codecContext,
    handoff,
    destination,
    dependencies,
    pendingDestinations,
  };
}
