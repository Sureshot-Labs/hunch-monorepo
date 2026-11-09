import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { canonicalJsonHash } from "./canonical.js";
import {
  initialFundingEvidenceRepairState,
  parseFundingEvidenceRepairState,
  type FundingEvidenceRepairState,
} from "../reconciliation/funding-evidence-repair-state.js";

type Queryable = Pick<PoolClient, "query">;

export type FundingEvidenceRepairSnapshot = Readonly<{
  operationId: string;
  operationStatus: string;
  recoveryMode: string | null;
  expired: boolean;
  stopped: boolean;
  compatible: boolean;
  evidenceOnly: boolean;
  metadata: Record<string, unknown>;
  repair: FundingEvidenceRepairState | null;
  inputDigest: string;
  providerNeeded: boolean;
  destinationNeeded: boolean;
  postconditionNeeded: boolean;
  jobStatus: string | null;
  nextProbeAt: Date | null;
}>;

export type FundingEvidenceRepairInspection = Readonly<{
  operationStatus: string;
  recoveryMode: string | null;
  expired: boolean;
  stopped: boolean;
  compatible: boolean;
  evidenceOnly: boolean;
  state: FundingEvidenceRepairState["state"] | null;
  generation: number;
  processedGeneration: number;
  reason: FundingEvidenceRepairState["reason"] | null;
  lastProbe: FundingEvidenceRepairState["lastProbe"];
  jobStatus: string | null;
  nextProbeAt: string | null;
}>;

/** No API env, executor, provider, or reducer imports: safe for an offline CLI. */
export async function loadFundingEvidenceRepairSnapshot(
  db: Queryable,
  operationId: string,
  now = new Date(),
): Promise<FundingEvidenceRepairSnapshot | null> {
  const result = await db.query<{
    status: string;
    recovery_mode: string | null;
    expires_at: Date;
    support_metadata: Record<string, unknown>;
    all_actions_expired: boolean;
    provider_needed: boolean;
    broadcast_destination_needed: boolean;
    postcondition_needed: boolean;
    job_status: string | null;
    due_at: Date | number | null;
    facts: unknown;
  }>(
    `select operation_row.status, operation_row.recovery_mode,
       operation_row.expires_at, operation_row.support_metadata,
       exists (select 1 from funding_operation_steps action_row where action_row.operation_id=operation_row.id)
       and not exists (select 1 from funding_operation_steps action_row where action_row.operation_id=operation_row.id
         and (action_row.action_expires_at is null or action_row.action_expires_at > $2)) as all_actions_expired,
       exists (select 1 from funding_operation_segments segment_row join funding_provider_requests request_row
         on request_row.segment_id=segment_row.id where segment_row.operation_id=operation_row.id) as provider_needed,
       exists (select 1 from funding_operation_steps action_row
         join funding_operation_step_attempts attempt_row on attempt_row.step_id=action_row.id
         where action_row.operation_id=operation_row.id and attempt_row.broadcast_may_have_occurred
           and action_row.action_validation_result->>'relayStepKind' is distinct from 'approve') as broadcast_destination_needed,
       exists (select 1 from funding_step_receipt_observations receipt_row
         where receipt_row.operation_id=operation_row.id and receipt_row.action_match and receipt_row.canonical
           and receipt_row.status in ('confirmed','finalized')) as postcondition_needed,
       job_row.status as job_status, job_row.due_at,
       jsonb_build_object(
         'plan',operation_row.plan_hash,
         'actions',coalesce((select jsonb_agg(jsonb_build_object(
           'id',action_row.id,'action',action_row.action_fingerprint,
           'validation',action_row.action_validation_result,'payer',action_row.payer_requirement)
           order by action_row.ordinal) from funding_operation_steps action_row where action_row.operation_id=operation_row.id),'[]'::jsonb),
         'attempts',coalesce((select jsonb_agg(jsonb_build_object(
           'id',attempt_row.id,'outcome',attempt_row.outcome,'broadcast',attempt_row.broadcast_may_have_occurred,
           'reference',attempt_row.receipt_ref_lookup_hmac,'keyVersion',attempt_row.lookup_key_version,
           'referenceKind',attempt_row.reference_kind,
           'retryableAfterReorg',attempt_row.actual_costs->'retryableAfterReorg',
           'retryableProviderFailure',attempt_row.actual_costs->'retryableProviderFailure')
           order by action_row.ordinal,attempt_row.attempt_number)
           from funding_operation_steps action_row join funding_operation_step_attempts attempt_row on attempt_row.step_id=action_row.id
           where action_row.operation_id=operation_row.id),'[]'::jsonb),
         'receipts',coalesce((select jsonb_agg(jsonb_build_object(
           'attempt',receipt_row.attempt_id,'status',receipt_row.status,'match',receipt_row.action_match,
           'canonical',receipt_row.canonical,'height',receipt_row.ledger_height,'block',receipt_row.block_hash,
           'failure',receipt_row.failure_code,'evidence',jsonb_build_object(
             'transactionHash',receipt_row.evidence->'transactionHash',
             'transactionSignature',receipt_row.evidence->'transactionSignature',
             'failureFinalized',receipt_row.evidence->'failureFinalized',
             'attributedSourceRaw',receipt_row.evidence->'attributedSourceRaw',
             'attributedDestinationRaw',receipt_row.evidence->'attributedDestinationRaw',
             'sourceDebitEventIndex',receipt_row.evidence->'sourceDebitEventIndex',
             'handoffEventIndex',receipt_row.evidence->'handoffEventIndex',
             'signedTransactionExpired',receipt_row.evidence->'signedTransactionExpired'))
           order by receipt_row.attempt_id) from funding_step_receipt_observations receipt_row
           where receipt_row.operation_id=operation_row.id),'[]'::jsonb),
         'providers',coalesce((select jsonb_agg(jsonb_build_object(
           'id',request_row.id,'reference',request_row.request_ref_lookup_hmac,'keyVersion',request_row.lookup_key_version,
           'status',request_row.raw_status,'category',request_row.support_metadata->'relayStatusCategory',
           'references',request_row.support_metadata->'relayTransactionReferenceFingerprints',
           'required',request_row.support_metadata->'relayRequiredEvidence',
           'failure',request_row.support_metadata->'providerFailureCode',
           'refundFailure',request_row.support_metadata->'providerRefundFailureCode') order by request_row.id)
           from funding_operation_segments segment_row join funding_provider_requests request_row on request_row.segment_id=segment_row.id
           where segment_row.operation_id=operation_row.id),'[]'::jsonb),
         'transfers',coalesce((select jsonb_agg(jsonb_build_object(
           'id',observation_row.id,'kind',observation_row.kind,'tx',observation_row.tx_hash,
           'event',observation_row.event_index,'asset',observation_row.asset_id,'raw',observation_row.raw_amount,
           'finality',observation_row.finality_status,'canonical',observation_row.canonical,'block',observation_row.block_hash,
           'metadata',jsonb_build_object(
             'receiptAttemptId',observation_row.metadata->'receiptAttemptId',
             'replacementForTransferId',observation_row.metadata->'replacementForTransferId',
             'handoffPhysicalIdentityValid',observation_row.metadata->'handoffPhysicalIdentityValid')) order by observation_row.id)
           from funding_observations observation_row where observation_row.operation_id=operation_row.id),'[]'::jsonb),
         'reservations',coalesce((select jsonb_agg(jsonb_build_object(
           'id',reservation_row.id,'mode',reservation_row.mode,'state',reservation_row.state,
           'raw',reservation_row.raw_amount,'expired',reservation_row.expires_at <= $2) order by reservation_row.id)
           from balance_reservations reservation_row where reservation_row.operation_id=operation_row.id),'[]'::jsonb)
       ) as facts
     from funding_operations operation_row
     left join funding_reconciliation_jobs job_row on job_row.operation_id=operation_row.id
     where operation_row.id=$1`,
    [operationId, now],
  );
  const row = result.rows[0];
  if (!row) return null;
  const evidenceOnly =
    typeof row.support_metadata.evidenceOnlyRecoveryAt === "string";
  return {
    operationId,
    operationStatus: row.status,
    recoveryMode: row.recovery_mode,
    expired: row.expires_at <= now,
    stopped: evidenceOnly || row.expires_at <= now || row.all_actions_expired,
    compatible:
      !("evidenceRepairV1" in row.support_metadata) ||
      parseFundingEvidenceRepairState(row.support_metadata.evidenceRepairV1) !==
        null,
    evidenceOnly,
    metadata: row.support_metadata,
    repair: parseFundingEvidenceRepairState(
      row.support_metadata.evidenceRepairV1,
    ),
    inputDigest: canonicalJsonHash(row.facts),
    providerNeeded: row.provider_needed,
    destinationNeeded:
      row.provider_needed ||
      row.postcondition_needed ||
      row.broadcast_destination_needed,
    postconditionNeeded: row.postcondition_needed,
    jobStatus: row.job_status,
    nextProbeAt: row.due_at instanceof Date ? row.due_at : null,
  };
}

function inspection(
  snapshot: FundingEvidenceRepairSnapshot,
): FundingEvidenceRepairInspection {
  return {
    operationStatus: snapshot.operationStatus,
    recoveryMode: snapshot.recoveryMode,
    expired: snapshot.expired,
    stopped: snapshot.stopped,
    compatible: snapshot.compatible,
    evidenceOnly: snapshot.evidenceOnly,
    state: snapshot.repair?.state ?? null,
    generation: snapshot.repair?.generation ?? 0,
    processedGeneration: snapshot.repair?.processedGeneration ?? 0,
    reason: snapshot.repair?.reason ?? null,
    lastProbe: snapshot.repair?.lastProbe ?? null,
    jobStatus: snapshot.jobStatus,
    nextProbeAt: snapshot.nextProbeAt?.toISOString() ?? null,
  };
}

export async function inspectFundingEvidenceRepair(
  db: Queryable,
  operationId: string,
): Promise<FundingEvidenceRepairInspection | null> {
  const snapshot = await loadFundingEvidenceRepairSnapshot(db, operationId);
  return snapshot ? inspection(snapshot) : null;
}

export class FundingEvidenceRepairRequestError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "operation_not_found"
      | "operation_not_stopped"
      | "incompatible_repair_state",
  ) {
    super(code);
    this.name = "FundingEvidenceRepairRequestError";
  }
}

/** Requests observation/accounting only. Idempotency and old-consent detachment are durable. */
export async function requestFundingEvidenceRepair(
  pool: Pool,
  input: Readonly<{ operationId: string; idempotencyKey: string; now?: Date }>,
): Promise<
  Readonly<{
    replayed: boolean;
    generation: number;
    inspection: FundingEvidenceRepairInspection;
  }>
> {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      input.operationId,
    ) ||
    input.idempotencyKey.trim().length < 1 ||
    input.idempotencyKey.length > 200
  )
    throw new FundingEvidenceRepairRequestError("invalid_request");
  const key = canonicalJsonHash({ idempotencyKey: input.idempotencyKey });
  const now = input.now ?? new Date();
  return tx(pool, async (client) => {
    await client.query(
      `select id from telegram_trade_intents where funding_operation_id=$1 order by id for update`,
      [input.operationId],
    );
    await client.query(
      `select id from funding_operations where id=$1 for update`,
      [input.operationId],
    );
    const snapshot = await loadFundingEvidenceRepairSnapshot(
      client,
      input.operationId,
      now,
    );
    if (!snapshot)
      throw new FundingEvidenceRepairRequestError("operation_not_found");
    if (!snapshot.compatible)
      throw new FundingEvidenceRepairRequestError("incompatible_repair_state");
    if (!snapshot.stopped)
      throw new FundingEvidenceRepairRequestError("operation_not_stopped");
    const previous = snapshot.repair ?? initialFundingEvidenceRepairState();
    const replayGeneration = previous.requestKeys[key];
    if (replayGeneration !== undefined)
      return {
        replayed: true,
        generation: replayGeneration,
        inspection: inspection(snapshot),
      };
    const generation = previous.generation + 1;
    const next: FundingEvidenceRepairState = {
      ...previous,
      generation,
      state: "requested",
      reason: "new_evidence",
      requestKeys: { ...previous.requestKeys, [key]: generation },
      retryCount: 0,
      retryStartedAt: null,
    };
    await client.query(
      `update funding_operations set support_metadata=support_metadata || jsonb_build_object(
         'evidenceOnlyRecoveryAt',coalesce(support_metadata->>'evidenceOnlyRecoveryAt',$2::text),
         'evidenceRepairV1',$3::jsonb), version=version+1, updated_at=$4 where id=$1`,
      [input.operationId, now.toISOString(), JSON.stringify(next), now],
    );
    await client.query(
      `insert into funding_reconciliation_jobs(operation_id,status,due_at) values($1,'scheduled',$2)
       on conflict(operation_id) do update set due_at=least(funding_reconciliation_jobs.due_at,excluded.due_at),
         status=case when funding_reconciliation_jobs.status='leased' and funding_reconciliation_jobs.lease_until>$2
           then 'leased' else 'scheduled' end,
         lease_owner=case when funding_reconciliation_jobs.status='leased' and funding_reconciliation_jobs.lease_until>$2
           then funding_reconciliation_jobs.lease_owner else null end,
         lease_token=case when funding_reconciliation_jobs.status='leased' and funding_reconciliation_jobs.lease_until>$2
           then funding_reconciliation_jobs.lease_token else null end,
         lease_until=case when funding_reconciliation_jobs.status='leased' and funding_reconciliation_jobs.lease_until>$2
           then funding_reconciliation_jobs.lease_until else null end, completed_at=null`,
      [input.operationId, now],
    );
    const refreshed = await loadFundingEvidenceRepairSnapshot(
      client,
      input.operationId,
      now,
    );
    if (!refreshed)
      throw new FundingEvidenceRepairRequestError("operation_not_found");
    return { replayed: false, generation, inspection: inspection(refreshed) };
  });
}
