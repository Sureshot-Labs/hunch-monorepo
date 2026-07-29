import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { isRecord } from "../../lib/type-guards.js";
import type { AssetRef, FundingPurpose, JsonValue } from "../domain/types.js";
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
  segmentId: string;
  userId: string;
  purpose: FundingPurpose;
  marketId: string | null;
  venueBindingOptionId: string;
  destinationLocationId: string;
  destinationAddress: string;
  asset: AssetRef;
  requestedRaw: string;
  baselineRaw: string;
  baselineRevision: string;
  providerRawStatus: string;
  providerDestinationReferenceCount: number;
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
    segment_id: string;
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
    segment_raw_status: string | null;
    segment_support_metadata: JsonRecord;
    competing_count: string | number;
  }>(
    `
      select
        operation.id as operation_id,
        segment.id as segment_id,
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
        segment.raw_status as segment_raw_status,
        segment.support_metadata as segment_support_metadata,
        (
          select count(*)
          from funding_operations competing
          where competing.id <> operation.id
            and competing.user_id = operation.user_id
            and competing.plan_kind = 'wallet_route'
            and competing.status in (
              'awaiting_user',
              'awaiting_external_funds',
              'in_progress',
              'ready'
            )
            and competing.destination_target_snapshot #>>
                  '{location,locationId}' =
                operation.destination_target_snapshot #>>
                  '{location,locationId}'
            and not exists (
              select 1
              from funding_operation_segments competing_segment
              where competing_segment.operation_id = competing.id
                and competing_segment.ordinal = 0
                and competing_segment.provider_id = 'relay'
                and competing_segment.raw_status = 'success'
                and competing_segment.support_metadata->>'relayStatusCategory' =
                  'provider_success'
                and (
                  competing_segment.support_metadata
                    ->>'destinationTransactionReferenceCount'
                ) ~ '^[0-9]+$'
                and (
                  competing_segment.support_metadata
                    ->>'destinationTransactionReferenceCount'
                )::integer >= 1
                and (
                  competing_segment.support_metadata->>'providerUpdatedAt'
                ) ~ '^[0-9]+$'
                and (
                  operation.support_metadata #>>
                    '{destinationObservation,baselineAsOf}'
                ) is not null
                and to_timestamp(
                  (
                    competing_segment.support_metadata->>'providerUpdatedAt'
                  )::numeric / 1000
                ) <= (
                  operation.support_metadata #>>
                    '{destinationObservation,baselineAsOf}'
                )::timestamptz
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
      where operation.id = $1
        and operation.plan_kind = 'wallet_route'
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
  if (
    row.segment_raw_status !== "success" ||
    row.segment_support_metadata.relayStatusCategory !== "provider_success"
  ) {
    return null;
  }
  const destinationReferenceCount = nonNegativeCount(
    row.segment_support_metadata.destinationTransactionReferenceCount,
  );
  if (destinationReferenceCount < 1) return null;

  const target = row.destination_target_snapshot;
  const location = isRecord(target.location) ? target.location : null;
  const details =
    location && isRecord(location.details) ? location.details : null;
  const minimumAsset = parseAsset(row.quoted_min_output.asset);
  const baseline = destinationObservationEvidence(
    row.operation_support_metadata,
    row.planner_snapshot,
  );
  const locationAsset = parseAsset(location?.asset);
  if (
    baseline.locationId !==
      requiredString(location?.locationId, "destination locationId") ||
    !sameAsset(baseline.asset, minimumAsset) ||
    !sameAsset(locationAsset, minimumAsset)
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "owned route destination baseline differs from the committed target",
    );
  }
  return {
    operationId: row.operation_id,
    segmentId: row.segment_id,
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
    requestedRaw: requiredString(
      row.quoted_min_output.raw,
      "quoted minimum output",
    ),
    baselineRaw: baseline.baselineRaw,
    baselineRevision: baseline.baselineRevision,
    providerRawStatus: row.segment_raw_status,
    providerDestinationReferenceCount: destinationReferenceCount,
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
    requestedRaw: input.target.requestedRaw,
  });
  if (!creditedRaw) return false;
  const delta =
    BigInt(input.observation.observedRaw) - BigInt(input.target.baselineRaw);
  await allocateFundingObservationInTransaction(client, {
    operationId: input.target.operationId,
    segmentId: input.target.segmentId,
    kind: "destination_credit",
    networkId: input.target.asset.networkId,
    assetId: input.target.asset.assetId,
    txHash: `owned-route:${input.target.operationId}:${input.observation.revision}`,
    eventIndex: "minimum-destination-balance-delta",
    fromAddress: null,
    toAddress: input.target.destinationAddress,
    rawAmount: creditedRaw,
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
      excessRaw: (delta - BigInt(creditedRaw)).toString(),
      providerRawStatus: input.target.providerRawStatus,
      providerDestinationReferenceCount:
        input.target.providerDestinationReferenceCount,
    },
  });
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
  ): Promise<Readonly<{ destinationsPolled: number }>> {
    const target = await (this.dependencies.loadTarget ?? loadTarget)(
      pool,
      operationId,
    );
    if (!target) return { destinationsPolled: 0 };
    const observation = await (this.dependencies.observe ?? observeDestination)(
      pool,
      target,
    );
    if (!observation) return { destinationsPolled: 1 };
    if (this.dependencies.persist) {
      await this.dependencies.persist(pool, { target, observation, now });
    } else {
      await tx(pool, (client) =>
        persistSatisfiedAmount(client, { target, observation, now }),
      );
    }
    return { destinationsPolled: 1 };
  }
}
