import { tx, type Pool, type PoolClient } from "@hunch/infra";
import {
  admitHip4OrderActionInTransaction,
  type Hip4SubmissionRecord,
} from "../repos/hip4-order-admission.js";
import { lockFundingPolicyForTransaction } from "../funding/policies/funding-policy-sidecar.js";
import { projectTelegramNativeHandoffStatusInTransaction } from "../repos/telegram-native-handoff-read.js";
import { recordFundingTradeAttemptOutcomeInTransaction } from "../funding/persistence/funding-trade-attempt-repository.js";
import { releaseFundingReservationForAbandonedTradeInTransaction } from "../funding/persistence/funding-evidence-repository.js";
import { z } from "zod";
import type { Hip4TradeSigningInput } from "./hip4-trade-signing.js";
import { classifyHip4SingleTradeReply } from "./hip4-trade-reply.js";
import {
  postHyperliquidExchangeOnce,
  type HyperliquidExchangeTransport,
} from "./hyperliquid-exchange.js";

/** Only the first exchange response to a newly admitted POST. Replayed HTTP
 * requests do not enter here. A cancel ACK / fill summary is not an execution,
 * final order state, balance receipt or authority to release a debit hold. */
export async function recordHip4SubmissionReplyInTransaction(
  db: PoolClient,
  input: { userId: string; actionId: string; body: unknown },
) {
  await lockFundingPolicyForTransaction(db);
  await db.query("select id from users where id=$1 for update", [input.userId]);
  const found = await db.query<
    Hip4SubmissionRecord & {
      order_id: string;
      unsigned_envelope: Hip4TradeSigningInput;
    }
  >(
    `select submission_row.*,action_row.order_id,action_row.unsigned_envelope
      from hip4_order_submissions submission_row join hip4_order_actions action_row on action_row.id=submission_row.action_id
      join orders order_row on order_row.id=action_row.order_id
      where submission_row.action_id=$1 and order_row.user_id=$2`,
    [input.actionId, input.userId],
  );
  const row = found.rows[0];
  if (!row) throw new Error("hip4_submission_not_found");
  if (row.state !== "submission_started") return row;
  const reply = classifyHip4SingleTradeReply(
    row.unsigned_envelope.action,
    input.body,
  );
  const rejected = reply.kind === "rejected" || reply.kind === "no_fill";
  if (row.funding_trade_attempt_id) {
    await recordFundingTradeAttemptOutcomeInTransaction(db, {
      userId: input.userId,
      attemptId: row.funding_trade_attempt_id,
      outcome: rejected ? "definitive_failure" : "ambiguous",
      broadcastMayHaveOccurred: !rejected,
      errorCode: rejected
        ? `hip4_${reply.kind}`
        : "hip4_order_reconciliation_required",
    });
    if (rejected) {
      const link = z
        .object({
          operationId: z.string().uuid(),
          reservationId: z.string().uuid(),
        })
        .parse(row.admission_snapshot.funding);
      await releaseFundingReservationForAbandonedTradeInTransaction(db, {
        userId: input.userId,
        link,
        outcomeReason: `hip4_${reply.kind}`,
      });
    }
  }
  // Update the prepared economic order. Generic venue-order upsert would make
  // another order when the oid arrives for the first time.
  const orderId =
    reply.kind === "resting" || reply.kind === "filled_summary"
      ? reply.orderId
      : null;
  if (row.unsigned_envelope.action.type === "order") {
    const changed = await db.query(
      `update orders set
      venue_order_id=coalesce(venue_order_id,$2),status=$3
      where id=$1 and (venue_order_id is null or $2::text is null or venue_order_id=$2) returning id`,
      [
        row.order_id,
        orderId,
        rejected
          ? reply.kind === "no_fill"
            ? "no_fill"
            : "failed"
          : "submitted",
      ],
    );
    if (changed.rows.length !== 1)
      throw new Error("hip4_order_reference_conflict");
  }
  const submission = (
    await db.query<Hip4SubmissionRecord>(
      `update hip4_order_submissions set state=$2,reply_summary=$3::jsonb,
    updated_at=clock_timestamp() where action_id=$1 and state='submission_started' returning *`,
      [input.actionId, rejected ? "rejected" : "reconcile_required", reply],
    )
  ).rows[0];
  await projectTelegramNativeHandoffStatusInTransaction(db, input);
  return submission;
}

/** Connected one-shot path. Context comes from trusted server observation,
 * never client-supplied policy, fees or balances.
 * No signer is invoked here. Tests inject transport; runtime uses the fixed
 * native endpoint. Failed commit/unknown commit never grants POST authority. */
export async function submitHip4OrderAction(
  pool: Pool,
  input: Parameters<typeof admitHip4OrderActionInTransaction>[1],
  transport: HyperliquidExchangeTransport,
  // Internal test seam only: cannot arrive in a JSON/public request. Default
  // uses the common venue lifecycle and the ordinary native admission gates.
  capabilityCheck?: Parameters<typeof admitHip4OrderActionInTransaction>[2],
) {
  const admitted = await tx(pool, (db) =>
    admitHip4OrderActionInTransaction(db, input, capabilityCheck),
  );
  if (!admitted.admitted)
    return { replayed: true, submission: admitted.submission };
  const response = await postHyperliquidExchangeOnce(
    admitted.environment,
    admitted.request,
    transport,
  );
  try {
    const submission = await tx(pool, (db) =>
      recordHip4SubmissionReplyInTransaction(db, {
        userId: input.userId,
        actionId: input.actionId,
        body: response.kind === "response" ? response.body : null,
      }),
    );
    return { replayed: false, submission };
  } catch {
    // The persisted action is discoverable for reconciliation. Do not leak
    // transport/signature/DB errors or retry the exchange after a failed write.
    return { replayed: false, submission: admitted.submission };
  }
}
