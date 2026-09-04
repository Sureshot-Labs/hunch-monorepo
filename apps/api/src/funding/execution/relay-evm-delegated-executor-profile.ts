import { ethers } from "ethers";
import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type {
  JsonValue,
  NormalizedAction,
  WalletExecutionProfile,
} from "../domain/types.js";
import { canonicalAccountAddress } from "../domain/asset-identity.js";
import { normalizedActionSchema } from "../domain/schemas.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import {
  lockFundingAuthorizationReservationScope,
  tryLockFundingAuthorizationReservationScope,
} from "../persistence/funding-authorization-reservation-lock.js";
import {
  allocateFundingObservationInTransaction,
  writeFundingOperationSupportFactsInTransaction,
} from "../persistence/funding-operation-repository.js";
import {
  finishFundingStepAttemptForUserInTransaction,
  projectedFundingActionInTransaction,
  projectedFundingActionBeforeBroadcastInTransaction,
  startFundingStepAttemptForUserInTransaction,
} from "../persistence/funding-evidence-repository.js";
import { lockFundingPolicyForTransaction } from "../policies/funding-policy-service.js";
import { lockFundingControllerWallet } from "./funding-controller-wallet-lock.js";
import {
  type DelegatedFundingExecutionClaim,
  type DelegatedFundingNetworkDriver,
  type DelegatedFundingProfileClaim,
  type DelegatedFundingRecoveryClaim,
  type DelegatedFundingRuntimeProfile,
} from "./delegated-funding-executor.js";
import {
  loadRelayEvmExecutionConfiguration,
  relayEvmProfileConfigured,
  type RelayEvmExecutionConfiguration,
} from "./delegated-funding-config.js";
import { TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID } from "./delegated-funding-profile-ids.js";
import {
  RELAY_EVM_FUNDING_PROFILE_SPECS,
  type RelayEvmFundingProfileSpec,
} from "./relay-evm-profile-specs.js";
import {
  telegramFundingAuthorizationFingerprint,
  telegramFundingAuthorizationFromRow,
  type TelegramFundingAuthorizationRow,
} from "./telegram-funding-authorization.js";
import { resolveTelegramRelayEvmCapability } from "./delegated-funding-capability-resolver.js";
import { validateRelayDelegatedEvmAction } from "./relay-evm-delegated-profile.js";
import { createRelayAllowanceCleanupOperationInTransaction } from "./relay-evm-allowance-cleanup.js";
import {
  classifyRelayCleanupAllowance,
  parseRelayEvmAllowanceObservation,
  type RelayEvmAllowanceObservation,
} from "./relay-evm-allowance-state.js";
import { relayActionNeedsAllowanceMaintenance } from "./relay-evm-lifecycle.js";
import { stableWalletOpaqueId } from "../../account-value/canonical.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import {
  fetchEvmBlockHash,
  fetchEvmBlockNumber,
} from "../../services/polygon-rpc.js";
import { RELAY_DEPOSITORY_V2 } from "../../funding-providers/relay/rehearsal.js";
import { RELAY_ROUTE_SPECS } from "../../funding-providers/relay/mappings.js";
import { reduceFundingOperationInTransaction } from "../reconciliation/funding-reducer.js";
import { deriveFundingLifecycle } from "../lifecycle/funding-lifecycle-projector.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
export const RELAY_CLEANUP_CANONICAL_WATCH_MS = 60_000;
type Policy = Awaited<
  ReturnType<
    typeof import("../policies/funding-policy-service.js").resolveFundingPolicy
  >
>;

function relayControlPlaneAllowed(
  configuration: RelayEvmExecutionConfiguration,
  policy: Policy,
  profile: RelayEvmFundingProfileSpec,
): boolean {
  return (
    configuration.enabled &&
    relayEvmProfileConfigured(configuration) &&
    policy.runtime.venues.some(
      (venue) =>
        profile.venueIds.includes(
          venue.venueId as "limitless" | "polymarket",
        ) &&
        venue.delegatedExecutionEnabled &&
        venue.delegatedPolicyIds.includes(profile.profileId),
    )
  );
}

type RelayClaimRow = TelegramFundingAuthorizationRow &
  Readonly<{
    action_fingerprint: string;
    action_validation_result: JsonRecord;
    allowance_mutation_baseline_block: string | null;
    authorization_fingerprint: string;
    authorization_id: string;
    executor_id: string;
    normalized_action: JsonRecord;
    operation_id: string;
    payer_requirement: string;
    policy_revision: string;
    policy_version: string | number;
    receipt_raw: string;
    step_id: string;
  }>;

type RelayRecoveryClaimRow = RelayClaimRow &
  Readonly<{
    attempt_id: string;
    attempt_outcome: "started" | "ambiguous";
  }>;

/**
 * Relay's SQL query establishes immutable authority, reservation, and
 * postcondition eligibility.  Whether the action can start is deliberately
 * decided here from the locked durable fact snapshot, never from the cached
 * operation or step state selected by that query.
 */
async function firstActionableRelayClaimRow(
  client: PoolClient,
  rows: readonly RelayClaimRow[],
  now: Date,
): Promise<RelayClaimRow | null> {
  for (const row of rows) {
    const { action } = await projectedFundingActionInTransaction(client, {
      operationId: row.operation_id,
      stepId: row.step_id,
      now,
    });
    if (action.actionable) return row;
  }
  return null;
}

/**
 * Recovery owns a broadcast-capable attempt, rather than starting a new
 * action.  Its eligibility is still a lifecycle decision: cache terminality
 * must not suppress a known attempt, and a cache rearm must not revive one.
 */
async function firstRecoverableRelayClaimRow(
  client: PoolClient,
  rows: readonly RelayRecoveryClaimRow[],
  now: Date,
): Promise<RelayRecoveryClaimRow | null> {
  for (const row of rows) {
    const { lifecycle, action } = await projectedFundingActionInTransaction(
      client,
      { operationId: row.operation_id, stepId: row.step_id, now },
    );
    if (
      !lifecycle.safety.terminal &&
      (action.state === "reconcile_required" ||
        action.state === "recovery_required")
    ) {
      return row;
    }
  }
  return null;
}

export type RelayEvmAllowanceReader = (
  input: Readonly<{
    owner: string;
    blockNumber: string | null;
    finality?: "latest" | "finalized";
    mutationBaselineBlock?: string | null;
  }>,
) => Promise<RelayEvmAllowanceObservation>;

const ALLOWANCE = new ethers.Interface([
  "function allowance(address owner,address spender) view returns (uint256)",
]);

// A Base USDC allowance is one shared mutable lane per wallet and Relay
// spender. Only the oldest unresolved reservation may observe or mutate it.
// Keep the aliases stable so every claim/recovery/broadcast boundary uses the
// exact same durable predicate.
const RELAY_ALLOWANCE_LANE_HEAD_PREDICATE = `not exists (
  select 1
    from telegram_funding_authorization_reservations prior_reservation
    join telegram_funding_authorizations prior_funding_authorization
      on prior_funding_authorization.id = prior_reservation.authorization_id
   where prior_reservation.status in ('reserved', 'cleanup_required')
     and prior_reservation.id <> reservation.id
     and prior_funding_authorization.wallet_chain =
           funding_authorization.wallet_chain
     and lower(prior_funding_authorization.wallet_address) =
           lower(funding_authorization.wallet_address)
     and prior_funding_authorization.profile_id =
           funding_authorization.profile_id
     and prior_funding_authorization.source_network_id =
           funding_authorization.source_network_id
     and lower(prior_funding_authorization.source_asset_id) =
           lower(funding_authorization.source_asset_id)
     and (prior_reservation.reserved_at, prior_reservation.id) <
           (reservation.reserved_at, reservation.id)
     -- Reserved and cleanup-required rows are the durable ownership leases for
     -- this mutable allowance. A fact-derived terminal reduction releases a
     -- no-deposit reservation before claim; never infer that release from an
     -- operation-status cache inside the shared-lane predicate.
)`;

export async function readRelayEvmAllowance(
  profile: RelayEvmFundingProfileSpec,
  input: Readonly<{
    owner: string;
    blockNumber: string | null;
    finality?: "latest" | "finalized";
    mutationBaselineBlock?: string | null;
  }>,
): Promise<RelayEvmAllowanceObservation> {
  const polygon = profile.sourceAsset.networkId === "evm:137";
  const rpcUrl = polygon
    ? fundingSidecarRuntimeConfig.polygonRpcUrl
    : fundingSidecarRuntimeConfig.baseRpcUrl;
  const timeoutMs = polygon
    ? fundingSidecarRuntimeConfig.polygonRpcTimeoutMs
    : fundingSidecarRuntimeConfig.baseRpcTimeoutMs;
  const chainLabel = polygon ? "Polygon" : "Base";
  let finalizedBlockHash: string | null = null;
  const finalizedBlock =
    input.blockNumber == null && input.finality === "finalized"
      ? await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "eth_getBlockByNumber",
            params: ["finalized", false],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }).then(async (response) => {
          if (!response.ok)
            throw new Error(`${chainLabel} finalized block RPC failed`);
          const payload = (await response.json()) as { result?: unknown };
          if (!payload.result || typeof payload.result !== "object") {
            throw new Error(
              `${chainLabel} finalized block RPC returned no result`,
            );
          }
          const block = payload.result as Record<string, unknown>;
          if (
            typeof block.number !== "string" ||
            !/^0x[0-9a-f]+$/iu.test(block.number) ||
            typeof block.hash !== "string" ||
            !/^0x[0-9a-f]{64}$/iu.test(block.hash)
          ) {
            throw new Error(
              `${chainLabel} finalized block RPC returned invalid data`,
            );
          }
          finalizedBlockHash = block.hash.toLowerCase();
          return BigInt(block.number);
        })
      : null;
  const anchoredBlock =
    input.blockNumber != null
      ? BigInt(input.blockNumber)
      : (finalizedBlock ??
        (await fetchEvmBlockNumber({
          rpcUrl,
          timeoutMs,
          bypassCache: true,
        })));
  if (anchoredBlock < 0n || anchoredBlock > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `${chainLabel} allowance block is outside the supported range`,
    );
  }
  const blockHash = await fetchEvmBlockHash({
    rpcUrl,
    timeoutMs,
    blockNumber: Number(anchoredBlock),
  });
  if (!blockHash)
    throw new Error(`${chainLabel} allowance block is unavailable`);
  if (finalizedBlockHash && finalizedBlockHash !== blockHash.toLowerCase()) {
    throw new Error(`${chainLabel} finalized allowance block hash changed`);
  }
  const tag = `0x${anchoredBlock.toString(16)}`;
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        {
          to: profile.sourceAsset.assetId,
          data: ALLOWANCE.encodeFunctionData("allowance", [
            input.owner,
            RELAY_DEPOSITORY_V2,
          ]),
        },
        tag,
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${chainLabel} allowance RPC failed`);
  const payload = (await response.json()) as { result?: unknown };
  if (typeof payload.result !== "string") {
    throw new Error(`${chainLabel} allowance RPC returned no result`);
  }
  const raw = BigInt(
    ALLOWANCE.decodeFunctionResult("allowance", payload.result)[0],
  ).toString();
  const verifiedBlockHash = await fetchEvmBlockHash({
    rpcUrl,
    timeoutMs,
    blockNumber: Number(anchoredBlock),
  });
  if (
    !verifiedBlockHash ||
    verifiedBlockHash.toLowerCase() !== blockHash.toLowerCase()
  ) {
    throw new Error(
      `${chainLabel} allowance block changed during anchored read`,
    );
  }
  const blockNumber = anchoredBlock.toString();
  let ownershipRevision: string | null = null;
  let lastMutationTransactionHash: string | null = null;
  if (input.mutationBaselineBlock != null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(input.mutationBaselineBlock)) {
      throw new Error(`${chainLabel} allowance mutation baseline is invalid`);
    }
    const baseline = BigInt(input.mutationBaselineBlock);
    if (baseline > anchoredBlock) {
      throw new Error(
        `${chainLabel} allowance mutation baseline is after observation`,
      );
    }
    const logResponse = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_getLogs",
        params: [
          {
            address: profile.sourceAsset.assetId,
            fromBlock: `0x${baseline.toString(16)}`,
            toBlock: tag,
            topics: [
              ethers.id("Approval(address,address,uint256)"),
              ethers.zeroPadValue(
                canonicalAccountAddress(
                  profile.sourceAsset.networkId,
                  input.owner,
                ),
                32,
              ),
              ethers.zeroPadValue(RELAY_DEPOSITORY_V2, 32),
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!logResponse.ok)
      throw new Error(`${chainLabel} allowance log RPC failed`);
    const logPayload = (await logResponse.json()) as { result?: unknown };
    if (!Array.isArray(logPayload.result)) {
      throw new Error(`${chainLabel} allowance log RPC returned no result`);
    }
    const mutations = logPayload.result
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          throw new Error(
            `${chainLabel} allowance log RPC returned invalid evidence`,
          );
        }
        const log = entry as Record<string, unknown>;
        if (
          typeof log.blockHash !== "string" ||
          typeof log.blockNumber !== "string" ||
          typeof log.transactionHash !== "string" ||
          typeof log.transactionIndex !== "string" ||
          typeof log.logIndex !== "string" ||
          typeof log.data !== "string"
        ) {
          throw new Error(
            `${chainLabel} allowance log RPC returned incomplete evidence`,
          );
        }
        return {
          blockHash: log.blockHash.toLowerCase(),
          blockNumber: log.blockNumber.toLowerCase(),
          data: log.data.toLowerCase(),
          logIndex: log.logIndex.toLowerCase(),
          transactionHash: log.transactionHash.toLowerCase(),
          transactionIndex: log.transactionIndex.toLowerCase(),
        };
      })
      .sort((left, right) => {
        const blockOrder = BigInt(left.blockNumber) - BigInt(right.blockNumber);
        if (blockOrder !== 0n) return blockOrder < 0n ? -1 : 1;
        const transactionOrder =
          BigInt(left.transactionIndex) - BigInt(right.transactionIndex);
        if (transactionOrder !== 0n) return transactionOrder < 0n ? -1 : 1;
        const logOrder = BigInt(left.logIndex) - BigInt(right.logIndex);
        return logOrder === 0n ? 0 : logOrder < 0n ? -1 : 1;
      });
    const postLogBlockHash = await fetchEvmBlockHash({
      rpcUrl,
      timeoutMs,
      blockNumber: Number(anchoredBlock),
    });
    if (
      !postLogBlockHash ||
      postLogBlockHash.toLowerCase() !== blockHash.toLowerCase()
    ) {
      throw new Error(
        `${chainLabel} allowance block changed during mutation scan`,
      );
    }
    ownershipRevision = canonicalJsonHash({
      baselineBlock: baseline.toString(),
      mutations,
      owner: canonicalAccountAddress(
        profile.sourceAsset.networkId,
        input.owner,
      ),
      raw,
      spender: RELAY_DEPOSITORY_V2,
      token: profile.sourceAsset.assetId,
    });
    lastMutationTransactionHash = mutations.at(-1)?.transactionHash ?? null;
  }
  return {
    raw,
    blockNumber,
    blockHash: blockHash.toLowerCase(),
    finality: input.finality === "finalized" ? "finalized" : "latest",
    revision: canonicalJsonHash({
      blockHash: blockHash.toLowerCase(),
      blockNumber,
      owner: canonicalAccountAddress(
        profile.sourceAsset.networkId,
        input.owner,
      ),
      raw,
      spender: RELAY_DEPOSITORY_V2,
      token: profile.sourceAsset.assetId,
    }),
    ownershipRevision,
    lastMutationTransactionHash,
  };
}

export async function readBaseRelayAllowance(
  input: Parameters<RelayEvmAllowanceReader>[0],
): Promise<RelayEvmAllowanceObservation> {
  const profile =
    RELAY_EVM_FUNDING_PROFILE_SPECS[TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID];
  if (!profile) throw new Error("Base Relay profile is unavailable");
  return readRelayEvmAllowance(profile, input);
}

type RelayMaintenanceKind =
  | "approval"
  | "releasable"
  | "stranded"
  | "deposit"
  | "cleanup";

function relayMaintenanceObservation(value: JsonRecord | undefined): Readonly<{
  kind: RelayMaintenanceKind;
  candidateId: string;
  operationId: string;
  expectedBlockHash: string | null;
  expectedMutationTransactionHashes: readonly string[];
  mutationBaselineBlock: string | null;
  allowance: RelayEvmAllowanceObservation;
}> | null {
  if (
    !value ||
    typeof value.maintenanceKind !== "string" ||
    !["approval", "releasable", "stranded", "deposit", "cleanup"].includes(
      value.maintenanceKind,
    ) ||
    typeof value.candidateId !== "string" ||
    typeof value.operationId !== "string"
  ) {
    return null;
  }
  const allowance = parseRelayEvmAllowanceObservation(value);
  if (!allowance) return null;
  return {
    kind: value.maintenanceKind as RelayMaintenanceKind,
    candidateId: value.candidateId,
    operationId: value.operationId,
    expectedBlockHash:
      typeof value.expectedBlockHash === "string"
        ? value.expectedBlockHash.toLowerCase()
        : null,
    expectedMutationTransactionHashes: Array.isArray(
      value.expectedMutationTransactionHashes,
    )
      ? value.expectedMutationTransactionHashes
          .filter(
            (item): item is string =>
              typeof item === "string" && /^0x[0-9a-f]{64}$/iu.test(item),
          )
          .map((item) => item.toLowerCase())
      : [],
    mutationBaselineBlock:
      typeof value.mutationBaselineBlock === "string"
        ? value.mutationBaselineBlock
        : null,
    allowance,
  };
}

function relayAllowanceMutationIsOwned(
  maintenance: Readonly<{
    expectedMutationTransactionHashes: readonly string[];
    allowance: RelayEvmAllowanceObservation;
  }>,
): boolean {
  const last = maintenance.allowance.lastMutationTransactionHash;
  return (
    last !== null &&
    maintenance.expectedMutationTransactionHashes.some(
      (expected) => expected.toLowerCase() === last,
    )
  );
}

async function relayActionNeedsAllowanceMaintenanceInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{ operationId: string; actionId: string; now: Date }>,
): Promise<boolean> {
  return relayActionNeedsAllowanceMaintenance(
    await loadFundingLifecycleFactsForOperationInTransaction(client, {
      operationId: input.operationId,
      now: input.now,
    }),
    input.actionId,
  );
}

async function observeRelayPostcondition(
  pool: Pool,
  allowance: RelayEvmAllowanceReader,
  now: Date,
  profile: RelayEvmFundingProfileSpec,
): Promise<JsonRecord | undefined> {
  const { rows } = await pool.query<{
    block_number: string | null;
    block_hash: string | null;
    action_id: string;
    candidate_id: string;
    maintenance_kind: RelayMaintenanceKind;
    expected_mutation_transaction_hashes: unknown;
    mutation_baseline_block: string | null;
    operation_id: string;
    wallet_address: string;
  }>({
    name: "funding-relay-observe-postcondition-v1",
    text: `with candidates as (
       select 1 as priority,
              'approval'::text as maintenance_kind,
              approval_receipt.id::text as candidate_id,
              operation.id::text as operation_id,
              approval_step.id::text as action_id,
              funding_authorization.wallet_address,
              jsonb_build_array(approval_receipt.evidence ->> 'transactionHash')
                as expected_mutation_transaction_hashes,
              operation.support_metadata ->> 'relayApprovalBaselineAllowanceBlock'
                as mutation_baseline_block,
              approval_receipt.ledger_height as block_number,
              approval_receipt.block_hash,
              approval_receipt.observed_at as observed_at
         from funding_operation_steps approval_step
         join funding_operation_steps deposit_step
           on deposit_step.depends_on_step_id = approval_step.id
          and deposit_step.operation_id = approval_step.operation_id
         join funding_step_receipt_observations approval_receipt
           on approval_receipt.step_id = approval_step.id
          and approval_receipt.status = 'finalized'
          and approval_receipt.action_match
          and approval_receipt.canonical
          and approval_receipt.evidence ->> 'singleOperationBundle' = 'true'
         join funding_operations operation
           on operation.id = approval_step.operation_id
         join telegram_funding_authorizations funding_authorization
           on funding_authorization.id::text =
                operation.support_metadata ->> 'fundingAuthorizationId'
         join telegram_funding_authorization_reservations reservation
           on reservation.funding_operation_id = operation.id
          and reservation.status = 'reserved'
        where approval_step.executor_id = $1
          and ${RELAY_ALLOWANCE_LANE_HEAD_PREDICATE}
          and not exists (
            select 1
            from funding_operation_step_attempts deposit_attempt
            where deposit_attempt.step_id = deposit_step.id
          )
          and approval_receipt.evidence ->> 'allowanceExact'
                is distinct from 'true'
          and approval_receipt.evidence ->> 'allowanceExactRejected'
                is distinct from 'true'
          and approval_receipt.evidence ->> 'allowanceAnchorRejected'
                is distinct from 'true'
          and approval_receipt.evidence ->> 'allowanceOwnershipRejected'
                is distinct from 'true'
       union all
       select 2, 'releasable', reservation.id::text, operation.id::text,
              approval_step.id::text,
              funding_authorization.wallet_address,
              '[]'::jsonb,
              operation.support_metadata ->> 'relayApprovalBaselineAllowanceBlock',
              null, null,
              operation.created_at
         from telegram_funding_authorization_reservations reservation
         join funding_operations operation
           on operation.id = reservation.funding_operation_id
         join telegram_funding_authorizations funding_authorization
           on funding_authorization.id = reservation.authorization_id
         join funding_operation_steps approval_step
           on approval_step.operation_id = operation.id
          and approval_step.executor_id = $1
          and approval_step.action_validation_result ->> 'relayStepKind' =
                'approve'
        where reservation.status = 'reserved'
          and ${RELAY_ALLOWANCE_LANE_HEAD_PREDICATE}
          and not exists (
            select 1 from funding_step_receipt_observations success
             where success.step_id = approval_step.id
               and success.status = 'finalized'
               and success.action_match and success.canonical
          )
          and not exists (
            select 1
              from funding_step_receipt_observations recent_failure
             where recent_failure.step_id = approval_step.id
               and recent_failure.status = 'failed'
               and recent_failure.canonical
               and recent_failure.evidence ->> 'failureFinalized' = 'true'
               and recent_failure.finalized_at >
                     clock_timestamp() - interval '15 minutes'
          )
          and not exists (
            select 1
              from funding_operation_step_attempts unresolved
             where unresolved.step_id = approval_step.id
               and (unresolved.outcome in ('started', 'ambiguous')
                    or unresolved.broadcast_may_have_occurred)
               and not exists (
                 select 1 from funding_step_receipt_observations evidence
                  where evidence.attempt_id = unresolved.id
                    and evidence.status in ('finalized', 'failed')
                    and evidence.canonical
               )
          )
       union all
       select 3, 'stranded', operation.id::text, operation.id::text,
              deposit_step.id::text,
              funding_authorization.wallet_address,
              jsonb_build_array(approval_receipt.evidence ->> 'transactionHash'),
              operation.support_metadata ->> 'relayApprovalBaselineAllowanceBlock',
              approval_receipt.ledger_height, approval_receipt.block_hash,
              operation.created_at
         from funding_operations operation
         join funding_operation_steps approval_step
           on approval_step.operation_id = operation.id
          and approval_step.executor_id = $1
          and approval_step.action_validation_result ->> 'relayStepKind' =
                'approve'
         join funding_step_receipt_observations approval_receipt
           on approval_receipt.step_id = approval_step.id
          and approval_receipt.status = 'finalized'
          and approval_receipt.action_match and approval_receipt.canonical
          and approval_receipt.evidence ->> 'singleOperationBundle' = 'true'
          and approval_receipt.evidence ->> 'allowanceExact' = 'true'
          and approval_receipt.evidence ->> 'allowanceOwnershipRejected'
                is distinct from 'true'
         join funding_operation_steps deposit_step
           on deposit_step.operation_id = operation.id
          and deposit_step.depends_on_step_id = approval_step.id
          and deposit_step.action_validation_result ->> 'relayStepKind' =
                'deposit'
         join telegram_funding_authorizations funding_authorization
           on funding_authorization.id::text =
                operation.support_metadata ->> 'fundingAuthorizationId'
         join telegram_funding_authorization_reservations reservation
           on reservation.funding_operation_id = operation.id
          and reservation.status = 'reserved'
          and reservation.cleanup_operation_id is null
        where ${RELAY_ALLOWANCE_LANE_HEAD_PREDICATE}
          and not exists (
            select 1 from funding_operation_step_attempts unresolved
             where unresolved.step_id = deposit_step.id
               and (unresolved.outcome in ('started', 'ambiguous')
                    or unresolved.broadcast_may_have_occurred)
               and not exists (
                 select 1 from funding_step_receipt_observations evidence
                  where evidence.attempt_id = unresolved.id
                    and evidence.status in ('finalized', 'failed')
                    and evidence.canonical
               )
          )
          and not exists (
            select 1
              from funding_step_receipt_observations recent_failure
             where recent_failure.step_id = deposit_step.id
               and recent_failure.status = 'failed'
               and recent_failure.canonical
               and recent_failure.evidence ->> 'failureFinalized' = 'true'
               and recent_failure.finalized_at >
                     clock_timestamp() - interval '15 minutes'
          )
       union all
       select 4, 'deposit', deposit_receipt.id::text, operation.id::text,
              deposit_step.id::text,
              funding_authorization.wallet_address,
              jsonb_build_array(
                (select approval_receipt.evidence ->> 'transactionHash'
                   from funding_operation_steps approval_step
                   join funding_step_receipt_observations approval_receipt
                     on approval_receipt.step_id = approval_step.id
                    and approval_receipt.status = 'finalized'
                    and approval_receipt.action_match
                    and approval_receipt.canonical
                    and approval_receipt.evidence ->> 'singleOperationBundle' = 'true'
                  where approval_step.operation_id = operation.id
                    and approval_step.action_validation_result ->> 'relayStepKind' =
                          'approve'
                  order by approval_receipt.observed_at desc
                  limit 1),
                deposit_receipt.evidence ->> 'transactionHash'
              ),
              operation.support_metadata ->> 'relayApprovalBaselineAllowanceBlock',
              deposit_receipt.ledger_height,
              deposit_receipt.block_hash,
              deposit_receipt.observed_at
         from funding_operation_steps deposit_step
         join funding_step_receipt_observations deposit_receipt
           on deposit_receipt.step_id = deposit_step.id
          and deposit_receipt.status = 'finalized'
          and deposit_receipt.action_match and deposit_receipt.canonical
          and deposit_receipt.evidence ->> 'singleOperationBundle' = 'true'
         join funding_operations operation
           on operation.id = deposit_step.operation_id
         join telegram_funding_authorizations funding_authorization
           on funding_authorization.id::text =
                operation.support_metadata ->> 'fundingAuthorizationId'
         join telegram_funding_authorization_reservations reservation
           on reservation.funding_operation_id = operation.id
          and reservation.status = 'reserved'
        where deposit_step.executor_id = $1
          and ${RELAY_ALLOWANCE_LANE_HEAD_PREDICATE}
          and deposit_receipt.evidence ->> 'attributedSourceRaw' =
                reservation.source_raw::text
          and deposit_receipt.block_hash is not null
          and deposit_receipt.evidence ->> 'sourceDebitEventIndex' is not null
          and deposit_receipt.evidence ->> 'transactionHash' is not null
          and deposit_receipt.evidence ->> 'allowanceZero'
                is distinct from 'true'
          and deposit_receipt.evidence ->> 'allowanceAnchorRejected'
                is distinct from 'true'
          and deposit_receipt.evidence ->> 'allowanceOwnershipRejected'
                is distinct from 'true'
          and not exists (
            select 1
              from funding_observations source_debit
             where source_debit.operation_id = operation.id
               and source_debit.kind = 'source_debit'
               and source_debit.canonical
               and source_debit.finality_status = 'finalized'
          )
       union all
       select 5, 'cleanup', cleanup_receipt.id::text,
              cleanup_operation.id::text, cleanup_step.id::text,
              funding_authorization.wallet_address,
              jsonb_build_array(cleanup_receipt.evidence ->> 'transactionHash'),
              parent_operation.support_metadata ->> 'relayApprovalBaselineAllowanceBlock',
              null, null,
              cleanup_receipt.observed_at
         from telegram_funding_authorization_reservations reservation
         join funding_operations cleanup_operation
           on cleanup_operation.id = reservation.cleanup_operation_id
         join funding_operations parent_operation
           on parent_operation.id = reservation.funding_operation_id
         join funding_operation_steps cleanup_step
           on cleanup_step.operation_id = cleanup_operation.id
          and cleanup_step.executor_id = $1
          and cleanup_step.action_validation_result ->> 'relayStepKind' =
                'cleanup'
         join funding_step_receipt_observations cleanup_receipt
           on cleanup_receipt.step_id = cleanup_step.id
          and cleanup_receipt.status = 'finalized'
          and cleanup_receipt.action_match and cleanup_receipt.canonical
          and cleanup_receipt.evidence ->> 'singleOperationBundle' = 'true'
          and cleanup_receipt.finalized_at <=
                $2::timestamptz -
                  $3::bigint * interval '1 millisecond'
         join telegram_funding_authorizations funding_authorization
           on funding_authorization.id = reservation.authorization_id
        where reservation.status = 'cleanup_required'
          and ${RELAY_ALLOWANCE_LANE_HEAD_PREDICATE}
          and cleanup_receipt.evidence ->> 'allowanceZero'
                is distinct from 'true'
          and cleanup_receipt.evidence ->> 'allowanceAnchorRejected'
                is distinct from 'true'
          and cleanup_receipt.evidence ->> 'allowanceOwnershipRejected'
                is distinct from 'true'
     )
     select maintenance_kind, candidate_id, operation_id, action_id, wallet_address,
            expected_mutation_transaction_hashes,
            mutation_baseline_block, block_number, block_hash
       from candidates
      order by priority, observed_at
      limit 25`,
    values: [profile.profileId, now, RELAY_CLEANUP_CANONICAL_WATCH_MS],
  });
  for (const candidate of rows) {
    if (
      (candidate.maintenance_kind === "releasable" ||
        candidate.maintenance_kind === "stranded") &&
      !(await relayActionNeedsAllowanceMaintenanceInTransaction(pool, {
        operationId: candidate.operation_id,
        actionId: candidate.action_id,
        now,
      }))
    ) {
      continue;
    }
    const observed = await allowance({
      owner: candidate.wallet_address,
      blockNumber: candidate.block_number,
      mutationBaselineBlock: candidate.mutation_baseline_block,
    });
    return {
      maintenanceKind: candidate.maintenance_kind,
      candidateId: candidate.candidate_id,
      operationId: candidate.operation_id,
      expectedBlockHash: candidate.block_hash,
      expectedMutationTransactionHashes: Array.isArray(
        candidate.expected_mutation_transaction_hashes,
      )
        ? candidate.expected_mutation_transaction_hashes.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      mutationBaselineBlock: candidate.mutation_baseline_block,
      ...observed,
    };
  }
  return undefined;
}

function walletId(
  row: Pick<RelayClaimRow, "wallet_chain" | "wallet_address">,
  profile: RelayEvmFundingProfileSpec,
) {
  return stableWalletOpaqueId({
    walletType: row.wallet_chain,
    networkId: profile.sourceAsset.networkId,
    address: row.wallet_address,
  });
}

function walletProfile(
  row: RelayClaimRow,
  actionWalletId: string,
  profile: RelayEvmFundingProfileSpec,
): WalletExecutionProfile {
  return {
    walletId: actionWalletId,
    controllerWalletRef: row.user_wallet_id,
    networkId: profile.sourceAsset.networkId,
    address: canonicalAccountAddress(
      profile.sourceAsset.networkId,
      row.wallet_address,
    ),
    source: "embedded",
    signingModes: ["privy_delegated"],
    serverWalletRef: row.privy_wallet_id,
    sponsorshipPolicyIds: [],
    evmAtomicBatchMode: null,
  };
}

function claimFromRow(
  row: RelayClaimRow,
  input: Readonly<{
    action: NormalizedAction;
    attemptId: string;
    broadcastBoundaryCrossed: boolean;
  }>,
  profile: RelayEvmFundingProfileSpec,
): DelegatedFundingExecutionClaim {
  return {
    action: input.action,
    allowanceMutationBaselineBlock: row.allowance_mutation_baseline_block,
    actionValidationResult: row.action_validation_result,
    actionWalletId: walletId(row, profile),
    actionFingerprint: row.action_fingerprint,
    authorizationFingerprint: row.authorization_fingerprint,
    authorizationId: row.authorization_id,
    attemptId: input.attemptId,
    broadcastBoundaryCrossed: input.broadcastBoundaryCrossed,
    destinationOptionId: row.destination_option_id,
    fundingPolicyRevision: row.policy_revision,
    fundingPolicyVersion: Number(row.policy_version),
    operationId: row.operation_id,
    policyFingerprint: row.policy_fingerprint,
    policyId: row.policy_id,
    privyWalletId: row.privy_wallet_id,
    profileId: profile.profileId,
    receiptRaw: row.receipt_raw,
    signerFingerprint: row.signer_fingerprint,
    signerId: row.signer_id,
    sponsor: row.payer_requirement === "privy_sponsor",
    stepId: row.step_id,
    telegramAccountId: row.telegram_account_id,
    telegramUserId: row.telegram_user_id,
    userId: row.user_id,
    venueId: row.venue_id,
    venueBindingOptionId: row.venue_binding_option_id,
    walletAddress: canonicalAccountAddress(
      profile.sourceAsset.networkId,
      row.wallet_address,
    ),
  };
}

/**
 * A route which never crossed a deposit broadcast boundary has not moved
 * value. An attempt may already exist because it is claimed before the
 * read-only pre-broadcast validation; it remains safe only while no attempt
 * can have reached a provider or chain. Retire its lane atomically so the
 * next route can make a new, exact approve.
 */
async function retireRelayPreDepositRouteInTransaction(
  client: PoolClient,
  input: Readonly<{
    errorCode: string;
    operationId: string;
    observed: RelayEvmAllowanceObservation;
    reason: string;
    now: Date;
  }>,
): Promise<boolean> {
  const scope = await client.query<{
    deposit_step_id: string;
    operation_version: string | number;
    reservation_id: string;
  }>(
    `select operation_row.version as operation_version,
            reservation_row.id as reservation_id,
            deposit_step.id as deposit_step_id
       from funding_operations operation_row
       join telegram_funding_authorization_reservations reservation_row
         on reservation_row.funding_operation_id = operation_row.id
        and reservation_row.status = 'reserved'
       join funding_operation_steps deposit_step
         on deposit_step.operation_id = operation_row.id
        and deposit_step.action_validation_result ->> 'relayStepKind' =
              'deposit'
      where operation_row.id = $1::uuid
        and not exists (
          select 1
            from funding_step_receipt_observations deposit_receipt
           where deposit_receipt.step_id = deposit_step.id
             and deposit_receipt.status = 'finalized'
             and deposit_receipt.canonical
             and deposit_receipt.action_match
        )
        and not exists (
          select 1
            from funding_operation_step_attempts deposit_attempt
           where deposit_attempt.step_id = deposit_step.id
             and deposit_attempt.broadcast_may_have_occurred
             and not exists (
               select 1
                 from funding_step_receipt_observations deposit_receipt
                where deposit_receipt.attempt_id = deposit_attempt.id
                  and deposit_receipt.status = 'failed'
                  and deposit_receipt.canonical
                  and deposit_receipt.action_match
             )
        )
      for update of operation_row, reservation_row, deposit_step`,
    [input.operationId],
  );
  const row = scope.rows[0];
  if (!row) return false;
  await writeFundingOperationSupportFactsInTransaction(client, {
    operationId: input.operationId,
    expectedVersion: Number(row.operation_version),
    supportMetadataPatch: {
      lifecycleTerminalFailure: {
        code: input.errorCode,
        decidedAt: input.now.toISOString(),
        actionId: row.deposit_step_id,
        reason: input.reason,
        observedAllowance: {
          raw: input.observed.raw,
          block: input.observed.blockNumber,
          blockHash: input.observed.blockHash,
          revision: input.observed.ownershipRevision,
          lastMutationTransactionHash:
            input.observed.lastMutationTransactionHash,
        },
      },
    },
    now: input.now,
  });
  const reduction = await reduceFundingOperationInTransaction(client, {
    operationId: input.operationId,
    now: input.now,
  });
  if (reduction.finalState.status !== "failed") {
    throw new Error("Relay pre-deposit terminal failure did not reduce");
  }
  // The reducer owns the generic terminal lease release. The terminal fact
  // already keeps Relay's anchored allowance evidence, so this executor only
  // verifies that reduction released the exact lease it had locked.
  const lease = await client.query<{ status: string }>(
    `select status
         from telegram_funding_authorization_reservations
        where id = $1::uuid
        for update`,
    [row.reservation_id],
  );
  if (lease.rows[0]?.status !== "released") {
    throw new Error(
      `Relay pre-deposit lease was not released by reduction (${lease.rows[0]?.status ?? "missing"})`,
    );
  }
  return true;
}

const AUTHORIZATION_COLUMNS = `
  funding_authorization.id,
  funding_authorization.user_id,
  funding_authorization.telegram_account_id,
  funding_authorization.telegram_user_id,
  funding_authorization.user_wallet_id,
  funding_authorization.privy_wallet_id,
  funding_authorization.wallet_address,
  funding_authorization.wallet_chain,
  funding_authorization.profile_id,
  funding_authorization.security_class,
  funding_authorization.max_source_raw::text,
  funding_authorization.signer_id,
  funding_authorization.signer_fingerprint,
  funding_authorization.policy_id,
  funding_authorization.policy_fingerprint,
  funding_authorization.venue_id,
  funding_authorization.destination_option_id,
  funding_authorization.venue_binding_option_id,
  funding_authorization.source_network_id,
  funding_authorization.source_asset_id,
  funding_authorization.source_asset_decimals,
  funding_authorization.destination_network_id,
  funding_authorization.destination_asset_id,
  funding_authorization.destination_asset_decimals,
  funding_authorization.granted_at,
  funding_authorization.expires_at`;

async function rejectRelayClaimRow(
  client: PoolClient,
  row: RelayClaimRow,
  now: Date,
): Promise<DelegatedFundingProfileClaim> {
  const attempt = await startFundingStepAttemptForUserInTransaction(client, {
    userId: row.user_id,
    operationId: row.operation_id,
    stepId: row.step_id,
    canonicalActionFingerprint: row.action_fingerprint,
    executorId: row.executor_id,
    now,
  });
  await finishFundingStepAttemptForUserInTransaction(client, {
    userId: row.user_id,
    operationId: row.operation_id,
    stepId: row.step_id,
    attemptId: attempt.attempt.id,
    outcome: "failed",
    broadcastMayHaveOccurred: false,
    referenceKind: null,
    receiptRefCiphertext: null,
    receiptRefLookupHmac: null,
    lookupKeyVersion: null,
    actualCosts: { reasonCode: "delegated_action_invalid" },
    now,
  });
  return { kind: "rejected", operationId: row.operation_id };
}

async function validateAndStartRelayClaim(
  client: PoolClient,
  row: RelayClaimRow,
  input: Readonly<{
    now: Date;
    profile: RelayEvmFundingProfileSpec;
    authorizationAllowed: (
      authorization: ReturnType<typeof telegramFundingAuthorizationFromRow>,
    ) => boolean;
  }>,
): Promise<DelegatedFundingProfileClaim> {
  const parsed = normalizedActionSchema.safeParse(row.normalized_action);
  const action = parsed.success ? (parsed.data as NormalizedAction) : null;
  let authorization: ReturnType<typeof telegramFundingAuthorizationFromRow>;
  try {
    authorization = telegramFundingAuthorizationFromRow(row);
  } catch {
    return rejectRelayClaimRow(client, row, input.now);
  }
  const actionWalletId = walletId(row, input.profile);
  if (
    !action ||
    canonicalJsonHash(action) !== row.action_fingerprint ||
    telegramFundingAuthorizationFingerprint(authorization) !==
      row.authorization_fingerprint ||
    !input.authorizationAllowed(authorization)
  ) {
    return rejectRelayClaimRow(client, row, input.now);
  }
  try {
    validateRelayDelegatedEvmAction({
      action,
      actionValidationResult: row.action_validation_result,
      expectedRaw: row.receipt_raw,
      walletAddress: row.wallet_address,
      walletId: actionWalletId,
      profile: input.profile,
    });
  } catch {
    return rejectRelayClaimRow(client, row, input.now);
  }
  await lockFundingControllerWallet(
    client,
    row.user_id,
    walletProfile(row, actionWalletId, input.profile),
  );
  const attempt = await startFundingStepAttemptForUserInTransaction(client, {
    userId: row.user_id,
    operationId: row.operation_id,
    stepId: row.step_id,
    canonicalActionFingerprint: row.action_fingerprint,
    executorId: row.executor_id,
    now: input.now,
  });
  return {
    kind: "execution",
    claim: claimFromRow(
      row,
      {
        action,
        attemptId: attempt.attempt.id,
        broadcastBoundaryCrossed: false,
      },
      input.profile,
    ),
  };
}

async function reconcileRelayPostconditions(
  client: PoolClient,
  observation: JsonRecord | undefined,
  now: Date,
  allowRetry: boolean,
  profile: RelayEvmFundingProfileSpec,
): Promise<void> {
  const maintenance = relayMaintenanceObservation(observation);
  if (maintenance) {
    const lane = await client.query<{
      authorization_id: string;
      user_id: string;
    }>(
      `select funding_authorization.id::text as authorization_id,
              funding_authorization.user_id::text as user_id
         from telegram_funding_authorization_reservations reservation
         join telegram_funding_authorizations funding_authorization
           on funding_authorization.id = reservation.authorization_id
        where reservation.funding_operation_id = $1::uuid
           or reservation.cleanup_operation_id = $1::uuid
        limit 1`,
      [maintenance.operationId],
    );
    const laneRow = lane.rows[0];
    if (
      !laneRow ||
      !(await lockFundingAuthorizationReservationScope(client, {
        authorizationId: laneRow.authorization_id,
        userId: laneRow.user_id,
      }))
    ) {
      return;
    }
  }
  await allocateFinalizedRelaySourceDebitInTransaction(client, {
    now,
    profile,
  });
  if (allowRetry) {
    // These are factual, bounded safety decisions. They used to be hidden in
    // direct step-cache updates, which made Relay retry behaviour invisible to
    // the common projector. A known non-broadcast failure and an elapsed reorg
    // watch are now explicit attempt facts; the reducer materializes the
    // resulting actionability for every consumer.
    const retryableFailure = await client.query<{ operation_id: string }>({
      name: "funding-relay-record-retryable-failure-v1",
      text: `update funding_operation_step_attempts attempt
                set actual_costs = coalesce(attempt.actual_costs, '{}'::jsonb)
                                   || jsonb_build_object(
                                        'retryableProviderFailure', true
                                      ),
                    updated_at = $2
               from funding_operation_steps step
               join funding_operations operation
                 on operation.id = step.operation_id
              where attempt.step_id = step.id
                and step.executor_id = $1
                and step.action_validation_result ->> 'relayStepKind' in (
                      'approve', 'deposit'
                    )
                and attempt.attempt_number = (
                      select max(candidate.attempt_number)
                      from funding_operation_step_attempts candidate
                      where candidate.step_id = step.id
                    )
                and attempt.outcome = 'failed'
                and not attempt.broadcast_may_have_occurred
                and coalesce(attempt.actual_costs ->> 'reasonCode', '') not in (
                      'delegated_action_invalid',
                      'delegated_authority_invalid',
                      'delegated_profile_invalid',
                      'delegated_profile_unavailable',
                      'delegated_quote_expired',
                      'delegated_route_changed',
                      'funding_policy_changed'
                    )
                and attempt.actual_costs ->> 'retryableProviderFailure'
                      is distinct from 'true'
                and (
                  select count(*)
                  from funding_operation_step_attempts counted
                  where counted.step_id = step.id
                ) < 2
                and exists (
                  select 1
                  from telegram_funding_authorization_reservations reservation
                  where reservation.funding_operation_id = operation.id
                    and reservation.status = 'reserved'
                )
              returning operation.id as operation_id`,
      values: [profile.profileId, now],
    });
    const retryableReorg = await client.query<{ operation_id: string }>({
      name: "funding-relay-record-retryable-reorg-v1",
      text: `update funding_operation_step_attempts attempt
                set actual_costs = coalesce(attempt.actual_costs, '{}'::jsonb)
                                   || jsonb_build_object(
                                        'retryableAfterReorg', true
                                      ),
                    updated_at = $2
               from funding_operation_steps step
               join funding_operations operation
                 on operation.id = step.operation_id
               cross join funding_step_receipt_observations receipt
              where attempt.step_id = step.id
                and receipt.attempt_id = attempt.id
                and step.executor_id = $1
                and step.action_validation_result ->> 'relayStepKind' = 'cleanup'
                and attempt.attempt_number = (
                      select max(candidate.attempt_number)
                      from funding_operation_step_attempts candidate
                      where candidate.step_id = step.id
                    )
                and receipt.status = 'reorged'
                and not receipt.canonical
                and receipt.reorged_at <= $2::timestamptz - interval '15 minutes'
                and attempt.actual_costs ->> 'retryableAfterReorg'
                      is distinct from 'true'
                and (
                  select count(*)
                  from funding_operation_step_attempts counted
                  where counted.step_id = step.id
                ) < 2
                and exists (
                  select 1
                  from telegram_funding_authorization_reservations reservation
                  where reservation.cleanup_operation_id = operation.id
                    and reservation.status = 'cleanup_required'
                )
              returning operation.id as operation_id`,
      values: [profile.profileId, now],
    });
    const affectedOperationIds = new Set([
      ...retryableFailure.rows.map((row) => row.operation_id),
      ...retryableReorg.rows.map((row) => row.operation_id),
    ]);
    for (const operationId of affectedOperationIds) {
      await reduceFundingOperationInTransaction(client, { operationId, now });
    }
  }
  const approval =
    maintenance?.kind === "approval"
      ? await client.query<{
          approval_receipt_id: string;
          approval_block: string;
          expected_raw: string;
          operation_id: string;
          wallet_address: string;
        }>(
          `select approval_receipt.id as approval_receipt_id,
            approval_receipt.ledger_height as approval_block,
            operation.id as operation_id,
            coalesce(
              approval_step.action_validation_result ->> 'relayApprovalCapRaw',
              reservation.source_raw::text
            ) as expected_raw,
            funding_authorization.wallet_address
       from funding_operation_steps approval_step
       join funding_operation_steps deposit_step
         on deposit_step.depends_on_step_id = approval_step.id
        and deposit_step.operation_id = approval_step.operation_id
       join funding_step_receipt_observations approval_receipt
         on approval_receipt.step_id = approval_step.id
        and approval_receipt.status = 'finalized'
        and approval_receipt.action_match
        and approval_receipt.canonical
        and approval_receipt.evidence ->> 'singleOperationBundle' = 'true'
       join funding_operations operation on operation.id = approval_step.operation_id
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id::text = operation.support_metadata ->> 'fundingAuthorizationId'
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
        and reservation.status = 'reserved'
       where approval_step.executor_id = $1
         and approval_receipt.id = $2::uuid
         and operation.id = $3::uuid
         and not exists (
           select 1
           from funding_operation_step_attempts deposit_attempt
           where deposit_attempt.step_id = deposit_step.id
         )
         and approval_receipt.evidence ->> 'allowanceExact' is distinct from 'true'
         and approval_receipt.evidence ->> 'allowanceExactRejected'
               is distinct from 'true'
       order by approval_receipt.observed_at
       for update of approval_step, deposit_step, approval_receipt, operation, reservation
       limit 1`,
          [profile.profileId, maintenance.candidateId, maintenance.operationId],
        )
      : { rows: [] };
  const approvalRow = approval.rows[0];
  if (
    approvalRow &&
    maintenance?.kind === "approval" &&
    maintenance.allowance.blockNumber === approvalRow.approval_block &&
    maintenance.expectedBlockHash !== maintenance.allowance.blockHash
  ) {
    await client.query(
      `update funding_step_receipt_observations
          set evidence = evidence || jsonb_build_object(
                'allowanceAnchorRejected', true,
                'lastAllowanceAnchorBlockHash', $2::text
              ),
              updated_at = $3
        where id = $1::uuid and status = 'finalized'`,
      [approvalRow.approval_receipt_id, maintenance.allowance.blockHash, now],
    );
    await reduceFundingOperationInTransaction(client, {
      operationId: approvalRow.operation_id,
      now,
    });
  }
  if (
    approvalRow &&
    maintenance?.kind === "approval" &&
    maintenance.allowance.blockNumber === approvalRow.approval_block &&
    maintenance.expectedBlockHash === maintenance.allowance.blockHash
  ) {
    const observed = maintenance.allowance;
    if (
      BigInt(observed.raw) !== BigInt(approvalRow.expected_raw) ||
      !relayAllowanceMutationIsOwned(maintenance)
    ) {
      if (BigInt(observed.raw) === BigInt(approvalRow.expected_raw)) {
        await client.query(
          `update funding_step_receipt_observations
              set evidence = evidence || jsonb_build_object(
                    'allowanceOwnershipRejected', true,
                    'lastAllowanceMutationTransactionHash', $2::text
                  ),
                  updated_at = $3
            where id = $1::uuid and status = 'finalized'`,
          [
            approvalRow.approval_receipt_id,
            observed.lastMutationTransactionHash,
            now,
          ],
        );
        await retireRelayPreDepositRouteInTransaction(client, {
          errorCode: "relay_allowance_ownership_changed",
          operationId: approvalRow.operation_id,
          observed,
          now,
          reason: "foreign_allowance_ownership",
        });
      } else {
        await client.query(
          `update funding_step_receipt_observations
              set evidence = evidence || jsonb_build_object(
                    'allowanceExactRejected', true,
                    'observedAllowanceRaw', $2::text,
                    'observedAllowanceBlock', $3::text,
                    'observedAllowanceBlockHash', $4::text
                  ),
                  updated_at = $5
            where id = $1 and status = 'finalized'`,
          [
            approvalRow.approval_receipt_id,
            observed.raw,
            observed.blockNumber,
            observed.blockHash,
            now,
          ],
        );
        await reduceFundingOperationInTransaction(client, {
          operationId: approvalRow.operation_id,
          now,
        });
      }
    } else {
      await client.query(
        `update funding_step_receipt_observations
            set evidence = evidence || jsonb_build_object(
                  'allowanceExact', true,
                  'allowanceRaw', $2::text,
                  'allowanceBlock', $3::text,
                  'allowanceBlockHash', $4::text,
                  'allowanceObservationRevision', $5::text
                ),
                observed_at = greatest(observed_at, $6),
                updated_at = $6
          where id = $1 and status = 'finalized'`,
        [
          approvalRow.approval_receipt_id,
          approvalRow.expected_raw,
          observed.blockNumber,
          observed.blockHash,
          observed.revision,
          now,
        ],
      );
      await reduceFundingOperationInTransaction(client, {
        operationId: approvalRow.operation_id,
        now,
      });
    }
  }

  const releasable =
    maintenance?.kind === "releasable"
      ? await client.query<{
          approval_step_id: string;
          operation_id: string;
          operation_version: string | number;
          wallet_address: string;
        }>(
          `select operation.id as operation_id,
            operation.version as operation_version,
            approval_step.id as approval_step_id,
            funding_authorization.wallet_address
       from telegram_funding_authorization_reservations reservation
       join funding_operations operation
         on operation.id = reservation.funding_operation_id
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id = reservation.authorization_id
       join funding_operation_steps approval_step
         on approval_step.operation_id = operation.id
        and approval_step.executor_id = $1
        and approval_step.action_validation_result ->> 'relayStepKind' =
              'approve'
       where reservation.status = 'reserved'
         and reservation.id = $2::uuid
         and operation.id = $3::uuid
         and not exists (
           select 1
           from funding_step_receipt_observations approval_success
           where approval_success.step_id = approval_step.id
             and approval_success.status = 'finalized'
             and approval_success.action_match
             and approval_success.canonical
         )
         and not exists (
           select 1
           from funding_operation_step_attempts unresolved_attempt
           where unresolved_attempt.step_id = approval_step.id
             and (
               unresolved_attempt.outcome in ('started', 'ambiguous')
               or unresolved_attempt.broadcast_may_have_occurred
             )
             and not exists (
               select 1
               from funding_step_receipt_observations attempt_receipt
               where attempt_receipt.attempt_id = unresolved_attempt.id
                 and attempt_receipt.status in ('finalized', 'failed')
                 and attempt_receipt.canonical
             )
         )
       order by operation.created_at
       for update of reservation, operation, approval_step skip locked
       limit 1`,
          [profile.profileId, maintenance.candidateId, maintenance.operationId],
        )
      : { rows: [] };
  const releasableRow = releasable.rows[0];
  if (
    releasableRow &&
    maintenance?.kind === "releasable" &&
    (await relayActionNeedsAllowanceMaintenanceInTransaction(client, {
      operationId: releasableRow.operation_id,
      actionId: releasableRow.approval_step_id,
      now,
    }))
  ) {
    const observed = maintenance.allowance;
    if (observed.raw === "0") {
      // An exhausted approval must release its rolling-cap reservation; the
      // dependent deposit remains untouched and can never become claimable.
      await writeFundingOperationSupportFactsInTransaction(client, {
        operationId: releasableRow.operation_id,
        expectedVersion: Number(releasableRow.operation_version),
        supportMetadataPatch: {
          lifecycleTerminalFailure: {
            code: "relay_approval_exhausted",
            decidedAt: now.toISOString(),
            actionId: releasableRow.approval_step_id,
            reason: "approval_not_effective",
            observedAllowance: {
              raw: observed.raw,
              block: observed.blockNumber,
              blockHash: observed.blockHash,
              revision: observed.revision,
            },
          },
        },
        now,
      });
      const reduction = await reduceFundingOperationInTransaction(client, {
        operationId: releasableRow.operation_id,
        now,
      });
      if (reduction.finalState.status !== "failed") {
        throw new Error("exhausted Relay approval did not reduce to failure");
      }
    } else {
      // No finalized Hunch approval exists, so a positive allowance cannot be
      // attributed to this operation. Never adopt or revoke it. This is a
      // durable evidence-review fact; the lifecycle projector owns its public
      // recovery cache rather than walking the old status transition graph.
      await writeFundingOperationSupportFactsInTransaction(client, {
        operationId: releasableRow.operation_id,
        expectedVersion: Number(releasableRow.operation_version),
        supportMetadataPatch: {
          lifecycleManualRecovery: {
            code: "relay_unattributed_allowance",
            requestedAt: now.toISOString(),
          },
          observedAllowanceBlock: observed.blockNumber,
          observedAllowanceBlockHash: observed.blockHash,
          observedAllowanceRaw: observed.raw,
        },
        now,
      });
      const reduction = await reduceFundingOperationInTransaction(client, {
        operationId: releasableRow.operation_id,
        now,
      });
      if (reduction.finalState.status !== "recovery_required") {
        throw new Error(
          "unattributed Relay allowance did not require recovery",
        );
      }
    }
  }

  const strandedAllowance =
    maintenance?.kind === "stranded"
      ? await client.query<{
          approval_receipt_id: string;
          deposit_step_id: string;
          deposit_attempt_count: string | number;
          operation_id: string;
          wallet_address: string;
        }>(
          `select approval_receipt.id as approval_receipt_id,
            deposit_step.id as deposit_step_id,
            (select count(*)
               from funding_operation_step_attempts deposit_attempt
              where deposit_attempt.step_id = deposit_step.id
            ) as deposit_attempt_count,
            operation.id as operation_id,
            funding_authorization.wallet_address
       from funding_operations operation
       join funding_operation_steps approval_step
         on approval_step.operation_id = operation.id
        and approval_step.executor_id = $1
        and approval_step.action_validation_result ->> 'relayStepKind' =
              'approve'
       join funding_step_receipt_observations approval_receipt
         on approval_receipt.step_id = approval_step.id
        and approval_receipt.status = 'finalized'
        and approval_receipt.action_match
        and approval_receipt.canonical
        and approval_receipt.evidence ->> 'singleOperationBundle' = 'true'
        and approval_receipt.evidence ->> 'allowanceExact' = 'true'
        and approval_receipt.evidence ->> 'allowanceOwnershipRejected'
              is distinct from 'true'
       join funding_operation_steps deposit_step
         on deposit_step.operation_id = operation.id
        and deposit_step.depends_on_step_id = approval_step.id
        and deposit_step.action_validation_result ->> 'relayStepKind' =
              'deposit'
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id::text =
              operation.support_metadata ->> 'fundingAuthorizationId'
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
        and reservation.status = 'reserved'
        and reservation.cleanup_operation_id is null
       where operation.id = $2::uuid
         and not exists (
           select 1
           from funding_operation_step_attempts unresolved_attempt
           where unresolved_attempt.step_id = deposit_step.id
             and (
               unresolved_attempt.outcome in ('started', 'ambiguous')
               or unresolved_attempt.broadcast_may_have_occurred
             )
             and not exists (
               select 1
               from funding_step_receipt_observations attempt_receipt
               where attempt_receipt.attempt_id = unresolved_attempt.id
                 and attempt_receipt.status in ('finalized', 'failed')
                 and attempt_receipt.canonical
             )
         )
       order by operation.created_at
       for update of operation, deposit_step, reservation skip locked
       limit 1`,
          [profile.profileId, maintenance.operationId],
        )
      : { rows: [] };
  const strandedAllowanceRow = strandedAllowance.rows[0];
  if (
    strandedAllowanceRow &&
    maintenance?.kind === "stranded" &&
    (await relayActionNeedsAllowanceMaintenanceInTransaction(client, {
      operationId: strandedAllowanceRow.operation_id,
      actionId: strandedAllowanceRow.deposit_step_id,
      now,
    }))
  ) {
    const observed = maintenance.allowance;
    if (Number(strandedAllowanceRow.deposit_attempt_count) === 0) {
      // The approve is canonical but deposit was never claimed. It is safe to
      // retire this route; the next route always sends its own exact approve.
      await retireRelayPreDepositRouteInTransaction(client, {
        errorCode: "relay_deposit_expired_before_broadcast",
        operationId: strandedAllowanceRow.operation_id,
        observed,
        now,
        reason: "deposit_not_started",
      });
    } else if (
      observed.raw !== "0" &&
      relayAllowanceMutationIsOwned(maintenance)
    ) {
      // A deposit reached the provider and failed canonically. Keep the
      // existing bounded cleanup/reorg fence for its residual allowance.
      await createRelayAllowanceCleanupOperationInTransaction(client, {
        profile,
        parentOperationId: strandedAllowanceRow.operation_id,
        allowanceRaw: observed.raw,
        allowanceRevision: observed.ownershipRevision ?? "",
        allowanceObservedBlock: observed.blockNumber,
        allowanceMutationBaselineBlock: maintenance.mutationBaselineBlock ?? "",
        now,
      });
    } else if (observed.raw !== "0") {
      await client.query(
        `update funding_step_receipt_observations
            set evidence = evidence || jsonb_build_object(
                  'allowanceOwnershipRejected', true,
                  'lastAllowanceMutationTransactionHash', $2::text
                ),
                updated_at = $3
          where id = $1::uuid and status = 'finalized'`,
        [
          strandedAllowanceRow.approval_receipt_id,
          observed.lastMutationTransactionHash,
          now,
        ],
      );
      await retireRelayPreDepositRouteInTransaction(client, {
        errorCode: "relay_allowance_ownership_changed",
        operationId: strandedAllowanceRow.operation_id,
        observed,
        now,
        reason: "foreign_allowance_ownership",
      });
    }
  }

  const deposit =
    maintenance?.kind === "deposit"
      ? await client.query<{
          deposit_block_hash: string;
          deposit_receipt_id: string;
          deposit_attempt_id: string;
          deposit_block: string;
          deposit_observed_at: Date;
          event_index: string;
          operation_id: string;
          segment_id: string;
          expected_raw: string;
          tx_hash: string;
          uses_preexisting_allowance: boolean;
          wallet_address: string;
        }>(
          `select deposit_receipt.id as deposit_receipt_id,
            deposit_receipt.attempt_id as deposit_attempt_id,
            deposit_receipt.ledger_height as deposit_block,
            deposit_receipt.block_hash as deposit_block_hash,
            deposit_receipt.observed_at as deposit_observed_at,
            deposit_receipt.evidence ->> 'sourceDebitEventIndex' as event_index,
            operation.id as operation_id,
            segment.id as segment_id,
            reservation.source_raw::text as expected_raw,
            deposit_receipt.evidence ->> 'transactionHash' as tx_hash,
            (deposit_step.action_validation_result ->>
              'relayAllowanceMode') = 'preexisting'
              as uses_preexisting_allowance,
            funding_authorization.wallet_address
       from funding_operation_steps deposit_step
       join funding_step_receipt_observations deposit_receipt
         on deposit_receipt.step_id = deposit_step.id
        and deposit_receipt.status = 'finalized'
        and deposit_receipt.action_match
        and deposit_receipt.canonical
        and deposit_receipt.evidence ->> 'singleOperationBundle' = 'true'
       join funding_operations operation on operation.id = deposit_step.operation_id
       join funding_operation_segments segment
         on segment.operation_id = operation.id and segment.ordinal = 0
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
        and reservation.status = 'reserved'
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id::text = operation.support_metadata ->> 'fundingAuthorizationId'
       where deposit_step.executor_id = $1
         and deposit_receipt.id = $2::uuid
         and operation.id = $3::uuid
         and deposit_receipt.evidence ->> 'attributedSourceRaw' = reservation.source_raw::text
         and deposit_receipt.block_hash is not null
         and deposit_receipt.evidence ->> 'sourceDebitEventIndex' is not null
         and deposit_receipt.evidence ->> 'transactionHash' is not null
         and deposit_receipt.evidence ->> 'allowanceZero' is distinct from 'true'
         and not exists (
           select 1
             from funding_observations source_debit
            where source_debit.operation_id = operation.id
              and source_debit.kind = 'source_debit'
              and source_debit.canonical
              and source_debit.finality_status = 'finalized'
         )
       order by deposit_receipt.observed_at
       for update of deposit_step, deposit_receipt, operation
       limit 1`,
          [profile.profileId, maintenance.candidateId, maintenance.operationId],
        )
      : { rows: [] };
  const depositRow = deposit.rows[0];
  if (
    depositRow &&
    maintenance?.kind === "deposit" &&
    maintenance.allowance.blockNumber === depositRow.deposit_block &&
    maintenance.expectedBlockHash !== maintenance.allowance.blockHash
  ) {
    await client.query(
      `update funding_step_receipt_observations
          set evidence = evidence || jsonb_build_object(
                'allowanceAnchorRejected', true,
                'observedAllowanceBlockHash', $2::text
              ),
              updated_at = $3
        where id = $1::uuid and status = 'finalized'`,
      [depositRow.deposit_receipt_id, maintenance.allowance.blockHash, now],
    );
  }
  if (
    depositRow &&
    maintenance?.kind === "deposit" &&
    maintenance.allowance.blockNumber === depositRow.deposit_block &&
    maintenance.expectedBlockHash === maintenance.allowance.blockHash
  ) {
    const observed = maintenance.allowance;
    if (
      !depositRow.uses_preexisting_allowance &&
      observed.raw !== "0" &&
      relayAllowanceMutationIsOwned(maintenance)
    ) {
      await createRelayAllowanceCleanupOperationInTransaction(client, {
        profile,
        parentOperationId: depositRow.operation_id,
        allowanceRaw: observed.raw,
        allowanceRevision: observed.ownershipRevision ?? "",
        allowanceObservedBlock: observed.blockNumber,
        allowanceMutationBaselineBlock: maintenance.mutationBaselineBlock ?? "",
        now,
      });
      return;
    }
    if (!depositRow.uses_preexisting_allowance && observed.raw !== "0") {
      await client.query(
        `update funding_step_receipt_observations
            set evidence = evidence || jsonb_build_object(
                  'allowanceOwnershipRejected', true,
                  'lastAllowanceMutationTransactionHash', $2::text
                ),
                updated_at = $3
          where id = $1::uuid and status = 'finalized'`,
        [
          depositRow.deposit_receipt_id,
          observed.lastMutationTransactionHash,
          now,
        ],
      );
      return;
    }
    await allocateFundingObservationInTransaction(client, {
      operationId: depositRow.operation_id,
      segmentId: depositRow.segment_id,
      kind: "source_debit",
      networkId: profile.sourceAsset.networkId,
      assetId: profile.sourceAsset.assetId,
      assetDecimals: profile.sourceAsset.decimals,
      txHash: depositRow.tx_hash,
      eventIndex: depositRow.event_index,
      fromAddress: depositRow.wallet_address,
      toAddress: RELAY_DEPOSITORY_V2,
      rawAmount: depositRow.expected_raw,
      observedAt: depositRow.deposit_observed_at,
      ledgerHeight: depositRow.deposit_block,
      blockHash: depositRow.deposit_block_hash,
      finalityStatus: "finalized",
      finalizedAt: now,
      metadata: {
        relayDelegatedProfile: profile.profileId,
        receiptAttemptId: depositRow.deposit_attempt_id,
      },
    });
    await client.query(
      `update funding_step_receipt_observations
          set evidence = evidence || $2::jsonb,
              observed_at = greatest(observed_at, $3),
              updated_at = $3
        where id = $1 and status = 'finalized'`,
      [
        depositRow.deposit_receipt_id,
        depositRow.uses_preexisting_allowance
          ? {
              preexistingAllowanceUsed: true,
              allowanceBlock: observed.blockNumber,
              allowanceBlockHash: observed.blockHash,
              allowanceObservationRevision: observed.revision,
            }
          : {
              allowanceZero: true,
              allowanceRaw: "0",
              allowanceBlock: observed.blockNumber,
              allowanceBlockHash: observed.blockHash,
              allowanceObservationRevision: observed.revision,
            },
        now,
      ],
    );
  }

  const cleanup =
    maintenance?.kind === "cleanup"
      ? await client.query<{
          cleanup_context: RelayCleanupContext;
          cleanup_block: string;
          cleanup_operation_id: string;
          cleanup_operation_version: string | number;
          cleanup_receipt_finalized_at: Date;
          cleanup_receipt_id: string;
          cleanup_step_id: string;
          deposit_receipt_id: string | null;
          deposit_attempt_id: string | null;
          deposit_event_index: string | null;
          deposit_block: string | null;
          deposit_block_hash: string | null;
          deposit_observed_at: Date | null;
          deposit_transaction_hash: string | null;
          expected_raw: string;
          parent_operation_id: string;
          parent_operation_version: string | number;
          reservation_id: string;
          segment_id: string | null;
          wallet_address: string;
        }>(
          `select cleanup_receipt.id as cleanup_receipt_id,
            cleanup_receipt.ledger_height as cleanup_block,
            cleanup_operation.id as cleanup_operation_id,
            cleanup_operation.version as cleanup_operation_version,
            cleanup_receipt.finalized_at as cleanup_receipt_finalized_at,
            cleanup_step.id as cleanup_step_id,
            cleanup_step.action_validation_result ->> 'cleanupContext'
              as cleanup_context,
            parent.id as parent_operation_id,
            parent.version as parent_operation_version,
            deposit_receipt.id as deposit_receipt_id,
            deposit_receipt.attempt_id as deposit_attempt_id,
            deposit_receipt.ledger_height as deposit_block,
            deposit_receipt.block_hash as deposit_block_hash,
            deposit_receipt.observed_at as deposit_observed_at,
            deposit_receipt.evidence ->> 'sourceDebitEventIndex'
              as deposit_event_index,
            deposit_receipt.evidence ->> 'transactionHash'
              as deposit_transaction_hash,
            reservation.source_raw::text as expected_raw,
            reservation.id as reservation_id,
            segment.id as segment_id,
            funding_authorization.wallet_address
       from telegram_funding_authorization_reservations reservation
       join funding_operations cleanup_operation
         on cleanup_operation.id = reservation.cleanup_operation_id
       join funding_operation_steps cleanup_step
         on cleanup_step.operation_id = cleanup_operation.id
        and cleanup_step.executor_id = $1
        and cleanup_step.action_validation_result ->> 'relayStepKind' = 'cleanup'
       join funding_step_receipt_observations cleanup_receipt
         on cleanup_receipt.step_id = cleanup_step.id
        and cleanup_receipt.status = 'finalized'
        and cleanup_receipt.action_match
        and cleanup_receipt.canonical
        and cleanup_receipt.evidence ->> 'singleOperationBundle' = 'true'
        and cleanup_receipt.finalized_at <=
              $4::timestamptz -
                $5::bigint * interval '1 millisecond'
       join funding_operations parent
         on parent.id = reservation.funding_operation_id
       left join funding_operation_segments segment
         on segment.operation_id = parent.id and segment.ordinal = 0
       join funding_operation_steps deposit_step
         on deposit_step.operation_id = parent.id
        and deposit_step.executor_id = $1
        and deposit_step.action_validation_result ->> 'relayStepKind' = 'deposit'
       left join funding_step_receipt_observations deposit_receipt
         on deposit_receipt.step_id = deposit_step.id
        and deposit_receipt.status = 'finalized'
        and deposit_receipt.action_match
        and deposit_receipt.canonical
        and deposit_receipt.evidence ->> 'singleOperationBundle' = 'true'
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id = reservation.authorization_id
       where reservation.status = 'cleanup_required'
         and ${RELAY_ALLOWANCE_LANE_HEAD_PREDICATE}
         and cleanup_receipt.id = $2::uuid
         and cleanup_operation.id = $3::uuid
         and cleanup_step.action_validation_result ->> 'cleanupContext' in (
               'approval_exhausted', 'pre_deposit_failure', 'post_deposit'
             )
         and (
           cleanup_step.action_validation_result ->> 'cleanupContext' <>
             'post_deposit'
           or (
             segment.id is not null
             and deposit_receipt.block_hash is not null
             and deposit_receipt.evidence ->> 'sourceDebitEventIndex' is not null
             and deposit_receipt.evidence ->> 'transactionHash' is not null
           )
         )
         and cleanup_receipt.evidence ->> 'allowanceZero' is distinct from 'true'
       order by cleanup_receipt.observed_at
       for update of reservation, cleanup_operation, cleanup_step,
                     cleanup_receipt, parent
       limit 1`,
          [
            profile.profileId,
            maintenance.candidateId,
            maintenance.operationId,
            now,
            RELAY_CLEANUP_CANONICAL_WATCH_MS,
          ],
        )
      : { rows: [] };
  const cleanupRow = cleanup.rows[0];
  if (
    cleanupRow &&
    maintenance?.kind === "cleanup" &&
    relayAllowanceMutationIsOwned(maintenance)
  ) {
    const observed = maintenance.allowance;
    if (
      observed.raw === "0" &&
      cleanupRow.cleanup_receipt_finalized_at.getTime() <=
        now.getTime() - RELAY_CLEANUP_CANONICAL_WATCH_MS
    ) {
      if (cleanupRow.cleanup_context === "post_deposit") {
        if (
          !cleanupRow.segment_id ||
          !cleanupRow.deposit_transaction_hash ||
          !cleanupRow.deposit_event_index ||
          !cleanupRow.deposit_observed_at ||
          !cleanupRow.deposit_block ||
          !cleanupRow.deposit_block_hash ||
          !cleanupRow.deposit_receipt_id ||
          !cleanupRow.deposit_attempt_id
        ) {
          throw new Error("Relay post-deposit cleanup evidence is incomplete");
        }
        await allocateRelayPostDepositSourceDebitInTransaction(client, {
          profile,
          evidence: {
            parentOperationId: cleanupRow.parent_operation_id,
            segmentId: cleanupRow.segment_id,
            depositReceiptId: cleanupRow.deposit_receipt_id,
            depositAttemptId: cleanupRow.deposit_attempt_id,
            depositTransactionHash: cleanupRow.deposit_transaction_hash,
            depositEventIndex: cleanupRow.deposit_event_index,
            depositObservedAt: cleanupRow.deposit_observed_at,
            depositBlock: cleanupRow.deposit_block,
            depositBlockHash: cleanupRow.deposit_block_hash,
            expectedRaw: cleanupRow.expected_raw,
            walletAddress: cleanupRow.wallet_address,
          },
          allowance: observed,
          cleanupOperationId: cleanupRow.cleanup_operation_id,
          cleanupReceiptId: cleanupRow.cleanup_receipt_id,
          now,
        });
      } else {
        await client.query(
          `update funding_step_receipt_observations
              set evidence = evidence || jsonb_build_object(
                    'allowanceZero', true,
                    'allowanceRaw', '0',
                    'allowanceBlock', $2::text,
                    'allowanceBlockHash', $3::text,
                    'allowanceObservationRevision', $4::text
                  ),
                  observed_at = greatest(observed_at, $5),
                  updated_at = $5
            where id = $1::uuid`,
          [
            cleanupRow.cleanup_receipt_id,
            observed.blockNumber,
            observed.blockHash,
            observed.revision,
            now,
          ],
        );
      }
      await completeRelayCleanupFromCanonicalZeroInTransaction(client, {
        operationId: cleanupRow.cleanup_operation_id,
        actionId: cleanupRow.cleanup_step_id,
        now,
        evidence: {
          allowanceZeroBlock: observed.blockNumber,
          allowanceZeroBlockHash: observed.blockHash,
          allowanceZeroReceiptId: cleanupRow.cleanup_receipt_id,
          cleanupCanonicalWatchCompletedAt: now.toISOString(),
        },
      });
      const cleaned = await client.query(
        `update telegram_funding_authorization_reservations
              set status = 'cleaned',
                  resolved_at = $2,
                  resolution_evidence = resolution_evidence ||
                    jsonb_build_object(
                      'cleanupReceiptId', $3::text,
                      'allowanceZeroBlock', $4::text,
                      'cleanupCanonicalWatchCompletedAt', $2::timestamptz
                    ),
                  updated_at = $2
            where id = $1::uuid and status = 'cleanup_required'`,
        [
          cleanupRow.reservation_id,
          now,
          cleanupRow.cleanup_receipt_id,
          observed.blockNumber,
        ],
      );
      if (cleaned.rowCount !== 1)
        throw new Error("Relay cleanup maturity reservation update was lost");
      await terminalizeRelayParentAfterCleanup(client, {
        cleanupContext: cleanupRow.cleanup_context,
        parentOperationId: cleanupRow.parent_operation_id,
        now,
        profile,
        evidence: {
          allowanceZeroBlock: cleanupRow.cleanup_block,
          allowanceZeroBlockHash: observed.blockHash,
          allowanceZeroRevision: observed.revision,
          cleanupCanonicalWatchCompletedAt: now.toISOString(),
          cleanupOperationId: cleanupRow.cleanup_operation_id,
          cleanupReceiptId: cleanupRow.cleanup_receipt_id,
        },
      });
    }
  } else if (cleanupRow && maintenance?.kind === "cleanup") {
    const observed = maintenance.allowance;
    await client.query(
      `update funding_step_receipt_observations
          set evidence = evidence || jsonb_build_object(
                'allowanceOwnershipRejected', true,
                'lastAllowanceMutationTransactionHash', $2::text,
                'observedAllowanceRaw', $3::text,
                'observedAllowanceBlock', $4::text,
                'observedAllowanceBlockHash', $5::text
              ),
              updated_at = $6
        where id = $1::uuid and status = 'finalized'`,
      [
        cleanupRow.cleanup_receipt_id,
        observed.lastMutationTransactionHash,
        observed.raw,
        observed.blockNumber,
        observed.blockHash,
        now,
      ],
    );
    const recoveryFact = {
      code: "relay_cleanup_foreign_allowance_drift",
      requestedAt: now.toISOString(),
    };
    await writeFundingOperationSupportFactsInTransaction(client, {
      operationId: cleanupRow.cleanup_operation_id,
      expectedVersion: Number(cleanupRow.cleanup_operation_version),
      supportMetadataPatch: {
        lifecycleManualRecovery: recoveryFact,
        observedAllowanceRaw: observed.raw,
        observedAllowanceRevision: observed.ownershipRevision,
      },
      now,
    });
    await writeFundingOperationSupportFactsInTransaction(client, {
      operationId: cleanupRow.parent_operation_id,
      expectedVersion: Number(cleanupRow.parent_operation_version),
      supportMetadataPatch: {
        lifecycleManualRecovery: recoveryFact,
        cleanupOperationId: cleanupRow.cleanup_operation_id,
        observedAllowanceRaw: observed.raw,
        observedAllowanceRevision: observed.ownershipRevision,
      },
      now,
    });
    await reduceFundingOperationInTransaction(client, {
      operationId: cleanupRow.cleanup_operation_id,
      now,
    });
    await reduceFundingOperationInTransaction(client, {
      operationId: cleanupRow.parent_operation_id,
      now,
    });
  }
  await terminalizeCompletedRelayCleanupParent(client, now, profile);
}

async function claimRelayCleanup(
  client: PoolClient,
  input: Readonly<{
    configuration: RelayEvmExecutionConfiguration;
    policy: Policy;
    now: Date;
    profile: RelayEvmFundingProfileSpec;
  }>,
): Promise<DelegatedFundingProfileClaim | null> {
  const { rows } = await client.query<RelayClaimRow>({
    name: "funding-relay-claim-cleanup-v1",
    text: `select cleanup_operation.id as operation_id,
            cleanup_operation.user_id,
            cleanup_operation.policy_version,
            cleanup_operation.policy_revision,
            funding_authorization.id::text as authorization_id,
            parent.support_metadata ->> 'fundingAuthorizationFingerprint'
              as authorization_fingerprint,
            cleanup_step.id as step_id,
            cleanup_step.action_fingerprint,
            cleanup_step.action_validation_result,
            null::text as allowance_mutation_baseline_block,
            cleanup_step.executor_id,
            cleanup_step.normalized_action,
            cleanup_step.payer_requirement,
            reservation.source_raw::text as receipt_raw,
            ${AUTHORIZATION_COLUMNS}
       from telegram_funding_authorization_reservations reservation
       join funding_operations parent
         on parent.id = reservation.funding_operation_id
       join funding_operations cleanup_operation
         on cleanup_operation.id = reservation.cleanup_operation_id
       join funding_operation_steps cleanup_step
         on cleanup_step.operation_id = cleanup_operation.id
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id = reservation.authorization_id
       where reservation.status = 'cleanup_required'
         and ${RELAY_ALLOWANCE_LANE_HEAD_PREDICATE}
         and cleanup_step.executor_id = $1
         and cleanup_step.action_validation_result ->> 'relayStepKind' = 'cleanup'
         and (cleanup_step.action_expires_at is null
              or cleanup_step.action_expires_at > clock_timestamp())
         and (
           not exists (
             select 1 from funding_operation_step_attempts attempt
              where attempt.step_id = cleanup_step.id
           )
           or (
             (select count(*) from funding_operation_step_attempts attempt
               where attempt.step_id = cleanup_step.id) < 2
             and exists (
               select 1
                 from funding_operation_step_attempts latest
                 left join funding_step_receipt_observations latest_receipt
                   on latest_receipt.attempt_id = latest.id
                where latest.step_id = cleanup_step.id
                  and (
                    (latest.outcome = 'failed'
                     and not latest.broadcast_may_have_occurred)
                    or (
                      latest_receipt.status = 'failed'
                      and latest_receipt.canonical
                      and latest_receipt.evidence ->> 'failureFinalized' = 'true'
                      and latest_receipt.finalized_at <=
                            $2::timestamptz - interval '15 minutes'
                    )
                    or (
                      latest_receipt.status = 'reorged'
                      and not latest_receipt.canonical
                      and latest_receipt.reorged_at <=
                            $2::timestamptz - interval '15 minutes'
                    )
                  )
                order by latest.attempt_number desc
                limit 1
             )
           )
         )
         and not exists (
           select 1
           from funding_operation_step_attempts parent_attempt
           join funding_operation_steps parent_step
             on parent_step.id = parent_attempt.step_id
           where parent_step.operation_id = parent.id
             and (
               parent_attempt.outcome in ('started', 'ambiguous')
               or parent_attempt.broadcast_may_have_occurred
             )
             and not exists (
               select 1
               from funding_step_receipt_observations parent_receipt
               where parent_receipt.attempt_id = parent_attempt.id
                 and parent_receipt.status in ('finalized', 'failed')
                 and parent_receipt.canonical
             )
         )
       order by cleanup_operation.created_at
       for update of cleanup_operation, cleanup_step, reservation,
                     funding_authorization skip locked
       limit 25`,
    values: [input.profile.profileId, input.now],
  });
  const row = await firstActionableRelayClaimRow(client, rows, input.now);
  if (!row) return null;
  if (
    !(await tryLockFundingAuthorizationReservationScope(client, {
      authorizationId: row.authorization_id,
      userId: row.user_id,
    }))
  ) {
    return null;
  }
  return validateAndStartRelayClaim(client, row, {
    now: input.now,
    profile: input.profile,
    authorizationAllowed: (authorization) =>
      authorization.signerId === input.configuration.signerId &&
      authorization.signerFingerprint ===
        input.configuration.signerFingerprint &&
      authorization.policyId === input.configuration.policyId &&
      authorization.policyFingerprint === input.configuration.policyFingerprint,
  });
}

/**
 * An unstarted Relay action has not created allowance or crossed a provider
 * boundary. Once its signed action expires, it must be terminalized without an
 * allowance RPC read: an RPC outage must never leave a dead route holding the
 * wallet lane (and therefore a Telegram Buy) indefinitely.
 */
async function expireRelayActionBeforeBroadcast(
  client: PoolClient,
  input: Readonly<{
    now: Date;
    profile: RelayEvmFundingProfileSpec;
  }>,
): Promise<DelegatedFundingProfileClaim | null> {
  const { rows } = await client.query<{
    approval_step_id: string;
    authorization_id: string;
    operation_id: string;
    operation_version: string | number;
    user_id: string;
  }>({
    name: "funding-relay-expire-unstarted-action-v1",
    text: `select operation.id as operation_id,
            operation.user_id,
            operation.version as operation_version,
            approval_step.id as approval_step_id,
            funding_authorization.id::text as authorization_id
       from telegram_funding_authorization_reservations reservation
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id = reservation.authorization_id
       join funding_operations operation
         on operation.id = reservation.funding_operation_id
       join funding_operation_steps approval_step
         on approval_step.operation_id = operation.id
        and approval_step.executor_id = $1
        and approval_step.action_validation_result ->> 'relayStepKind' =
              'approve'
       where reservation.status = 'reserved'
         and ${RELAY_ALLOWANCE_LANE_HEAD_PREDICATE}
         and approval_step.action_expires_at is not null
         and approval_step.action_expires_at <= $2::timestamptz
         and not exists (
           select 1
             from funding_operation_step_attempts attempt
            where attempt.step_id = approval_step.id
         )
       order by operation.created_at, approval_step.ordinal
       for update of reservation, funding_authorization, operation,
                     approval_step skip locked
       limit 1`,
    values: [input.profile.profileId, input.now],
  });
  const row = rows[0];
  if (!row) return null;
  if (
    !(await tryLockFundingAuthorizationReservationScope(client, {
      authorizationId: row.authorization_id,
      userId: row.user_id,
    }))
  ) {
    return null;
  }

  const facts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    { operationId: row.operation_id, now: input.now },
  );
  const approval = facts?.actions.find(
    (action) => action.actionId === row.approval_step_id,
  );
  const lifecycle = facts ? deriveFundingLifecycle(facts) : null;
  // The candidate scan is deliberately cache-free. Revalidate every safety
  // condition under the row locks because an old `action_required` cache must
  // neither expire a live route nor keep a dead one alive.
  if (
    !facts ||
    !approval ||
    approval.attempts.length !== 0 ||
    approval.expiresAt === null ||
    approval.expiresAt.getTime() > input.now.getTime() ||
    lifecycle?.safety.externalEffectMayHaveOccurred ||
    lifecycle?.safety.terminal
  ) {
    return null;
  }
  await writeFundingOperationSupportFactsInTransaction(client, {
    operationId: row.operation_id,
    expectedVersion: Number(row.operation_version),
    supportMetadataPatch: {
      lifecycleTerminalFailure: {
        code: "relay_action_expired_before_broadcast",
        decidedAt: input.now.toISOString(),
        actionId: row.approval_step_id,
        reason: "unstarted_action_expired",
      },
      relayPreclaimDiagnostic: "action_expired_without_attempt",
      relayPreclaimDiagnosedAt: input.now.toISOString(),
    },
    now: input.now,
  });
  const reduction = await reduceFundingOperationInTransaction(client, {
    operationId: row.operation_id,
    now: input.now,
  });
  if (reduction.finalState.status !== "failed") {
    throw new Error("expired Relay action did not reduce to failure");
  }
  return {
    kind: "expired_without_broadcast",
    operationId: row.operation_id,
  };
}

/**
 * A terminal route with no deposit attempt has no possible source debit.
 * Its previous approve is retained as evidence, but its lane/cap reservation
 * must not block the next independently approved route.
 */
async function releaseTerminalRelayPreDepositReservation(
  client: PoolClient,
  input: Readonly<{ now: Date; profile: RelayEvmFundingProfileSpec }>,
): Promise<void> {
  const { rows } = await client.query<{
    authorization_id: string;
    operation_id: string;
    reservation_id: string;
    user_id: string;
  }>({
    name: "funding-relay-release-terminal-predeposit-v1",
    text: `select reservation.id::text as reservation_id,
            reservation.funding_operation_id::text as operation_id,
            funding_authorization.id::text as authorization_id,
            operation_row.user_id::text as user_id
       from telegram_funding_authorization_reservations reservation
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id = reservation.authorization_id
       join funding_operations operation_row
         on operation_row.id = reservation.funding_operation_id
       join funding_operation_steps deposit_step
         on deposit_step.operation_id = operation_row.id
        and deposit_step.action_validation_result ->> 'relayStepKind' =
              'deposit'
      where reservation.status = 'reserved'
        and funding_authorization.profile_id = $1
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
      order by reservation.reserved_at, reservation.id
      for update of reservation, funding_authorization, operation_row, deposit_step
                    skip locked
      limit 25`,
    values: [input.profile.profileId],
  });
  for (const row of rows) {
    if (
      !(await tryLockFundingAuthorizationReservationScope(client, {
        authorizationId: row.authorization_id,
        userId: row.user_id,
      }))
    ) {
      continue;
    }
    const facts = await loadFundingLifecycleFactsForOperationInTransaction(
      client,
      { operationId: row.operation_id, now: input.now },
    );
    if (!facts || !deriveFundingLifecycle(facts).safety.terminal) {
      continue;
    }
    // The cache can be stale precisely when this maintenance path runs. Let
    // the common reducer materialize the terminal result and release its
    // exact lease; this path only identifies the no-deposit candidate.
    await reduceFundingOperationInTransaction(client, {
      operationId: row.operation_id,
      now: input.now,
    });
    const released = await client.query<{ status: string }>(
      `select status
         from telegram_funding_authorization_reservations
        where id = $1::uuid
        for update`,
      [row.reservation_id],
    );
    if (released.rows[0]?.status !== "released") {
      throw new Error(
        "terminal Relay pre-deposit reservation release was lost",
      );
    }
    return;
  }
}

async function claimRelay(
  client: PoolClient,
  input: Readonly<{
    policy: Policy;
    now: Date;
    configuration: RelayEvmExecutionConfiguration;
    observation?: JsonRecord;
    profile: RelayEvmFundingProfileSpec;
  }>,
): Promise<DelegatedFundingProfileClaim | null> {
  await releaseTerminalRelayPreDepositReservation(client, {
    now: input.now,
    profile: input.profile,
  });
  const controlPlaneAllowed = relayControlPlaneAllowed(
    input.configuration,
    input.policy,
    input.profile,
  );
  // An action that expired before it acquired an attempt has no external
  // effect to reconcile. Resolve it before allowance maintenance: maintenance
  // may otherwise treat the stale action as a live lane candidate and take a
  // transition intended for a submitted route.
  const expired = await expireRelayActionBeforeBroadcast(client, {
    now: input.now,
    profile: input.profile,
  });
  if (expired) return expired;
  await reconcileRelayPostconditions(
    client,
    input.observation,
    input.now,
    controlPlaneAllowed,
    input.profile,
  );
  if (!controlPlaneAllowed) {
    return claimRelayCleanup(client, input);
  }
  const { rows } = await client.query<RelayClaimRow>({
    name: "funding-relay-claim-action-v1",
    text: `select operation.id as operation_id,
            operation.user_id,
            operation.policy_version,
            operation.policy_revision,
            operation.support_metadata ->> 'fundingAuthorizationId' as authorization_id,
            operation.support_metadata ->> 'fundingAuthorizationFingerprint' as authorization_fingerprint,
            step.id as step_id,
            step.action_fingerprint,
            step.action_validation_result,
            case
              when step.action_validation_result ->> 'relayStepKind' =
                     'deposit'
              then (
                select dependency_receipt.ledger_height::text
                from funding_step_receipt_observations dependency_receipt
                join funding_operation_step_attempts dependency_attempt
                  on dependency_attempt.id = dependency_receipt.attempt_id
                 and dependency_attempt.step_id = dependency.id
                where dependency_receipt.step_id = dependency.id
                  and dependency_receipt.status = 'finalized'
                  and dependency_receipt.action_match
                  and dependency_receipt.canonical
                  and dependency_receipt.evidence ->> 'allowanceExact' = 'true'
                  and dependency_receipt.evidence ->>
                        'singleOperationBundle' = 'true'
                  and dependency_receipt.evidence ->> 'allowanceRaw' =
                        coalesce(
                          dependency.action_validation_result ->>
                            'relayApprovalCapRaw',
                          reservation.source_raw::text
                        )
                  and dependency_receipt.evidence ->> 'allowanceBlock' =
                        dependency_receipt.ledger_height
                  and lower(
                        dependency_receipt.evidence ->> 'allowanceBlockHash'
                      ) = lower(dependency_receipt.block_hash)
                order by dependency_receipt.observed_at desc,
                         dependency_receipt.id desc
                limit 1
              )
              else null
            end as allowance_mutation_baseline_block,
            step.executor_id,
            step.normalized_action,
            step.payer_requirement,
            reservation.source_raw::text as receipt_raw,
            ${AUTHORIZATION_COLUMNS}
       from funding_operation_steps step
       join funding_operations operation on operation.id = step.operation_id
       left join funding_operation_steps dependency on dependency.id = step.depends_on_step_id
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id::text = operation.support_metadata ->> 'fundingAuthorizationId'
        and funding_authorization.user_id = operation.user_id
        and funding_authorization.profile_id = $1
        and funding_authorization.security_class = 'routed_value_movement'
        and funding_authorization.revoked_at is null
        and (funding_authorization.expires_at is null or funding_authorization.expires_at > clock_timestamp())
       join telegram_funding_authorization_reservations reservation
         on reservation.authorization_id = funding_authorization.id
        and reservation.funding_operation_id = operation.id
        and reservation.source_raw <= funding_authorization.max_source_raw
        and reservation.status = 'reserved'
       where step.executor_id = $1
         and ${RELAY_ALLOWANCE_LANE_HEAD_PREDICATE}
         and (
           (
             reservation.receive_receipt_id is not null
             and exists (
               select 1
                 from funding_receive_receipts receive_receipt
                 join telegram_funding_sessions funding_context
                   on funding_context.receive_session_id =
                        receive_receipt.receive_session_id
                  and funding_context.user_id = operation.user_id
                 join telegram_funding_consents funding_consent
                   on funding_consent.id::text =
                        operation.support_metadata ->>
                          'telegramFundingConsentId'
                  and funding_consent.telegram_funding_session_id =
                        funding_context.id
                  and funding_consent.consent_fingerprint =
                        operation.support_metadata ->>
                          'telegramFundingConsentFingerprint'
                  and funding_consent.automation_policy_snapshot ->>
                        'version' = '3'
                  and funding_consent.automation_policy_snapshot ->>
                        'authorizationId' = funding_authorization.id::text
                where receive_receipt.id = reservation.receive_receipt_id
                  and receive_receipt.child_funding_operation_id = operation.id
                  and receive_receipt.id::text =
                        operation.support_metadata ->>
                          'fundingReceiveReceiptId'
                  and receive_receipt.status = 'routing'
                  and receive_receipt.raw_amount = reservation.source_raw
             )
           )
           or (
             reservation.source_trade_intent_id is not null
             and exists (
               select 1
                 from telegram_trade_intents trade_intent_row
                where trade_intent_row.id =
                      reservation.source_trade_intent_id
                  and trade_intent_row.user_id = operation.user_id
                  and trade_intent_row.status = 'funding'
                  and trade_intent_row.funding_operation_id = operation.id
                  and trade_intent_row.submit_started_at is null
                  and trade_intent_row.id::text =
                        operation.support_metadata ->>
                          'telegramTradeIntentId'
             )
           )
         )
         and (
           step.depends_on_step_id is null
           or exists (
               select 1
               from funding_step_receipt_observations dependency_receipt
               join funding_operation_step_attempts dependency_attempt
                 on dependency_attempt.id = dependency_receipt.attempt_id
                and dependency_attempt.step_id = dependency.id
               where dependency_receipt.step_id = dependency.id
                 and dependency_receipt.status = 'finalized'
                 and dependency_receipt.action_match
                 and dependency_receipt.canonical
                 and dependency_receipt.evidence ->>
                       'singleOperationBundle' = 'true'
                 and step.action_validation_result ->> 'relayStepKind' =
                       'deposit'
                 and dependency.action_validation_result ->>
                       'relayStepKind' = 'approve'
                 and dependency_receipt.evidence ->> 'allowanceExact' = 'true'
                 and dependency_receipt.evidence ->> 'allowanceRaw' =
                       coalesce(
                         dependency.action_validation_result ->>
                           'relayApprovalCapRaw',
                         reservation.source_raw::text
                       )
                 and dependency_receipt.evidence ->> 'allowanceBlock' =
                       dependency_receipt.ledger_height
                 and lower(
                       dependency_receipt.evidence ->> 'allowanceBlockHash'
                     ) = lower(dependency_receipt.block_hash)
             )
         )
         and (step.action_expires_at is null or step.action_expires_at > clock_timestamp())
         and (
           not exists (
             select 1 from funding_operation_step_attempts prior
             where prior.step_id = step.id
           )
           or (
             (select count(*) from funding_operation_step_attempts prior where prior.step_id = step.id) < 2
             and exists (
               select 1
               from funding_operation_step_attempts prior
               left join funding_step_receipt_observations prior_receipt
                 on prior_receipt.attempt_id = prior.id
               where prior.step_id = step.id
               order by prior.attempt_number desc
               limit 1
             )
             and (
               select prior.outcome = 'failed'
                      or (
                        prior_receipt.status = 'failed'
                        and prior_receipt.evidence ->> 'failureFinalized' = 'true'
                        and prior_receipt.canonical
                        and prior_receipt.finalized_at <=
                              $2::timestamptz - interval '15 minutes'
                      )
               from funding_operation_step_attempts prior
               left join funding_step_receipt_observations prior_receipt
                 on prior_receipt.attempt_id = prior.id
               where prior.step_id = step.id
               order by prior.attempt_number desc
               limit 1
             )
           )
         )
       order by operation.created_at, step.ordinal
       for update of operation, step, funding_authorization, reservation skip locked
       limit 25`,
    values: [input.profile.profileId, input.now],
  });
  const row = await firstActionableRelayClaimRow(client, rows, input.now);
  if (!row) return claimRelayCleanup(client, input);
  if (
    !(await tryLockFundingAuthorizationReservationScope(client, {
      authorizationId: row.authorization_id,
      userId: row.user_id,
    }))
  ) {
    return null;
  }
  return validateAndStartRelayClaim(client, row, {
    now: input.now,
    profile: input.profile,
    authorizationAllowed: (authorization) =>
      authorization.maxSourceRaw === input.configuration.maxSourceRaw &&
      Number(row.policy_version) === input.policy.runtime.contractVersion &&
      row.policy_revision === input.policy.revision,
  });
}

async function recoverRelay(
  client: PoolClient,
  input: Readonly<{
    recoverProviderReplayBefore: Date;
    recoverUnbroadcastRetryBefore: Date;
    now: Date;
    profile: RelayEvmFundingProfileSpec;
  }>,
): Promise<DelegatedFundingRecoveryClaim | null> {
  const { rows } = await client.query<RelayRecoveryClaimRow>({
    name: "funding-relay-recover-action-v1",
    text: `select attempt.id as attempt_id,
            attempt.outcome as attempt_outcome,
            operation.id as operation_id,
            operation.user_id,
            operation.policy_version,
            operation.policy_revision,
            operation.support_metadata ->> 'fundingAuthorizationId' as authorization_id,
            operation.support_metadata ->> 'fundingAuthorizationFingerprint' as authorization_fingerprint,
            step.id as step_id,
            step.action_fingerprint,
            step.action_validation_result,
            case
              when step.action_validation_result ->> 'relayStepKind' =
                     'deposit'
              then (
                select dependency_receipt.ledger_height::text
                from funding_step_receipt_observations dependency_receipt
                join funding_operation_step_attempts dependency_attempt
                  on dependency_attempt.id = dependency_receipt.attempt_id
                 and dependency_attempt.step_id = dependency.id
                where dependency_receipt.step_id = dependency.id
                  and dependency_receipt.status = 'finalized'
                  and dependency_receipt.action_match
                  and dependency_receipt.canonical
                  and dependency_receipt.evidence ->> 'allowanceExact' = 'true'
                  and dependency_receipt.evidence ->>
                        'singleOperationBundle' = 'true'
                  and dependency_receipt.evidence ->> 'allowanceRaw' =
                        coalesce(
                          dependency.action_validation_result ->>
                            'relayApprovalCapRaw',
                          reservation.source_raw::text
                        )
                  and dependency_receipt.evidence ->> 'allowanceBlock' =
                        dependency_receipt.ledger_height
                  and lower(
                        dependency_receipt.evidence ->> 'allowanceBlockHash'
                      ) = lower(dependency_receipt.block_hash)
                order by dependency_receipt.observed_at desc,
                         dependency_receipt.id desc
                limit 1
              )
              else null
            end as allowance_mutation_baseline_block,
            step.executor_id,
            step.normalized_action,
            step.payer_requirement,
            reservation.source_raw::text as receipt_raw,
            ${AUTHORIZATION_COLUMNS}
       from funding_operation_step_attempts attempt
       join funding_operation_steps step on step.id = attempt.step_id
       join funding_operations operation on operation.id = step.operation_id
       left join funding_operation_steps dependency
         on dependency.id = step.depends_on_step_id
        and dependency.operation_id = operation.id
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id::text = operation.support_metadata ->> 'fundingAuthorizationId'
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
        and reservation.status in ('reserved', 'cleanup_required')
       where attempt.executor_id = $1
         and ${RELAY_ALLOWANCE_LANE_HEAD_PREDICATE}
         and (
           attempt.outcome = 'ambiguous'
           or (
             (
               reservation.receive_receipt_id is not null
               and exists (
                 select 1
                   from funding_receive_receipts receive_receipt
                  where receive_receipt.id = reservation.receive_receipt_id
                    and receive_receipt.child_funding_operation_id = operation.id
                    and receive_receipt.id::text =
                          operation.support_metadata ->>
                            'fundingReceiveReceiptId'
                    and receive_receipt.status = 'routing'
                    and receive_receipt.raw_amount = reservation.source_raw
               )
             )
             or (
               reservation.source_trade_intent_id is not null
               and exists (
                 select 1
                   from telegram_trade_intents trade_intent_row
                  where trade_intent_row.id =
                        reservation.source_trade_intent_id
                    and trade_intent_row.user_id = operation.user_id
                    and trade_intent_row.status = 'funding'
                    and trade_intent_row.funding_operation_id = operation.id
                    and trade_intent_row.submit_started_at is null
                    and trade_intent_row.id::text =
                          operation.support_metadata ->>
                            'telegramTradeIntentId'
               )
             )
           )
         )
         and (
           attempt.outcome = 'started'
           or (
             attempt.outcome = 'ambiguous'
             and attempt.reference_kind = 'provider_receipt'
           )
         )
         and attempt.updated_at <= case
               when attempt.outcome = 'started' then $2::timestamptz
               else $3::timestamptz
             end
       order by attempt.updated_at, attempt.id
       for update of attempt, step, operation, reservation skip locked
       limit 25`,
    values: [
      input.profile.profileId,
      input.recoverUnbroadcastRetryBefore,
      input.recoverProviderReplayBefore,
    ],
  });
  const row = await firstRecoverableRelayClaimRow(client, rows, input.now);
  if (!row) {
    const cleanup = await client.query<RelayRecoveryClaimRow>({
      name: "funding-relay-recover-cleanup-v1",
      text: `select attempt.id as attempt_id,
              attempt.outcome as attempt_outcome,
              cleanup_operation.id as operation_id,
              cleanup_operation.user_id,
              cleanup_operation.policy_version,
              cleanup_operation.policy_revision,
              funding_authorization.id::text as authorization_id,
              parent.support_metadata ->> 'fundingAuthorizationFingerprint'
                as authorization_fingerprint,
              cleanup_step.id as step_id,
              cleanup_step.action_fingerprint,
              cleanup_step.action_validation_result,
              null::text as allowance_mutation_baseline_block,
              cleanup_step.executor_id,
              cleanup_step.normalized_action,
              cleanup_step.payer_requirement,
              reservation.source_raw::text as receipt_raw,
              ${AUTHORIZATION_COLUMNS}
         from funding_operation_step_attempts attempt
         join funding_operation_steps cleanup_step
           on cleanup_step.id = attempt.step_id
         join funding_operations cleanup_operation
           on cleanup_operation.id = cleanup_step.operation_id
         join telegram_funding_authorization_reservations reservation
           on reservation.cleanup_operation_id = cleanup_operation.id
          and reservation.status = 'cleanup_required'
         join funding_operations parent
           on parent.id = reservation.funding_operation_id
         join telegram_funding_authorizations funding_authorization
           on funding_authorization.id = reservation.authorization_id
         where cleanup_step.executor_id = $1
           and ${RELAY_ALLOWANCE_LANE_HEAD_PREDICATE}
           and cleanup_step.action_validation_result ->> 'relayStepKind' =
                 'cleanup'
           and (
             attempt.outcome = 'started'
             or (
               attempt.outcome = 'ambiguous'
               and attempt.reference_kind = 'provider_receipt'
             )
           )
           and attempt.updated_at <= case
                 when attempt.outcome = 'started' then $2::timestamptz
                 else $3::timestamptz
               end
         order by attempt.updated_at, attempt.id
         for update of attempt, cleanup_step, cleanup_operation,
                       reservation skip locked
         limit 25`,
      values: [
        input.profile.profileId,
        input.recoverUnbroadcastRetryBefore,
        input.recoverProviderReplayBefore,
      ],
    });
    const cleanupRow = await firstRecoverableRelayClaimRow(
      client,
      cleanup.rows,
      input.now,
    );
    if (!cleanupRow) return null;
    if (
      !(await tryLockFundingAuthorizationReservationScope(client, {
        authorizationId: cleanupRow.authorization_id,
        userId: cleanupRow.user_id,
      }))
    ) {
      return null;
    }
    const leasedCleanup = await client.query(
      `update funding_operation_step_attempts
          set updated_at = $2
        where id = $1
          and outcome in ('started', 'ambiguous')
          and updated_at <= $3`,
      [
        cleanupRow.attempt_id,
        input.now,
        cleanupRow.attempt_outcome === "started"
          ? input.recoverUnbroadcastRetryBefore
          : input.recoverProviderReplayBefore,
      ],
    );
    if (leasedCleanup.rowCount !== 1) return null;
    const parsedCleanup = normalizedActionSchema.safeParse(
      cleanupRow.normalized_action,
    );
    if (!parsedCleanup.success) {
      throw new Error("Relay cleanup recovery action is invalid");
    }
    const cleanupAction = parsedCleanup.data as NormalizedAction;
    validateRelayDelegatedEvmAction({
      action: cleanupAction,
      actionValidationResult: cleanupRow.action_validation_result,
      expectedRaw: cleanupRow.receipt_raw,
      walletAddress: cleanupRow.wallet_address,
      walletId: walletId(cleanupRow, input.profile),
      profile: input.profile,
    });
    return claimFromRow(
      cleanupRow,
      {
        action: cleanupAction,
        attemptId: cleanupRow.attempt_id,
        broadcastBoundaryCrossed: cleanupRow.attempt_outcome === "ambiguous",
      },
      input.profile,
    );
  }
  if (
    !(await tryLockFundingAuthorizationReservationScope(client, {
      authorizationId: row.authorization_id,
      userId: row.user_id,
    }))
  ) {
    return null;
  }
  const leased = await client.query(
    `update funding_operation_step_attempts
        set updated_at = $2
      where id = $1 and outcome in ('started', 'ambiguous') and updated_at <= $3`,
    [
      row.attempt_id,
      input.now,
      row.attempt_outcome === "started"
        ? input.recoverUnbroadcastRetryBefore
        : input.recoverProviderReplayBefore,
    ],
  );
  if (leased.rowCount !== 1) return null;
  const parsed = normalizedActionSchema.safeParse(row.normalized_action);
  if (!parsed.success) throw new Error("Relay recovery action is invalid");
  const action = parsed.data as NormalizedAction;
  validateRelayDelegatedEvmAction({
    action,
    actionValidationResult: row.action_validation_result,
    expectedRaw: row.receipt_raw,
    walletAddress: row.wallet_address,
    walletId: walletId(row, input.profile),
    profile: input.profile,
  });
  return claimFromRow(
    row,
    {
      action,
      attemptId: row.attempt_id,
      broadcastBoundaryCrossed: row.attempt_outcome === "ambiguous",
    },
    input.profile,
  );
}

async function preBroadcastRelay(
  client: PoolClient,
  input: Readonly<{
    claim: DelegatedFundingExecutionClaim;
    now: Date;
    configuration: RelayEvmExecutionConfiguration;
    observation?: JsonRecord;
    profile: RelayEvmFundingProfileSpec;
  }>,
) {
  await lockFundingPolicyForTransaction(client);
  const validated = validateRelayDelegatedEvmAction({
    action: input.claim.action,
    actionValidationResult: input.claim.actionValidationResult,
    expectedRaw: input.claim.receiptRaw,
    walletAddress: input.claim.walletAddress,
    walletId: input.claim.actionWalletId,
    profile: input.profile,
  });
  if (
    !input.claim.fundingPolicyRevision ||
    !Number.isSafeInteger(input.claim.fundingPolicyVersion) ||
    (input.claim.fundingPolicyVersion ?? 0) < 1
  ) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
    };
  }
  if (
    !(await lockFundingAuthorizationReservationScope(client, {
      authorizationId: input.claim.authorizationId,
      userId: input.claim.userId,
    }))
  ) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_authority_invalid" as const,
    };
  }
  const claimRoute = input.profile.routeIds
    .map((routeId) => RELAY_ROUTE_SPECS[routeId])
    .find(
      (route) =>
        route != null &&
        route.destination.networkId ===
          (input.claim.venueId === "limitless" ? "evm:8453" : "evm:137"),
    );
  const capability =
    validated.kind === "cleanup"
      ? null
      : input.claim.telegramAccountId && claimRoute
        ? await resolveTelegramRelayEvmCapability(client, {
            userId: input.claim.userId,
            telegramAccountId: input.claim.telegramAccountId,
            telegramUserId: input.claim.telegramUserId,
            destinationOptionId: input.claim.destinationOptionId,
            venueBindingOptionId: input.claim.venueBindingOptionId,
            configuration: input.configuration,
            profileId: input.profile.profileId,
            routeId: claimRoute.routeId,
            sourceAsset: input.profile.sourceAsset,
            destinationAsset: claimRoute.destination,
            venueId: input.claim.venueId,
            expectedAuthorizationId: input.claim.authorizationId,
            expectedAuthorizationFingerprint:
              input.claim.authorizationFingerprint,
            expectedFundingPolicyRevision: input.claim.fundingPolicyRevision,
            now: input.now,
            lock: true,
          })
        : null;
  if (
    validated.kind !== "cleanup" &&
    (!capability || capability.decision.kind !== "allowed")
  ) {
    return (
      capability?.decision ?? {
        kind: "hard_invalid" as const,
        reasonCode: "delegated_authority_invalid" as const,
      }
    );
  }
  const operationLock = await client.query(
    `select id
       from funding_operations
      where id = $1::uuid
        and user_id = $2::uuid
      for update`,
    [input.claim.operationId, input.claim.userId],
  );
  if (operationLock.rowCount !== 1) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
    };
  }
  const stepLock = await client.query(
    `select id
       from funding_operation_steps
      where id = $1::uuid
        and operation_id = $2::uuid
        and executor_id = $3
      for update`,
    [input.claim.stepId, input.claim.operationId, input.profile.profileId],
  );
  if (stepLock.rowCount !== 1) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
    };
  }
  const attemptLock = await client.query<{ attempt_number: number }>(
    `select attempt_number
       from funding_operation_step_attempts
      where id = $1::uuid
        and step_id = $2::uuid
        and executor_id = $3
      for update`,
    [input.claim.attemptId, input.claim.stepId, input.profile.profileId],
  );
  if (attemptLock.rowCount !== 1) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
    };
  }
  const usesPreexistingAllowance =
    validated.kind === "deposit" &&
    input.claim.actionValidationResult.relayAllowanceMode === "preexisting";
  const reservationLock = await client.query(
    `select id
       from telegram_funding_authorization_reservations
      where authorization_id = $1::uuid
        and (
          ($2::boolean = false and funding_operation_id = $3::uuid)
          or ($2::boolean = true and cleanup_operation_id = $3::uuid)
        )
        and status = case
              when $2::boolean then 'cleanup_required'
              else 'reserved'
            end
      for update`,
    [
      input.claim.authorizationId,
      validated.kind === "cleanup",
      input.claim.operationId,
    ],
  );
  if (reservationLock.rowCount !== 1) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
      diagnosticCode: "reservation_lane_missing" as const,
    };
  }
  const attemptNumber = attemptLock.rows[0]?.attempt_number;
  if (attemptNumber === undefined) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
    };
  }
  const preBroadcastLifecycle =
    await projectedFundingActionBeforeBroadcastInTransaction(client, {
      operationId: input.claim.operationId,
      stepId: input.claim.stepId,
      attemptNumber,
      now: input.now,
    });
  if (
    preBroadcastLifecycle.lifecycle.safety.terminal ||
    !preBroadcastLifecycle.action.actionable
  ) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
    };
  }
  let dependencyApprovalLocked =
    validated.kind !== "deposit" || usesPreexistingAllowance;
  let dependencyApprovalTransactionHash: string | null = null;
  if (validated.kind === "deposit" && !usesPreexistingAllowance) {
    const dependency = await client.query<{
      approval_transaction_hash: string;
      id: string;
    }>(
      `select dependency.id,
              lower(dependency_receipt.evidence ->> 'transactionHash')
                as approval_transaction_hash
         from funding_operation_step_attempts attempt
         join funding_operation_steps step on step.id = attempt.step_id
         join funding_operations operation on operation.id = step.operation_id
         join funding_operation_steps dependency
           on dependency.id = step.depends_on_step_id
          and dependency.operation_id = operation.id
         join funding_step_receipt_observations dependency_receipt
           on dependency_receipt.step_id = dependency.id
          and dependency_receipt.status = 'finalized'
          and dependency_receipt.action_match
          and dependency_receipt.canonical
          and dependency_receipt.evidence ->> 'allowanceExact' = 'true'
          and dependency_receipt.evidence ->> 'singleOperationBundle' = 'true'
          and dependency_receipt.evidence ->> 'transactionHash' ~
                '^0x[0-9a-fA-F]{64}$'
          and dependency_receipt.evidence ->> 'allowanceRaw' = $6
          and dependency_receipt.evidence ->> 'allowanceBlock' =
                dependency_receipt.ledger_height
          and lower(dependency_receipt.evidence ->> 'allowanceBlockHash') =
                lower(dependency_receipt.block_hash)
         join funding_operation_step_attempts dependency_attempt
           on dependency_attempt.id = dependency_receipt.attempt_id
          and dependency_attempt.step_id = dependency.id
        where operation.id = $1::uuid
          and operation.policy_version = $4
          and operation.policy_revision = $5
          and step.id = $2::uuid
          and step.executor_id = $7
          and step.action_validation_result ->> 'relayStepKind' = 'deposit'
          and attempt.id = $3::uuid
          and attempt.outcome = 'started'
          and dependency.executor_id = $7
          and dependency.action_validation_result ->> 'relayStepKind' =
                'approve'
        order by dependency_receipt.observed_at desc
        for update of dependency, dependency_attempt, dependency_receipt
        limit 2`,
      [
        input.claim.operationId,
        input.claim.stepId,
        input.claim.attemptId,
        input.claim.fundingPolicyVersion,
        input.claim.fundingPolicyRevision,
        input.claim.receiptRaw,
        input.profile.profileId,
      ],
    );
    dependencyApprovalLocked = dependency.rowCount === 1;
    dependencyApprovalTransactionHash =
      dependency.rows[0]?.approval_transaction_hash ?? null;
  }
  if (!dependencyApprovalLocked) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
      diagnosticCode: "approval_dependency_missing" as const,
    };
  }
  const scope = await client.query<{
    action_expires_at: Date | null;
    allowance_exact: boolean;
    checked_at: Date;
    cleanup_allowance_raw: string | null;
    cleanup_allowance_revision: string | null;
  }>(
    `select step.action_expires_at,
            $6::boolean as allowance_exact,
            reservation.resolution_evidence ->> 'cleanupAllowanceRaw'
              as cleanup_allowance_raw,
            reservation.cleanup_allowance_revision,
            clock_timestamp() as checked_at
       from funding_operation_step_attempts attempt
       join funding_operation_steps step on step.id = attempt.step_id
       join funding_operations operation on operation.id = step.operation_id
       join telegram_funding_authorization_reservations reservation
         on (
              ($5::boolean = false
               and reservation.funding_operation_id = step.operation_id)
              or
              ($5::boolean = true
               and reservation.cleanup_operation_id = step.operation_id)
            )
        and reservation.authorization_id = $4::uuid
        and reservation.status = case
              when $5::boolean then 'cleanup_required'
              else 'reserved'
            end
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id = reservation.authorization_id
       where step.operation_id = $1::uuid
         and operation.policy_version = $7
         and operation.policy_revision = $8
         and step.id = $2::uuid
         and attempt.id = $3::uuid
         and attempt.outcome = 'started'
         and (
           $5::boolean = true
           or (
             (
               reservation.receive_receipt_id is not null
               and exists (
                 select 1
                   from funding_receive_receipts receive_receipt
                  where receive_receipt.id = reservation.receive_receipt_id
                    and receive_receipt.child_funding_operation_id = operation.id
                    and receive_receipt.id::text =
                          operation.support_metadata ->>
                            'fundingReceiveReceiptId'
                    and receive_receipt.status = 'routing'
                    and receive_receipt.raw_amount = reservation.source_raw
               )
             )
             or (
               reservation.source_trade_intent_id is not null
               and exists (
                 select 1
                   from telegram_trade_intents trade_intent_row
                  where trade_intent_row.id =
                        reservation.source_trade_intent_id
                    and trade_intent_row.user_id = operation.user_id
                    and trade_intent_row.status = 'funding'
                    and trade_intent_row.funding_operation_id = operation.id
                    and trade_intent_row.submit_started_at is null
                    and trade_intent_row.id::text =
                          operation.support_metadata ->>
                            'telegramTradeIntentId'
               )
             )
           )
         )
         and ${RELAY_ALLOWANCE_LANE_HEAD_PREDICATE}
      `,
    [
      input.claim.operationId,
      input.claim.stepId,
      input.claim.attemptId,
      input.claim.authorizationId,
      validated.kind === "cleanup",
      dependencyApprovalLocked,
      input.claim.fundingPolicyVersion,
      input.claim.fundingPolicyRevision,
    ],
  );
  const row = scope.rows[0];
  if (!row)
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
      diagnosticCode: "reservation_lane_missing" as const,
    };
  const residual = row.action_expires_at
    ? row.action_expires_at.getTime() - row.checked_at.getTime()
    : Number.MAX_SAFE_INTEGER;
  if (residual < input.configuration.minimumSequentialTtlMs) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_quote_expired" as const,
    };
  }
  const observed = parseRelayEvmAllowanceObservation(input.observation);
  if (!observed) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
      diagnosticCode: "allowance_observation_missing" as const,
    };
  }
  if (
    validated.kind === "deposit" &&
    !usesPreexistingAllowance &&
    (!input.claim.allowanceMutationBaselineBlock ||
      !/^(0|[1-9][0-9]*)$/u.test(input.claim.allowanceMutationBaselineBlock))
  ) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
      diagnosticCode: "allowance_baseline_missing" as const,
    };
  }
  const observedAllowance = BigInt(observed.raw);
  // A fresh exact approve is safe regardless of the preceding allowance.
  // Its own finalized receipt, rather than historical ownership inference,
  // is the dependency fence for the following deposit.
  if (validated.kind === "approve") return { kind: "allowed" as const };
  // Relay can omit approve when an existing controller allowance already
  // covers this exact deposit. That allowance may be a prior Hunch route or
  // a user-managed allowance: it is never authority by itself. The current
  // route still has its own active reservation and exact policy-bound Relay
  // deposit calldata, so do not invent an approval receipt, require historic
  // ownership provenance, or schedule a zero-cleanup for it.
  if (usesPreexistingAllowance) {
    const expected = BigInt(input.claim.receiptRaw);
    if (observedAllowance < expected) {
      return {
        kind: "hard_invalid" as const,
        reasonCode: "delegated_action_invalid" as const,
        diagnosticCode: "allowance_amount_mismatch" as const,
      };
    }
    return { kind: "allowed" as const };
  }
  const depositAllowanceOwned =
    validated.kind !== "deposit" ||
    (observed.ownershipRevision !== null &&
      observed.lastMutationTransactionHash !== null &&
      dependencyApprovalTransactionHash !== null &&
      observed.lastMutationTransactionHash.toLowerCase() ===
        dependencyApprovalTransactionHash);
  const cleanupState =
    validated.kind === "cleanup"
      ? classifyRelayCleanupAllowance({
          currentRaw: observed.raw,
          currentRevision: observed.ownershipRevision ?? "",
          ownedRaw: row.cleanup_allowance_raw,
          ownedRevision: row.cleanup_allowance_revision,
          actionOwnedRaw: input.claim.actionValidationResult.ownedAllowanceRaw,
          actionOwnedRevision:
            input.claim.actionValidationResult.allowanceRevision,
        })
      : null;
  // Cleanup can revoke only the exact residual owned by this operation.
  if (cleanupState === "already_zero") {
    const ownedAllowanceObservedBlock =
      typeof input.claim.actionValidationResult.allowanceObservedBlock ===
        "string" &&
      /^(0|[1-9][0-9]*)$/u.test(
        input.claim.actionValidationResult.allowanceObservedBlock,
      )
        ? BigInt(input.claim.actionValidationResult.allowanceObservedBlock)
        : null;
    if (
      observed.finality !== "finalized" ||
      ownedAllowanceObservedBlock == null ||
      BigInt(observed.blockNumber) < ownedAllowanceObservedBlock
    ) {
      return {
        kind: "soft_paused" as const,
        reasonCode: "delegated_profile_unavailable" as const,
      };
    }
    return { kind: "already_satisfied" as const };
  }
  const expected = BigInt(input.claim.receiptRaw);
  if (validated.kind !== "cleanup" && observedAllowance !== expected) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
      diagnosticCode: "allowance_amount_mismatch" as const,
    };
  }
  if (
    cleanupState === "foreign_drift" ||
    (validated.kind === "deposit" && !depositAllowanceOwned)
  ) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
      diagnosticCode: "allowance_owner_tx_mismatch" as const,
    };
  }
  if (validated.kind === "deposit" && !row.allowance_exact) {
    return {
      kind: "hard_invalid" as const,
      reasonCode: "delegated_action_invalid" as const,
      diagnosticCode: "approval_dependency_missing" as const,
    };
  }
  return { kind: "allowed" as const };
}

type RelayCleanupContext =
  | "approval_exhausted"
  | "pre_deposit_failure"
  | "post_deposit";

type RelayPostDepositEvidence = Readonly<{
  parentOperationId: string;
  segmentId: string;
  depositReceiptId: string;
  depositAttemptId: string;
  depositTransactionHash: string;
  depositEventIndex: string;
  depositObservedAt: Date;
  depositBlock: string;
  depositBlockHash: string;
  expectedRaw: string;
  walletAddress: string;
}>;

/**
 * A finalized, action-matched Relay deposit receipt is the source-debit proof.
 * It must not wait for a later allowance read or cleanup transaction: allowance
 * is authority for the deposit, not evidence that the deposited token moved.
 */
async function allocateFinalizedRelaySourceDebitInTransaction(
  client: PoolClient,
  input: Readonly<{
    now: Date;
    operationId?: string;
    profile: RelayEvmFundingProfileSpec;
  }>,
): Promise<boolean> {
  const candidates = await client.query<{
    authorizationId: string;
    depositReceiptId: string;
    depositStepId: string;
    parentOperationId: string;
    reservationId: string;
    segmentId: string;
    userId: string;
  }>({
    name: "funding-relay-allocate-finalized-source-debit-v1",
    text: `select operation.id as "parentOperationId",
            segment.id as "segmentId",
            deposit_step.id as "depositStepId",
            deposit_receipt.id as "depositReceiptId",
            reservation.id as "reservationId",
            funding_authorization.id::text as "authorizationId",
            funding_authorization.user_id::text as "userId"
       from funding_operation_steps deposit_step
       join funding_step_receipt_observations deposit_receipt
         on deposit_receipt.step_id = deposit_step.id
        and deposit_receipt.status = 'finalized'
        and deposit_receipt.action_match
        and deposit_receipt.canonical
        and deposit_receipt.evidence ->> 'singleOperationBundle' = 'true'
       join funding_operations operation on operation.id = deposit_step.operation_id
       join funding_operation_segments segment
         on segment.operation_id = operation.id and segment.ordinal = 0
       join telegram_funding_authorization_reservations reservation
         on reservation.funding_operation_id = operation.id
        and reservation.status = 'reserved'
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id::text =
              operation.support_metadata ->> 'fundingAuthorizationId'
      where deposit_step.executor_id = $1
        and ($2::uuid is null or operation.id = $2::uuid)
        and deposit_receipt.evidence ->> 'attributedSourceRaw' =
              reservation.source_raw::text
        and deposit_receipt.block_hash is not null
        and deposit_receipt.evidence ->> 'sourceDebitEventIndex' is not null
        and deposit_receipt.evidence ->> 'transactionHash' is not null
        and not exists (
          select 1
            from funding_observations source_debit
           where source_debit.operation_id = operation.id
             and source_debit.kind = 'source_debit'
             and source_debit.canonical
             and source_debit.finality_status = 'finalized'
        )
      order by deposit_receipt.observed_at
      limit 1`,
    values: [input.profile.profileId, input.operationId ?? null],
  });
  const candidate = candidates.rows[0];
  if (
    !candidate ||
    !(await tryLockFundingAuthorizationReservationScope(client, {
      authorizationId: candidate.authorizationId,
      userId: candidate.userId,
    }))
  ) {
    return false;
  }
  // preBroadcastRelay owns the allowance lane before touching operation rows.
  // Follow that same total order, then lock each mutable funding row with a
  // fresh statement and revalidate the unlocked discovery candidate.
  const operation = await client.query<{ funding_authorization_id: string }>(
    `select support_metadata ->> 'fundingAuthorizationId'
              as funding_authorization_id
       from funding_operations
      where id = $1::uuid and user_id = $2::uuid
      for update`,
    [candidate.parentOperationId, candidate.userId],
  );
  if (
    operation.rows[0]?.funding_authorization_id !== candidate.authorizationId
  ) {
    return false;
  }
  const step = await client.query(
    `select id
       from funding_operation_steps
      where id = $1::uuid
        and operation_id = $2::uuid
        and executor_id = $3
      for update`,
    [
      candidate.depositStepId,
      candidate.parentOperationId,
      input.profile.profileId,
    ],
  );
  if (step.rowCount !== 1) return false;
  const receipt = await client.query<{
    depositAttemptId: string;
    depositBlock: string;
    depositBlockHash: string;
    depositEventIndex: string;
    depositObservedAt: Date;
    depositTransactionHash: string;
    expectedRaw: string;
  }>(
    `select attempt_id as "depositAttemptId",
            ledger_height as "depositBlock",
            block_hash as "depositBlockHash",
            observed_at as "depositObservedAt",
            evidence ->> 'transactionHash' as "depositTransactionHash",
            evidence ->> 'sourceDebitEventIndex' as "depositEventIndex",
            evidence ->> 'attributedSourceRaw' as "expectedRaw"
       from funding_step_receipt_observations
      where id = $1::uuid
        and step_id = $2::uuid
        and status = 'finalized'
        and action_match
        and canonical
        and evidence ->> 'singleOperationBundle' = 'true'
        and block_hash is not null
        and evidence ->> 'sourceDebitEventIndex' is not null
        and evidence ->> 'transactionHash' is not null
      for update`,
    [candidate.depositReceiptId, candidate.depositStepId],
  );
  const receiptEvidence = receipt.rows[0];
  if (!receiptEvidence) return false;
  const reservation = await client.query<{
    expectedRaw: string;
    walletAddress: string;
  }>(
    `select reservation.source_raw::text as "expectedRaw",
            funding_authorization.wallet_address as "walletAddress"
       from telegram_funding_authorization_reservations reservation
       join telegram_funding_authorizations funding_authorization
         on funding_authorization.id = reservation.authorization_id
      where reservation.id = $1::uuid
        and reservation.funding_operation_id = $2::uuid
        and reservation.authorization_id = $3::uuid
        and reservation.status = 'reserved'
        and funding_authorization.user_id = $4::uuid
      for update of reservation`,
    [
      candidate.reservationId,
      candidate.parentOperationId,
      candidate.authorizationId,
      candidate.userId,
    ],
  );
  const reservationEvidence = reservation.rows[0];
  if (
    !reservationEvidence ||
    reservationEvidence.expectedRaw !== receiptEvidence.expectedRaw
  ) {
    return false;
  }
  const revalidated = await client.query(
    `select segment.id
       from funding_operation_segments segment
      where segment.id = $1::uuid
        and segment.operation_id = $2::uuid
        and segment.ordinal = 0
        and not exists (
          select 1
            from funding_observations source_debit
           where source_debit.operation_id = $2::uuid
             and source_debit.kind = 'source_debit'
             and source_debit.canonical
             and source_debit.finality_status = 'finalized'
        )`,
    [candidate.segmentId, candidate.parentOperationId],
  );
  if (revalidated.rowCount !== 1) return false;
  const evidence: RelayPostDepositEvidence = {
    parentOperationId: candidate.parentOperationId,
    segmentId: candidate.segmentId,
    depositReceiptId: candidate.depositReceiptId,
    ...receiptEvidence,
    ...reservationEvidence,
  };
  await allocateFundingObservationInTransaction(client, {
    operationId: evidence.parentOperationId,
    segmentId: evidence.segmentId,
    kind: "source_debit",
    networkId: input.profile.sourceAsset.networkId,
    assetId: input.profile.sourceAsset.assetId,
    assetDecimals: input.profile.sourceAsset.decimals,
    txHash: evidence.depositTransactionHash,
    eventIndex: evidence.depositEventIndex,
    fromAddress: evidence.walletAddress,
    toAddress: RELAY_DEPOSITORY_V2,
    rawAmount: evidence.expectedRaw,
    observedAt: evidence.depositObservedAt,
    ledgerHeight: evidence.depositBlock,
    blockHash: evidence.depositBlockHash,
    finalityStatus: "finalized",
    finalizedAt: input.now,
    metadata: {
      relayDelegatedProfile: input.profile.profileId,
      receiptAttemptId: evidence.depositAttemptId,
    },
  });
  await client.query(
    `update funding_step_receipt_observations
        set evidence = evidence || jsonb_build_object(
              'sourceDebitRecorded', true,
              'sourceDebitRecordedAt', $2::timestamptz
            ),
            updated_at = $2
      where id = $1::uuid and status = 'finalized'`,
    [evidence.depositReceiptId, input.now],
  );
  // The receipt established that a source debit must be observed; the exact
  // canonical debit above now satisfies that fact. Recompute the projection
  // in the same transaction rather than leaving a stale reconcile cache for
  // the next worker pass.
  await reduceFundingOperationInTransaction(client, {
    operationId: evidence.parentOperationId,
    now: input.now,
  });
  return true;
}

/**
 * Reconciliation jobs must record the exact canonical Relay debit before the
 * generic reducer evaluates readiness. The executor's opportunistic batch
 * maintenance remains useful, but it is not a liveness mechanism for an
 * already-finalized operation.
 */
export async function recordFinalizedRelaySourceDebitForOperation(
  pool: Pool,
  input: Readonly<{
    now: Date;
    operationId: string;
    profile: RelayEvmFundingProfileSpec;
  }>,
): Promise<boolean> {
  return tx(pool, (client) =>
    allocateFinalizedRelaySourceDebitInTransaction(client, input),
  );
}

async function allocateRelayPostDepositSourceDebitInTransaction(
  client: PoolClient,
  input: Readonly<{
    evidence: RelayPostDepositEvidence;
    allowance: RelayEvmAllowanceObservation;
    cleanupOperationId: string;
    cleanupReceiptId?: string;
    now: Date;
    profile: RelayEvmFundingProfileSpec;
  }>,
): Promise<void> {
  await allocateFundingObservationInTransaction(client, {
    operationId: input.evidence.parentOperationId,
    segmentId: input.evidence.segmentId,
    kind: "source_debit",
    networkId: input.profile.sourceAsset.networkId,
    assetId: input.profile.sourceAsset.assetId,
    assetDecimals: input.profile.sourceAsset.decimals,
    txHash: input.evidence.depositTransactionHash,
    eventIndex: input.evidence.depositEventIndex,
    fromAddress: input.evidence.walletAddress,
    toAddress: RELAY_DEPOSITORY_V2,
    rawAmount: input.evidence.expectedRaw,
    observedAt: input.evidence.depositObservedAt,
    ledgerHeight: input.evidence.depositBlock,
    blockHash: input.evidence.depositBlockHash,
    finalityStatus: "finalized",
    finalizedAt: input.now,
    metadata: {
      ...(input.cleanupReceiptId
        ? { allowanceCleanupReceiptId: input.cleanupReceiptId }
        : { allowanceCleanupAlreadyZero: true }),
      allowanceCleanupOperationId: input.cleanupOperationId,
      relayDelegatedProfile: input.profile.profileId,
      receiptAttemptId: input.evidence.depositAttemptId,
    },
  });
  const receiptIds = [
    input.evidence.depositReceiptId,
    ...(input.cleanupReceiptId ? [input.cleanupReceiptId] : []),
  ];
  await client.query(
    `update funding_step_receipt_observations
        set evidence = evidence || $2::jsonb,
            observed_at = greatest(observed_at, $3),
            updated_at = $3
      where id = any($1::uuid[])`,
    [
      receiptIds,
      {
        allowanceZero: true,
        allowanceRaw: "0",
        allowanceBlock: input.allowance.blockNumber,
        allowanceBlockHash: input.allowance.blockHash,
        allowanceObservationRevision: input.allowance.revision,
        cleanupOperationId: input.cleanupOperationId,
        ...(input.cleanupReceiptId
          ? { cleanupReceiptId: input.cleanupReceiptId }
          : { allowanceAlreadyZero: true }),
      },
      input.now,
    ],
  );
}

async function completeRelayCleanupFromCanonicalZeroInTransaction(
  client: PoolClient,
  input: Readonly<{
    actionId: string;
    evidence: JsonRecord;
    now: Date;
    operationId: string;
  }>,
): Promise<void> {
  // Attempt reporting may materialize a fresh lifecycle cache immediately
  // before this terminal fact. Read the version under the existing operation
  // lock at the point of mutation rather than carrying it across that write.
  const versionResult = await client.query<{ version: string | number }>(
    `select version
       from funding_operations
      where id = $1::uuid
      for update`,
    [input.operationId],
  );
  const operation = versionResult.rows[0];
  if (!operation) {
    throw new Error("Relay cleanup operation disappeared before completion");
  }
  await writeFundingOperationSupportFactsInTransaction(client, {
    operationId: input.operationId,
    expectedVersion: Number(operation.version),
    supportMetadataPatch: {
      lifecycleTerminalCompletion: {
        code: "relay_allowance_cleanup_completed",
        decidedAt: input.now.toISOString(),
        actionId: input.actionId,
      },
      ...input.evidence,
    },
    now: input.now,
  });
  await reduceFundingOperationInTransaction(client, {
    operationId: input.operationId,
    now: input.now,
  });
}

async function terminalizeRelayParentAfterCleanup(
  client: PoolClient,
  input: Readonly<{
    cleanupContext: RelayCleanupContext;
    parentOperationId: string;
    now: Date;
    evidence: JsonRecord;
    profile: RelayEvmFundingProfileSpec;
  }>,
): Promise<void> {
  if (input.cleanupContext === "post_deposit") return;
  const { rows } = await client.query<{
    approval_step_id: string;
    deposit_step_id: string;
    operation_version: string | number;
  }>(
    `select operation.version as operation_version,
            approval_step.id as approval_step_id,
            deposit_step.id as deposit_step_id
       from funding_operations operation
       join funding_operation_steps approval_step
         on approval_step.operation_id = operation.id
        and approval_step.executor_id = $2
        and approval_step.action_validation_result ->> 'relayStepKind' =
              'approve'
       join funding_operation_steps deposit_step
         on deposit_step.operation_id = operation.id
        and deposit_step.executor_id = $2
        and deposit_step.action_validation_result ->> 'relayStepKind' =
              'deposit'
      where operation.id = $1::uuid
      for update of operation, approval_step, deposit_step`,
    [input.parentOperationId, input.profile.profileId],
  );
  const row = rows[0];
  if (!row) return;
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    {
      operationId: input.parentOperationId,
      now: input.now,
    },
  );
  if (!facts || deriveFundingLifecycle(facts).safety.terminal) return;
  const approvalExhausted = input.cleanupContext === "approval_exhausted";
  await writeFundingOperationSupportFactsInTransaction(client, {
    operationId: input.parentOperationId,
    expectedVersion: Number(row.operation_version),
    supportMetadataPatch: {
      lifecycleTerminalFailure: {
        code: approvalExhausted
          ? "relay_approval_exhausted"
          : "relay_deposit_failed",
        decidedAt: input.now.toISOString(),
        actionId: approvalExhausted
          ? row.approval_step_id
          : row.deposit_step_id,
      },
      ...input.evidence,
    },
    now: input.now,
  });
  await reduceFundingOperationInTransaction(client, {
    operationId: input.parentOperationId,
    now: input.now,
  });
}

async function terminalizeCompletedRelayCleanupParent(
  client: PoolClient,
  now: Date,
  profile: RelayEvmFundingProfileSpec,
): Promise<void> {
  const { rows } = await client.query<{
    cleanup_context: Exclude<RelayCleanupContext, "post_deposit">;
    cleanup_operation_id: string;
    parent_operation_id: string;
    resolution_evidence: JsonRecord;
  }>({
    name: "funding-relay-terminalize-cleaned-parent-v1",
    text: `select cleanup.id as cleanup_operation_id,
            parent.id as parent_operation_id,
            cleanup_step.action_validation_result ->> 'cleanupContext'
              as cleanup_context,
            reservation.resolution_evidence
       from telegram_funding_authorization_reservations reservation
       join funding_operations cleanup
         on cleanup.id = reservation.cleanup_operation_id
       join funding_operation_steps cleanup_step
         on cleanup_step.operation_id = cleanup.id
        and cleanup_step.executor_id = $1
        and cleanup_step.action_validation_result ->> 'relayStepKind' =
              'cleanup'
        and cleanup_step.action_validation_result ->> 'cleanupContext' in (
              'approval_exhausted', 'pre_deposit_failure'
            )
       join funding_operations parent
         on parent.id = reservation.funding_operation_id
      where reservation.status = 'cleaned'
        and reservation.resolved_at is not null
      order by reservation.resolved_at, reservation.id
      limit 1`,
    values: [profile.profileId],
  });
  const row = rows[0];
  if (!row) return;
  await terminalizeRelayParentAfterCleanup(client, {
    cleanupContext: row.cleanup_context,
    parentOperationId: row.parent_operation_id,
    now,
    profile,
    evidence: {
      ...row.resolution_evidence,
      cleanupOperationId: row.cleanup_operation_id,
      cleanupParentRepairCompletedAt: now.toISOString(),
    },
  });
}

async function finalizeRelayAlreadySatisfiedInTransaction(
  client: PoolClient,
  input: Readonly<{
    claim: DelegatedFundingExecutionClaim;
    now: Date;
    observation?: JsonRecord;
    profile: RelayEvmFundingProfileSpec;
  }>,
): Promise<void> {
  const observed = parseRelayEvmAllowanceObservation(input.observation);
  const validated = validateRelayDelegatedEvmAction({
    action: input.claim.action,
    actionValidationResult: input.claim.actionValidationResult,
    expectedRaw: input.claim.receiptRaw,
    walletAddress: input.claim.walletAddress,
    walletId: input.claim.actionWalletId,
    profile: input.profile,
  });
  if (
    validated.kind !== "cleanup" ||
    !observed ||
    observed.raw !== "0" ||
    observed.finality !== "finalized"
  ) {
    throw new Error(
      "Relay already-satisfied action is not an anchored zero cleanup",
    );
  }
  const scope = await client.query<{
    cleanup_context: RelayCleanupContext;
    cleanup_allowance_raw: string;
    cleanup_allowance_revision: string;
    cleanup_allowance_observed_block: string;
    operation_version: string | number;
    reservation_id: string;
    parent_operation_id: string;
  }>(
    `select reservation.id as reservation_id,
            reservation.cleanup_allowance_revision,
            reservation.resolution_evidence ->> 'cleanupAllowanceRaw'
              as cleanup_allowance_raw,
            reservation.resolution_evidence ->> 'cleanupAllowanceObservedBlock'
              as cleanup_allowance_observed_block,
            operation.version as operation_version,
            reservation.funding_operation_id as parent_operation_id,
            step.action_validation_result ->> 'cleanupContext'
              as cleanup_context
       from funding_operation_step_attempts attempt
       join funding_operation_steps step on step.id = attempt.step_id
       join funding_operations operation on operation.id = step.operation_id
       join telegram_funding_authorization_reservations reservation
         on reservation.cleanup_operation_id = operation.id
        and reservation.status = 'cleanup_required'
       where operation.id = $1::uuid
         and step.id = $2::uuid
         and attempt.id = $3::uuid
         and attempt.outcome = 'started'
         and step.action_validation_result ->> 'relayStepKind' = 'cleanup'
         and step.action_validation_result ->> 'allowanceRevision' =
               reservation.cleanup_allowance_revision
         and step.action_validation_result ->> 'ownedAllowanceRaw' =
               reservation.resolution_evidence ->> 'cleanupAllowanceRaw'
         and step.action_validation_result ->> 'allowanceObservedBlock' =
               reservation.resolution_evidence ->> 'cleanupAllowanceObservedBlock'
         and step.action_validation_result ->> 'cleanupContext' in (
               'approval_exhausted', 'pre_deposit_failure', 'post_deposit'
             )
       for update of attempt, step, operation, reservation`,
    [input.claim.operationId, input.claim.stepId, input.claim.attemptId],
  );
  const row = scope.rows[0];
  if (!row) throw new Error("Relay zero cleanup binding changed");
  const lifecycleFacts =
    await loadFundingLifecycleFactsForOperationInTransaction(client, {
      operationId: input.claim.operationId,
      now: input.now,
    });
  const lifecycle = lifecycleFacts
    ? deriveFundingLifecycle(lifecycleFacts)
    : null;
  const action = lifecycle?.actions.find(
    (candidate) => candidate.actionId === input.claim.stepId,
  );
  // This is an attempt conclusion, not a fresh action admission. Its own
  // started attempt makes the current projection recovery_required; accepting
  // precisely that state preserves an expiry race while terminal/cancelled or
  // conflicting facts still reject the conclusion.
  if (lifecycle?.safety.terminal || action?.state !== "recovery_required") {
    throw new Error("Relay zero cleanup lifecycle changed");
  }
  if (
    !/^(0|[1-9][0-9]*)$/u.test(row.cleanup_allowance_observed_block) ||
    BigInt(observed.blockNumber) < BigInt(row.cleanup_allowance_observed_block)
  ) {
    throw new Error("Relay finalized zero predates the owned allowance");
  }
  let postDepositEvidence: RelayPostDepositEvidence | null = null;
  if (row.cleanup_context === "post_deposit") {
    const postDeposit = await client.query<{
      parent_operation_id: string;
      segment_id: string;
      deposit_receipt_id: string;
      deposit_attempt_id: string;
      deposit_transaction_hash: string;
      deposit_event_index: string;
      deposit_observed_at: Date;
      deposit_block: string;
      deposit_block_hash: string;
      expected_raw: string;
      wallet_address: string;
    }>(
      `select parent.id as parent_operation_id,
              segment.id as segment_id,
              deposit_receipt.id as deposit_receipt_id,
              deposit_receipt.attempt_id as deposit_attempt_id,
              deposit_receipt.evidence ->> 'transactionHash'
                as deposit_transaction_hash,
              deposit_receipt.evidence ->> 'sourceDebitEventIndex'
                as deposit_event_index,
              deposit_receipt.observed_at as deposit_observed_at,
              deposit_receipt.ledger_height as deposit_block,
              deposit_receipt.block_hash as deposit_block_hash,
              reservation.source_raw::text as expected_raw,
              funding_authorization.wallet_address
         from funding_operations parent
         join telegram_funding_authorization_reservations reservation
           on reservation.id = $3::uuid
          and reservation.funding_operation_id = parent.id
         join funding_operation_segments segment
           on segment.operation_id = parent.id and segment.ordinal = 0
         join funding_operation_steps deposit_step
           on deposit_step.operation_id = parent.id
          and deposit_step.executor_id = $2
          and deposit_step.action_validation_result ->> 'relayStepKind' =
                'deposit'
         join funding_step_receipt_observations deposit_receipt
           on deposit_receipt.step_id = deposit_step.id
          and deposit_receipt.status = 'finalized'
          and deposit_receipt.action_match
          and deposit_receipt.canonical
          and deposit_receipt.evidence ->> 'singleOperationBundle' = 'true'
          and deposit_receipt.evidence ->> 'attributedSourceRaw' =
                reservation.source_raw::text
          and deposit_receipt.block_hash is not null
          and deposit_receipt.evidence ->> 'sourceDebitEventIndex' is not null
          and deposit_receipt.evidence ->> 'transactionHash' is not null
         join telegram_funding_authorizations funding_authorization
           on funding_authorization.id::text =
                parent.support_metadata ->> 'fundingAuthorizationId'
        where parent.id = $1::uuid
        order by deposit_receipt.observed_at desc
        for update of parent, deposit_step, deposit_receipt
        limit 1`,
      [row.parent_operation_id, input.profile.profileId, row.reservation_id],
    );
    const evidence = postDeposit.rows[0];
    if (!evidence) {
      throw new Error(
        "Relay already-zero post-deposit cleanup evidence is incomplete",
      );
    }
    postDepositEvidence = {
      parentOperationId: evidence.parent_operation_id,
      segmentId: evidence.segment_id,
      depositReceiptId: evidence.deposit_receipt_id,
      depositAttemptId: evidence.deposit_attempt_id,
      depositTransactionHash: evidence.deposit_transaction_hash,
      depositEventIndex: evidence.deposit_event_index,
      depositObservedAt: evidence.deposit_observed_at,
      depositBlock: evidence.deposit_block,
      depositBlockHash: evidence.deposit_block_hash,
      expectedRaw: evidence.expected_raw,
      walletAddress: evidence.wallet_address,
    };
  }
  await finishFundingStepAttemptForUserInTransaction(client, {
    userId: input.claim.userId,
    operationId: input.claim.operationId,
    stepId: input.claim.stepId,
    attemptId: input.claim.attemptId,
    outcome: "succeeded",
    broadcastMayHaveOccurred: false,
    referenceKind: null,
    receiptRefCiphertext: null,
    receiptRefLookupHmac: null,
    lookupKeyVersion: null,
    actualCosts: {
      allowanceAlreadyZero: true,
      allowanceBlock: observed.blockNumber,
      allowanceBlockHash: observed.blockHash,
      allowanceObservationRevision: observed.revision,
      ownedAllowanceRaw: row.cleanup_allowance_raw,
      ownedAllowanceRevision: row.cleanup_allowance_revision,
    },
    now: input.now,
  });
  if (postDepositEvidence) {
    await allocateRelayPostDepositSourceDebitInTransaction(client, {
      evidence: postDepositEvidence,
      allowance: observed,
      cleanupOperationId: input.claim.operationId,
      now: input.now,
      profile: input.profile,
    });
  }
  await completeRelayCleanupFromCanonicalZeroInTransaction(client, {
    operationId: input.claim.operationId,
    actionId: input.claim.stepId,
    evidence: {
      allowanceAlreadyZero: true,
      allowanceZeroBlock: observed.blockNumber,
      allowanceZeroBlockHash: observed.blockHash,
      allowanceZeroRevision: observed.revision,
    },
    now: input.now,
  });
  await client.query(
    `update telegram_funding_authorization_reservations
        set status = 'cleaned',
            resolved_at = $2,
            resolution_evidence = resolution_evidence || jsonb_build_object(
              'allowanceAlreadyZero', true,
              'allowanceZeroBlock', $3::text,
              'allowanceZeroBlockHash', $4::text,
              'allowanceZeroRevision', $5::text
            ),
            updated_at = $2
      where id = $1::uuid and status = 'cleanup_required'`,
    [
      row.reservation_id,
      input.now,
      observed.blockNumber,
      observed.blockHash,
      observed.revision,
    ],
  );
  await terminalizeRelayParentAfterCleanup(client, {
    cleanupContext: row.cleanup_context,
    parentOperationId: row.parent_operation_id,
    now: input.now,
    profile: input.profile,
    evidence: {
      allowanceAlreadyZero: true,
      allowanceZeroBlock: observed.blockNumber,
      allowanceZeroBlockHash: observed.blockHash,
      allowanceZeroRevision: observed.revision,
      cleanupOperationId: input.claim.operationId,
    },
  });
}

async function finalizeRelayHardInvalidInTransaction(
  client: PoolClient,
  input: Readonly<{
    claim: DelegatedFundingExecutionClaim;
    now: Date;
    reasonCode: string;
    observation?: JsonRecord;
    profile: RelayEvmFundingProfileSpec;
  }>,
): Promise<void> {
  const validated = validateRelayDelegatedEvmAction({
    action: input.claim.action,
    actionValidationResult: input.claim.actionValidationResult,
    expectedRaw: input.claim.receiptRaw,
    walletAddress: input.claim.walletAddress,
    walletId: input.claim.actionWalletId,
    profile: input.profile,
  });
  const observed = parseRelayEvmAllowanceObservation(input.observation);
  if (!observed) return;
  if (validated.kind === "deposit") {
    const ownership = await client.query<{
      approval_receipt_id: string;
      approval_transaction_hash: string;
      receipt_raw: string;
    }>(
      `select approval_receipt.id as approval_receipt_id,
              lower(approval_receipt.evidence ->> 'transactionHash')
                as approval_transaction_hash,
              reservation.source_raw::text as receipt_raw
         from funding_operation_steps deposit_step
         join funding_operations operation
           on operation.id = deposit_step.operation_id
         join funding_operation_steps approval_step
           on approval_step.id = deposit_step.depends_on_step_id
          and approval_step.operation_id = operation.id
         join funding_step_receipt_observations approval_receipt
           on approval_receipt.step_id = approval_step.id
          and approval_receipt.status = 'finalized'
          and approval_receipt.action_match
          and approval_receipt.canonical
          and approval_receipt.evidence ->> 'allowanceExact' = 'true'
          and approval_receipt.evidence ->> 'singleOperationBundle' = 'true'
         join telegram_funding_authorization_reservations reservation
           on reservation.funding_operation_id = operation.id
          and reservation.status = 'reserved'
        where operation.id = $1::uuid
          and deposit_step.id = $2::uuid
        order by approval_receipt.observed_at desc
        for update of operation, deposit_step, approval_step,
                      approval_receipt, reservation
        limit 1`,
      [input.claim.operationId, input.claim.stepId],
    );
    const row = ownership.rows[0];
    const foreignSameValueMutation =
      row !== undefined &&
      observed.raw === row.receipt_raw &&
      (observed.ownershipRevision === null ||
        observed.lastMutationTransactionHash === null ||
        observed.lastMutationTransactionHash.toLowerCase() !==
          row.approval_transaction_hash);
    if (!row || !foreignSameValueMutation) return;
    await client.query(
      `update funding_step_receipt_observations
          set evidence = evidence || jsonb_build_object(
                'allowanceOwnershipRejected', true,
                'lastAllowanceMutationTransactionHash', $2::text
              ),
              updated_at = $3
        where id = $1::uuid and status = 'finalized'`,
      [
        row.approval_receipt_id,
        observed.lastMutationTransactionHash,
        input.now,
      ],
    );
    await retireRelayPreDepositRouteInTransaction(client, {
      errorCode: "relay_allowance_ownership_changed",
      operationId: input.claim.operationId,
      observed,
      now: input.now,
      reason: "foreign_allowance_ownership",
    });
    return;
  }
  if (validated.kind !== "cleanup") return;
  const ownedRaw = input.claim.actionValidationResult.ownedAllowanceRaw;
  const ownedRevision = input.claim.actionValidationResult.allowanceRevision;
  if (typeof ownedRaw !== "string" || typeof ownedRevision !== "string") {
    return;
  }
  const cleanupState = classifyRelayCleanupAllowance({
    currentRaw: observed.raw,
    currentRevision: observed.ownershipRevision ?? "",
    ownedRaw,
    ownedRevision,
    actionOwnedRaw: ownedRaw,
    actionOwnedRevision: ownedRevision,
  });
  if (cleanupState !== "foreign_drift") return;
  const { rows } = await client.query<{
    cleanup_version: string | number;
    parent_operation_id: string;
    parent_version: string | number;
  }>(
    `select cleanup.version as cleanup_version,
            parent.id as parent_operation_id,
            parent.version as parent_version
       from telegram_funding_authorization_reservations reservation
       join funding_operations cleanup
         on cleanup.id = reservation.cleanup_operation_id
       join funding_operations parent
         on parent.id = reservation.funding_operation_id
      where cleanup.id = $1::uuid
        and reservation.status = 'cleanup_required'
      for update of cleanup, parent, reservation`,
    [input.claim.operationId],
  );
  const row = rows[0];
  if (!row) return;
  const recoveryFact = {
    code: "relay_cleanup_foreign_allowance_drift",
    requestedAt: input.now.toISOString(),
  };
  await writeFundingOperationSupportFactsInTransaction(client, {
    operationId: input.claim.operationId,
    expectedVersion: Number(row.cleanup_version),
    supportMetadataPatch: {
      lifecycleManualRecovery: recoveryFact,
      observedAllowanceRaw: observed.raw,
      observedAllowanceRevision: observed.revision,
      ownedAllowanceRaw: ownedRaw,
      ownedAllowanceRevision: ownedRevision,
    },
    now: input.now,
  });
  await writeFundingOperationSupportFactsInTransaction(client, {
    operationId: row.parent_operation_id,
    expectedVersion: Number(row.parent_version),
    supportMetadataPatch: {
      lifecycleManualRecovery: recoveryFact,
      cleanupOperationId: input.claim.operationId,
      observedAllowanceRaw: observed.raw,
      observedAllowanceRevision: observed.revision,
    },
    now: input.now,
  });
  await reduceFundingOperationInTransaction(client, {
    operationId: input.claim.operationId,
    now: input.now,
  });
  await reduceFundingOperationInTransaction(client, {
    operationId: row.parent_operation_id,
    now: input.now,
  });
}

export function createRelayEvmDelegatedFundingProfile(
  input: Readonly<{
    configuration?: RelayEvmExecutionConfiguration;
    driver: DelegatedFundingNetworkDriver;
    allowanceReader?: RelayEvmAllowanceReader;
    profile?: RelayEvmFundingProfileSpec;
  }>,
): DelegatedFundingRuntimeProfile {
  const configuration =
    input.configuration ?? loadRelayEvmExecutionConfiguration();
  const profile =
    input.profile ??
    RELAY_EVM_FUNDING_PROFILE_SPECS[TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID];
  if (!profile) throw new Error("Relay EVM funding profile is unavailable");
  const allowance =
    input.allowanceReader ??
    ((readInput) => readRelayEvmAllowance(profile, readInput));
  return {
    profileId: profile.profileId,
    controlPlaneDecision: () => ({ kind: "allowed" }),
    rejectInvalidInTransaction: async () => null,
    claimInTransaction: (client, claimInput) =>
      claimRelay(client, { ...claimInput, configuration, profile }),
    recoverInTransaction: (client, recoverInput) =>
      recoverRelay(client, { ...recoverInput, profile }),
    observeBeforeClaim: (pool, input) =>
      observeRelayPostcondition(pool, allowance, input.now, profile),
    observePreBroadcast: (claim) =>
      allowance({
        owner: claim.walletAddress,
        blockNumber: null,
        finality:
          claim.actionValidationResult.relayStepKind === "cleanup"
            ? "finalized"
            : "latest",
        mutationBaselineBlock:
          claim.allowanceMutationBaselineBlock ??
          (typeof claim.actionValidationResult
            .allowanceMutationBaselineBlock === "string"
            ? claim.actionValidationResult.allowanceMutationBaselineBlock
            : null),
      }),
    preBroadcastDecisionInTransaction: (client, boundaryInput) =>
      preBroadcastRelay(client, { ...boundaryInput, configuration, profile }),
    finalizeAlreadySatisfiedInTransaction: (client, finalizeInput) =>
      finalizeRelayAlreadySatisfiedInTransaction(client, {
        ...finalizeInput,
        profile,
      }),
    finalizeHardInvalidInTransaction: (client, finalizeInput) =>
      finalizeRelayHardInvalidInTransaction(client, {
        ...finalizeInput,
        profile,
      }),
    driver: input.driver,
    validateSubmittedReference: (reference) =>
      /^0x[0-9a-f]{64}$/iu.test(reference),
  };
}
