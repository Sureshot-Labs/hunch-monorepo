import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { isRecord } from "../../lib/type-guards.js";
import type {
  AssetRef,
  FundingPurpose,
  JsonValue,
  PreparationPurpose,
} from "../domain/types.js";
import {
  allocateFundingObservationInTransaction,
  FundingPersistenceError,
} from "../persistence/funding-operation-repository.js";
import { WalletPreparationRuntimeService } from "../preparation/runtime-service.js";
import { sameAsset } from "../planner/money.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type DirectIngressObservationTarget = Readonly<{
  operationId: string;
  userId: string;
  purpose: FundingPurpose;
  marketId: string | null;
  venueBindingOptionId: string;
  destinationLocationId: string;
  destinationAddress: string;
  requestedAsset: AssetRef;
  requestedRaw: string;
  baselineRaw: string;
  baselineRevision: string;
}>;

export type DirectIngressDestinationObservation = Readonly<{
  observedRaw: string;
  revision: string;
  observedAt: string;
}>;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      `direct ingress evidence lacks ${field}`,
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
      "direct ingress destination asset is invalid",
    );
  }
  return {
    networkId: value.networkId,
    assetId: value.assetId,
    decimals: value.decimals,
  };
}

function preparationPurpose(purpose: FundingPurpose): PreparationPurpose {
  return purpose === "trade_shortfall" ? "buy" : "fund";
}

async function loadTarget(
  db: Pick<Pool, "query">,
  operationId: string,
): Promise<DirectIngressObservationTarget | null> {
  const { rows } = await db.query<{
    operation_id: string;
    user_id: string;
    purpose: FundingPurpose;
    market_id: string | null;
    venue_binding_snapshot: JsonRecord;
    destination_target_snapshot: JsonRecord;
    requested_destination_amount: JsonRecord;
    support_metadata: JsonRecord;
  }>(
    `
      select
        operation.id as operation_id,
        operation.user_id,
        operation.purpose,
        operation.market_id,
        operation.venue_binding_snapshot,
        operation.destination_target_snapshot,
        operation.requested_destination_amount,
        operation.support_metadata
      from funding_operations operation
      where operation.id = $1
        and operation.plan_kind = 'direct_external_handoff'
        and operation.status not in (
          'completed',
          'refunded',
          'failed',
          'cancelled'
        )
        and not exists (
          select 1
          from funding_observations observation
          where observation.operation_id = operation.id
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
  const binding = row.venue_binding_snapshot;
  const requested = row.requested_destination_amount;
  const target = row.destination_target_snapshot;
  const location = isRecord(target.location) ? target.location : null;
  const details =
    location && isRecord(location.details) ? location.details : null;
  return {
    operationId: row.operation_id,
    userId: row.user_id,
    purpose: row.purpose,
    marketId: row.market_id,
    venueBindingOptionId: requiredString(
      binding.venueBindingOptionId,
      "venueBindingOptionId",
    ),
    destinationLocationId: requiredString(
      location?.locationId,
      "destinationLocationId",
    ),
    destinationAddress: requiredString(
      details?.address ?? location?.locationId,
      "destinationAddress",
    ),
    requestedAsset: parseAsset(requested.asset),
    requestedRaw: requiredString(requested.raw, "requestedRaw"),
    baselineRaw: requiredString(
      row.support_metadata.destinationBaselineRaw,
      "destinationBaselineRaw",
    ),
    baselineRevision: requiredString(
      row.support_metadata.destinationBaselineRevision,
      "destinationBaselineRevision",
    ),
  };
}

async function observeDestination(
  pool: Pool,
  target: DirectIngressObservationTarget,
): Promise<DirectIngressDestinationObservation | null> {
  const candidates = await new WalletPreparationRuntimeService(
    pool,
  ).resolvedCandidates({
    accountId: target.userId,
    purpose: preparationPurpose(target.purpose),
    marketContextId: target.marketId,
    marketClass: null,
    compatibleVenueBindingOptionIds: [target.venueBindingOptionId],
  });
  const matches = candidates.filter(
    (candidate) =>
      candidate.bindingOption.venueBindingOptionId ===
        target.venueBindingOptionId &&
      candidate.target.kind === "owned_location" &&
      candidate.target.location.locationId === target.destinationLocationId &&
      sameAsset(
        candidate.spendability.observedAmount.asset,
        target.requestedAsset,
      ),
  );
  if (matches.length !== 1) return null;
  const observed = matches[0]?.spendability;
  if (!observed) return null;
  return {
    observedRaw: observed.observedAmount.raw,
    revision: observed.revision,
    observedAt: observed.asOf,
  };
}

async function persistSatisfiedAmount(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    target: DirectIngressObservationTarget;
    observation: DirectIngressDestinationObservation;
    now: Date;
  }>,
): Promise<boolean> {
  const creditedRaw = directIngressSatisfiedAmount({
    baselineRaw: input.target.baselineRaw,
    observedRaw: input.observation.observedRaw,
    requestedRaw: input.target.requestedRaw,
  });
  if (creditedRaw == null) return false;
  const observedDeltaRaw = (
    BigInt(input.observation.observedRaw) - BigInt(input.target.baselineRaw)
  ).toString();
  await allocateFundingObservationInTransaction(client, {
    operationId: input.target.operationId,
    segmentId: null,
    kind: "destination_credit",
    networkId: input.target.requestedAsset.networkId,
    assetId: input.target.requestedAsset.assetId,
    txHash: `direct-ingress:${input.target.operationId}:${input.observation.revision}`,
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
      observerId: "owned_destination_balance_delta_v2",
      baselineRaw: input.target.baselineRaw,
      baselineRevision: input.target.baselineRevision,
      observedRaw: input.observation.observedRaw,
      observedRevision: input.observation.revision,
      observedDeltaRaw,
      requestedRaw: input.target.requestedRaw,
      minimumSatisfied: true,
      excessRaw: (
        BigInt(observedDeltaRaw) - BigInt(input.target.requestedRaw)
      ).toString(),
    },
  });
  return true;
}

export function directIngressSatisfiedAmount(
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

export class DirectIngressDestinationObserver {
  readonly observerId = "owned_destination_balance_delta_v2";

  constructor(
    private readonly dependencies: Readonly<{
      loadTarget?: typeof loadTarget;
      observe?: typeof observeDestination;
      persist?: (
        pool: Pool,
        input: Readonly<{
          target: DirectIngressObservationTarget;
          observation: DirectIngressDestinationObservation;
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
