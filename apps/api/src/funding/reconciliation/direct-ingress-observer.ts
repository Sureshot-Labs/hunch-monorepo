import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { isRecord } from "../../lib/type-guards.js";
import { SOLANA_NATIVE_ASSET } from "../domain/network-fees.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type { AssetRef, FundingPurpose, JsonValue } from "../domain/types.js";
import type { FundingOperationState } from "../domain/transitions.js";
import {
  allocateFundingObservationInTransaction,
  FundingPersistenceError,
  writeFundingOperationSupportFactsInTransaction,
} from "../persistence/funding-operation-repository.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import { deriveFundingLifecycle } from "../lifecycle/funding-lifecycle-projector.js";
import { sameAsset } from "../planner/money.js";
import { reduceFundingOperationInTransaction } from "./funding-reducer.js";
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
    | Readonly<{ kind: "retained_owned_source_credit" }>
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
  /** Optimistic snapshot for callers which also carry this immutable target. */
  operationVersion: number;
  /**
   * Legacy transport context kept for receive-session callers. The direct
   * ingress observer never reads it; lifecycle eligibility comes from facts.
   */
  operationState?: FundingOperationState;
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
  } else if (completionKind === "retained_owned_source_credit") {
    if (!sameAsset(asset, SOLANA_NATIVE_ASSET)) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "retained owned source credit is limited to native SOL",
      );
    }
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
  db: Pick<PoolClient, "query">,
  operationId: string,
  now: Date,
): Promise<DirectIngressObservationTarget | null> {
  const { rows } = await db.query<{
    operation_id: string;
    user_id: string;
    purpose: FundingPurpose;
    market_id: string | null;
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
        operation.version,
        operation.venue_binding_snapshot,
        operation.destination_target_snapshot,
        operation.requested_destination_amount,
        operation.support_metadata
      from funding_operations operation
      where operation.id = $1
        and operation.plan_kind = 'direct_external_handoff'
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
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(db, {
    operationId: row.operation_id,
    now,
  });
  if (!facts) return null;
  const lifecycle = deriveFundingLifecycle(facts);
  // This observer only discovers a first external ingress.  Any later
  // lifecycle phase is owned by its actual action/evidence worker; the
  // materialized operation status is deliberately not used as this gate.
  if (
    lifecycle.safety.terminal ||
    lifecycle.status !== "awaiting_external_funds"
  ) {
    return null;
  }
  const binding = row.venue_binding_snapshot;
  const requested = row.requested_destination_amount;
  const target = row.destination_target_snapshot;
  const location = isRecord(target.location) ? target.location : null;
  const details =
    location && isRecord(location.details) ? location.details : null;
  const requestedAsset = parseAsset(requested.asset);
  const rawVariants = row.support_metadata.ingressVariants;
  const variants: readonly DirectIngressObservationVariant[] = Array.isArray(
    rawVariants,
  )
    ? rawVariants.map(parseDirectIngressObservationVariant)
    : [
        {
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
          completion: { kind: "direct_destination_credit" as const },
        },
      ];
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
  client: PoolClient,
  input: Readonly<{
    target: DirectIngressObservationTarget;
    positiveVariantIds: readonly string[];
    now: Date;
  }>,
): Promise<void> {
  const current = await client.query<{ version: number }>(
    `select version
       from funding_operations
      where id = $1
      for update`,
    [input.target.operationId],
  );
  const operation = current.rows[0];
  if (!operation) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "direct ingress operation disappeared before ambiguity handling",
    );
  }
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(client, {
    operationId: input.target.operationId,
    now: input.now,
  });
  if (!facts) return;
  const lifecycle = deriveFundingLifecycle(facts);
  if (
    lifecycle.safety.terminal ||
    lifecycle.status !== "awaiting_external_funds"
  ) {
    return;
  }
  await writeFundingOperationSupportFactsInTransaction(client, {
    operationId: input.target.operationId,
    expectedVersion: operation.version,
    supportMetadataPatch: {
      lifecycleManualRecovery: {
        code: "mixed_external_ingress_assets",
        requestedAt: input.now.toISOString(),
      },
      ingressVariantConflict: input.positiveVariantIds,
      ingressVariantConflictDetectedAt: input.now.toISOString(),
    },
    now: input.now,
  });
  await reduceFundingOperationInTransaction(client, {
    operationId: input.target.operationId,
    now: input.now,
  });
}

async function persistSatisfiedAmount(
  client: PoolClient,
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
  // External balance observation happens outside the transaction. Re-check
  // the factual lifecycle while holding the operation row lock before that
  // old observation is allowed to create new durable money evidence.
  const locked = await client.query<{ id: string }>(
    `select id
       from funding_operations
      where id = $1
      for update`,
    [input.target.operationId],
  );
  if (!locked.rows[0]) return false;
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(client, {
    operationId: input.target.operationId,
    now: input.now,
  });
  if (!facts) return false;
  const lifecycle = deriveFundingLifecycle(facts);
  if (
    lifecycle.safety.terminal ||
    lifecycle.status !== "awaiting_external_funds"
  ) {
    return false;
  }
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
  // The source-credit fact activates a deferred action and the reducer writes
  // the resulting step/operation projection caches. Do not manually mutate a
  // step state here: that would make a cache an independent lifecycle writer.
  await reduceFundingOperationInTransaction(client, {
    operationId: input.target.operationId,
    now: input.now,
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
      now,
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
