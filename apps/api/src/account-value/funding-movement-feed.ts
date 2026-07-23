import type { Pool } from "@hunch/infra";

import type {
  AssetRef,
  ObservedAsset,
  ValuedAssetComponent,
} from "../funding/domain/types.js";
import { scaleUnsignedDecimalByRawRatio, subtractRawFloor } from "./decimal.js";

export type FundingAvailabilityFact = Readonly<{
  componentId: string;
  reservedRaw: string;
  submittedDebitRaw: string;
  submittedDebitObservedAt: string | null;
}>;

export type FundingInTransitFact = Readonly<{
  operationId: string;
  sourceComponentId: string;
  sourceLocationId: string;
  amount: Readonly<{
    asset: AssetRef;
    raw: string;
  }>;
  observedAt: string;
}>;

export type FundingAccountValueFacts = Readonly<{
  schemaReady: boolean;
  availability: readonly FundingAvailabilityFact[];
  inTransit: readonly FundingInTransitFact[];
}>;

type AvailabilityRow = {
  component_id: string;
  reserved_raw: string;
  submitted_debit_raw: string;
  submitted_debit_observed_at: Date | null;
};

type InTransitRow = {
  operation_id: string;
  source_component_id: string;
  source_location_id: string;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  raw_amount: string;
  observed_at: Date;
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
    return { schemaReady: false, availability: [], inTransit: [] };
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
            and not exists (
              select 1
              from funding_observations observation
              where observation.operation_id =
                    balance_reservations.operation_id
                and observation.kind in ('source_debit', 'source_credit')
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
           and observation.kind = 'source_debit'
           and observation.canonical
           and observation.finality_status = 'finalized'
          where operation.user_id = $1
            and not exists (
              select 1
              from funding_observations replacement
              where replacement.operation_id = operation.id
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
    pool.query<InTransitRow>(
      `
        with source_evidence as (
          select
            operation_id,
            min(network_id) as network_id,
            min(asset_id) as asset_id,
            count(distinct network_id) as network_count,
            count(distinct asset_id) as asset_count,
            sum(raw_amount::numeric)::text as raw_amount,
            max(coalesce(finalized_at, observed_at)) as observed_at
          from funding_observations
          where kind in ('source_debit', 'source_credit')
            and canonical
            and finality_status = 'finalized'
          group by operation_id
        )
        select
          operation.id as operation_id,
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
          (operation.requested_source_amount #>> '{asset,decimals}')::integer
            as asset_decimals,
          source.raw_amount,
          source.observed_at
        from funding_operations operation
        join source_evidence source on source.operation_id = operation.id
        join lateral (
          select component_id, location_id
          from balance_reservations
          where operation_id = operation.id
            and mode = 'subtract_available'
          order by created_at asc
          limit 1
        ) reservation on true
        where operation.user_id = $1
          and source.network_count = 1
          and source.asset_count = 1
          and operation.requested_source_amount #>> '{asset,networkId}'
            = source.network_id
          and operation.requested_source_amount #>> '{asset,assetId}'
            = source.asset_id
          and not exists (
            select 1
            from funding_observations replacement
            where replacement.operation_id = operation.id
              and replacement.kind in ('destination_credit', 'refund_credit')
              and replacement.canonical
              and replacement.finality_status = 'finalized'
          )
        order by operation.created_at, operation.id
      `,
      [userId],
    ),
  ]);

  return {
    schemaReady: true,
    availability: availabilityResult.rows.map((row) => ({
      componentId: row.component_id,
      reservedRaw: row.reserved_raw,
      submittedDebitRaw: row.submitted_debit_raw,
      submittedDebitObservedAt:
        row.submitted_debit_observed_at?.toISOString() ?? null,
    })),
    inTransit: movementResult.rows.map((row) => ({
      operationId: row.operation_id,
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
  };
}

export function buildFundingInTransitObservations(
  userId: string,
  facts: readonly FundingInTransitFact[],
): readonly ObservedAsset[] {
  return facts.map((fact) => ({
    componentId: `funding-movement:${fact.operationId}`,
    location: {
      kind: "in_transit_claim",
      locationId: `funding-in-transit:${fact.operationId}`,
      accountId: userId,
      asset: fact.amount.asset,
      details: {
        movementId: fact.operationId,
        representationStage: "in_transit",
        sourceComponentId: fact.sourceComponentId,
        sourceLocationId: fact.sourceLocationId,
      },
    },
    amount: fact.amount,
    ownershipEvidenceId: `funding-observation:${fact.operationId}`,
    observedAt: fact.observedAt,
    observationFreshness: "fresh",
    observationError: null,
    metadataRisk: "verified",
  }));
}

export function applyFundingSourceDebitSuppression(
  components: readonly ValuedAssetComponent[],
  facts: readonly FundingInTransitFact[],
): readonly ValuedAssetComponent[] {
  const debitByComponent = new Map<string, FundingInTransitFact[]>();
  for (const fact of facts) {
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
