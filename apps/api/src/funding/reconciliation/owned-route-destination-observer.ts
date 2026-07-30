import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { isRecord } from "../../lib/type-guards.js";
import type {
  AssetRef,
  FundingPurpose,
  JsonValue,
  Money,
} from "../domain/types.js";
import type { FundingOperationState } from "../domain/transitions.js";
import {
  allocateFundingObservationInTransaction,
  FundingPersistenceError,
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
    providerDestinationReferenceCount: number;
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
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
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
  if (!/^[1-9][0-9]*$/.test(raw)) {
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
    if (
      !/^[1-9][0-9]*$/.test(expectedRaw) ||
      !/^[1-9][0-9]*$/.test(minimumRaw) ||
      BigInt(expectedRaw) < BigInt(minimumRaw)
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
      providerDestinationReferenceCount: nonNegativeCount(
        entry.destinationTransactionReferenceCount,
      ),
    };
  });
}

function destinationObservationEvidence(
  supportMetadata: JsonRecord,
  plannerSnapshot: JsonRecord | null,
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
  if (!location || !spendability || !observed) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "owned route destination lacks a committed or immutable baseline",
    );
  }
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

async function loadTarget(
  db: Pick<Pool, "query">,
  operationId: string,
): Promise<OwnedRouteDestinationTarget | null> {
  const { rows } = await db.query<{
    operation_id: string;
    user_id: string;
    purpose: FundingPurpose;
    market_id: string | null;
    status: FundingOperationState["status"];
    progress_stage: FundingOperationState["stage"];
    version: number;
    venue_binding_snapshot: JsonRecord;
    destination_target_snapshot: JsonRecord;
    operation_support_metadata: JsonRecord;
    planner_snapshot: JsonRecord | null;
    quoted_min_output: JsonRecord;
    requested_destination_amount: JsonRecord | null;
    provider_segments: unknown;
    competing_count: string | number;
  }>(
    `
      select
        operation.id as operation_id,
        operation.user_id,
        operation.purpose,
        operation.market_id,
        operation.status,
        operation.progress_stage,
        operation.version,
        operation.venue_binding_snapshot,
        operation.destination_target_snapshot,
        operation.support_metadata as operation_support_metadata,
        projection.planner_snapshot,
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
              'destinationTransactionReferenceCount',
                provider_segment.support_metadata
                  ->'destinationTransactionReferenceCount'
            )
            order by provider_segment.ordinal
          )
          from funding_operation_segments provider_segment
          where provider_segment.operation_id = operation.id
            and provider_segment.provider_id = 'relay'
        ) as provider_segments,
        (
          select count(*)
          from funding_operations competing
          where competing.id <> operation.id
            and competing.user_id = operation.user_id
            and competing.plan_kind in ('wallet_route', 'composite_route')
            and competing.destination_target_snapshot #>>
                  '{location,locationId}' =
                operation.destination_target_snapshot #>>
                  '{location,locationId}'
            and (
              exists (
                select 1
                from funding_operation_segments competing_segment
                where competing_segment.operation_id = competing.id
                  and competing_segment.provider_id = 'relay'
                  and case
                    when
                      competing_segment.raw_status = 'success'
                      and competing_segment.support_metadata
                        ->>'relayStatusCategory' = 'provider_success'
                      and (
                        competing_segment.support_metadata
                          ->>'destinationTransactionReferenceCount'
                      ) ~ '^[0-9]+$'
                      and (
                        competing_segment.support_metadata
                          ->>'destinationTransactionReferenceCount'
                      )::integer >= 1
                      and (
                        competing_segment.support_metadata
                          ->>'providerUpdatedAt'
                      ) ~ '^[0-9]+$'
                      and destination_baseline.baseline_as_of is not null
                    then to_timestamp(
                      (
                        competing_segment.support_metadata
                          ->>'providerUpdatedAt'
                      )::numeric / 1000
                    ) > destination_baseline.baseline_as_of
                    else (
                      competing.status in (
                        'awaiting_user',
                        'awaiting_external_funds',
                        'in_progress',
                        'ready',
                        'reconcile_required'
                      )
                      or (
                        competing.status = 'recovery_required'
                        -- A delivered current route cannot be blocked forever
                        -- by an older recovery route that has no destination
                        -- transaction. If that older route delivers later,
                        -- this operation's finalized destination observation
                        -- prevents the same balance delta from being
                        -- attributed twice.
                        and not (
                          segment.raw_status = 'success'
                          and segment.support_metadata
                            ->>'relayStatusCategory' = 'provider_success'
                          and coalesce(
                            segment.support_metadata
                              ->>'destinationTransactionReferenceCount',
                            '0'
                          ) ~ '^[0-9]+$'
                          and (
                            coalesce(
                              segment.support_metadata
                                ->>'destinationTransactionReferenceCount',
                              '0'
                            )
                          )::integer >= 1
                          and coalesce(
                            competing_segment.support_metadata
                              ->>'destinationTransactionReferenceCount',
                            '0'
                          ) ~ '^[0-9]+$'
                          and (
                            coalesce(
                              competing_segment.support_metadata
                                ->>'destinationTransactionReferenceCount',
                              '0'
                            )
                          )::integer = 0
                        )
                      )
                    )
                  end
              )
              or (
                competing.support_metadata->>'containsVenuePreparation' =
                  'true'
                and case
                  when exists (
                    select 1
                    from funding_observations competing_preparation
                    where competing_preparation.operation_id = competing.id
                      and competing_preparation.kind = 'venue_readiness'
                      and competing_preparation.canonical
                      and competing_preparation.finality_status = 'finalized'
                      and competing_preparation.observed_at >
                        destination_baseline.baseline_as_of
                  ) then true
                  when exists (
                    select 1
                    from funding_observations competing_preparation
                    where competing_preparation.operation_id = competing.id
                      and competing_preparation.kind = 'venue_readiness'
                      and competing_preparation.canonical
                      and competing_preparation.finality_status = 'finalized'
                      and competing_preparation.observed_at <=
                        destination_baseline.baseline_as_of
                  ) then false
                  else competing.status in (
                    'awaiting_user',
                    'awaiting_external_funds',
                    'in_progress',
                    'ready',
                    'reconcile_required',
                    'recovery_required'
                  )
                end
              )
              or exists (
                select 1
                from funding_observations competing_credit
                where competing_credit.operation_id = competing.id
                  and competing_credit.kind = 'destination_credit'
                  and competing_credit.canonical
                  and competing_credit.finality_status = 'finalized'
                  and competing_credit.observed_at >
                    destination_baseline.baseline_as_of
                )
            )
        ) as competing_count
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
          )::timestamptz
        ) as baseline_as_of
      ) destination_baseline
      where operation.id = $1
        and operation.plan_kind in ('wallet_route', 'composite_route')
        and operation.status not in (
          'completed',
          'refunded',
          'failed',
          'cancelled',
          'reconcile_required',
          'recovery_required'
        )
        and exists (
          select 1
          from funding_operation_steps step
          where step.operation_id = operation.id
        )
        and not exists (
          select 1
          from funding_operation_steps step
          where step.operation_id = operation.id
            and step.state <> 'succeeded'
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
  if (!row || Number(row.competing_count) > 0) return null;
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
  );
  const locationAsset = parseAsset(location?.asset);
  if (
    baseline.locationId !==
      requiredString(location?.locationId, "destination locationId") ||
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
    destinationLocationId: baseline.locationId,
    destinationAddress: requiredString(details?.address, "destinationAddress"),
    asset: minimumAsset,
    requestedRaw,
    observationThresholdRaw,
    baselineRaw: baseline.baselineRaw,
    baselineRevision: baseline.baselineRevision,
    operationVersion: row.version,
    operationState: {
      status: row.status,
      stage: row.progress_stage,
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
    );
    if (!target) {
      return { destinationsPolled: 0, destinationSatisfied: false };
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
