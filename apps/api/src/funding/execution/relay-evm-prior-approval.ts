import type { Pool, PoolClient } from "@hunch/infra";

import type { JsonValue } from "../domain/types.js";
import type { RelayEvmAllowanceObservation } from "./relay-evm-allowance-state.js";
import type { RelayEvmFundingProfileSpec } from "./relay-evm-profile-specs.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type RelayEvmPriorApprovalProof = Readonly<{
  allowanceRaw: string;
  approvalBlock: string;
  approvalBlockHash: string;
  approvalReceiptId: string;
  approvalTransactionHash: string;
  ownershipRevision: string;
  sourceOperationId: string;
}>;

export type RelayEvmPriorApprovalAllowanceReader = (
  input: Readonly<{
    owner: string;
    blockNumber: string | null;
    finality?: "latest" | "finalized";
    mutationBaselineBlock?: string | null;
  }>,
) => Promise<RelayEvmAllowanceObservation>;

type TerminalPriorApprovalCandidate = Readonly<{
  allowanceRaw: string;
  approvalBlock: string;
  approvalBlockHash: string;
  approvalReceiptId: string;
  approvalTransactionHash: string;
  sourceOperationId: string;
}>;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/iu.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/iu.test(value);
}

function isPositiveRaw(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/u.test(value);
}

function isBlock(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value);
}

export function parseRelayEvmPriorApprovalProof(
  value: JsonRecord | null | undefined,
): RelayEvmPriorApprovalProof | null {
  if (
    !value ||
    !isPositiveRaw(value.allowanceRaw) ||
    !isBlock(value.approvalBlock) ||
    !isHash(value.approvalBlockHash) ||
    !isUuid(value.approvalReceiptId) ||
    !isHash(value.approvalTransactionHash) ||
    typeof value.ownershipRevision !== "string" ||
    value.ownershipRevision.length < 32 ||
    !isUuid(value.sourceOperationId)
  ) {
    return null;
  }
  return {
    allowanceRaw: value.allowanceRaw,
    approvalBlock: value.approvalBlock,
    approvalBlockHash: value.approvalBlockHash.toLowerCase(),
    approvalReceiptId: value.approvalReceiptId,
    approvalTransactionHash: value.approvalTransactionHash.toLowerCase(),
    ownershipRevision: value.ownershipRevision,
    sourceOperationId: value.sourceOperationId,
  };
}

export function relayEvmPriorApprovalSupportMetadata(
  proof: RelayEvmPriorApprovalProof,
): Readonly<{ relayPriorApprovalProof: RelayEvmPriorApprovalProof }> {
  return { relayPriorApprovalProof: proof };
}

async function loadTerminalPriorApprovalCandidates(
  db: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  input: Readonly<{
    approvalReceiptId?: string;
    owner: string;
    profile: RelayEvmFundingProfileSpec;
    sourceOperationId?: string;
    userId: string;
    lock?: boolean;
  }>,
): Promise<readonly TerminalPriorApprovalCandidate[]> {
  const lock = input.lock
    ? "for update of source_operation, approval_step, approval_receipt, deposit_step"
    : "";
  const { rows } = await db.query<{
    allowance_raw: string;
    approval_block: string;
    approval_block_hash: string;
    approval_receipt_id: string;
    approval_transaction_hash: string;
    source_operation_id: string;
  }>(
    `select approval_receipt.evidence ->> 'allowanceRaw' as allowance_raw,
            approval_receipt.ledger_height::text as approval_block,
            approval_receipt.block_hash as approval_block_hash,
            approval_receipt.id::text as approval_receipt_id,
            lower(approval_receipt.evidence ->> 'transactionHash')
              as approval_transaction_hash,
            source_operation.id::text as source_operation_id
       from funding_operations source_operation
       join funding_operation_steps approval_step
         on approval_step.operation_id = source_operation.id
        and approval_step.executor_id = $2
        and approval_step.state = 'succeeded'
        and approval_step.action_validation_result ->> 'relayStepKind' = 'approve'
       join funding_step_receipt_observations approval_receipt
         on approval_receipt.step_id = approval_step.id
        and approval_receipt.status = 'finalized'
        and approval_receipt.canonical
        and approval_receipt.action_match
        and approval_receipt.evidence ->> 'singleOperationBundle' = 'true'
        and approval_receipt.evidence ->> 'allowanceExact' = 'true'
        and approval_receipt.evidence ->> 'allowanceRaw' ~ '^[1-9][0-9]*$'
        and approval_receipt.evidence ->> 'transactionHash' ~ '^0x[0-9a-fA-F]{64}$'
       join funding_operation_steps deposit_step
         on deposit_step.operation_id = source_operation.id
        and deposit_step.depends_on_step_id = approval_step.id
        and deposit_step.executor_id = $2
        and deposit_step.action_validation_result ->> 'relayStepKind' = 'deposit'
       join telegram_funding_authorizations source_authorization
         on source_authorization.id::text =
              source_operation.support_metadata ->> 'fundingAuthorizationId'
        and source_authorization.user_id = source_operation.user_id
        and source_authorization.profile_id = $2
       where source_operation.user_id = $1::uuid
         and lower(source_authorization.wallet_address) = lower($3)
         and source_operation.status in ('failed', 'cancelled')
         and source_operation.progress_stage = 'terminal'
         and ($4::uuid is null or source_operation.id = $4::uuid)
         and ($5::uuid is null or approval_receipt.id = $5::uuid)
        and not exists (
          select 1
            from funding_operation_step_attempts deposit_attempt
           where deposit_attempt.step_id = deposit_step.id
        )
        and not exists (
          select 1
            from funding_step_receipt_observations deposit_receipt
           where deposit_receipt.step_id = deposit_step.id
        )
       order by source_operation.updated_at desc, source_operation.id desc
       limit 8
       ${lock}`,
    [
      input.userId,
      input.profile.profileId,
      input.owner,
      input.sourceOperationId ?? null,
      input.approvalReceiptId ?? null,
    ],
  );
  return rows.flatMap((row) => {
    if (
      !isPositiveRaw(row.allowance_raw) ||
      !isBlock(row.approval_block) ||
      !isHash(row.approval_block_hash) ||
      !isUuid(row.approval_receipt_id) ||
      !isHash(row.approval_transaction_hash) ||
      !isUuid(row.source_operation_id)
    ) {
      return [];
    }
    return [
      {
        allowanceRaw: row.allowance_raw,
        approvalBlock: row.approval_block,
        approvalBlockHash: row.approval_block_hash.toLowerCase(),
        approvalReceiptId: row.approval_receipt_id,
        approvalTransactionHash: row.approval_transaction_hash.toLowerCase(),
        sourceOperationId: row.source_operation_id,
      },
    ];
  });
}

function candidateMatchesObservation(
  candidate: TerminalPriorApprovalCandidate,
  observation: RelayEvmAllowanceObservation,
): boolean {
  return (
    observation.raw === candidate.allowanceRaw &&
    observation.ownershipRevision !== null &&
    observation.lastMutationTransactionHash ===
      candidate.approvalTransactionHash &&
    BigInt(observation.blockNumber) >= BigInt(candidate.approvalBlock)
  );
}

function candidateMatchesHistoricalObservation(
  candidate: TerminalPriorApprovalCandidate,
  observation: RelayEvmAllowanceObservation,
): boolean {
  return (
    observation.blockNumber === candidate.approvalBlock &&
    candidateMatchesObservation(candidate, observation)
  );
}

export async function proveRelayEvmPriorApproval(
  db: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  input: Readonly<{
    allowanceReader: RelayEvmPriorApprovalAllowanceReader;
    owner: string;
    profile: RelayEvmFundingProfileSpec;
    userId: string;
  }>,
): Promise<RelayEvmPriorApprovalProof | null> {
  const candidates = await loadTerminalPriorApprovalCandidates(db, input);
  const matches: RelayEvmPriorApprovalProof[] = [];
  for (const candidate of candidates) {
    const historical = await input.allowanceReader({
      owner: input.owner,
      blockNumber: candidate.approvalBlock,
      finality: "finalized",
      mutationBaselineBlock: candidate.approvalBlock,
    });
    if (
      historical.blockHash !== candidate.approvalBlockHash ||
      !candidateMatchesHistoricalObservation(candidate, historical)
    ) {
      continue;
    }
    const current = await input.allowanceReader({
      owner: input.owner,
      blockNumber: null,
      finality: "finalized",
      mutationBaselineBlock: candidate.approvalBlock,
    });
    if (
      !candidateMatchesObservation(candidate, current) ||
      current.ownershipRevision !== historical.ownershipRevision
    ) {
      continue;
    }
    matches.push({
      allowanceRaw: candidate.allowanceRaw,
      approvalBlock: candidate.approvalBlock,
      approvalBlockHash: candidate.approvalBlockHash,
      approvalReceiptId: candidate.approvalReceiptId,
      approvalTransactionHash: candidate.approvalTransactionHash,
      ownershipRevision: current.ownershipRevision ?? "",
      sourceOperationId: candidate.sourceOperationId,
    });
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export async function verifyRelayEvmPriorApprovalInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    owner: string;
    profile: RelayEvmFundingProfileSpec;
    proof: RelayEvmPriorApprovalProof;
    userId: string;
  }>,
): Promise<boolean> {
  const candidates = await loadTerminalPriorApprovalCandidates(client, {
    owner: input.owner,
    profile: input.profile,
    userId: input.userId,
    sourceOperationId: input.proof.sourceOperationId,
    approvalReceiptId: input.proof.approvalReceiptId,
    lock: true,
  });
  const candidate = candidates[0];
  return Boolean(
    candidate &&
    candidates.length === 1 &&
    candidate.allowanceRaw === input.proof.allowanceRaw &&
    candidate.approvalBlock === input.proof.approvalBlock &&
    candidate.approvalBlockHash === input.proof.approvalBlockHash &&
    candidate.approvalTransactionHash === input.proof.approvalTransactionHash,
  );
}

/**
 * Retire the old terminal route's reservation in the same transaction that
 * commits its successor when it is still held. A terminal pre-deposit route
 * may have already released it; the immutable proof and the successor's own
 * lane lock still fence that case.
 */
export async function consumeRelayEvmPriorApprovalReservationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    now: Date;
    owner: string;
    profile: RelayEvmFundingProfileSpec;
    proof: RelayEvmPriorApprovalProof;
    userId: string;
  }>,
): Promise<boolean> {
  if (!(await verifyRelayEvmPriorApprovalInTransaction(client, input))) {
    return false;
  }
  const reservation = await client.query<{
    id: string;
    status: "released" | "reserved";
  }>(
    `select reservation.id::text as id, reservation.status
       from telegram_funding_authorization_reservations reservation
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id = reservation.authorization_id
       where reservation.funding_operation_id = $1::uuid
         and funding_authorization.user_id = $2::uuid
         and funding_authorization.profile_id = $3
         and lower(funding_authorization.wallet_address) = lower($4)
         and reservation.status in ('reserved', 'released')
       for update of reservation, funding_authorization`,
    [
      input.proof.sourceOperationId,
      input.userId,
      input.profile.profileId,
      input.owner,
    ],
  );
  const row = reservation.rows[0];
  if (!row || reservation.rows.length !== 1) return false;
  if (row.status === "released") return true;
  const released = await client.query(
    `update telegram_funding_authorization_reservations
        set status = 'released',
            resolved_at = $2,
            resolution_evidence = resolution_evidence || jsonb_build_object(
              'reason', 'relay_prior_approval_consumed',
              'sourceOperationId', $3::text
            ),
            updated_at = $2
      where id = $1::uuid and status = 'reserved'`,
    [row.id, input.now, input.proof.sourceOperationId],
  );
  return released.rowCount === 1;
}
