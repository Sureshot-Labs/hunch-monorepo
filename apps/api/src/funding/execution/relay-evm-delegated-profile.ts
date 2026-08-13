import { ethers } from "ethers";

import type { JsonValue, NormalizedAction } from "../domain/types.js";
import { sameAccountAddress } from "../domain/asset-identity.js";
import {
  BASE_USDC,
  RELAY_DEPOSITORY_V2,
  validateRelayDepositoryV2Action,
} from "../../funding-providers/relay/rehearsal.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

const ERC20 = new ethers.Interface([
  "function approve(address spender,uint256 amount)",
]);

export type RelayEvmDelegatedStepKind = "approve" | "deposit" | "cleanup";

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
  }>,
): Readonly<{ kind: RelayEvmDelegatedStepKind; orderId: string | null }> {
  const amount = positiveRaw(input.expectedRaw);
  const kind = input.actionValidationResult.relayStepKind;
  if (
    input.action.kind !== "evm_transaction" ||
    input.action.networkId !== "evm:8453" ||
    input.action.senderWalletId !== input.walletId ||
    input.action.valueRaw !== "0" ||
    amount == null ||
    !["approve", "deposit", "cleanup"].includes(String(kind))
  ) {
    throw new Error("Relay delegated action differs from its exact profile");
  }
  if (kind === "approve" || kind === "cleanup") {
    if (!sameAccountAddress("evm:8453", input.action.to, BASE_USDC)) {
      throw new Error("Relay approval token differs from Base USDC");
    }
    const decoded = ERC20.decodeFunctionData("approve", input.action.data);
    if (
      !sameAccountAddress(
        "evm:8453",
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
    token: BASE_USDC,
    user: input.walletAddress,
  });
  return { kind: "deposit", orderId };
}
