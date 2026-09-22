import { tx, type Pool, type PoolClient } from "@hunch/infra";
import type { JsonValue, NormalizedAction } from "../domain/types.js";
import { normalizedActionSchema } from "../domain/schemas.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import {
  FundingPersistenceError,
  wakeFundingReconciliationInTransaction,
  writeFundingOperationSupportFactsInTransaction,
} from "../persistence/funding-operation-repository.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import { deriveFundingLifecycleBeforeActionBroadcast } from "../lifecycle/funding-lifecycle-projector.js";
import {
  parseSafeFundingSubmission,
  validateSafeFundingSubmission,
  safeFundingTransactionReference,
} from "./safe-funding-submission-contract.js";
import {
  createFundingTransactionReferenceCodec,
  type FundingTransactionReferenceCodec,
} from "./transaction-reference-codec.js";
import { polymarketRelayerTransactionReference } from "./polymarket-deposit-wallet-handoff.js";
import {
  createPolymarketRelayerHeaderPayload,
  type PolymarketRelayerCredentials,
} from "../../services/polymarket-relayer-signing.js";
import { POLYMARKET_RELAYER_BASE_URL } from "../../services/polymarket-deposit-wallet-relayer.js";
import { getCredentialsEncryptionKey } from "../../lib/credentials-encryption.js";
import {
  lockFundingPolicyForTransaction,
  resolveFundingControlPlaneSnapshot,
  type FundingControlPlaneSnapshot,
} from "../policies/funding-policy-sidecar.js";

type JsonRecord = Record<string, JsonValue>;
export type SafeFundingSubmitInput = {
  operationId: string;
  stepId: string;
  attemptId: string;
  request: Record<string, unknown>;
};
export class SafeFundingSubmissionUnknownError extends Error {
  constructor() {
    super("Safe submission is awaiting durable relayer evidence");
  }
}

export async function admitSafeFundingSubmissionInTransaction(
  client: PoolClient,
  userId: string,
  input: SafeFundingSubmitInput,
  at?: Date,
  referenceCodec?: FundingTransactionReferenceCodec,
  admissionPolicy?: FundingControlPlaneSnapshot,
) {
  const operation = await client.query<{
    id: string;
    external_recipient_id: string | null;
    policy_revision: string;
    policy_version: number;
  }>(
    "select id, external_recipient_id, policy_revision, policy_version from funding_operations where id=$1 and user_id=$2 for update",
    [input.operationId, userId],
  );
  const scopedOperation = operation.rows[0];
  if (!scopedOperation)
    throw new FundingPersistenceError(
      "operation_not_found",
      "Funding operation not found",
    );
  const steps = await client.query<{
    normalized_action: JsonRecord;
    action_validation_result: JsonRecord;
    action_fingerprint: string;
    executor_id: string;
    action_expires_at: Date | null;
  }>(
    "select normalized_action, action_validation_result, action_fingerprint, executor_id, action_expires_at from funding_operation_steps where id=$1 and operation_id=$2 for update",
    [input.stepId, input.operationId],
  );
  const step = steps.rows[0];
  if (
    !step ||
    step.executor_id !== "polymarket_safe_relayer_v1" ||
    canonicalJsonHash(step.normalized_action) !== step.action_fingerprint
  )
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Safe funding action binding changed",
    );
  const action = normalizedActionSchema.parse(
    step.normalized_action,
  ) as unknown as NormalizedAction;
  const identity = validateSafeFundingSubmission({
    action,
    validation: step.action_validation_result,
    request: input.request,
  });
  const codec = referenceCodec ?? safeFundingReferenceCodec();
  const safeReference = safeFundingTransactionReference(
    String(input.request.proxyWallet),
    identity.safeTransactionHash,
  );
  const attempts = await client.query<{
    outcome: string;
    actual_costs: JsonRecord;
    attempt_number: number;
    receipt_ref_ciphertext: string | null;
    lookup_key_version: number | null;
  }>(
    "select outcome, actual_costs, attempt_number, receipt_ref_ciphertext, lookup_key_version from funding_operation_step_attempts where id=$1 and step_id=$2 for update",
    [input.attemptId, input.stepId],
  );
  const attempt = attempts.rows[0];
  // Obtain wall-clock time after waiting for locks, never before them.
  const now =
    at ??
    (await client.query<{ now: Date }>("select clock_timestamp() as now"))
      .rows[0]?.now;
  if (!now) throw new Error("Safe admission clock unavailable");
  const submission = parseSafeFundingSubmission(
    attempt?.actual_costs.safeSubmission,
  );
  if (!attempt || !submission)
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "Safe attempt requires the scoped submission protocol",
    );
  if (submission.phase === "admitted") {
    if (submission.requestFingerprint !== identity.requestFingerprint)
      throw new FundingPersistenceError(
        "quote_mismatch",
        "Safe attempt already owns a different signed request",
      );
    return {
      admitted: false as const,
      ciphertext: attempt.receipt_ref_ciphertext,
      keyVersion: attempt.lookup_key_version,
    };
  }
  if (attempt.outcome !== "started" || submission.phase !== "prepared")
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "Safe attempt is closed",
    );
  if (
    Date.parse(submission.expiresAt) <= now.getTime() ||
    (step.action_expires_at && step.action_expires_at <= now)
  )
    throw new FundingPersistenceError(
      "quote_expired",
      "Safe signing lease has expired",
    );
  if (
    admissionPolicy &&
    !scopedOperation.external_recipient_id &&
    (admissionPolicy.runtime.creationMode !== "on" ||
      !admissionPolicy.runtime.gates.startUnsubmittedAction ||
      admissionPolicy.runtime.gates.emergencyBroadcastPause ||
      admissionPolicy.revision !== scopedOperation.policy_revision ||
      admissionPolicy.runtime.contractVersion !==
        Number(scopedOperation.policy_version))
  )
    throw new FundingPersistenceError(
      "quote_invalidated",
      "Safe submission is disabled or its funding policy changed",
    );
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    { operationId: input.operationId, now },
  );
  if (
    !facts ||
    !deriveFundingLifecycleBeforeActionBroadcast(facts, {
      actionId: input.stepId,
      attemptNumber: attempt.attempt_number,
    }).actions.find((candidate) => candidate.actionId === input.stepId)
      ?.actionable
  )
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "Safe funding action is no longer executable",
    );
  await client.query(
    `update funding_operation_step_attempts
    set outcome='ambiguous', broadcast_may_have_occurred=true, finished_at=$2,
        actual_costs=actual_costs || $3::jsonb,
        reference_kind='external_handoff', receipt_ref_ciphertext=$4,
        receipt_ref_lookup_hmac=$5, lookup_key_version=$6
    where id=$1`,
    [
      input.attemptId,
      now,
      {
        safeSubmission: {
          ...submission,
          phase: "admitted",
          admittedAt: now.toISOString(),
          ...identity,
        },
      },
      codec.encrypt(safeReference),
      codec.fingerprint(safeReference),
      codec.keyVersion,
    ],
  );
  await wakeFundingReconciliationInTransaction(client, {
    operationId: input.operationId,
    dueAt: now,
  });
  return {
    admitted: true as const,
    ciphertext: codec.encrypt(safeReference),
    keyVersion: codec.keyVersion,
  };
}

/** Only this server-owned path may attach a result to an admitted Safe attempt. */
export async function recordSafeFundingSubmissionResultInTransaction(
  client: PoolClient,
  userId: string,
  input: SafeFundingSubmitInput,
  reference: string,
  codec: FundingTransactionReferenceCodec,
  now = new Date(),
) {
  const operation = await client.query<{
    id: string;
    version: string | number;
    support_metadata: JsonRecord;
  }>(
    "select id, version, support_metadata from funding_operations where id=$1 and user_id=$2 for update",
    [input.operationId, userId],
  );
  const scoped = operation.rows[0];
  if (!scoped) throw new Error("Safe submission operation disappeared");
  await client.query(
    "select id from funding_operation_steps where id=$1 and operation_id=$2 for update",
    [input.stepId, input.operationId],
  );
  const result = await client.query(
    `select id from funding_operation_step_attempts
    where id=$1 and step_id=$2 and outcome='ambiguous'
      and actual_costs -> 'safeSubmission' ->> 'phase' = 'admitted'
      and actual_costs -> 'safeSubmission' ->> 'requestFingerprint' = $3
      and receipt_ref_ciphertext is not null for update`,
    [input.attemptId, input.stepId, canonicalJsonHash(input.request)],
  );
  if (!result.rows.length)
    throw new Error("Safe submission result could not be persisted");
  const previousResults = scoped.support_metadata.safeSubmissionResults;
  const results =
    previousResults &&
    typeof previousResults === "object" &&
    !Array.isArray(previousResults)
      ? previousResults
      : {};
  const existing = (results as JsonRecord)[input.attemptId];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    const previousEvidence = existing as JsonRecord;
    if (
      previousEvidence.referenceLookupHmac !== codec.fingerprint(reference) ||
      previousEvidence.lookupKeyVersion !== codec.keyVersion
    ) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "Safe submission already has different provider evidence",
      );
    }
    return;
  }
  await writeFundingOperationSupportFactsInTransaction(client, {
    operationId: input.operationId,
    expectedVersion: Number(scoped.version),
    supportMetadataPatch: {
      safeSubmissionResults: {
        ...results,
        [input.attemptId]: {
          referenceCiphertext: codec.encrypt(reference),
          referenceLookupHmac: codec.fingerprint(reference),
          lookupKeyVersion: codec.keyVersion,
          observedAt: now.toISOString(),
        },
      },
    },
    now,
  });
  await wakeFundingReconciliationInTransaction(client, {
    operationId: input.operationId,
    dueAt: now,
  });
}

export async function submitSafeFundingAction(
  pool: Pool,
  userId: string,
  input: SafeFundingSubmitInput,
  credentials: PolymarketRelayerCredentials,
  dependencies: {
    fetchImpl?: typeof fetch;
    codec?: FundingTransactionReferenceCodec;
    /** Test-only injection; production always resolves under the policy lock. */
    admissionPolicy?: (
      client: PoolClient,
    ) => Promise<FundingControlPlaneSnapshot | undefined>;
  } = {},
): Promise<{ transactionReference: string }> {
  const codec = dependencies.codec ?? safeFundingReferenceCodec();
  const admission = await tx(pool, async (client) => {
    await lockFundingPolicyForTransaction(client);
    const policy = await (
      dependencies.admissionPolicy ?? resolveFundingControlPlaneSnapshot
    )(client);
    return admitSafeFundingSubmissionInTransaction(
      client,
      userId,
      input,
      undefined,
      codec,
      policy,
    );
  });
  if (!admission.admitted) {
    if (admission.ciphertext && admission.keyVersion === codec.keyVersion)
      return { transactionReference: codec.decrypt(admission.ciphertext) };
    throw new SafeFundingSubmissionUnknownError();
  }
  // The durable ambiguous marker is committed before the sole network call.
  // Do not tie this request to the browser's abort signal and never retry POST.
  let responseStatus: number | null = null;
  try {
    const headers = createPolymarketRelayerHeaderPayload({
      ...credentials,
      method: "POST",
      path: "/submit",
      body: input.request,
    });
    const response = await (dependencies.fetchImpl ?? fetch)(
      `${POLYMARKET_RELAYER_BASE_URL}/submit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(input.request),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      },
    );
    responseStatus = response.status;
    const result = (await response.json()) as {
      transactionID?: unknown;
      transactionHash?: unknown;
    };
    // A usable identity wins over the HTTP label, just like a late provider
    // status report. Never discard receipt evidence carried in an error reply.
    const reference =
      typeof result.transactionID === "string"
        ? polymarketRelayerTransactionReference(result.transactionID)
        : typeof result.transactionHash === "string" &&
            /^0x[0-9a-fA-F]{64}$/.test(result.transactionHash)
          ? result.transactionHash.toLowerCase()
          : null;
    if (!reference) throw new SafeFundingSubmissionUnknownError();
    await tx(pool, (client) =>
      recordSafeFundingSubmissionResultInTransaction(
        client,
        userId,
        input,
        reference,
        codec,
      ),
    );
    return { transactionReference: codec.decrypt(admission.ciphertext) };
  } catch {
    // Even an upstream rejection does not erase the admitted boundary.
    await tx(pool, async (client) => {
      const operation = await client.query<{
        version: string | number;
        support_metadata: JsonRecord;
      }>(
        "select version, support_metadata from funding_operations where id=$1 and user_id=$2 for update",
        [input.operationId, userId],
      );
      const row = operation.rows[0];
      if (!row) return;
      const now = new Date();
      const previous = row.support_metadata.safeSubmissionDiagnostics;
      const diagnostics =
        previous && typeof previous === "object" && !Array.isArray(previous)
          ? previous
          : {};
      await writeFundingOperationSupportFactsInTransaction(client, {
        operationId: input.operationId,
        expectedVersion: Number(row.version),
        now,
        supportMetadataPatch: {
          safeSubmissionDiagnostics: {
            ...diagnostics,
            [input.attemptId]: {
              observedAt: now.toISOString(),
              responseStatus,
              outcome:
                responseStatus === null
                  ? "transport_unknown"
                  : "provider_response_unresolved",
            },
          },
        },
      });
      await wakeFundingReconciliationInTransaction(client, {
        operationId: input.operationId,
        dueAt: now,
      });
    }).catch(() => {
      /* The durable Safe identity still owns recovery if diagnostics cannot be written. */
    });
    throw new SafeFundingSubmissionUnknownError();
  }
}

function safeFundingReferenceCodec(): FundingTransactionReferenceCodec {
  const lookupKey = process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY?.trim();
  if (!lookupKey)
    throw new FundingPersistenceError(
      "quote_invalidated",
      "Funding reference protection is unavailable",
    );
  return createFundingTransactionReferenceCodec({
    encryptionKey: getCredentialsEncryptionKey(),
    lookupHmacKey: lookupKey,
    keyVersion: Number(process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION || 1),
  });
}

/** Caller holds the operation lock; unversioned legacy attempts are untouched. */
export async function closeExpiredSafeFundingPreparationsInTransaction(
  client: PoolClient,
  operationId: string,
  now: Date,
): Promise<boolean> {
  const rows = await client.query<{ id: string; actual_costs: JsonRecord }>(
    `select attempt_row.id, attempt_row.actual_costs
    from funding_operation_steps step_row join funding_operation_step_attempts attempt_row on attempt_row.step_id=step_row.id
    where step_row.operation_id=$1 and step_row.executor_id='polymarket_safe_relayer_v1'
      and attempt_row.outcome='started' and not attempt_row.broadcast_may_have_occurred
      and attempt_row.reference_kind is null
      and attempt_row.actual_costs -> 'safeSubmission' ->> 'phase' = 'prepared'
    order by step_row.ordinal, attempt_row.attempt_number for update of step_row, attempt_row`,
    [operationId],
  );
  let changed = false;
  for (const row of rows.rows) {
    const submission = parseSafeFundingSubmission(
      row.actual_costs.safeSubmission,
    );
    if (!submission || Date.parse(submission.expiresAt) > now.getTime())
      continue;
    await client.query(
      `update funding_operation_step_attempts set outcome='cancelled', finished_at=$2,
      actual_costs=actual_costs || $3::jsonb where id=$1`,
      [
        row.id,
        now,
        {
          safeSubmission: { ...submission, phase: "closed" },
          reasonCode: "safe_pre_submit_lease_expired",
        },
      ],
    );
    changed = true;
  }
  return changed;
}
