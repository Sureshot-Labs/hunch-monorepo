import type { PoolClient } from "@hunch/infra";
import { z } from "zod";
import { RELAY_REQUEST_TRANSACTION_LIMIT } from "../../funding-providers/relay/request-evidence.js";
import {
  assertRefundSourceActionPageLimit,
  type RefundSourceAccounting,
} from "./relay-refund-source-actions.js";
import type { RefundCompletionProgress } from "./relay-refund-completion-scan.js";
import {
  readRefundDestinationReferences,
  refundDestinationObservationMatches,
  type RefundDestinationObservation,
  type RefundNativeDestination,
} from "./relay-refund-destination-settlement.js";

const observationKindSchema = z.enum([
  "source_debit",
  "source_credit",
  "intermediate_transfer",
  "destination_credit",
  "refund_credit",
  "venue_readiness",
]);
const cursorSchema = z
  .object({ kind: observationKindSchema, id: z.uuid() })
  .strict();
export const refundObservationProgressSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unchecked") }).strict(),
  z
    .object({
      kind: z.literal("reading"),
      cursor: cursorSchema,
      debitSeen: z.boolean(),
      refundsSeen: z.number().int().min(0).max(RELAY_REQUEST_TRANSACTION_LIMIT),
      destinationRaw: z
        .string()
        .regex(/^(0|[1-9]\d*)$/u)
        .max(78)
        .default("0"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pending"),
      reason: z.enum([
        "unexpected_observation",
        "nonfinal_observation",
        "incomplete_settlement",
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("empty") }).strict(),
  z.object({ kind: z.literal("refunded") }).strict(),
  z.object({ kind: z.literal("delivered") }).strict(),
]);
export type RefundObservationProgress = z.infer<
  typeof refundObservationProgressSchema
>;

type ObservationRow = RefundDestinationObservation & {
  id: string;
  operation_id: string;
  segment_id: string | null;
  kind: z.infer<typeof observationKindSchema>;
  network_id: string;
  tx_hash: string;
  event_index: string;
  canonical: boolean;
  finality_status: string;
};
function observationPageSql(resumed: boolean): string {
  // Existing 0303 index (operation_id,kind,id). Page BEFORE segment filtering:
  // unrelated legs consume work budget but cannot veto this leg or be skipped
  // by an unbounded post-filter LIMIT. No growing evidence/audit JSON is read.
  return `select id,operation_id,segment_id,kind,network_id,tx_hash,event_index,
    canonical,finality_status,asset_id,asset_decimals,from_address,to_address,
    raw_amount,ledger_height,block_hash,metadata->>'observerId' as observer_id,
    metadata->>'nativeDestinationDex' as native_destination_dex from funding_observations
    where operation_id=$1::uuid
    ${resumed ? "and (kind,id) > ($3::text,$4::uuid)" : ""}
    order by kind,id limit $2`;
}
export const REFUND_OBSERVATION_FIRST_PAGE_SQL = observationPageSql(false);
export const REFUND_OBSERVATION_NEXT_PAGE_SQL = observationPageSql(true);

/** Exact-contract source leg only, at the SAME checked revision as actions and
 * current refund set. No attempt + no money observation, or one exact debit +
 * complete refund, can clear this leg's pending source role. This does NOT
 * establish source membership, other roles, or publish an external deposit.
 * A successfully delivered leg requires the frozen native minimum, actual
 * canonical destination credits and their retained positive Relay references.
 * The exact refund watcher repairs the same physical row after a reorg; legacy
 * replacement-chain semantics remain in their existing lifecycle, not here. */
export async function readRefundObservationPage(
  db: Pick<PoolClient, "query">,
  input: {
    operationId: string;
    segmentId: string;
    accounting: RefundSourceAccounting;
    refundSet: RefundCompletionProgress;
    destination?: RefundNativeDestination | null;
    progress: RefundObservationProgress;
    limit: number;
  },
): Promise<RefundObservationProgress> {
  assertRefundSourceActionPageLimit(input.limit);
  const { progress, accounting, refundSet } = input;
  if (progress.kind !== "unchecked" && progress.kind !== "reading")
    return progress;
  const pending = (
    reason: Extract<RefundObservationProgress, { kind: "pending" }>["reason"],
  ): RefundObservationProgress => ({ kind: "pending", reason });
  const delivery =
    accounting.kind === "single_debit" &&
    refundSet.kind === "pending" &&
    refundSet.reason === "no_current_receipts";
  if (
    accounting.kind === "unaccounted" ||
    (accounting.kind === "single_debit" &&
      refundSet.kind !== "complete_refund_set" &&
      !delivery) ||
    (delivery && !input.destination)
  )
    return pending("incomplete_settlement");
  const cursor = progress.kind === "reading" ? progress.cursor : null;
  const result = await db.query<ObservationRow>(
    cursor
      ? REFUND_OBSERVATION_NEXT_PAGE_SQL
      : REFUND_OBSERVATION_FIRST_PAGE_SQL,
    [
      input.operationId,
      input.limit + 1,
      ...(cursor ? [cursor.kind, cursor.id] : []),
    ],
  );
  const rows = result.rows.slice(0, input.limit);
  const destination = input.destination;
  const deliveryReceipts =
    delivery && destination
      ? rows.filter(
          (row) =>
            row.segment_id === input.segmentId &&
            row.kind === "destination_credit" &&
            refundDestinationObservationMatches(destination, row),
        )
      : [];
  const matchedReferences = await readRefundDestinationReferences(db, {
    operationId: input.operationId,
    segmentId: input.segmentId,
    receipts: deliveryReceipts,
  });
  let debitSeen = progress.kind === "reading" && progress.debitSeen;
  let refundsSeen = progress.kind === "reading" ? progress.refundsSeen : 0;
  let destinationRaw = BigInt(
    progress.kind === "reading" ? progress.destinationRaw : "0",
  );
  for (const row of rows) {
    if (row.operation_id !== input.operationId)
      return pending("unexpected_observation");
    if (row.segment_id !== input.segmentId) continue;
    if (!row.canonical || row.finality_status !== "finalized")
      return pending("nonfinal_observation");
    if (accounting.kind !== "single_debit")
      return pending("unexpected_observation");
    if (
      row.kind === "source_debit" &&
      !debitSeen &&
      row.id === accounting.debit.observationId &&
      row.network_id === accounting.debit.networkId &&
      row.tx_hash === accounting.debit.transactionHash &&
      row.event_index === accounting.debit.eventIndex
    ) {
      debitSeen = true;
    } else if (
      row.kind === "refund_credit" &&
      refundSet.kind === "complete_refund_set" &&
      refundsSeen < refundSet.receiptCount
    ) {
      // All current final refunds were independently validated under this same
      // revision. This pass catches all states/kinds outside that current set.
      refundsSeen++;
    } else if (
      delivery &&
      input.destination &&
      row.kind === "destination_credit" &&
      matchedReferences.has(row.id)
    ) {
      // Saturate at the frozen minimum: only threshold attainment is needed,
      // and the continuation stays fixed-size for arbitrarily split credits.
      const next = destinationRaw + BigInt(row.raw_amount);
      const minimum = BigInt(input.destination.minimum.raw);
      destinationRaw = next < minimum ? next : minimum;
    } else return pending("unexpected_observation");
  }
  const last = rows.at(-1);
  if (result.rows.length > input.limit && last)
    return {
      kind: "reading",
      cursor: { kind: last.kind, id: last.id },
      debitSeen,
      refundsSeen,
      destinationRaw: destinationRaw.toString(),
    };
  if (accounting.kind === "none")
    return !debitSeen && refundsSeen === 0
      ? { kind: "empty" }
      : pending("unexpected_observation");
  if (delivery && input.destination)
    return debitSeen &&
      refundsSeen === 0 &&
      destinationRaw >= BigInt(input.destination.minimum.raw)
      ? { kind: "delivered" }
      : pending("incomplete_settlement");
  return debitSeen &&
    refundSet.kind === "complete_refund_set" &&
    refundsSeen === refundSet.receiptCount
    ? { kind: "refunded" }
    : pending("incomplete_settlement");
}
