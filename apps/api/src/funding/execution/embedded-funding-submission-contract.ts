import {
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import type { NormalizedAction } from "../domain/types.js";
import { FundingPersistenceError } from "../persistence/funding-operation-repository.js";
import { relaySolanaActionMessage } from "../../funding-providers/relay/solana-sponsorship.js";

export const EMBEDDED_FUNDING_PREPARATION_LEASE_MS = 120_000;
export type EmbeddedFundingContext = {
  operationId: string;
  stepId: string;
  attemptId: string;
};
export type EmbeddedFundingSubmission = {
  version: 1;
  phase: "prepared" | "admitted" | "closed";
  expiresAt: string;
  signer: string;
  payer: "user" | "privy_sponsor";
  requestFingerprint?: string;
  admittedAt?: string;
};
export function parseEmbeddedFundingSubmission(
  value: unknown,
): EmbeddedFundingSubmission | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return row.version === 1 &&
    ["prepared", "admitted", "closed"].includes(String(row.phase)) &&
    typeof row.expiresAt === "string" &&
    Number.isFinite(Date.parse(row.expiresAt)) &&
    typeof row.signer === "string" &&
    ["user", "privy_sponsor"].includes(String(row.payer))
    ? (row as EmbeddedFundingSubmission)
    : null;
}
export function embeddedFundingExecutionKey(
  context: EmbeddedFundingContext,
): string {
  return `funding:v1:${context.attemptId}`;
}
export function assertEmbeddedExecutionScope(
  executionKey: string | null | undefined,
  context?: EmbeddedFundingContext,
): void {
  if (!context && executionKey?.startsWith("funding:v1:"))
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Funding authorization requires its scoped submission context",
    );
}
export function assertEmbeddedFundingAuthorizationSignatures(
  requests: readonly { id: string }[],
  signatures: readonly { id: string; signature: string }[],
): void {
  if (
    requests.length !== 1 ||
    signatures.length !== 1 ||
    !requests[0] ||
    !signatures[0] ||
    requests[0].id !== signatures[0].id ||
    !signatures[0].signature.trim()
  )
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Funding requires the exact prepared authorization signature",
    );
}
export type EmbeddedFundingPayload =
  | {
      kind: "ethereum";
      signer: string;
      chainId: number;
      executionMode: "sequential" | "atomic";
      returnOnAccepted: boolean;
      transactions: readonly {
        to: string;
        data: string;
        value?: string;
        gas?: string;
        sponsor?: boolean;
      }[];
    }
  | {
      kind: "solana";
      signer: string;
      transactions: readonly {
        transaction: string;
        sponsor?: boolean;
        caip2?: string | null;
      }[];
      lookupTables: AddressLookupTableAccount[];
    };
/** This checks the exact owned immutable action, never a client execution key. */
export function validateEmbeddedFundingPayload(
  action: NormalizedAction,
  lease: EmbeddedFundingSubmission,
  payload: EmbeddedFundingPayload,
): void {
  const mismatch = () => {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Embedded funding request does not match its committed action",
    );
  };
  const addressEqual = (a: string, b: string) =>
    payload.kind === "ethereum" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (
    !addressEqual(lease.signer, payload.signer) ||
    payload.transactions.some(
      (entry) =>
        (payload.kind === "ethereum"
          ? entry.sponsor !== false
          : entry.sponsor === true) !==
        (lease.payer === "privy_sponsor"),
    )
  )
    mismatch();
  if (payload.kind === "ethereum") {
    if (
      (action.kind !== "evm_transaction" &&
        action.kind !== "evm_transaction_batch") ||
      action.networkId !== `evm:${payload.chainId}` ||
      !payload.returnOnAccepted
    )
      return mismatch();
    const calls = action.kind === "evm_transaction" ? [action] : action.calls;
    if (
      payload.executionMode !==
        (action.kind === "evm_transaction_batch" ? "atomic" : "sequential") ||
      calls.length !== payload.transactions.length
    )
      return mismatch();
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      const actual = payload.transactions[index];
      if (!call || !actual) return mismatch();
      try {
        if (
          !addressEqual(call.to, actual.to) ||
          call.data.toLowerCase() !== actual.data.toLowerCase() ||
          BigInt(call.valueRaw) !== BigInt(actual.value ?? "0") ||
          (action.kind === "evm_transaction" &&
            (action.gasLimitRaw === null
              ? actual.gas !== undefined
              : BigInt(action.gasLimitRaw) !== BigInt(actual.gas ?? "0"))) ||
          (action.kind === "evm_transaction_batch" && actual.gas !== undefined)
        )
          mismatch();
      } catch {
        mismatch();
      }
    }
    return;
  }
  if (
    action.kind !== "svm_transaction" ||
    action.networkId !== "solana:mainnet" ||
    payload.transactions.length !== 1
  )
    return mismatch();
  const entry = payload.transactions[0];
  if (!entry) return mismatch();
  if (entry.caip2 && entry.caip2 !== "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
    return mismatch();
  try {
    const actual = VersionedTransaction.deserialize(
      Buffer.from(entry.transaction, "base64"),
    );
    const expected = relaySolanaActionMessage(
      action,
      payload.signer,
      actual.message.recentBlockhash,
    ).compileToV0Message(payload.lookupTables);
    if (
      !Buffer.from(expected.serialize()).equals(
        Buffer.from(actual.message.serialize()),
      ) ||
      actual.signatures.some((signature) =>
        signature.some((byte) => byte !== 0),
      )
    )
      mismatch();
  } catch {
    mismatch();
  }
}
