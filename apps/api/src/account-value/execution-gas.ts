import type { AccountValueReadModel } from "./runtime-service.js";
import type { WalletExecutionProfile } from "../funding/domain/types.js";
import {
  sameAccountAddress,
  canonicalAssetId,
} from "../funding/domain/asset-identity.js";
import {
  SOLANA_NATIVE_ASSET,
  SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS,
} from "../funding/domain/network-fees.js";
import { PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID } from "../funding/execution/sponsorship-policy.js";

export type ExecutionGas = Readonly<{
  status: "ready" | "needs_gas" | "unknown";
  sponsored: boolean;
  networkId: string;
  requiredRaw: string;
  availableRaw: string | null;
  shortfallRaw: string | null;
}>;

/** Gas-only readiness, not a promise that any particular funding route exists. */
export function deriveExecutionGas(
  account: Pick<
    AccountValueReadModel,
    "projection" | "cashAvailability" | "nativeGasBalances"
  >,
  profile: WalletExecutionProfile,
): ExecutionGas {
  const sponsored =
    profile.sponsorshipPolicyIds.includes(
      PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID,
    ) &&
    profile.signingModes.includes("privy_authorization") &&
    Boolean(profile.serverWalletRef);
  const required = sponsored
    ? 0n
    : profile.networkId === "solana:mainnet"
      ? SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS
      : 1n;
  const base = {
    sponsored,
    networkId: profile.networkId,
    requiredRaw: required.toString(),
  };
  if (sponsored)
    return { ...base, status: "ready", availableRaw: null, shortfallRaw: "0" };
  const nativeId =
    profile.networkId === "solana:mainnet"
      ? SOLANA_NATIVE_ASSET.assetId
      : "0x0000000000000000000000000000000000000000";
  let availableRaw: bigint | null = null;
  const nativeObservation = account.nativeGasBalances?.find(
    (observation) =>
      observation.networkId === profile.networkId &&
      sameAccountAddress(
        profile.networkId,
        observation.address,
        profile.address,
      ),
  );
  if (nativeObservation) availableRaw = BigInt(nativeObservation.raw);
  for (const component of account.projection.components) {
    const address = component.location.details.address;
    if (
      component.location.kind !== "wallet" ||
      typeof address !== "string" ||
      component.amount.asset.networkId !== profile.networkId ||
      canonicalAssetId(component.amount.asset) !==
        canonicalAssetId({ ...component.amount.asset, assetId: nativeId }) ||
      !sameAccountAddress(profile.networkId, address, profile.address)
    )
      continue;
    const available = account.cashAvailability.components.find(
      (row) => row.componentId === component.componentId,
    );
    // A missing USD price does not invalidate a fresh raw native balance.
    if (
      component.observationFreshness !== "fresh" ||
      component.observationError ||
      !available ||
      available.reasonCodes.includes("cash_availability_unknown")
    )
      continue;
    const raw = BigInt(available.availableRaw);
    if (availableRaw == null || raw > availableRaw) availableRaw = raw;
  }
  if (availableRaw == null)
    return {
      ...base,
      status: "unknown",
      availableRaw: null,
      shortfallRaw: null,
    };
  return {
    ...base,
    status: availableRaw >= required ? "ready" : "needs_gas",
    availableRaw: availableRaw.toString(),
    shortfallRaw: (availableRaw < required
      ? required - availableRaw
      : 0n
    ).toString(),
  };
}
