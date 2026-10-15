import type { PoolClient } from "@hunch/infra";
import type { RelayRequestEvidence } from "../../funding-providers/relay/request-evidence.js";
import {
  loadRelayExactRefundContext,
  type RelayExactRefundLookup,
  type RelayExactRefundContext,
} from "./relay-exact-refund-receipts.js";

/** No user/status/time filter: another owner's claim, a stopped operation or
 * duplicate immutable order must not disappear before the identity check. */
export const REFUND_ORDER_LOOKUP_SQL = `
  select segment_row.id as segment_id, segment_row.operation_id,
         operation_row.user_id
    from (
      select id, operation_id from funding_operation_segments
       where provider_id='relay'
         and refund_location_snapshot->>'relayProtocolOrderId' ~ '^0x[0-9a-fA-F]{64}$'
         and lower(refund_location_snapshot->>'relayProtocolOrderId')=$1
       order by id limit 2
    ) segment_row
    join funding_operations operation_row on operation_row.id=segment_row.operation_id
`;

export type CommittedRelayRefundCandidate = Readonly<{
  kind: "candidate";
  operationId: string;
  segmentId: string;
  context: RelayExactRefundContext;
}>;

/** A positive reverse lookup only narrows the existing receipt verifier's
 * target. Before writing, its caller still needs the current operation lock,
 * exact canonical event proof and joint receive-role arbitration. Unmatched
 * is deliberately NOT `external` and conveys no wallet-history coverage. */
export async function findCommittedRelayRefundCandidate(
  db: Pick<PoolClient, "query">,
  input: {
    userId: string;
    request: RelayRequestEvidence;
    referenceCodec: RelayExactRefundLookup["referenceCodec"];
  },
): Promise<
  | CommittedRelayRefundCandidate
  | Readonly<{ kind: "unmatched" }>
  | Readonly<{ kind: "pending"; reason: string }>
> {
  const orderId = input.request.protocol?.orderId;
  if (
    input.request.refundProjectionInvalid ||
    !/^0x[0-9a-f]{64}$/iu.test(orderId ?? "")
  )
    return { kind: "pending", reason: "refund_reverse_order_invalid" };
  const { rows } = await db.query<{
    operation_id: string;
    segment_id: string;
    user_id: string;
  }>(REFUND_ORDER_LOOKUP_SQL, [orderId?.toLowerCase()]);
  if (!rows.length) return { kind: "unmatched" };
  if (rows.length !== 1 || rows[0].user_id !== input.userId)
    return { kind: "pending", reason: "refund_reverse_order_ambiguous" };
  const row = rows[0];
  const context = await loadRelayExactRefundContext(db, {
    operationId: row.operation_id,
    segmentId: row.segment_id,
    requestId: input.request.id,
    referenceCodec: input.referenceCodec,
  });
  if (context.kind === "pending") return context;
  if (context.kind === "ignored")
    return { kind: "pending", reason: "refund_reverse_contract_unavailable" };
  if (context.expected.protocolOrderId.toLowerCase() !== orderId?.toLowerCase())
    return { kind: "pending", reason: "refund_reverse_order_mismatch" };
  return {
    kind: "candidate",
    operationId: row.operation_id,
    segmentId: row.segment_id,
    context,
  };
}
