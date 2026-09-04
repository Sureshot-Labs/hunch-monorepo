import type { PoolClient } from "@hunch/infra";

import { parseMoneyJson } from "../domain/money-json.js";
import type { FundingPurpose, JsonValue } from "../domain/types.js";
import {
  isValidFundingOperationState,
  type FundingOperationState,
} from "../domain/transitions.js";
import { relayEvmFundingProfileSpec } from "../execution/relay-evm-profile-specs.js";
import {
  listFundingObservationsForOperations,
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
  operation_id: string;
  plan_snapshot: JsonRecord;
  purpose: FundingPurpose;
  user_id: string;
  requested_destination_amount: JsonRecord | null;
  support_metadata: JsonRecord;
}>;

type LifecycleRouteLegRow = Readonly<{
  id: string;
  operation_id: string;
  quoted_input: JsonRecord;
  quoted_min_output: JsonRecord;
}>;

type LifecycleActionRow = Readonly<{
  action_expires_at: Date | null;
  action_validation_result: JsonRecord;
  attempt_actual_costs: JsonRecord | null;
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
  operation_id: string;
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

type LifecycleReservationRow = Readonly<
  FundingLifecycleReservationFact & { operation_id: string }
>;

type LifecycleConsumerRow = Readonly<{
  completed: boolean;
  operation_id: string;
  settled_without_consumer: boolean;
  unresolved: boolean;
}>;

type LifecycleReceiveRow = Readonly<{
  closed_at: Date | null;
  expires_at: Date;
  operation_id: string;
}>;

type DelegatedTelegramAuthorizationFacts = Readonly<{
  intentActive: boolean;
  reservationActive: boolean;
}>;

type LifecycleAuthorizationRow = Readonly<
  DelegatedTelegramAuthorizationFacts & { operation_id: string }
>;

function delegatedTelegramIntentId(supportMetadata: JsonRecord): string | null {
  if (supportMetadata.delegatedOriginKind !== "trade_shortfall_intent") {
    return null;
  }
  const intentId = supportMetadata.telegramTradeIntentId;
  return typeof intentId === "string" && intentId.trim() ? intentId : "";
}

function actionAuthorization(
  action: LifecycleActionRow,
  telegram: DelegatedTelegramAuthorizationFacts | null,
): FundingLifecycleActionFact["authorization"] {
  if (telegram === null) return undefined;
  const isRouterAction =
    action.executor_id === "polymarket_deposit_pusd_fund_v1";
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
  if (["approval", "signature"].includes(action.step_kind)) return false;
  // Relay's approve action is represented by its generic transaction step
  // kind. Its immutable profile payload, rather than a mutable step cache,
  // is the canonical distinction from the following money-moving deposit.
  return !(
    relayEvmFundingProfileSpec(action.executor_id) !== null &&
    action.action_validation_result.relayStepKind === "approve"
  );
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

function actionRequiresAllowanceZeroEvidence(
  action: LifecycleActionRow,
): boolean {
  return (
    relayEvmFundingProfileSpec(action.executor_id) !== null &&
    action.action_validation_result.relayStepKind === "cleanup"
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
    // A Relay allowance read at the approval's height but a different block
    // hash invalidates that approval's exact postcondition. This is durable
    // receipt evidence, not a mutable deposit-step cache override.
    actionMatched:
      row.receipt_evidence?.allowanceAnchorRejected === true ||
      row.receipt_evidence?.allowanceExactRejected === true ||
      (actionRequiresAllowanceZeroEvidence(row) &&
        row.receipt_evidence?.allowanceOwnershipRejected === true) ||
      (actionRequiresAllowanceZeroEvidence(row) &&
        row.receipt_evidence?.allowanceZero !== true)
        ? false
        : row.receipt_action_match,
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

/**
 * Lifecycle decisions are recorded as small, append-only facts in support
 * metadata until the dedicated durable-event schema lands in Stage 3. Keep
 * their decoding here, rather than letting each projection branch perform its
 * own untyped JSON checks.
 */
function lifecycleMetadataRecord(
  supportMetadata: JsonRecord,
  key: string,
): JsonRecord | null {
  const candidate = supportMetadata[key];
  return candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate)
    ? (candidate as JsonRecord)
    : null;
}

function lifecycleMetadataDate(metadata: JsonRecord, key: string): Date | null {
  const value = metadata[key];
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function lifecycleCancellation(
  supportMetadata: JsonRecord,
): FundingLifecycleFacts["cancellation"] {
  const candidate = lifecycleMetadataRecord(
    supportMetadata,
    "lifecycleCancellation",
  );
  const requestedAt = candidate
    ? lifecycleMetadataDate(candidate, "requestedAt")
    : null;
  return requestedAt ? { requestedAt } : null;
}

function lifecycleManualRecovery(
  supportMetadata: JsonRecord,
): FundingLifecycleFacts["manualRecovery"] {
  const candidate = lifecycleMetadataRecord(
    supportMetadata,
    "lifecycleManualRecovery",
  );
  const code = candidate?.code;
  const requestedAt = candidate
    ? lifecycleMetadataDate(candidate, "requestedAt")
    : null;
  return typeof code === "string" && requestedAt ? { code, requestedAt } : null;
}

function lifecycleAutomaticRecovery(
  supportMetadata: JsonRecord,
): FundingLifecycleFacts["automaticRecovery"] {
  const candidate = lifecycleMetadataRecord(
    supportMetadata,
    "lifecycleAutomaticRecovery",
  );
  const code = candidate?.code;
  const requestedAt = candidate
    ? lifecycleMetadataDate(candidate, "requestedAt")
    : null;
  if (typeof code === "string" && requestedAt) {
    return { code, requestedAt };
  }

  // Operations written before the projector recorded the same durable event
  // as two diagnostics fields. Read them once as facts so an in-flight route
  // cannot regress merely because its active-window cache is cleared.
  const fallbackCode = supportMetadata.reconciliationRecoveryReason;
  if (typeof fallbackCode !== "string") {
    return null;
  }
  const fallbackRequestedAt = lifecycleMetadataDate(
    supportMetadata,
    "reconciliationRecoveryRequiredAt",
  );
  return fallbackRequestedAt
    ? { code: fallbackCode, requestedAt: fallbackRequestedAt }
    : null;
}

function lifecycleTerminalFailure(
  supportMetadata: JsonRecord,
): FundingLifecycleFacts["terminalFailure"] {
  const candidate = lifecycleMetadataRecord(
    supportMetadata,
    "lifecycleTerminalFailure",
  );
  const code = candidate?.code;
  const decidedAt = candidate
    ? lifecycleMetadataDate(candidate, "decidedAt")
    : null;
  if (typeof code !== "string" || !decidedAt) return null;
  const actionId = candidate?.actionId;
  return {
    code,
    decidedAt,
    actionId: typeof actionId === "string" ? actionId : null,
  };
}

function lifecycleTerminalCompletion(
  supportMetadata: JsonRecord,
): FundingLifecycleFacts["terminalCompletion"] {
  const candidate = lifecycleMetadataRecord(
    supportMetadata,
    "lifecycleTerminalCompletion",
  );
  const code = candidate?.code;
  const decidedAt = candidate
    ? lifecycleMetadataDate(candidate, "decidedAt")
    : null;
  const actionId = candidate?.actionId;
  if (typeof code !== "string" || !decidedAt || typeof actionId !== "string") {
    return null;
  }
  return { code, decidedAt, actionId };
}

function compileFundingLifecycleFacts(
  input: Readonly<{
    actionRows: readonly LifecycleActionRow[];
    consumer: LifecycleConsumerRow | null;
    header: LifecycleHeaderRow;
    now: Date;
    observationRows: readonly FundingObservationRow[];
    receive: LifecycleReceiveRow | null;
    reconciliationEvidenceTimeoutMs: number;
    reservationRows: readonly LifecycleReservationRow[];
    routeLegRows: readonly LifecycleRouteLegRow[];
    telegramAuthorization: DelegatedTelegramAuthorizationFacts | null;
  }>,
): FundingLifecycleFacts {
  const {
    actionRows,
    consumer,
    header,
    now,
    observationRows,
    receive,
    reconciliationEvidenceTimeoutMs,
    reservationRows,
    routeLegRows,
    telegramAuthorization,
  } = input;
  const actionsById = new Map<string, FundingLifecycleActionFact>();
  for (const row of actionRows) {
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
            retryableAfterFailure:
              row.attempt_actual_costs?.retryableProviderFailure === true,
            retryableAfterReorg:
              row.attempt_actual_costs?.retryableAfterReorg === true,
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

  const routeLegs = routeLegRows.map((row) => {
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
  const consumerFacts = consumer ?? {
    completed: false,
    operation_id: header.operation_id,
    settled_without_consumer: false,
    unresolved: false,
  };
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
    reservations: reservationRows,
    consumer: {
      required: header.purpose === "trade_shortfall",
      completed: consumerFacts.completed,
      settledWithoutConsumer: consumerFacts.settled_without_consumer,
      unresolved: consumerFacts.unresolved,
    },
    receive:
      receive && receive.closed_at === null
        ? { open: true, expiresAt: receive.expires_at }
        : null,
    cancellation: lifecycleCancellation(header.support_metadata),
    manualRecovery: lifecycleManualRecovery(header.support_metadata),
    automaticRecovery: lifecycleAutomaticRecovery(header.support_metadata),
    terminalFailure: lifecycleTerminalFailure(header.support_metadata),
    terminalCompletion: lifecycleTerminalCompletion(header.support_metadata),
    reconciliation: {
      evidenceDeadline: reconciliationEvidenceDeadline(
        header.support_metadata,
        now,
        reconciliationEvidenceTimeoutMs,
      ),
    },
    now,
  };
}

function groupRowsByOperation<Row extends Readonly<{ operation_id: string }>>(
  rows: readonly Row[],
): ReadonlyMap<string, readonly Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const existing = grouped.get(row.operation_id);
    if (existing) existing.push(row);
    else grouped.set(row.operation_id, [row]);
  }
  return grouped;
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
  const factsByOperation =
    await loadFundingLifecycleFactsForOperationsInTransaction(client, {
      now: input.now,
      operationIds: [input.operationId],
      reconciliationEvidenceTimeoutMs: input.reconciliationEvidenceTimeoutMs,
    });
  return factsByOperation.get(input.operationId) ?? null;
}

/**
 * Bounded lifecycle page loader. It deliberately executes a fixed sequence of
 * fact queries so both Pool and PoolClient callers remain safe, while avoiding
 * the serial per-operation N+1 that made a 100-row history page expensive.
 */
export async function loadFundingLifecycleFactsForOperationsInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    now: Date;
    operationIds: readonly string[];
    reconciliationEvidenceTimeoutMs?: number;
  }>,
): Promise<ReadonlyMap<string, FundingLifecycleFacts>> {
  const requestedOperationIds = [...new Set(input.operationIds)];
  if (requestedOperationIds.length === 0) return new Map();
  const headerResult = await client.query<LifecycleHeaderRow>(
    `
      select operation_row.id::text as operation_id,
             operation_row.user_id,
             operation_row.purpose,
             operation_row.requested_destination_amount,
             operation_row.support_metadata,
             quote.plan_snapshot
        from funding_operations operation_row
        join funding_quotes quote on quote.id = operation_row.quote_id
       where operation_row.id = any($1::uuid[])
    `,
    [requestedOperationIds],
  );
  if (headerResult.rows.length === 0) return new Map();
  const operationIds = headerResult.rows.map((row) => row.operation_id);
  const delegatedOperationIds = headerResult.rows
    .filter((row) => delegatedTelegramIntentId(row.support_metadata) !== null)
    .map((row) => row.operation_id);

  // Keep the fixed query sequence serial: PoolClient callers cannot safely
  // issue concurrent pg queries. The page costs seven set reads for ordinary
  // operations (eight when it includes delegated Telegram authorization),
  // rather than seven or eight reads for every operation in it.
  const authorizationRows =
    delegatedOperationIds.length === 0
      ? []
      : (
          await client.query<LifecycleAuthorizationRow>(
            `
      select operation_row.id::text as operation_id,
             exists (
               select 1
                 from telegram_trade_intents trade_intent
                where trade_intent.id::text =
                        operation_row.support_metadata ->> 'telegramTradeIntentId'
                  and trade_intent.user_id = operation_row.user_id
                  and trade_intent.status = 'funding'
                  and trade_intent.submit_started_at is null
                  and (
                    trade_intent.funding_operation_id = operation_row.id
                    or trade_intent.funding_operation_id::text =
                         operation_row.support_metadata ->>
                           'continuationOfOperationId'
                  )
             ) as "intentActive",
             exists (
               select 1
                 from telegram_funding_authorization_reservations reservation
                where reservation.funding_operation_id = operation_row.id
                  and reservation.source_trade_intent_id::text =
                        operation_row.support_metadata ->> 'telegramTradeIntentId'
                  and reservation.status = 'reserved'
             ) as "reservationActive"
        from funding_operations operation_row
       where operation_row.id = any($1::uuid[])
         and operation_row.support_metadata ->> 'delegatedOriginKind' =
               'trade_shortfall_intent'
    `,
            [delegatedOperationIds],
          )
        ).rows;
  const routeLegResult = await client.query<LifecycleRouteLegRow>(
    `
      select segment.operation_id::text as operation_id,
             segment.id,
             segment.quoted_input,
             segment.quoted_min_output
        from funding_operation_segments segment
       where segment.operation_id = any($1::uuid[])
       order by segment.operation_id asc, segment.ordinal asc
    `,
    [operationIds],
  );
  const actionResult = await client.query<LifecycleActionRow>(
    `
      select step.operation_id::text as operation_id,
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
             attempt.actual_costs as attempt_actual_costs,
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
       where step.operation_id = any($1::uuid[])
       order by step.operation_id asc,
                step.ordinal asc,
                attempt.attempt_number asc nulls first
    `,
    [operationIds],
  );
  const observationsByOperation = await listFundingObservationsForOperations(
    client,
    operationIds,
  );
  const reservationResult = await client.query<LifecycleReservationRow>(
    `
      select reservation.operation_id::text as operation_id,
             reservation.mode,
             reservation.state
        from balance_reservations reservation
       where reservation.operation_id = any($1::uuid[])
       order by reservation.operation_id asc, reservation.id asc
    `,
    [operationIds],
  );
  const consumerResult = await client.query<LifecycleConsumerRow>(
    `
      select operation_ids.operation_id::text as operation_id,
             exists (
               select 1
                 from funding_trade_attempts trade_attempt
                where trade_attempt.operation_id = operation_ids.operation_id
                  and trade_attempt.state = 'accepted'
             ) as completed,
             exists (
               select 1
                 from funding_trade_attempts trade_attempt
                where trade_attempt.operation_id = operation_ids.operation_id
                  and trade_attempt.state in (
                    'claimed',
                    'submission_started',
                    'ambiguous'
                  )
             ) as unresolved,
             exists (
               select 1
                 from balance_reservations reservation
                where reservation.operation_id = operation_ids.operation_id
                  and reservation.mode = 'settled_for_consumer'
                  and reservation.state in ('consumed', 'released')
             ) as settled_without_consumer
        from unnest($1::uuid[]) as operation_ids(operation_id)
    `,
    [operationIds],
  );
  const receiveResult = await client.query<LifecycleReceiveRow>(
    `
      select distinct on (receipt.child_funding_operation_id)
             receipt.child_funding_operation_id::text as operation_id,
             session.closed_at,
             session.expires_at
        from funding_receive_receipts receipt
        join funding_receive_sessions session
          on session.id = receipt.receive_session_id
       where receipt.child_funding_operation_id = any($1::uuid[])
       order by receipt.child_funding_operation_id asc,
                receipt.created_at desc,
                receipt.id desc
    `,
    [operationIds],
  );

  const authorizationsByOperation = new Map(
    authorizationRows.map((row) => [
      row.operation_id,
      {
        intentActive: row.intentActive,
        reservationActive: row.reservationActive,
      } satisfies DelegatedTelegramAuthorizationFacts,
    ]),
  );
  const routeLegsByOperation = groupRowsByOperation(routeLegResult.rows);
  const actionsByOperation = groupRowsByOperation(actionResult.rows);
  const reservationsByOperation = groupRowsByOperation(reservationResult.rows);
  const consumersByOperation = new Map(
    consumerResult.rows.map((row) => [row.operation_id, row]),
  );
  const receivesByOperation = new Map(
    receiveResult.rows.map((row) => [row.operation_id, row]),
  );
  const factsByOperation = new Map<string, FundingLifecycleFacts>();
  for (const header of headerResult.rows) {
    const delegatedIntentId = delegatedTelegramIntentId(
      header.support_metadata,
    );
    factsByOperation.set(
      header.operation_id,
      compileFundingLifecycleFacts({
        actionRows: actionsByOperation.get(header.operation_id) ?? [],
        consumer: consumersByOperation.get(header.operation_id) ?? null,
        header,
        now: input.now,
        observationRows: observationsByOperation.get(header.operation_id) ?? [],
        receive: receivesByOperation.get(header.operation_id) ?? null,
        reconciliationEvidenceTimeoutMs:
          input.reconciliationEvidenceTimeoutMs ?? 0,
        reservationRows: reservationsByOperation.get(header.operation_id) ?? [],
        routeLegRows: routeLegsByOperation.get(header.operation_id) ?? [],
        telegramAuthorization:
          delegatedIntentId === null
            ? null
            : (authorizationsByOperation.get(header.operation_id) ?? {
                intentActive: false,
                reservationActive: false,
              }),
      }),
    );
  }
  return factsByOperation;
}
