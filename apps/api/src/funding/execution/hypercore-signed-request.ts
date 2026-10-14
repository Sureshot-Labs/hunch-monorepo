import { Signature } from "ethers";
import type { validateRelayHypercorePayloads } from "../../funding-providers/relay/hypercore-actions.js";
import { verifyHypercoreActionSignature } from "../../funding-providers/relay/hypercore-actions.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import {
  nativeFundingPreparationSchema,
  type NativeFundingSubmission,
} from "./hypercore-submission-contract.js";
import { FundingPersistenceError } from "../persistence/funding-operation-repository.js";

type Pair = ReturnType<typeof validateRelayHypercorePayloads>;
export function nativeFundingSigningPreparation(
  pair: Pair,
  submission: NativeFundingSubmission,
) {
  if (
    submission.phase !== "prepared" ||
    submission.pairFingerprint !== pair.fingerprint ||
    submission.nonce !== pair.binding.nonce ||
    submission.signer !== pair.binding.owner.toLowerCase()
  )
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Native signing preparation changed",
    );
  const signing =
    submission.stage === "nonce_mapping" ? pair.authorization : pair.transfer;
  return nativeFundingPreparationSchema.parse({
    version: 1,
    stage: submission.stage,
    expiresAt: submission.expiresAt,
    signer: submission.signer,
    digest: signing.digest,
    typedData: signing.typedData,
  });
}
/** Accept only a signature; reconstruct the POST from immutable server data. */
export function nativeFundingSignedRequest(
  pair: Pair,
  stage: NativeFundingSubmission["stage"],
  signature: string,
) {
  const typedData =
    stage === "nonce_mapping"
      ? pair.authorization.typedData
      : pair.transfer.typedData;
  let parsed: Signature;
  try {
    verifyHypercoreActionSignature(typedData, signature, pair.binding.owner);
    parsed = Signature.from(signature);
  } catch {
    // Ethers errors may embed their input signature. Neither route logs nor
    // public errors may retain sign-only authorization material.
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Invalid native action signature",
    );
  }
  if (stage === "nonce_mapping") {
    // Relay's signature-step protocol carries the signature in the query,
    // not in the POST body. Keep it separate so generic body logs cannot leak it.
    const body = pair.authorization.post.body;
    return {
      stage: "nonce_mapping" as const,
      body,
      signature: parsed.serialized,
      requestFingerprint: canonicalJsonHash({
        stage,
        body,
        signature: parsed.serialized,
      }),
    };
  }
  const body = {
    action: pair.transfer.action,
    nonce: pair.binding.nonce,
    signature: { r: parsed.r, s: parsed.s, v: parsed.v },
  };
  return {
    stage: "send_asset" as const,
    body,
    requestFingerprint: canonicalJsonHash({ stage, body }),
  };
}

/** Recovery identity, never a transaction hash or proof of a native debit. */
export function nativeFundingActionReference(pair: Pair): string {
  return `hyperliquid-action:v1:mainnet:${pair.binding.owner.toLowerCase()}:${pair.binding.nonce}:${pair.transfer.digest.toLowerCase()}`;
}
