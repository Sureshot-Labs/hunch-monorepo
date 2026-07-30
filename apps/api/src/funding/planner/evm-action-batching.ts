import { stableOpaqueId } from "../../account-value/canonical.js";
import type {
  EvmTransactionAction,
  EvmTransactionBatchAction,
  NormalizedAction,
  WalletExecutionProfile,
} from "../domain/types.js";
import { canonicalJsonHash } from "../persistence/canonical.js";

export const MAX_ATOMIC_EVM_BATCH_CALLS = 8;

export type WalletExecutableActionGroup = Readonly<{
  action: NormalizedAction;
  sourceActions: readonly NormalizedAction[];
}>;

function batchEligible(
  action: NormalizedAction,
  profile: WalletExecutionProfile,
): action is EvmTransactionAction {
  return (
    action.kind === "evm_transaction" &&
    action.networkId === profile.networkId &&
    action.senderWalletId === profile.walletId &&
    profile.evmAtomicBatchMode === "privy_wallet_send_calls"
  );
}

function sameBatch(
  candidate: EvmTransactionAction,
  first: EvmTransactionAction,
): boolean {
  return (
    candidate.networkId === first.networkId &&
    candidate.senderWalletId === first.senderWalletId
  );
}

function atomicBatch(
  actions: readonly EvmTransactionAction[],
): EvmTransactionBatchAction {
  const batchIdentity = {
    kind: "evm_transaction_batch",
    networkId: actions[0]?.networkId,
    senderWalletId: actions[0]?.senderWalletId,
    calls: actions.map((action) => ({
      actionId: action.actionId,
      to: action.to,
      data: action.data,
      valueRaw: action.valueRaw,
    })),
  } as const;
  if (!batchIdentity.networkId || !batchIdentity.senderWalletId) {
    throw new Error("atomic EVM batch requires at least one action");
  }
  return {
    ...batchIdentity,
    actionId: stableOpaqueId(
      "funding_action_batch",
      canonicalJsonHash(batchIdentity),
    ),
  };
}

/**
 * Coalesces only consecutive calls that the exact wallet profile explicitly
 * declares it can execute atomically. All other actions retain their original
 * order and one-action-per-step semantics.
 */
export function groupWalletExecutableActions(input: {
  actions: readonly NormalizedAction[];
  profile: WalletExecutionProfile;
}): readonly WalletExecutableActionGroup[] {
  const groups: WalletExecutableActionGroup[] = [];
  for (let index = 0; index < input.actions.length; ) {
    const first = input.actions[index];
    if (!first) break;
    if (!batchEligible(first, input.profile)) {
      groups.push({ action: first, sourceActions: [first] });
      index += 1;
      continue;
    }

    const candidates: EvmTransactionAction[] = [first];
    let cursor = index + 1;
    while (
      cursor < input.actions.length &&
      candidates.length < MAX_ATOMIC_EVM_BATCH_CALLS
    ) {
      const candidate = input.actions[cursor];
      if (
        !candidate ||
        !batchEligible(candidate, input.profile) ||
        !sameBatch(candidate, first)
      ) {
        break;
      }
      candidates.push(candidate);
      cursor += 1;
    }

    if (candidates.length === 1) {
      groups.push({ action: first, sourceActions: [first] });
      index += 1;
      continue;
    }
    groups.push({
      action: atomicBatch(candidates),
      sourceActions: candidates,
    });
    index = cursor;
  }
  return groups;
}
