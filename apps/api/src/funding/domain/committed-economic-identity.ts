import { isRecord } from "../../lib/type-guards.js";
import { assetLocationSchema } from "./schemas.js";

export type CommittedFundingIdentity = Readonly<{
  currentOwnerUserId: string;
  originalEconomicAccountId: string;
}>;

type SourceIdentity =
  | Readonly<{ kind: "owned"; accountId: string }>
  | Readonly<{ kind: "unscoped" | "invalid" }>;

/** Only documented committed source shapes are identity anchors. Never search
 * arbitrary metadata for an accountId or infer a merge from its timestamp. */
function operationSourceIdentity(snapshot: unknown): SourceIdentity {
  if (!isRecord(snapshot)) return { kind: "unscoped" };
  const rawOwned = ["owned_location", "wallet", "venue_account"].includes(
    String(snapshot.kind),
  );
  const source =
    !rawOwned && isRecord(snapshot.source) ? snapshot.source : snapshot;
  if (source.kind === "composite") {
    if (
      !Array.isArray(snapshot.sourceLegs) ||
      snapshot.sourceLegs.length === 0 ||
      source.legCount !== snapshot.sourceLegs.length
    )
      return { kind: "invalid" };
    const owners = new Set<string>();
    for (const leg of snapshot.sourceLegs) {
      if (
        !isRecord(leg) ||
        !isRecord(leg.source) ||
        !["owned_location", "external_ingress", "venue_preparation"].includes(
          String(leg.source.kind),
        )
      )
        return { kind: "invalid" };
      const identity = operationSourceIdentity(leg.source);
      if (identity.kind === "invalid") return identity;
      if (identity.kind === "owned") owners.add(identity.accountId);
    }
    if (owners.size > 1) return { kind: "invalid" };
    return owners.size === 1
      ? { kind: "owned", accountId: [...owners][0] }
      : { kind: "unscoped" };
  }
  if (
    source.kind === "owned_location" ||
    source.kind === "wallet" ||
    source.kind === "venue_account"
  ) {
    const location = assetLocationSchema.safeParse(
      source.kind === "owned_location" ? source.location : source,
    );
    return location.success
      ? { kind: "owned", accountId: location.data.accountId }
      : { kind: "invalid" };
  }
  return { kind: "unscoped" };
}

/** Relational operation/reservation ownership authorizes the current reader.
 * Immutable operation source anchors the original economic subject across an
 * allowed terminal user merge. Bound segment/target/refund owners must agree.
 * Legacy unscoped operation sources retain same-owner behavior only.
 * No key lookup: the subject HMAC is not a signature over this immutable plan.
 */
export function readCommittedFundingIdentity(input: {
  currentOwnerUserId: string;
  operationSourceSnapshot?: unknown;
  accountIds: readonly unknown[];
}): CommittedFundingIdentity | null {
  if (input.currentOwnerUserId.length === 0 || input.accountIds.length === 0)
    return null;
  const anchor = operationSourceIdentity(input.operationSourceSnapshot);
  if (anchor.kind === "invalid") return null;
  const original =
    anchor.kind === "owned" ? anchor.accountId : input.currentOwnerUserId;
  if (input.accountIds.some((accountId) => accountId !== original)) return null;
  return {
    currentOwnerUserId: input.currentOwnerUserId,
    originalEconomicAccountId: original,
  };
}

export function refundSnapshotAccountIds(
  snapshot: unknown,
): readonly unknown[] | null {
  if (!isRecord(snapshot)) return null;
  const extension = snapshot.alternativeRefundLocations;
  const alternatives =
    extension === undefined
      ? []
      : isRecord(extension) && Array.isArray(extension.locations)
        ? extension.locations
        : null;
  if (!alternatives || alternatives.some((entry) => !isRecord(entry)))
    return null;
  return [
    snapshot.accountId,
    ...alternatives.map(
      (entry) => (entry as Record<string, unknown>).accountId,
    ),
  ];
}
