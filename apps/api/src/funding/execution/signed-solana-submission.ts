import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import {
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import type { SvmTransactionAction } from "../domain/types.js";
import { relaySolanaActionMessage } from "../../funding-providers/relay/solana-sponsorship.js";
import { matchesFundingMessageWithComputeBudget } from "./solana-compute-budget.js";

export class SignedSolanaSubmissionError extends Error {
  constructor(
    readonly reason:
      | "encoding"
      | "size"
      | "serialization"
      | "signer_count"
      | "missing_signature"
      | "message_mismatch"
      | "signature_invalid",
  ) {
    super(
      {
        encoding: "Invalid signed Solana transaction encoding",
        size: "Invalid signed Solana transaction size",
        serialization: "Invalid signed Solana transaction serialization",
        signer_count: "Funding submission requires exactly one source signer",
        missing_signature: "Funding signature is missing",
        message_mismatch:
          "Signed funding message does not match committed action",
        signature_invalid: "Funding transaction signature is invalid",
      }[reason],
    );
    this.name = "SignedSolanaSubmissionError";
  }
}

/** Validates identity, not permission to broadcast. Caller must bind the owned
 * operation/attempt and atomically retain this identity before sending bytes.
 * No wallet secret or sponsorship is involved in external signed submissions.
 */
export function verifySignedSolanaFundingSubmission(input: {
  action: SvmTransactionAction;
  signer: string;
  signedTransaction: string;
  lookupTables: AddressLookupTableAccount[];
}): Readonly<{ signature: string; blockhash: string }> {
  if (
    input.signedTransaction.length > 1644 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.signedTransaction)
  ) {
    throw new SignedSolanaSubmissionError("encoding");
  }
  const bytes = Buffer.from(input.signedTransaction, "base64");
  if (
    bytes.length > 1232 ||
    bytes.toString("base64") !== input.signedTransaction
  ) {
    throw new SignedSolanaSubmissionError("size");
  }
  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(bytes);
  } catch {
    throw new SignedSolanaSubmissionError("serialization");
  }
  if (transaction.signatures.length !== 1) {
    throw new SignedSolanaSubmissionError("signer_count");
  }
  const signature = transaction.signatures[0];
  if (!signature) throw new SignedSolanaSubmissionError("missing_signature");
  const expected = relaySolanaActionMessage(
    input.action,
    input.signer,
    transaction.message.recentBlockhash,
  ).compileToV0Message(input.lookupTables);
  if (
    !matchesFundingMessageWithComputeBudget(
      expected,
      transaction.message,
      input.lookupTables,
    )
  ) {
    throw new SignedSolanaSubmissionError("message_mismatch");
  }
  const publicKey = bs58.decode(input.signer);
  if (
    publicKey.length !== 32 ||
    !verify(
      null,
      transaction.message.serialize(),
      createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(publicKey),
        ]),
        format: "der",
        type: "spki",
      }),
      signature,
    )
  ) {
    throw new SignedSolanaSubmissionError("signature_invalid");
  }
  return {
    signature: bs58.encode(signature),
    blockhash: transaction.message.recentBlockhash,
  };
}

export type VerifiedSolanaSubmission = Readonly<{
  version: 1;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
}>;

export type SolanaSigningContext = Readonly<{
  blockhash: string;
  lastValidBlockHeight: number;
}>;

export function parseSolanaSigningContext(
  value: unknown,
): SolanaSigningContext | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.blockhash !== "string" ||
    !Number.isSafeInteger(row.lastValidBlockHeight) ||
    Number(row.lastValidBlockHeight) <= 0
  )
    return null;
  try {
    if (bs58.decode(row.blockhash).length !== 32) return null;
  } catch {
    return null;
  }
  return {
    blockhash: row.blockhash,
    lastValidBlockHeight: Number(row.lastValidBlockHeight),
  };
}

export function parseVerifiedSolanaSubmission(
  value: unknown,
): VerifiedSolanaSubmission | null {
  const context = parseSolanaSigningContext(value);
  if (!context) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.signature !== "string") return null;
  try {
    if (bs58.decode(row.signature).length !== 64) return null;
  } catch {
    return null;
  }
  return { version: 1, signature: row.signature, ...context };
}
