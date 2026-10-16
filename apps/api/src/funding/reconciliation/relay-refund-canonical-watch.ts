import type { Pool } from "@hunch/infra";
import { isRecord } from "../../lib/type-guards.js";
import { createHip4AccountClient } from "../../services/hip4-client.js";
import {
  admitHip4Request,
  readHip4Policy,
} from "../../services/hip4-repository.js";
import {
  commitFundingClassificationTransaction,
  FundingClassificationChangedError,
} from "../persistence/funding-classification-revisions.js";
import { EXACT_REFUND_OBSERVER_ID } from "./relay-exact-refund-receipts.js";
import {
  inspectEvmRefundCanonicality,
  inspectNativeRefundCanonicality,
  type RefundCanonicalProof,
  type RefundCanonicalTarget,
} from "./relay-refund-canonical-proof.js";
import {
  REFUND_CANONICAL_OPERATION_SQL,
  REFUND_CANONICAL_PAGE_SQL,
  readRefundCanonicalTarget,
  readRefundWatchReceipt,
  refundWatchBindingFingerprint,
  refundWatchFacts,
  type RefundWatchRow,
} from "./relay-refund-watch-context.js";
import {
  protectRefundCanonicalProofs,
  type RefundWatchResult,
} from "./relay-refund-watch-effects.js";
import {
  publishRefundCanonicalRestoration,
  type RefundWatchPublicationWork,
} from "./relay-refund-watch-publication.js";
import {
  fundingEvidenceBudgetClient,
  setFundingEvidenceQueryBudget,
} from "./funding-evidence-budget.js";
export {
  REFUND_CANONICAL_PAGE_SQL,
  type RefundWatchRow,
} from "./relay-refund-watch-context.js";
export { persistRefundCanonicalProofs } from "./relay-refund-watch-effects.js";
export {
  REFUND_CANONICAL_LOCK_SQL,
  REFUND_RECEIVE_ANCHOR_UPDATE_SQL,
} from "../persistence/canonical-event-lock-sql.js";
const MIN_UUID = "00000000-0000-0000-0000-000000000000";
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** Unfinished pages and unresolved verification survive the ordinary terminal
 * watch window. This flag is diagnostic/work scheduling, never money evidence. */
export { exactRefundWatchPending } from "./relay-refund-watch-state.js";

export async function pollRelayRefundCanonicalWatch(
  pool: Pool,
  input: {
    operationId: string;
    now: Date;
    limit: number;
    deadlineMs?: number;
    publication?: RefundWatchPublicationWork;
  },
  inspect?: (
    target: RefundCanonicalTarget,
    now: Date,
  ) => Promise<RefundCanonicalProof>,
  clock: () => number = Date.now,
) {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 2147483647
  )
    throw new Error("Invalid refund watch page limit");
  const priorRow = await pool.query<{
    watch: unknown;
    has_exact_contract: boolean;
    user_id: string;
    classification_revision: string;
  }>(REFUND_CANONICAL_OPERATION_SQL, [input.operationId]);
  if (!priorRow.rows.length) return { checked: 0, changed: 0, pending: false };
  const prior = priorRow.rows[0].watch;
  if (!priorRow.rows[0].has_exact_contract && prior == null)
    return { checked: 0, changed: 0, pending: false };
  const state = isRecord(prior) && prior.version === 1 ? prior : {};
  const afterId =
    typeof state.afterId === "string" && uuid.test(state.afterId)
      ? state.afterId
      : null;
  const { rows } = await pool.query<RefundWatchRow>(REFUND_CANONICAL_PAGE_SQL, [
    input.operationId,
    afterId ?? MIN_UUID,
    input.limit,
  ]);
  const deadline = input.deadlineMs ?? Number.POSITIVE_INFINITY;
  let nativePolicy:
    | Awaited<ReturnType<typeof readHip4Policy>>["policy"]
    | undefined;
  const readNative = async (
    owner: string,
    startTime: number,
    endTime: number,
  ) => {
    if (!nativePolicy) {
      const { policy: configured } = await readHip4Policy(pool, "accountRead");
      nativePolicy = { ...configured, environment: "mainnet" as const };
    }
    const policy = {
      ...nativePolicy,
      requestTimeoutMs: Math.max(
        1,
        Math.min(nativePolicy.requestTimeoutMs, Math.ceil(deadline - clock())),
      ),
    };
    const nativeRead = createHip4AccountClient(policy, (weight) =>
      admitHip4Request(pool, "mainnet", weight, policy.requestWeightPerMinute),
    );
    return nativeRead({
      type: "userNonFundingLedgerUpdates",
      user: owner,
      startTime,
      endTime,
    });
  };
  const results: RefundWatchResult[] = [];
  let visitedId: string | null = afterId;
  let interrupted = false;
  for (const row of rows) {
    if (clock() >= deadline) {
      interrupted = true;
      break;
    }
    const receipt = JSON.parse(row.receipt_snapshot);
    if (receipt.metadata?.observerId !== EXACT_REFUND_OBSERVER_ID) {
      visitedId = receipt.id;
      continue;
    }
    const target = readRefundCanonicalTarget(row);
    let proof: RefundCanonicalProof;
    try {
      proof = !target
        ? { kind: "pending", reason: "refund_watch_contract_invalid" }
        : inspect
          ? await inspect(target, input.now)
          : target.asset.networkId.startsWith("evm:")
            ? await inspectEvmRefundCanonicality(
                target,
                input.now,
                undefined,
                deadline,
              )
            : await inspectNativeRefundCanonicality(target, readNative);
    } catch {
      proof = { kind: "pending", reason: "refund_watch_transport_error" };
    }
    if (
      proof.kind === "pending" &&
      ["refund_watch_budget_exhausted", "refund_watch_deadline"].includes(
        proof.reason,
      )
    ) {
      interrupted = true;
      break;
    }
    results.push({ row, proof });
    visitedId = receipt.id;
  }
  // Chain admission can stop before a known row is inspected. Protect its
  // already recorded ownership anyway; a pending proof never retracts it.
  // This is the SAME bounded page, and visitedId remains at the last actually
  // processed row so budget denial cannot skip its next ordinary verification.
  const inspected = new Map(results.map((result) => [result.row, result]));
  const protectionRows: RefundWatchResult[] = rows.flatMap((row) => {
    if (
      JSON.parse(row.receipt_snapshot).metadata?.observerId !==
      EXACT_REFUND_OBSERVER_ID
    )
      return [];
    return [
      inspected.get(row) ?? {
        row,
        proof: {
          kind: "pending" as const,
          reason: "refund_watch_read_budget_pending",
        },
      },
    ];
  });
  const operationFacts = refundWatchFacts(
    {
      ...priorRow.rows[0],
      receipt_snapshot: "",
      refund_location_snapshot: null,
      provider_quote_ref_lookup_hmac: null,
      lookup_key_version: null,
    },
    input.operationId,
  );
  let protectedResult: Awaited<ReturnType<typeof protectRefundCanonicalProofs>>;
  let pending: boolean;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set transaction isolation level read committed");
    const db = input.publication
      ? fundingEvidenceBudgetClient(client, input.publication.work.deadlineMs)
      : client;
    protectedResult = await protectRefundCanonicalProofs(db, {
      operationId: input.operationId,
      now: input.now,
      rows: protectionRows,
      operationFacts,
    });
    const sweepPending =
      (afterId !== null && state.sweepPending === true) ||
      results.some((result) => result.proof.kind === "pending") ||
      protectedResult.stale ||
      protectedResult.restorations.length > 0;
    const nextId =
      interrupted || rows.length === input.limit ? visitedId : null;
    pending = interrupted || sweepPending || nextId !== null;
    // Cursor is diagnostic only, in protection BEFORE original F. Never write
    // it after a derived U checkpoint. A successful restore can clear it on the
    // next ordinary complete sweep; restored cash is available immediately.
    if (rows.length || afterId || prior !== null) {
      const updated = await db.query(
        `update funding_operations set version=version+1, support_metadata=jsonb_set(support_metadata,
          '{exactRefundCanonicalWatch}',$3::jsonb,true)
          where id=$1::uuid and coalesce(support_metadata->'exactRefundCanonicalWatch','null'::jsonb)=$2::jsonb`,
        [
          input.operationId,
          JSON.stringify(prior ?? null),
          {
            version: 1,
            afterId: nextId,
            pending,
            sweepPending,
            checkedAt: input.now.toISOString(),
            reason: interrupted
              ? "refund_watch_read_budget_pending"
              : protectedResult.stale
                ? "refund_watch_snapshot_changed"
                : protectedResult.restorations.length
                  ? "refund_watch_role_publication_pending"
                  : results.some((result) => result.proof.kind === "pending")
                    ? "refund_watch_verification_pending"
                    : null,
          },
        ],
      );
      if (!updated.rowCount) throw new FundingClassificationChangedError();
    }
    if (input.publication)
      await setFundingEvidenceQueryBudget(
        client,
        input.publication.work.deadlineMs,
      );
    await commitFundingClassificationTransaction(client, [
      operationFacts,
      ...protectionRows.map(({ row }) =>
        refundWatchFacts(row, input.operationId),
      ),
    ]);
  } catch (error) {
    await client.query("rollback");
    // No durable pending cursor survived this rollback. Propagate through the
    // existing worker retry path; a return-only pending could finish a terminal
    // job before its ordinary next canonical verification.
    throw error;
  } finally {
    client.release();
  }
  let changed = protectedResult.changed;
  for (const restoration of protectedResult.restorations) {
    const expected = JSON.parse(restoration.row.receipt_snapshot);
    // Adopt facts after OUR protection commit only if the exact captured receipt
    // and ORIGINAL source/refund contract survive. Never graft RPC A->B onto C.
    const fresh = await readRefundWatchReceipt(pool, {
      receiptId: expected.id,
      operationId: input.operationId,
      snapshot: restoration.row.receipt_snapshot,
    });
    if (
      !fresh ||
      refundWatchBindingFingerprint(fresh) !==
        refundWatchBindingFingerprint(restoration.row)
    ) {
      pending = true;
      continue;
    }
    const result = await publishRefundCanonicalRestoration(pool, {
      operationId: input.operationId,
      row: fresh,
      now: input.now,
      canonical: restoration.canonical,
      publication: input.publication,
    });
    if (result.changed) changed++;
    if (result.reason) pending = true;
  }
  return { checked: results.length, changed, pending };
}
