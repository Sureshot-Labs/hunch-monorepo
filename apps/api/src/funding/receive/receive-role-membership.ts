import { isRecord } from "../../lib/type-guards.js";
import { sameAccountAddress } from "../domain/asset-identity.js";
import {
  matchRefundSourceEnvelope,
  supportsRefundSourceEnvelope,
  type RefundSourceCandidateRow,
} from "../reconciliation/relay-refund-source-candidates.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../reconciliation/owned-route-destination-observer.js";

/** Immutable candidate membership, NOT a current role or financial verdict.
 * Source reservations enumerate operations even for unbound Safe/Deposit Wallet
 * preparation prefixes and direct withdrawals. Their address/asset/provider need
 * not equal the handoff envelope. Each role subsequently checks exact facts.
 */
export function receiveSourceRoleMembership(
  userId: string,
  event: OwnedRouteCanonicalDestinationEvent,
  row: RefundSourceCandidateRow,
): {
  refund: "candidate" | "invalid" | "unrelated";
  handoff: boolean;
  destination: boolean;
} {
  if (row.user_id !== userId || !supportsRefundSourceEnvelope(event))
    return { refund: "unrelated", handoff: false, destination: false };
  return {
    refund: matchRefundSourceEnvelope(userId, event, row).kind,
    handoff: ["wallet_route", "composite_route", "venue_preparation"].includes(
      row.operation_plan_kind ?? "",
    ),
    destination: immutableReceiveDestinationMatches(userId, event, row),
  };
}

/** Match only the existing destination classifier's frozen scope: operation
 * FINAL target and the leg's output asset, not its intermediate target, status,
 * source amount, reference, minimum amount or quote expiry. Current facts and
 * owner/revision validation are required even after a negative result.
 * Native/Solana receive classification is deliberately outside this EVM scan.
 */
export function immutableReceiveDestinationMatches(
  userId: string,
  event: OwnedRouteCanonicalDestinationEvent,
  row: Pick<
    RefundSourceCandidateRow,
    | "user_id"
    | "operation_user_id"
    | "operation_plan_kind"
    | "segment_id"
    | "provider_id"
    | "operation_destination_target_snapshot"
    | "quoted_min_output"
  >,
): boolean {
  if (
    !supportsRefundSourceEnvelope(event) ||
    row.user_id !== userId ||
    row.operation_user_id !== userId ||
    !["wallet_route", "composite_route"].includes(
      row.operation_plan_kind ?? "",
    ) ||
    !row.segment_id ||
    row.provider_id !== "relay"
  )
    return false;
  const target = row.operation_destination_target_snapshot;
  const location =
    isRecord(target) && isRecord(target.location) ? target.location : null;
  const details =
    location && isRecord(location.details) ? location.details : null;
  // Match the legacy SQL's narrow #>> comparisons. Membership must not become
  // stricter than that classifier because of unrelated extension properties or
  // legacy decimals stored as JSON text instead of a number.
  const assetMatches = (value: unknown) =>
    isRecord(value) &&
    value.networkId === event.networkId &&
    String(value.decimals) === String(event.asset.decimals) &&
    typeof value.assetId === "string" &&
    sameAccountAddress(event.networkId, value.assetId, event.asset.assetId);
  return (
    assetMatches(location?.asset) &&
    assetMatches(
      isRecord(row.quoted_min_output) ? row.quoted_min_output.asset : null,
    ) &&
    typeof details?.address === "string" &&
    sameAccountAddress(
      event.networkId,
      details.address,
      event.destinationAddress,
    )
  );
}
