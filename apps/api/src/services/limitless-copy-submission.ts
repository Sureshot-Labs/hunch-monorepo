import { isRecord } from "../lib/type-guards.js";
import {
  readRetainedLimitlessClobSubmission,
  type RetainedLimitlessClobSubmission,
} from "./limitless-clob-evidence-identity.js";

export type RetainedLimitlessCopySubmission = RetainedLimitlessClobSubmission;

/** The context must come from server-resolved signing, never a client/provider domain.
 * Retain only signed EIP-712 fields: signatures, auth and arbitrary extras are not proof.
 */
export function retainLimitlessCopySubmission(input: {
  order: unknown;
  context: unknown;
  walletAddress: string;
  tokenId: string;
}): RetainedLimitlessCopySubmission | null {
  return readRetainedLimitlessClobSubmission(input, { ...input, side: "BUY" });
}

/** Source snapshots are server-retained before submit, not provider status payloads. */
export function readLimitlessCopySubmission(
  value: unknown,
  identity: { walletAddress: string; tokenId: string },
): RetainedLimitlessCopySubmission | null {
  return isRecord(value)
    ? retainLimitlessCopySubmission({
        ...identity,
        order: value.order,
        context: value.context,
      })
    : null;
}
