import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { isRecord } from "../../lib/type-guards.js";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import type {
  AssetRef,
  FundingPurpose,
  JsonValue,
  Money,
} from "../domain/types.js";
import {
  isPositiveRawAmount,
  parsePositiveRawAmount,
} from "../domain/raw-amount.js";
import type { FundingOperationState } from "../domain/transitions.js";
import { sameAccountAddress } from "../domain/asset-identity.js";
import {
  deriveFundingLifecycle,
  type FundingLifecycleFacts,
} from "../lifecycle/funding-lifecycle-projector.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import {
  allocateFundingObservationInTransaction,
  FundingPersistenceError,
  wakeFundingReconciliationInTransaction,
} from "../persistence/funding-operation-repository.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { sameAsset } from "../planner/money.js";
import { observeOwnedWalletAssetBalance } from "./owned-wallet-asset-balance.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
const OWNED_ROUTE_DESTINATION_OBSERVER_ID =
  "relay_owned_destination_observation_v1";

export type OwnedRouteDestinationTarget = Readonly<{
  operationId: string;
  providerSegments: readonly Readonly<{
    segmentId: string;
    ordinal: number;
    asset: AssetRef;
    expectedRaw: string;
    minimumRaw: string;
    providerRawStatus: string;
    providerStatusCategory?: string;
    providerDestinationReferenceCount: number;
    transactionReferenceFingerprints?: readonly string[];
  }>[];
  destinationReceipts?: readonly Readonly<{
    receiptId: string;
    receiveSessionId: string;
    networkId: string;
    assetId: string;
    assetDecimals: number;
    destinationAddress: string;
    rawAmount: string;
    txHash: string;
    eventIndex: string;
    ledgerHeight: string;
    blockHash: string;
    observedAt: string;
  }>[];
  userId: string;
  purpose: FundingPurpose;
  marketId: string | null;
  venueBindingOptionId: string;
  destinationLocationId: string;
  destinationAddress: string;
  asset: AssetRef;
  requestedRaw: string;
  observationThresholdRaw: string;
  baselineRaw: string;
  baselineRevision: string;
  operationVersion: number;
  operationState: FundingOperationState;
}>;

export type OwnedRouteDestinationObservation = Readonly<{
  observedRaw: string;
  revision: string;
  observedAt: string;
}>;

export type OwnedRouteCanonicalDestinationEvent = Readonly<{
  networkId: string;
  asset: AssetRef;
  destinationAddress: string;
  sourceAddress: string | null;
  rawAmount: string;
  transactionHash: string;
  eventIndex: string;
  ledgerHeight: string;
  blockHash: string;
  observedAt: Date;
}>;

export type OwnedRouteCanonicalDestinationClassification =
  | Readonly<{ kind: "external" }>
  | Readonly<{
      kind: "internal";
      operationId: string;
      segmentId: string;
      transactionReferenceFingerprint: string;
    }>
  | Readonly<{
      kind: "recovery_required";
      reason:
        | "owned_route_destination_ambiguous"
        | "owned_route_destination_correlation_pending";
    }>;

type OwnedRouteCanonicalDestinationCandidateRow = {
  event_identity: string;
  match_kind: "exact" | "possible";
  operation_id: string;
  segment_id: string;
};

function canonicalDestinationEventIdentity(
  event: OwnedRouteCanonicalDestinationEvent,
): string {
  return [event.networkId, event.transactionHash, event.eventIndex].join(":");
}

/**
 * Correlate chain transfers to Relay destinations before receive-session
 * allocation. Provider references identify the transaction; the frozen route
 * envelope (user, asset and destination) prevents a reference from claiming a
 * transfer for another operation.
 */
export async function classifyOwnedRouteCanonicalDestinationEvents(
  db: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    events: readonly OwnedRouteCanonicalDestinationEvent[];
    referenceCodec: Pick<RelayReferenceCodec, "fingerprint">;
  }>,
): Promise<ReadonlyMap<string, OwnedRouteCanonicalDestinationClassification>> {
  const lookups = input.events.map((event) => ({
    identity: canonicalDestinationEventIdentity(event),
    networkId: event.networkId,
    assetId: event.asset.assetId,
    assetDecimals: event.asset.decimals,
    destinationAddress: event.destinationAddress,
    rawAmount: event.rawAmount,
    transactionReferenceFingerprint: input.referenceCodec.fingerprint(
      event.transactionHash,
    ),
  }));
  const classifications = new Map<
    string,
    OwnedRouteCanonicalDestinationClassification
  >(
    input.events.map((event) => [
      canonicalDestinationEventIdentity(event),
      { kind: "external" },
    ]),
  );
  if (lookups.length === 0) return classifications;
  const { rows } = await db.query<OwnedRouteCanonicalDestinationCandidateRow>(
    `
      with candidate_event as (
        select value as event
        from jsonb_array_elements($2::jsonb)
      ),
      candidate_route as (
        select
          candidate.event ->> 'identity' as event_identity,
          operation.id as operation_id,
          segment.id as segment_id,
          operation.status as operation_status,
          (
            coalesce(segment.support_metadata ->>
              'originTransactionReferenceCount', '0') ~ '^[1-9][0-9]*$'
            or exists (
              select 1
              from funding_operation_steps source_step
              join funding_operation_step_attempts source_attempt
                on source_attempt.step_id = source_step.id
              where source_step.operation_id = operation.id
                and source_step.segment_id = segment.id
                and (source_attempt.broadcast_may_have_occurred
                     or source_attempt.outcome = 'started')
            )
          ) as source_may_be_moving,
          (segment.raw_status = 'success'
            and segment.support_metadata ->> 'relayStatusCategory' =
                  'provider_success'
            and coalesce(segment.support_metadata ->>
                  'destinationTransactionReferenceCount', '0') ~ '^[1-9][0-9]*$'
          ) as destination_known,
          case
            when segment.raw_status = 'success'
             and segment.support_metadata ->> 'relayStatusCategory' =
                   'provider_success'
             and case
                   when coalesce(
                          segment.support_metadata ->>
                            'destinationTransactionReferenceCount',
                          ''
                        ) ~ '^[0-9]+$'
                     then (
                       segment.support_metadata ->>
                         'destinationTransactionReferenceCount'
                     )::integer
                   else 0
                 end > 0
             and exists (
                   select 1
                   from jsonb_array_elements_text(
                     case
                       when jsonb_typeof(
                              segment.support_metadata ->
                                'relayTransactionReferenceFingerprints'
                            ) = 'array'
                         then segment.support_metadata ->
                                'relayTransactionReferenceFingerprints'
                       else '[]'::jsonb
                     end
                   ) as fingerprint(reference_value)
                   where fingerprint.reference_value =
                         candidate.event ->>
                           'transactionReferenceFingerprint'
                 )
              then 'exact'
            else 'possible'
          end as match_kind
        from candidate_event candidate
        join funding_operations operation
         on operation.user_id = $1::uuid
         and operation.plan_kind in ('wallet_route', 'composite_route')
         and operation.destination_target_snapshot #>>
               '{location,asset,networkId}' =
               candidate.event ->> 'networkId'
         and operation.destination_target_snapshot #>>
               '{location,asset,decimals}' =
               candidate.event ->> 'assetDecimals'
         and funding_account_identifier_equal(
               candidate.event ->> 'networkId',
               operation.destination_target_snapshot #>>
                 '{location,asset,assetId}',
               candidate.event ->> 'assetId'
             )
         and funding_account_identifier_equal(
               candidate.event ->> 'networkId',
               operation.destination_target_snapshot #>>
                 '{location,details,address}',
               candidate.event ->> 'destinationAddress'
             )
        join funding_operation_segments segment
          on segment.operation_id = operation.id
         and segment.provider_id = 'relay'
         and segment.quoted_min_output #>> '{asset,networkId}' =
               candidate.event ->> 'networkId'
         and segment.quoted_min_output #>> '{asset,decimals}' =
               candidate.event ->> 'assetDecimals'
         and funding_account_identifier_equal(
               candidate.event ->> 'networkId',
               segment.quoted_min_output #>> '{asset,assetId}',
               candidate.event ->> 'assetId'
             )
      ),
      eligible_candidate as (
        select *
        from candidate_route
        where match_kind = 'exact'
           or (
             not coalesce(destination_known, false)
             and source_may_be_moving
             and operation_status not in (
               'ready', 'completed', 'refunded', 'failed', 'cancelled'
             )
           )
      ),
      ranked_candidate as (
        select
          event_identity,
          operation_id,
          segment_id,
          match_kind,
          row_number() over (
            partition by event_identity, match_kind
            order by operation_id, segment_id
          ) as candidate_rank
        from eligible_candidate
      )
      select event_identity, operation_id, segment_id, match_kind
      from ranked_candidate
      where candidate_rank <= 2
      order by event_identity, match_kind, candidate_rank
    `,
    [input.userId, JSON.stringify(lookups)],
  );
  const candidatesByEvent = new Map<
    string,
    OwnedRouteCanonicalDestinationCandidateRow[]
  >();
  for (const row of rows) {
    const candidates = candidatesByEvent.get(row.event_identity) ?? [];
    candidates.push(row);
    candidatesByEvent.set(row.event_identity, candidates);
  }
  for (const lookup of lookups) {
    const candidates = candidatesByEvent.get(lookup.identity) ?? [];
    const exactCandidates = candidates.filter(
      (candidate) => candidate.match_kind === "exact",
    );
    if (exactCandidates.length > 1) {
      classifications.set(lookup.identity, {
        kind: "recovery_required",
        reason: "owned_route_destination_ambiguous",
      });
      continue;
    }
    const exactCandidate = exactCandidates[0];
    if (exactCandidate) {
      classifications.set(lookup.identity, {
        kind: "internal",
        operationId: exactCandidate.operation_id,
        segmentId: exactCandidate.segment_id,
        transactionReferenceFingerprint: lookup.transactionReferenceFingerprint,
      });
      continue;
    }
    if (candidates.some((candidate) => candidate.match_kind === "possible")) {
      classifications.set(lookup.identity, {
        kind: "recovery_required",
        reason: "owned_route_destination_correlation_pending",
      });
    }
  }
  return classifications;
}

export async function recordOwnedRouteCanonicalDestinationCredit(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    event: OwnedRouteCanonicalDestinationEvent;
    match: Extract<
      OwnedRouteCanonicalDestinationClassification,
      { kind: "internal" }
    >;
    now: Date;
  }>,
): Promise<void> {
  await allocateFundingObservationInTransaction(client, {
    operationId: input.match.operationId,
    segmentId: input.match.segmentId,
    kind: "destination_credit",
    networkId: input.event.networkId,
    assetId: input.event.asset.assetId,
    assetDecimals: input.event.asset.decimals,
    txHash: input.event.transactionHash,
    eventIndex: input.event.eventIndex,
    fromAddress: input.event.sourceAddress,
    toAddress: input.event.destinationAddress,
    rawAmount: input.event.rawAmount,
    observedAt: input.event.observedAt,
    ledgerHeight: input.event.ledgerHeight,
    blockHash: input.event.blockHash,
    finalityStatus: "finalized",
    finalizedAt: input.now,
    metadata: {
      observerId: OWNED_ROUTE_DESTINATION_OBSERVER_ID,
      relayTransactionReferenceMatched: true,
      relayTransactionReferenceFingerprint:
        input.match.transactionReferenceFingerprint,
      canonicalReceiveEventSuppressed: true,
    },
  });
  await wakeFundingReconciliationInTransaction(client, {
    operationId: input.match.operationId,
    dueAt: input.now,
    priority: 10,
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      `owned route destination evidence lacks ${field}`,
    );
  }
  return value;
}

function parseAsset(value: unknown): AssetRef {
  if (
    !isRecord(value) ||
    typeof value.networkId !== "string" ||
    typeof value.assetId !== "string" ||
    typeof value.decimals !== "number"
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "owned route destination asset is invalid",
    );
  }
  return {
    networkId: value.networkId,
    assetId: value.assetId,
    decimals: value.decimals,
  };
}

function nonNegativeCount(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  }
  return 0;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function preparationContribution(
  operationSupportMetadata: JsonRecord,
): Money | null {
  if (operationSupportMetadata.containsVenuePreparation !== true) return null;
  const minimum = operationSupportMetadata.venuePreparationMinimumDestination;
  if (!isRecord(minimum)) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "composite preparation contribution is not frozen",
    );
  }
  const raw = requiredString(
    minimum.raw,
    "venuePreparationMinimumDestination.raw",
  );
  if (!isPositiveRawAmount(raw)) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "composite preparation contribution is not positive",
    );
  }
  return {
    asset: parseAsset(minimum.asset),
    raw,
  };
}

function parseProviderSegments(
  value: unknown,
): OwnedRouteDestinationTarget["providerSegments"] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "owned route destination has no provider segments",
    );
  }
  return value.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.segmentId !== "string" ||
      typeof entry.ordinal !== "number" ||
      entry.ordinal !== index ||
      !isRecord(entry.expectedOutput) ||
      !isRecord(entry.minimumOutput)
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "owned route destination provider segments are not canonical",
      );
    }
    const expectedRaw = requiredString(
      entry.expectedOutput.raw,
      "providerSegments.expectedOutput.raw",
    );
    const minimumRaw = requiredString(
      entry.minimumOutput.raw,
      "providerSegments.minimumOutput.raw",
    );
    const expectedAmount = parsePositiveRawAmount(expectedRaw);
    const minimumAmount = parsePositiveRawAmount(minimumRaw);
    if (
      expectedAmount == null ||
      minimumAmount == null ||
      expectedAmount < minimumAmount
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "owned route destination provider economics are invalid",
      );
    }
    const expectedAsset = parseAsset(entry.expectedOutput.asset);
    const minimumAsset = parseAsset(entry.minimumOutput.asset);
    if (!sameAsset(expectedAsset, minimumAsset)) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "owned route destination provider assets differ",
      );
    }
    return {
      segmentId: entry.segmentId,
      ordinal: entry.ordinal,
      asset: expectedAsset,
      expectedRaw,
      minimumRaw,
      providerRawStatus:
        typeof entry.rawStatus === "string" ? entry.rawStatus : "pending",
      providerStatusCategory:
        typeof entry.relayStatusCategory === "string"
          ? entry.relayStatusCategory
          : "pending",
      providerDestinationReferenceCount: nonNegativeCount(
        entry.destinationTransactionReferenceCount,
      ),
      transactionReferenceFingerprints: stringArray(
        entry.transactionReferenceFingerprints,
      ),
    };
  });
}

type CompetingProviderSegment = Readonly<{
  destinationReferenceCount: number;
  originReferenceCount: number;
  providerStatusCategory: string | null;
  providerUpdatedAt: Date | null;
  rawStatus: string | null;
}>;

function dateFromEpochMilliseconds(value: unknown): Date | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value)
        ? Number(value)
        : null;
  if (numeric === null || !Number.isFinite(numeric)) return null;
  const parsed = new Date(numeric);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function competingProviderSegments(
  value: unknown,
): readonly CompetingProviderSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    return [
      {
        destinationReferenceCount: nonNegativeCount(
          entry.destinationTransactionReferenceCount,
        ),
        originReferenceCount: nonNegativeCount(
          entry.originTransactionReferenceCount,
        ),
        providerStatusCategory:
          typeof entry.relayStatusCategory === "string"
            ? entry.relayStatusCategory
            : null,
        providerUpdatedAt: dateFromEpochMilliseconds(entry.providerUpdatedAt),
        rawStatus: typeof entry.rawStatus === "string" ? entry.rawStatus : null,
      },
    ];
  });
}

function hasFinalEvidenceAfter(
  facts: FundingLifecycleFacts,
  kind: FundingLifecycleFacts["transfers"][number]["kind"],
  baselineAsOf: Date | null,
): boolean {
  return (
    baselineAsOf !== null &&
    facts.transfers.some(
      (transfer) =>
        transfer.kind === kind &&
        transfer.canonical &&
        transfer.finality === "finalized" &&
        transfer.observedAt > baselineAsOf,
    )
  );
}

function hasFinalEvidenceAtOrBefore(
  facts: FundingLifecycleFacts,
  kind: FundingLifecycleFacts["transfers"][number]["kind"],
  baselineAsOf: Date | null,
): boolean {
  return (
    baselineAsOf !== null &&
    facts.transfers.some(
      (transfer) =>
        transfer.kind === kind &&
        transfer.canonical &&
        transfer.finality === "finalized" &&
        transfer.observedAt <= baselineAsOf,
    )
  );
}

function providerReportedDestinationAfterBaseline(
  segments: readonly CompetingProviderSegment[],
  baselineAsOf: Date | null,
): boolean {
  return segments.some(
    (segment) =>
      segment.rawStatus === "success" &&
      segment.providerStatusCategory === "provider_success" &&
      segment.destinationReferenceCount >= 1 &&
      segment.providerUpdatedAt !== null &&
      baselineAsOf !== null &&
      segment.providerUpdatedAt > baselineAsOf,
  );
}

function providerReportsMovement(
  segments: readonly CompetingProviderSegment[],
): boolean {
  return segments.some(
    (segment) =>
      segment.originReferenceCount >= 1 ||
      segment.destinationReferenceCount >= 1,
  );
}

async function hasCompetingDestinationRoute(
  db: Pick<Pool, "query">,
  input: Readonly<{
    baselineAsOf: Date | null;
    currentOperationId: string;
    currentProviderSegments: OwnedRouteDestinationTarget["providerSegments"];
    destinationLocationId: string;
    now: Date;
    userId: string;
  }>,
): Promise<boolean> {
  const { rows } = await db.query<{
    operation_id: string;
    provider_segments: unknown;
    support_metadata: JsonRecord;
  }>(
    `select competing_operation.id as operation_id,
            competing_operation.support_metadata,
            coalesce(
              jsonb_agg(
                jsonb_build_object(
                  'rawStatus', competing_segment.raw_status,
                  'relayStatusCategory',
                    competing_segment.support_metadata ->> 'relayStatusCategory',
                  'originTransactionReferenceCount',
                    competing_segment.support_metadata
                      -> 'originTransactionReferenceCount',
                  'destinationTransactionReferenceCount',
                    competing_segment.support_metadata
                      -> 'destinationTransactionReferenceCount',
                  'providerUpdatedAt',
                    competing_segment.support_metadata -> 'providerUpdatedAt'
                )
                order by competing_segment.ordinal
              ) filter (where competing_segment.id is not null),
              '[]'::jsonb
            ) as provider_segments
       from funding_operations competing_operation
       left join funding_operation_segments competing_segment
         on competing_segment.operation_id = competing_operation.id
        and competing_segment.provider_id = 'relay'
      where competing_operation.id <> $1::uuid
        and competing_operation.user_id = $2::uuid
        and competing_operation.plan_kind in ('wallet_route', 'composite_route')
        and competing_operation.destination_target_snapshot #>>
              '{location,locationId}' = $3
      group by competing_operation.id, competing_operation.support_metadata`,
    [input.currentOperationId, input.userId, input.destinationLocationId],
  );
  const currentProviderReportedDestination = input.currentProviderSegments.some(
    (segment) =>
      segment.providerRawStatus === "success" &&
      segment.providerStatusCategory === "provider_success" &&
      segment.providerDestinationReferenceCount >= 1,
  );

  for (const row of rows) {
    const facts = await loadFundingLifecycleFactsForOperationInTransaction(db, {
      operationId: row.operation_id,
      now: input.now,
    });
    if (!facts) continue;
    const lifecycle = deriveFundingLifecycle(facts);
    const destinationAfterBaseline = hasFinalEvidenceAfter(
      facts,
      "destination_credit",
      input.baselineAsOf,
    );
    const destinationAtOrBeforeBaseline = hasFinalEvidenceAtOrBefore(
      facts,
      "destination_credit",
      input.baselineAsOf,
    );
    if (destinationAfterBaseline) return true;
    if (lifecycle.status === "ready" && destinationAtOrBeforeBaseline) {
      continue;
    }

    const providerSegments = competingProviderSegments(row.provider_segments);
    const providerMovementMayHaveOccurred =
      facts.actions.some((action) =>
        action.attempts.some((attempt) => attempt.broadcastMayHaveOccurred),
      ) || providerReportsMovement(providerSegments);
    if (
      providerMovementMayHaveOccurred &&
      providerReportedDestinationAfterBaseline(
        providerSegments,
        input.baselineAsOf,
      )
    ) {
      return true;
    }

    const containsVenuePreparation =
      row.support_metadata.containsVenuePreparation === true;
    if (containsVenuePreparation) {
      if (hasFinalEvidenceAfter(facts, "venue_readiness", input.baselineAsOf)) {
        return true;
      }
      if (
        hasFinalEvidenceAtOrBefore(facts, "venue_readiness", input.baselineAsOf)
      ) {
        continue;
      }
      if (!lifecycle.safety.terminal) return true;
    }

    if (!providerMovementMayHaveOccurred || lifecycle.safety.terminal) {
      continue;
    }
    const onlyUnexposedAutomaticRecovery =
      lifecycle.status === "recovery_required" &&
      !lifecycle.safety.requiresManualRecovery &&
      currentProviderReportedDestination &&
      providerSegments.every(
        (segment) => segment.destinationReferenceCount === 0,
      );
    if (!onlyUnexposedAutomaticRecovery) return true;
  }
  return false;
}

export function destinationObservationEvidence(
  supportMetadata: JsonRecord,
  plannerSnapshot: JsonRecord | null,
  receiveDestinationObservation: JsonRecord | null,
): Readonly<{
  locationId: string;
  asset: AssetRef;
  baselineRaw: string;
  baselineRevision: string;
}> {
  const committed = isRecord(supportMetadata.destinationObservation)
    ? supportMetadata.destinationObservation
    : null;
  if (committed) {
    if (
      requiredString(
        committed.observerId,
        "destinationObservation.observerId",
      ) !== OWNED_ROUTE_DESTINATION_OBSERVER_ID
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "owned route destination observer differs from the committed policy",
      );
    }
    return {
      locationId: requiredString(
        committed.locationId,
        "destinationObservation.locationId",
      ),
      asset: parseAsset(committed.asset),
      baselineRaw: requiredString(
        committed.baselineRaw,
        "destinationObservation.baselineRaw",
      ),
      baselineRevision: requiredString(
        committed.baselineRevision,
        "destinationObservation.baselineRevision",
      ),
    };
  }

  const destination =
    plannerSnapshot && isRecord(plannerSnapshot.destination)
      ? plannerSnapshot.destination
      : null;
  const target =
    destination && isRecord(destination.target) ? destination.target : null;
  const location = target && isRecord(target.location) ? target.location : null;
  const spendability =
    destination && isRecord(destination.spendability)
      ? destination.spendability
      : null;
  const observed =
    spendability && isRecord(spendability.observedAmount)
      ? spendability.observedAmount
      : null;
  if (location && spendability && observed) {
    return {
      locationId: requiredString(
        location.locationId,
        "planner destination locationId",
      ),
      asset: parseAsset(observed.asset),
      baselineRaw: requiredString(
        observed.raw,
        "planner destination baselineRaw",
      ),
      baselineRevision: requiredString(
        spendability.revision,
        "planner destination baselineRevision",
      ),
    };
  }

  if (!receiveDestinationObservation) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "owned route destination lacks a committed or immutable baseline",
    );
  }
  return {
    locationId: requiredString(
      receiveDestinationObservation.locationId,
      "receive destination locationId",
    ),
    asset: parseAsset(receiveDestinationObservation.asset),
    baselineRaw: requiredString(
      receiveDestinationObservation.baselineRaw,
      "receive destination baselineRaw",
    ),
    baselineRevision: requiredString(
      receiveDestinationObservation.baselineRevision,
      "receive destination baselineRevision",
    ),
  };
}

async function loadTarget(
  db: Pick<Pool, "query">,
  operationId: string,
  now: Date,
): Promise<OwnedRouteDestinationTarget | null> {
  const { rows } = await db.query<{
    operation_id: string;
    user_id: string;
    purpose: FundingPurpose;
    market_id: string | null;
    baseline_as_of: Date | null;
    version: number;
    venue_binding_snapshot: JsonRecord;
    destination_target_snapshot: JsonRecord;
    operation_support_metadata: JsonRecord;
    planner_snapshot: JsonRecord | null;
    receive_destination_observation: JsonRecord | null;
    quoted_min_output: JsonRecord;
    requested_destination_amount: JsonRecord | null;
    provider_segments: unknown;
  }>(
    `
      select
        operation.id as operation_id,
        operation.user_id,
        operation.purpose,
        operation.market_id,
        operation.version,
        operation.venue_binding_snapshot,
        operation.destination_target_snapshot,
        operation.support_metadata as operation_support_metadata,
        projection.planner_snapshot,
        receive_destination_baseline.destination_observation
          as receive_destination_observation,
        destination_baseline.baseline_as_of,
        segment.quoted_min_output,
        operation.requested_destination_amount,
        (
          select jsonb_agg(
            jsonb_build_object(
              'segmentId', provider_segment.id,
              'ordinal', provider_segment.ordinal,
              'expectedOutput', provider_segment.quoted_expected_output,
              'minimumOutput', provider_segment.quoted_min_output,
              'rawStatus', provider_segment.raw_status,
              'relayStatusCategory',
                provider_segment.support_metadata ->> 'relayStatusCategory',
              'destinationTransactionReferenceCount',
                provider_segment.support_metadata
                  ->'destinationTransactionReferenceCount',
              'transactionReferenceFingerprints',
                provider_segment.support_metadata
                  ->'relayTransactionReferenceFingerprints'
            )
            order by provider_segment.ordinal
          )
          from funding_operation_segments provider_segment
          where provider_segment.operation_id = operation.id
            and provider_segment.provider_id = 'relay'
        ) as provider_segments
      from funding_operations operation
      join funding_operation_segments segment
        on segment.operation_id = operation.id
       and segment.ordinal = 0
       and segment.provider_id = 'relay'
      join funding_quotes quote
        on quote.id = operation.quote_id
       and quote.user_id = operation.user_id
      left join funding_liquidity_projections projection
        on projection.id = quote.discovery_projection_id
       and projection.user_id = operation.user_id
      left join lateral (
        select jsonb_build_object(
          'locationId', immutable_variant.variant ->> 'destinationLocationId',
          'asset', immutable_variant.variant -> 'asset',
          'baselineRaw', immutable_variant.variant ->> 'baselineRaw',
          'baselineRevision',
            immutable_variant.variant ->> 'baselineRevision',
          'baselineAsOf', immutable_variant.session_opened_at
        ) as destination_observation,
        immutable_variant.session_opened_at as baseline_as_of
        from (
          select
            receive_session.opened_at as session_opened_at,
            variant,
            count(*) over () as candidate_count
          from funding_receive_receipts receive_receipt
          join funding_receive_sessions receive_session
            on receive_session.id = receive_receipt.receive_session_id
           and receive_session.user_id = operation.user_id
          cross join lateral jsonb_array_elements(
            receive_session.observation_start_variants
          ) variant
          where receive_receipt.id::text =
                  operation.support_metadata ->> 'fundingReceiveReceiptId'
            and receive_receipt.child_funding_operation_id = operation.id
            and receive_receipt.user_id = operation.user_id
            and variant ->> 'destinationLocationId' =
                  operation.destination_target_snapshot #>>
                    '{location,locationId}'
            and variant #>> '{completion,kind}' =
                  'direct_destination_credit'
            and variant #>> '{asset,networkId}' =
                  operation.destination_target_snapshot #>>
                    '{location,asset,networkId}'
            and variant #>> '{asset,decimals}' =
                  operation.destination_target_snapshot #>>
                    '{location,asset,decimals}'
            and funding_account_identifier_equal(
                  variant #>> '{asset,networkId}',
                  variant #>> '{asset,assetId}',
                  operation.destination_target_snapshot #>>
                    '{location,asset,assetId}'
                )
            and funding_account_identifier_equal(
                  variant #>> '{asset,networkId}',
                  variant ->> 'destinationAddress',
                  operation.destination_target_snapshot #>>
                    '{location,details,address}'
                )
        ) immutable_variant
        where immutable_variant.candidate_count = 1
        limit 1
      ) receive_destination_baseline on true
      cross join lateral (
        select coalesce(
          nullif(
            operation.support_metadata #>>
              '{destinationObservation,baselineAsOf}',
            ''
          )::timestamptz,
          nullif(
            projection.planner_snapshot #>>
              '{destination,spendability,asOf}',
            ''
          )::timestamptz,
          receive_destination_baseline.baseline_as_of
        ) as baseline_as_of
      ) destination_baseline
      where operation.id = $1
        and operation.plan_kind in ('wallet_route', 'composite_route')
        and exists (
          select 1
          from funding_operation_steps step
          where step.operation_id = operation.id
        )
        and not exists (
          select 1
          from funding_observations observation
          where observation.operation_id = operation.id
            and observation.segment_id = segment.id
            and observation.kind = 'destination_credit'
            and observation.canonical
            and observation.finality_status = 'finalized'
        )
      limit 1
    `,
    [operationId],
  );
  const row = rows[0];
  if (!row) return null;
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(db, {
    operationId: row.operation_id,
    now,
  });
  if (!facts) return null;
  const lifecycle = deriveFundingLifecycle(facts);
  if (
    lifecycle.safety.terminal ||
    lifecycle.safety.requiresManualRecovery ||
    lifecycle.actions.length === 0 ||
    lifecycle.actions.some((action) => action.state !== "succeeded")
  ) {
    return null;
  }
  const target = row.destination_target_snapshot;
  const location = isRecord(target.location) ? target.location : null;
  const details =
    location && isRecord(location.details) ? location.details : null;
  const minimumAsset = parseAsset(row.quoted_min_output.asset);
  const providerSegments = parseProviderSegments(row.provider_segments);
  const requestedDestination =
    row.requested_destination_amount &&
    parseAsset(row.requested_destination_amount.asset);
  const requestedRaw = requiredString(
    row.requested_destination_amount?.raw ?? row.quoted_min_output.raw,
    "requested destination output",
  );
  const preparation = preparationContribution(row.operation_support_metadata);
  const observationThresholdRaw = (
    BigInt(preparation?.raw ?? "0") +
    providerSegments.reduce(
      (sum, providerSegment) => sum + BigInt(providerSegment.minimumRaw),
      0n,
    )
  ).toString();
  const baseline = destinationObservationEvidence(
    row.operation_support_metadata,
    row.planner_snapshot,
    row.receive_destination_observation,
  );
  const locationAsset = parseAsset(location?.asset);
  const destinationLocationId = requiredString(
    location?.locationId,
    "destination locationId",
  );
  if (
    baseline.locationId !== destinationLocationId ||
    !sameAsset(baseline.asset, minimumAsset) ||
    !sameAsset(locationAsset, minimumAsset) ||
    providerSegments.some(
      (providerSegment) => !sameAsset(providerSegment.asset, minimumAsset),
    ) ||
    (preparation != null && !sameAsset(preparation.asset, minimumAsset)) ||
    (requestedDestination != null &&
      !sameAsset(requestedDestination, minimumAsset)) ||
    BigInt(observationThresholdRaw) < BigInt(requestedRaw)
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "owned route destination baseline differs from the committed target",
    );
  }
  if (
    await hasCompetingDestinationRoute(db, {
      baselineAsOf: row.baseline_as_of,
      currentOperationId: row.operation_id,
      currentProviderSegments: providerSegments,
      destinationLocationId,
      now,
      userId: row.user_id,
    })
  ) {
    return null;
  }
  const sourceReceiptValue =
    row.operation_support_metadata.fundingReceiveReceiptId;
  const sourceReceiptId =
    typeof sourceReceiptValue === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      sourceReceiptValue,
    )
      ? sourceReceiptValue
      : null;
  const destinationAddress = requiredString(
    details?.address,
    "destinationAddress",
  );
  type DestinationReceiptRow = {
    receipt_id: string;
    receive_session_id: string;
    network_id: string;
    asset_id: string;
    asset_decimals: number;
    destination_address: string;
    raw_amount: string;
    tx_hash: string;
    event_index: string;
    ledger_height: string;
    block_hash: string;
    observed_at: Date;
  };
  const destinationReceiptRows = sourceReceiptId
    ? (
        await db.query<DestinationReceiptRow>(
          `select destination_receipt.id::text as receipt_id,
            destination_receipt.receive_session_id::text as receive_session_id,
            destination_receipt.network_id,
            destination_receipt.asset_id,
            destination_receipt.asset_decimals,
            destination_receipt.destination_address,
            destination_receipt.raw_amount::text as raw_amount,
            destination_receipt.tx_hash,
            destination_receipt.event_index,
            destination_receipt.ledger_height::text as ledger_height,
            destination_receipt.block_hash,
            destination_receipt.observed_at
       from funding_receive_receipts source_receipt
       join funding_receive_receipts destination_receipt
         on destination_receipt.receive_session_id =
              source_receipt.receive_session_id
        and destination_receipt.id <> source_receipt.id
      where source_receipt.id = $1::uuid
        and source_receipt.child_funding_operation_id = $2::uuid
        and source_receipt.user_id = $3::uuid
        and destination_receipt.user_id = source_receipt.user_id
        and destination_receipt.status = 'ready'
        and destination_receipt.handling = 'direct'
        and destination_receipt.network_id = $4
        and funding_account_identifier_equal(
              destination_receipt.network_id,
              destination_receipt.asset_id,
              $5
            )
        and destination_receipt.asset_decimals = $6
        and funding_account_identifier_equal(
              destination_receipt.network_id,
              destination_receipt.destination_address,
              $7
            )
        and destination_receipt.tx_hash is not null
        and destination_receipt.event_index is not null
        and destination_receipt.ledger_height is not null
        and destination_receipt.block_hash is not null
      order by destination_receipt.observed_at,
               destination_receipt.id`,
          [
            sourceReceiptId,
            row.operation_id,
            row.user_id,
            minimumAsset.networkId,
            minimumAsset.assetId,
            minimumAsset.decimals,
            destinationAddress,
          ],
        )
      ).rows
    : [];
  return {
    operationId: row.operation_id,
    providerSegments,
    userId: row.user_id,
    purpose: row.purpose,
    marketId: row.market_id,
    venueBindingOptionId: requiredString(
      row.operation_support_metadata.venueBindingOptionId ??
        row.venue_binding_snapshot.venueBindingOptionId,
      "venueBindingOptionId",
    ),
    destinationReceipts: destinationReceiptRows.map((receipt) => ({
      receiptId: receipt.receipt_id,
      receiveSessionId: receipt.receive_session_id,
      networkId: receipt.network_id,
      assetId: receipt.asset_id,
      assetDecimals: receipt.asset_decimals,
      destinationAddress: receipt.destination_address,
      rawAmount: receipt.raw_amount,
      txHash: receipt.tx_hash,
      eventIndex: receipt.event_index,
      ledgerHeight: receipt.ledger_height,
      blockHash: receipt.block_hash,
      observedAt: receipt.observed_at.toISOString(),
    })),
    destinationLocationId,
    destinationAddress,
    asset: minimumAsset,
    requestedRaw,
    observationThresholdRaw,
    baselineRaw: baseline.baselineRaw,
    baselineRevision: baseline.baselineRevision,
    operationVersion: row.version,
    operationState: {
      status: lifecycle.status,
      stage: lifecycle.progressStage,
    },
  };
}

export async function observeOwnedRouteDestination(
  target: OwnedRouteDestinationTarget,
  observeBalance: typeof observeOwnedWalletAssetBalance = observeOwnedWalletAssetBalance,
): Promise<OwnedRouteDestinationObservation | null> {
  const observedRaw = await observeBalance({
    networkId: target.asset.networkId,
    asset: target.asset,
    destinationAddress: target.destinationAddress,
  });
  const observedAt = new Date().toISOString();
  return {
    observedRaw,
    revision: canonicalJsonHash({
      schema: "relay_owned_destination_observation_v2",
      networkId: target.asset.networkId,
      address: target.destinationAddress,
      asset: target.asset,
      raw: observedRaw,
      observedAt,
    }),
    observedAt,
  };
}

async function observeDestination(
  _pool: Pool,
  target: OwnedRouteDestinationTarget,
): Promise<OwnedRouteDestinationObservation | null> {
  return observeOwnedRouteDestination(target);
}

export function ownedRouteSatisfiedAmount(
  input: Readonly<{
    baselineRaw: string;
    observedRaw: string;
    requestedRaw: string;
  }>,
): string | null {
  const delta = BigInt(input.observedRaw) - BigInt(input.baselineRaw);
  const requested = BigInt(input.requestedRaw);
  return delta >= requested ? requested.toString() : null;
}

export function ownedRouteProviderCredits(
  target: Pick<
    OwnedRouteDestinationTarget,
    "providerSegments" | "observationThresholdRaw"
  >,
): readonly Readonly<{
  segmentId: string;
  ordinal: number;
  rawAmount: string;
  providerRawStatus: string;
  providerDestinationReferenceCount: number;
}>[] {
  const credits = target.providerSegments.map((segment) => ({
    segmentId: segment.segmentId,
    ordinal: segment.ordinal,
    rawAmount: segment.minimumRaw,
    providerRawStatus: segment.providerRawStatus,
    providerDestinationReferenceCount:
      segment.providerDestinationReferenceCount,
  }));
  const total = credits.reduce(
    (sum, credit) => sum + BigInt(credit.rawAmount),
    0n,
  );
  if (total > BigInt(target.observationThresholdRaw)) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "owned route provider minimums exceed the observation threshold",
    );
  }
  return credits;
}

type OwnedRouteExactDestinationCredit = Readonly<{
  segmentId: string;
  receipt: NonNullable<
    OwnedRouteDestinationTarget["destinationReceipts"]
  >[number];
  transactionReferenceFingerprint: string;
}>;

export function ownedRouteExactDestinationCredits(
  target: OwnedRouteDestinationTarget,
  referenceCodec: Pick<RelayReferenceCodec, "fingerprint">,
): readonly OwnedRouteExactDestinationCredit[] | null {
  const credits: OwnedRouteExactDestinationCredit[] = [];
  for (const receipt of target.destinationReceipts ?? []) {
    if (
      !sameAsset(
        {
          networkId: receipt.networkId,
          assetId: receipt.assetId,
          decimals: receipt.assetDecimals,
        },
        target.asset,
      ) ||
      !sameAccountAddress(
        target.asset.networkId,
        receipt.destinationAddress,
        target.destinationAddress,
      )
    ) {
      continue;
    }
    let fingerprint: string;
    try {
      fingerprint = referenceCodec.fingerprint(receipt.txHash);
    } catch {
      continue;
    }
    const matchingSegments = target.providerSegments.filter(
      (providerSegment) =>
        providerSegment.providerRawStatus === "success" &&
        providerSegment.providerStatusCategory === "provider_success" &&
        providerSegment.providerDestinationReferenceCount > 0 &&
        (providerSegment.transactionReferenceFingerprints ?? []).includes(
          fingerprint,
        ),
    );
    if (matchingSegments.length !== 1) continue;
    const providerSegment = matchingSegments[0];
    if (!providerSegment) continue;
    credits.push({
      segmentId: providerSegment.segmentId,
      receipt,
      transactionReferenceFingerprint: fingerprint,
    });
  }
  if (
    target.providerSegments.some((providerSegment) => {
      if (
        providerSegment.providerRawStatus !== "success" ||
        providerSegment.providerStatusCategory !== "provider_success" ||
        providerSegment.providerDestinationReferenceCount < 1
      ) {
        return true;
      }
      const creditedRaw = credits
        .filter((credit) => credit.segmentId === providerSegment.segmentId)
        .reduce(
          (total, credit) => total + BigInt(credit.receipt.rawAmount),
          0n,
        );
      return creditedRaw < BigInt(providerSegment.minimumRaw);
    })
  ) {
    return null;
  }
  return credits.length > 0 ? credits : null;
}

async function persistExactDestinationCredits(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    target: OwnedRouteDestinationTarget;
    credits: readonly OwnedRouteExactDestinationCredit[];
    now: Date;
  }>,
): Promise<boolean> {
  for (const credit of input.credits) {
    const lockedReceipt = await client.query<{ id: string }>(
      `select destination_receipt.id::text as id
         from funding_receive_receipts destination_receipt
        where destination_receipt.id = $1::uuid
          and destination_receipt.receive_session_id = $2::uuid
          and destination_receipt.status = 'ready'
          and destination_receipt.handling = 'direct'
          and destination_receipt.network_id = $3
          and funding_account_identifier_equal(
                destination_receipt.network_id,
                destination_receipt.asset_id,
                $4
              )
          and destination_receipt.asset_decimals = $5
          and funding_account_identifier_equal(
                destination_receipt.network_id,
                destination_receipt.destination_address,
                $6
              )
          and destination_receipt.raw_amount = $7::numeric
          and destination_receipt.tx_hash = $8
          and destination_receipt.event_index = $9
          and destination_receipt.ledger_height = $10::numeric
          and destination_receipt.block_hash = $11
        for update of destination_receipt`,
      [
        credit.receipt.receiptId,
        credit.receipt.receiveSessionId,
        input.target.asset.networkId,
        input.target.asset.assetId,
        input.target.asset.decimals,
        input.target.destinationAddress,
        credit.receipt.rawAmount,
        credit.receipt.txHash,
        credit.receipt.eventIndex,
        credit.receipt.ledgerHeight,
        credit.receipt.blockHash,
      ],
    );
    if (lockedReceipt.rowCount !== 1) return false;
    await allocateFundingObservationInTransaction(client, {
      operationId: input.target.operationId,
      segmentId: credit.segmentId,
      kind: "destination_credit",
      networkId: input.target.asset.networkId,
      assetId: input.target.asset.assetId,
      assetDecimals: input.target.asset.decimals,
      txHash: credit.receipt.txHash,
      eventIndex: credit.receipt.eventIndex,
      fromAddress: null,
      toAddress: input.target.destinationAddress,
      rawAmount: credit.receipt.rawAmount,
      observedAt: new Date(credit.receipt.observedAt),
      ledgerHeight: credit.receipt.ledgerHeight,
      blockHash: credit.receipt.blockHash,
      finalityStatus: "finalized",
      finalizedAt: input.now,
      metadata: {
        observerId: OWNED_ROUTE_DESTINATION_OBSERVER_ID,
        receiveReceiptId: credit.receipt.receiptId,
        receiveSessionId: credit.receipt.receiveSessionId,
        relayTransactionReferenceMatched: true,
        relayTransactionReferenceFingerprint:
          credit.transactionReferenceFingerprint,
      },
    });
  }
  return true;
}

async function persistSatisfiedAmount(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    target: OwnedRouteDestinationTarget;
    observation: OwnedRouteDestinationObservation;
    now: Date;
  }>,
): Promise<boolean> {
  const creditedRaw = ownedRouteSatisfiedAmount({
    baselineRaw: input.target.baselineRaw,
    observedRaw: input.observation.observedRaw,
    requestedRaw: input.target.observationThresholdRaw,
  });
  if (!creditedRaw) return false;
  const delta =
    BigInt(input.observation.observedRaw) - BigInt(input.target.baselineRaw);
  const credits = ownedRouteProviderCredits(input.target);
  for (const credit of credits) {
    await allocateFundingObservationInTransaction(client, {
      operationId: input.target.operationId,
      segmentId: credit.segmentId,
      kind: "destination_credit",
      networkId: input.target.asset.networkId,
      assetId: input.target.asset.assetId,
      assetDecimals: input.target.asset.decimals,
      txHash: `owned-route:${input.target.operationId}:${input.observation.revision}`,
      eventIndex: `minimum-destination-balance-delta:${credit.ordinal}`,
      fromAddress: null,
      toAddress: input.target.destinationAddress,
      rawAmount: credit.rawAmount,
      observedAt: new Date(input.observation.observedAt),
      ledgerHeight: null,
      blockHash: null,
      finalityStatus: "finalized",
      finalizedAt: input.now,
      metadata: {
        observerId: OWNED_ROUTE_DESTINATION_OBSERVER_ID,
        baselineRaw: input.target.baselineRaw,
        baselineRevision: input.target.baselineRevision,
        observedRaw: input.observation.observedRaw,
        observedRevision: input.observation.revision,
        observedDeltaRaw: delta.toString(),
        requestedRaw: input.target.requestedRaw,
        aggregateCreditedRaw: creditedRaw,
        excessRaw: (delta - BigInt(creditedRaw)).toString(),
        providerRawStatus: credit.providerRawStatus,
        providerDestinationReferenceCount:
          credit.providerDestinationReferenceCount,
      },
    });
  }
  return true;
}

export class OwnedRouteDestinationObserver {
  readonly observerId = OWNED_ROUTE_DESTINATION_OBSERVER_ID;

  constructor(
    private readonly dependencies: Readonly<{
      loadTarget?: typeof loadTarget;
      observe?: typeof observeDestination;
      persist?: (
        pool: Pool,
        input: Readonly<{
          target: OwnedRouteDestinationTarget;
          observation: OwnedRouteDestinationObservation;
          now: Date;
        }>,
      ) => Promise<boolean>;
      referenceCodec?: Pick<RelayReferenceCodec, "fingerprint">;
    }> = {},
  ) {}

  async pollOperation(
    pool: Pool,
    operationId: string,
    now = new Date(),
  ): Promise<
    Readonly<{
      destinationsPolled: number;
      destinationSatisfied: boolean;
    }>
  > {
    const target = await (this.dependencies.loadTarget ?? loadTarget)(
      pool,
      operationId,
      now,
    );
    if (!target) {
      return { destinationsPolled: 0, destinationSatisfied: false };
    }
    const exactCredits = this.dependencies.referenceCodec
      ? ownedRouteExactDestinationCredits(
          target,
          this.dependencies.referenceCodec,
        )
      : null;
    if (exactCredits) {
      const destinationSatisfied = await tx(pool, (client) =>
        persistExactDestinationCredits(client, {
          target,
          credits: exactCredits,
          now,
        }),
      );
      return { destinationsPolled: 1, destinationSatisfied };
    }
    const observation = await (this.dependencies.observe ?? observeDestination)(
      pool,
      target,
    );
    if (!observation) {
      return { destinationsPolled: 1, destinationSatisfied: false };
    }
    let destinationSatisfied: boolean;
    if (this.dependencies.persist) {
      destinationSatisfied = await this.dependencies.persist(pool, {
        target,
        observation,
        now,
      });
    } else {
      destinationSatisfied = await tx(pool, (client) =>
        persistSatisfiedAmount(client, { target, observation, now }),
      );
    }
    return { destinationsPolled: 1, destinationSatisfied };
  }
}
