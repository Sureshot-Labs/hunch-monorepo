import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { isRecord } from "../../lib/type-guards.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type { AssetRef, FundingPurpose, JsonValue } from "../domain/types.js";
import type { FundingOperationState } from "../domain/transitions.js";
import {
  allocateFundingObservationInTransaction,
  FundingPersistenceError,
  transitionFundingOperationInTransaction,
} from "../persistence/funding-operation-repository.js";
import { sameAsset } from "../planner/money.js";
import { observeOwnedWalletAssetBalance } from "./owned-wallet-asset-balance.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type DirectIngressObservationVariant = Readonly<{
  variantId: string;
  networkId: string;
  asset: AssetRef;
  destinationAddress: string;
  destinationLocationId: string;
  baselineRaw: string;
  baselineRevision: string;
  observation: Readonly<{
    adapterId: string;
    payload: JsonRecord;
  }>;
  completion:
    | Readonly<{ kind: "direct_destination_credit" }>
    | Readonly<{ kind: "child_funding_operation" }>
    | Readonly<{
        kind: "committed_venue_preparation";
        stepOrdinal: number;
      }>;
}>;

export type DirectIngressObservationTarget = Readonly<{
  operationId: string;
  userId: string;
  purpose: FundingPurpose;
  marketId: string | null;
  venueBindingOptionId: string;
  requestedAsset: AssetRef;
  requestedRaw: string;
  operationVersion: number;
  operationState: FundingOperationState;
  variants: readonly DirectIngressObservationVariant[];
}>;

export type DirectIngressVariantObservation = Readonly<{
  variantId: string;
  observedRaw: string;
  revision: string;
  observedAt: string;
}>;

export type DirectIngressDestinationObservation = Readonly<{
  variants: readonly DirectIngressVariantObservation[];
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

export function parseDirectIngressObservationVariant(
  value: unknown,
): DirectIngressObservationVariant {
  if (
    !isRecord(value) ||
    !isRecord(value.observation) ||
    !isRecord(value.completion)
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "direct ingress variant is invalid",
    );
  }
  const asset = parseAsset(value.asset);
  const networkId = requiredString(value.networkId, "variant.networkId");
  if (asset.networkId !== networkId) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "direct ingress variant asset and receive network differ",
    );
  }
  if (!isRecord(value.observation.payload)) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "direct ingress observation adapter payload is invalid",
    );
  }
  const observation: DirectIngressObservationVariant["observation"] = {
    adapterId: requiredString(
      value.observation.adapterId,
      "variant.observation.adapterId",
    ),
    payload: value.observation.payload as JsonRecord,
  };
  const completionKind = value.completion.kind;
  let completion: DirectIngressObservationVariant["completion"];
  if (completionKind === "direct_destination_credit") {
    completion = { kind: completionKind };
  } else if (completionKind === "child_funding_operation") {
    completion = { kind: completionKind };
  } else if (
    completionKind === "committed_venue_preparation" &&
    Number.isInteger(value.completion.stepOrdinal) &&
    Number(value.completion.stepOrdinal) >= 0
  ) {
    completion = {
      kind: completionKind,
      stepOrdinal: Number(value.completion.stepOrdinal),
    };
  } else {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "direct ingress completion adapter is invalid",
    );
  }
  return {
    variantId: requiredString(value.variantId, "variant.variantId"),
    networkId,
    asset,
    destinationAddress: requiredString(
      value.destinationAddress,
      "variant.destinationAddress",
    ),
    destinationLocationId: requiredString(
      value.destinationLocationId,
      "variant.destinationLocationId",
    ),
    baselineRaw: requiredString(value.baselineRaw, "variant.baselineRaw"),
    baselineRevision: requiredString(
      value.baselineRevision,
      "variant.baselineRevision",
    ),
    observation,
    completion,
  };
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
    status: FundingOperationState["status"];
    progress_stage: FundingOperationState["stage"];
    version: number;
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
        operation.status,
        operation.progress_stage,
        operation.version,
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
          'cancelled',
          'reconcile_required',
          'recovery_required'
        )
        and not exists (
          select 1
          from funding_observations observation
          where observation.operation_id = operation.id
            and observation.kind in ('source_credit', 'destination_credit')
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
  const requestedAsset = parseAsset(requested.asset);
  const fallbackVariant: DirectIngressObservationVariant = {
    variantId: `legacy:${row.operation_id}`,
    networkId: requestedAsset.networkId,
    asset: requestedAsset,
    destinationLocationId: requiredString(
      location?.locationId,
      "destinationLocationId",
    ),
    destinationAddress: requiredString(
      details?.address ?? location?.locationId,
      "destinationAddress",
    ),
    baselineRaw: requiredString(
      row.support_metadata.destinationBaselineRaw,
      "destinationBaselineRaw",
    ),
    baselineRevision: requiredString(
      row.support_metadata.destinationBaselineRevision,
      "destinationBaselineRevision",
    ),
    observation: {
      adapterId: "owned_destination_spendability_v1",
      payload: {},
    },
    completion: { kind: "direct_destination_credit" },
  };
  const rawVariants = row.support_metadata.ingressVariants;
  const variants = Array.isArray(rawVariants)
    ? rawVariants.map(parseDirectIngressObservationVariant)
    : [fallbackVariant];
  if (
    variants.length === 0 ||
    new Set(variants.map((variant) => variant.variantId)).size !==
      variants.length ||
    variants.some((variant) => !variant.destinationAddress.trim())
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "direct ingress variants are empty, duplicated, or invalid",
    );
  }
  return {
    operationId: row.operation_id,
    userId: row.user_id,
    purpose: row.purpose,
    marketId: row.market_id,
    venueBindingOptionId: requiredString(
      row.support_metadata.venueBindingOptionId ?? binding.venueBindingOptionId,
      "venueBindingOptionId",
    ),
    requestedAsset,
    requestedRaw: requiredString(requested.raw, "requestedRaw"),
    operationVersion: row.version,
    operationState: {
      status: row.status,
      stage: row.progress_stage,
    },
    variants,
  };
}

async function observeFrozenOwnedBalances(
  variants: readonly DirectIngressObservationVariant[],
): Promise<readonly DirectIngressVariantObservation[]> {
  const observedAt = new Date().toISOString();
  return Promise.all(
    variants.map(async (variant) => {
      const observedRaw = await observeOwnedWalletAssetBalance({
        networkId: variant.networkId,
        asset: variant.asset,
        destinationAddress: variant.destinationAddress,
      });
      return {
        variantId: variant.variantId,
        observedRaw,
        revision: canonicalJsonHash({
          schema: "owned_ingress_balance_observation_v1",
          adapterId: variant.observation.adapterId,
          networkId: variant.networkId,
          address: variant.destinationAddress,
          asset: variant.asset,
          raw: observedRaw,
          observedAt,
        }),
        observedAt,
      };
    }),
  );
}

/**
 * Additional EVM networks and Solana register another adapter here; the core
 * observer neither infers token semantics nor grows a chain/provider branch.
 */
export interface DirectIngressObservationAdapter {
  readonly adapterId: string;
  observe(
    pool: Pool,
    target: DirectIngressObservationTarget,
    variants: readonly DirectIngressObservationVariant[],
  ): Promise<readonly DirectIngressVariantObservation[] | null>;
}

const ownedDestinationSpendabilityAdapter: DirectIngressObservationAdapter = {
  adapterId: "owned_destination_spendability_v1",
  async observe(_pool, _target, variants) {
    return variants.length === 1 ? observeFrozenOwnedBalances(variants) : null;
  },
};

const polymarketDepositWalletAssetsAdapter: DirectIngressObservationAdapter = {
  adapterId: "polymarket_deposit_wallet_assets_v1",
  async observe(_pool, _target, variants) {
    return variants.every((variant) => {
      const field = variant.observation.payload.field;
      return field === "depositPusdRaw" || field === "depositUsdceRaw";
    })
      ? observeFrozenOwnedBalances(variants)
      : null;
  },
};

const ownedWalletLiquidBalancesAdapter: DirectIngressObservationAdapter = {
  adapterId: "owned_wallet_liquid_balances_v1",
  async observe(_pool, _target, variants) {
    if (
      variants.some(
        (variant) => typeof variant.observation.payload.balanceKey !== "string",
      )
    ) {
      throw new Error("receive balance key is missing");
    }
    return observeFrozenOwnedBalances(variants);
  },
};

const DEFAULT_OBSERVATION_ADAPTERS: readonly DirectIngressObservationAdapter[] =
  [
    ownedDestinationSpendabilityAdapter,
    polymarketDepositWalletAssetsAdapter,
    ownedWalletLiquidBalancesAdapter,
  ];

export async function observeDirectIngressDestination(
  pool: Pool,
  target: DirectIngressObservationTarget,
  adapters: readonly DirectIngressObservationAdapter[] = DEFAULT_OBSERVATION_ADAPTERS,
): Promise<DirectIngressDestinationObservation | null> {
  const variantsByAdapter = new Map<
    string,
    DirectIngressObservationVariant[]
  >();
  for (const variant of target.variants) {
    const group = variantsByAdapter.get(variant.observation.adapterId) ?? [];
    group.push(variant);
    variantsByAdapter.set(variant.observation.adapterId, group);
  }
  const observations: DirectIngressVariantObservation[] = [];
  for (const [adapterId, variants] of variantsByAdapter) {
    const matches = adapters.filter(
      (adapter) => adapter.adapterId === adapterId,
    );
    if (matches.length !== 1) return null;
    const adapter = matches[0];
    if (!adapter) return null;
    const observed = await adapter.observe(pool, target, variants);
    if (!observed || observed.length !== variants.length) return null;
    observations.push(...observed);
  }
  return observations.length === target.variants.length
    ? { variants: observations }
    : null;
}

async function moveToAmbiguousRecovery(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    target: DirectIngressObservationTarget;
    positiveVariantIds: readonly string[];
    now: Date;
  }>,
): Promise<void> {
  await transitionFundingOperationInTransaction(client, {
    operationId: input.target.operationId,
    scope: { kind: "worker" },
    expectedVersion: input.target.operationVersion,
    expectedState: input.target.operationState,
    nextState: {
      status: "recovery_required",
      stage:
        input.target.operationState.stage === "committed"
          ? "source_action"
          : input.target.operationState.stage,
    },
    errorCode: "mixed_external_ingress_assets",
    supportMetadataPatch: {
      ingressVariantConflict: input.positiveVariantIds,
      ingressVariantConflictDetectedAt: input.now.toISOString(),
    },
    now: input.now,
  });
}

async function activateCommittedStep(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    stepOrdinal: number;
    now: Date;
  }>,
): Promise<void> {
  const activated = await client.query(
    `
      update funding_operation_steps
      set state = 'action_required',
          updated_at = $3
      where operation_id = $1
        and ordinal = $2
        and state = 'planned'
    `,
    [input.operationId, input.stepOrdinal, input.now],
  );
  if (activated.rowCount !== 1) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "committed ingress completion step is unavailable",
    );
  }
}

async function persistSatisfiedAmount(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    target: DirectIngressObservationTarget;
    observation: DirectIngressDestinationObservation;
    now: Date;
  }>,
): Promise<boolean> {
  const selection = selectDirectIngressVariant({
    variants: input.target.variants,
    observations: input.observation.variants,
    requestedRaw: input.target.requestedRaw,
  });
  if (selection.kind === "ambiguous") {
    await moveToAmbiguousRecovery(client, {
      target: input.target,
      positiveVariantIds: selection.positiveVariantIds,
      now: input.now,
    });
    return true;
  }
  if (selection.kind === "waiting") return false;
  const selected = selection;
  const creditedRaw = input.target.requestedRaw;
  const direct =
    selected.variant.completion.kind === "direct_destination_credit";
  if (
    direct &&
    !sameAsset(selected.variant.asset, input.target.requestedAsset)
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "direct ingress variant cannot credit another destination asset",
    );
  }
  await allocateFundingObservationInTransaction(client, {
    operationId: input.target.operationId,
    segmentId: null,
    kind: direct ? "destination_credit" : "source_credit",
    networkId: selected.variant.asset.networkId,
    assetId: selected.variant.asset.assetId,
    assetDecimals: selected.variant.asset.decimals,
    txHash: `direct-ingress:${input.target.operationId}:${selected.observation.revision}`,
    eventIndex: direct
      ? "minimum-destination-balance-delta"
      : `verified-ingress:${selected.variant.variantId}`,
    fromAddress: null,
    toAddress: selected.variant.destinationAddress,
    rawAmount: creditedRaw,
    observedAt: new Date(selected.observation.observedAt),
    ledgerHeight: null,
    blockHash: null,
    finalityStatus: "finalized",
    finalizedAt: input.now,
    metadata: {
      observerId: "owned_multi_asset_balance_delta_v1",
      ingressVariantId: selected.variant.variantId,
      baselineRaw: selected.variant.baselineRaw,
      baselineRevision: selected.variant.baselineRevision,
      observedRaw: selected.observation.observedRaw,
      observedRevision: selected.observation.revision,
      observedDeltaRaw: selected.delta.toString(),
      requestedRaw: input.target.requestedRaw,
      minimumSatisfied: true,
      excessRaw: (
        selected.delta - BigInt(input.target.requestedRaw)
      ).toString(),
      completionKind: selected.variant.completion.kind,
    },
  });
  if (selected.variant.completion.kind === "committed_venue_preparation") {
    await activateCommittedStep(client, {
      operationId: input.target.operationId,
      stepOrdinal: selected.variant.completion.stepOrdinal,
      now: input.now,
    });
  }
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

export function selectDirectIngressVariant(
  input: Readonly<{
    variants: readonly DirectIngressObservationVariant[];
    observations: readonly DirectIngressVariantObservation[];
    requestedRaw: string;
  }>,
):
  | Readonly<{ kind: "waiting" }>
  | Readonly<{ kind: "ambiguous"; positiveVariantIds: readonly string[] }>
  | Readonly<{
      kind: "satisfied";
      variant: DirectIngressObservationVariant;
      observation: DirectIngressVariantObservation;
      delta: bigint;
    }> {
  const observedByVariant = new Map(
    input.observations.map((observation) => [
      observation.variantId,
      observation,
    ]),
  );
  const deltas = input.variants.map((variant) => {
    const observation = observedByVariant.get(variant.variantId);
    if (!observation) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "direct ingress observation omitted an accepted variant",
      );
    }
    return {
      variant,
      observation,
      delta: BigInt(observation.observedRaw) - BigInt(variant.baselineRaw),
    };
  });
  const positive = deltas.filter((entry) => entry.delta > 0n);
  if (positive.length > 1) {
    return {
      kind: "ambiguous",
      positiveVariantIds: positive.map((entry) => entry.variant.variantId),
    };
  }
  const selected = positive[0];
  if (!selected || selected.delta < BigInt(input.requestedRaw)) {
    return { kind: "waiting" };
  }
  return { kind: "satisfied", ...selected };
}

export class DirectIngressDestinationObserver {
  readonly observerId = "owned_multi_asset_balance_delta_v1";

  constructor(
    private readonly dependencies: Readonly<{
      loadTarget?: typeof loadTarget;
      observe?: typeof observeDirectIngressDestination;
      observationAdapters?: readonly DirectIngressObservationAdapter[];
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
    const observation = this.dependencies.observe
      ? await this.dependencies.observe(pool, target)
      : await observeDirectIngressDestination(
          pool,
          target,
          this.dependencies.observationAdapters,
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
