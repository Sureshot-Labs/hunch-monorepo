import { ethers } from "ethers";
import type { PoolClient } from "@hunch/infra";

import {
  stableOpaqueId,
  stableWalletOpaqueId,
} from "../../account-value/canonical.js";
import { RELAY_DEPOSITORY_V2 } from "../../funding-providers/relay/rehearsal.js";
import type { JsonValue } from "../domain/types.js";
import {
  commitFundingOperationInTransaction,
  createFundingQuoteInTransaction,
  type FundingCommitPlan,
} from "../persistence/funding-operation-repository.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type { RelayEvmFundingProfileSpec } from "./relay-evm-profile-specs.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

const ERC20 = new ethers.Interface([
  "function approve(address spender,uint256 amount)",
]);

type CleanupCandidate = Readonly<{
  authorizationId: string;
  destinationSnapshot: JsonRecord;
  depositStepId: string;
  parentOperationId: string;
  policyRevision: string;
  policyVersion: number;
  reservationId: string;
  sourceSnapshot: JsonRecord;
  subjectLookupHmac: string;
  subjectLookupKeyVersion: number;
  userId: string;
  venueBindingSnapshot: JsonRecord | null;
  walletAddress: string;
  cleanupContext: "approval_exhausted" | "pre_deposit_failure" | "post_deposit";
}>;

async function loadCleanupCandidate(
  client: PoolClient,
  parentOperationId: string,
  profileId: string,
): Promise<CleanupCandidate | null> {
  const { rows } = await client.query<{
    authorization_id: string;
    destination_target_snapshot: JsonRecord;
    deposit_step_id: string;
    operation_id: string;
    policy_revision: string;
    policy_version: string | number;
    quote_id: string;
    reservation_id: string;
    source_snapshot: JsonRecord;
    subject_lookup_hmac: string;
    subject_lookup_key_version: number;
    user_id: string;
    venue_binding_snapshot: JsonRecord | null;
    wallet_address: string;
    approval_succeeded: boolean;
    deposit_succeeded: boolean;
  }>(
    `select operation.id as operation_id,
            operation.user_id,
            operation.quote_id,
            operation.policy_version,
            operation.policy_revision,
            operation.source_snapshot,
            operation.destination_target_snapshot,
            operation.venue_binding_snapshot,
            operation.original_subject_lookup_hmac as subject_lookup_hmac,
            operation.subject_lookup_key_version,
            deposit_step.id as deposit_step_id,
            funding_authorization.id as authorization_id,
            funding_authorization.wallet_address,
            reservation.id as reservation_id,
            exists (
              select 1
                from funding_operation_steps successful_approval
                join funding_step_receipt_observations approval_receipt
                  on approval_receipt.step_id = successful_approval.id
                 and approval_receipt.status = 'finalized'
                 and approval_receipt.action_match
                 and approval_receipt.canonical
                 and approval_receipt.evidence ->> 'allowanceExact' = 'true'
               where successful_approval.operation_id = operation.id
                 and successful_approval.executor_id = $2
                 and successful_approval.action_validation_result ->> 'relayStepKind' =
                       'approve'
            ) as approval_succeeded,
            exists (
              select 1
                from funding_step_receipt_observations deposit_receipt
               where deposit_receipt.step_id = deposit_step.id
                 and deposit_receipt.status = 'finalized'
                 and deposit_receipt.action_match
                 and deposit_receipt.canonical
                 and deposit_receipt.evidence ->> 'sourceDebitEventIndex' is not null
                 and deposit_receipt.evidence ->> 'transactionHash' is not null
            ) as deposit_succeeded
       from funding_operations operation
       join funding_operation_steps deposit_step
         on deposit_step.operation_id = operation.id
        and deposit_step.executor_id = $2
        and deposit_step.action_validation_result ->> 'relayStepKind' = 'deposit'
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id::text =
              operation.support_metadata ->> 'fundingAuthorizationId'
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
        and reservation.status = 'reserved'
        and reservation.cleanup_operation_id is null
       where operation.id = $1::uuid
         and operation.status in (
               'in_progress', 'reconcile_required', 'recovery_required'
             )
         and deposit_step.state in (
               'planned', 'action_required', 'succeeded', 'failed',
               'recovery_required'
             )
         and exists (
           select 1
             from funding_operation_steps approval_step
            where approval_step.operation_id = operation.id
              and approval_step.executor_id = $2
              and approval_step.action_validation_result ->> 'relayStepKind' =
                    'approve'
              and (
                exists (
                  select 1
                    from funding_step_receipt_observations approval_receipt
                   where approval_receipt.step_id = approval_step.id
                     and approval_receipt.status = 'finalized'
                     and approval_receipt.action_match
                     and approval_receipt.canonical
                     and approval_receipt.evidence ->> 'allowanceExact' = 'true'
                )
                or (
                  approval_step.state in (
                    'action_required', 'failed', 'recovery_required'
                  )
                  and (
                    approval_step.action_expires_at <= clock_timestamp()
                    or (select count(*)
                          from funding_operation_step_attempts used
                         where used.step_id = approval_step.id) >= 2
                  )
                )
              )
         )
         and not exists (
           select 1
           from funding_operation_step_attempts attempt
           where attempt.step_id = deposit_step.id
             and (
               attempt.outcome in ('started', 'ambiguous')
               or attempt.broadcast_may_have_occurred
             )
             and not exists (
               select 1
               from funding_step_receipt_observations attempt_receipt
               where attempt_receipt.attempt_id = attempt.id
                 and attempt_receipt.status in ('finalized', 'failed')
                 and attempt_receipt.canonical
             )
         )
       for update of operation, deposit_step, funding_authorization, reservation
       limit 1`,
    [parentOperationId, profileId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    authorizationId: row.authorization_id,
    destinationSnapshot: row.destination_target_snapshot,
    depositStepId: row.deposit_step_id,
    parentOperationId: row.operation_id,
    policyRevision: row.policy_revision,
    policyVersion: Number(row.policy_version),
    reservationId: row.reservation_id,
    sourceSnapshot: row.source_snapshot,
    subjectLookupHmac: row.subject_lookup_hmac,
    subjectLookupKeyVersion: row.subject_lookup_key_version,
    userId: row.user_id,
    venueBindingSnapshot: row.venue_binding_snapshot,
    walletAddress: row.wallet_address,
    cleanupContext: row.deposit_succeeded
      ? "post_deposit"
      : row.approval_succeeded
        ? "pre_deposit_failure"
        : "approval_exhausted",
  };
}

export async function createRelayAllowanceCleanupOperationInTransaction(
  client: PoolClient,
  input: Readonly<{
    parentOperationId: string;
    allowanceRaw: string;
    allowanceRevision: string;
    allowanceObservedBlock: string;
    allowanceMutationBaselineBlock: string;
    now: Date;
    profile: RelayEvmFundingProfileSpec;
  }>,
): Promise<string | null> {
  if (
    !/^[1-9][0-9]*$/u.test(input.allowanceRaw) ||
    input.allowanceRevision.length < 32 ||
    !/^(0|[1-9][0-9]*)$/u.test(input.allowanceObservedBlock) ||
    !/^(0|[1-9][0-9]*)$/u.test(input.allowanceMutationBaselineBlock)
  )
    return null;
  const candidate = await loadCleanupCandidate(
    client,
    input.parentOperationId,
    input.profile.profileId,
  );
  if (!candidate) return null;
  const action = {
    kind: "evm_transaction" as const,
    actionId: stableOpaqueId(
      "relay_cleanup_action",
      `${candidate.parentOperationId}:${candidate.depositStepId}:${input.allowanceRevision}`,
    ),
    networkId: input.profile.sourceAsset.networkId,
    senderWalletId: stableWalletOpaqueId({
      walletType: "ethereum",
      networkId: input.profile.sourceAsset.networkId,
      address: candidate.walletAddress,
    }),
    to: input.profile.sourceAsset.assetId,
    data: ERC20.encodeFunctionData("approve", [RELAY_DEPOSITORY_V2, 0n]),
    valueRaw: "0",
    gasLimitRaw: null,
  };
  const walletExecutionSnapshot = {
    walletId: action.senderWalletId,
    address: candidate.walletAddress,
  };
  const expiresAt = new Date(input.now.getTime() + 10 * 60_000);
  const plan: FundingCommitPlan = {
    operation: {
      purpose: "manual_rebalance",
      initialState: { status: "in_progress", stage: "source_action" },
      experienceMode: "prepare_first",
      planKind: "direct_external_handoff",
      sourceSnapshot: candidate.sourceSnapshot,
      destinationTargetSnapshot: candidate.destinationSnapshot,
      externalRecipientId: null,
      venueId: "polymarket",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: candidate.venueBindingSnapshot,
      walletExecutionSnapshot,
      placementSnapshot: {},
      requestedSourceAmount: null,
      requestedDestinationAmount: null,
      supportMetadata: {
        cleanupKind: "relay_allowance_zero_v1",
        cleanupContext: candidate.cleanupContext,
        parentOperationId: candidate.parentOperationId,
        parentDepositStepId: candidate.depositStepId,
        fundingAuthorizationId: candidate.authorizationId,
        allowanceRevision: input.allowanceRevision,
      },
    },
    segments: [],
    reservations: [],
    steps: [
      {
        ordinal: 0,
        segmentOrdinal: null,
        stepKind: "venue_preparation",
        state: "action_required",
        actionFingerprint: canonicalJsonHash(action),
        executorId: input.profile.profileId,
        payerRequirement: "privy_sponsor",
        dependsOnOrdinal: null,
        normalizedAction: action,
        actionValidationResult: {
          delegatedProfileId: input.profile.profileId,
          relayStepKind: "cleanup",
          signerAddress: candidate.walletAddress,
          requiresSingleOperationBundle: true,
          parentOperationId: candidate.parentOperationId,
          cleanupContext: candidate.cleanupContext,
          allowanceRevision: input.allowanceRevision,
          allowanceObservedBlock: input.allowanceObservedBlock,
          allowanceMutationBaselineBlock: input.allowanceMutationBaselineBlock,
          ownedAllowanceRaw: input.allowanceRaw,
        },
        actionExpiresAt: null,
      },
    ],
  };
  const consentToken = stableOpaqueId(
    "relay_cleanup_consent",
    `${candidate.parentOperationId}:${candidate.depositStepId}:${input.allowanceRevision}`,
  );
  const quote = await createFundingQuoteInTransaction(client, {
    userId: candidate.userId,
    discoveryProjectionId: stableOpaqueId(
      "relay_cleanup_projection",
      candidate.parentOperationId,
    ),
    selectedSourceOptionSnapshot: candidate.sourceSnapshot,
    marketContextSnapshot: null,
    destinationOptionSnapshot: candidate.destinationSnapshot,
    venueBindingSnapshot: candidate.venueBindingSnapshot,
    planSnapshot: plan,
    policyVersion: candidate.policyVersion,
    policyRevision: candidate.policyRevision,
    canonicalRequest: {
      kind: "relay_allowance_cleanup_v1",
      parentOperationId: candidate.parentOperationId,
      depositStepId: candidate.depositStepId,
      allowanceRevision: input.allowanceRevision,
    },
    consentToken,
    expiresAt,
  });
  const committed = await commitFundingOperationInTransaction(client, {
    userId: candidate.userId,
    quoteId: quote.id,
    consentToken,
    idempotencyKey: `relay-cleanup:${candidate.parentOperationId}:${candidate.depositStepId}:${input.allowanceRevision}`,
    plan,
    subjectLookupHmac: candidate.subjectLookupHmac,
    subjectLookupKeyVersion: candidate.subjectLookupKeyVersion,
    now: input.now,
  });
  await client.query(
    `update telegram_funding_authorization_reservations
        set status = 'cleanup_required',
            cleanup_operation_id = $2::uuid,
            cleanup_allowance_revision = $3,
            resolution_evidence = resolution_evidence || jsonb_build_object(
              'cleanupOperationId', $2::text,
              'cleanupAllowanceRaw', $4::text,
              'cleanupAllowanceObservedBlock', $5::text
            ),
            updated_at = $6
      where id = $1::uuid
        and status = 'reserved'
        and cleanup_operation_id is null`,
    [
      candidate.reservationId,
      committed.operation.id,
      input.allowanceRevision,
      input.allowanceRaw,
      input.allowanceObservedBlock,
      input.now,
    ],
  );
  return committed.operation.id;
}
