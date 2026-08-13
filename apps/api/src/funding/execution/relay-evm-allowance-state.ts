export type RelayEvmAllowanceObservation = Readonly<{
  raw: string;
  blockNumber: string;
  blockHash: string;
  finality: "latest" | "finalized";
  revision: string;
  ownershipRevision: string | null;
  lastMutationTransactionHash: string | null;
}>;

export function parseRelayEvmAllowanceObservation(
  value: Readonly<Record<string, unknown>> | undefined,
): RelayEvmAllowanceObservation | null {
  if (
    !value ||
    typeof value.raw !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(value.raw) ||
    typeof value.blockNumber !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(value.blockNumber) ||
    typeof value.blockHash !== "string" ||
    !/^0x[0-9a-f]{64}$/iu.test(value.blockHash) ||
    (value.finality !== "latest" && value.finality !== "finalized") ||
    typeof value.revision !== "string" ||
    value.revision.length < 32
  ) {
    return null;
  }
  return {
    raw: value.raw,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash.toLowerCase(),
    finality: value.finality,
    revision: value.revision,
    ownershipRevision:
      typeof value.ownershipRevision === "string" &&
      value.ownershipRevision.length >= 32
        ? value.ownershipRevision
        : null,
    lastMutationTransactionHash:
      typeof value.lastMutationTransactionHash === "string" &&
      /^0x[0-9a-f]{64}$/iu.test(value.lastMutationTransactionHash)
        ? value.lastMutationTransactionHash.toLowerCase()
        : null,
  };
}

export function classifyRelayCleanupAllowance(
  input: Readonly<{
    currentRaw: string;
    currentRevision: string;
    ownedRaw: string | null;
    ownedRevision: string | null;
    actionOwnedRaw: unknown;
    actionOwnedRevision: unknown;
  }>,
): "already_zero" | "owned_residual" | "foreign_drift" {
  if (input.currentRaw === "0") return "already_zero";
  return input.ownedRaw === input.currentRaw &&
    input.currentRevision === input.ownedRevision &&
    input.actionOwnedRaw === input.ownedRaw &&
    input.ownedRevision !== null &&
    input.actionOwnedRevision === input.ownedRevision
    ? "owned_residual"
    : "foreign_drift";
}
