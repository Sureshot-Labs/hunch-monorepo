import { ethers } from "ethers";

import { RELAY_PINNED_ASSETS } from "../../funding-providers/relay/mappings.js";
import { POLYMARKET_COLLATERAL_ONRAMP } from "../../funding-providers/relay/rehearsal.js";
import type { JsonValue, NormalizedAction } from "../domain/types.js";
import { parsePrivyFundingTransactionReference } from "./privy-transaction-reference.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

const ERC20_TRANSFER_INTERFACE = new ethers.Interface([
  "function transfer(address recipient,uint256 amount)",
]);
const ERC20_APPROVE_INTERFACE = new ethers.Interface([
  "function approve(address spender,uint256 amount)",
]);
const POLYMARKET_COLLATERAL_INTERFACE = new ethers.Interface([
  "function wrap(address asset,address recipient,uint256 amount)",
]);
const EVM_TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const POLYMARKET_RELAYER_TRANSACTION_REFERENCE_PREFIX =
  "polymarket-relayer:v1:";
const POLYMARKET_RELAYER_TRANSACTION_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/u;

// The relayer may accept a request before exposing its transaction hash. A
// chain-only Transfer can be attributed to that request only inside this
// immutable window; later exact provider evidence remains authoritative.
export const POLYMARKET_HANDOFF_CHAIN_ATTRIBUTION_WINDOW_MS = 90_000;

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
    !Array.isArray(action.payload.calls)
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
    const calls = action.payload.calls.map((call) => {
      if (
        typeof call !== "object" ||
        call === null ||
        Array.isArray(call) ||
        typeof call.target !== "string" ||
        typeof call.value !== "string" ||
        typeof call.data !== "string" ||
        call.value !== "0"
      ) {
        throw new Error("invalid handoff call");
      }
      return {
        target: ethers.getAddress(call.target),
        data: call.data,
      };
    });
    const convertsUsdce =
      action.payload.conversionKind === "polymarket_usdce_to_pusd";
    const transferCall = calls.at(-1);
    if (!transferCall) return null;
    const decodedTransfer = ERC20_TRANSFER_INTERFACE.decodeFunctionData(
      "transfer",
      transferCall.data,
    );
    const baseEnvelopeMatches =
      amountRaw > 0n &&
      transferCall.target === tokenAddress &&
      ethers.getAddress(String(decodedTransfer[0])) === recipientAddress &&
      BigInt(decodedTransfer[1]) === amountRaw &&
      validatedTokenAddress === tokenAddress &&
      validatedFunderAddress === funderAddress &&
      validatedRecipientAddress === recipientAddress &&
      validation.amountRaw === amountRaw.toString() &&
      validation.transferData === transferCall.data;
    if (!baseEnvelopeMatches) return null;
    if (!convertsUsdce) {
      if (
        calls.length !== 1 ||
        validation.executionEnvelope !==
          "polymarket_deposit_wallet_to_controller_v1"
      ) {
        return null;
      }
    } else {
      if (
        calls.length !== 3 ||
        action.payload.sourceToken !== RELAY_PINNED_ASSETS.polygonUsdce ||
        tokenAddress.toLowerCase() !== RELAY_PINNED_ASSETS.polygonPusd ||
        validation.executionEnvelope !==
          "polymarket_deposit_wallet_to_controller_v1" ||
        validation.conversionKind !== "polymarket_usdce_to_pusd" ||
        typeof validation.sourceTokenAddress !== "string" ||
        ethers.getAddress(validation.sourceTokenAddress).toLowerCase() !==
          RELAY_PINNED_ASSETS.polygonUsdce ||
        typeof validation.collateralOnrampAddress !== "string" ||
        ethers.getAddress(validation.collateralOnrampAddress) !==
          ethers.getAddress(POLYMARKET_COLLATERAL_ONRAMP) ||
        typeof validation.signerAddress !== "string" ||
        ethers.getAddress(validation.signerAddress) !== recipientAddress
      ) {
        return null;
      }
      const approval = calls[0];
      const wrap = calls[1];
      if (!approval || !wrap) return null;
      const decodedApproval = ERC20_APPROVE_INTERFACE.decodeFunctionData(
        "approve",
        approval.data,
      );
      const decodedWrap = POLYMARKET_COLLATERAL_INTERFACE.decodeFunctionData(
        "wrap",
        wrap.data,
      );
      if (
        approval.target.toLowerCase() !== RELAY_PINNED_ASSETS.polygonUsdce ||
        ethers.getAddress(String(decodedApproval[0])) !==
          ethers.getAddress(POLYMARKET_COLLATERAL_ONRAMP) ||
        BigInt(decodedApproval[1]) !== amountRaw ||
        wrap.target !== ethers.getAddress(POLYMARKET_COLLATERAL_ONRAMP) ||
        ethers.getAddress(String(decodedWrap[0])).toLowerCase() !==
          RELAY_PINNED_ASSETS.polygonUsdce ||
        ethers.getAddress(String(decodedWrap[1])) !== funderAddress ||
        BigInt(decodedWrap[2]) !== amountRaw
      ) {
        return null;
      }
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

export type PolymarketDepositWalletTransactionReference = Readonly<{
  kind: "external_handoff" | "provider_receipt" | "transaction";
  reference: string;
}>;

export function polymarketRelayerTransactionReference(
  transactionId: string,
): string {
  const trimmed = transactionId.trim();
  if (!POLYMARKET_RELAYER_TRANSACTION_ID_PATTERN.test(trimmed)) {
    throw new Error("Polymarket relayer transaction ID is invalid");
  }
  return `${POLYMARKET_RELAYER_TRANSACTION_REFERENCE_PREFIX}${trimmed}`;
}

export function parsePolymarketRelayerTransactionReference(
  reference: string,
): string | null {
  const trimmed = reference.trim();
  if (!trimmed.startsWith(POLYMARKET_RELAYER_TRANSACTION_REFERENCE_PREFIX)) {
    return null;
  }
  const transactionId = trimmed.slice(
    POLYMARKET_RELAYER_TRANSACTION_REFERENCE_PREFIX.length,
  );
  return POLYMARKET_RELAYER_TRANSACTION_ID_PATTERN.test(transactionId)
    ? transactionId
    : null;
}

export function normalizePolymarketDepositWalletTransactionReference(
  action: NormalizedAction,
  validation: JsonRecord,
  reference: string,
): PolymarketDepositWalletTransactionReference {
  const trimmed = reference.trim();
  if (
    (action.kind === "evm_transaction" ||
      action.kind === "evm_transaction_batch") &&
    parsePrivyFundingTransactionReference(trimmed)
  ) {
    return { kind: "provider_receipt", reference: trimmed };
  }
  const handoff = polymarketDepositWalletHandoffExpectation(action, validation);
  if (handoff && EVM_TRANSACTION_HASH_PATTERN.test(trimmed)) {
    return { kind: "transaction", reference: trimmed.toLowerCase() };
  }
  if (handoff && parsePolymarketRelayerTransactionReference(trimmed)) {
    return { kind: "external_handoff", reference: trimmed };
  }
  return { kind: "transaction", reference };
}
