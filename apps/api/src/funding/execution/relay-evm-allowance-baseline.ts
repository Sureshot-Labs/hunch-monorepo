import type { Pool, PoolClient } from "@hunch/infra";

import {
  readRelayEvmAllowance,
  type RelayEvmAllowanceReader,
} from "./relay-evm-delegated-executor-profile.js";
import type { RelayEvmAllowanceObservation } from "./relay-evm-allowance-state.js";
import type { RelayEvmFundingProfileSpec } from "./relay-evm-profile-specs.js";
import {
  proveRelayEvmPriorApproval,
  type RelayEvmPriorApprovalProof,
} from "./relay-evm-prior-approval.js";

/**
 * Capture the immutable pre-approval allowance observation for a Relay
 * operation. The later ownership check scans every Approval mutation from
 * this block through the approved action's anchored observation.
 *
 * Receipt-origin funding and user-confirmed trade shortfalls create the same
 * Relay approval/deposit sequence, so both must persist this baseline before
 * committing an operation.
 */
export async function captureRelayEvmAllowanceBaseline(
  profile: RelayEvmFundingProfileSpec,
  input: Readonly<{
    owner: string;
    reader?: RelayEvmAllowanceReader;
  }>,
): Promise<RelayEvmAllowanceObservation> {
  const reader =
    input.reader ?? ((readInput) => readRelayEvmAllowance(profile, readInput));
  return reader({ owner: input.owner, blockNumber: null });
}

/**
 * Capture the shared Relay allowance admission fact for either a receive
 * route or a user-confirmed shortfall. A nonzero allowance is acceptable
 * only when it is a terminal Hunch approve that remains the finalized head;
 * the caller still creates a fresh exact approve before any deposit.
 */
export async function captureRelayEvmAllowanceAdmission(
  db: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  input: Readonly<{
    owner: string;
    profile: RelayEvmFundingProfileSpec;
    reader?: RelayEvmAllowanceReader;
    userId: string;
  }>,
): Promise<
  Readonly<{
    baseline: RelayEvmAllowanceObservation;
    priorApprovalProof: RelayEvmPriorApprovalProof | null;
  }>
> {
  const reader =
    input.reader ??
    ((readInput) => readRelayEvmAllowance(input.profile, readInput));
  const baseline = await captureRelayEvmAllowanceBaseline(input.profile, {
    owner: input.owner,
    reader,
  });
  if (baseline.raw === "0") return { baseline, priorApprovalProof: null };
  return {
    baseline,
    priorApprovalProof: await proveRelayEvmPriorApproval(db, {
      allowanceReader: reader,
      owner: input.owner,
      profile: input.profile,
      userId: input.userId,
    }),
  };
}

/** The exact baseline fields persisted on a funding operation. */
export function relayEvmAllowanceBaselineSupportMetadata(
  baseline: Pick<
    RelayEvmAllowanceObservation,
    "raw" | "blockNumber" | "blockHash" | "revision"
  >,
): Readonly<Record<string, string>> {
  return {
    relayApprovalBaselineAllowanceRaw: baseline.raw,
    relayApprovalBaselineAllowanceBlock: baseline.blockNumber,
    relayApprovalBaselineAllowanceBlockHash: baseline.blockHash,
    relayApprovalBaselineAllowanceRevision: baseline.revision,
  };
}
