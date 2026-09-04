import { tx, type Pool, type PoolClient } from "@hunch/infra";
import bs58 from "bs58";

import {
  relayClientSourceDebitPostcondition,
  withRelayClientSourceDebitPostcondition,
} from "../execution/relay-client-source-debit.js";
import { directWithdrawalActionValidation } from "../execution/direct-withdrawal-transfer.js";
import { POLYMARKET_HANDOFF_CHAIN_ATTRIBUTION_WINDOW_MS } from "../execution/polymarket-deposit-wallet-handoff.js";

import { isReceiptBearingFundingActionKind } from "../domain/action-kinds.js";
import { isRawAmount } from "../domain/raw-amount.js";
import type { JsonValue, NormalizedAction } from "../domain/types.js";
import { moneySchema, normalizedActionSchema } from "../domain/schemas.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import { deriveFundingLifecycle } from "../lifecycle/funding-lifecycle-projector.js";
import {
  allocateFundingObservationInTransaction,
  FundingPersistenceError,
} from "./funding-operation-repository.js";
import { reduceFundingOperationInTransaction } from "../reconciliation/funding-reducer.js";

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
  attemptStartedAt: Date;
  stepKind: "transaction" | "external_handoff" | "venue_preparation";
  payerRequirement:
    | "none"
    | "user"
    | "provider"
    | "privy_sponsor"
    | "hunch_sponsor";
  networkId: string;
  action: NormalizedAction;
  actionValidationResult: JsonRecord;
  receiptRefCiphertext: string;
  receiptRefLookupHmac: string;
  lookupKeyVersion: number;
  previousReceipt: FundingStepReceiptObservation | null;
}>;

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
): Promise<readonly FundingStepReceiptTarget[]> {
  const { rows } = await db.query<{
    operation_id: string;
    step_id: string;
    segment_id: string | null;
    attempt_id: string;
    attempt_started_at: Date;
    step_kind: FundingStepReceiptTarget["stepKind"];
    executor_id: string;
    payer_requirement: FundingStepReceiptTarget["payerRequirement"];
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
        attempt.started_at as attempt_started_at,
        step.step_kind,
        step.executor_id,
        step.payer_requirement,
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
        -- Receipt eligibility is an attempt fact: a durable broadcast-capable
        -- reference must remain observable even when an older reducer pass
        -- left the operation or step projection cache terminal. The caller
        -- owns queue cadence; this query never uses an aggregate cache to
        -- decide whether a known transaction may still need reconciliation.
      order by step.ordinal, attempt.attempt_number
    `,
    [operationId],
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
      attemptStartedAt: row.attempt_started_at,
      stepKind: row.step_kind,
      payerRequirement: row.payer_requirement,
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
  // Failed, mismatched, and reorged evidence is immutable in PostgreSQL except
  // for the explicitly allowed correction/reorg transitions below. Treat an
  // identical terminal poll as an idempotent read. A successful finalized
  // receipt is intentionally refreshable so confirmation/provider metadata can
  // advance while its original finalized_at watch origin stays fixed.
  if (previous === incoming.status) {
    return ["failed", "mismatch", "reorged"].includes(previous);
  }
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

const MAX_POLYMARKET_HANDOFF_AMBIGUITY_CANDIDATES = 64;

type PolymarketHandoffAmbiguityCandidate = Readonly<{
  operation_id: string;
  attempt_outcome: "started" | "submitted" | "ambiguous";
}>;

/**
 * A chain-scanned Transfer must not be allocated while another matching
 * handoff could own it. Submitted and ambiguous attempts always remain
 * competitors because a broadcast may have moved money. A merely started
 * attempt has no broadcast reference, so its current lifecycle projection is
 * the canonical test for whether that route is still live.
 */
async function findLivePolymarketHandoffAmbiguityCandidate(
  client: PoolClient,
  input: Readonly<{
    attemptId: string;
    userId: string;
    networkId: string;
    actionValidationResult: JsonRecord;
    chainTransactionBlockTimestampMs: number;
    canonicalTransactionHash: string;
    now: Date;
  }>,
): Promise<string | null> {
  const { rows } = await client.query<PolymarketHandoffAmbiguityCandidate>(
    `
      select other_operation.id as operation_id,
             other_attempt.outcome as attempt_outcome
      from funding_operation_step_attempts other_attempt
      join funding_operation_steps other_step
        on other_step.id = other_attempt.step_id
      join funding_operations other_operation
        on other_operation.id = other_step.operation_id
      left join funding_step_receipt_observations other_receipt
        on other_receipt.attempt_id = other_attempt.id
      where other_attempt.id <> $1
        and other_operation.user_id = $2
        and other_step.step_kind = 'external_handoff'
        and other_step.normalized_action ->> 'kind' = 'external_handoff'
        and other_step.normalized_action ->> 'handoffKind' =
              'polymarket_deposit_wallet_transfer'
        and (
          other_attempt.outcome = 'started'
          or (
            other_attempt.outcome in ('submitted', 'ambiguous')
            and other_attempt.broadcast_may_have_occurred
          )
        )
        and funding_account_identifier_equal(
              $3,
              other_step.action_validation_result ->> 'tokenAddress',
              $4
            )
        and funding_account_identifier_equal(
              $3,
              other_step.action_validation_result ->> 'funderAddress',
              $5
            )
        and funding_account_identifier_equal(
              $3,
              other_step.action_validation_result ->> 'recipientAddress',
              $6
            )
        and other_step.action_validation_result ->> 'amountRaw' = $7
        and to_timestamp($8::double precision / 1000.0) >=
              date_trunc('second', other_attempt.started_at) + interval '1 second'
        and to_timestamp($8::double precision / 1000.0) <=
              other_attempt.started_at +
              $10::double precision * interval '1 millisecond'
        and (
          other_receipt.attempt_id is null
          or other_receipt.status in ('pending', 'confirmed')
          or (
            other_receipt.status = 'mismatch'
            and coalesce(
                  lower(other_receipt.evidence ->> 'ambiguousTransactionHash'),
                  lower(other_receipt.evidence ->> 'unboundChainTransactionHash')
                ) = $9
          )
        )
        and coalesce(
              lower(other_receipt.evidence ->> 'transactionHash'),
              lower(other_receipt.evidence ->> 'ambiguousTransactionHash'),
              lower(other_receipt.evidence ->> 'unboundChainTransactionHash'),
              $9
            ) = $9
      order by other_attempt.started_at asc
      limit $11
    `,
    [
      input.attemptId,
      input.userId,
      input.networkId,
      input.actionValidationResult.tokenAddress ?? null,
      input.actionValidationResult.funderAddress ?? null,
      input.actionValidationResult.recipientAddress ?? null,
      input.actionValidationResult.amountRaw ?? null,
      input.chainTransactionBlockTimestampMs,
      input.canonicalTransactionHash,
      POLYMARKET_HANDOFF_CHAIN_ATTRIBUTION_WINDOW_MS,
      MAX_POLYMARKET_HANDOFF_AMBIGUITY_CANDIDATES + 1,
    ],
  );
  if (rows.length > MAX_POLYMARKET_HANDOFF_AMBIGUITY_CANDIDATES) {
    // Do not allocate a physical Transfer after an unexpectedly broad match.
    // The caller records ambiguity and lets recovery expose the operation.
    return rows[0]?.operation_id ?? null;
  }
  for (const candidate of rows) {
    if (candidate.attempt_outcome !== "started") {
      return candidate.operation_id;
    }
    const facts = await loadFundingLifecycleFactsForOperationInTransaction(
      client,
      { operationId: candidate.operation_id, now: input.now },
    );
    if (facts && !deriveFundingLifecycle(facts).safety.terminal) {
      return candidate.operation_id;
    }
  }
  return null;
}

export async function applyFundingStepReceiptEvidenceInTransaction(
  client: PoolClient,
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
    operation_user_id: string;
    requested_source_amount: JsonRecord | null;
    operation_support_metadata: JsonRecord;
  }>(
    `
      select user_id as operation_user_id,
             requested_source_amount,
             support_metadata as operation_support_metadata
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
    step_kind: FundingStepReceiptTarget["stepKind"];
    executor_id: string;
    segment_id: string | null;
    normalized_action: JsonRecord;
    action_validation_result: JsonRecord;
  }>(
    `
      select step.step_kind,
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
  const attemptResult = await client.query<{
    id: string;
  }>(
    `
      select current_attempt.id
      from funding_operation_step_attempts current_attempt
      where current_attempt.step_id = $1
        and current_attempt.id = $2
        and current_attempt.broadcast_may_have_occurred
      for update of current_attempt
    `,
    [input.stepId, input.attemptId],
  );
  const scopedAttempt = attemptResult.rows[0];
  if (!scopedAttempt) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding step receipt target no longer exists",
    );
  }

  let incomingReceipt = input.receipt;
  if (
    scoped.step_kind === "external_handoff" &&
    (incomingReceipt.status === "confirmed" ||
      incomingReceipt.status === "finalized") &&
    incomingReceipt.actionMatch === true &&
    incomingReceipt.canonical &&
    incomingReceipt.failureCode === null
  ) {
    const transactionHash = incomingReceipt.evidence.transactionHash;
    const handoffEventIndex = incomingReceipt.evidence.handoffEventIndex;
    if (
      typeof transactionHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/u.test(transactionHash) ||
      typeof handoffEventIndex !== "string" ||
      !isRawAmount(handoffEventIndex)
    ) {
      incomingReceipt = {
        status: "mismatch",
        actionMatch: false,
        ledgerHeight: incomingReceipt.ledgerHeight,
        blockHash: incomingReceipt.blockHash,
        canonical: true,
        failureCode: "external_handoff_physical_identity_missing",
        evidence: {
          handoffPhysicalIdentityValid: false,
        },
      };
    } else {
      const canonicalTransactionHash = transactionHash.toLowerCase();
      // Receipt inspection can discover a hash without the provider. Serialize
      // the physical Transfer identity before accepting it so two overlapping
      // same-amount operations can never consume the same on-chain event.
      await client.query(
        `
          select pg_advisory_xact_lock(
            hashtextextended($1::text, 0)
          )
        `,
        [
          [input.networkId, canonicalTransactionHash, handoffEventIndex].join(
            ":",
          ),
        ],
      );
      const transactionHashSource =
        incomingReceipt.evidence.transactionHashSource;
      const chainTransactionBlockTimestampMs =
        incomingReceipt.evidence.chainTransactionBlockTimestampMs;
      const ambiguousCandidateOperationId =
        transactionHashSource === "chain_scan" &&
        typeof chainTransactionBlockTimestampMs === "number" &&
        Number.isSafeInteger(chainTransactionBlockTimestampMs)
          ? await findLivePolymarketHandoffAmbiguityCandidate(client, {
              attemptId: input.attemptId,
              userId: scopedOperation.operation_user_id,
              networkId: input.networkId,
              actionValidationResult: scoped.action_validation_result,
              chainTransactionBlockTimestampMs,
              canonicalTransactionHash,
              now,
            })
          : null;
      if (ambiguousCandidateOperationId) {
        incomingReceipt = {
          status: "pending",
          actionMatch: null,
          ledgerHeight: incomingReceipt.ledgerHeight,
          blockHash: incomingReceipt.blockHash,
          canonical: true,
          failureCode: null,
          evidence: {
            ...incomingReceipt.evidence,
            transactionHash: null,
            ambiguousTransactionHash: canonicalTransactionHash,
            chainTransactionBlockTimestampMs,
            competingOperationId: ambiguousCandidateOperationId,
            externalHandoffCandidateAmbiguous: true,
            handoffEventIndex,
            transactionHashSource: "chain_scan",
          },
        };
      }
      const conflictingReceipt =
        incomingReceipt.status === "mismatch"
          ? null
          : await client.query<{ operation_id: string }>(
              `
          select receipt.operation_id
          from funding_step_receipt_observations receipt
          join funding_operation_steps receipt_step
            on receipt_step.id = receipt.step_id
          where receipt.network_id = $1
            and lower(receipt.evidence ->> 'transactionHash') = $2
            and receipt.evidence ->> 'handoffEventIndex' = $3
            and receipt.attempt_id <> $4
            and receipt_step.step_kind = 'external_handoff'
            and receipt.status in ('confirmed', 'finalized')
            and receipt.action_match
            and receipt.canonical
          limit 1
        `,
              [
                input.networkId,
                canonicalTransactionHash,
                handoffEventIndex,
                input.attemptId,
              ],
            );
      if (conflictingReceipt?.rows[0]) {
        incomingReceipt = {
          status: "mismatch",
          actionMatch: false,
          ledgerHeight: incomingReceipt.ledgerHeight,
          blockHash: incomingReceipt.blockHash,
          canonical: true,
          failureCode: "external_handoff_transfer_already_allocated",
          evidence: {
            conflictingOperationId: conflictingReceipt.rows[0].operation_id,
            handoffEventIndex,
            handoffPhysicalIdentityConflict: true,
          },
        };
      }
    }
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
    shouldIgnoreFundingStepReceiptUpdate(previous.status, incomingReceipt)
  ) {
    return mapReceipt(previous);
  }

  const incomingIsFinal =
    incomingReceipt.status === "finalized" ||
    (incomingReceipt.status === "failed" &&
      incomingReceipt.canonical &&
      incomingReceipt.evidence.failureFinalized === true);
  const finalizedAt = incomingIsFinal ? (previous?.finalized_at ?? now) : null;
  const reorgedAt = incomingReceipt.status === "reorged" ? now : null;
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
      incomingReceipt.status,
      incomingReceipt.actionMatch,
      incomingReceipt.ledgerHeight,
      incomingReceipt.blockHash,
      incomingReceipt.canonical,
      incomingReceipt.failureCode,
      incomingReceipt.evidence,
      now,
      finalizedAt,
      reorgedAt,
    ],
  );
  const row = stored.rows[0];
  if (!row) throw new Error("funding step receipt upsert returned no row");

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

  if (incomingReceipt.status === "reorged") {
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

  // Receipts and any derived transfer observations are durable facts. The
  // reducer alone materializes action/segment/operation state, including
  // reorg recovery and dependent Telegram Router actions.
  await reduceFundingOperationInTransaction(client, {
    operationId: input.operationId,
    now,
  });
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
