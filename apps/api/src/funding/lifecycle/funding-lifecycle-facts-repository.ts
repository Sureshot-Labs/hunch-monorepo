import type { PoolClient } from "@hunch/infra";

import { parseMoneyJson } from "../domain/money-json.js";
import type { FundingPurpose, JsonValue } from "../domain/types.js";
import {
  listFundingObservationsForOperation,
  type FundingObservationRow,
} from "../persistence/funding-operation-repository.js";
import type {
  FundingLifecycleActionAttempt,
  FundingLifecycleActionFact,
  FundingLifecycleActionReceipt,
  FundingLifecycleFacts,
  FundingLifecycleMoney,
  FundingLifecycleReservationFact,
  FundingLifecycleTransferEvidence,
} from "./funding-lifecycle-projector.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

type LifecycleHeaderRow = Readonly<{
  purpose: FundingPurpose;
  requested_destination_amount: JsonRecord | null;
}>;

type LifecycleRouteLegRow = Readonly<{
  id: string;
  quoted_input: JsonRecord;
  quoted_min_output: JsonRecord;
}>;

type LifecycleActionRow = Readonly<{
  action_expires_at: Date | null;
  action_validation_result: JsonRecord;
  attempt_number: number | null;
  attempt_outcome: FundingLifecycleActionAttempt["outcome"] | null;
  broadcast_may_have_occurred: boolean | null;
  depends_on_step_id: string | null;
  id: string;
  ordinal: number;
  receipt_action_match: boolean | null;
  receipt_canonical: boolean | null;
  receipt_evidence: JsonRecord | null;
  receipt_status: FundingLifecycleActionReceipt["status"] | null;
  segment_id: string | null;
  step_kind:
    | "approval"
    | "transaction"
    | "signature"
    | "external_handoff"
    | "server_action"
    | "venue_preparation";
}>;

type LifecycleReservationRow = Readonly<FundingLifecycleReservationFact>;

type LifecycleConsumerRow = Readonly<{
  completed: boolean;
  unresolved: boolean;
}>;

type LifecycleReceiveRow = Readonly<{
  closed_at: Date | null;
  expires_at: Date;
}>;

function lifecycleMoney(
  value: JsonRecord | null,
  label: string,
): FundingLifecycleMoney | null {
  const parsed = parseMoneyJson(value);
  if (!parsed) return null;
  if (!/^0$|^[1-9][0-9]*$/.test(parsed.raw)) {
    throw new Error(`funding lifecycle ${label} has an invalid raw amount`);
  }
  return {
    networkId: parsed.asset.networkId,
    assetId: parsed.asset.assetId,
    decimals: parsed.asset.decimals,
    raw: parsed.raw,
  };
}

function actionActivation(
  validation: JsonRecord,
): FundingLifecycleActionFact["activation"] {
  return validation.activation === "after_verified_ingress"
    ? "after_verified_ingress"
    : "immediate";
}

function actionMayMoveMoney(action: LifecycleActionRow): boolean {
  return !["approval", "signature"].includes(action.step_kind);
}

function receiptFromRow(
  row: LifecycleActionRow,
): FundingLifecycleActionReceipt | null {
  if (row.receipt_status === null || row.receipt_canonical === null) {
    return null;
  }
  return {
    status: row.receipt_status,
    canonical: row.receipt_canonical,
    actionMatched: row.receipt_action_match,
    failureFinalized: row.receipt_evidence?.failureFinalized === true,
  };
}

function transferFromObservation(
  observation: FundingObservationRow,
): FundingLifecycleTransferEvidence {
  return {
    transferId: observation.id,
    routeLegId: observation.segmentId,
    kind: observation.kind,
    money: {
      networkId: observation.networkId,
      assetId: observation.assetId,
      decimals: observation.assetDecimals,
      raw: observation.rawAmount,
    },
    finality: observation.finalityStatus,
    canonical: observation.canonical,
  };
}

/**
 * Loads only lifecycle facts. Do not add `funding_operations.status`,
 * `funding_operation_steps.state`, or `funding_operation_segments.status` to
 * any query in this module: those are materialized output caches.
 */
export async function loadFundingLifecycleFactsForOperationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    now: Date;
  }>,
): Promise<FundingLifecycleFacts | null> {
  const headerResult = await client.query<LifecycleHeaderRow>(
    `
      select
        operation_row.purpose,
        operation_row.requested_destination_amount
      from funding_operations operation_row
      where operation_row.id = $1::uuid
    `,
    [input.operationId],
  );
  const header = headerResult.rows[0];
  if (!header) return null;

  const [
    routeLegResult,
    actionResult,
    observationRows,
    reservationResult,
    consumerResult,
    receiveResult,
  ] = await Promise.all([
    client.query<LifecycleRouteLegRow>(
      `
          select segment.id, segment.quoted_input, segment.quoted_min_output
          from funding_operation_segments segment
          where segment.operation_id = $1::uuid
          order by segment.ordinal asc
        `,
      [input.operationId],
    ),
    client.query<LifecycleActionRow>(
      `
          select
            step.id,
            step.ordinal,
            step.segment_id,
            step.step_kind,
            step.depends_on_step_id,
            step.action_validation_result,
            step.action_expires_at,
            attempt.attempt_number,
            attempt.outcome as attempt_outcome,
            attempt.broadcast_may_have_occurred,
            receipt.status as receipt_status,
            receipt.canonical as receipt_canonical,
            receipt.action_match as receipt_action_match,
            receipt.evidence as receipt_evidence
          from funding_operation_steps step
          left join funding_operation_step_attempts attempt
            on attempt.step_id = step.id
          left join funding_step_receipt_observations receipt
            on receipt.attempt_id = attempt.id
          where step.operation_id = $1::uuid
          order by step.ordinal asc, attempt.attempt_number asc nulls first
        `,
      [input.operationId],
    ),
    listFundingObservationsForOperation(client, input.operationId),
    client.query<LifecycleReservationRow>(
      `
          select reservation.mode, reservation.state
          from balance_reservations reservation
          where reservation.operation_id = $1::uuid
          order by reservation.id asc
        `,
      [input.operationId],
    ),
    client.query<LifecycleConsumerRow>(
      `
          select
            exists (
              select 1
              from funding_trade_attempts trade_attempt
              where trade_attempt.operation_id = $1::uuid
                and trade_attempt.state = 'accepted'
            ) as completed,
            exists (
              select 1
              from funding_trade_attempts trade_attempt
              where trade_attempt.operation_id = $1::uuid
                and trade_attempt.state in (
                  'claimed',
                  'submission_started',
                  'ambiguous'
                )
            ) as unresolved
        `,
      [input.operationId],
    ),
    client.query<LifecycleReceiveRow>(
      `
          select session.closed_at, session.expires_at
          from funding_receive_receipts receipt
          join funding_receive_sessions session
            on session.id = receipt.receive_session_id
          where receipt.child_funding_operation_id = $1::uuid
          order by receipt.created_at desc, receipt.id desc
          limit 1
        `,
      [input.operationId],
    ),
  ]);

  const actionsById = new Map<string, FundingLifecycleActionFact>();
  for (const row of actionResult.rows) {
    const existing = actionsById.get(row.id);
    const attempt =
      row.attempt_number === null ||
      row.attempt_outcome === null ||
      row.broadcast_may_have_occurred === null
        ? null
        : {
            attemptNumber: row.attempt_number,
            outcome: row.attempt_outcome,
            broadcastMayHaveOccurred: row.broadcast_may_have_occurred,
            receipt: receiptFromRow(row),
          };
    if (existing) {
      if (attempt === null) continue;
      actionsById.set(row.id, {
        ...existing,
        attempts: [...existing.attempts, attempt],
      });
      continue;
    }
    actionsById.set(row.id, {
      actionId: row.id,
      ordinal: row.ordinal,
      routeLegId: row.segment_id,
      dependsOnActionId: row.depends_on_step_id,
      activation: actionActivation(row.action_validation_result),
      expiresAt: row.action_expires_at,
      independentLane:
        row.segment_id !== null && row.depends_on_step_id === null,
      mayMoveMoney: actionMayMoveMoney(row),
      requiresVenueReadiness: row.step_kind === "venue_preparation",
      attempts: attempt === null ? [] : [attempt],
    });
  }

  const routeLegs = routeLegResult.rows.map((row) => {
    const requestedSource = lifecycleMoney(
      row.quoted_input,
      `route leg ${row.id} requested source`,
    );
    const minimumDestination = lifecycleMoney(
      row.quoted_min_output,
      `route leg ${row.id} minimum destination`,
    );
    if (!requestedSource || !minimumDestination) {
      throw new Error(
        `funding lifecycle route leg ${row.id} is missing a required amount`,
      );
    }
    return { routeLegId: row.id, requestedSource, minimumDestination };
  });
  const requestedDestination = lifecycleMoney(
    header.requested_destination_amount,
    "requested destination",
  );
  const consumer = consumerResult.rows[0] ?? {
    completed: false,
    unresolved: false,
  };
  const receive = receiveResult.rows[0];
  return {
    plan: {
      requestedDestination,
      routeLegs,
      completionEvidence: (() => {
        const requiresVenueReadiness = [...actionsById.values()].some(
          (action) => action.requiresVenueReadiness,
        );
        if (!requiresVenueReadiness) return "destination_credit" as const;
        return routeLegs.length === 0
          ? "venue_readiness"
          : "destination_credit_and_venue_readiness";
      })(),
    },
    actions: [...actionsById.values()],
    transfers: observationRows.map(transferFromObservation),
    reservations: reservationResult.rows,
    consumer: {
      required: header.purpose === "trade_shortfall",
      completed: consumer.completed,
      unresolved: consumer.unresolved,
    },
    receive:
      receive && receive.closed_at === null
        ? { open: true, expiresAt: receive.expires_at }
        : null,
    now: input.now,
  };
}
