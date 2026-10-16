import type { PoolClient } from "@hunch/infra";
import { isRecord } from "../../lib/type-guards.js";
import { sameAccountAddress, sameAsset } from "../domain/asset-identity.js";
import { assetLocationSchema, moneySchema } from "../domain/schemas.js";
import { readFundingRefundContract } from "../domain/refund-settlement.js";
import { readCommittedFundingIdentity } from "../domain/committed-economic-identity.js";
import type { OwnedRouteCanonicalDestinationEvent } from "./owned-route-destination-observer.js";

export type RefundSourceCursor = Readonly<{ createdAt: string; id: string }>;
export type RefundSourceCandidateRow = Readonly<{
  reservation_id: string;
  reservation_created_at: string;
  operation_id: string;
  segment_id: string | null;
  user_id: string;
  operation_user_id: string | null;
  operation_plan_kind?: string | null;
  operation_destination_target_snapshot?: unknown;
  operation_source_snapshot?: unknown;
  location_id: string;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  raw_amount: string;
  mode: string;
  provider_id: string | null;
  source_snapshot: unknown;
  quoted_input: unknown;
  destination_target_snapshot?: unknown;
  quoted_min_output?: unknown;
  refund_location_snapshot: unknown;
  provider_quote_ref_lookup_hmac: string | null;
  lookup_key_version: number | null;
}>;

/** Page the source rows BEFORE inspecting provider/asset/owner/amount. Filtering
 * by reservation asset first would hide a misbound reservation. The existing
 * deferred plan-shape constraint requires one source_input row for every route
 * leg; other reservation roles must not fan out this scan. All states count.
 *
 * No mutable attempt, status, finality or quote-expiry predicate belongs here.
 * Every immutable envelope candidate must survive until the final current-fact
 * check, even when it looked settled or unstarted on an earlier page. */
function hydrateSourceSql(sourceSelection: string): string {
  return `with source_page as materialized (${sourceSelection})
  select source_page.id as reservation_id,
    to_char(source_page.created_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as reservation_created_at,
    source_page.operation_id, source_page.segment_id, source_page.user_id,
    operation_row.user_id as operation_user_id,
    operation_row.plan_kind as operation_plan_kind,
    operation_row.source_snapshot as operation_source_snapshot,
    operation_row.destination_target_snapshot as operation_destination_target_snapshot,
    source_page.location_id, source_page.network_id, source_page.asset_id,
    source_page.asset_decimals, source_page.raw_amount, source_page.mode,
    segment_row.provider_id, segment_row.source_snapshot, segment_row.quoted_input,
    segment_row.destination_target_snapshot, segment_row.quoted_min_output,
    segment_row.refund_location_snapshot,
    segment_row.provider_quote_ref_lookup_hmac, segment_row.lookup_key_version
  from source_page
  left join lateral (
    select user_id,plan_kind,source_snapshot,destination_target_snapshot from funding_operations
    where id=source_page.operation_id limit 1
  ) operation_row on true
  left join lateral (
    select * from funding_operation_segments
    where id=source_page.segment_id
      and operation_id=source_page.operation_id limit 1
  ) segment_row on true
  order by source_page.created_at desc,source_page.id desc`;
}
function sourcePageSql(resumed: boolean): string {
  return hydrateSourceSql(`
    select reservation_row.*
    from balance_reservations reservation_row
    where reservation_row.user_id=$1::uuid
      and reservation_row.economic_role='source_input'
      and reservation_row.created_at <= $2::timestamptz
      ${resumed ? "and (reservation_row.created_at,reservation_row.id) < ($4::timestamptz,$5::uuid)" : ""}
    order by reservation_row.created_at desc,reservation_row.id desc
    limit $3`);
}
export const REFUND_SOURCE_FIRST_PAGE_SQL = sourcePageSql(false);
export const REFUND_SOURCE_NEXT_PAGE_SQL = sourcePageSql(true);
export const REFUND_SOURCE_EXACT_SQL = hydrateSourceSql(`
  select reservation_row.* from balance_reservations reservation_row
  where reservation_row.id=$2::uuid and reservation_row.user_id=$1::uuid
    and reservation_row.economic_role='source_input'`);

export type RefundSourceCandidateIdentity = Readonly<{
  userId: string;
  operationId: string;
  segmentId: string;
  reservationId: string;
}>;

/** Rehydrate the exact enumerated identity under the facts-page guard. Never
 * bind a newly read revision to an old envelope from an earlier source page. */
export async function loadRefundSourceCandidate(
  db: Pick<PoolClient, "query">,
  input: RefundSourceCandidateIdentity,
): Promise<RefundSourceCandidateRow | null> {
  const { rows } = await db.query<RefundSourceCandidateRow>(
    REFUND_SOURCE_EXACT_SQL,
    [input.userId, input.reservationId],
  );
  const row = rows[0];
  return row &&
    row.operation_id === input.operationId &&
    row.segment_id === input.segmentId &&
    row.operation_user_id === input.userId
    ? row
    : null;
}

export type RefundSourceEnvelopeMatch =
  | Readonly<{ kind: "unrelated" }>
  | Readonly<{
      kind: "candidate" | "invalid";
      operationId: string;
      segmentId: string | null;
      reservationId: string;
    }>;

/** Protocol support, not a rollout flag. Native/Solana receive events cannot
 * be classified by this EVM refund-source reader and must not scan its history. */
export function supportsRefundSourceEnvelope(
  event: Pick<OwnedRouteCanonicalDestinationEvent, "networkId" | "asset">,
): boolean {
  return (
    ["evm:8453", "evm:137"].includes(event.networkId) &&
    event.asset.networkId === event.networkId
  );
}

/** This establishes only a POSSIBLE immutable relationship, never a refund or
 * an external deposit. In particular, the candidate may have only an approval
 * or no attempt at all; callers must check exact bound money-moving facts. */
export function matchRefundSourceEnvelope(
  userId: string,
  event: OwnedRouteCanonicalDestinationEvent,
  row: RefundSourceCandidateRow,
): RefundSourceEnvelopeMatch {
  const unrelated: RefundSourceEnvelopeMatch = { kind: "unrelated" };
  if (row.user_id !== userId || !supportsRefundSourceEnvelope(event))
    return unrelated;
  const snapshot = row.refund_location_snapshot;
  if (!isRecord(snapshot) || !Object.hasOwn(snapshot, "refundEvidenceContract"))
    return unrelated; // Legacy routes retain their existing classifier.
  const identity = {
    operationId: row.operation_id,
    segmentId: row.segment_id,
    reservationId: row.reservation_id,
  };
  const invalid = (): RefundSourceEnvelopeMatch => ({
    kind: "invalid",
    ...identity,
  });
  const alternatives = isRecord(snapshot.alternativeRefundLocations)
    ? snapshot.alternativeRefundLocations.locations
    : snapshot.alternativeRefundLocations === undefined
      ? []
      : null;
  const sourceSnapshot = row.source_snapshot;
  const source = assetLocationSchema.safeParse(
    isRecord(sourceSnapshot) && sourceSnapshot.kind === "owned_location"
      ? sourceSnapshot.location
      : null,
  );
  const amount = moneySchema.safeParse(row.quoted_input);
  const contract = readFundingRefundContract(snapshot, {
    requestFingerprint: row.provider_quote_ref_lookup_hmac,
    lookupKeyVersion: row.lookup_key_version,
  });
  const locations = Array.isArray(alternatives)
    ? [snapshot, ...alternatives].map((location) =>
        assetLocationSchema.strip().safeParse(location),
      )
    : [];
  if (
    !locations.length ||
    locations.some(
      (location) =>
        !location.success || typeof location.data.details.address !== "string",
    )
  )
    return invalid();
  if (
    !locations.some(
      (location) =>
        location.success &&
        typeof location.data.details.address === "string" &&
        sameAsset(location.data.asset, event.asset) &&
        sameAccountAddress(
          event.networkId,
          location.data.details.address,
          event.destinationAddress,
        ),
    )
  )
    return unrelated;
  if (
    !row.segment_id ||
    row.operation_user_id !== userId ||
    row.provider_id !== "relay" ||
    !source.success ||
    !amount.success ||
    !contract?.supported ||
    !readCommittedFundingIdentity({
      currentOwnerUserId: userId,
      operationSourceSnapshot: row.operation_source_snapshot,
      accountIds: [
        source.data.accountId,
        ...locations.flatMap((location) =>
          location.success ? [location.data.accountId] : [],
        ),
      ],
    }) ||
    typeof source.data.details.address !== "string" ||
    !sameAsset(source.data.asset, amount.data.asset) ||
    !sameAsset(source.data.asset, event.asset) ||
    !sameAccountAddress(
      event.networkId,
      source.data.details.address,
      event.destinationAddress,
    ) ||
    !/^[1-9]\d*$/.test(amount.data.raw) ||
    !/^[1-9]\d*$/.test(event.rawAmount)
  )
    return invalid();
  if (BigInt(event.rawAmount) > BigInt(amount.data.raw)) return unrelated;
  if (
    row.mode !== "subtract_available" ||
    row.location_id !== source.data.locationId ||
    !sameAsset(
      {
        networkId: row.network_id,
        assetId: row.asset_id,
        decimals: row.asset_decimals,
      },
      source.data.asset,
    ) ||
    row.raw_amount !== amount.data.raw
  )
    return invalid();
  return { kind: "candidate", ...identity };
}

/** Internal continuation, not a public cursor. The owner, cutoff and event
 * identity must be frozen by the calling canonical-event retry record. This
 * reader cannot return `external` or dismiss candidates using mutable facts.
 * A missing nextCursor means only that this enumeration ended, NOT a stable
 * MVCC membership proof: ownership changes/late historical insertion require
 * restart/revalidation. Current-fact decisions cannot be cached across pages. */
export async function loadRefundSourceCandidatePage(
  db: Pick<PoolClient, "query">,
  input: {
    userId: string;
    scanBefore: string;
    cursor: RefundSourceCursor | null;
    limit: number;
  },
): Promise<
  Readonly<{
    rows: readonly RefundSourceCandidateRow[];
    nextCursor: RefundSourceCursor | null;
  }>
> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit >= Number.MAX_SAFE_INTEGER
  )
    throw new Error("Refund source page requires a positive safe page limit");
  const result = await db.query<RefundSourceCandidateRow>(
    input.cursor ? REFUND_SOURCE_NEXT_PAGE_SQL : REFUND_SOURCE_FIRST_PAGE_SQL,
    [
      input.userId,
      input.scanBefore,
      input.limit + 1,
      ...(input.cursor ? [input.cursor.createdAt, input.cursor.id] : []),
    ],
  );
  const rows = result.rows.slice(0, input.limit);
  const last = rows.at(-1);
  return {
    rows,
    nextCursor:
      result.rows.length > input.limit && last
        ? { createdAt: last.reservation_created_at, id: last.reservation_id }
        : null,
  };
}
