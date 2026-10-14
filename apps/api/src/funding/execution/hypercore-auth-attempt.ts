import type { PoolClient } from "@hunch/infra";
import type { WalletExecutionProfile } from "../domain/types.js";
import { FundingPersistenceError } from "../persistence/funding-operation-repository.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import { deriveFundingLifecycleBeforeActionBroadcast } from "../lifecycle/funding-lifecycle-projector.js";
import { loadValidatedHyperliquidFundingPair } from "./hyperliquid-nonce-claims.js";
import {
  nativeFundingSignedRequest,
  nativeFundingActionReference,
} from "./hypercore-signed-request.js";
import type { FundingTransactionReferenceCodec } from "./transaction-reference-codec.js";
import {
  parseNativeFundingSubmission,
  type NativeFundingSubmission,
} from "./hypercore-submission-contract.js";
import { lockFundingControllerWallet } from "./funding-controller-wallet-lock.js";
import type { FundingControlPlaneSnapshot } from "../policies/funding-policy-sidecar.js";
import { withdrawalBindingMatches } from "../domain/withdrawal-binding.js";
import { canonicalJsonEqual } from "../persistence/canonical.js";
import { sameAccountAddress, sameAsset } from "../domain/asset-identity.js";
import { resolveWithdrawalDestination } from "./withdrawal-destination-runtime.js";
import { validatedExternalRecipientSchema } from "../domain/schemas.js";
import type { ResolvedExternalRecipient } from "../domain/types.js";

/** Reuse the common encrypted-recipient contract, not a second allowlist. */
export function assertNativeFundingRecipient(input: {
  userId: string;
  recipient: ResolvedExternalRecipient;
  destinationTarget: unknown;
  actionPayload: Record<string, unknown>;
}): void {
  const target = input.destinationTarget as {
    kind?: unknown;
    recipient?: unknown;
  } | null;
  const frozen = validatedExternalRecipientSchema.safeParse(target?.recipient);
  const recipient = input.recipient;
  if (
    target?.kind !== "external_recipient" ||
    !frozen.success ||
    !canonicalJsonEqual(
      input.destinationTarget,
      input.actionPayload.destinationTarget,
    ) ||
    frozen.data.recipientId !== recipient.recipientId ||
    frozen.data.accountId !== input.userId ||
    recipient.accountId !== input.userId ||
    frozen.data.addressFingerprint !== recipient.addressFingerprint ||
    frozen.data.networkId !== recipient.networkId ||
    !sameAsset(frozen.data.asset, recipient.asset) ||
    frozen.data.validationPolicyVersion !== recipient.validationPolicyVersion ||
    typeof input.actionPayload.recipientAddress !== "string" ||
    !sameAccountAddress(
      recipient.networkId,
      input.actionPayload.recipientAddress,
      recipient.address,
    )
  )
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Native withdrawal recipient binding changed",
    );
}

/** Caller holds the common operation lock. Reads only that operation's indexed
 * steps, then revalidates the immutable pair and existing nonce ownership. */
export async function nativeFundingPreparationInTransaction(
  client: Pick<PoolClient, "query">,
  operationId: string,
  stepId: string,
) {
  const sendRows = await client.query<{ id: string }>(
    `select id from funding_operation_steps where operation_id=$1 and executor_id='relay_hypercore_native_v1'
      and step_kind='external_handoff' and (id=$2 or depends_on_step_id=$2)`,
    [operationId, stepId],
  );
  const sendRow = sendRows.rows[0];
  if (sendRows.rows.length !== 1 || !sendRow)
    throw new Error("native_funding_pair_missing");
  const pair = await loadValidatedHyperliquidFundingPair(client, sendRow.id);
  if (
    pair.send.operation_id !== operationId ||
    ![pair.auth.id, pair.send.id].includes(stepId)
  )
    throw new Error("native_funding_pair_scope");
  const claim = await client.query<{ matches: boolean }>(
    `select environment='mainnet' and signer_address=$2 and nonce=$3::bigint and action_fingerprint=$4 as matches
       from hyperliquid_nonce_claims where funding_step_id=$1`,
    [
      pair.send.id,
      pair.validated.binding.owner.toLowerCase(),
      pair.validated.binding.nonce,
      pair.send.action_fingerprint,
    ],
  );
  if (claim.rows[0]?.matches !== true)
    throw new Error("native_funding_nonce_unowned");
  const payload = pair.auth.normalized_action.payload as Record<
    string,
    unknown
  >;
  const submission = parseNativeFundingSubmission({
    version: 1,
    phase: "prepared",
    stage: stepId === pair.auth.id ? "nonce_mapping" : "send_asset",
    expiresAt: payload.expiresAt,
    pairFingerprint: pair.validated.fingerprint,
    signer: pair.validated.binding.owner.toLowerCase(),
    nonce: pair.validated.binding.nonce,
  });
  if (!submission) throw new Error("native_funding_preparation_invalid");
  return { pair, submission };
}

export type NativeFundingSubmitInput = {
  userId: string;
  operationId: string;
  stepId: string;
  attemptId: string;
  signature: string;
};
export type NativeFundingCapacityCheck = (
  client: PoolClient,
  input: {
    userId: string;
    operationId: string;
    pair: Awaited<
      ReturnType<typeof nativeFundingPreparationInTransaction>
    >["pair"];
    profile: WalletExecutionProfile;
    sourceSnapshot: unknown;
  },
) => Promise<{ expiresAt: string }>;

export const NATIVE_FUNDING_OPERATION_LOCK_SQL = `select policy_revision, policy_version,
  wallet_execution_snapshot, source_snapshot, purpose, external_recipient_id, destination_target_snapshot
  from funding_operations where id=$1 and user_id=$2 for update`;

/** Both exact native actions share policy, ownership, lease and lifecycle
 * validation. Only SendAsset acquires capacity and durable money ambiguity. */
async function admitNativeFundingActionInTransaction(
  client: PoolClient,
  input: NativeFundingSubmitInput,
  policy: FundingControlPlaneSnapshot,
  options:
    | { stage: "nonce_mapping" }
    | {
        stage: "send_asset";
        verifyCapacity: NativeFundingCapacityCheck;
        codec: FundingTransactionReferenceCodec;
      },
) {
  const operationRows = await client.query<{
    policy_revision: string;
    policy_version: number;
    wallet_execution_snapshot: WalletExecutionProfile;
    source_snapshot: unknown;
    purpose: string;
    external_recipient_id: string | null;
    destination_target_snapshot: unknown;
  }>(NATIVE_FUNDING_OPERATION_LOCK_SQL, [input.operationId, input.userId]);
  const operation = operationRows.rows[0];
  if (!operation)
    throw new FundingPersistenceError(
      "operation_not_found",
      "Funding operation not found",
    );
  const { pair, submission: expected } =
    await nativeFundingPreparationInTransaction(
      client,
      input.operationId,
      input.stepId,
    );
  const selectedStep =
    options.stage === "nonce_mapping" ? pair.auth : pair.send;
  if (input.stepId !== selectedStep.id)
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Expected exact native action stage",
    );
  const rows = await client.query<{
    outcome: string;
    actual_costs: Record<string, unknown>;
    canonical_action_fingerprint: string;
    executor_id: string;
    latest: boolean;
  }>(
    `select attempt_row.outcome, attempt_row.actual_costs, attempt_row.canonical_action_fingerprint, attempt_row.executor_id,
      not exists(select 1 from funding_operation_step_attempts newer_attempt where newer_attempt.step_id=attempt_row.step_id and newer_attempt.attempt_number>attempt_row.attempt_number) as latest
     from funding_operation_step_attempts attempt_row where attempt_row.id=$1 and attempt_row.step_id=$2 for update`,
    [input.attemptId, input.stepId],
  );
  const attempt = rows.rows[0];
  const submission = parseNativeFundingSubmission(
    attempt?.actual_costs.nativeSubmission,
  );
  if (
    !attempt ||
    !submission ||
    submission.stage !== options.stage ||
    attempt.canonical_action_fingerprint !== selectedStep.action_fingerprint ||
    attempt.executor_id !== selectedStep.executor_id ||
    submission.pairFingerprint !== expected.pairFingerprint ||
    submission.signer !== expected.signer ||
    submission.nonce !== expected.nonce ||
    submission.expiresAt !== expected.expiresAt
  )
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Native attempt binding changed",
    );
  const request = nativeFundingSignedRequest(
    pair.validated,
    options.stage,
    input.signature,
  );
  if (submission.phase !== "prepared") {
    if (
      submission.requestFingerprint &&
      submission.requestFingerprint !== request.requestFingerprint
    )
      throw new FundingPersistenceError(
        "quote_mismatch",
        "Native attempt owns another signed request",
      );
    return { admitted: false as const, outcome: attempt.outcome };
  }
  if (attempt.outcome !== "started" || !attempt.latest)
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "Native attempt is closed",
    );
  if (
    !withdrawalBindingMatches(
      operation.purpose,
      operation.external_recipient_id,
    )
  )
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Native withdrawal purpose binding changed",
    );
  let recipientExpiresAt: string | undefined;
  if (operation.external_recipient_id) {
    // User-owned withdrawal follows the existing code-owned contract, not the
    // venue funding pause. Lock recipient before wallet/source until admission.
    const recipient = await resolveWithdrawalDestination(client, {
      userId: input.userId,
      recipientId: operation.external_recipient_id,
      lockForShare: true,
    });
    assertNativeFundingRecipient({
      userId: input.userId,
      recipient,
      destinationTarget: operation.destination_target_snapshot,
      actionPayload: pair.send.normalized_action.payload as Record<
        string,
        unknown
      >,
    });
    recipientExpiresAt = recipient.expiresAt;
  } else if (
    policy.invalidStoredPolicy ||
    policy.runtime.creationMode !== "on" ||
    !policy.runtime.gates.startUnsubmittedAction ||
    policy.runtime.gates.emergencyBroadcastPause ||
    policy.revision !== operation.policy_revision ||
    policy.runtime.contractVersion !== Number(operation.policy_version)
  )
    throw new FundingPersistenceError(
      "quote_invalidated",
      "Funding policy changed before authorization",
    );
  const profile = operation.wallet_execution_snapshot;
  if (
    !profile ||
    profile.walletId !== pair.auth.normalized_action.actorWalletId ||
    profile.networkId !== "hyperliquid:mainnet" ||
    typeof profile.address !== "string" ||
    profile.address.toLowerCase() !== expected.signer ||
    !["embedded", "external"].includes(profile.source)
  )
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Native controller profile mismatch",
    );
  await lockFundingControllerWallet(client, input.userId, profile);
  let capacityExpiresAt: string | undefined;
  if (options.stage === "send_asset") {
    // Validate the fresh provider sample plus all physical holds/debits under
    // the common lock. The caller's own reservation is not free cash.
    const capacity = await options.verifyCapacity(client, {
      userId: input.userId,
      operationId: input.operationId,
      pair,
      profile,
      sourceSnapshot: operation.source_snapshot,
    });
    capacityExpiresAt = capacity.expiresAt;
  }
  const now = (
    await client.query<{ now: Date }>("select clock_timestamp() as now")
  ).rows[0]?.now;
  if (!now) throw new Error("Native authorization clock unavailable");
  if (recipientExpiresAt && Date.parse(recipientExpiresAt) <= now.getTime())
    throw new FundingPersistenceError(
      "quote_expired",
      "Withdrawal recipient expired before admission",
    );
  if (
    options.stage === "send_asset" &&
    (!capacityExpiresAt ||
      !Number.isFinite(Date.parse(capacityExpiresAt)) ||
      Date.parse(capacityExpiresAt) <= now.getTime())
  )
    throw new FundingPersistenceError(
      "quote_invalidated",
      "Native capacity expired while waiting for admission",
    );
  if (Date.parse(submission.expiresAt) <= now.getTime())
    throw new FundingPersistenceError(
      "quote_expired",
      "Native authorization expired",
    );
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    { operationId: input.operationId, now },
  );
  const attemptNumber = facts?.actions
    .find((action) => action.actionId === input.stepId)
    ?.attempts.at(-1)?.attemptNumber;
  if (
    !facts ||
    attemptNumber === undefined ||
    !deriveFundingLifecycleBeforeActionBroadcast(facts, {
      actionId: input.stepId,
      attemptNumber,
    }).actions.find((action) => action.actionId === input.stepId)?.actionable
  )
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "Native authorization is not actionable",
    );
  const admitted = {
    ...submission,
    phase: "admitted" as const,
    admittedAt: now.toISOString(),
    requestFingerprint: request.requestFingerprint,
  };
  if (options.stage === "send_asset") {
    const reference = nativeFundingActionReference(pair.validated);
    await client.query(
      `update funding_operation_step_attempts set outcome='ambiguous',broadcast_may_have_occurred=true,finished_at=$2,
        actual_costs=jsonb_set(actual_costs,'{nativeSubmission}',$3::jsonb),
        reference_kind='external_handoff',receipt_ref_ciphertext=$4,receipt_ref_lookup_hmac=$5,lookup_key_version=$6 where id=$1`,
      [
        input.attemptId,
        now,
        admitted,
        options.codec.encrypt(reference),
        options.codec.fingerprint(reference),
        options.codec.keyVersion,
      ],
    );
  } else {
    await client.query(
      `update funding_operation_step_attempts set actual_costs=jsonb_set(actual_costs,'{nativeSubmission}',$2::jsonb) where id=$1`,
      [input.attemptId, admitted],
    );
  }
  return {
    admitted: true as const,
    request,
  };
}

/** The caller commits before the single bounded authorize POST. */
export async function admitNativeFundingAuthInTransaction(
  client: PoolClient,
  input: NativeFundingSubmitInput,
  policy: FundingControlPlaneSnapshot,
) {
  const result = await admitNativeFundingActionInTransaction(
    client,
    input,
    policy,
    { stage: "nonce_mapping" },
  );
  if (!result.admitted) return { ...result, requestFingerprint: undefined };
  if (result.request.stage !== "nonce_mapping")
    throw new Error("native_auth_request_stage");
  return {
    admitted: true as const,
    request: result.request.body,
    signature: result.request.signature,
    requestFingerprint: result.request.requestFingerprint,
  };
}

/** No retry/POST authority is returned for an already admitted action. */
export async function admitNativeFundingSendInTransaction(
  client: PoolClient,
  input: NativeFundingSubmitInput,
  policy: FundingControlPlaneSnapshot,
  verifyCapacity: NativeFundingCapacityCheck,
  codec: FundingTransactionReferenceCodec,
) {
  const result = await admitNativeFundingActionInTransaction(
    client,
    input,
    policy,
    { stage: "send_asset", verifyCapacity, codec },
  );
  if (!result.admitted) return result;
  if (result.request.stage !== "send_asset")
    throw new Error("native_send_request_stage");
  return {
    admitted: true as const,
    request: result.request.body,
    requestFingerprint: result.request.requestFingerprint,
  };
}

/** Fenced completion: a late HTTP ACK cannot reopen a cancelled/expired/older
 * attempt. Unknown registration is retryable only as the SAME mapping. */
export async function finishNativeFundingAuthInTransaction(
  client: Pick<PoolClient, "query">,
  input: {
    operationId: string;
    stepId: string;
    attemptId: string;
    requestFingerprint: string;
    authorized: boolean;
  },
) {
  await client.query(
    "select id from funding_operations where id=$1 for update",
    [input.operationId],
  );
  const rows = await client.query<{ actual_costs: Record<string, unknown> }>(
    `select attempt_row.actual_costs from funding_operation_steps auth_step
     join funding_operation_step_attempts attempt_row on attempt_row.step_id=auth_step.id
     where auth_step.operation_id=$1 and auth_step.id=$2 and attempt_row.id=$3
       and attempt_row.outcome='started' and not attempt_row.broadcast_may_have_occurred
       and attempt_row.reference_kind is null and attempt_row.receipt_ref_ciphertext is null
       and attempt_row.receipt_ref_lookup_hmac is null and attempt_row.lookup_key_version is null
       and attempt_row.actual_costs #>> '{nativeSubmission,phase}'='admitted'
       and attempt_row.actual_costs #>> '{nativeSubmission,requestFingerprint}'=$4
       and funding_native_auth_attempt_bound(auth_step.id,attempt_row.canonical_action_fingerprint,attempt_row.executor_id,attempt_row.actual_costs->'nativeSubmission')
       and not exists(select 1 from funding_operation_step_attempts newer_attempt where newer_attempt.step_id=auth_step.id and newer_attempt.attempt_number>attempt_row.attempt_number)
     for update of attempt_row`,
    [
      input.operationId,
      input.stepId,
      input.attemptId,
      input.requestFingerprint,
    ],
  );
  const submission = parseNativeFundingSubmission(
    rows.rows[0]?.actual_costs.nativeSubmission,
  );
  if (!submission || submission.phase !== "admitted") return false;
  await client.query(
    `update funding_operation_step_attempts set outcome=$2, finished_at=clock_timestamp(),
    actual_costs=jsonb_set(actual_costs,'{nativeSubmission}',$3::jsonb) where id=$1`,
    [
      input.attemptId,
      input.authorized ? "succeeded" : "failed",
      {
        ...submission,
        phase: "closed",
        reason: input.authorized ? "authorized" : "authorization_unknown",
      },
    ],
  );
  return true;
}

/** Caller holds the operation lock. Only harmless mapping or never-admitted
 * sends may close. Explicit cancellation does not wait for housekeeping. */
export async function closeNativeFundingUnsubmittedInTransaction(
  client: Pick<PoolClient, "query">,
  operationId: string,
  now: Date,
  reason: "expired" | "cancelled",
) {
  const rows = await client.query<{
    id: string;
    actual_costs: Record<string, unknown>;
  }>(
    `select attempt_row.id, attempt_row.actual_costs from funding_operation_steps auth_step
      join funding_operation_step_attempts attempt_row on attempt_row.step_id=auth_step.id
      where auth_step.operation_id=$1 and auth_step.executor_id='relay_hypercore_native_v1'
        and attempt_row.outcome='started'
        and not attempt_row.broadcast_may_have_occurred and attempt_row.reference_kind is null
        and attempt_row.receipt_ref_ciphertext is null and attempt_row.receipt_ref_lookup_hmac is null and attempt_row.lookup_key_version is null
        and case when auth_step.step_kind='signature' then
          funding_native_auth_attempt_bound(auth_step.id,attempt_row.canonical_action_fingerprint,attempt_row.executor_id,attempt_row.actual_costs->'nativeSubmission')
        when auth_step.step_kind='external_handoff' and attempt_row.actual_costs#>>'{nativeSubmission,phase}'='prepared' then
          funding_native_send_attempt_bound(auth_step.id,attempt_row.canonical_action_fingerprint,attempt_row.executor_id,attempt_row.actual_costs->'nativeSubmission')
        else false end
        and not exists(select 1 from funding_operation_step_attempts newer_attempt where newer_attempt.step_id=auth_step.id and newer_attempt.attempt_number>attempt_row.attempt_number)
      for update of attempt_row`,
    [operationId],
  );
  const closed: string[] = [];
  for (const row of rows.rows) {
    const submission = parseNativeFundingSubmission(
      row.actual_costs.nativeSubmission,
    );
    if (
      !submission ||
      !["prepared", "admitted"].includes(submission.phase) ||
      (reason === "expired" && Date.parse(submission.expiresAt) > now.getTime())
    )
      continue;
    const metadata: NativeFundingSubmission = {
      ...submission,
      phase: "closed",
      reason,
    };
    await client.query(
      `update funding_operation_step_attempts set outcome='cancelled',finished_at=$2,actual_costs=jsonb_set(actual_costs,'{nativeSubmission}',$3::jsonb) where id=$1`,
      [row.id, now, metadata],
    );
    closed.push(row.id);
  }
  return closed;
}
