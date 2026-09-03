import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type { JsonValue } from "../domain/types.js";
import { deriveFundingLifecycle } from "../lifecycle/funding-lifecycle-projector.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import { canonicalJsonEqual, canonicalJsonHash } from "./canonical.js";
import {
  consumeFundingReservationInTransaction,
  fetchFundingOperationForUser,
  FundingPersistenceError,
  releaseFundingReservationInTransaction,
  transitionFundingOperationInTransaction,
  type FundingOperationRow,
  wakeFundingReconciliationInTransaction,
  writeFundingOperationLifecycleProjectionCacheInTransaction,
} from "./funding-operation-repository.js";
import {
  acceptFundingTradeAttemptInTransaction,
  hasUnresolvedFundingTradeAttemptInTransaction,
  proveAmbiguousLimitlessFokNoFillInTransaction,
  proveAmbiguousLimitlessTerminalRejectionInTransaction,
  proveAmbiguousLimitlessTradeAttemptAbsentInTransaction,
  recordFundingTradeAttemptOutcomeInTransaction,
  type FundingTradeAttempt,
} from "./funding-trade-attempt-repository.js";
import { persistedTradeTerminalOutcome } from "./funding-trade-consumer-status.js";
import {
  sameFundingTradeConsumerIntent,
  storedFundingTradeConsumerIntentFromRow,
  type FundingTradeConsumerIntent,
} from "./funding-trade-consumer-intent.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type FundingOperationStepState =
  | "planned"
  | "action_required"
  | "submitted"
  | "succeeded"
  | "reconcile_required"
  | "recovery_required"
  | "failed"
  | "cancelled";

export type FundingOperationStep = Readonly<{
  id: string;
  operationId: string;
  segmentId: string | null;
  ordinal: number;
  stepKind:
    | "approval"
    | "transaction"
    | "signature"
    | "external_handoff"
    | "server_action"
    | "venue_preparation";
  state: FundingOperationStepState;
  actionFingerprint: string;
  executorId: string;
  payerRequirement:
    | "none"
    | "user"
    | "provider"
    | "privy_sponsor"
    | "hunch_sponsor";
  dependsOnStepId: string | null;
  dependencyState: FundingOperationStepState | null;
  normalizedAction: JsonRecord;
  actionValidationResult: JsonRecord;
  actionExpiresAt: Date | null;
}>;

type FundingOperationStepDbRow = {
  id: string;
  operation_id: string;
  segment_id: string | null;
  ordinal: number;
  step_kind: FundingOperationStep["stepKind"];
  state: FundingOperationStepState;
  action_fingerprint: string;
  executor_id: string;
  payer_requirement: FundingOperationStep["payerRequirement"];
  depends_on_step_id: string | null;
  dependency_state: FundingOperationStepState | null;
  normalized_action: JsonRecord;
  action_validation_result: JsonRecord;
  action_expires_at: Date | null;
};

function mapOperationStep(
  row: FundingOperationStepDbRow,
  projectedStates: ReadonlyMap<string, FundingOperationStepState> | null = null,
): FundingOperationStep {
  const state = projectedStates?.get(row.id) ?? row.state;
  const dependencyState =
    row.depends_on_step_id === null
      ? null
      : (projectedStates?.get(row.depends_on_step_id) ?? row.dependency_state);
  return {
    id: row.id,
    operationId: row.operation_id,
    segmentId: row.segment_id,
    ordinal: row.ordinal,
    stepKind: row.step_kind,
    state,
    actionFingerprint: row.action_fingerprint,
    executorId: row.executor_id,
    payerRequirement: row.payer_requirement,
    dependsOnStepId: row.depends_on_step_id,
    dependencyState,
    normalizedAction: row.normalized_action,
    actionValidationResult: row.action_validation_result,
    actionExpiresAt: row.action_expires_at,
  };
}

async function projectedFundingStepStates(
  db: Pick<Pool, "query">,
  operationId: string,
): Promise<ReadonlyMap<string, FundingOperationStepState>> {
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(db, {
    operationId,
    now: new Date(),
  });
  if (!facts) return new Map();
  return new Map(
    deriveFundingLifecycle(facts).actions.map((action) => [
      action.actionId,
      action.state,
    ]),
  );
}

const operationStepColumns = `
  step.id,
  step.operation_id,
  step.segment_id,
  step.ordinal,
  step.step_kind,
  step.state,
  step.action_fingerprint,
  step.executor_id,
  step.payer_requirement,
  step.depends_on_step_id,
  dependency.state as dependency_state,
  step.normalized_action,
  step.action_validation_result,
  step.action_expires_at
`;

export async function fetchFundingOperationStepForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
    stepId: string;
  }>,
): Promise<FundingOperationStep | null> {
  const { rows } = await db.query<FundingOperationStepDbRow>(
    `
      select ${operationStepColumns}
      from funding_operation_steps step
      join funding_operations operation on operation.id = step.operation_id
      left join funding_operation_steps dependency
        on dependency.id = step.depends_on_step_id
       and dependency.operation_id = step.operation_id
      where operation.user_id = $1
        and operation.id = $2
        and step.id = $3
    `,
    [input.userId, input.operationId, input.stepId],
  );
  const row = rows[0];
  if (!row) return null;
  return mapOperationStep(
    row,
    await projectedFundingStepStates(db, input.operationId),
  );
}

export async function listFundingOperationStepsForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
  }>,
): Promise<readonly FundingOperationStep[]> {
  const { rows } = await db.query<FundingOperationStepDbRow>(
    `
      select ${operationStepColumns}
      from funding_operation_steps step
      join funding_operations operation on operation.id = step.operation_id
      left join funding_operation_steps dependency
        on dependency.id = step.depends_on_step_id
       and dependency.operation_id = step.operation_id
      where operation.user_id = $1
        and operation.id = $2
      order by step.ordinal asc
    `,
    [input.userId, input.operationId],
  );
  const projectedStates = await projectedFundingStepStates(
    db,
    input.operationId,
  );
  return rows.map((row) => mapOperationStep(row, projectedStates));
}

export type FundingPolymarketHandoffCandidate = Readonly<{
  operationId: string;
  stepId: string;
  attemptId: string;
  attemptOutcome: "started" | "submitted" | "ambiguous";
  referenceKind: FundingStepAttempt["referenceKind"];
  resolvedTransactionHash: string | null;
  receiptRefCiphertext: string | null;
  receiptRefLookupHmac: string | null;
  lookupKeyVersion: number | null;
  normalizedAction: JsonRecord;
  actionValidationResult: JsonRecord;
}>;

type FundingPolymarketHandoffCandidateDbRow = {
  operation_id: string;
  step_id: string;
  attempt_id: string;
  attempt_outcome: FundingPolymarketHandoffCandidate["attemptOutcome"];
  reference_kind: FundingPolymarketHandoffCandidate["referenceKind"];
  resolved_transaction_hash: string | null;
  receipt_ref_ciphertext: string | null;
  receipt_ref_lookup_hmac: string | null;
  lookup_key_version: number | null;
  normalized_action: JsonRecord;
  action_validation_result: JsonRecord;
};

const MAX_POLYMARKET_HANDOFF_CANDIDATES_PER_LOOKUP = 256;

export class FundingPolymarketHandoffLookupOverflowError extends Error {
  constructor() {
    super("polymarket handoff candidate lookup exceeded its safety bound");
    this.name = "FundingPolymarketHandoffLookupOverflowError";
  }
}

export type FundingPolymarketHandoffCanonicalEventLookup = Readonly<{
  networkId: string;
  assetId: string;
  sourceAddress: string;
  destinationAddress: string;
  rawAmount: string;
  receiptRefLookupHmac: string | null;
}>;

export async function listPotentialPolymarketHandoffsForCanonicalEvents(
  db: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    events: readonly FundingPolymarketHandoffCanonicalEventLookup[];
    currentLookupKeyVersion: number | null;
  }>,
): Promise<readonly FundingPolymarketHandoffCandidate[]> {
  if (input.events.length === 0) return [];
  const receiptRefLookupHmacs = input.events.flatMap((event) =>
    event.receiptRefLookupHmac ? [event.receiptRefLookupHmac] : [],
  );
  const { rows } = await db.query<FundingPolymarketHandoffCandidateDbRow>(
    `
        with candidate_event as (
          select value as event
          from jsonb_array_elements($2::jsonb)
        )
        select
          operation.id as operation_id,
          step.id as step_id,
          attempt.id as attempt_id,
          attempt.outcome as attempt_outcome,
          attempt.reference_kind,
          case
            when receipt.evidence ->> 'transactionHash'
                   ~ '^0x[0-9a-fA-F]{64}$'
            then lower(receipt.evidence ->> 'transactionHash')
            else null
          end as resolved_transaction_hash,
          attempt.receipt_ref_ciphertext,
          attempt.receipt_ref_lookup_hmac,
          attempt.lookup_key_version,
          step.normalized_action,
          step.action_validation_result
        from funding_operation_step_attempts attempt
        join funding_operation_steps step on step.id = attempt.step_id
        join funding_operations operation on operation.id = step.operation_id
        left join funding_step_receipt_observations receipt
          on receipt.attempt_id = attempt.id
        left join lateral (
          select true as matches_event
          from candidate_event candidate
          where step.normalized_action ->> 'networkId'
                  = candidate.event ->> 'networkId'
            and funding_account_identifier_equal(
                  candidate.event ->> 'networkId',
                  step.action_validation_result ->> 'tokenAddress',
                  candidate.event ->> 'assetId'
                )
            and funding_account_identifier_equal(
                  candidate.event ->> 'networkId',
                  step.action_validation_result ->> 'funderAddress',
                  candidate.event ->> 'sourceAddress'
                )
            and funding_account_identifier_equal(
                  candidate.event ->> 'networkId',
                  step.action_validation_result ->> 'recipientAddress',
                  candidate.event ->> 'destinationAddress'
                )
            and step.action_validation_result ->> 'amountRaw'
                  = candidate.event ->> 'rawAmount'
          limit 1
        ) semantic_match on true
        where operation.user_id = $1
          and step.normalized_action ->> 'kind' = 'external_handoff'
          and step.normalized_action ->> 'handoffKind'
            = 'polymarket_deposit_wallet_transfer'
          and (
            (
              attempt.outcome = 'started'
              and operation.status not in (
                'completed', 'refunded', 'failed', 'cancelled'
              )
              and semantic_match.matches_event
            )
            or (
              attempt.outcome in ('submitted', 'ambiguous')
              and attempt.broadcast_may_have_occurred = true
              and attempt.reference_kind in ('transaction', 'external_handoff')
              and (
                semantic_match.matches_event
                or attempt.receipt_ref_lookup_hmac = any($3::text[])
                or (
                  $4::integer is not null
                  and attempt.lookup_key_version is distinct from $4
                )
              )
            )
          )
        order by attempt.created_at desc
        limit $5
      `,
    [
      input.userId,
      JSON.stringify(input.events),
      [...new Set(receiptRefLookupHmacs)],
      input.currentLookupKeyVersion,
      MAX_POLYMARKET_HANDOFF_CANDIDATES_PER_LOOKUP + 1,
    ],
  );
  if (rows.length > MAX_POLYMARKET_HANDOFF_CANDIDATES_PER_LOOKUP) {
    throw new FundingPolymarketHandoffLookupOverflowError();
  }
  return rows.map((row) => ({
    operationId: row.operation_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    attemptOutcome: row.attempt_outcome,
    referenceKind: row.reference_kind,
    resolvedTransactionHash: row.resolved_transaction_hash,
    receiptRefCiphertext: row.receipt_ref_ciphertext,
    receiptRefLookupHmac: row.receipt_ref_lookup_hmac,
    lookupKeyVersion: row.lookup_key_version,
    normalizedAction: row.normalized_action,
    actionValidationResult: row.action_validation_result,
  }));
}

export type FundingWithdrawalDestination = Readonly<{
  id: string;
  userId: string;
  networkId: string;
  assetId: string;
  assetDecimals: number;
  addressCiphertext: string | null;
  addressLookupHmac: string;
  lookupKeyVersion: number;
  validationEvidence: JsonRecord;
  policyVersion: number;
  expiresAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
}>;

type FundingWithdrawalDestinationDbRow = {
  id: string;
  user_id: string;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  address_ciphertext: string | null;
  address_lookup_hmac: string;
  lookup_key_version: number;
  validation_evidence: JsonRecord;
  policy_version: string | number;
  expires_at: Date;
  revoked_at: Date | null;
  revocation_reason: string | null;
};

const destinationColumns = `
  id,
  user_id,
  network_id,
  asset_id,
  asset_decimals,
  address_ciphertext,
  address_lookup_hmac,
  lookup_key_version,
  validation_evidence,
  policy_version,
  expires_at,
  revoked_at,
  revocation_reason
`;

function mapDestination(
  row: FundingWithdrawalDestinationDbRow,
): FundingWithdrawalDestination {
  return {
    id: row.id,
    userId: row.user_id,
    networkId: row.network_id,
    assetId: row.asset_id,
    assetDecimals: row.asset_decimals,
    addressCiphertext: row.address_ciphertext,
    addressLookupHmac: row.address_lookup_hmac,
    lookupKeyVersion: row.lookup_key_version,
    validationEvidence: row.validation_evidence,
    policyVersion: Number(row.policy_version),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
  };
}

export async function registerFundingWithdrawalDestinationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    networkId: string;
    assetId: string;
    assetDecimals: number;
    addressCiphertext: string;
    addressLookupHmac: string;
    lookupKeyVersion: number;
    validationEvidence: JsonRecord;
    policyVersion: number;
    expiresAt: Date;
    now?: Date;
  }>,
): Promise<
  Readonly<{ destination: FundingWithdrawalDestination; replayed: boolean }>
> {
  const existingResult = await client.query<FundingWithdrawalDestinationDbRow>(
    `
        select ${destinationColumns}
        from funding_withdrawal_destinations
        where user_id = $1
          and network_id = $2
          and asset_id = $3
          and address_lookup_hmac = $4
          and lookup_key_version = $5
          and revoked_at is null
        for update
      `,
    [
      input.userId,
      input.networkId,
      input.assetId,
      input.addressLookupHmac,
      input.lookupKeyVersion,
    ],
  );
  const existingRow = existingResult.rows[0];
  if (existingRow) {
    const existing = mapDestination(existingRow);
    const reusable =
      existing.assetDecimals === input.assetDecimals &&
      existing.policyVersion === input.policyVersion &&
      existing.expiresAt.getTime() > (input.now ?? new Date()).getTime();
    if (reusable) {
      return { destination: existing, replayed: true };
    }
    await client.query(
      `
        update funding_withdrawal_destinations
        set revoked_at = $2,
            revocation_reason = 'revalidated',
            address_ciphertext = null
        where id = $1 and revoked_at is null
      `,
      [existing.id, input.now ?? new Date()],
    );
  }

  const { rows } = await client.query<FundingWithdrawalDestinationDbRow>(
    `
      insert into funding_withdrawal_destinations (
        user_id,
        network_id,
        asset_id,
        asset_decimals,
        address_ciphertext,
        address_lookup_hmac,
        lookup_key_version,
        validation_evidence,
        policy_version,
        expires_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
      returning ${destinationColumns}
    `,
    [
      input.userId,
      input.networkId,
      input.assetId,
      input.assetDecimals,
      input.addressCiphertext,
      input.addressLookupHmac,
      input.lookupKeyVersion,
      input.validationEvidence,
      input.policyVersion,
      input.expiresAt,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("withdrawal destination insert returned no row");
  return { destination: mapDestination(row), replayed: false };
}

export async function registerFundingWithdrawalDestination(
  pool: Pool,
  input: Parameters<
    typeof registerFundingWithdrawalDestinationInTransaction
  >[1],
): Promise<
  Readonly<{ destination: FundingWithdrawalDestination; replayed: boolean }>
> {
  return tx(pool, (client) =>
    registerFundingWithdrawalDestinationInTransaction(client, input),
  );
}

export async function fetchFundingWithdrawalDestinationForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    destinationId: string;
    lockForShare?: boolean;
  }>,
): Promise<FundingWithdrawalDestination | null> {
  const { rows } = await db.query<FundingWithdrawalDestinationDbRow>(
    `
      select ${destinationColumns}
      from funding_withdrawal_destinations
      where user_id = $1 and id = $2
      ${input.lockForShare ? "for share" : ""}
    `,
    [input.userId, input.destinationId],
  );
  return rows[0] ? mapDestination(rows[0]) : null;
}

export async function revokeFundingWithdrawalDestinationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    destinationId: string;
    reason: string;
    cryptoShred: boolean;
    now?: Date;
  }>,
): Promise<FundingWithdrawalDestination> {
  const { rows } = await client.query<FundingWithdrawalDestinationDbRow>(
    `
      update funding_withdrawal_destinations
      set revoked_at = $4,
          revocation_reason = $3,
          address_ciphertext = case when $5 then null else address_ciphertext end
      where user_id = $1
        and id = $2
        and revoked_at is null
      returning ${destinationColumns}
    `,
    [
      input.userId,
      input.destinationId,
      input.reason,
      input.now ?? new Date(),
      input.cryptoShred,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "active withdrawal destination was not found for authenticated user",
    );
  }
  return mapDestination(row);
}

export type FundingStepAttemptOutcome =
  | "submitted"
  | "succeeded"
  | "failed"
  | "ambiguous"
  | "cancelled";

export type FundingStepAttempt = Readonly<{
  id: string;
  stepId: string;
  attemptNumber: number;
  canonicalActionFingerprint: string;
  executorId: string;
  outcome: "started" | FundingStepAttemptOutcome;
  broadcastMayHaveOccurred: boolean;
  referenceKind:
    | "transaction"
    | "signature"
    | "provider_receipt"
    | "external_handoff"
    | null;
  receiptRefCiphertext: string | null;
  receiptRefLookupHmac: string | null;
  lookupKeyVersion: number | null;
  actualCosts: JsonRecord;
  startedAt: Date;
  finishedAt: Date | null;
}>;

/**
 * Records cancellation as durable action evidence.  The lifecycle projection
 * decides which actions remain safely cancellable; this writer only appends
 * those cancellation facts.  In particular, a completed approval is harmless
 * and must not prevent cancellation of a still-unstarted debit action.
 *
 * The enclosing caller must already hold the operation lock.  The projection
 * establishes the no-money-movement boundary before this helper appends any
 * cancellation fact.
 */
export async function recordSafeFundingActionCancellationsInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    now: Date;
  }>,
): Promise<
  Readonly<{
    cancelledStepIds: readonly string[];
    unsafeStepIds: readonly string[];
  }>
> {
  const lifecycle = await projectedFundingLifecycleInTransaction(client, {
    operationId: input.operationId,
    now: input.now,
  });
  const projectedActionById = new Map(
    lifecycle.actions.map((action) => [action.actionId, action]),
  );
  const unsafeStepIds = lifecycle.actions
    .filter(
      (action) =>
        action.state !== "planned" &&
        action.state !== "action_required" &&
        action.state !== "succeeded" &&
        action.state !== "failed" &&
        action.state !== "cancelled",
    )
    .map((action) => action.actionId);
  if (!lifecycle.safety.cancelAllowed || unsafeStepIds.length > 0) {
    return {
      cancelledStepIds: [],
      unsafeStepIds:
        unsafeStepIds.length > 0
          ? unsafeStepIds
          : lifecycle.actions.map((action) => action.actionId),
    };
  }

  const candidateResult = await client.query<{
    attempt_number: number | null;
    canonical_action_fingerprint: string;
    executor_id: string;
    step_id: string;
  }>(
    `
      select
        step.id as step_id,
        attempt.attempt_number,
        step.action_fingerprint as canonical_action_fingerprint,
        step.executor_id
      from funding_operation_steps step
      left join lateral (
        select
          candidate.attempt_number
        from funding_operation_step_attempts candidate
        where candidate.step_id = step.id
        order by candidate.attempt_number desc
        limit 1
      ) attempt on true
      where step.operation_id = $1::uuid
      order by step.ordinal
      for update of step
    `,
    [input.operationId],
  );
  const cancelledStepIds: string[] = [];
  for (const row of candidateResult.rows) {
    const projectedAction = projectedActionById.get(row.step_id);
    if (!projectedAction) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "funding lifecycle projection omitted a committed action",
      );
    }
    if (
      projectedAction.state !== "planned" &&
      projectedAction.state !== "action_required"
    ) {
      continue;
    }
    const attemptNumber = (row.attempt_number ?? 0) + 1;
    const { rows } = await client.query<{ step_id: string }>(
      `
        insert into funding_operation_step_attempts (
          step_id,
          attempt_number,
          canonical_action_fingerprint,
          executor_id,
          outcome,
          broadcast_may_have_occurred,
          actual_costs,
          started_at,
          finished_at
        )
        values (
          $1::uuid, $2, $3, $4, 'cancelled', false,
          '{"reasonCode":"cancelled_after_safe_evidence"}'::jsonb,
          $5::timestamptz, $5::timestamptz
        )
        on conflict (step_id, attempt_number) do nothing
        returning step_id
      `,
      [
        row.step_id,
        attemptNumber,
        row.canonical_action_fingerprint,
        row.executor_id,
        input.now,
      ],
    );
    const cancelled = rows[0]?.step_id;
    if (!cancelled) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "funding action changed while recording its cancellation",
      );
    }
    cancelledStepIds.push(cancelled);
  }
  return { cancelledStepIds, unsafeStepIds: [] };
}

/**
 * A zero-action external ingress has no step on which to store cancellation.
 * Keep the decision as one explicit, append-only-in-practice lifecycle fact
 * instead of treating the materialized operation status as the decision.
 */
export async function recordFundingOperationCancellationDecisionInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{ operationId: string; now: Date }>,
): Promise<void> {
  const updated = await client.query(
    `update funding_operations
        set support_metadata = jsonb_set(
              support_metadata,
              '{lifecycleCancellation}',
              jsonb_build_object(
                'reason', 'user_cancelled_before_money_moved',
                'requestedAt', $2::timestamptz
              ),
              true
            ),
            version = version + 1,
            updated_at = $2
      where id = $1::uuid
        and support_metadata -> 'lifecycleCancellation' is null`,
    [input.operationId, input.now],
  );
  if ((updated.rowCount ?? 0) > 1) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding cancellation decision matched multiple operations",
    );
  }
}

type FundingStepAttemptDbRow = {
  id: string;
  step_id: string;
  attempt_number: number;
  canonical_action_fingerprint: string;
  executor_id: string;
  outcome: FundingStepAttempt["outcome"];
  broadcast_may_have_occurred: boolean;
  reference_kind: FundingStepAttempt["referenceKind"];
  receipt_ref_ciphertext: string | null;
  receipt_ref_lookup_hmac: string | null;
  lookup_key_version: number | null;
  actual_costs: JsonRecord;
  started_at: Date;
  finished_at: Date | null;
};

const attemptColumns = `
  id,
  step_id,
  attempt_number,
  canonical_action_fingerprint,
  executor_id,
  outcome,
  broadcast_may_have_occurred,
  reference_kind,
  receipt_ref_ciphertext,
  receipt_ref_lookup_hmac,
  lookup_key_version,
  actual_costs,
  started_at,
  finished_at
`;

function mapAttempt(row: FundingStepAttemptDbRow): FundingStepAttempt {
  return {
    id: row.id,
    stepId: row.step_id,
    attemptNumber: row.attempt_number,
    canonicalActionFingerprint: row.canonical_action_fingerprint,
    executorId: row.executor_id,
    outcome: row.outcome,
    broadcastMayHaveOccurred: row.broadcast_may_have_occurred,
    referenceKind: row.reference_kind,
    receiptRefCiphertext: row.receipt_ref_ciphertext,
    receiptRefLookupHmac: row.receipt_ref_lookup_hmac,
    lookupKeyVersion: row.lookup_key_version,
    actualCosts: row.actual_costs,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Actions are admitted from the same immutable facts that drive the public
 * lifecycle, not from the materialized `funding_operation_steps.state` cache.
 * The caller must already hold the operation lock before using this helper.
 */
export async function projectedFundingLifecycleInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{ operationId: string; now: Date }>,
) {
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    input,
  );
  if (!facts) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding operation disappeared while reading lifecycle facts",
    );
  }
  return deriveFundingLifecycle(facts);
}

export async function writeFundingStepProjectionCacheInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    stepId: string;
    state: FundingOperationStepState;
    now: Date;
  }>,
): Promise<void> {
  // This is deliberately an unconditional cache write. The decision was
  // already made by deriveFundingLifecycle from immutable facts; a stale
  // cached state must never veto or alter it.
  const updated = await client.query(
    `update funding_operation_steps
        set state = $2,
            updated_at = $3
      where id = $1`,
    [input.stepId, input.state, input.now],
  );
  if (updated.rowCount !== 1) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding operation step disappeared while caching lifecycle projection",
    );
  }
}

export async function startFundingStepAttemptInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    stepId: string;
    canonicalActionFingerprint: string;
    executorId: string;
    now?: Date;
  }>,
): Promise<FundingStepAttempt> {
  const stepResult = await client.query<{
    action_fingerprint: string;
    executor_id: string;
  }>(
    `
      select action_fingerprint, executor_id
      from funding_operation_steps
      where id = $1 and operation_id = $2
      for update
    `,
    [input.stepId, input.operationId],
  );
  const step = stepResult.rows[0];
  if (!step) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding operation step was not found",
    );
  }
  if (
    step.action_fingerprint !== input.canonicalActionFingerprint ||
    step.executor_id !== input.executorId
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "attempt does not match the immutable committed action",
    );
  }

  const previousResult = await client.query<{
    attempt_number: number;
    broadcast_may_have_occurred: boolean;
    outcome: FundingStepAttempt["outcome"];
    receipt_status: string | null;
  }>(
    `
      select
        attempt.attempt_number,
        attempt.outcome,
        attempt.broadcast_may_have_occurred,
        receipt.status as receipt_status
      from funding_operation_step_attempts attempt
      left join funding_step_receipt_observations receipt
        on receipt.attempt_id = attempt.id
      where attempt.step_id = $1
      order by attempt.attempt_number desc
      limit 1
      for update of attempt
    `,
    [input.stepId],
  );
  const previous = previousResult.rows[0];
  const previousBroadcastProvenFailed = previous?.receipt_status === "failed";
  if (
    previous &&
    (previous.outcome === "started" ||
      previous.outcome === "succeeded" ||
      ((previous.outcome === "submitted" ||
        previous.outcome === "ambiguous" ||
        previous.broadcast_may_have_occurred) &&
        !previousBroadcastProvenFailed))
  ) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "previous attempt may have broadcast; reconciliation is required before retry",
    );
  }
  const attemptNumber = (previous?.attempt_number ?? 0) + 1;
  const { rows } = await client.query<FundingStepAttemptDbRow>(
    `
      insert into funding_operation_step_attempts (
        step_id,
        attempt_number,
        canonical_action_fingerprint,
        executor_id,
        started_at
      )
      values ($1, $2, $3, $4, $5)
      returning ${attemptColumns}
    `,
    [
      input.stepId,
      attemptNumber,
      input.canonicalActionFingerprint,
      input.executorId,
      input.now ?? new Date(),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("funding attempt insert returned no row");
  return mapAttempt(row);
}

export async function startFundingStepAttemptForUserInTransaction(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    operationId: string;
    stepId: string;
    canonicalActionFingerprint: string;
    executorId: string;
    expectedPolicy?: Readonly<{ revision: string; version: number }>;
    now?: Date;
  }>,
): Promise<
  Readonly<{
    attempt: FundingStepAttempt;
    step: FundingOperationStep;
  }>
> {
  // Lock the operation in its own statement. Under READ COMMITTED a statement
  // that starts while a sibling report holds this lock can retain its older
  // snapshot after waiting. The following statement therefore observes the
  // sibling report that just committed before deciding whether another action
  // may start.
  const operationResult = await client.query<{
    policy_revision: string;
    policy_version: string | number;
    status: FundingOperationRow["status"];
  }>(
    `
      select status, policy_revision, policy_version
      from funding_operations
      where user_id = $1 and id = $2
      for update
    `,
    [input.userId, input.operationId],
  );
  const operation = operationResult.rows[0];
  if (!operation) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding operation step was not found for authenticated user",
    );
  }
  const { rows } = await client.query<FundingOperationStepDbRow>(
    `
        select
          ${operationStepColumns}
        from funding_operation_steps step
        left join funding_operation_steps dependency
          on dependency.id = step.depends_on_step_id
         and dependency.operation_id = step.operation_id
        where step.operation_id = $1
          and step.id = $2
        for update of step
    `,
    [input.operationId, input.stepId],
  );
  const row = rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding operation step was not found for authenticated user",
    );
  }
  const now =
    input.now ??
    (await client.query<{ now: Date }>("select clock_timestamp() as now"))
      .rows[0]?.now;
  if (!now) throw new Error("funding action start clock is unavailable");
  if (row.action_expires_at !== null && row.action_expires_at <= now) {
    throw new FundingPersistenceError(
      "quote_expired",
      "funding action provider deadline has expired",
    );
  }
  if (
    input.expectedPolicy &&
    (operation.policy_revision !== input.expectedPolicy.revision ||
      Number(operation.policy_version) !== input.expectedPolicy.version)
  ) {
    throw new FundingPersistenceError(
      "quote_invalidated",
      "funding action policy changed before attempt start",
    );
  }
  if (
    row.action_fingerprint !== input.canonicalActionFingerprint ||
    row.executor_id !== input.executorId ||
    canonicalJsonHash(row.normalized_action) !==
      input.canonicalActionFingerprint
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "funding action differs from its committed fingerprint",
    );
  }
  const lifecycle = await projectedFundingLifecycleInTransaction(client, {
    operationId: input.operationId,
    now,
  });
  const projectedAction = lifecycle.actions.find(
    (action) => action.actionId === input.stepId,
  );
  if (!projectedAction?.actionable) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding operation step is not currently actionable from lifecycle facts",
    );
  }
  const attempt = await startFundingStepAttemptInTransaction(client, {
    operationId: input.operationId,
    stepId: input.stepId,
    canonicalActionFingerprint: input.canonicalActionFingerprint,
    executorId: input.executorId,
    now,
  });
  return {
    attempt,
    step: mapOperationStep(
      row,
      new Map(lifecycle.actions.map((action) => [action.actionId, action.state])),
    ),
  };
}

export async function startFundingStepAttemptForUser(
  pool: Pool,
  input: Parameters<typeof startFundingStepAttemptForUserInTransaction>[1],
): Promise<
  Awaited<ReturnType<typeof startFundingStepAttemptForUserInTransaction>>
> {
  return tx(pool, (client) =>
    startFundingStepAttemptForUserInTransaction(client, input),
  );
}

export async function finishFundingStepAttemptInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    attemptId: string;
    outcome: FundingStepAttemptOutcome;
    broadcastMayHaveOccurred: boolean;
    referenceKind: FundingStepAttempt["referenceKind"];
    receiptRefCiphertext: string | null;
    receiptRefLookupHmac: string | null;
    lookupKeyVersion: number | null;
    actualCosts: JsonRecord;
    now?: Date;
  }>,
): Promise<FundingStepAttempt> {
  const requiresAmbiguousBroadcastEvidence =
    input.outcome === "submitted" || input.outcome === "ambiguous";
  if (input.broadcastMayHaveOccurred !== requiresAmbiguousBroadcastEvidence) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "broadcast uncertainty is valid only for submitted or ambiguous attempts",
    );
  }
  const hasReference =
    input.referenceKind !== null ||
    input.receiptRefCiphertext !== null ||
    input.receiptRefLookupHmac !== null ||
    input.lookupKeyVersion !== null;
  if (
    hasReference &&
    (input.referenceKind === null ||
      input.receiptRefCiphertext === null ||
      input.receiptRefLookupHmac === null ||
      input.lookupKeyVersion === null)
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "attempt receipt reference must be supplied as an encrypted/HMAC tuple",
    );
  }
  const { rows } = await client.query<FundingStepAttemptDbRow>(
    `
      update funding_operation_step_attempts
      set outcome = $2,
          broadcast_may_have_occurred = $3,
          reference_kind = $4,
          receipt_ref_ciphertext = $5,
          receipt_ref_lookup_hmac = $6,
          lookup_key_version = $7,
          actual_costs = $8::jsonb,
          finished_at = $9
      where id = $1 and outcome = 'started'
      returning ${attemptColumns}
    `,
    [
      input.attemptId,
      input.outcome,
      input.broadcastMayHaveOccurred,
      input.referenceKind,
      input.receiptRefCiphertext,
      input.receiptRefLookupHmac,
      input.lookupKeyVersion,
      input.actualCosts,
      input.now ?? new Date(),
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding attempt is already finalized",
    );
  }
  return mapAttempt(row);
}

function finalizedAttemptMatchesReport(
  attempt: FundingStepAttempt,
  input: Readonly<{
    outcome: FundingStepAttemptOutcome;
    broadcastMayHaveOccurred: boolean;
    referenceKind: FundingStepAttempt["referenceKind"];
    receiptRefLookupHmac: string | null;
    lookupKeyVersion: number | null;
    actualCosts: JsonRecord;
  }>,
): boolean {
  return (
    attempt.outcome === input.outcome &&
    attempt.broadcastMayHaveOccurred === input.broadcastMayHaveOccurred &&
    attempt.referenceKind === input.referenceKind &&
    attempt.receiptRefLookupHmac === input.receiptRefLookupHmac &&
    attempt.lookupKeyVersion === input.lookupKeyVersion &&
    canonicalJsonEqual(attempt.actualCosts, input.actualCosts)
  );
}

// The action-report endpoint preserves its existing acknowledgement contract:
// a successful executor report still means "submitted" to the caller until
// canonical receipt/evidence is observed. This is presentation only; the
// stored step cache is written from the lifecycle projection below.
function reportAcknowledgementStepState(
  outcome: FundingStepAttemptOutcome,
): "submitted" | "reconcile_required" | "failed" | "cancelled" {
  if (outcome === "submitted" || outcome === "succeeded") return "submitted";
  if (outcome === "ambiguous") return "reconcile_required";
  if (outcome === "failed") return "failed";
  return "cancelled";
}

export async function finishFundingStepAttemptForUserInTransaction(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    operationId: string;
    stepId: string;
    attemptId: string;
    outcome: FundingStepAttemptOutcome;
    broadcastMayHaveOccurred: boolean;
    referenceKind: FundingStepAttempt["referenceKind"];
    receiptRefCiphertext: string | null;
    receiptRefLookupHmac: string | null;
    lookupKeyVersion: number | null;
    actualCosts: JsonRecord;
    now?: Date;
  }>,
): Promise<
  Readonly<{
    attempt: FundingStepAttempt;
    stepState: "submitted" | "reconcile_required" | "failed" | "cancelled";
  }>
> {
  const operationResult = await client.query<{
    operation_progress_stage: FundingOperationRow["progressStage"];
    operation_recovery_mode: FundingOperationRow["recoveryMode"];
    operation_status: FundingOperationRow["status"];
    operation_version: string | number;
  }>(
    `
      select progress_stage as operation_progress_stage,
             recovery_mode as operation_recovery_mode,
             status as operation_status,
             version as operation_version
      from funding_operations
      where user_id = $1 and id = $2
      for update
    `,
    [input.userId, input.operationId],
  );
  const scopedOperation = operationResult.rows[0];
  if (!scopedOperation) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding action attempt was not found for authenticated user",
    );
  }
  const stepResult = await client.query<{ id: string }>(
    `
      select id
      from funding_operation_steps
      where operation_id = $1 and id = $2
      for update
    `,
    [input.operationId, input.stepId],
  );
  const scopedStep = stepResult.rows[0];
  if (!scopedStep) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding action attempt was not found for authenticated user",
    );
  }
  const priorAttemptResult = await client.query<FundingStepAttemptDbRow>(
    `
      select ${attemptColumns}
      from funding_operation_step_attempts
      where step_id = $1 and id = $2
      for update
    `,
    [input.stepId, input.attemptId],
  );
  const priorAttemptRow = priorAttemptResult.rows[0];
  if (!priorAttemptRow) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding action attempt disappeared while recording its report",
    );
  }
  const priorAttempt = mapAttempt(priorAttemptRow);
  if (priorAttempt.outcome !== "started") {
    if (!finalizedAttemptMatchesReport(priorAttempt, input)) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "funding attempt was already finalized with different evidence",
      );
    }
    return {
      attempt: priorAttempt,
      stepState: reportAcknowledgementStepState(priorAttempt.outcome),
    };
  }
  const attempt = await finishFundingStepAttemptInTransaction(client, input);
  const now = input.now ?? new Date();
  const lifecycle = await projectedFundingLifecycleInTransaction(client, {
    operationId: input.operationId,
    now,
  });
  const action = lifecycle.actions.find(
    (candidate) => candidate.actionId === input.stepId,
  );
  if (!action) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding action disappeared while projecting its report",
    );
  }
  const stepState = action.state;
  await writeFundingStepProjectionCacheInTransaction(client, {
    stepId: input.stepId,
    state: stepState,
    now,
  });
  await wakeFundingReconciliationInTransaction(client, {
    operationId: input.operationId,
    dueAt: now,
  });
  if (
    input.broadcastMayHaveOccurred &&
    (scopedOperation.operation_status === "failed" ||
      scopedOperation.operation_status === "cancelled")
  ) {
    await transitionFundingOperationInTransaction(client, {
      operationId: input.operationId,
      scope: { kind: "worker" },
      expectedVersion: Number(scopedOperation.operation_version),
      expectedState: {
        status: scopedOperation.operation_status,
        stage: scopedOperation.operation_progress_stage,
      },
      nextState: { status: "recovery_required", stage: "source_action" },
      recoveryMode:
        input.receiptRefLookupHmac === null
          ? "manual_review"
          : "automatic_evidence",
      errorCode: "late_broadcast_after_terminal_operation",
      supportMetadataPatch: {
        lateBroadcastAttemptId: input.attemptId,
        lateBroadcastObservedAt: (input.now ?? new Date()).toISOString(),
      },
      now,
    });
  }
  return {
    attempt,
    stepState: reportAcknowledgementStepState(input.outcome),
  };
}

export async function resolveAmbiguousProviderFundingStepAttemptForUserInTransaction(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    operationId: string;
    stepId: string;
    attemptId: string;
    providerReferenceLookupHmac: string;
    retryableDefinitiveFailure?: boolean;
    resolution:
      | Readonly<{
          kind: "transaction";
          receiptRefCiphertext: string;
          receiptRefLookupHmac: string;
          lookupKeyVersion: number;
        }>
      | Readonly<{
          kind: "definitive_failure";
          actualCosts: JsonRecord;
        }>;
    now?: Date;
  }>,
): Promise<
  Readonly<{
    attempt: FundingStepAttempt;
    stepState: FundingOperationStepState;
  }>
> {
  const operationResult = await client.query<{
    operation_progress_stage: FundingOperationRow["progressStage"];
    operation_recovery_mode: FundingOperationRow["recoveryMode"];
    operation_status: FundingOperationRow["status"];
    operation_support_metadata: JsonRecord;
    operation_version: string | number;
  }>(
    `
      select status as operation_status,
             progress_stage as operation_progress_stage,
             recovery_mode as operation_recovery_mode,
             support_metadata as operation_support_metadata,
             version as operation_version
      from funding_operations
      where user_id = $1 and id = $2
      for update
    `,
    [input.userId, input.operationId],
  );
  const scopedOperation = operationResult.rows[0];
  if (!scopedOperation) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "delegated funding attempt was not found for authenticated user",
    );
  }
  const stepResult = await client.query<{
    step_state: FundingOperationStepState;
  }>(
    `
      select state as step_state
      from funding_operation_steps
      where operation_id = $1 and id = $2
      for update
    `,
    [input.operationId, input.stepId],
  );
  const scopedStep = stepResult.rows[0];
  if (!scopedStep) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "delegated funding attempt was not found for authenticated user",
    );
  }
  const priorResult = await client.query<FundingStepAttemptDbRow>(
    `select ${attemptColumns}
       from funding_operation_step_attempts
      where step_id = $1 and id = $2
      for update`,
    [input.stepId, input.attemptId],
  );
  const priorRow = priorResult.rows[0];
  if (!priorRow) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "delegated funding attempt disappeared while resolving its provider reference",
    );
  }
  const prior = mapAttempt(priorRow);
  if (input.resolution.kind === "transaction") {
    if (
      prior.outcome === "ambiguous" &&
      prior.referenceKind === "transaction" &&
      prior.receiptRefLookupHmac === input.resolution.receiptRefLookupHmac &&
      prior.lookupKeyVersion === input.resolution.lookupKeyVersion
    ) {
      return { attempt: prior, stepState: scopedStep.step_state };
    }
  } else if (
    prior.outcome === "failed" &&
    canonicalJsonEqual(prior.actualCosts, input.resolution.actualCosts)
  ) {
    return { attempt: prior, stepState: "failed" };
  }
  if (
    prior.outcome !== "ambiguous" ||
    prior.referenceKind !== "provider_receipt" ||
    prior.receiptRefLookupHmac !== input.providerReferenceLookupHmac ||
    prior.lookupKeyVersion === null ||
    !["reconcile_required", "recovery_required"].includes(scopedStep.step_state)
  ) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "delegated provider reference is no longer awaiting resolution",
    );
  }
  const now = input.now ?? new Date();
  const resolved =
    input.resolution.kind === "transaction"
      ? await client.query<FundingStepAttemptDbRow>(
          `
            update funding_operation_step_attempts
            set reference_kind = 'transaction',
                receipt_ref_ciphertext = $2,
                receipt_ref_lookup_hmac = $3,
                lookup_key_version = $4,
                updated_at = $5
            where id = $1
              and outcome = 'ambiguous'
              and reference_kind = 'provider_receipt'
              and receipt_ref_lookup_hmac = $6
            returning ${attemptColumns}
          `,
          [
            input.attemptId,
            input.resolution.receiptRefCiphertext,
            input.resolution.receiptRefLookupHmac,
            input.resolution.lookupKeyVersion,
            now,
            input.providerReferenceLookupHmac,
          ],
        )
      : await client.query<FundingStepAttemptDbRow>(
          `
            update funding_operation_step_attempts
            set outcome = 'failed',
                broadcast_may_have_occurred = false,
                reference_kind = null,
                receipt_ref_ciphertext = null,
                receipt_ref_lookup_hmac = null,
                lookup_key_version = null,
                actual_costs = $2::jsonb,
                updated_at = $3
            where id = $1
              and outcome = 'ambiguous'
              and reference_kind = 'provider_receipt'
              and receipt_ref_lookup_hmac = $4
            returning ${attemptColumns}
          `,
          [
            input.attemptId,
            input.resolution.actualCosts,
            now,
            input.providerReferenceLookupHmac,
          ],
        );
  const resolvedRow = resolved.rows[0];
  if (!resolvedRow) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "delegated provider reference resolution lost its compare-and-set",
    );
  }
  const stepState =
    input.resolution.kind === "transaction"
      ? scopedStep.step_state
      : input.retryableDefinitiveFailure
        ? "action_required"
        : "failed";
  if (input.resolution.kind === "definitive_failure") {
    const updated = await client.query(
      `
        update funding_operation_steps
        set state = $3, updated_at = $2
        where id = $1 and state in ('reconcile_required', 'recovery_required')
      `,
      [input.stepId, now, stepState],
    );
    if (updated.rowCount !== 1) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "delegated funding step changed while resolving provider failure",
      );
    }
  }
  const strandedProviderFailure =
    input.resolution.kind === "definitive_failure" &&
    scopedOperation.operation_status === "recovery_required" &&
    scopedOperation.operation_recovery_mode === "automatic_evidence";
  const hasGenericWindow =
    scopedOperation.operation_support_metadata.reconciliationActiveSince !=
      null ||
    scopedOperation.operation_support_metadata
      .reconciliationActiveAttemptBaseline != null;
  if (hasGenericWindow || strandedProviderFailure) {
    // Provider recovery and generic reconciliation own different clocks. At
    // their handoff, discard the old window; a proven failure also ends the
    // automatic loop because no recovery selector can claim a failed step.
    const state = {
      status: scopedOperation.operation_status,
      stage: scopedOperation.operation_progress_stage,
    } as const;
    await transitionFundingOperationInTransaction(client, {
      operationId: input.operationId,
      scope: { kind: "worker" },
      expectedVersion: Number(scopedOperation.operation_version),
      expectedState: state,
      nextState: state,
      ...(strandedProviderFailure
        ? {
            recoveryMode: "manual_review" as const,
            errorCode: "delegated_provider_reference_failed",
          }
        : {}),
      ...(hasGenericWindow
        ? {
            supportMetadataPatch: {
              reconciliationActiveSince: null,
              reconciliationActiveAttemptBaseline: null,
            },
          }
        : {}),
      now,
    });
  }
  await wakeFundingReconciliationInTransaction(client, {
    operationId: input.operationId,
    dueAt: now,
  });
  return { attempt: mapAttempt(resolvedRow), stepState };
}

export async function finishFundingStepAttemptForUser(
  pool: Pool,
  input: Parameters<typeof finishFundingStepAttemptForUserInTransaction>[1],
): Promise<
  Awaited<ReturnType<typeof finishFundingStepAttemptForUserInTransaction>>
> {
  return tx(pool, (client) =>
    finishFundingStepAttemptForUserInTransaction(client, input),
  );
}

export type FundingReservationConsumer =
  | Readonly<{ kind: "web_order"; orderId: string }>
  | Readonly<{ kind: "execution"; executionId: string }>
  | Readonly<{ kind: "telegram_trade_intent"; intentId: string }>;

export type FundingTradeReservationLink = Readonly<{
  operationId: string;
  reservationId: string;
}>;

export type FundingConsumerReservation = Readonly<{
  operationId: string;
  reservationId: string;
  rawAmount: string;
  asset: Readonly<{
    networkId: string;
    assetId: string;
    decimals: number;
  }>;
  consumerIntent: FundingTradeConsumerIntent;
  expiresAt: Date;
}>;

export async function fetchFundingConsumerReservationForUser(
  db: Pick<Pool | PoolClient, "query">,
  input: Readonly<{
    /** Bind the read to an enclosing intent transition when a caller must
     * atomically attach the reservation to a consumer. */
    forUpdate?: boolean;
    now?: Date;
    userId: string;
    operationId: string;
  }>,
): Promise<FundingConsumerReservation | null> {
  const result = await db.query<{
    operation_id: string;
    reservation_id: string;
    raw_amount: string;
    network_id: string;
    asset_id: string;
    asset_decimals: number;
    expires_at: Date;
    venue_id: string | null;
    market_id: string | null;
    market_context_snapshot: unknown;
    requested_destination_amount: unknown;
  }>(
    `
      select
        reservation.operation_id,
        reservation.id as reservation_id,
        reservation.raw_amount,
        reservation.network_id,
        reservation.asset_id,
        reservation.asset_decimals,
        reservation.expires_at,
        operation.venue_id,
        operation.market_id,
        operation.market_context_snapshot,
        operation.requested_destination_amount
      from balance_reservations reservation
      join funding_operations operation
        on operation.id = reservation.operation_id
       and operation.user_id = reservation.user_id
      where reservation.user_id = $1
        and reservation.operation_id = $2
        and reservation.mode = 'settled_for_consumer'
        and reservation.state = 'active'
      order by reservation.id
      limit 2
      ${input.forUpdate ? "for update of reservation" : ""}
    `,
    [input.userId, input.operationId],
  );
  if (result.rows.length > 1) {
    throw new FundingPersistenceError(
      "invalid_operation_state",
      "funding operation has ambiguous consumer reservations",
    );
  }
  const row = result.rows[0];
  const now = input.now ?? new Date();
  const facts = row
    ? await loadFundingLifecycleFactsForOperationInTransaction(db, {
        operationId: row.operation_id,
        now,
      })
    : null;
  const lifecycle = facts ? deriveFundingLifecycle(facts) : null;
  if (
    row &&
    (lifecycle?.status !== "ready" ||
      lifecycle.progressStage !== "ready_for_consumer")
  ) {
    return null;
  }
  const consumerIntent = row
    ? storedFundingTradeConsumerIntentFromRow(row)
    : null;
  if (row && !consumerIntent) {
    throw new FundingPersistenceError(
      "invalid_operation_state",
      "funding reservation is missing its exact trade consumer intent",
    );
  }
  return row
    ? {
        operationId: row.operation_id,
        reservationId: row.reservation_id,
        rawAmount: row.raw_amount,
        asset: {
          networkId: row.network_id,
          assetId: row.asset_id,
          decimals: row.asset_decimals,
        },
        consumerIntent: consumerIntent as FundingTradeConsumerIntent,
        expiresAt: row.expires_at,
      }
    : null;
}

type FundingTradeReservationScopeRow = Readonly<{
  operation_id: string;
  reservation_id: string;
  raw_amount: string;
  expires_at: Date;
  reservation_state: "active" | "consumed" | "released";
  consumer_kind: string | null;
  consumer_ref: string | null;
  purpose: string;
  venue_id: string | null;
  market_id: string | null;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  market_context_snapshot: unknown;
  requested_destination_amount: unknown;
}>;

async function loadFundingTradeReservationScope(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    operationId?: string | null;
    reservationId: string;
  }>,
): Promise<FundingTradeReservationScopeRow> {
  const result = await client.query<FundingTradeReservationScopeRow>(
    `
      select
        operation.id as operation_id,
        reservation.id as reservation_id,
        reservation.raw_amount,
        reservation.expires_at,
        reservation.state as reservation_state,
        reservation.consumer_kind,
        reservation.consumer_ref,
        operation.purpose,
        operation.venue_id,
        operation.market_id,
        reservation.network_id,
        reservation.asset_id,
        reservation.asset_decimals,
        operation.market_context_snapshot,
        operation.requested_destination_amount
      from funding_operations operation
      join balance_reservations reservation
        on reservation.operation_id = operation.id
       and reservation.user_id = operation.user_id
      where ($1::uuid is null or operation.id = $1)
        and reservation.id = $2
        and operation.user_id = $3
        and reservation.mode = 'settled_for_consumer'
    `,
    [input.operationId ?? null, input.reservationId, input.userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "settled funding reservation is not linked to authenticated user",
    );
  }
  return row;
}

export async function assertFundingReservationReadyForTrade(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    link: FundingTradeReservationLink;
    intent: FundingTradeConsumerIntent;
    now?: Date;
  }>,
): Promise<Readonly<{ rawAmount: string; expiresAt: Date }>> {
  const row = await loadFundingTradeReservationScope(db, {
    userId: input.userId,
    operationId: input.link.operationId,
    reservationId: input.link.reservationId,
  });
  const now = input.now ?? new Date();
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(db, {
    operationId: row.operation_id,
    now,
  });
  const lifecycle = facts ? deriveFundingLifecycle(facts) : null;
  if (
    lifecycle?.status !== "ready" ||
    lifecycle.progressStage !== "ready_for_consumer" ||
    row.purpose !== "trade_shortfall" ||
    row.reservation_state !== "active" ||
    row.expires_at.getTime() <= now.getTime() ||
    row.venue_id !== input.intent.venueId ||
    row.market_id !== input.intent.marketId
  ) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding reservation is not ready for this exact trade",
    );
  }
  const expectedIntent = storedFundingTradeConsumerIntentFromRow(row);
  if (
    !expectedIntent ||
    !sameFundingTradeConsumerIntent(expectedIntent, input.intent)
  ) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding reservation does not match this exact normalized trade spend",
    );
  }
  return { rawAmount: row.raw_amount, expiresAt: row.expires_at };
}

async function completeReadyFundingOperation(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
    resolution: "consumed_by_trade" | "released_to_venue_cash";
    now: Date;
  }>,
): Promise<void> {
  const operation = await fetchFundingOperationForUser(client, {
    userId: input.userId,
    operationId: input.operationId,
  });
  if (!operation) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding operation was not found for authenticated user",
    );
  }
  if (operation.purpose !== "trade_shortfall") {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding operation is not a trade-shortfall route",
    );
  }
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    { operationId: operation.id, now: input.now },
  );
  const lifecycle = facts ? deriveFundingLifecycle(facts) : null;
  if (
    lifecycle?.status !== "completed" ||
    lifecycle.progressStage !== "terminal"
  ) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding operation is not completed by its consumer facts",
    );
  }
  await writeFundingOperationLifecycleProjectionCacheInTransaction(client, {
    operationId: operation.id,
    expectedVersion: operation.version,
    state: {
      status: lifecycle.status,
      stage: lifecycle.progressStage,
    },
    recoveryMode: lifecycle.recoveryMode,
    supportMetadataPatch: {
      consumerResolution: input.resolution,
      consumerResolvedAt: input.now.toISOString(),
    },
    now: input.now,
  });
  await releaseCompletedTradeShortfallSourceReservationsInTransaction(client, {
    operationId: operation.id,
    userId: input.userId,
    now: input.now,
  });
}

/**
 * A v2 handoff retains the original Telegram intent as the durable parent of
 * a generic web order.  The normal consumer repository is the only point at
 * which that order/execution is known to be persisted and its reservation is
 * consumed, so link the two here rather than asking the Mini App to race a
 * second, Telegram-specific completion callback.
 *
 * This is deliberately a conditional no-op for every ordinary web consumer.
 * The JSON binding was written by the v2 handoff transaction and makes a
 * reservation UUID alone insufficient to attach an unrelated intent.
 */
async function advanceTelegramAppHandoffV2ConsumerInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    attempt: FundingTradeAttempt;
    consumer: FundingReservationConsumer;
    consumerStatus: string | null;
    externalReference: string;
    now: Date;
    venueOrderId: string | null;
  }>,
): Promise<void> {
  const orderId =
    input.consumer.kind === "web_order" ? input.consumer.orderId : null;
  const executionId =
    input.consumer.kind === "execution" ? input.consumer.executionId : null;
  const consumerKind =
    input.consumer.kind === "web_order"
      ? "web_order"
      : input.consumer.kind === "execution"
        ? "execution"
        : "telegram_trade_intent";
  const consumerRef =
    input.consumer.kind === "web_order"
      ? input.consumer.orderId
      : input.consumer.kind === "execution"
        ? input.consumer.executionId
        : input.consumer.intentId;
  await client.query(
    `update telegram_trade_intents intent
        set status = $11::text,
            submit_started_at = coalesce(intent.submit_started_at, $7),
            submitted_at = coalesce(intent.submitted_at, $7),
            order_id = coalesce(intent.order_id, $5::uuid),
            execution_id = coalesce(intent.execution_id, $6::uuid),
            venue_order_id = coalesce(intent.venue_order_id, $12),
            result = coalesce(intent.result, '{}'::jsonb) || jsonb_build_object(
              'appHandoffTradeExecution',
              jsonb_build_object(
                'attemptId', $3::uuid,
                'consumerKind', $8::text,
                'consumerRef', $9::text,
                'externalReference', $4::text,
                'operationId', $1::uuid,
                'reservationId', $2::uuid,
                'state', 'accepted',
                'version', 2
              )
            ),
            updated_at = $7
      where intent.user_id = $10::uuid
        and intent.delivery_mode = 'app_handoff'
        and intent.action = 'buy'
        and intent.status in ('funding', 'executing', 'submitted')
        and intent.funding_operation_id = $1::uuid
        and intent.funding_reservation_id = $2::uuid
        and intent.result -> 'appHandoffFunding' ->> 'version' = '2'
        and intent.result -> 'appHandoffFunding' ->> 'operationId' = $1::text
        and intent.result -> 'appHandoffFundingReady' ->> 'reservationId' = $2::text`,
    [
      input.attempt.operationId,
      input.attempt.reservationId,
      input.attempt.id,
      input.externalReference,
      orderId,
      executionId,
      input.now,
      consumerKind,
      consumerRef,
      input.attempt.userId,
      persistedTradeTerminalOutcome(
        input.consumer.kind === "execution" ? "execution" : "web_order",
        input.consumerStatus,
      ) === "filled"
        ? "filled"
        : "submitted",
      input.venueOrderId,
    ],
  );
}

/**
 * A completed shortfall has already placed the exact destination amount at
 * the venue.  Its source reservation is therefore no longer a liability.
 * Keep the consumer reservation separate: it binds the next exact trade,
 * whereas these reservations only guarded the route before it became ready.
 */
export async function releaseCompletedTradeShortfallSourceReservationsInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    userId: string;
    now?: Date;
  }>,
): Promise<number> {
  const now = input.now ?? new Date();
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    { operationId: input.operationId, now },
  );
  const lifecycle = facts ? deriveFundingLifecycle(facts) : null;
  if (
    lifecycle?.status !== "completed" ||
    lifecycle.progressStage !== "terminal"
  ) {
    return 0;
  }
  const result = await client.query<{ id: string }>(
    `
      select reservation.id
      from balance_reservations reservation
      join funding_operations operation
        on operation.id = reservation.operation_id
       and operation.user_id = reservation.user_id
      where reservation.operation_id = $1
        and reservation.user_id = $2
        and reservation.state = 'active'
        and reservation.mode <> 'settled_for_consumer'
        and operation.purpose = 'trade_shortfall'
      order by reservation.id
      for update of reservation
    `,
    [input.operationId, input.userId],
  );
  for (const row of result.rows) {
    await releaseFundingReservationInTransaction(client, {
      reservationId: row.id,
      outcomeReason: "completed_trade_shortfall_source_released",
      now,
    });
  }
  return result.rows.length;
}

export async function consumeFundingReservationForLinkedConsumerInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    reservationId: string;
    tradeAttemptId?: string | null;
    tradeAttemptReconciliationClaimToken?: string | null;
    consumer: FundingReservationConsumer;
    outcomeReason: string;
    now?: Date;
  }>,
) {
  const identity = await client.query<{ operation_id: string }>(
    `select operation_id
       from balance_reservations
      where id = $1 and user_id = $2`,
    [input.reservationId, input.userId],
  );
  const expectedOperationId = identity.rows[0]?.operation_id;
  if (!expectedOperationId) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "settled funding reservation is not linked to authenticated user",
    );
  }
  await client.query(
    `select intent.id
       from telegram_trade_intents intent
      where intent.user_id = $1
        and intent.funding_operation_id = $2
      order by intent.id
      for update`,
    [input.userId, expectedOperationId],
  );
  const lockedOperation = await client.query<{ id: string }>(
    `select id
       from funding_operations
      where id = $1 and user_id = $2
      for update`,
    [expectedOperationId, input.userId],
  );
  if (!lockedOperation.rows[0]) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding operation is not available for trade consumption",
    );
  }
  const lockedReservation = await client.query<{ id: string }>(
    `select id
       from balance_reservations
      where id = $1
        and operation_id = $2
        and user_id = $3
      for update`,
    [input.reservationId, expectedOperationId, input.userId],
  );
  if (!lockedReservation.rows[0]) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding reservation disappeared before trade consumption",
    );
  }
  const scope = await loadFundingTradeReservationScope(client, {
    userId: input.userId,
    operationId: expectedOperationId,
    reservationId: input.reservationId,
  });
  const operationId = scope.operation_id;
  if (!scope.venue_id || !scope.market_id) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "trade funding reservation is missing an exact venue and market binding",
    );
  }

  let consumerKind: string;
  let consumerRef: string;
  let consumerStatus: string | null = null;
  let consumerVenueOrderId: string | null = null;
  let externalReference: string;
  let linked = false;
  if (input.consumer.kind === "web_order") {
    consumerKind = "web_order";
    consumerRef = input.consumer.orderId;
    const result = await client.query<{
      external_reference: string;
      status: string | null;
      venue_order_id: string | null;
    }>(
      `
        select coalesce(order_hash, venue_order_id, id::text) as external_reference,
               status,
               venue_order_id
        from orders
        where id = $1
          and user_id = $2
          and funding_operation_id = $3
          and funding_reservation_id = $4
          and venue = $5
          and side = 'BUY'
          and exists (
            select 1
            from unified_tokens token
            where token.market_id = $6
              and token.venue = $5
              and token.token_id = orders.token_id
          )
      `,
      [
        consumerRef,
        input.userId,
        operationId,
        input.reservationId,
        scope.venue_id,
        scope.market_id,
      ],
    );
    linked = result.rowCount === 1;
    externalReference = result.rows[0]?.external_reference ?? consumerRef;
    consumerStatus = result.rows[0]?.status ?? null;
    consumerVenueOrderId = result.rows[0]?.venue_order_id ?? null;
  } else if (input.consumer.kind === "execution") {
    consumerKind = "execution";
    consumerRef = input.consumer.executionId;
    const result = await client.query<{
      external_reference: string;
      status: string | null;
      venue_order_id: string | null;
    }>(
      `
        select coalesce(tx_signature, venue_order_id, id::text) as external_reference,
               status,
               venue_order_id
        from executions
        where id = $1
          and user_id = $2
          and funding_operation_id = $3
          and funding_reservation_id = $4
          and venue = $5
          and unified_market_id = $6
          and side = 'BUY'
      `,
      [
        consumerRef,
        input.userId,
        operationId,
        input.reservationId,
        scope.venue_id,
        scope.market_id,
      ],
    );
    linked = result.rowCount === 1;
    externalReference = result.rows[0]?.external_reference ?? consumerRef;
    consumerStatus = result.rows[0]?.status ?? null;
    consumerVenueOrderId = result.rows[0]?.venue_order_id ?? null;
  } else {
    consumerKind = "telegram_trade_intent";
    consumerRef = input.consumer.intentId;
    const result = await client.query<{ external_reference: string }>(
      `
        select coalesce(tx_signature, venue_order_id, id::text) as external_reference
        from telegram_trade_intents
        where id = $1
          and user_id = $2
          and funding_operation_id = $3
          and funding_reservation_id = $4
          and venue = $5
          and market_id = $6
          and action = 'buy'
      `,
      [
        consumerRef,
        input.userId,
        operationId,
        input.reservationId,
        scope.venue_id,
        scope.market_id,
      ],
    );
    linked = result.rowCount === 1;
    externalReference = result.rows[0]?.external_reference ?? consumerRef;
  }
  if (!linked) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "reservation consumer is not linked to authenticated user and operation",
    );
  }

  const now = input.now ?? new Date();
  const attempt = await acceptFundingTradeAttemptInTransaction(client, {
    userId: input.userId,
    operationId,
    reservationId: input.reservationId,
    attemptId: input.tradeAttemptId,
    expectedReconciliationClaimToken:
      input.tradeAttemptReconciliationClaimToken,
    externalReference,
    consumerKind: consumerKind as
      | "web_order"
      | "execution"
      | "telegram_trade_intent",
    consumerRef,
    now,
  });
  if (input.consumer.kind === "web_order") {
    await client.query(
      `
        update orders
        set funding_trade_attempt_id = $2
        where id = $1 and user_id = $3
      `,
      [consumerRef, attempt.id, input.userId],
    );
  } else if (input.consumer.kind === "execution") {
    await client.query(
      `
        update executions
        set funding_trade_attempt_id = $2
        where id = $1 and user_id = $3
      `,
      [consumerRef, attempt.id, input.userId],
    );
  }
  await advanceTelegramAppHandoffV2ConsumerInTransaction(client, {
    attempt,
    consumer: input.consumer,
    consumerStatus,
    externalReference,
    now,
    venueOrderId: consumerVenueOrderId ?? externalReference,
  });
  await completeReadyFundingOperation(client, {
    userId: input.userId,
    operationId,
    resolution: "consumed_by_trade",
    now,
  });
  return consumeFundingReservationInTransaction(client, {
    userId: input.userId,
    reservationId: input.reservationId,
    consumerKind,
    consumerRef,
    outcomeReason: input.outcomeReason,
    now,
  });
}

export async function releaseFundingReservationForAbandonedTradeInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    /** See failTelegramAppHandoffV2FundedIntentWithoutConsumerInTransaction. */
    handoffFailure?: Readonly<{ code: string; message: string }>;
    userId: string;
    link: FundingTradeReservationLink;
    outcomeReason: string;
    now?: Date;
  }>,
): Promise<void> {
  await client.query(
    `select intent.id
       from telegram_trade_intents intent
      where intent.user_id = $1
        and intent.funding_operation_id = $2
      order by intent.id
      for update`,
    [input.userId, input.link.operationId],
  );
  await client.query(
    `
      select id
      from funding_operations
      where id = $1 and user_id = $2
      for update
    `,
    [input.link.operationId, input.userId],
  );
  const scope = await loadFundingTradeReservationScope(client, {
    userId: input.userId,
    operationId: input.link.operationId,
    reservationId: input.link.reservationId,
  });
  if (scope.reservation_state === "released") return;
  if (scope.reservation_state !== "active") {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "consumed funding reservation cannot be abandoned",
    );
  }
  const now = input.now ?? new Date();
  if (input.handoffFailure) {
    await failTelegramAppHandoffV2FundedIntentWithoutConsumerInTransaction(
      client,
      {
        code: input.handoffFailure.code,
        message: input.handoffFailure.message,
        operationId: input.link.operationId,
        userId: input.userId,
      },
    );
  }
  await client.query(
    `
      update funding_trade_attempts
      set state = 'definitive_failure',
          broadcast_may_have_occurred = false,
          error_code = 'cancelled_before_submission',
          resolved_at = $4,
          updated_at = $4
      where user_id = $1
        and operation_id = $2
        and reservation_id = $3
        and state = 'claimed'
    `,
    [input.userId, input.link.operationId, input.link.reservationId, now],
  );
  if (
    await hasUnresolvedFundingTradeAttemptInTransaction(client, {
      userId: input.userId,
      operationId: input.link.operationId,
      reservationId: input.link.reservationId,
    })
  ) {
    throw new FundingPersistenceError(
      "trade_submission_reconciling",
      "funding reservation has an unresolved trade attempt and must reconcile before release",
    );
  }
  await releaseFundingReservationInTransaction(client, {
    reservationId: input.link.reservationId,
    outcomeReason: input.outcomeReason,
    now,
  });
  await completeReadyFundingOperation(client, {
    userId: input.userId,
    operationId: input.link.operationId,
    resolution: "released_to_venue_cash",
    now,
  });
}

/**
 * Close only the v2 funding intent attached to an operation that lost its
 * reservation without a durable venue order. A definitive provider rejection
 * can occur after the handoff atomically claimed its attempt, so `executing`
 * is also safe to close here. Ordinary web funding and any intent with a
 * durable venue reference retain their existing reconciliation paths.
 */
export async function failTelegramAppHandoffV2FundedIntentWithoutConsumerInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    code: string;
    message: string;
    operationId: string;
    userId: string;
  }>,
): Promise<void> {
  await client.query(
    `update telegram_trade_intents intent
        set status = 'failed',
            error_code = $3::text,
            error_message = $4::text,
            updated_at = clock_timestamp()
      where intent.user_id = $1::uuid
        and intent.funding_operation_id = $2::uuid
        and intent.action = 'buy'
        and intent.delivery_mode = 'app_handoff'
        and intent.status in ('funding', 'executing')
        and intent.order_id is null
        and intent.execution_id is null
        and intent.venue_order_id is null
        and intent.tx_signature is null
        and intent.result->'appHandoffExecution'->>'version' = '2'
        and (
          intent.result->'appHandoffExecution'->>'kind' = 'funding'
          or (
            intent.result->'appHandoffExecution'->>'kind' is null
            and intent.result->'appHandoffFunding'->>'version' = '2'
            and intent.result->'appHandoffFunding'->>'operationId'
              = intent.funding_operation_id::text
            and intent.result->'appHandoffFunding'->>'handoffId'
              = intent.result->'appHandoffExecution'->>'handoffId'
          )
        )`,
    [input.userId, input.operationId, input.code, input.message],
  );
}

export async function releaseFundingReservationForAbandonedTrade(
  pool: Pool,
  input: Parameters<
    typeof releaseFundingReservationForAbandonedTradeInTransaction
  >[1],
): Promise<void> {
  await tx(pool, (client) =>
    releaseFundingReservationForAbandonedTradeInTransaction(client, input),
  );
}

export async function releaseFundingReservationForDefinitiveTradeFailure(
  pool: Pool,
  input: Readonly<{
    userId: string;
    link: FundingTradeReservationLink;
    tradeAttemptId: string;
    outcomeReason: string;
    errorCode?: string | null;
    externalReference?: string | null;
    broadcastMayHaveOccurred: boolean;
    operationSupportMetadataPatch?: JsonRecord;
    /** Preserve a precise sealed-handoff terminal reason when one is known. */
    handoffFailure?: Readonly<{ code: string; message: string }>;
    now?: Date;
  }>,
): Promise<void> {
  await tx(pool, async (client) => {
    await recordFundingTradeAttemptOutcomeInTransaction(client, {
      userId: input.userId,
      attemptId: input.tradeAttemptId,
      outcome: "definitive_failure",
      externalReference: input.externalReference,
      errorCode: input.errorCode,
      broadcastMayHaveOccurred: input.broadcastMayHaveOccurred,
      operationSupportMetadataPatch: input.operationSupportMetadataPatch,
      now: input.now,
    });
    await releaseFundingReservationForAbandonedTradeInTransaction(client, {
      userId: input.userId,
      link: input.link,
      outcomeReason: input.outcomeReason,
      handoffFailure: input.handoffFailure ?? {
        code: input.errorCode?.trim() || "funding_trade_failed",
        message: "Funding could not complete before the Buy was submitted.",
      },
      now: input.now,
    });
  });
}

export async function releaseFundingReservationForProvenAbsentLimitlessTrade(
  pool: Pool,
  input: Readonly<{
    clientOrderId: string;
    expectedClaimToken: string;
    link: FundingTradeReservationLink;
    minimumAgeMs: number;
    now?: Date;
    operationSupportMetadataPatch?: JsonRecord;
    tradeAttemptId: string;
    userId: string;
  }>,
): Promise<void> {
  await tx(pool, async (client) => {
    await proveAmbiguousLimitlessTradeAttemptAbsentInTransaction(client, {
      attemptId: input.tradeAttemptId,
      clientOrderId: input.clientOrderId,
      expectedClaimToken: input.expectedClaimToken,
      minimumAgeMs: input.minimumAgeMs,
      now: input.now,
      operationSupportMetadataPatch: input.operationSupportMetadataPatch,
      userId: input.userId,
    });
    await releaseFundingReservationForAbandonedTradeInTransaction(client, {
      handoffFailure: {
        code: "limitless_exact_status_not_found",
        message:
          "Limitless did not accept the prior order. The funded balance is available to try again.",
      },
      userId: input.userId,
      link: input.link,
      outcomeReason: "trade_not_accepted",
      now: input.now,
    });
  });
}

export async function releaseFundingReservationForProvenLimitlessFokNoFill(
  pool: Pool,
  input: Readonly<{
    clientOrderId: string;
    expectedClaimToken: string;
    link: FundingTradeReservationLink;
    now?: Date;
    tradeAttemptId: string;
    userId: string;
  }>,
): Promise<void> {
  await tx(pool, async (client) => {
    await proveAmbiguousLimitlessFokNoFillInTransaction(client, {
      attemptId: input.tradeAttemptId,
      clientOrderId: input.clientOrderId,
      expectedClaimToken: input.expectedClaimToken,
      now: input.now,
      userId: input.userId,
    });
    await releaseFundingReservationForAbandonedTradeInTransaction(client, {
      userId: input.userId,
      link: input.link,
      outcomeReason: "trade_no_fill",
      handoffFailure: {
        code: "trade_no_fill",
        message: "Limitless could not fill the funded Buy. Nothing was bought.",
      },
      now: input.now,
    });
  });
}

export async function releaseFundingReservationForProvenLimitlessTerminalRejection(
  pool: Pool,
  input: Readonly<{
    clientOrderId: string;
    errorCode: string;
    expectedClaimToken: string;
    link: FundingTradeReservationLink;
    now?: Date;
    tradeAttemptId: string;
    userId: string;
  }>,
): Promise<void> {
  await tx(pool, async (client) => {
    await proveAmbiguousLimitlessTerminalRejectionInTransaction(client, {
      attemptId: input.tradeAttemptId,
      clientOrderId: input.clientOrderId,
      errorCode: input.errorCode,
      expectedClaimToken: input.expectedClaimToken,
      now: input.now,
      userId: input.userId,
    });
    await releaseFundingReservationForAbandonedTradeInTransaction(client, {
      userId: input.userId,
      link: input.link,
      outcomeReason: "trade_rejected",
      handoffFailure: {
        code: input.errorCode,
        message:
          "Limitless conclusively reported that the prior order was not accepted.",
      },
      now: input.now,
    });
  });
}

export type FundingRouteOutcome =
  | "succeeded"
  | "refunded"
  | "failed"
  | "reconcile_required"
  | "recovery_required"
  | "cancelled";

export async function startFundingRouteObservationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
    routeKeyHmac: string;
    routeKeyVersion: number;
    providerId: string;
    adapterVersion: number;
    amountBand: string;
    policyRevision: string;
    startedAt?: Date;
    supportMetadata?: JsonRecord;
  }>,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `
      insert into funding_route_observations (
        user_id,
        operation_id,
        route_key_hmac,
        route_key_version,
        provider_id,
        adapter_version,
        amount_band,
        started_at,
        outcome,
        policy_revision,
        support_metadata
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, 'in_progress', $9, $10::jsonb
      )
      returning id
    `,
    [
      input.userId,
      input.operationId,
      input.routeKeyHmac,
      input.routeKeyVersion,
      input.providerId,
      input.adapterVersion,
      input.amountBand,
      input.startedAt ?? new Date(),
      input.policyRevision,
      input.supportMetadata ?? {},
    ],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding route observation ownership was rejected",
    );
  }
  return id;
}

export async function finishFundingRouteObservationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    routeObservationId: string;
    outcome: FundingRouteOutcome;
    latencyStages: JsonRecord;
    refundObserved: boolean;
    recoveryRequired: boolean;
    reasonCodes?: readonly string[];
    supportMetadata?: JsonRecord;
    finishedAt?: Date;
  }>,
): Promise<void> {
  const result = await client.query(
    `
      update funding_route_observations
      set finished_at = $4,
          latency_stages = $5::jsonb,
          outcome = $3,
          refund_observed = $6,
          recovery_required = $7,
          reason_codes = $8::text[],
          support_metadata = support_metadata || $9::jsonb
      where id = $1
        and user_id = $2
        and outcome = 'in_progress'
        and finished_at is null
    `,
    [
      input.routeObservationId,
      input.userId,
      input.outcome,
      input.finishedAt ?? new Date(),
      input.latencyStages,
      input.refundObserved,
      input.recoveryRequired,
      input.reasonCodes ?? [],
      input.supportMetadata ?? {},
    ],
  );
  if (result.rowCount !== 1) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding route observation is already terminal or out of scope",
    );
  }
}

export async function upsertFundingProviderRequestInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    segmentId: string;
    requestKind: "initial" | "child";
    requestRefCiphertext: string | null;
    requestRefLookupHmac: string;
    rawStatus: string | null;
    discoverySource: string;
    lookupKeyVersion: number;
    observedAt?: Date;
    supportMetadata?: JsonRecord;
  }>,
): Promise<Readonly<{ id: string; replayed: boolean }>> {
  const observedAt = input.observedAt ?? new Date();
  const { rows } = await client.query<{
    id: string;
    inserted: boolean;
    request_kind: "initial" | "child";
    request_ref_ciphertext: string | null;
    lookup_key_version: number;
    discovery_source: string;
  }>(
    `
      with owned_segment as (
        select segment.id
        from funding_operation_segments segment
        where segment.id = $1 and segment.operation_id = $2
      ),
      written as (
        insert into funding_provider_requests (
          segment_id,
          request_kind,
          request_ref_ciphertext,
          request_ref_lookup_hmac,
          raw_status,
          discovery_source,
          lookup_key_version,
          first_seen_at,
          last_seen_at,
          support_metadata
        )
        select
          owned_segment.id,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $9,
          $10::jsonb
        from owned_segment
        on conflict (segment_id, request_ref_lookup_hmac) do update set
          raw_status = excluded.raw_status,
          last_seen_at = greatest(
            funding_provider_requests.last_seen_at,
            excluded.last_seen_at
          ),
          support_metadata =
            funding_provider_requests.support_metadata
            || excluded.support_metadata
        returning
          id,
          request_kind,
          request_ref_ciphertext,
          lookup_key_version,
          discovery_source,
          (xmax = 0) as inserted
      )
      select * from written
    `,
    [
      input.segmentId,
      input.operationId,
      input.requestKind,
      input.requestRefCiphertext,
      input.requestRefLookupHmac,
      input.rawStatus,
      input.discoverySource,
      input.lookupKeyVersion,
      observedAt,
      input.supportMetadata ?? {},
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding segment was not found for operation",
    );
  }
  const identityMismatches = [
    row.request_kind !== input.requestKind ? "request_kind" : null,
    row.request_ref_ciphertext !== input.requestRefCiphertext
      ? "request_ref_ciphertext"
      : null,
    row.lookup_key_version !== input.lookupKeyVersion
      ? "lookup_key_version"
      : null,
    row.discovery_source !== input.discoverySource ? "discovery_source" : null,
  ].filter((value): value is string => value !== null);
  if (identityMismatches.length > 0) {
    throw new FundingPersistenceError(
      "idempotency_conflict",
      `provider request fingerprint was reused with different identity (${identityMismatches.join(", ")})`,
    );
  }
  return { id: row.id, replayed: !row.inserted };
}
