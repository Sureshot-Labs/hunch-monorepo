import { tx, type Pool, type PoolClient } from "@hunch/infra";
import type { JsonValue, NormalizedAction } from "../domain/types.js";
import { normalizedActionSchema } from "../domain/schemas.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import {
  FundingPersistenceError,
  wakeFundingReconciliationInTransaction,
} from "../persistence/funding-operation-repository.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import { deriveFundingLifecycleBeforeActionBroadcast } from "../lifecycle/funding-lifecycle-projector.js";
import {
  lockFundingPolicyForTransaction,
  resolveFundingControlPlaneSnapshot,
  type FundingControlPlaneSnapshot,
} from "../policies/funding-policy-sidecar.js";
import {
  createFundingTransactionReferenceCodec,
  type FundingTransactionReferenceCodec,
} from "./transaction-reference-codec.js";
import { getCredentialsEncryptionKey } from "../../lib/credentials-encryption.js";
import {
  parseEmbeddedFundingSubmission,
  validateEmbeddedFundingPayload,
  type EmbeddedFundingContext,
  type EmbeddedFundingPayload,
} from "./embedded-funding-submission-contract.js";
import { parsePrivyFundingTransactionReference } from "./privy-transaction-reference.js";

type JsonRecord = Record<string, JsonValue>;
export type EmbeddedFundingSubmissionInput = {
  context: EmbeddedFundingContext;
  payload: EmbeddedFundingPayload;
  requests: readonly { id: string; input: unknown }[];
};
export type EmbeddedFundingReference = {
  kind: "transaction" | "provider_transaction" | "user_operation";
  value: string;
};
export class EmbeddedFundingSubmissionUnknownError extends Error {
  constructor() {
    super("Embedded funding submission is awaiting durable provider evidence");
  }
}
type AttemptRow = {
  outcome: string;
  actual_costs: JsonRecord;
  attempt_number: number;
  reference_kind: "transaction" | "provider_receipt" | "signature" | null;
  receipt_ref_ciphertext: string | null;
  receipt_ref_lookup_hmac: string | null;
  lookup_key_version: number | null;
};
async function lockScope(
  client: PoolClient,
  userId: string,
  scope: EmbeddedFundingContext,
) {
  const operation = (
    await client.query<{
      external_recipient_id: string | null;
      policy_revision: string;
      policy_version: number;
    }>(
      "select external_recipient_id, policy_revision, policy_version from funding_operations where id=$1 and user_id=$2 for update",
      [scope.operationId, userId],
    )
  ).rows[0];
  if (!operation)
    throw new FundingPersistenceError(
      "operation_not_found",
      "Funding operation not found",
    );
  const step = (
    await client.query<{
      normalized_action: JsonRecord;
      action_fingerprint: string;
      executor_id: string;
      action_expires_at: Date | null;
    }>(
      "select normalized_action, action_fingerprint, executor_id, action_expires_at from funding_operation_steps where id=$1 and operation_id=$2 for update",
      [scope.stepId, scope.operationId],
    )
  ).rows[0];
  if (
    !step ||
    !["wallet_profile_evm_v1", "wallet_profile_svm_v1"].includes(
      step.executor_id,
    ) ||
    canonicalJsonHash(step.normalized_action) !== step.action_fingerprint
  )
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Embedded funding action binding changed",
    );
  const attempt = (
    await client.query<AttemptRow>(
      "select outcome, actual_costs, attempt_number, reference_kind, receipt_ref_ciphertext, receipt_ref_lookup_hmac, lookup_key_version from funding_operation_step_attempts where id=$1 and step_id=$2 for update",
      [scope.attemptId, scope.stepId],
    )
  ).rows[0];
  const lease = parseEmbeddedFundingSubmission(
    attempt?.actual_costs.embeddedSubmission,
  );
  if (!attempt || !lease)
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "Refresh funding to use the scoped embedded submission protocol",
    );
  return { operation, step, attempt, lease };
}
async function databaseNow(client: PoolClient, at?: Date): Promise<Date> {
  const now =
    at ??
    (await client.query<{ now: Date }>("select clock_timestamp() as now"))
      .rows[0]?.now;
  if (!now) throw new Error("Embedded admission clock unavailable");
  return now;
}
function fingerprint(input: EmbeddedFundingSubmissionInput): string {
  // Signatures are deliberately excluded. One provider request represents a
  // single EVM transaction, an atomic batch, or one Solana transaction.
  if (input.requests.length !== 1)
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Funding requires exactly one atomic provider submission",
    );
  return canonicalJsonHash(
    input.requests.map(({ id, input: request }) => ({
      id,
      input: request,
    })) as JsonValue,
  );
}
function assertPrepared(
  scope: Awaited<ReturnType<typeof lockScope>>,
  now: Date,
) {
  if (scope.attempt.outcome !== "started" || scope.lease.phase !== "prepared")
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "Embedded funding attempt is closed or already admitted",
    );
  if (
    Date.parse(scope.lease.expiresAt) <= now.getTime() ||
    (scope.step.action_expires_at && scope.step.action_expires_at <= now)
  )
    throw new FundingPersistenceError(
      "quote_expired",
      "Embedded funding signing lease expired; refresh funding",
    );
}
export async function prepareEmbeddedFundingSubmissionInTransaction(
  client: PoolClient,
  userId: string,
  input: EmbeddedFundingSubmissionInput,
  at?: Date,
): Promise<void> {
  const scope = await lockScope(client, userId, input.context);
  assertPrepared(scope, await databaseNow(client, at));
  validateEmbeddedFundingPayload(
    normalizedActionSchema.parse(
      scope.step.normalized_action,
    ) as NormalizedAction,
    scope.lease,
    input.payload,
  );
  fingerprint(input);
}
export async function admitEmbeddedFundingSubmissionInTransaction(
  client: PoolClient,
  userId: string,
  input: EmbeddedFundingSubmissionInput,
  at?: Date,
  admissionPolicy?: FundingControlPlaneSnapshot,
) {
  const scope = await lockScope(client, userId, input.context);
  const now = await databaseNow(client, at);
  validateEmbeddedFundingPayload(
    normalizedActionSchema.parse(
      scope.step.normalized_action,
    ) as NormalizedAction,
    scope.lease,
    input.payload,
  );
  const requestFingerprint = fingerprint(input);
  if (scope.lease.phase === "admitted") {
    if (scope.lease.requestFingerprint !== requestFingerprint)
      throw new FundingPersistenceError(
        "quote_mismatch",
        "Embedded authorization does not match its admitted request",
      );
    return {
      admitted: false as const,
      referenceKind: scope.attempt.reference_kind,
      referenceCiphertext: scope.attempt.receipt_ref_ciphertext,
      lookupKeyVersion: scope.attempt.lookup_key_version,
    };
  }
  assertPrepared(scope, now);
  if (
    admissionPolicy &&
    !scope.operation.external_recipient_id &&
    (admissionPolicy.runtime.creationMode !== "on" ||
      !admissionPolicy.runtime.gates.startUnsubmittedAction ||
      admissionPolicy.runtime.gates.emergencyBroadcastPause ||
      admissionPolicy.revision !== scope.operation.policy_revision ||
      admissionPolicy.runtime.contractVersion !==
        Number(scope.operation.policy_version))
  )
    throw new FundingPersistenceError(
      "quote_invalidated",
      "Funding submission policy changed",
    );
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    { operationId: input.context.operationId, now },
  );
  if (
    !facts ||
    !deriveFundingLifecycleBeforeActionBroadcast(facts, {
      actionId: input.context.stepId,
      attemptNumber: scope.attempt.attempt_number,
    }).actions.find((action) => action.actionId === input.context.stepId)
      ?.actionable
  )
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "Embedded funding action is no longer executable",
    );
  await client.query(
    "update funding_operation_step_attempts set outcome='ambiguous', broadcast_may_have_occurred=true, finished_at=$2, actual_costs=actual_costs || $3::jsonb where id=$1",
    [
      input.context.attemptId,
      now,
      {
        embeddedSubmission: {
          ...scope.lease,
          phase: "admitted",
          requestFingerprint,
          admittedAt: now.toISOString(),
        },
      },
    ],
  );
  await wakeFundingReconciliationInTransaction(client, {
    operationId: input.context.operationId,
    dueAt: now,
  });
  return { admitted: true as const };
}
export async function recordEmbeddedFundingSubmissionResultInTransaction(
  client: PoolClient,
  userId: string,
  context: EmbeddedFundingContext,
  reference: EmbeddedFundingReference,
  codec: FundingTransactionReferenceCodec,
  now = new Date(),
): Promise<void> {
  const scope = await lockScope(client, userId, context);
  if (
    scope.lease.phase !== "admitted" ||
    !["ambiguous", "submitted"].includes(scope.attempt.outcome)
  )
    throw new EmbeddedFundingSubmissionUnknownError();
  const hmac = codec.fingerprint(reference.value);
  const provider = parsePrivyFundingTransactionReference(reference.value);
  const kind =
    scope.step.normalized_action.kind === "svm_transaction"
      ? "signature"
      : provider
        ? "provider_receipt"
        : "transaction";
  if (scope.attempt.receipt_ref_lookup_hmac) {
    if (
      scope.attempt.receipt_ref_lookup_hmac !== hmac ||
      scope.attempt.reference_kind !== kind
    )
      throw new EmbeddedFundingSubmissionUnknownError();
    return;
  }
  await client.query(
    "update funding_operation_step_attempts set reference_kind=$2, receipt_ref_ciphertext=$3, receipt_ref_lookup_hmac=$4, lookup_key_version=$5, actual_costs=actual_costs || $6::jsonb where id=$1",
    [
      context.attemptId,
      kind,
      codec.encrypt(reference.value),
      hmac,
      codec.keyVersion,
      provider ? { providerReferenceKind: "privy_transaction" } : {},
    ],
  );
  await wakeFundingReconciliationInTransaction(client, {
    operationId: context.operationId,
    dueAt: now,
  });
}
function referenceCodec(): FundingTransactionReferenceCodec {
  const lookupHmacKey = process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY?.trim();
  if (!lookupHmacKey)
    throw new FundingPersistenceError(
      "quote_invalidated",
      "Funding reference protection is unavailable",
    );
  return createFundingTransactionReferenceCodec({
    encryptionKey: getCredentialsEncryptionKey(),
    lookupHmacKey,
    keyVersion: Number(process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION || 1),
  });
}
export async function prepareEmbeddedFundingSubmission(
  pool: Pool,
  userId: string,
  input: EmbeddedFundingSubmissionInput,
): Promise<void> {
  await tx(pool, (client) =>
    prepareEmbeddedFundingSubmissionInTransaction(client, userId, input),
  );
}
export async function readAdmittedEmbeddedFundingReference(
  pool: Pool,
  userId: string,
  context: EmbeddedFundingContext,
): Promise<EmbeddedFundingReference | undefined> {
  const codec = referenceCodec();
  return tx(pool, async (client) => {
    const scope = await lockScope(client, userId, context);
    if (scope.lease.phase !== "admitted") return undefined;
    const attempt = scope.attempt;
    if (
      !attempt.receipt_ref_ciphertext ||
      attempt.lookup_key_version !== codec.keyVersion
    )
      throw new EmbeddedFundingSubmissionUnknownError();
    const value = codec.decrypt(attempt.receipt_ref_ciphertext);
    const provider = parsePrivyFundingTransactionReference(value);
    return {
      kind:
        provider?.kind === "transaction_id"
          ? "provider_transaction"
          : provider
            ? "user_operation"
            : "transaction",
      value,
    };
  });
}
/** No Redis TTL or browser disconnect can grant a second provider POST. */
export async function submitEmbeddedFundingAction(
  pool: Pool,
  userId: string,
  input: EmbeddedFundingSubmissionInput,
  submit: () => Promise<EmbeddedFundingReference>,
  dependencies: {
    codec?: FundingTransactionReferenceCodec;
    admissionPolicy?: (
      client: PoolClient,
    ) => Promise<FundingControlPlaneSnapshot | undefined>;
  } = {},
): Promise<EmbeddedFundingReference> {
  const codec = dependencies.codec ?? referenceCodec();
  const admission = await tx(pool, async (client) => {
    await lockFundingPolicyForTransaction(client);
    const policy = await (
      dependencies.admissionPolicy ?? resolveFundingControlPlaneSnapshot
    )(client);
    return admitEmbeddedFundingSubmissionInTransaction(
      client,
      userId,
      input,
      undefined,
      policy,
    );
  });
  if (!admission.admitted) {
    if (
      !admission.referenceCiphertext ||
      !admission.referenceKind ||
      admission.lookupKeyVersion !== codec.keyVersion
    )
      throw new EmbeddedFundingSubmissionUnknownError();
    const value = codec.decrypt(admission.referenceCiphertext);
    const provider = parsePrivyFundingTransactionReference(value);
    return {
      kind:
        provider?.kind === "transaction_id"
          ? "provider_transaction"
          : provider
            ? "user_operation"
            : "transaction",
      value,
    };
  }
  try {
    const reference = await submit();
    if (!reference.value) throw new EmbeddedFundingSubmissionUnknownError();
    await tx(pool, (client) =>
      recordEmbeddedFundingSubmissionResultInTransaction(
        client,
        userId,
        input.context,
        reference,
        codec,
      ),
    );
    return reference;
  } catch {
    throw new EmbeddedFundingSubmissionUnknownError();
  }
}
/** Caller owns operation lock. Legacy and admitted attempts never expire here. */
export async function closeExpiredEmbeddedFundingPreparationsInTransaction(
  client: PoolClient,
  operationId: string,
  now: Date,
): Promise<boolean> {
  const rows = await client.query<{ id: string; actual_costs: JsonRecord }>(
    `select attempt_row.id, attempt_row.actual_costs from funding_operation_steps step_row join funding_operation_step_attempts attempt_row on attempt_row.step_id=step_row.id where step_row.operation_id=$1 and step_row.executor_id in ('wallet_profile_evm_v1','wallet_profile_svm_v1') and attempt_row.outcome='started' and not attempt_row.broadcast_may_have_occurred and attempt_row.reference_kind is null and attempt_row.actual_costs -> 'embeddedSubmission' ->> 'phase' = 'prepared' order by step_row.ordinal,attempt_row.attempt_number for update of step_row,attempt_row`,
    [operationId],
  );
  let changed = false;
  for (const row of rows.rows) {
    const lease = parseEmbeddedFundingSubmission(
      row.actual_costs.embeddedSubmission,
    );
    if (!lease || Date.parse(lease.expiresAt) > now.getTime()) continue;
    await client.query(
      "update funding_operation_step_attempts set outcome='cancelled', finished_at=$2, actual_costs=actual_costs || $3::jsonb where id=$1",
      [
        row.id,
        now,
        {
          embeddedSubmission: { ...lease, phase: "closed" },
          reasonCode: "embedded_pre_submit_lease_expired",
        },
      ],
    );
    changed = true;
  }
  return changed;
}
