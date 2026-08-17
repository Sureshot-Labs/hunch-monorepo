import {
  readRelayEvmAllowance,
  type RelayEvmAllowanceReader,
} from "./relay-evm-delegated-executor-profile.js";
import type { RelayEvmAllowanceObservation } from "./relay-evm-allowance-state.js";
import type { RelayEvmFundingProfileSpec } from "./relay-evm-profile-specs.js";

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
