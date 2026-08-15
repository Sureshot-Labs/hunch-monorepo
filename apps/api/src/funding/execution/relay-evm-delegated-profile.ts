import { ethers } from "ethers";

import type { JsonValue, NormalizedAction } from "../domain/types.js";
import { sameAccountAddress } from "../domain/asset-identity.js";
import {
  RELAY_DEPOSITORY_V2,
  validateRelayDepositoryV2Action,
} from "../../funding-providers/relay/rehearsal.js";
import {
  RELAY_EVM_FUNDING_PROFILE_SPECS,
  type RelayEvmFundingProfileSpec,
} from "./relay-evm-profile-specs.js";
import { TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID } from "./delegated-funding-profile-ids.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

const ERC20 = new ethers.Interface([
  "function approve(address spender,uint256 amount)",
]);
const PULLER = new ethers.Interface([
  "function pullPusd(uint256 expectedNonce,uint256 amount)",
]);

export type RelayEvmDelegatedStepKind =
  | "source_pull"
  | "approve"
  | "deposit"
  | "cleanup";

function positiveRaw(value: string): bigint | null {
  return /^[1-9][0-9]*$/u.test(value) ? BigInt(value) : null;
}

export function validateRelayDelegatedEvmAction(
  input: Readonly<{
    action: NormalizedAction;
    actionValidationResult: JsonRecord;
    expectedRaw: string;
    walletAddress: string;
    walletId: string;
    profile?: RelayEvmFundingProfileSpec;
  }>,
): Readonly<{ kind: RelayEvmDelegatedStepKind; orderId: string | null }> {
  const amount = positiveRaw(input.expectedRaw);
  const profile =
    input.profile ??
    RELAY_EVM_FUNDING_PROFILE_SPECS[TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID];
  if (!profile) throw new Error("Relay delegated profile is unavailable");
  const kind = input.actionValidationResult.relayStepKind;
  if (
    input.action.kind !== "evm_transaction" ||
    input.action.networkId !== profile.sourceAsset.networkId ||
    input.action.senderWalletId !== input.walletId ||
    input.action.valueRaw !== "0" ||
    amount == null ||
    !["source_pull", "approve", "deposit", "cleanup"].includes(String(kind))
  ) {
    throw new Error("Relay delegated action differs from its exact profile");
  }
  if (kind === "source_pull") {
    const puller =
      fundingSidecarRuntimeConfig.polymarketDepositWalletPullerAddress;
    const expectedNonce = input.actionValidationResult.pullNonce;
    const expectedSourceRaw = input.actionValidationResult.expectedSourceRaw;
    if (
      profile.sourceAsset.networkId !== "evm:137" ||
      !sameAccountAddress(
        profile.sourceAsset.networkId,
        profile.sourceAsset.assetId,
        fundingSidecarRuntimeConfig.polymarketPusdAddress,
      ) ||
      !puller ||
      !sameAccountAddress(
        profile.sourceAsset.networkId,
        input.action.to,
        puller,
      ) ||
      typeof expectedNonce !== "string" ||
      !/^(0|[1-9][0-9]*)$/u.test(expectedNonce) ||
      expectedSourceRaw !== input.expectedRaw
    )
      throw new Error(
        "Relay source pull differs from its exact Puller profile",
      );
    const decoded = PULLER.decodeFunctionData("pullPusd", input.action.data);
    if (
      BigInt(decoded.expectedNonce) !== BigInt(expectedNonce) ||
      BigInt(decoded.amount) !== amount
    )
      throw new Error("Relay source pull nonce or amount differs");
    return { kind: "source_pull", orderId: null };
  }
  if (kind === "approve" || kind === "cleanup") {
    if (
      !sameAccountAddress(
        profile.sourceAsset.networkId,
        input.action.to,
        profile.sourceAsset.assetId,
      )
    ) {
      throw new Error("Relay approval token differs from its exact profile");
    }
    const decoded = ERC20.decodeFunctionData("approve", input.action.data);
    if (
      !sameAccountAddress(
        profile.sourceAsset.networkId,
        String(decoded.spender),
        RELAY_DEPOSITORY_V2,
      ) ||
      BigInt(decoded.amount) !== (kind === "cleanup" ? 0n : amount)
    ) {
      throw new Error("Relay approval spender or amount differs");
    }
    return { kind, orderId: null };
  }
  const orderId = validateRelayDepositoryV2Action({
    action: {
      data: input.action.data,
      to: input.action.to,
      value: BigInt(input.action.valueRaw),
    },
    amount,
    token: profile.sourceAsset.assetId,
    user: input.walletAddress,
    depositorMode: "self_bound",
  });
  return { kind: "deposit", orderId };
}
