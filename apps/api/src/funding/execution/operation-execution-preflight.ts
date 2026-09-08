import type { Pool } from "@hunch/infra";
import { isRecord } from "../../lib/type-guards.js";
import { normalizedActionSchema, opaqueIdSchema } from "../domain/schemas.js";
import type { FundingOperationStep } from "../persistence/funding-evidence-repository.js";
import type { FundingOperationRow } from "../persistence/funding-operation-repository.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import {
  POLYMARKET_DEPOSIT_ROUTER_PROFILE_IDS,
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_IDS,
} from "./delegated-funding-profile-ids.js";

export type FundingExecutionPreflight = Readonly<{
  operationId: string;
  operationVersion: number;
  complete: boolean;
  requiredControllerWalletRefs: string[];
}>;

const clientExecutors = new Set([
  "wallet_profile_evm_v1",
  "wallet_profile_svm_v1",
  "polymarket_deposit_wallet_relayer_v1",
  "polymarket_safe_relayer_v1",
]);

/** Read immutable profiles only; linked wallets and fresh quotes are not evidence. */
export function buildFundingExecutionPreflight(
  operation: Pick<FundingOperationRow, "id" | "version">,
  steps: readonly FundingOperationStep[],
  snapshot: unknown,
): FundingExecutionPreflight {
  const profiles: Record<string, unknown>[] = [];
  const collect = (value: unknown): void => {
    if (!isRecord(value)) return;
    if (Array.isArray(value.profiles)) value.profiles.forEach(collect);
    else profiles.push(value);
  };
  collect(snapshot);
  let complete = true;
  const refs = new Set<string>();
  for (const step of steps) {
    if (
      [
        "succeeded",
        "failed",
        "cancelled",
        "submitted",
        "reconcile_required",
        "recovery_required",
      ].includes(step.state)
    )
      continue;
    if (!clientExecutors.has(step.executorId)) {
      if (
        [
          ...POLYMARKET_DEPOSIT_ROUTER_PROFILE_IDS,
          ...TELEGRAM_RELAY_EVM_FUNDING_PROFILE_IDS,
        ].includes(step.executorId)
      )
        continue;
      // Unknown executors must not masquerade as an empty, safe client set.
      complete = false;
      continue;
    }
    const parsed = normalizedActionSchema.safeParse(step.normalizedAction);
    if (
      !parsed.success ||
      canonicalJsonHash(parsed.data) !== step.actionFingerprint
    ) {
      complete = false;
      continue;
    }
    const action = parsed.data;
    const walletId =
      "senderWalletId" in action
        ? action.senderWalletId
        : "signerWalletId" in action
          ? action.signerWalletId
          : action.actorWalletId;
    const matches = profiles.filter(
      (profile) =>
        profile.walletId === walletId && profile.networkId === action.networkId,
    );
    const controllers = new Set(
      matches.map((profile) => profile.controllerWalletRef),
    );
    const controller = controllers.values().next().value;
    const controllerRef = opaqueIdSchema.safeParse(controller);
    if (controllers.size !== 1 || !controllerRef.success) {
      complete = false;
    } else refs.add(controllerRef.data);
  }
  return {
    operationId: operation.id,
    operationVersion: operation.version,
    complete,
    requiredControllerWalletRefs: [...refs].sort(),
  };
}

export async function readFundingExecutionPreflight(
  pool: Pick<Pool, "query">,
  userId: string,
  operation: FundingOperationRow,
  steps: readonly FundingOperationStep[],
): Promise<FundingExecutionPreflight> {
  const { rows } = await pool.query<{ wallet_execution_snapshot: unknown }>(
    `select wallet_execution_snapshot from funding_operations
      where id = $1 and user_id = $2 and version = $3`,
    [operation.id, userId, operation.version],
  );
  const result = buildFundingExecutionPreflight(
    operation,
    steps,
    rows[0]?.wallet_execution_snapshot,
  );
  return rows.length === 1 ? result : { ...result, complete: false };
}
