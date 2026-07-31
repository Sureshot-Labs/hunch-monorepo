import { ethers } from "ethers";

import type { JsonValue, NormalizedAction } from "../domain/types.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

const ERC20_TRANSFER_INTERFACE = new ethers.Interface([
  "function transfer(address recipient,uint256 amount)",
]);
const EVM_TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export type PolymarketDepositWalletHandoffExpectation = Readonly<{
  tokenAddress: string;
  funderAddress: string;
  recipientAddress: string;
  amountRaw: bigint;
}>;

export function polymarketDepositWalletHandoffExpectation(
  action: NormalizedAction,
  validation: JsonRecord,
): PolymarketDepositWalletHandoffExpectation | null {
  if (
    action.kind !== "external_handoff" ||
    action.networkId !== "evm:137" ||
    action.handoffKind !== "polymarket_deposit_wallet_transfer" ||
    typeof action.payload.token !== "string" ||
    typeof action.payload.funder !== "string" ||
    typeof action.payload.recipient !== "string" ||
    typeof action.payload.amountRaw !== "string" ||
    !Array.isArray(action.payload.calls) ||
    action.payload.calls.length !== 1
  ) {
    return null;
  }
  const call = action.payload.calls[0];
  if (
    typeof call !== "object" ||
    call === null ||
    Array.isArray(call) ||
    typeof call.target !== "string" ||
    typeof call.value !== "string" ||
    typeof call.data !== "string" ||
    call.value !== "0"
  ) {
    return null;
  }
  try {
    const tokenAddress = ethers.getAddress(action.payload.token);
    const funderAddress = ethers.getAddress(action.payload.funder);
    const recipientAddress = ethers.getAddress(action.payload.recipient);
    const validatedTokenAddress = ethers.getAddress(
      String(validation.tokenAddress),
    );
    const validatedFunderAddress = ethers.getAddress(
      String(validation.funderAddress),
    );
    const validatedRecipientAddress = ethers.getAddress(
      String(validation.recipientAddress),
    );
    const amountRaw = BigInt(action.payload.amountRaw);
    const decoded = ERC20_TRANSFER_INTERFACE.decodeFunctionData(
      "transfer",
      call.data,
    );
    if (
      amountRaw <= 0n ||
      ethers.getAddress(call.target) !== tokenAddress ||
      ethers.getAddress(String(decoded[0])) !== recipientAddress ||
      BigInt(decoded[1]) !== amountRaw ||
      validation.executionEnvelope !==
        "polymarket_deposit_wallet_to_controller_v1" ||
      validatedTokenAddress !== tokenAddress ||
      validatedFunderAddress !== funderAddress ||
      validatedRecipientAddress !== recipientAddress ||
      validation.amountRaw !== amountRaw.toString() ||
      validation.transferData !== call.data
    ) {
      return null;
    }
    return {
      tokenAddress,
      funderAddress,
      recipientAddress,
      amountRaw,
    };
  } catch {
    return null;
  }
}

export function normalizePolymarketDepositWalletTransactionReference(
  action: NormalizedAction,
  validation: JsonRecord,
  reference: string,
): string {
  const trimmed = reference.trim();
  return polymarketDepositWalletHandoffExpectation(action, validation) &&
    EVM_TRANSACTION_HASH_PATTERN.test(trimmed)
    ? trimmed.toLowerCase()
    : reference;
}
