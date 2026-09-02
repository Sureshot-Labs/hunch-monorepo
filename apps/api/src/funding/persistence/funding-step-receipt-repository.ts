import { tx, type Pool, type PoolClient } from "@hunch/infra";
import bs58 from "bs58";

import { activateTelegramTradeShortfallRouterDependentFundInTransaction } from "../execution/telegram-trade-shortfall-activation.js";
import {
  relayClientSourceDebitPostcondition,
  withRelayClientSourceDebitPostcondition,
} from "../execution/relay-client-source-debit.js";
import { directWithdrawalActionValidation } from "../execution/direct-withdrawal-transfer.js";

import { isReceiptBearingFundingActionKind } from "../domain/action-kinds.js";
import { isRawAmount } from "../domain/raw-amount.js";
import type { JsonValue, NormalizedAction } from "../domain/types.js";
import { moneySchema, normalizedActionSchema } from "../domain/schemas.js";
import {
  allocateFundingObservationInTransaction,
  FundingPersistenceError,
  transitionFundingOperationInTransaction,
  type FundingOperationRow,
} from "./funding-operation-repository.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type FundingStepReceiptStatus =
  | "pending"
  | "confirmed"
  | "finalized"
  | "failed"
  | "mismatch"
  | "reorged";

export type FundingStepReceiptTarget = Readonly<{
  operationId: string;
  stepId: string;
  segmentId: string | null;
  attemptId: string;
  stepKind: "transaction" | "external_handoff" | "venue_preparation";
  payerRequirement:
    | "none"
    | "user"
    | "provider"
    | "privy_sponsor"
    | "hunch_sponsor";
  stepState:
    | "planned"
    | "action_required"
    | "submitted"
    | "succeeded"
    | "reconcile_required"
    | "recovery_required"
    | "failed"
    | "cancelled";
  networkId: string;
  action: NormalizedAction;
  actionValidationResult: JsonRecord;
  receiptRefCiphertext: string;
  receiptRefLookupHmac: string;
  lookupKeyVersion: number;
  previousReceipt: FundingStepReceiptObservation | null;
}>;

type ReceiptManagedStepState =
  | FundingStepReceiptTarget["stepState"]
  | "action_required";

export type FundingStepReceiptObservation = Readonly<{
  operationId: string;
  stepId: string;
  attemptId: string;
  networkId: string;
  status: FundingStepReceiptStatus;
  actionMatch: boolean | null;
  ledgerHeight: string | null;
  blockHash: string | null;
  canonical: boolean;
  failureCode: string | null;
  evidence: JsonRecord;
  firstSeenAt: Date;
  observedAt: Date;
  finalizedAt: Date | null;
  reorgedAt: Date | null;
}>;

type ReceiptDbRow = {
  operation_id: string;
  step_id: string;
  attempt_id: string;
  network_id: string;
  status: FundingStepReceiptStatus;
  action_match: boolean | null;
  ledger_height: string | null;
  block_hash: string | null;
  canonical: boolean;
  failure_code: string | null;
  evidence: JsonRecord;
  first_seen_at: Date;
  observed_at: Date;
  finalized_at: Date | null;
  reorged_at: Date | null;
};

const receiptColumns = `
  operation_id,
  step_id,
  attempt_id,
  network_id,
  status,
  action_match,
  ledger_height,
  block_hash,
  canonical,
  failure_code,
  evidence,
  first_seen_at,
  observed_at,
  finalized_at,
  reorged_at
`;

function mapReceipt(row: ReceiptDbRow): FundingStepReceiptObservation {
  return {
    operationId: row.operation_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    networkId: row.network_id,
    status: row.status,
    actionMatch: row.action_match,
    ledgerHeight: row.ledger_height,
    blockHash: row.block_hash,
    canonical: row.canonical,
    failureCode: row.failure_code,
    evidence: row.evidence,
    firstSeenAt: row.first_seen_at,
    observedAt: row.observed_at,
    finalizedAt: row.finalized_at,
    reorgedAt: row.reorged_at,
  };
}

export async function listFundingStepReceiptTargets(
  db: Pick<Pool, "query">,
  operationId: string,
  now = new Date(),
): Promise<readonly FundingStepReceiptTarget[]> {
  const { rows } = await db.query<{
    operation_id: string;
    step_id: string;
    segment_id: string | null;
    attempt_id: string;
    step_kind: FundingStepReceiptTarget["stepKind"];
    executor_id: string;
    payer_requirement: FundingStepReceiptTarget["payerRequirement"];
    step_state: FundingStepReceiptTarget["stepState"];
    normalized_action: JsonRecord;
    action_validation_result: JsonRecord;
    requested_source_amount: JsonRecord | null;
    operation_support_metadata: JsonRecord;
    receipt_ref_ciphertext: string;
    receipt_ref_lookup_hmac: string;
    lookup_key_version: number;
    receipt_operation_id: string | null;
    receipt_step_id: string | null;
    receipt_attempt_id: string | null;
    receipt_network_id: string | null;
    receipt_status: FundingStepReceiptStatus | null;
    receipt_action_match: boolean | null;
    receipt_ledger_height: string | null;
    receipt_block_hash: string | null;
    receipt_canonical: boolean | null;
    receipt_failure_code: string | null;
    receipt_evidence: JsonRecord | null;
    receipt_first_seen_at: Date | null;
    receipt_observed_at: Date | null;
    receipt_finalized_at: Date | null;
    receipt_reorged_at: Date | null;
  }>(
    `
      select
        step.operation_id,
        step.id as step_id,
        step.segment_id,
        attempt.id as attempt_id,
        step.step_kind,
        step.executor_id,
        step.payer_requirement,
        step.state as step_state,
        step.normalized_action,
        case
          when step.executor_id = 'telegram_relay_evm_funding_v1'
           and step.action_validation_result ->> 'relayStepKind' = 'cleanup'
           and step.action_validation_result ->> 'signerAddress' is null
          then step.action_validation_result || jsonb_build_object(
            'signerAddress',
            (
              select min(funding_authorization.wallet_address)
                from telegram_funding_authorization_reservations reservation
                join telegram_funding_authorizations funding_authorization
                  on funding_authorization.id = reservation.authorization_id
                 and funding_authorization.user_id = operation.user_id
                 and funding_authorization.profile_id =
                       'telegram_relay_evm_funding_v1'
               where reservation.cleanup_operation_id = operation.id
               having count(*) = 1
            )
          )
          else step.action_validation_result
        end as action_validation_result,
        operation.requested_source_amount,
        operation.support_metadata as operation_support_metadata,
        attempt.receipt_ref_ciphertext,
        attempt.receipt_ref_lookup_hmac,
        attempt.lookup_key_version,
        receipt.operation_id as receipt_operation_id,
        receipt.step_id as receipt_step_id,
        receipt.attempt_id as receipt_attempt_id,
        receipt.network_id as receipt_network_id,
        receipt.status as receipt_status,
        receipt.action_match as receipt_action_match,
        receipt.ledger_height as receipt_ledger_height,
        receipt.block_hash as receipt_block_hash,
        receipt.canonical as receipt_canonical,
        receipt.failure_code as receipt_failure_code,
        receipt.evidence as receipt_evidence,
        receipt.first_seen_at as receipt_first_seen_at,
        receipt.observed_at as receipt_observed_at,
        receipt.finalized_at as receipt_finalized_at,
        receipt.reorged_at as receipt_reorged_at
      from funding_operation_steps step
      join funding_operation_step_attempts attempt
        on attempt.step_id = step.id
       and attempt.broadcast_may_have_occurred
       and attempt.reference_kind <> 'provider_receipt'
       and attempt.receipt_ref_ciphertext is not null
       and attempt.receipt_ref_lookup_hmac is not null
       and attempt.lookup_key_version is not null
      left join funding_step_receipt_observations receipt
        on receipt.attempt_id = attempt.id
      join funding_operations operation
        on operation.id = step.operation_id
      where step.operation_id = $1
        and (
          operation.status not in ('completed', 'refunded', 'failed', 'cancelled')
          or (
            attempt.broadcast_may_have_occurred
            and (
              receipt.attempt_id is null
              or receipt.status in ('pending', 'confirmed', 'mismatch', 'reorged')
              or (
                receipt.status in ('finalized', 'failed')
                and receipt.canonical
                and receipt.finalized_at >=
                      $2::timestamptz - interval '15 minutes'
              )
            )
          )
        )
        and (
          step.state in (
            'submitted',
            'reconcile_required',
            'recovery_required'
          )
          -- A postcondition may prove a step succeeded before its broadcast
          -- receipt reaches finality. Keep polling every succeeded step until
          -- the operation itself terminates so confirmed receipts can advance
          -- to finalized and finalized receipts remain reorg-monitored.
          or step.state = 'succeeded'
          -- A canonical failed receipt authorizes retry only after a bounded
          -- reorg watch. Keep polling it regardless of the re-armed step state
          -- until that fence expires.
          or (
            step.executor_id = 'telegram_relay_evm_funding_v1'
            and receipt.status = 'failed'
            and receipt.canonical
            and receipt.evidence ->> 'failureFinalized' = 'true'
            and receipt.finalized_at >= $2::timestamptz - interval '15 minutes'
          )
          -- Legacy incidents may have terminalized the operation or step
          -- while a sibling's durable attempt still carries a transaction.
          -- Keep that exact reference observable instead of orphaning it.
          or (
            operation.status in ('completed', 'refunded', 'failed', 'cancelled')
            and attempt.broadcast_may_have_occurred
          )
        )
      order by step.ordinal, attempt.attempt_number
    `,
    [operationId, now],
  );
  return rows.map((row) => {
    const action = normalizedActionSchema.parse(
      row.normalized_action,
    ) as unknown as NormalizedAction;
    if (!isReceiptBearingFundingActionKind(action.kind)) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "broadcast receipt is linked to a non-receipt-bearing action",
      );
    }
    const previousReceipt =
      row.receipt_status &&
      row.receipt_operation_id &&
      row.receipt_step_id &&
      row.receipt_attempt_id &&
      row.receipt_network_id &&
      row.receipt_canonical !== null &&
      row.receipt_evidence &&
      row.receipt_first_seen_at &&
      row.receipt_observed_at
        ? mapReceipt({
            operation_id: row.receipt_operation_id,
            step_id: row.receipt_step_id,
            attempt_id: row.receipt_attempt_id,
            network_id: row.receipt_network_id,
            status: row.receipt_status,
            action_match: row.receipt_action_match,
            ledger_height: row.receipt_ledger_height,
            block_hash: row.receipt_block_hash,
            canonical: row.receipt_canonical,
            failure_code: row.receipt_failure_code,
            evidence: row.receipt_evidence,
            first_seen_at: row.receipt_first_seen_at,
            observed_at: row.receipt_observed_at,
            finalized_at: row.receipt_finalized_at,
            reorged_at: row.receipt_reorged_at,
          })
        : null;
    const sourceAmount = moneySchema.safeParse(row.requested_source_amount);
    const actionValidationResult =
      row.executor_id === "wallet_profile_evm_v1" && sourceAmount.success
        ? withRelayClientSourceDebitPostcondition({
            action,
            actionValidationResult: row.action_validation_result,
            routeId:
              typeof row.operation_support_metadata.routeId === "string"
                ? row.operation_support_metadata.routeId
                : null,
            sourceAmount: sourceAmount.data,
          })
        : row.action_validation_result;
    return {
      operationId: row.operation_id,
      stepId: row.step_id,
      segmentId: row.segment_id,
      attemptId: row.attempt_id,
      stepKind: row.step_kind,
      payerRequirement: row.payer_requirement,
      stepState: row.step_state,
      networkId: action.networkId,
      action,
      actionValidationResult,
      receiptRefCiphertext: row.receipt_ref_ciphertext,
      receiptRefLookupHmac: row.receipt_ref_lookup_hmac,
      lookupKeyVersion: row.lookup_key_version,
      previousReceipt,
    };
  });
}

export type FundingStepReceiptEvidence = Readonly<{
  status: FundingStepReceiptStatus;
  actionMatch: boolean | null;
  ledgerHeight: string | null;
  blockHash: string | null;
  canonical: boolean;
  failureCode: string | null;
  evidence: JsonRecord;
}>;

const receiptRank: Readonly<Record<FundingStepReceiptStatus, number>> = {
  pending: 0,
  confirmed: 1,
  finalized: 2,
  failed: 3,
  mismatch: 3,
  reorged: 4,
};

export function shouldIgnoreFundingStepReceiptUpdate(
  previous: FundingStepReceiptStatus,
  incoming: FundingStepReceiptEvidence,
): boolean {
  if (previous === incoming.status) return false;
  if (
    previous === "mismatch" &&
    incoming.status === "finalized" &&
    incoming.actionMatch === true &&
    incoming.canonical
  ) {
    return false;
  }
  if (previous === "failed") return incoming.status !== "reorged";
  if (["mismatch", "reorged"].includes(previous)) return true;
  if (previous === "finalized") return incoming.status !== "reorged";
  return receiptRank[incoming.status] < receiptRank[previous];
}

export function fundingStepStateForReceipt(
  receipt: FundingStepReceiptStatus,
  current: FundingStepReceiptTarget["stepState"],
  stepKind: FundingStepReceiptTarget["stepKind"],
): ReceiptManagedStepState {
  // Legacy inconsistent rows can carry a real broadcast reference after the
  // step was stopped. Receipt evidence is still persisted and reduced at the
  // operation level, but the immutable step state cannot be resurrected.
  if (current === "failed" || current === "cancelled") return current;
  if (receipt === "finalized") {
    if (stepKind === "venue_preparation") {
      // A finalized receipt only advances preparation into postcondition
      // verification. Once that verifier succeeds (or recovery is required),
      // later receipt polls must not move the step backwards.
      return current === "reconcile_required" ? "submitted" : current;
    }
    return "succeeded";
  }
  if (receipt === "failed") return "action_required";
  if (receipt === "mismatch") return "recovery_required";
  if (receipt === "reorged") return "recovery_required";
  if (receipt === "confirmed" && current === "reconcile_required") {
    return "submitted";
  }
  return current;
}

export async function applyFundingStepReceiptEvidenceInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    stepId: string;
    attemptId: string;
    networkId: string;
    receipt: FundingStepReceiptEvidence;
    now?: Date;
  }>,
): Promise<FundingStepReceiptObservation> {
  const now = input.now ?? new Date();
  const operationResult = await client.query<{
    operation_progress_stage: FundingOperationRow["progressStage"];
    operation_status: FundingOperationRow["status"];
    operation_version: string | number;
    requested_source_amount: JsonRecord | null;
    operation_support_metadata: JsonRecord;
  }>(
    `
      select requested_source_amount,
             support_metadata as operation_support_metadata,
             progress_stage as operation_progress_stage,
             status as operation_status,
             version as operation_version
      from funding_operations
      where id = $1
      for update
    `,
    [input.operationId],
  );
  const scopedOperation = operationResult.rows[0];
  if (!scopedOperation) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding step receipt target no longer exists",
    );
  }
  const stepResult = await client.query<{
    step_state: FundingStepReceiptTarget["stepState"];
    step_kind: FundingStepReceiptTarget["stepKind"];
    executor_id: string;
    segment_id: string | null;
    normalized_action: JsonRecord;
    action_validation_result: JsonRecord;
  }>(
    `
      select step.state as step_state,
             step.step_kind,
             step.executor_id,
             step.segment_id,
             step.normalized_action,
             step.action_validation_result
      from funding_operation_steps step
      where step.operation_id = $1
        and step.id = $2
      for update of step
    `,
    [input.operationId, input.stepId],
  );
  const scoped = stepResult.rows[0];
  if (!scoped) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding step receipt target no longer exists",
    );
  }
  const attemptResult = await client.query<{ id: string }>(
    `
      select id
      from funding_operation_step_attempts
      where step_id = $1
        and id = $2
        and broadcast_may_have_occurred
      for update
    `,
    [input.stepId, input.attemptId],
  );
  if (!attemptResult.rows[0]) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding step receipt target no longer exists",
    );
  }

  const existing = await client.query<ReceiptDbRow>(
    `
      select ${receiptColumns}
      from funding_step_receipt_observations
      where attempt_id = $1
      for update
    `,
    [input.attemptId],
  );
  const previous = existing.rows[0];
  if (
    previous &&
    shouldIgnoreFundingStepReceiptUpdate(previous.status, input.receipt)
  ) {
    return mapReceipt(previous);
  }

  const incomingIsFinal =
    input.receipt.status === "finalized" ||
    (input.receipt.status === "failed" &&
      input.receipt.canonical &&
      input.receipt.evidence.failureFinalized === true);
  const finalizedAt = incomingIsFinal ? (previous?.finalized_at ?? now) : null;
  const reorgedAt = input.receipt.status === "reorged" ? now : null;
  const stored = await client.query<ReceiptDbRow>(
    `
      insert into funding_step_receipt_observations (
        operation_id,
        step_id,
        attempt_id,
        network_id,
        status,
        action_match,
        ledger_height,
        block_hash,
        canonical,
        failure_code,
        evidence,
        first_seen_at,
        observed_at,
        finalized_at,
        reorged_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
        $12, $12, $13, $14
      )
      on conflict (attempt_id) do update
      set status = excluded.status,
          action_match = excluded.action_match,
          ledger_height = excluded.ledger_height,
          block_hash = excluded.block_hash,
          canonical = excluded.canonical,
          failure_code = excluded.failure_code,
          -- Provider polling and profile-specific postcondition verification
          -- are independent writers. A later receipt observation may advance
          -- finality or refresh provider metadata, but it must never erase
          -- causal evidence already attached by the profile verifier.
          evidence = funding_step_receipt_observations.evidence || excluded.evidence,
          observed_at = excluded.observed_at,
          finalized_at = excluded.finalized_at,
          reorged_at = excluded.reorged_at
      returning ${receiptColumns}
    `,
    [
      input.operationId,
      input.stepId,
      input.attemptId,
      input.networkId,
      input.receipt.status,
      input.receipt.actionMatch,
      input.receipt.ledgerHeight,
      input.receipt.blockHash,
      input.receipt.canonical,
      input.receipt.failureCode,
      input.receipt.evidence,
      now,
      finalizedAt,
      reorgedAt,
    ],
  );
  const row = stored.rows[0];
  if (!row) throw new Error("funding step receipt upsert returned no row");

  const previousWasCanonicalFinalSuccess =
    previous?.status === "finalized" &&
    previous.action_match === true &&
    previous.canonical;
  const firstCanonicalFinalSuccess =
    row.status === "finalized" &&
    row.action_match === true &&
    row.canonical &&
    !previousWasCanonicalFinalSuccess;
  if (
    firstCanonicalFinalSuccess &&
    ["completed", "refunded", "failed", "cancelled"].includes(
      scopedOperation.operation_status,
    )
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
      errorCode: "late_finalized_receipt_after_terminal_operation",
      recoveryMode: "automatic_evidence",
      now,
    });
  }

  if (
    scoped.executor_id === "wallet_profile_evm_v1" &&
    row.status === "finalized" &&
    row.action_match === true &&
    row.canonical
  ) {
    const action = normalizedActionSchema.parse(
      scoped.normalized_action,
    ) as unknown as NormalizedAction;
    const sourceAmount = moneySchema.safeParse(
      scopedOperation.requested_source_amount,
    );
    const actionValidationResult = sourceAmount.success
      ? withRelayClientSourceDebitPostcondition({
          action,
          actionValidationResult: scoped.action_validation_result,
          routeId:
            typeof scopedOperation.operation_support_metadata.routeId ===
            "string"
              ? scopedOperation.operation_support_metadata.routeId
              : null,
          sourceAmount: sourceAmount.data,
        })
      : scoped.action_validation_result;
    const postcondition = relayClientSourceDebitPostcondition(
      actionValidationResult,
    );
    const observationKind = directWithdrawalActionValidation(
      actionValidationResult,
    )
      ? "destination_credit"
      : "source_debit";
    const attributedSourceRaw = row.evidence.attributedSourceRaw;
    const sourceDebitEventIndex = row.evidence.sourceDebitEventIndex;
    const transactionHash = row.evidence.transactionHash;
    if (
      postcondition &&
      attributedSourceRaw === postcondition.expectedSourceRaw &&
      isRawAmount(sourceDebitEventIndex) &&
      typeof transactionHash === "string" &&
      /^0x[0-9a-fA-F]{64}$/u.test(transactionHash) &&
      row.ledger_height &&
      row.block_hash &&
      row.finalized_at
    ) {
      await allocateFundingObservationInTransaction(client, {
        operationId: input.operationId,
        segmentId: scoped.segment_id,
        kind: observationKind,
        networkId: input.networkId,
        assetId: postcondition.expectedSourceAssetId,
        assetDecimals: postcondition.expectedSourceAssetDecimals,
        txHash: transactionHash.toLowerCase(),
        eventIndex: sourceDebitEventIndex,
        fromAddress: postcondition.expectedSourceAddress,
        toAddress: postcondition.expectedSourceRecipient,
        rawAmount: postcondition.expectedSourceRaw,
        observedAt: row.observed_at,
        ledgerHeight: row.ledger_height,
        blockHash: row.block_hash,
        finalityStatus: "finalized",
        finalizedAt: row.finalized_at,
        metadata: {
          observerId:
            observationKind === "destination_credit"
              ? "direct_withdrawal_receipt_destination_credit_v1"
              : "relay_client_receipt_source_debit_v1",
          receiptAttemptId: input.attemptId,
        },
      });
    }
  }

  if (
    scoped.executor_id === "wallet_profile_svm_v1" &&
    row.status === "finalized" &&
    row.action_match === true &&
    row.canonical
  ) {
    const validation = directWithdrawalActionValidation(
      scoped.action_validation_result,
    );
    const transactionSignature = row.evidence.transactionSignature;
    let signatureLength = 0;
    if (typeof transactionSignature === "string") {
      try {
        signatureLength = bs58.decode(transactionSignature).length;
      } catch {
        signatureLength = 0;
      }
    }
    if (
      validation?.kind === "exact_sol_withdrawal" &&
      typeof transactionSignature === "string" &&
      signatureLength === 64 &&
      row.ledger_height &&
      row.finalized_at
    ) {
      await allocateFundingObservationInTransaction(client, {
        operationId: input.operationId,
        segmentId: scoped.segment_id,
        kind: "destination_credit",
        networkId: input.networkId,
        assetId: validation.expectedSourceAssetId,
        assetDecimals: validation.expectedSourceAssetDecimals,
        txHash: transactionSignature,
        eventIndex: "0",
        fromAddress: validation.expectedSourceAddress,
        toAddress: validation.expectedSourceRecipient,
        rawAmount: validation.expectedSourceRaw,
        observedAt: row.observed_at,
        ledgerHeight: row.ledger_height,
        blockHash: row.block_hash,
        finalityStatus: "finalized",
        finalizedAt: row.finalized_at,
        metadata: {
          observerId: "direct_sol_withdrawal_receipt_destination_credit_v1",
          receiptAttemptId: input.attemptId,
        },
      });
    }
  }

  if (input.receipt.status === "reorged") {
    await client.query(
      `
        update funding_observations
        set finality_status = 'reorged',
            canonical = false,
            reorged_at = $2,
            metadata = metadata || jsonb_build_object(
              'receiptReorged', true,
              'receiptReorgedAt', $2::timestamptz
            ),
            updated_at = $2
        where operation_id = $1
          and (
            (kind = 'venue_readiness' and $4 = 'venue_preparation')
            or (
              kind in ('source_debit', 'destination_credit')
              and $4 = 'transaction'
            )
          )
          and metadata->>'receiptAttemptId' = $3
          and canonical
          and finality_status = 'finalized'
      `,
      [input.operationId, now, input.attemptId, scoped.step_kind],
    );
  }

  const nextStepState = fundingStepStateForReceipt(
    input.receipt.status,
    scoped.step_state,
    scoped.step_kind,
  );
  if (nextStepState !== scoped.step_state) {
    const updated = await client.query(
      `
        update funding_operation_steps
        set state = $4,
            updated_at = $5
        where operation_id = $1
          and id = $2
          and state = $3
      `,
      [input.operationId, input.stepId, scoped.step_state, nextStepState, now],
    );
    if (updated.rowCount !== 1) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "funding step state changed while applying receipt evidence",
      );
    }
    if (
      nextStepState === "succeeded" &&
      scoped.step_kind === "transaction" &&
      input.receipt.status === "finalized"
    ) {
      await activateTelegramTradeShortfallRouterDependentFundInTransaction(
        client,
        {
          operationId: input.operationId,
          approvalStepId: input.stepId,
        },
      );
    }
  }
  return mapReceipt(row);
}

export async function applyFundingStepReceiptEvidence(
  pool: Pool,
  input: Parameters<typeof applyFundingStepReceiptEvidenceInTransaction>[1],
): Promise<FundingStepReceiptObservation> {
  return tx(pool, (client) =>
    applyFundingStepReceiptEvidenceInTransaction(client, input),
  );
}
