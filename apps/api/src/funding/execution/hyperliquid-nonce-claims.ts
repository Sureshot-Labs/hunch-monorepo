import type { PoolClient } from "@hunch/infra";
import {
  RELAY_HYPERCORE_AUTH,
  RELAY_HYPERCORE_EXECUTOR,
  RELAY_HYPERCORE_SEND,
} from "../../funding-providers/relay/hypercore-operation-plan.js";
import {
  relayHypercorePairBindingSchema,
  validateRelayHypercorePayloads,
} from "../../funding-providers/relay/hypercore-actions.js";
import { HYPERCORE_MAINNET_USDC } from "../domain/hypercore-identity.js";
import type { JsonObject } from "../domain/types.js";
import {
  canonicalJsonEqual,
  canonicalJsonHash,
} from "../persistence/canonical.js";

export class HyperliquidNonceConflictError extends Error {
  readonly code = "hyperliquid_nonce_conflict";
  constructor() {
    // Only unsubmitted preparations may request a fresh quote. Existing unknown
    // submissions keep their original step/attempt and go through recovery.
    super("Native nonce is already bound; review a fresh quote before signing");
  }
}

type NativeStep = {
  id: string;
  operation_id: string;
  segment_id: string | null;
  step_kind: string;
  executor_id: string;
  action_fingerprint: string;
  normalized_action: JsonObject;
  action_validation_result: JsonObject;
  depends_on_step_id: string | null;
};

export const HYPERLIQUID_FUNDING_NONCE_PAIR_SQL = `select native_step.id, native_step.operation_id, native_step.segment_id, native_step.step_kind, native_step.executor_id,
            native_step.action_fingerprint, native_step.normalized_action,
            native_step.action_validation_result, native_step.depends_on_step_id
       from funding_operation_steps native_step
      where native_step.id = $1::uuid
         or native_step.id = (
           select send_step.depends_on_step_id from funding_operation_steps send_step
            where send_step.id = $1::uuid
         )`;

/** Recheck immutable pair identity for both commit and server admission. */
export async function loadValidatedHyperliquidFundingPair(
  client: Pick<PoolClient, "query">,
  sendStepId: string,
) {
  const result = await client.query<NativeStep>(
    HYPERLIQUID_FUNDING_NONCE_PAIR_SQL,
    [sendStepId],
  );
  const send = result.rows.find((row) => row.id === sendStepId);
  const auth = result.rows.find((row) => row.id === send?.depends_on_step_id);
  if (
    !send ||
    !auth ||
    result.rows.length !== 2 ||
    send.operation_id !== auth.operation_id ||
    !send.segment_id ||
    send.segment_id !== auth.segment_id
  )
    throw new Error("native_nonce_pair_missing");
  const authAction = auth.normalized_action;
  const sendAction = send.normalized_action;
  const payload = (action: JsonObject) => action.payload as JsonObject;
  for (const [step, stage, kind, handoffKind] of [
    [auth, "nonce_mapping", "signature", RELAY_HYPERCORE_AUTH],
    [send, "send_asset", "external_handoff", RELAY_HYPERCORE_SEND],
  ] as const) {
    if (
      step.step_kind !== kind ||
      step.executor_id !== RELAY_HYPERCORE_EXECUTOR ||
      step.normalized_action.kind !== "external_handoff" ||
      step.normalized_action.networkId !== HYPERCORE_MAINNET_USDC.networkId ||
      step.normalized_action.handoffKind !== handoffKind ||
      canonicalJsonHash(step.normalized_action) !== step.action_fingerprint ||
      step.action_validation_result.validatorId !== RELAY_HYPERCORE_EXECUTOR ||
      step.action_validation_result.nativeStage !== stage ||
      step.action_validation_result.nativeEnvironment !== "mainnet" ||
      step.action_validation_result.valueMoving !== (stage === "send_asset") ||
      !payload(step.normalized_action)
    )
      throw new Error("native_nonce_step_invalid");
  }
  const { data: authData, ...authBinding } = payload(authAction);
  const { data: sendData, ...sendBinding } = payload(sendAction);
  if (
    !canonicalJsonEqual(authBinding, sendBinding) ||
    authAction.actorWalletId !== sendAction.actorWalletId
  )
    throw new Error("native_nonce_pair_mismatch");
  const validated = validateRelayHypercorePayloads(
    { authorization: authData, transfer: sendData },
    relayHypercorePairBindingSchema.parse(payload(sendAction).binding),
  );
  for (const step of [auth, send]) {
    if (
      step.action_validation_result.nativeNonce !== validated.binding.nonce ||
      step.action_validation_result.nativePairFingerprint !==
        validated.fingerprint ||
      step.action_validation_result.validationRevision !==
        validated.fingerprint ||
      String(step.action_validation_result.signerAddress).toLowerCase() !==
        validated.binding.owner.toLowerCase()
    )
      throw new Error("native_nonce_validation_mismatch");
  }
  return { auth, send, validated };
}

export async function claimHyperliquidFundingNonceInTransaction(
  client: Pick<PoolClient, "query">,
  sendStepId: string,
): Promise<void> {
  const { send, validated } = await loadValidatedHyperliquidFundingPair(
    client,
    sendStepId,
  );
  const values = [
    "mainnet",
    validated.binding.owner.toLowerCase(),
    String(validated.binding.nonce),
    send.action_fingerprint,
    sendStepId,
  ];
  const inserted = await client.query(
    `insert into hyperliquid_nonce_claims
       (environment, signer_address, nonce, action_fingerprint, funding_step_id)
     values ($1, $2, $3::bigint, $4, $5::uuid)
     on conflict do nothing returning funding_step_id`,
    values,
  );
  if (inserted.rowCount) return;
  // A separate statement is intentional: at READ COMMITTED a conflicting
  // insert may have waited for a transaction not visible to its own snapshot.
  const existing = await client.query<{ matches: boolean }>(
    `select environment = $1 and signer_address = $2 and nonce = $3::bigint
            and action_fingerprint = $4 as matches
       from hyperliquid_nonce_claims where funding_step_id = $5::uuid`,
    values,
  );
  if (existing.rows[0]?.matches !== true)
    throw new HyperliquidNonceConflictError();
}
