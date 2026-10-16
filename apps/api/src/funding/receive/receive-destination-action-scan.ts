import type { PoolClient } from "@hunch/infra";
import { z } from "zod";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";
import { fundingActionPageCtes } from "../persistence/funding-action-page-sql.js";
import {
  FundingClassificationChangedError,
  readFundingClassificationRevision,
  readFundingClassificationPage,
} from "../persistence/funding-classification-revisions.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../reconciliation/owned-route-destination-observer.js";
import { assertRefundSourceActionPageLimit } from "../reconciliation/relay-refund-source-actions.js";
import { supportsRefundSourceEnvelope } from "../reconciliation/relay-refund-source-candidates.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { immutableReceiveDestinationMatches } from "./receive-role-membership.js";
import {
  receiveRoleEventFingerprint,
  receiveRoleProgressBaseSchema,
} from "./receive-role-progress.js";

export const destinationActionProgressSchema = receiveRoleProgressBaseSchema
  .extend({
    role: z.literal("destination"),
    segmentId: z.uuid(),
    codecContext: z.string().regex(/^[0-9a-f]{64}$/),
    referenceRetryRequired: z.boolean(),
    sourceMayBeMoving: z.boolean(),
    // Preserve exact identity separately from the possible flag. Across candidates
    // one exact destination wins over possibles; two distinct exacts are ambiguous.
    match: z.enum(["exact", "possible", "unrelated"]),
  })
  .strict()
  .refine((value) => (value.kind === "complete") === (value.cursor === null));
export type DestinationActionProgress = z.infer<
  typeof destinationActionProgressSchema
>;

export function receiveDestinationReferenceContext(
  event: OwnedRouteCanonicalDestinationEvent,
  codec?: Pick<RelayReferenceCodec, "fingerprint">,
) {
  let fingerprint: string | null = null;
  try {
    fingerprint = codec?.fingerprint(event.transactionHash) ?? null;
  } catch {
    /* The normal reader retries after codec recovery. */
  }
  return { fingerprint, codecContext: canonicalJsonHash({ fingerprint }) };
}

/** Shared projection for an exact leg and indexed reference witnesses. SQL
 * expressions are internal placeholders, never request text. */
export function receiveDestinationHeaderColumns(
  stableReference = "$4::text",
  legacyReference = "$5::text",
): string {
  return `operation_row.user_id,
  operation_row.user_id as operation_user_id,operation_row.plan_kind as operation_plan_kind,
  operation_row.destination_target_snapshot as operation_destination_target_snapshot,
  operation_row.status as operation_status,segment_row.id as segment_id,
  segment_row.provider_id,segment_row.quoted_min_output,
  coalesce(segment_row.support_metadata->>'originTransactionReferenceCount','0') ~ '^[1-9][0-9]*$' as source_may_be_moving,
  coalesce(segment_row.raw_status='success'
    and segment_row.support_metadata->>'relayStatusCategory'='provider_success'
    and coalesce(segment_row.support_metadata->>'destinationTransactionReferenceCount','0') ~ '^[1-9][0-9]*$',false) as destination_known,
  (coalesce(segment_row.support_metadata->'relaySuccessfulDestinationReferenceHashesV1','[]'::jsonb) @> jsonb_build_array(${stableReference})
    or coalesce(segment_row.raw_status='success'
      and segment_row.support_metadata->>'relayStatusCategory'='provider_success'
      and coalesce(segment_row.support_metadata->>'destinationTransactionReferenceCount','') ~ '^[0-9]*[1-9][0-9]*$'
      and exists(select 1 from jsonb_array_elements_text(case
        when jsonb_typeof(segment_row.support_metadata->'relayTransactionReferenceFingerprints')='array'
        then segment_row.support_metadata->'relayTransactionReferenceFingerprints' else '[]'::jsonb end) as fingerprint_row(reference_value)
        where fingerprint_row.reference_value=${legacyReference}),false)) as exact_reference`;
}

export const RECEIVE_DESTINATION_HEADER_SQL = `select ${receiveDestinationHeaderColumns()}
  from (select * from funding_operations where id=$1::uuid offset 0) operation_row
  cross join (select * from funding_operation_segments where id=$3::uuid offset 0) segment_row
  where operation_row.user_id=$2::uuid and segment_row.operation_id=operation_row.id`;

export const RECEIVE_DESTINATION_ACTION_PAGE_SQL = `${fundingActionPageCtes("refund_segment")}
  select fact_page.step_ordinal,fact_page.attempt_number,
    coalesce(step_row.segment_id=$2::uuid and (attempt_row.broadcast_may_have_occurred or attempt_row.outcome='started'),false) as source_may_be_moving
  from fact_page
  join funding_operation_steps step_row on step_row.id=fact_page.step_id
  left join funding_operation_step_attempts attempt_row on attempt_row.id=fact_page.attempt_id
  order by fact_page.step_ordinal,fact_page.attempt_number`;

export type ReceiveDestinationHeaderRow = Parameters<
  typeof immutableReceiveDestinationMatches
>[2] & {
  operation_status: string;
  source_may_be_moving: boolean;
  destination_known: boolean;
  exact_reference: boolean;
};

/** Bounded current-fact read for one captured destination dependency, not an
 * allocation verdict. Uses the existing classifier's immutable scope, status,
 * origin/attempt flags and retained/legacy exact references. No provider IO.
 */
export async function readReceiveDestinationActionPage(
  db: Pick<PoolClient, "query">,
  input: {
    userId: string;
    operationId: string;
    segmentId: string;
    event: OwnedRouteCanonicalDestinationEvent;
    progress: unknown;
    limit: number;
    referenceCodec?: Pick<RelayReferenceCodec, "fingerprint">;
  },
): Promise<DestinationActionProgress | { kind: "restart" | "unavailable" }> {
  assertRefundSourceActionPageLimit(input.limit);
  if (!supportsRefundSourceEnvelope(input.event))
    return { kind: "unavailable" };
  const parsed = destinationActionProgressSchema.safeParse(input.progress);
  if (input.progress != null && !parsed.success) return { kind: "restart" };
  let previous = parsed.success ? parsed.data : null;
  const eventFingerprint = receiveRoleEventFingerprint(input.event);
  if (
    previous &&
    (previous.eventFingerprint !== eventFingerprint ||
      previous.facts.userId !== input.userId ||
      previous.facts.operationId !== input.operationId ||
      previous.segmentId !== input.segmentId)
  )
    return { kind: "restart" };
  const { fingerprint, codecContext } = receiveDestinationReferenceContext(
    input.event,
    input.referenceCodec,
  );
  const facts = await readFundingClassificationRevision(db, {
    userId: input.userId,
    operationId: input.operationId,
  });
  if (!facts) return { kind: "unavailable" };
  if (previous && previous.facts.revision !== facts.revision)
    return { kind: "restart" };
  if (
    previous &&
    (previous.codecContext !== codecContext ||
      (previous.kind === "complete" && previous.referenceRetryRequired))
  )
    previous = null;
  if (previous?.kind === "complete") return previous;
  try {
    return await readFundingClassificationPage(db, facts, async (guardedDb) => {
      const header = (
        await guardedDb.query<ReceiveDestinationHeaderRow>(
          RECEIVE_DESTINATION_HEADER_SQL,
          [
            input.operationId,
            input.userId,
            input.segmentId,
            relayDestinationReferenceIdentity(input.event.transactionHash),
            fingerprint,
          ],
        )
      ).rows[0];
      if (!header) return { kind: "unavailable" } as const;
      const related = immutableReceiveDestinationMatches(
        input.userId,
        input.event,
        header,
      );
      let sourceMayBeMoving =
        header.source_may_be_moving || (previous?.sourceMayBeMoving ?? false);
      let cursor: DestinationActionProgress["cursor"] = null;
      const possible =
        related &&
        !header.destination_known &&
        !["ready", "completed", "refunded", "failed", "cancelled"].includes(
          header.operation_status,
        );
      if (possible && !header.exact_reference && !sourceMayBeMoving) {
        const rows = (
          await guardedDb.query<{
            step_ordinal: number;
            attempt_number: number;
            source_may_be_moving: boolean;
          }>(RECEIVE_DESTINATION_ACTION_PAGE_SQL, [
            input.operationId,
            input.segmentId,
            input.limit + 1,
            previous?.cursor?.stepOrdinal ?? -1,
            previous?.cursor?.attemptNumber ?? 0,
          ])
        ).rows;
        const page = rows.slice(0, input.limit);
        sourceMayBeMoving = page.some((row) => row.source_may_be_moving);
        const last = page.at(-1);
        if (!sourceMayBeMoving && rows.length > input.limit && last)
          cursor = {
            stepOrdinal: last.step_ordinal,
            attemptNumber: last.attempt_number,
          };
      }
      return {
        version: 1,
        role: "destination",
        kind: cursor ? "continuation" : "complete",
        facts,
        eventFingerprint,
        segmentId: input.segmentId,
        codecContext,
        referenceRetryRequired:
          related && !header.exact_reference && fingerprint === null,
        sourceMayBeMoving,
        cursor,
        match:
          related && header.exact_reference
            ? "exact"
            : possible && sourceMayBeMoving
              ? "possible"
              : "unrelated",
      } as DestinationActionProgress;
    });
  } catch (error) {
    if (error instanceof FundingClassificationChangedError)
      return { kind: "restart" };
    throw error;
  }
}
