import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";

/** Verify the unchanged prepared message and every required signature before retaining identity. */
export function verifySocialSolanaSubmission(input: {
  preparedTransaction?: string;
  signedTransaction: string;
  owner: string;
}): { signature: string; messageDigestBytes: Uint8Array } {
  const bytes = Buffer.from(input.signedTransaction, "base64");
  if (
    bytes.length > 1232 ||
    bytes.toString("base64") !== input.signedTransaction
  )
    throw new Error("Invalid Solana transaction encoding");
  const signed = VersionedTransaction.deserialize(bytes);
  const message = signed.message.serialize();
  if (
    input.preparedTransaction &&
    !Buffer.from(message).equals(
      Buffer.from(
        VersionedTransaction.deserialize(
          Buffer.from(input.preparedTransaction, "base64"),
        ).message.serialize(),
      ),
    )
  )
    throw new Error("Signed transaction changed the prepared message");
  const required = signed.message.header.numRequiredSignatures;
  const signers = signed.message.staticAccountKeys.slice(0, required);
  if (
    !signers.some((key) => key.toBase58() === input.owner) ||
    signed.signatures.length !== required
  )
    throw new Error("Copy transaction owner is not a required signer");
  for (let index = 0; index < required; index++) {
    const signature = signed.signatures[index],
      key = signers[index];
    if (
      !signature ||
      !key ||
      !verify(
        null,
        message,
        createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            key.toBuffer(),
          ]),
          format: "der",
          type: "spki",
        }),
        signature,
      )
    )
      throw new Error("Invalid Copy transaction signature");
  }
  const initiatingSignature = signed.signatures[0];
  if (!initiatingSignature)
    throw new Error("Missing initiating transaction signature");
  return {
    signature: bs58.encode(initiatingSignature),
    messageDigestBytes: message,
  };
}
