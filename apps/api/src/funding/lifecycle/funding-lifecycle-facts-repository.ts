import type { PoolClient } from "@hunch/infra";

import { parseMoneyJson } from "../domain/money-json.js";
import type { FundingPurpose, JsonValue } from "../domain/types.js";
import {
  isValidFundingOperationState,
  type FundingOperationState,
} from "../domain/transitions.js";
import { relayEvmFundingProfileSpec } from "../execution/relay-evm-profile-specs.js";
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
  plan_snapshot: JsonRecord;
  purpose: FundingPurpose;
  user_id: string;
  requested_destination_amount: JsonRecord | null;
  support_metadata: JsonRecord;
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
  attempt_reference_kind: FundingLifecycleActionAttempt["referenceKind"] | null;
  attempt_started_at: Date | null;
  attempt_updated_at: Date | null;
  broadcast_may_have_occurred: boolean | null;
  depends_on_step_id: string | null;
  executor_id: string;
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
  settled_without_consumer: boolean;
  unresolved: boolean;
}>;

type LifecycleReceiveRow = Readonly<{
  closed_at: Date | null;
  expires_at: Date;
}>;

type DelegatedTelegramAuthorizationFacts = Readonly<{
  intentActive: boolean;
  reservationActive: boolean;
}>;

function delegatedTelegramIntentId(
  supportMetadata: JsonRecord,
): string | null {
  if (supportMetadata.delegatedOriginKind !== "trade_shortfall_intent") {
    return null;
  }
  const intentId = supportMetadata.telegramTradeIntentId;
  return typeof intentId === "string" && intentId.trim() ? intentId : "";
}

async function loadDelegatedTelegramAuthorizationFacts(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    userId: string;
    supportMetadata: JsonRecord;
  }>,
): Promise<DelegatedTelegramAuthorizationFacts | null> {
  const intentId = delegatedTelegramIntentId(input.supportMetadata);
  if (intentId === null) return null;
  if (!intentId) {
    return { intentActive: false, reservationActive: false };
  }
  const { rows } = await client.query<DelegatedTelegramAuthorizationFacts>(
    `
      select
        exists (
          select 1
          from telegram_trade_intents trade_intent
          where trade_intent.id::text = $2
            and trade_intent.user_id = $3::uuid
            and trade_intent.status = 'funding'
            and trade_intent.submit_started_at is null
            and (
              trade_intent.funding_operation_id = $1::uuid
              or trade_intent.funding_operation_id::text =
                   $4::jsonb ->> 'continuationOfOperationId'
            )
        ) as "intentActive",
        exists (
          select 1
          from telegram_funding_authorization_reservations reservation
          where reservation.funding_operation_id = $1::uuid
            and reservation.source_trade_intent_id::text = $2
            and reservation.status = 'reserved'
        ) as "reservationActive"
    `,
    [
      input.operationId,
      intentId,
      input.userId,
      input.supportMetadata,
    ],
  );
  return rows[0] ?? { intentActive: false, reservationActive: false };
}

function actionAuthorization(
  action: LifecycleActionRow,
  telegram: DelegatedTelegramAuthorizationFacts | null,
): FundingLifecycleActionFact["authorization"] {
  if (telegram === null) return undefined;
  const isRouterAction = action.executor_id === "polymarket_deposit_pusd_fund_v1";
  const isRelayAction = relayEvmFundingProfileSpec(action.executor_id) !== null;
  if (!isRouterAction && !isRelayAction) return undefined;
  return telegram.intentActive && (isRouterAction || telegram.reservationActive)
    ? "granted"
    : "blocked";
}

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

function immutableInitialState(planSnapshot: JsonRecord): Readonly<{
  status: FundingLifecycleFacts["plan"]["initialState"]["status"];
  progressStage: FundingLifecycleFacts["plan"]["initialState"]["progressStage"];
}> {
  const operation = planSnapshot.operation;
  const initialState =
    operation !== null && typeof operation === "object"
      ? (operation as JsonRecord).initialState
      : null;
  const status =
    initialState !== null && typeof initialState === "object"
      ? (initialState as JsonRecord).status
      : null;
  const stage =
    initialState !== null && typeof initialState === "object"
      ? (initialState as JsonRecord).stage
      : null;
  if (typeof status !== "string" || typeof stage !== "string") {
    throw new Error(
      "funding lifecycle plan is missing its immutable initial state",
    );
  }
  const candidate: FundingOperationState = {
    status: status as FundingOperationState["status"],
    stage: stage as FundingOperationState["stage"],
  };
  if (!isValidFundingOperationState(candidate)) {
    throw new Error(
      "funding lifecycle plan has an invalid immutable initial state",
    );
  }
  return {
    status: candidate.status,
    progressStage: candidate.stage,
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

function actionRequiresSourceDebitEvidence(
  action: LifecycleActionRow,
): boolean {
  // The same receipt postcondition also appears on user-signed Relay actions
  // and direct withdrawals, and may describe an approval. Only a delegated
  // Relay *money-moving* action requires the extra operation-level
  // source-debit gate; the immutable executor ID and step kind together are
  // the plan boundary that distinguishes that policy from those other actions.
  return (
    actionMayMoveMoney(action) &&
    relayEvmFundingProfileSpec(action.executor_id) !== null &&
    action.action_validation_result.postconditionEvidenceKind ===
      "exact_erc20_source_debit_v1"
  );
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
    observedAt: observation.observedAt,
    reorgedAt: observation.reorgedAt,
    replacementForTransferId:
      typeof observation.metadata.replacementForRefundObservationId === "string"
        ? observation.metadata.replacementForRefundObservationId
        : null,
  };
}

function reconciliationEvidenceDeadline(
  supportMetadata: JsonRecord,
  now: Date,
  timeoutMs: number,
): Date | null {
  const persistedDeadline = supportMetadata.reconciliationEvidenceDeadline;
  if (typeof persistedDeadline === "string") {
    const parsedDeadline = new Date(persistedDeadline);
    if (Number.isFinite(parsedDeadline.getTime())) return parsedDeadline;
  }
  const startedAtValue = supportMetadata.reconciliationActiveSince;
  if (typeof startedAtValue !== "string") return null;
  const startedAt = new Date(startedAtValue);
  if (
    !Number.isFinite(startedAt.getTime()) ||
    startedAt.getTime() > now.getTime() ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  ) {
    return null;
  }
  return new Date(startedAt.getTime() + timeoutMs);
}

function lifecycleCancellation(
  supportMetadata: JsonRecord,
): FundingLifecycleFacts["cancellation"] {
  const candidate = supportMetadata.lifecycleCancellation;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return null;
  }
  const requestedAt = (candidate as JsonRecord).requestedAt;
  if (typeof requestedAt !== "string") return null;
  const parsed = new Date(requestedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return { requestedAt: parsed };
}

function lifecycleManualRecovery(
  supportMetadata: JsonRecord,
): FundingLifecycleFacts["manualRecovery"] {
  const candidate = supportMetadata.lifecycleManualRecovery;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return null;
  }
  const code = (candidate as JsonRecord).code;
  const requestedAt = (candidate as JsonRecord).requestedAt;
  if (typeof code !== "string" || typeof requestedAt !== "string") {
    return null;
  }
  const parsed = new Date(requestedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return { code, requestedAt: parsed };
}

/**
 * Loads lifecycle facts, not transitional materialized state. Do not add
 * `funding_operation_steps.state` or `funding_operation_segments.status`, or
 * use `funding_operations.status` for a live decision: they are output
 * caches. Terminality is derived from immutable plan, action, receipt,
 * transfer, and consumer facts like every other lifecycle state.
 */
export async function loadFundingLifecycleFactsForOperationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    now: Date;
    reconciliationEvidenceTimeoutMs?: number;
  }>,
): Promise<FundingLifecycleFacts | null> {
  const headerResult = await client.query<LifecycleHeaderRow>(
    `
      select
        operation_row.user_id,
        operation_row.purpose,
        operation_row.requested_destination_amount,
        operation_row.support_metadata,
        quote.plan_snapshot
      from funding_operations operation_row
      join funding_quotes quote on quote.id = operation_row.quote_id
      where operation_row.id = $1::uuid
    `,
    [input.operationId],
  );
  const header = headerResult.rows[0];
  if (!header) return null;
  const telegramAuthorization = await loadDelegatedTelegramAuthorizationFacts(
    client,
    {
      operationId: input.operationId,
      userId: header.user_id,
      supportMetadata: header.support_metadata,
    },
  );

  // A reducer passes one transactional pg client. Parallel `client.query()`
  // calls only queue behind each other today and are deprecated by pg, so keep
  // this factual read explicit and serial.
  const routeLegResult = await client.query<LifecycleRouteLegRow>(
    `
      select segment.id, segment.quoted_input, segment.quoted_min_output
      from funding_operation_segments segment
      where segment.operation_id = $1::uuid
      order by segment.ordinal asc
    `,
    [input.operationId],
  );
  const actionResult = await client.query<LifecycleActionRow>(
    `
      select
        step.id,
        step.ordinal,
        step.segment_id,
        step.step_kind,
        step.depends_on_step_id,
        step.action_validation_result,
        step.action_expires_at,
        step.executor_id,
        attempt.attempt_number,
        attempt.outcome as attempt_outcome,
        attempt.broadcast_may_have_occurred,
        attempt.reference_kind as attempt_reference_kind,
        attempt.started_at as attempt_started_at,
        coalesce(
          attempt.updated_at,
          attempt.finished_at,
          attempt.started_at
        ) as attempt_updated_at,
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
  );
  const observationRows = await listFundingObservationsForOperation(
    client,
    input.operationId,
  );
  const reservationResult = await client.query<LifecycleReservationRow>(
    `
      select reservation.mode, reservation.state
      from balance_reservations reservation
      where reservation.operation_id = $1::uuid
      order by reservation.id asc
    `,
    [input.operationId],
  );
  const consumerResult = await client.query<LifecycleConsumerRow>(
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
        ) as unresolved,
        exists (
          select 1
          from balance_reservations reservation
          where reservation.operation_id = $1::uuid
            and reservation.mode = 'settled_for_consumer'
            and reservation.state in ('consumed', 'released')
        ) as settled_without_consumer
    `,
    [input.operationId],
  );
  const receiveResult = await client.query<LifecycleReceiveRow>(
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
  );

  const actionsById = new Map<string, FundingLifecycleActionFact>();
  for (const row of actionResult.rows) {
    const existing = actionsById.get(row.id);
    const attempt =
      row.attempt_number === null ||
      row.attempt_outcome === null ||
      row.broadcast_may_have_occurred === null ||
      row.attempt_started_at === null ||
      row.attempt_updated_at === null
        ? null
        : {
            attemptNumber: row.attempt_number,
            outcome: row.attempt_outcome,
            broadcastMayHaveOccurred: row.broadcast_may_have_occurred,
            referenceKind: row.attempt_reference_kind,
            startedAt: row.attempt_started_at,
            updatedAt: row.attempt_updated_at,
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
      executorId: row.executor_id,
      routeLegId: row.segment_id,
      dependsOnActionId: row.depends_on_step_id,
      activation: actionActivation(row.action_validation_result),
      expiresAt: row.action_expires_at,
      independentLane:
        row.segment_id !== null && row.depends_on_step_id === null,
      mayMoveMoney: actionMayMoveMoney(row),
      requiresSourceDebitEvidence: actionRequiresSourceDebitEvidence(row),
      requiresVenueReadiness: row.step_kind === "venue_preparation",
      authorization: actionAuthorization(row, telegramAuthorization),
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
    settled_without_consumer: false,
    unresolved: false,
  };
  const receive = receiveResult.rows[0];
  return {
    plan: {
      initialState: immutableInitialState(header.plan_snapshot),
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
      settledWithoutConsumer: consumer.settled_without_consumer,
      unresolved: consumer.unresolved,
    },
    receive:
      receive && receive.closed_at === null
        ? { open: true, expiresAt: receive.expires_at }
        : null,
    cancellation: lifecycleCancellation(header.support_metadata),
    manualRecovery: lifecycleManualRecovery(header.support_metadata),
    reconciliation: {
      evidenceDeadline: reconciliationEvidenceDeadline(
        header.support_metadata,
        input.now,
        input.reconciliationEvidenceTimeoutMs ?? 0,
      ),
    },
    now: input.now,
  };
}
