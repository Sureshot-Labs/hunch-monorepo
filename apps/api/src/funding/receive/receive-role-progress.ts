import { z } from "zod";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../reconciliation/owned-route-destination-observer.js";

export const receiveRoleProgressBaseSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["continuation", "complete"]),
    eventFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    facts: z
      .object({
        userId: z.uuid(),
        operationId: z.uuid(),
        revision: z
          .string()
          .regex(/^(0|[1-9][0-9]{0,18})$/)
          .refine((value) => BigInt(value) <= 9223372036854775807n),
      })
      .strict(),
    cursor: z
      .object({
        stepOrdinal: z.number().int().min(0).max(2147483647),
        attemptNumber: z.number().int().min(0).max(2147483647),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** Bind derived summaries to the frozen physical envelope, not poll time or
 * current marks. The event is already read from the canonical E lease. No raw
 * transaction/provider references or addresses are persisted in a summary.
 */
export function receiveRoleEventFingerprint(
  event: OwnedRouteCanonicalDestinationEvent,
): string {
  return canonicalJsonHash({
    networkId: event.networkId,
    asset: { ...event.asset, assetId: event.asset.assetId.toLowerCase() },
    transactionHash: event.transactionHash.toLowerCase(),
    eventIndex: event.eventIndex,
    sourceAddress: event.sourceAddress?.toLowerCase() ?? null,
    destinationAddress: event.destinationAddress.toLowerCase(),
    rawAmount: event.rawAmount,
    ledgerHeight: event.ledgerHeight,
    blockHash: event.blockHash?.toLowerCase() ?? null,
    nativeEvidence: event.nativeEvidence ?? null,
  });
}
