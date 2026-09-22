import { ethers } from "ethers";
import type { JsonValue, NormalizedAction } from "../domain/types.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { FundingPersistenceError } from "../persistence/funding-operation-repository.js";
import { polymarketDepositWalletHandoffExpectation } from "./polymarket-deposit-wallet-handoff.js";
import { deriveSafeProxyAddress } from "../../services/polymarket-safe-address.js";

export const SAFE_FUNDING_SUBMISSION_METADATA =
  "Hunch existing Safe funding transfer";
export const SAFE_FUNDING_PREPARATION_LEASE_MS = 120_000;
export function safeFundingTransactionReference(
  safe: string,
  transactionHash: string,
): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash))
    throw new Error("Invalid Safe transaction hash");
  return `polymarket-safe:v1:${ethers.getAddress(safe).toLowerCase()}:${transactionHash.toLowerCase()}`;
}
export function parseSafeFundingTransactionReference(
  reference: string,
): { safe: string; transactionHash: string } | null {
  const match =
    /^polymarket-safe:v1:(0x[0-9a-fA-F]{40}):(0x[0-9a-fA-F]{64})$/.exec(
      reference,
    );
  return match?.[1] && match[2]
    ? {
        safe: match[1].toLowerCase(),
        transactionHash: match[2].toLowerCase(),
      }
    : null;
}
export type SafeFundingSubmission = {
  version: 1;
  expiresAt: string;
  phase: "prepared" | "admitted" | "closed";
  admittedAt?: string;
  requestFingerprint?: string;
  safeNonce?: string;
  safeTransactionHash?: string;
};

export function parseSafeFundingSubmission(
  value: unknown,
): SafeFundingSubmission | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(record.expiresAt)) ||
    !["prepared", "admitted", "closed"].includes(String(record.phase))
  )
    return null;
  return record as SafeFundingSubmission;
}

export const SAFE_FUNDING_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

/** Match the SDK's single Call envelope, including its eth_sign Safe signature. */
export function validateSafeFundingSubmission(input: {
  action: NormalizedAction;
  validation: Readonly<Record<string, JsonValue>>;
  request: Record<string, unknown>;
}): {
  requestFingerprint: string;
  safeNonce: string;
  safeTransactionHash: string;
} {
  try {
    const { action, validation, request } = input;
    const expectation = polymarketDepositWalletHandoffExpectation(
      action,
      validation,
    );
    if (
      action.kind !== "external_handoff" ||
      action.handoffKind !== "polymarket_safe_transfer" ||
      !expectation
    )
      throw new Error();
    const allowed = [
      "data",
      "from",
      "metadata",
      "nonce",
      "proxyWallet",
      "signature",
      "signatureParams",
      "to",
      "type",
    ];
    if (Object.keys(request).sort().join() !== allowed.sort().join())
      throw new Error();
    const owner = ethers.getAddress(String(validation.signerAddress));
    const params = request.signatureParams as
      | Record<string, unknown>
      | undefined;
    if (
      !params ||
      Object.keys(params).sort().join() !==
        [
          "baseGas",
          "gasPrice",
          "gasToken",
          "operation",
          "refundReceiver",
          "safeTxnGas",
        ]
          .sort()
          .join() ||
      request.type !== "SAFE" ||
      request.metadata !== SAFE_FUNDING_SUBMISSION_METADATA ||
      ethers.getAddress(String(request.from)) !== owner ||
      ethers.getAddress(String(request.proxyWallet)) !==
        expectation.funderAddress ||
      deriveSafeProxyAddress(owner) !== expectation.funderAddress ||
      ethers.getAddress(String(request.to)) !== expectation.tokenAddress ||
      request.data !== validation.transferData ||
      typeof request.nonce !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(request.nonce) ||
      params.operation !== "0" ||
      params.safeTxnGas !== "0" ||
      params.baseGas !== "0" ||
      params.gasPrice !== "0" ||
      ethers.getAddress(String(params.gasToken)) !== ethers.ZeroAddress ||
      ethers.getAddress(String(params.refundReceiver)) !== ethers.ZeroAddress ||
      typeof request.signature !== "string" ||
      !/^0x[0-9a-fA-F]{130}$/.test(request.signature)
    )
      throw new Error();
    const safeTransactionHash = ethers.TypedDataEncoder.hash(
      { chainId: 137, verifyingContract: expectation.funderAddress },
      SAFE_FUNDING_TX_TYPES,
      {
        to: expectation.tokenAddress,
        value: 0,
        data: request.data,
        operation: 0,
        safeTxGas: 0,
        baseGas: 0,
        gasPrice: 0,
        gasToken: ethers.ZeroAddress,
        refundReceiver: ethers.ZeroAddress,
        nonce: request.nonce,
      },
    );
    const packedV = Number.parseInt(request.signature.slice(-2), 16);
    if (packedV !== 31 && packedV !== 32) throw new Error();
    const ordinarySignature =
      request.signature.slice(0, -2) + (packedV - 4).toString(16);
    if (
      ethers.verifyMessage(
        ethers.getBytes(safeTransactionHash),
        ordinarySignature,
      ) !== owner
    )
      throw new Error();
    return {
      requestFingerprint: canonicalJsonHash(request),
      safeNonce: request.nonce,
      safeTransactionHash,
    };
  } catch {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Safe submission does not match the exact committed owner-signed transfer",
    );
  }
}
