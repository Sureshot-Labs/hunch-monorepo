import { getAddress } from "ethers";
import { isRecord } from "../lib/type-guards.js";
import {
  buildLimitlessClobSubmissionContext,
  type LimitlessClobSubmissionContext,
} from "./limitless-clob-evidence-identity.js";
import { LIMITLESS_CLOB_ORDER_TYPES } from "./limitless-order-contract.js";

export type RetainedLimitlessCopySubmission = {
  context: LimitlessClobSubmissionContext;
  order: Record<string, string>;
};

/** The context must come from server-resolved signing, never a client/provider domain.
 * Retain only signed EIP-712 fields: signatures, auth and arbitrary extras are not proof.
 */
export function retainLimitlessCopySubmission(input: {
  order: unknown;
  context: unknown;
  walletAddress: string;
  tokenId: string;
}): RetainedLimitlessCopySubmission | null {
  if (!isRecord(input.order) || !isRecord(input.context)) return null;
  const context = input.context;
  if (
    context.contextVersion !== 1 ||
    context.chainId !== 8453 ||
    typeof context.exchangeAddress !== "string" ||
    typeof context.orderHash !== "string"
  )
    return null;
  try {
    const order: Record<string, string> = {};
    for (const field of LIMITLESS_CLOB_ORDER_TYPES.Order) {
      const value = input.order[field.name];
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "bigint"
      )
        return null;
      order[field.name] = String(value);
    }
    if (
      getAddress(order.maker) !== getAddress(input.walletAddress) ||
      getAddress(order.signer) !== getAddress(input.walletAddress) ||
      BigInt(order.tokenId) !==
        BigInt(input.tokenId.replace(/^limitless:/, "")) ||
      BigInt(order.side) !== 0n
    )
      return null;
    const expected = buildLimitlessClobSubmissionContext(
      context.exchangeAddress,
      order,
    );
    if (expected.orderHash !== context.orderHash.toLowerCase()) return null;
    return { context: expected, order };
  } catch {
    return null;
  }
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
