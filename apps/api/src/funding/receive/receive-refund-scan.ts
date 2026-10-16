import { tx, type Pool, type PoolClient } from "@hunch/infra";
import {
  lockBoundFundingReceiveClassificationRetry,
  lockFundingReceiveCanonicalEvents,
  type FundingReceiveCanonicalEventInput,
  type FundingReceiveClassificationRetry,
} from "../persistence/funding-receive-session-repository.js";
import {
  FundingClassificationChangedError,
  readFundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";
import { lockFundingRoleMembershipOwner } from "../persistence/funding-role-membership-lifecycle.js";
import {
  loadRefundSourceCandidatePage,
  supportsRefundSourceEnvelope,
} from "../reconciliation/relay-refund-source-candidates.js";
import { assertRefundSourceActionPageLimit } from "../reconciliation/relay-refund-source-actions.js";
import { readRefundSourceActionPage } from "../reconciliation/relay-refund-source-action-scan.js";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import {
  readReceiveExactRoleEvidence,
  type ReceiveExactRoleEvidence,
} from "./receive-exact-role-evidence.js";
import { receiveSourceRoleMembership } from "./receive-role-membership.js";
import { readReceiveHandoffActionPage } from "./receive-handoff-action-scan.js";
import { readReceiveDestinationActionPage } from "./receive-destination-action-scan.js";
import {
  readRecordedRelayRefundRoleEvidence,
  refundCanonicalEventKey,
} from "../reconciliation/relay-exact-refund-classification.js";
import {
  arbitrateReceiveRoleCandidates,
  type ReceiveRoleArbitration,
  type ReceiveRoleCandidate,
  type ReceiveRefundRoleEvidence,
} from "./receive-role-arbitration.js";
import {
  destinationActionProgressSchema,
  receiveDestinationReferenceContext,
} from "./receive-destination-action-scan.js";
import { receiveRoleEventFingerprint } from "./receive-role-progress.js";
import {
  protectedRecordedRefundRoleProofMatches,
  type ProtectedRecordedRefundRoleProof,
} from "../reconciliation/relay-owned-refund-ownership.js";

type RetryIdentity = Pick<
  FundingReceiveClassificationRetry,
  "eventId" | "leaseToken" | "boundSessionId" | "boundVariantId"
>;
export const RECEIVE_ROLE_SCAN_CONTRACT_VERSION = 5;
type ScanRow = {
  event_fingerprint: string | null;
  contract_version: number;
  user_id: string;
  receive_session_id: string | null;
  variant_id: string | null;
  scan_before: string;
  source_cursor_created_at: string | null;
  source_cursor_id: string | null;
  source_exhausted: boolean;
  progress_revision: string;
  last_lease_token: string | null;
};

// A real receive lease always validates its session before reading this state.
// A provider job may have created the same owner's checkpoint without one.
// Conversely a provider job can use a session-created checkpoint, but cannot
// change its owner or grant itself receive allocation authority.
function scanContextMatches(
  scan: ScanRow,
  userId: string,
  event: FundingReceiveClassificationRetry,
): boolean {
  return (
    scan.user_id === userId &&
    ((scan.receive_session_id === null && scan.variant_id === null) ||
      (event.boundSessionId === null && event.boundVariantId === null) ||
      (scan.receive_session_id === event.boundSessionId &&
        scan.variant_id === event.boundVariantId))
  );
}

function needsReceiveBindingRestart(
  scan: ScanRow,
  event: FundingReceiveClassificationRetry,
): boolean {
  return scan.receive_session_id === null && event.boundSessionId !== null;
}
type CandidateRow = {
  candidate_id: string;
  reservation_id: string | null;
  operation_id: string;
  segment_id: string | null;
  envelope_kind: "candidate" | "invalid" | "unrelated";
  handoff_possible: boolean;
  destination_possible: boolean;
  next_role: "refund" | "handoff" | "destination";
  action_continuation: unknown;
  action_result: unknown;
  handoff_progress: unknown;
  destination_progress: unknown;
};

export const READ_RECEIVE_REFUND_SCAN_SQL = `select contract_version,user_id,
  receive_session_id,variant_id,event_fingerprint,source_exhausted,progress_revision::text,last_lease_token,
  to_char(scan_before at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as scan_before,
  to_char(source_cursor_created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    as source_cursor_created_at,source_cursor_id
  from funding_receive_refund_scans where event_id=$1::uuid`;

export const NEXT_RECEIVE_REFUND_CANDIDATE_SQL = `select candidate_id,reservation_id,operation_id,
  segment_id,envelope_kind,action_continuation,action_result,
  handoff_possible,destination_possible,next_role,handoff_progress,destination_progress
  from funding_receive_refund_candidates
  where event_id=$1::uuid
  order by last_checked_revision,candidate_id limit 1`;

function roleCandidatePageSql(resumed: boolean): string {
  return `select candidate_id,reservation_id,operation_id,segment_id,envelope_kind,
    handoff_possible,destination_possible,action_result,handoff_progress,destination_progress
    from funding_receive_refund_candidates where event_id=$1::uuid
    ${resumed ? "and candidate_id>$3::uuid" : ""}
    order by candidate_id limit $2`;
}
export const RECEIVE_ROLE_CANDIDATES_FIRST_PAGE_SQL =
  roleCandidatePageSql(false);
export const RECEIVE_ROLE_CANDIDATES_NEXT_PAGE_SQL = roleCandidatePageSql(true);

export const RESTART_RECEIVE_ROLE_SCAN_SQL = `update funding_receive_refund_scans
  set contract_version=${RECEIVE_ROLE_SCAN_CONTRACT_VERSION},scan_before=clock_timestamp(),source_cursor_created_at=null,
    source_cursor_id=null,source_exhausted=false,
    receive_session_id=coalesce(receive_session_id,$2::uuid),
    variant_id=coalesce(variant_id,$3::text),event_fingerprint=$4::text
  where event_id=$1`;

/** Read compact rows from an authoritative frozen E lease, with bounded
 * queries and no raw-history reload. Caller owns the transaction and all E
 * locks before any O lock. Holding E keeps checkpoint membership/results stable;
 * the returned operation facts still require the final O/F publication fence.
 * Exact indexed witnesses are read after complete summaries, not omitted on a
 * missing codec. Source-membership proof remains a caller requirement. This
 * helper neither allocates nor invents missing evidence. */
export async function readReceiveRoleArbitrationInTransaction(
  db: PoolClient,
  input: {
    retry: RetryIdentity;
    userId: string;
    limit: number;
    refundEvidence?: ReceiveRefundRoleEvidence;
    exactRoleEvidence?: ReceiveExactRoleEvidence;
    transactionReferenceCodec?: Pick<
      FundingTransactionReferenceCodec,
      "fingerprint" | "keyVersion" | "decrypt"
    >;
    referenceCodec?: Pick<RelayReferenceCodec, "fingerprint">;
  },
): Promise<ReceiveRoleArbitration> {
  assertRefundSourceActionPageLimit(input.limit);
  const retry = await lockBoundFundingReceiveClassificationRetry(db, input);
  if (!retry)
    return { kind: "incomplete", reason: "candidate_context_changed" };
  return readLockedReceiveRoleArbitration(db, input, retry);
}

/** The caller has validated and locked the real canonical-event authority.
 * Kept separate from the session lease adapter so other existing funding jobs
 * need not fabricate a receive session to use the same role summaries. */
async function readLockedReceiveRoleArbitration(
  db: PoolClient,
  input: Parameters<typeof readReceiveRoleArbitrationInTransaction>[1],
  retry: FundingReceiveClassificationRetry,
): Promise<ReceiveRoleArbitration> {
  const scan = (
    await db.query<ScanRow>(READ_RECEIVE_REFUND_SCAN_SQL, [retry.eventId])
  ).rows[0];
  if (
    !scan ||
    scan.contract_version !== RECEIVE_ROLE_SCAN_CONTRACT_VERSION ||
    !scan.source_exhausted ||
    scan.event_fingerprint !== receiveRoleEventFingerprint(retry)
  )
    return { kind: "incomplete", reason: "source_enumeration_pending" };
  if (!scanContextMatches(scan, input.userId, retry))
    return { kind: "incomplete", reason: "candidate_context_changed" };
  // A sessionless checkpoint predates the receive session's lifecycle fence.
  // Source ownership could have changed meanwhile (for example a user merge).
  // Only bounded re-enumeration under the real frozen session closes that gap.
  if (needsReceiveBindingRestart(scan, retry))
    return { kind: "incomplete", reason: "source_enumeration_pending" };
  const refundEvidence =
    input.refundEvidence ??
    (
      await readRecordedRelayRefundRoleEvidence(db, {
        userId: input.userId,
        events: [retry],
      })
    ).get(refundCanonicalEventKey(retry));
  if (!refundEvidence)
    return { kind: "incomplete", reason: "refund_evidence_pending" };
  const { transactionReferenceCodec, referenceCodec } = input;
  if (
    !input.exactRoleEvidence &&
    (!transactionReferenceCodec || !referenceCodec)
  )
    return { kind: "incomplete", reason: "reference_recovery_pending" };
  async function* candidates(): AsyncIterable<ReceiveRoleCandidate> {
    let cursor: string | null = null;
    for (;;) {
      const page: {
        rows: (ReceiveRoleCandidate & { candidate_id: string })[];
      } = await db.query(
        cursor
          ? RECEIVE_ROLE_CANDIDATES_NEXT_PAGE_SQL
          : RECEIVE_ROLE_CANDIDATES_FIRST_PAGE_SQL,
        [input.retry.eventId, input.limit + 1, ...(cursor ? [cursor] : [])],
      );
      for (const row of page.rows.slice(0, input.limit)) yield row;
      if (page.rows.length <= input.limit) return;
      cursor = page.rows[input.limit - 1].candidate_id;
    }
  }
  return arbitrateReceiveRoleCandidates({
    ...input,
    refundEvidence,
    event: retry,
    enumerationComplete: true,
    candidates: candidates(),
    loadExactRoleEvidence:
      !input.exactRoleEvidence && transactionReferenceCodec && referenceCodec
        ? (destinationProgress) =>
            readReceiveExactRoleEvidence(db, {
              userId: input.userId,
              limit: input.limit,
              event: retry,
              transactionReferenceCodec,
              referenceCodec,
              destinationProgress,
            })
        : undefined,
  });
}

export const INSERT_RECEIVE_ROLE_CONTINUATIONS_SQL = `insert into funding_receive_refund_candidates
  (event_id,operation_id,segment_id,envelope_kind,destination_possible,next_role,destination_progress)
  select $1::uuid,witness_row.operation_id,witness_row.segment_id,'unrelated',true,'destination',witness_row.progress
  from jsonb_to_recordset($2::jsonb) as witness_row(operation_id uuid,segment_id uuid,progress jsonb)
  on conflict(event_id,operation_id,segment_id) where reservation_id is null do nothing`;

/** Checkpoint-only publication of exact-reader continuations under the SAME E
 * lease. Caller commits this even when arbitration is incomplete; no financial
 * effects or acknowledgment may precede it. Existing rows are never rewound by
 * replay: the ordinary bounded candidate rotation advances/restarts them.
 */
export async function checkpointReceiveRoleArbitrationInTransaction(
  db: PoolClient,
  input: Parameters<typeof readReceiveRoleArbitrationInTransaction>[1],
): Promise<ReceiveRoleArbitration> {
  const result = await readReceiveRoleArbitrationInTransaction(db, input);
  if (result.kind !== "incomplete" || !result.pendingDestinations?.length)
    return result;
  // The reader already owns E; reread only to validate the authoritative
  // envelope, never accept amounts/identity supplied by a caller.
  const retry = await lockBoundFundingReceiveClassificationRetry(db, input);
  if (!retry)
    return { kind: "incomplete", reason: "candidate_context_changed" };
  return checkpointLockedReceiveRoleArbitration(db, input, retry, result);
}

async function checkpointLockedReceiveRoleArbitration(
  db: PoolClient,
  input: Parameters<typeof readReceiveRoleArbitrationInTransaction>[1],
  retry: FundingReceiveClassificationRetry,
  result: ReceiveRoleArbitration,
): Promise<ReceiveRoleArbitration> {
  if (result.kind !== "incomplete" || !result.pendingDestinations?.length)
    return result;
  const fingerprint = receiveRoleEventFingerprint(retry);
  const codecContext = receiveDestinationReferenceContext(
    retry,
    input.referenceCodec,
  ).codecContext;
  const rows = result.pendingDestinations.map((value) => {
    const progress = destinationActionProgressSchema.parse(value);
    if (
      progress.kind !== "continuation" ||
      progress.facts.userId !== input.userId ||
      progress.eventFingerprint !== fingerprint ||
      progress.codecContext !== codecContext
    )
      throw new Error("Invalid exact destination continuation context");
    return {
      operation_id: progress.facts.operationId,
      segment_id: progress.segmentId,
      progress,
    };
  });
  await db.query(INSERT_RECEIVE_ROLE_CONTINUATIONS_SQL, [
    retry.eventId,
    JSON.stringify(rows),
  ]);
  return result;
}

export const DELETE_RECEIVE_REFUND_CANDIDATE_PAGE_SQL = `with candidate_page as materialized (
  select candidate_id from funding_receive_refund_candidates
  where event_id=$1 order by candidate_id limit $2
) delete from funding_receive_refund_candidates candidate_row
using candidate_page where candidate_row.event_id=$1
  and candidate_row.candidate_id=candidate_page.candidate_id`;

export const RECEIVE_REFUND_CLEANUP_PAGE_SQL = `select event_id
  from funding_receive_refund_scans where cleanup_ready
  order by updated_at,event_id limit $1`;

export type ReceiveRefundScanProgress = Readonly<{
  kind:
    | "unavailable"
    | "context_mismatch"
    | "replayed"
    | "source_restart"
    | "source_page"
    | "action_page"
    | "awaiting_evidence";
  /** Diagnostic work counter, never an allocation/evidence revision. */
  revision?: string;
}>;

/** One checkpoint-only transaction, using the EXISTING canonical-event lease.
 * E -> derived rows only: no O/F locks, provider IO, allocation or execution.
 * Source/action completion is not a negative classification: exact debit,
 * settlement, membership and all-role publication fences are still required.
 * The caller supplies the existing worker policy's bounded page budget. */
export async function advanceReceiveRefundScan(
  pool: Pool,
  input: {
    retry: RetryIdentity;
    userId: string;
    limit: number;
    restartEnumeration?: boolean;
    transactionReferenceCodec?: Pick<
      FundingTransactionReferenceCodec,
      "fingerprint" | "keyVersion" | "decrypt"
    >;
    referenceCodec?: Pick<RelayReferenceCodec, "fingerprint">;
  },
): Promise<ReceiveRefundScanProgress> {
  assertRefundSourceActionPageLimit(input.limit);
  return tx(pool, async (db) => {
    // Read authoritative envelope/owner, never retry's caller-supplied amounts.
    // Only E is locked; the immutable frozen session is read, not locked.
    const retry = await lockBoundFundingReceiveClassificationRetry(db, input);
    if (!retry) return { kind: "unavailable" };
    return advanceLockedReceiveRoleScan(db, input, retry);
  });
}

async function advanceLockedReceiveRoleScan(
  db: PoolClient,
  input: Parameters<typeof advanceReceiveRefundScan>[1],
  retry: FundingReceiveClassificationRetry,
): Promise<ReceiveRefundScanProgress> {
  await db.query(
    `insert into funding_receive_refund_scans
       (event_id,contract_version,user_id,receive_session_id,variant_id,event_fingerprint)
       values($1,${RECEIVE_ROLE_SCAN_CONTRACT_VERSION},$2,$3,$4,$5) on conflict(event_id) do nothing`,
    [
      retry.eventId,
      input.userId,
      retry.boundSessionId,
      retry.boundVariantId,
      receiveRoleEventFingerprint(retry),
    ],
  );
  const scan = (
    await db.query<ScanRow>(READ_RECEIVE_REFUND_SCAN_SQL, [retry.eventId])
  ).rows[0];
  if (
    ![1, 2, 3, 4, RECEIVE_ROLE_SCAN_CONTRACT_VERSION].includes(
      scan.contract_version,
    ) ||
    !scanContextMatches(scan, input.userId, retry)
  )
    return { kind: "context_mismatch" };
  const bindingRestart = needsReceiveBindingRestart(scan, retry);
  const semanticsRestart =
    scan.contract_version !== RECEIVE_ROLE_SCAN_CONTRACT_VERSION ||
    scan.event_fingerprint !== receiveRoleEventFingerprint(retry);
  if (
    !bindingRestart &&
    !semanticsRestart &&
    scan.last_lease_token === retry.leaseToken
  )
    return { kind: "replayed", revision: scan.progress_revision };
  const revision = (BigInt(scan.progress_revision) + 1n).toString();
  let kind: ReceiveRefundScanProgress["kind"];
  if (input.restartEnumeration || semanticsRestart || bindingRestart) {
    // Explicit bounded repair: preserve every candidate, including those no
    // longer visible. New enumeration must never shrink the dependency set.
    await db.query(RESTART_RECEIVE_ROLE_SCAN_SQL, [
      retry.eventId,
      retry.boundSessionId,
      retry.boundVariantId,
      receiveRoleEventFingerprint(retry),
    ]);
    kind = "source_restart";
  } else if (!scan.source_exhausted) {
    const page = await loadRefundSourceCandidatePage(db, {
      userId: input.userId,
      scanBefore: scan.scan_before,
      cursor:
        scan.source_cursor_created_at && scan.source_cursor_id
          ? {
              createdAt: scan.source_cursor_created_at,
              id: scan.source_cursor_id,
            }
          : null,
      limit: input.limit,
    });
    const candidates = page.rows.flatMap((row) => {
      const roles = receiveSourceRoleMembership(input.userId, retry, row);
      return roles.refund === "unrelated" &&
        !roles.handoff &&
        !roles.destination
        ? []
        : [
            {
              reservation_id: row.reservation_id,
              operation_id: row.operation_id,
              segment_id: row.segment_id,
              envelope_kind: roles.refund,
              handoff_possible: roles.handoff,
              destination_possible: roles.destination,
            },
          ];
    });
    if (candidates.length)
      await db.query(
        `insert into funding_receive_refund_candidates
         (event_id,reservation_id,operation_id,segment_id,envelope_kind,handoff_possible,destination_possible)
         select $1, candidate_row.reservation_id,candidate_row.operation_id,
           candidate_row.segment_id,candidate_row.envelope_kind,candidate_row.handoff_possible,candidate_row.destination_possible
         from jsonb_to_recordset($2::jsonb) as candidate_row
           (reservation_id uuid,operation_id uuid,segment_id uuid,envelope_kind text,handoff_possible boolean,destination_possible boolean)
         on conflict(event_id,reservation_id) do update set
           envelope_kind=case when (funding_receive_refund_candidates.operation_id,funding_receive_refund_candidates.segment_id)
             is not distinct from (excluded.operation_id,excluded.segment_id)
             then excluded.envelope_kind else funding_receive_refund_candidates.envelope_kind end,
           action_continuation=null,action_result=null,
           handoff_possible=funding_receive_refund_candidates.handoff_possible or excluded.handoff_possible,
           destination_possible=funding_receive_refund_candidates.destination_possible or excluded.destination_possible,
           handoff_progress=null,destination_progress=null,next_role='refund',
           diagnostic_code=case when (funding_receive_refund_candidates.operation_id,funding_receive_refund_candidates.segment_id)
             is distinct from (excluded.operation_id,excluded.segment_id)
             then 'source_identity_changed' else null end,last_checked_revision=0
         where (funding_receive_refund_candidates.operation_id,funding_receive_refund_candidates.segment_id,
                funding_receive_refund_candidates.envelope_kind)
           is distinct from (excluded.operation_id,excluded.segment_id,excluded.envelope_kind)
           or (excluded.handoff_possible and not funding_receive_refund_candidates.handoff_possible)
           or (excluded.destination_possible and not funding_receive_refund_candidates.destination_possible)`,
        [retry.eventId, JSON.stringify(candidates)],
      );
    await db.query(
      `update funding_receive_refund_scans set source_cursor_created_at=$2,
         source_cursor_id=$3,source_exhausted=$4 where event_id=$1`,
      [
        retry.eventId,
        page.nextCursor?.createdAt ?? null,
        page.nextCursor?.id ?? null,
        !page.nextCursor,
      ],
    );
    kind = "source_page";
  } else {
    const candidate = (
      await db.query<CandidateRow>(NEXT_RECEIVE_REFUND_CANDIDATE_SQL, [
        retry.eventId,
      ])
    ).rows[0];
    if (!candidate) {
      kind = "awaiting_evidence";
    } else {
      const roles = (["refund", "handoff", "destination"] as const).filter(
        (role) =>
          role === "refund"
            ? candidate.envelope_kind !== "unrelated"
            : role === "handoff"
              ? candidate.handoff_possible
              : candidate.destination_possible,
      );
      const role = roles.includes(candidate.next_role)
        ? candidate.next_role
        : roles[0];
      const nextRole = roles[(roles.indexOf(role) + 1) % roles.length];
      if (role === "handoff" || role === "destination") {
        const inputRole = {
          userId: input.userId,
          operationId: candidate.operation_id,
          event: retry,
          limit: input.limit,
        };
        const result =
          role === "handoff"
            ? await readReceiveHandoffActionPage(db, {
                ...inputRole,
                progress: candidate.handoff_progress,
                transactionReferenceCodec: input.transactionReferenceCodec,
              })
            : !candidate.segment_id
              ? ({ kind: "unavailable" } as const)
              : await readReceiveDestinationActionPage(db, {
                  ...inputRole,
                  segmentId: candidate.segment_id,
                  progress: candidate.destination_progress,
                  referenceCodec: input.referenceCodec,
                });
        // Code-owned column only. One role page per claimed event, with a
        // second round-robin inside the existing fair candidate rotation.
        const column =
          role === "handoff" ? "handoff_progress" : "destination_progress";
        await db.query(
          `update funding_receive_refund_candidates set ${column}=$3,
            diagnostic_code=$4,last_checked_revision=$5,next_role=$6 where event_id=$1 and candidate_id=$2`,
          [
            retry.eventId,
            candidate.candidate_id,
            result.kind === "continuation" || result.kind === "complete"
              ? result
              : null,
            result.kind === "restart"
              ? "facts_changed"
              : result.kind === "unavailable"
                ? "source_unavailable"
                : null,
            revision,
            nextRole,
          ],
        );
      } else {
        const result =
          !candidate.segment_id || !candidate.reservation_id
            ? ({ kind: "unavailable" } as const)
            : await readRefundSourceActionPage(db, {
                identity: {
                  userId: input.userId,
                  operationId: candidate.operation_id,
                  segmentId: candidate.segment_id,
                  reservationId: candidate.reservation_id,
                },
                continuation: candidate.action_continuation,
                completed: candidate.action_result,
                limit: input.limit,
                event: retry,
              });
        await db.query(
          `update funding_receive_refund_candidates set action_continuation=$3,
           action_result=$4,diagnostic_code=$5,last_checked_revision=$6,next_role=$7
           where event_id=$1 and candidate_id=$2`,
          [
            retry.eventId,
            candidate.candidate_id,
            result.kind === "continuation" ? result.continuation : null,
            result.kind === "complete" ? result : null,
            result.kind === "restart"
              ? "facts_changed"
              : result.kind === "unavailable"
                ? "source_unavailable"
                : null,
            revision,
            nextRole,
          ],
        );
      }
      kind = "action_page";
    }
  }
  await db.query(
    `update funding_receive_refund_scans set progress_revision=$2,
       last_lease_token=$3,updated_at=clock_timestamp() where event_id=$1`,
    [retry.eventId, revision, retry.leaseToken],
  );
  return { kind, revision };
}

export type SessionlessFundingRoleScanInput = Omit<
  Parameters<typeof advanceReceiveRefundScan>[1],
  "retry"
> & {
  operationId: string;
  event: FundingReceiveCanonicalEventInput;
  /** Existing caller's work identity, not a new financial lease or authority. */
  progressToken: string;
};

export type ProtectedRefundRoleScanInput = SessionlessFundingRoleScanInput & {
  protectedRefundProof: ProtectedRecordedRefundRoleProof;
};

export const SESSIONLESS_FUNDING_ROLE_EVENT_SQL = `select event_row.id,
  (event_row.classification_receive_session_id is null or exists(
    select 1 from funding_receive_sessions session_row
    where session_row.id=event_row.classification_receive_session_id
      and session_row.user_id=$4::uuid)) as owner_matches
  from funding_receive_canonical_events event_row
  where event_row.network_id=$1 and event_row.tx_hash=$2 and event_row.event_index=$3
    and event_row.allocation_status<>'allocated'`;

/** Checkpoint authority only. The provider caller must verify its exact receipt
 * before calling, and must still prove role membership plus O/F before effects.
 * This does not claim the canonical retry queue, bind a session or suppress E.
 */
async function lockSessionlessRoleScanEvent(
  db: PoolClient,
  input: SessionlessFundingRoleScanInput,
): Promise<FundingReceiveClassificationRetry | null> {
  assertRefundSourceActionPageLimit(input.limit);
  if (!supportsRefundSourceEnvelope(input.event))
    throw new Error("Sessionless role scan requires a supported EVM envelope");
  const owner = { operationId: input.operationId, userId: input.userId };
  if (!(await readFundingClassificationRevision(db, owner))) return null;
  const event = {
    ...input.event,
    transactionHash: input.event.transactionHash.toLowerCase(),
  };
  // Multi-event publishers prelock their entire footprint BEFORE invoking this
  // adapter. Reacquiring one already-owned E is harmless; never call after O.
  await lockFundingReceiveCanonicalEvents(db, [event]);
  if (!(await readFundingClassificationRevision(db, owner))) return null;
  const row = (
    await db.query<{ id: string; owner_matches: boolean }>(
      SESSIONLESS_FUNDING_ROLE_EVENT_SQL,
      [event.networkId, event.transactionHash, event.eventIndex, input.userId],
    )
  ).rows[0];
  if (!row?.owner_matches) return null;
  return {
    ...event,
    eventId: row.id,
    leaseToken: input.progressToken,
    boundSessionId: null,
    boundVariantId: null,
  };
}

/** One proof-scoped adapter for an already suppressed RECORDED refund A.
 * It does not upsert/advance E to proposed B. No arbitrary retry constructor or
 * ignore-anchor switch is exposed. All common internals continue to use B's
 * fingerprint on the same stable E ID and preserve their O/U/F requirements. */
async function protectedRefundRoleScanRetry(
  db: PoolClient,
  input: ProtectedRefundRoleScanInput,
): Promise<FundingReceiveClassificationRetry | null> {
  assertRefundSourceActionPageLimit(input.limit);
  if (
    !protectedRecordedRefundRoleProofMatches(input.protectedRefundProof, input)
  )
    return null;
  const facts = await readFundingClassificationRevision(db, input);
  if (!facts || facts.revision !== input.protectedRefundProof.facts.revision)
    return null;
  const event = (
    await db.query<{ id: string; owner_matches: boolean }>(
      SESSIONLESS_FUNDING_ROLE_EVENT_SQL,
      [
        input.event.networkId,
        input.event.transactionHash.toLowerCase(),
        input.event.eventIndex,
        input.userId,
      ],
    )
  ).rows[0];
  if (!event?.owner_matches || event.id !== input.protectedRefundProof.eventId)
    return null;
  return {
    ...input.event,
    eventId: event.id,
    leaseToken: input.progressToken,
    boundSessionId: null,
    boundVariantId: null,
  };
}

export async function readProtectedRefundRoleArbitrationInTransaction(
  db: PoolClient,
  input: ProtectedRefundRoleScanInput,
): Promise<ReceiveRoleArbitration> {
  const retry = await protectedRefundRoleScanRetry(db, input);
  if (!retry)
    return { kind: "incomplete", reason: "candidate_context_changed" };
  return readLockedReceiveRoleArbitration(
    db,
    {
      ...input,
      retry,
      refundEvidence: input.protectedRefundProof.refundEvidence,
    },
    retry,
  );
}

export async function advanceProtectedRefundRoleScanInTransaction(
  db: PoolClient,
  input: ProtectedRefundRoleScanInput,
): Promise<ReceiveRefundScanProgress> {
  const retry = await protectedRefundRoleScanRetry(db, input);
  if (!retry) return { kind: "unavailable" };
  await lockFundingRoleMembershipOwner(db, input.userId);
  if (!(await readFundingClassificationRevision(db, input)))
    throw new FundingClassificationChangedError();
  return advanceLockedReceiveRoleScan(db, { ...input, retry }, retry);
}

export async function checkpointProtectedRefundRoleArbitrationInTransaction(
  db: PoolClient,
  input: ProtectedRefundRoleScanInput,
): Promise<ReceiveRoleArbitration> {
  const retry = await protectedRefundRoleScanRetry(db, input);
  if (!retry)
    return { kind: "incomplete", reason: "candidate_context_changed" };
  await lockFundingRoleMembershipOwner(db, input.userId);
  if (!(await readFundingClassificationRevision(db, input)))
    throw new FundingClassificationChangedError();
  const shared = {
    ...input,
    retry,
    refundEvidence: input.protectedRefundProof.refundEvidence,
  };
  return checkpointLockedReceiveRoleArbitration(
    db,
    shared,
    retry,
    await readLockedReceiveRoleArbitration(db, shared, retry),
  );
}

/** One derived page on the existing provider job tick. Not connected to a new
 * scheduler and not financial publication. A matching real receive session can
 * later use these summaries only through its ordinary bound-lease validation. */
export async function advanceSessionlessFundingRoleScan(
  pool: Pool,
  input: SessionlessFundingRoleScanInput,
): Promise<ReceiveRefundScanProgress> {
  try {
    return await tx(pool, async (db) => {
      await db.query("set transaction isolation level read committed");
      return advanceSessionlessFundingRoleScanInTransaction(db, input);
    });
  } catch (error) {
    if (!(error instanceof FundingClassificationChangedError)) throw error;
    return { kind: "unavailable" };
  }
}

/** One derived page inside a publisher's FULL E footprint. Acquires U NOWAIT,
 * so this transaction MUST commit without later O locks or financial effects,
 * even when a subsequent pure read becomes ready. The next ordinary job tick
 * uses the pure reader and the sorted O union instead. */
export async function advanceSessionlessFundingRoleScanInTransaction(
  db: PoolClient,
  input: SessionlessFundingRoleScanInput,
): Promise<ReceiveRefundScanProgress> {
  const retry = await lockSessionlessRoleScanEvent(db, input);
  if (!retry) return { kind: "unavailable" };
  await lockFundingRoleMembershipOwner(db, input.userId);
  if (!(await readFundingClassificationRevision(db, input)))
    throw new FundingClassificationChangedError();
  return advanceLockedReceiveRoleScan(db, { ...input, retry }, retry);
}

/** Pure ready-path read. Caller owns BEGIN READ COMMITTED and full E prelocks.
 * No checkpoint writes or U lock: collect the entire O union before the late
 * owner/membership fence. This result alone never authorizes credit. */
export async function readSessionlessFundingRoleArbitrationInTransaction(
  db: PoolClient,
  input: SessionlessFundingRoleScanInput & {
    refundEvidence?: ReceiveRefundRoleEvidence;
  },
): Promise<ReceiveRoleArbitration> {
  const retry = await lockSessionlessRoleScanEvent(db, input);
  if (!retry)
    return { kind: "incomplete", reason: "candidate_context_changed" };
  return readLockedReceiveRoleArbitration(db, { ...input, retry }, retry);
}

/** Derived-work branch only: full E -> U NOWAIT -> checkpoint -> COMMIT.
 * Regardless of the returned result, never acquire O or publish effects in this
 * transaction. A later financial tick uses the pure reader above. */
export async function checkpointSessionlessFundingRoleArbitrationInTransaction(
  db: PoolClient,
  input: SessionlessFundingRoleScanInput & {
    refundEvidence?: ReceiveRefundRoleEvidence;
  },
): Promise<ReceiveRoleArbitration> {
  const retry = await lockSessionlessRoleScanEvent(db, input);
  if (!retry)
    return { kind: "incomplete", reason: "candidate_context_changed" };
  await lockFundingRoleMembershipOwner(db, input.userId);
  if (!(await readFundingClassificationRevision(db, input)))
    throw new FundingClassificationChangedError();
  const shared = { ...input, retry };
  const result = await readLockedReceiveRoleArbitration(db, shared, retry);
  return checkpointLockedReceiveRoleArbitration(db, shared, retry, result);
}

/** AFTER full E + sorted O union, before effects. NOWAIT prevents inversion
 * against merge's existing U -> O ordering; fresh RC reads see a completed
 * merge's header reset. Caller must roll back on failure before retrying. */
export async function lockSessionlessFundingRoleMembershipForPublication(
  db: PoolClient,
  input: SessionlessFundingRoleScanInput,
): Promise<void> {
  await lockFundingRoleMembershipOwner(db, input.userId);
  const owner = await readFundingClassificationRevision(db, input);
  const event = (
    await db.query<{ id: string; owner_matches: boolean }>(
      SESSIONLESS_FUNDING_ROLE_EVENT_SQL,
      [
        input.event.networkId,
        input.event.transactionHash.toLowerCase(),
        input.event.eventIndex,
        input.userId,
      ],
    )
  ).rows[0];
  if (!owner || !event?.owner_matches)
    throw new FundingClassificationChangedError();
  const scan = (
    await db.query<ScanRow>(READ_RECEIVE_REFUND_SCAN_SQL, [event.id])
  ).rows[0];
  if (
    !scan ||
    scan.user_id !== input.userId ||
    scan.contract_version !== RECEIVE_ROLE_SCAN_CONTRACT_VERSION ||
    !scan.source_exhausted ||
    scan.event_fingerprint !== receiveRoleEventFingerprint(input.event)
  )
    throw new FundingClassificationChangedError();
}

/** Bounded deletion of DERIVED work only after immutable final allocation.
 * Unresolved events cannot be trimmed into a smaller negative proof set.
 * The header survives until every child is gone. No time-based expiration. */
export async function clearReceiveRefundScanPageInTransaction(
  db: Pick<PoolClient, "query">,
  input: { eventId: string; limit: number },
): Promise<{
  kind: "retained" | "cleared";
  remaining: boolean;
  deleted: number;
}> {
  assertRefundSourceActionPageLimit(input.limit);
  // Lock here as well so a standalone repair cannot invert E -> derived rows.
  const event = (
    await db.query(
      "select allocation_status,allocation_error_code from funding_receive_canonical_events where id=$1 for update",
      [input.eventId],
    )
  ).rows[0];
  // Exact suppression can be revoked by a reorg. Retain all dependencies then.
  if (!event || event.allocation_status !== "allocated")
    return { kind: "retained", remaining: true, deleted: 0 };
  const result = await db.query(DELETE_RECEIVE_REFUND_CANDIDATE_PAGE_SQL, [
    input.eventId,
    input.limit,
  ]);
  const remaining = (
    await db.query(
      `select exists(select 1 from funding_receive_refund_candidates where event_id=$1 limit 1) as remaining`,
      [input.eventId],
    )
  ).rows[0].remaining as boolean;
  if (!remaining)
    await db.query(
      "delete from funding_receive_refund_scans where event_id=$1",
      [input.eventId],
    );
  else
    await db.query(
      "update funding_receive_refund_scans set updated_at=clock_timestamp() where event_id=$1",
      [input.eventId],
    );
  return { kind: "cleared", remaining, deleted: result.rowCount ?? 0 };
}

/** Drain derived rows after immutable allocation, independent of receive-window
 * expiry or retry eligibility. One E per transaction avoids introducing a UUID
 * lock order that conflicts with the financial writers' physical-key order.
 * Dense headers rotate using the existing updated_at; suppression is ineligible.
 * The existing worker budget bounds both selected headers and each child page. */
export async function clearReceiveRefundScanBatch(
  pool: Pool,
  input: { limit: number },
): Promise<{ eventsChecked: number; rowsDeleted: number; errors: number }> {
  assertRefundSourceActionPageLimit(input.limit);
  const { rows } = await pool.query<{ event_id: string }>(
    RECEIVE_REFUND_CLEANUP_PAGE_SQL,
    [input.limit],
  );
  let eventsChecked = 0,
    rowsDeleted = 0,
    errors = 0;
  for (const row of rows) {
    try {
      const result = await tx(pool, async (db) => {
        const locked = await db.query(
          "select id from funding_receive_canonical_events where id=$1 for update skip locked",
          [row.event_id],
        );
        if (!locked.rowCount) return null;
        return clearReceiveRefundScanPageInTransaction(db, {
          eventId: row.event_id,
          limit: input.limit,
        });
      });
      if (result) {
        eventsChecked++;
        rowsDeleted += result.deleted;
        if (result.kind === "retained") errors++;
      }
    } catch {
      errors++;
    }
  }
  return { eventsChecked, rowsDeleted, errors };
}
