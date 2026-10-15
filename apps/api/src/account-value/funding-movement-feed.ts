import type { Pool } from "@hunch/infra";

import type {
  AssetRef,
  AssetLocation,
  ObservedAsset,
  ValuedAssetComponent,
} from "../funding/domain/types.js";
import { scaleUnsignedDecimalByRawRatio, subtractRawFloor } from "./decimal.js";
import { fundingReservationHoldSql } from "../funding/persistence/source-reservation-hold.js";
import { isHypercoreMainnetUsdc } from "../funding/domain/hypercore-identity.js";
import {
  sameAsset,
  sameAccountAddress,
} from "../funding/domain/asset-identity.js";
import { assetLocationSchema, moneySchema } from "../funding/domain/schemas.js";
import { isRecord } from "../lib/type-guards.js";
import { RELAY_ROUTE_SPECS } from "../funding-providers/relay/mappings.js";
import {
  readFundingRefundContract,
  readFundingRefundReceiptIdentity,
  readFundingRefundCompletionProofs,
  fundingRefundReceiptMatchesContract,
  type FundingRefundSettledReceipt,
} from "../funding/domain/refund-settlement.js";
import { projectFundingRefundClaim } from "./funding-refund-claim.js";
import type { CollectorError } from "./account-value-projector.js";

const exactEvmSourceAssets = [
  RELAY_ROUTE_SPECS["base-usdc-to-hypercore-spot-usdc"].source,
  RELAY_ROUTE_SPECS["polygon-usdc-to-hypercore-spot-usdc"].source,
];

/** A completed transfer stops being in transit, but cannot restore cash in an
 * older cached source snapshot. Read only the indexed post-snapshot tail of
 * exact owned native sources; never aggregate different observation times. */
export const FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL = `
  select source_snapshot.component_id as source_component_id,
    source_snapshot.location_id as source_location_id,
    debit.operation_id, debit.segment_id, debit.network_id, debit.asset_id,
    source_snapshot.asset_decimals, debit.raw_amount,
    coalesce(debit.finalized_at, debit.observed_at) as observed_at
  from jsonb_to_recordset($2::jsonb) as source_snapshot(
    component_id text, location_id text, address text, asset_decimals integer,
    snapshot_at timestamptz)
  join funding_observations debit
    on debit.network_id='hyperliquid:mainnet'
      and debit.asset_id='0x6d1e7cde53ba9467b783cb7c530ce054'
      and debit.asset_decimals=source_snapshot.asset_decimals
      and lower(debit.from_address)=source_snapshot.address
      and coalesce(debit.finalized_at, debit.observed_at)>source_snapshot.snapshot_at
      and debit.kind='source_debit' and debit.canonical
      and debit.finality_status='finalized'
  join funding_operations operation_row
    on operation_row.id=debit.operation_id and operation_row.user_id=$1
  where exists (
    select 1 from balance_reservations reservation_row
    where reservation_row.operation_id=debit.operation_id
      and reservation_row.user_id=$1
      and reservation_row.segment_id is not distinct from debit.segment_id
      and (source_snapshot.component_id is null or reservation_row.component_id=source_snapshot.component_id)
      and reservation_row.location_id=source_snapshot.location_id
      and reservation_row.network_id=debit.network_id
      and reservation_row.asset_id=debit.asset_id
      and reservation_row.asset_decimals=source_snapshot.asset_decimals
      and reservation_row.mode='subtract_available'
  )`;

export async function loadFundingNativeSnapshotDebits(
  pool: Pick<Pool, "query">,
  userId: string,
  components: readonly ValuedAssetComponent[],
): Promise<readonly FundingInTransitFact[]> {
  const snapshots = components
    .filter(
      (row) =>
        row.location.accountId === userId &&
        row.location.kind === "venue_account" &&
        row.location.details.nativeSourceDex === "spot" &&
        row.observationFreshness === "fresh" &&
        !row.observationError &&
        isHypercoreMainnetUsdc(row.amount.asset) &&
        typeof row.location.details.address === "string" &&
        /^0x[\da-fA-F]{40}$/.test(row.location.details.address),
    )
    .map((row) => ({
      component_id: row.componentId,
      location_id: row.location.locationId,
      address: String(row.location.details.address).toLowerCase(),
      asset_decimals: row.amount.asset.decimals,
      snapshot_at: row.observedAt,
    }));
  if (!snapshots.length) return [];
  const { rows } = await pool.query<InTransitRow>(
    FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL,
    [userId, JSON.stringify(snapshots)],
  );
  return rows.map((row) => ({
    operationId: row.operation_id,
    segmentId: row.segment_id,
    sourceComponentId: row.source_component_id,
    sourceLocationId: row.source_location_id,
    amount: {
      asset: {
        networkId: row.network_id,
        assetId: row.asset_id,
        decimals: row.asset_decimals,
      },
      raw: row.raw_amount,
    },
    observedAt: row.observed_at.toISOString(),
  }));
}

/** Source receipts remain relevant after terminal settlement. This query reads
 * the exact wallet/token post-snapshot tail, not every historical operation or
 * a cached operation status. It never converts one token into another. */
export const FUNDING_EVM_SNAPSHOT_DEBITS_SQL = `
  select source_snapshot.component_id as source_component_id,
    source_snapshot.location_id as source_location_id,
    debit.operation_id, debit.segment_id, debit.network_id, debit.asset_id,
    debit.asset_decimals, debit.raw_amount,
    coalesce(debit.finalized_at, debit.observed_at) as observed_at
  from jsonb_to_recordset($2::jsonb) as source_snapshot(
    component_id text, location_id text, address text, network_id text,
    asset_id text, asset_decimals integer, snapshot_at timestamptz)
  join funding_observations debit
    on debit.network_id in ('evm:8453','evm:137')
      and debit.network_id=source_snapshot.network_id
      and lower(debit.asset_id)=source_snapshot.asset_id
      and debit.asset_decimals=6
      and debit.asset_decimals=source_snapshot.asset_decimals
      and lower(debit.from_address)=source_snapshot.address
      and coalesce(debit.finalized_at, debit.observed_at)>source_snapshot.snapshot_at
      and debit.kind='source_debit' and debit.canonical
      and debit.finality_status='finalized'
  join funding_operations operation_row
    on operation_row.id=debit.operation_id and operation_row.user_id=$1
  where exists (
    select 1 from balance_reservations reservation_row
    where reservation_row.operation_id=debit.operation_id
      and reservation_row.user_id=$1
      and reservation_row.segment_id is not distinct from debit.segment_id
      and reservation_row.component_id=source_snapshot.component_id
      and reservation_row.location_id=source_snapshot.location_id
      and reservation_row.network_id=debit.network_id
      and lower(reservation_row.asset_id)=lower(debit.asset_id)
      and reservation_row.asset_decimals=debit.asset_decimals
      and reservation_row.mode='subtract_available'
  )`;

export function fundingSnapshotDebitComponents(
  userId: string,
  components: readonly ValuedAssetComponent[],
): readonly ValuedAssetComponent[] {
  return components.filter(
    (row) =>
      row.location.accountId === userId &&
      row.observationFreshness === "fresh" &&
      !row.observationError &&
      sameAsset(row.location.asset, row.amount.asset) &&
      typeof row.location.details.address === "string" &&
      /^0x[\da-fA-F]{40}$/.test(row.location.details.address) &&
      Number.isFinite(Date.parse(row.observedAt)) &&
      ((row.location.kind === "venue_account" &&
        row.location.details.nativeSourceDex === "spot" &&
        isHypercoreMainnetUsdc(row.amount.asset)) ||
        (row.location.kind === "wallet" &&
          exactEvmSourceAssets.some((asset) =>
            sameAsset(asset, row.amount.asset),
          ))),
  );
}

export async function loadFundingSnapshotDebits(
  pool: Pick<Pool, "query">,
  userId: string,
  components: readonly ValuedAssetComponent[],
): Promise<readonly FundingInTransitFact[]> {
  const eligible = fundingSnapshotDebitComponents(userId, components);
  const snapshots = eligible
    .filter((row) => row.location.kind === "wallet")
    .map((row) => ({
      component_id: row.componentId,
      location_id: row.location.locationId,
      address: String(row.location.details.address).toLowerCase(),
      network_id: row.amount.asset.networkId,
      asset_id: row.amount.asset.assetId.toLowerCase(),
      asset_decimals: row.amount.asset.decimals,
      snapshot_at: row.observedAt,
    }));
  const [native, evm] = await Promise.all([
    loadFundingNativeSnapshotDebits(pool, userId, eligible),
    snapshots.length
      ? pool.query<InTransitRow>(FUNDING_EVM_SNAPSHOT_DEBITS_SQL, [
          userId,
          JSON.stringify(snapshots),
        ])
      : Promise.resolve({ rows: [] as InTransitRow[] }),
  ]);
  return [
    ...native,
    ...evm.rows.map((row) => ({
      operationId: row.operation_id,
      segmentId: row.segment_id,
      sourceComponentId: row.source_component_id,
      sourceLocationId: row.source_location_id,
      amount: {
        asset: {
          networkId: row.network_id,
          assetId: row.asset_id,
          decimals: row.asset_decimals,
        },
        raw: row.raw_amount,
      },
      observedAt: row.observed_at.toISOString(),
    })),
  ];
}

export type FundingAvailabilityFact = Readonly<{
  componentId: string;
  reservedRaw: string;
  submittedDebitRaw: string;
  submittedDebitObservedAt: string | null;
}>;

export type FundingInTransitFact = Readonly<{
  operationId: string;
  segmentId: string | null;
  sourceComponentId: string | null;
  sourceLocationId: string | null;
  /** Validated frozen source, independent of a missing/corrupt reservation. */
  committedSourceLocation?:
    | (Omit<AssetLocation, "details"> & {
        readonly details: Readonly<Record<string, unknown>>;
      })
    | null;
  amount: Readonly<{
    asset: AssetRef;
    raw: string;
  }>;
  observedAt: string;
  observationError?: string | null;
}>;

/** An unregistered erroneous claim may be excluded by valuation policy. It is
 * still an accounting gap, not evidence that the headline is complete. */
export function fundingMovementErrors(
  facts: readonly FundingInTransitFact[],
): readonly CollectorError[] {
  return [
    ...new Set(
      facts.flatMap((fact) =>
        fact.observationError ? [fact.observationError] : [],
      ),
    ),
  ].map((code) => ({
    collectorId: "funding-in-transit",
    code,
    retryable: true,
  }));
}

/** Fence only the owned physical source. A missing reservation cannot supply a
 * component ID, and mismatched evidence must not relabel its actual asset. */
export function fundingInvalidSourceComponentIds(
  userId: string,
  facts: readonly FundingInTransitFact[],
  components: readonly ValuedAssetComponent[],
): ReadonlySet<string> {
  const invalid = facts.filter(
    (fact) => fact.observationError === "funding_source_evidence_invalid",
  );
  return new Set(
    components
      .filter(
        (component) =>
          component.location.accountId === userId &&
          invalid.some((fact) => {
            // A fresh physical balance after this evidence is usable even if
            // historical attribution still needs repair. Do not strand cash
            // behind an unrelated immutable-history defect.
            const snapshotAt = Date.parse(component.observedAt);
            const evidenceAt = Date.parse(fact.observedAt);
            if (
              component.observationFreshness === "fresh" &&
              !component.observationError &&
              Number.isFinite(snapshotAt) &&
              Number.isFinite(evidenceAt) &&
              snapshotAt >= evidenceAt
            )
              return false;
            const source = fact.committedSourceLocation;
            if (!source)
              return (
                fact.sourceComponentId === component.componentId &&
                fact.sourceLocationId === component.location.locationId &&
                sameAsset(fact.amount.asset, component.amount.asset)
              );
            return (
              source.accountId === userId &&
              source.kind === component.location.kind &&
              source.locationId === component.location.locationId &&
              sameAsset(source.asset, component.location.asset) &&
              sameAsset(source.asset, component.amount.asset) &&
              typeof source.details.address === "string" &&
              typeof component.location.details.address === "string" &&
              sameAccountAddress(
                source.asset.networkId,
                source.details.address,
                component.location.details.address,
              )
            );
          }),
      )
      .map((component) => component.componentId),
  );
}

export type FundingRefundBalanceChange = Readonly<{
  operationId: string;
  locationId: string;
  asset: AssetRef;
  observedAt: string;
  invalidated: boolean;
  nativeDestinationDex: "spot" | "" | null;
}>;

/** A receipt or its invalidation does not prove that cached cash reflects it. */
export function fundingRefundSnapshotLagOperations(
  changes: readonly FundingRefundBalanceChange[],
  components: readonly ValuedAssetComponent[],
): ReadonlySet<string> {
  return new Set(
    changes
      .filter(
        (credit) =>
          !components.some(
            (component) =>
              component.location.locationId === credit.locationId &&
              sameAsset(component.amount.asset, credit.asset) &&
              component.observationFreshness === "fresh" &&
              !component.observationError &&
              Date.parse(component.observedAt) >= Date.parse(credit.observedAt),
          ),
      )
      .map((credit) => credit.operationId),
  );
}

/** An invalidated credit may still be included in cached target cash. Fence
 * only that physical asset until a normal balance refresh observes the reorg. */
export function fundingInvalidatedRefundComponentIds(
  changes: readonly FundingRefundBalanceChange[],
  components: readonly ValuedAssetComponent[],
): ReadonlySet<string> {
  return new Set(
    components
      .filter((component) =>
        changes.some(
          (change) =>
            change.invalidated &&
            change.locationId === component.location.locationId &&
            sameAsset(change.asset, component.amount.asset) &&
            !(
              component.observationFreshness === "fresh" &&
              !component.observationError &&
              Date.parse(component.observedAt) >= Date.parse(change.observedAt)
            ),
        ),
      )
      .map((component) => component.componentId),
  );
}

export type FundingAccountValueFacts = Readonly<{
  schemaReady: boolean;
  availability: readonly FundingAvailabilityFact[];
  inTransit: readonly FundingInTransitFact[];
  refundBalanceChanges: readonly FundingRefundBalanceChange[];
}>;

type AvailabilityRow = {
  component_id: string;
  reserved_raw: string;
  submitted_debit_raw: string;
  submitted_debit_observed_at: Date | null;
};

type InTransitRow = {
  operation_id: string;
  segment_id: string | null;
  source_component_id: string | null;
  source_location_id: string | null;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  raw_amount: string;
  observed_at: Date;
};

type RefundMovementRow = InTransitRow & {
  committed_source: unknown;
  committed_input: unknown;
  source_network_count: string | number;
  source_asset_count: string | number;
  source_decimal_count: string | number;
  source_actual_decimals: number;
  source_owner_count: string | number;
  source_owner_complete: boolean;
  source_owner_address: string | null;
  reservation_component_id: string | null;
  reservation_location_id: string | null;
  refund_location_snapshot: unknown;
  provider_quote_ref_lookup_hmac: string | null;
  lookup_key_version: number | null;
  refund_receipts: (FundingRefundSettledReceipt & {
    observedAt: string;
    canonical: boolean;
    finalityStatus: string;
    reorgedAt: string | null;
  })[];
};

async function isFundingAccountValueSchemaReady(
  pool: Pick<Pool, "query">,
): Promise<boolean> {
  const { rows } = await pool.query<{ ready: boolean }>(
    `
      select
        to_regclass('public.funding_operations') is not null
        and to_regclass('public.funding_observations') is not null
        and to_regclass('public.balance_reservations') is not null
        as ready
    `,
  );
  return rows[0]?.ready === true;
}

export async function loadFundingAccountValueFacts(
  pool: Pick<Pool, "query">,
  userId: string,
): Promise<FundingAccountValueFacts> {
  if (!(await isFundingAccountValueSchemaReady(pool))) {
    return {
      schemaReady: false,
      availability: [],
      inTransit: [],
      refundBalanceChanges: [],
    };
  }

  const [availabilityResult, movementResult] = await Promise.all([
    pool.query<AvailabilityRow>(
      `
        with active_reservations as (
          select
            component_id,
            sum(raw_amount::numeric)::text as reserved_raw
          from balance_reservations
          where balance_reservations.user_id = $1
            and balance_reservations.state = 'active'
            and ${fundingReservationHoldSql("balance_reservations")}
            and not exists (
              select 1
              from funding_observations observation
              where observation.operation_id =
                    balance_reservations.operation_id
                and observation.segment_id is not distinct from
                    balance_reservations.segment_id
                and observation.kind = 'source_debit'
                and observation.canonical
                and observation.finality_status = 'finalized'
            )
          group by component_id
        ),
        submitted_debits as (
          select
            reservation.component_id,
            sum(observation.raw_amount::numeric)::text as submitted_debit_raw,
            max(
              coalesce(observation.finalized_at, observation.observed_at)
            ) as submitted_debit_observed_at
          from funding_operations operation
          join balance_reservations reservation
            on reservation.operation_id = operation.id
           and reservation.mode = 'subtract_available'
          join funding_observations observation
            on observation.operation_id = operation.id
           and observation.segment_id is not distinct from
               reservation.segment_id
           and observation.kind = 'source_debit'
           and observation.canonical
           and observation.finality_status = 'finalized'
          where operation.user_id = $1
            and not exists (
              select 1
              from funding_observations replacement
              where replacement.operation_id = operation.id
                and replacement.segment_id is not distinct from
                    reservation.segment_id
                and replacement.kind in ('destination_credit', 'refund_credit')
                and replacement.canonical
                and replacement.finality_status = 'finalized'
            )
          group by reservation.component_id
        ),
        component_ids as (
          select component_id from active_reservations
          union
          select component_id from submitted_debits
        )
        select
          component.component_id,
          coalesce(reservation.reserved_raw, '0') as reserved_raw,
          coalesce(debit.submitted_debit_raw, '0') as submitted_debit_raw,
          debit.submitted_debit_observed_at
        from component_ids component
        left join active_reservations reservation
          on reservation.component_id = component.component_id
        left join submitted_debits debit
          on debit.component_id = component.component_id
        order by component.component_id
      `,
      [userId],
    ),
    pool.query<RefundMovementRow>(
      `
        with owned_operations as materialized (
          select id,user_id,source_snapshot,requested_source_amount,created_at
          from funding_operations where user_id=$1
        )
        select
          operation.id as operation_id,
          source.segment_id,
          coalesce(
            nullif(operation.source_snapshot->>'componentId', ''),
            reservation.component_id
          ) as source_component_id,
          coalesce(
            nullif(operation.source_snapshot->>'locationId', ''),
            reservation.location_id
          ) as source_location_id,
          source.network_id,
          source.asset_id,
          coalesce(
            (segment.quoted_input #>> '{asset,decimals}')::integer,
            (operation.requested_source_amount #>> '{asset,decimals}')::integer
          )
            as asset_decimals,
          source.raw_amount,
          source.observed_at,
          segment.source_snapshot as committed_source, segment.quoted_input as committed_input,
          source.network_count as source_network_count, source.asset_count as source_asset_count,
          source.decimal_count as source_decimal_count, source.actual_decimals as source_actual_decimals,
          source.owner_count as source_owner_count, source.owner_complete as source_owner_complete,
          source.owner_address as source_owner_address,
          reservation.component_id as reservation_component_id,
          reservation.location_id as reservation_location_id,
          segment.refund_location_snapshot,
          segment.provider_quote_ref_lookup_hmac,
          segment.lookup_key_version,
          coalesce((select jsonb_agg(jsonb_build_object(
            'observationId', refund_row.id,
            'money', jsonb_build_object('raw',refund_row.raw_amount::text,
              'asset',jsonb_build_object('networkId',refund_row.network_id,'assetId',refund_row.asset_id,'decimals',refund_row.asset_decimals)),
            'destinationAddress',refund_row.to_address,
            'nativeDestinationDex',refund_row.metadata->'nativeDestinationDex',
            'identity',refund_row.metadata->'relayRefundReceipt',
            'completionProofs',refund_row.metadata->'relayRefundCompletionProofs',
            'observedAt',coalesce(refund_row.finalized_at,refund_row.observed_at),
            'canonical',refund_row.canonical,'finalityStatus',refund_row.finality_status,
            'reorgedAt',refund_row.reorged_at))
            from funding_observations refund_row
            where refund_row.operation_id=operation.id
              and refund_row.segment_id is not distinct from source.segment_id
              and refund_row.kind='refund_credit'), '[]'::jsonb) as refund_receipts
        from owned_operations operation
        join lateral (
          -- Parameterize the indexed debit aggregate per owned operation.
          -- A generic plan must not rerun the entire user's source history
          -- once for every operation when it underestimates a prolific user.
          select segment_id,
            min(network_id) as network_id,
            min(asset_id) as asset_id,
            count(distinct network_id) as network_count,
            count(distinct asset_id) as asset_count,
            count(distinct asset_decimals) as decimal_count,
            min(asset_decimals) as actual_decimals,
            count(distinct lower(from_address)) as owner_count,
            bool_and(from_address is not null) as owner_complete,
            min(lower(from_address)) as owner_address,
            sum(raw_amount::numeric)::text as raw_amount,
            max(coalesce(finalized_at, observed_at)) as observed_at
          from funding_observations evidence
          where evidence.operation_id=operation.id
            and kind='source_debit' and canonical and finality_status='finalized'
          group by segment_id
        ) source on true
        left join funding_operation_segments segment
          on segment.operation_id = operation.id
         and segment.id = source.segment_id
        left join lateral (
          select component_id, location_id
          from balance_reservations
          where operation_id = operation.id
            and mode = 'subtract_available'
            and segment_id is not distinct from source.segment_id
            and (not coalesce(segment.refund_location_snapshot ? 'refundEvidenceContract',false) or (
              user_id=operation.user_id
              and location_id=segment.source_snapshot#>>'{location,locationId}'
              and network_id=segment.quoted_input#>>'{asset,networkId}'
              and lower(asset_id)=lower(segment.quoted_input#>>'{asset,assetId}')
              and asset_decimals::text=segment.quoted_input#>>'{asset,decimals}'
              and raw_amount=segment.quoted_input->>'raw'
            ))
          order by created_at asc
          limit 1
        ) reservation on true
        where operation.user_id = $1
          and (coalesce(segment.refund_location_snapshot ? 'refundEvidenceContract',false) or (
          reservation.component_id is not null
          and source.network_count = 1
          and source.asset_count = 1
          and coalesce(
                segment.quoted_input #>> '{asset,networkId}',
                operation.requested_source_amount #>> '{asset,networkId}'
              )
            = source.network_id
          and case when source.network_id like 'evm:%' or source.network_id like 'hyperliquid:%'
            then lower(coalesce(
                segment.quoted_input #>> '{asset,assetId}',
                operation.requested_source_amount #>> '{asset,assetId}'
              )) = lower(source.asset_id)
            else coalesce(
                segment.quoted_input #>> '{asset,assetId}',
                operation.requested_source_amount #>> '{asset,assetId}'
              )
            = source.asset_id end))
          and not exists (
            select 1
            from funding_observations replacement
            where replacement.operation_id = operation.id
              and replacement.segment_id is not distinct from
                  source.segment_id
              and (replacement.kind='destination_credit' or
                (replacement.kind='refund_credit' and
                 not coalesce(segment.refund_location_snapshot ? 'refundEvidenceContract',false)))
              and replacement.canonical
              and replacement.finality_status = 'finalized'
          )
        order by operation.created_at, operation.id
      `,
      [userId],
    ),
  ]);

  const refundBalanceChanges: FundingRefundBalanceChange[] = [];
  const inTransit = movementResult.rows.flatMap(
    (row): FundingInTransitFact[] => {
      const fact: FundingInTransitFact = {
        operationId: row.operation_id,
        segmentId: row.segment_id,
        sourceComponentId: row.source_component_id,
        sourceLocationId: row.source_location_id,
        amount: {
          asset: {
            networkId: row.network_id,
            assetId: row.asset_id,
            decimals: row.asset_decimals,
          },
          raw: row.raw_amount,
        },
        observedAt: row.observed_at.toISOString(),
      };
      const contract = readFundingRefundContract(row.refund_location_snapshot, {
        requestFingerprint: row.provider_quote_ref_lookup_hmac,
        lookupKeyVersion: row.lookup_key_version,
      });
      if (contract === null) return [fact];
      // A new physical observation is not validated by event deduplication.
      // Validate the ENTIRE source set, not a conveniently matching subset.
      const committedSource =
        isRecord(row.committed_source) &&
        row.committed_source.kind === "owned_location"
          ? assetLocationSchema.safeParse(row.committed_source.location)
          : null;
      const committedInput = moneySchema.safeParse(row.committed_input);
      const sourceValid =
        committedSource?.success &&
        committedInput.success &&
        committedSource.data.accountId === userId &&
        sameAsset(committedSource.data.asset, committedInput.data.asset) &&
        String(row.source_network_count) === "1" &&
        String(row.source_asset_count) === "1" &&
        String(row.source_decimal_count) === "1" &&
        String(row.source_owner_count) === "1" &&
        row.source_owner_complete &&
        sameAsset(
          { ...fact.amount.asset, decimals: row.source_actual_decimals },
          committedInput.data.asset,
        ) &&
        typeof committedSource.data.details.address === "string" &&
        row.source_owner_address !== null &&
        sameAccountAddress(
          committedSource.data.asset.networkId,
          committedSource.data.details.address,
          row.source_owner_address,
        ) &&
        row.reservation_component_id !== null &&
        row.reservation_location_id === committedSource.data.locationId &&
        BigInt(fact.amount.raw) <= BigInt(committedInput.data.raw);
      const allReceipts = row.refund_receipts.map((receipt) => ({
        ...receipt,
        identity: readFundingRefundReceiptIdentity(receipt.identity),
        completionProofs: readFundingRefundCompletionProofs(
          receipt.completionProofs,
        ),
      }));
      for (const receipt of allReceipts) {
        const changeAt =
          receipt.canonical && receipt.finalityStatus === "finalized"
            ? receipt.observedAt
            : receipt.finalityStatus === "reorged"
              ? receipt.reorgedAt
              : null;
        if (
          changeAt &&
          receipt.identity &&
          fundingRefundReceiptMatchesContract(contract, receipt)
        )
          refundBalanceChanges.push({
            operationId: fact.operationId,
            locationId: receipt.identity.refundLocationId,
            asset: receipt.money.asset,
            observedAt: changeAt,
            invalidated: receipt.finalityStatus === "reorged",
            nativeDestinationDex: receipt.nativeDestinationDex,
          });
      }
      const claim = sourceValid
        ? projectFundingRefundClaim({
            source: fact.amount,
            contract,
            receipts: allReceipts.filter(
              (receipt) =>
                receipt.canonical && receipt.finalityStatus === "finalized",
            ),
          })
        : {
            kind: "unpriced" as const,
            reason: "funding_source_evidence_invalid",
          };
      if (claim.kind === "complete") return [];
      return [
        {
          ...fact,
          sourceComponentId:
            row.reservation_component_id ?? fact.sourceComponentId,
          sourceLocationId:
            row.reservation_location_id ?? fact.sourceLocationId,
          committedSourceLocation:
            committedSource?.success &&
            committedSource.data.accountId === userId
              ? committedSource.data
              : null,
          amount: {
            ...fact.amount,
            raw: claim.kind === "pending" ? claim.raw : fact.amount.raw,
          },
          observationError: claim.kind === "unpriced" ? claim.reason : null,
        },
      ];
    },
  );
  return {
    schemaReady: true,
    availability: availabilityResult.rows.map((row) => ({
      componentId: row.component_id,
      reservedRaw: row.reserved_raw,
      submittedDebitRaw: row.submitted_debit_raw,
      submittedDebitObservedAt:
        row.submitted_debit_observed_at?.toISOString() ?? null,
    })),
    inTransit,
    refundBalanceChanges,
  };
}

export function buildFundingInTransitObservations(
  userId: string,
  facts: readonly FundingInTransitFact[],
): readonly ObservedAsset[] {
  return facts.map((fact) => {
    const movementId = `${fact.operationId}:${fact.segmentId ?? "operation"}`;
    return {
      componentId: `funding-movement:${movementId}`,
      location: {
        kind: "in_transit_claim",
        locationId: `funding-in-transit:${movementId}`,
        accountId: userId,
        asset: fact.amount.asset,
        details: {
          movementId,
          operationId: fact.operationId,
          segmentId: fact.segmentId ?? "operation",
          representationStage: "in_transit",
          sourceComponentId: fact.sourceComponentId,
          sourceLocationId: fact.sourceLocationId,
        },
      },
      amount: fact.amount,
      ownershipEvidenceId: `funding-observation:${movementId}`,
      observedAt: fact.observedAt,
      observationFreshness: fact.observationError ? "unknown" : "fresh",
      observationError: fact.observationError
        ? { code: fact.observationError, retryable: true }
        : null,
      metadataRisk: "verified",
    };
  });
}

export function applyFundingSourceDebitSuppression(
  components: readonly ValuedAssetComponent[],
  facts: readonly FundingInTransitFact[],
): readonly ValuedAssetComponent[] {
  const debitByComponent = new Map<string, FundingInTransitFact[]>();
  for (const fact of facts) {
    if (!fact.sourceComponentId) continue;
    const entries = debitByComponent.get(fact.sourceComponentId) ?? [];
    entries.push(fact);
    debitByComponent.set(fact.sourceComponentId, entries);
  }

  return components.map((component) => {
    const debits = debitByComponent.get(component.componentId);
    if (!debits || component.amount.raw === "0") return component;
    const debitRaw = debits
      .filter(
        (debit) =>
          debit.sourceLocationId === component.location.locationId &&
          sameAsset(debit.amount.asset, component.amount.asset) &&
          Date.parse(component.observedAt) < Date.parse(debit.observedAt),
      )
      .reduce((total, debit) => total + BigInt(debit.amount.raw), 0n)
      .toString();
    if (debitRaw === "0") return component;
    const residualRaw = subtractRawFloor(component.amount.raw, [debitRaw]);
    const estimatedUsd =
      component.estimatedUsd == null
        ? null
        : {
            ...component.estimatedUsd,
            value: scaleUnsignedDecimalByRawRatio({
              value: component.estimatedUsd.value,
              numeratorRaw: residualRaw,
              denominatorRaw: component.amount.raw,
            }),
          };
    return {
      ...component,
      amount: { ...component.amount, raw: residualRaw },
      estimatedUsd,
    };
  });
}
