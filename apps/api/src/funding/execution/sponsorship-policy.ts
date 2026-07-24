import type {
  NormalizedAction,
  WalletExecutionProfile,
} from "../domain/types.js";

export const PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID =
  "privy_user_authorized_evm_sponsorship_v1";

const MAX_SPONSORED_EVM_GAS_LIMIT = 3_000_000n;

export type ResolvedActionSponsorship = Readonly<{
  payerRequirement: "user" | "privy_sponsor";
  policyId: string | null;
  signingMode: "web_client" | "privy_authorization";
}>;

function unsignedRaw(value: string): bigint | null {
  return /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
}

/**
 * This is Hunch's local sponsorship capability, not a claim that a wallet ID
 * alone grants gas payment. Privy remains the final enforcement boundary.
 * The caller must additionally run the route-specific immutable action
 * validator before this result can be committed or executed.
 */
export function resolveActionSponsorship(input: {
  action: NormalizedAction;
  profile: WalletExecutionProfile;
}): ResolvedActionSponsorship {
  const actionWalletId =
    input.action.kind === "evm_transaction"
      ? input.action.senderWalletId
      : input.action.kind === "external_handoff"
        ? input.action.actorWalletId
        : input.action.signerWalletId;
  if (
    input.profile.walletId !== actionWalletId ||
    input.profile.networkId !== input.action.networkId
  ) {
    throw new Error(
      "sponsorship profile does not match the exact action signer and network",
    );
  }
  if (
    input.action.kind === "evm_transaction" &&
    input.profile.serverWalletRef &&
    input.profile.source !== "external" &&
    input.profile.signingModes.includes("privy_authorization") &&
    input.profile.sponsorshipPolicyIds.includes(
      PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID,
    )
  ) {
    const gasLimit = input.action.gasLimitRaw
      ? unsignedRaw(input.action.gasLimitRaw)
      : null;
    const value = unsignedRaw(input.action.valueRaw);
    if (
      value == null ||
      (gasLimit != null &&
        (gasLimit <= 0n || gasLimit > MAX_SPONSORED_EVM_GAS_LIMIT))
    ) {
      throw new Error(
        "Privy sponsorship action gas or native value is outside policy",
      );
    }
    return {
      payerRequirement: "privy_sponsor",
      policyId: PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID,
      signingMode: "privy_authorization",
    };
  }
  return {
    payerRequirement: "user",
    policyId: null,
    signingMode: "web_client",
  };
}
