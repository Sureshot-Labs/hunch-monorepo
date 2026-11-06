import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { randomUUID } from "node:crypto";

import type {
  JsonValue,
  NormalizedAction,
  PreparationPurpose,
} from "../domain/types.js";
import { canonicalJsonEqual, canonicalJsonHash } from "./canonical.js";
import { FundingPersistenceError } from "./funding-operation-repository.js";
import {
  preparationAdmissionKeyHash,
  preparationExecutionKey,
  type PreparationAdmission,
  type PreparationExecutionJournal,
} from "../preparation/admission-contract.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type PreparationApprovalOutcome =
  | Readonly<{ actionId: string; status: "pending" | "unknown" }>
  | Readonly<{
      actionId: string;
      status: "succeeded" | "failed";
      evidence: JsonRecord;
    }>;

export type FundingPreparationRunRequest = Readonly<{
  venueBindingOptionId: string;
  purpose: PreparationPurpose;
  marketContextId: string | null;
  marketClass: string | null;
  positionActionRef: string | null;
  controllerWalletRef: string | null;
  expectedInspectionRevision: string;
  executionJournal?: PreparationExecutionJournal;
}>;

export type FundingPreparationActionState =
  | "action_required"
  | "submitted"
  | "ambiguous"
  | "failed"
  | "cancelled"
  | "succeeded";

export type FundingPreparationRunStatus =
  | FundingPreparationActionState
  | "expired";

export type FundingPreparationActionAttempt = Readonly<{
  actionId: string;
  ordinal: number;
  actionFingerprint: string;
  action: NormalizedAction;
  state: FundingPreparationActionState;
  broadcastMayHaveOccurred: boolean;
  transactionReference: string | null;
  report: JsonRecord | null;
  reportedAt: Date | null;
  resolvedAt: Date | null;
}>;

export type FundingPreparationRun = Readonly<{
  runId: string;
  userId: string;
  requestFingerprint: string;
  request: FundingPreparationRunRequest;
  inspectionRevision: string;
  controllerWalletRef: string | null;
  status: FundingPreparationRunStatus;
  expiresAt: Date;
  resolvedAt: Date | null;
  actions: readonly FundingPreparationActionAttempt[];
  replayed: boolean;
}>;

type RunRow = {
  id: string;
  user_id: string;
  request_fingerprint: string;
  request_snapshot: FundingPreparationRunRequest;
  inspection_revision: string;
  controller_wallet_ref: string | null;
  status: FundingPreparationRunStatus;
  expires_at: Date;
  resolved_at: Date | null;
};

type ActionRow = {
  action_id: string;
  ordinal: number;
  action_fingerprint: string;
  normalized_action: NormalizedAction;
  state: FundingPreparationActionState;
  broadcast_may_have_occurred: boolean;
  transaction_reference: string | null;
  report_snapshot: JsonRecord | null;
  reported_at: Date | null;
  resolved_at: Date | null;
};

const RUN_COLUMNS = `
  id, user_id, request_fingerprint, request_snapshot, inspection_revision,
  controller_wallet_ref, status, expires_at, resolved_at
`;

const ACTION_COLUMNS = `
  action_id, ordinal, action_fingerprint, normalized_action, state,
  broadcast_may_have_occurred, transaction_reference, report_snapshot,
  reported_at, resolved_at
`;

function mapAction(row: ActionRow): FundingPreparationActionAttempt {
  return {
    actionId: row.action_id,
    ordinal: row.ordinal,
    actionFingerprint: row.action_fingerprint,
    action: row.normalized_action,
    state: row.state,
    broadcastMayHaveOccurred: row.broadcast_may_have_occurred,
    transactionReference: row.transaction_reference,
    report: row.report_snapshot,
    reportedAt: row.reported_at,
    resolvedAt: row.resolved_at,
  };
}

async function loadActions(
  client: Pick<PoolClient, "query">,
  runId: string,
  forUpdate = false,
): Promise<readonly FundingPreparationActionAttempt[]> {
  const result = await client.query<ActionRow>(
    `
      select ${ACTION_COLUMNS}
      from funding_preparation_action_attempts
      where run_id = $1
      order by ordinal
      ${forUpdate ? "for update" : ""}
    `,
    [runId],
  );
  return result.rows.map(mapAction);
}

async function mapRun(
  client: Pick<PoolClient, "query">,
  row: RunRow,
  replayed: boolean,
  forUpdate = false,
): Promise<FundingPreparationRun> {
  return {
    runId: row.id,
    userId: row.user_id,
    requestFingerprint: row.request_fingerprint,
    request: row.request_snapshot,
    inspectionRevision: row.inspection_revision,
    controllerWalletRef: row.controller_wallet_ref,
    status: row.status,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    actions: await loadActions(client, row.id, forUpdate),
    replayed,
  };
}

async function expireUnsubmittedRunIfNeeded(
  client: Pick<PoolClient, "query">,
  row: RunRow,
  now = new Date(),
): Promise<RunRow> {
  if (
    row.status !== "action_required" ||
    row.expires_at.getTime() > now.getTime()
  ) {
    return row;
  }
  const expired = await client.query<RunRow>(
    `
      update funding_preparation_runs
      set status = 'expired', resolved_at = $2
      where id = $1
        and status = 'action_required'
        and expires_at <= $2
      returning ${RUN_COLUMNS}
    `,
    [row.id, now],
  );
  return expired.rows[0] ?? row;
}

export function fundingPreparationRequestFingerprint(
  request: FundingPreparationRunRequest,
): string {
  return `preparation_${canonicalJsonHash({
    schema: "funding_preparation_request_v1",
    venueBindingOptionId: request.venueBindingOptionId,
    purpose: request.purpose,
    marketContextId: request.marketContextId,
    marketClass: request.marketClass,
    positionActionRef: request.positionActionRef,
    controllerWalletRef: request.controllerWalletRef,
    expectedInspectionRevision: request.expectedInspectionRevision,
  })}`;
}

function preparationScopeFingerprint(
  request: FundingPreparationRunRequest,
): string {
  return `preparation_admission_${canonicalJsonHash({
    schema: "preparation_scope_v1",
    venueBindingOptionId: request.venueBindingOptionId,
    purpose: request.purpose,
    marketContextId: request.marketContextId,
    positionActionRef: request.positionActionRef,
  })}`;
}

export async function createOrReplayFundingPreparationRun(
  pool: Pool,
  input: Readonly<{
    userId: string;
    request: FundingPreparationRunRequest;
    expiresAt: Date;
    admissionProtocolVersion?: 1;
    materialize: (
      runId: string,
      renewal?: Readonly<{
        forceFresh: true;
        controllerWalletRef: string | null;
      }>,
    ) => Promise<
      Readonly<{
        actions: readonly NormalizedAction[];
        controllerWalletRef: string;
      }>
    >;
  }>,
): Promise<FundingPreparationRun> {
  const scopeFingerprint = preparationScopeFingerprint(input.request);
  const legacyFingerprint = fundingPreparationRequestFingerprint(input.request);
  const requestFingerprint =
    input.admissionProtocolVersion === 1 ? scopeFingerprint : legacyFingerprint;
  return tx(pool, async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`funding-preparation:${input.userId}:${scopeFingerprint}`],
    );
    const existing = await client.query<RunRow>(
      `
        select ${RUN_COLUMNS}
        from funding_preparation_runs
        where user_id = $1 and request_fingerprint = any($2::text[])
        order by (request_fingerprint = $3) desc
        limit 1
        for update
      `,
      [input.userId, [scopeFingerprint, legacyFingerprint], scopeFingerprint],
    );
    if (
      !existing.rows[0] ||
      (input.admissionProtocolVersion === 1 &&
        !existing.rows[0].request_snapshot.executionJournal)
    ) {
      // Legacy clients had no pre-wallet fence. A new revision/version is not
      // evidence that an older action in the same business scope never ran.
      const legacy = await client.query<RunRow>(
        `select ${RUN_COLUMNS} from funding_preparation_runs
         where user_id=$1 and request_snapshot->'executionJournal' is null
           and request_snapshot->>'venueBindingOptionId'=$2
           and request_snapshot->>'purpose'=$3
           and (request_snapshot->>'marketContextId') is not distinct from $4::text
           and (request_snapshot->>'positionActionRef') is not distinct from $5::text
           and status in ('action_required','submitted','ambiguous','expired')
         order by updated_at desc limit 1 for update`,
        [
          input.userId,
          input.request.venueBindingOptionId,
          input.request.purpose,
          input.request.marketContextId,
          input.request.positionActionRef,
        ],
      );
      if (legacy.rows[0])
        return mapRun(
          client,
          await expireUnsubmittedRunIfNeeded(client, legacy.rows[0]),
          true,
          true,
        );
    }
    let renewal:
      | Readonly<{ forceFresh: true; controllerWalletRef: string | null }>
      | undefined;
    if (existing.rows[0]) {
      const existingRun = await expireUnsubmittedRunIfNeeded(
        client,
        existing.rows[0],
      );
      const mapped = await mapRun(client, existingRun, true, true);
      const journal = mapped.request.executionJournal;
      if (journal && input.admissionProtocolVersion !== 1) return mapped;
      const untouched =
        mapped.actions.length > 0 &&
        mapped.actions.every(
          (action) =>
            action.state === "action_required" &&
            !action.broadcastMayHaveOccurred &&
            action.transactionReference === null &&
            action.report === null &&
            action.reportedAt === null &&
            action.resolvedAt === null,
        );
      const isExplicitlyNotStarted = (
        action: FundingPreparationActionAttempt,
      ) =>
        ["cancelled", "failed"].includes(action.state) &&
        !action.broadcastMayHaveOccurred &&
        action.transactionReference === null &&
        (journal?.admissions[action.actionId]?.phase === "not_started" ||
          (action.state === "cancelled" &&
            action.report?.notStartedReason === "wallet_not_invoked"));
      const explicitlyNotStarted =
        mapped.actions.length > 0 &&
        mapped.actions.every(isExplicitlyNotStarted);
      const hasKnownNotStarted = mapped.actions.some(isExplicitlyNotStarted);
      const completedOrUntouched =
        mapped.actions.length > 0 &&
        (mapped.actions.some((action) => action.state === "succeeded") ||
          hasKnownNotStarted) &&
        mapped.actions.every(
          (action) =>
            action.state === "succeeded" ||
            isExplicitlyNotStarted(action) ||
            (action.state === "action_required" &&
              !action.broadcastMayHaveOccurred &&
              !action.report &&
              !action.transactionReference &&
              !action.reportedAt &&
              !action.resolvedAt),
        ) &&
        Object.entries(journal?.admissions ?? {}).every(
          ([actionId, grant]) =>
            mapped.actions.find((action) => action.actionId === actionId)
              ?.state === "succeeded" ||
            grant.phase === "not_started" ||
            (grant.delivery === "embedded" && grant.phase === "reserved"),
        );
      const evidenceChanged =
        mapped.inspectionRevision !== input.request.expectedInspectionRevision;
      const canRetire =
        input.admissionProtocolVersion === 1 &&
        (((mapped.status === "expired" ||
          ["failed", "cancelled"].includes(mapped.status) ||
          (mapped.status === "action_required" &&
            (evidenceChanged || hasKnownNotStarted))) &&
          journal?.version === 1 &&
          ((untouched &&
            Object.values(journal.admissions).every(
              (grant) =>
                grant.delivery === "embedded" && grant.phase === "reserved",
            )) ||
            completedOrUntouched)) ||
          (["cancelled", "failed"].includes(mapped.status) &&
            explicitlyNotStarted) ||
          (mapped.status === "succeeded" && evidenceChanged));
      if (!canRetire) return mapped;
      // Keep every historical run/action/report. Only the live lookup slot is
      // retired. Stale grants still resolve to the closed original run.
      await client.query(
        "update funding_preparation_runs set request_fingerprint=$2, status=case when status='action_required' then 'expired' else status end, resolved_at=case when status='action_required' then now() else resolved_at end where id=$1",
        [mapped.runId, `${mapped.requestFingerprint}:retired:${mapped.runId}`],
      );
      renewal = {
        forceFresh: true,
        controllerWalletRef: mapped.controllerWalletRef,
      };
    }

    const runResult = await client.query<RunRow>(
      `
        insert into funding_preparation_runs (
          user_id, request_fingerprint, request_snapshot,
          inspection_revision, controller_wallet_ref, status, expires_at,
          resolved_at
        )
        values (
          $1, $2, $3::jsonb, $4, $5, 'action_required', $6, null
        )
        returning ${RUN_COLUMNS}
      `,
      [
        input.userId,
        requestFingerprint,
        input.admissionProtocolVersion === 1
          ? {
              ...input.request,
              executionJournal: { version: 1, admissions: {} },
            }
          : input.request,
        input.request.expectedInspectionRevision,
        input.request.controllerWalletRef,
        input.expiresAt,
      ],
    );
    const row = runResult.rows[0];
    if (!row) throw new Error("funding preparation run insert returned no row");
    const materialized = await input.materialize(row.id, renewal);
    if (
      renewal?.controllerWalletRef &&
      materialized.controllerWalletRef !== renewal.controllerWalletRef
    ) {
      throw new FundingPersistenceError(
        "idempotency_conflict",
        "preparation controller changed; inspect again",
      );
    }
    if (
      row.controller_wallet_ref !== null &&
      materialized.controllerWalletRef !== row.controller_wallet_ref
    ) {
      throw new FundingPersistenceError(
        "idempotency_conflict",
        "preparation controller wallet changed during materialization",
      );
    }
    for (const [ordinal, action] of materialized.actions.entries()) {
      const actionFingerprint = canonicalJsonHash(action);
      await client.query(
        `
          insert into funding_preparation_action_attempts (
            action_id, run_id, ordinal, action_fingerprint, normalized_action
          )
          values ($1, $2, $3, $4, $5::jsonb)
        `,
        [action.actionId, row.id, ordinal, actionFingerprint, action],
      );
    }
    if (materialized.actions.length === 0) {
      const completed = await client.query<RunRow>(
        `
          update funding_preparation_runs
          set controller_wallet_ref = $2,
              status = 'succeeded',
              resolved_at = now()
          where id = $1
          returning ${RUN_COLUMNS}
        `,
        [row.id, materialized.controllerWalletRef],
      );
      return mapRun(client, completed.rows[0] ?? row, false, true);
    }
    const materializedRun = await client.query<RunRow>(
      `
        update funding_preparation_runs
        set controller_wallet_ref = $2
        where id = $1
        returning ${RUN_COLUMNS}
      `,
      [row.id, materialized.controllerWalletRef],
    );
    return mapRun(client, materializedRun.rows[0] ?? row, false, true);
  });
}

export async function fetchFundingPreparationRun(
  pool: Pool,
  input: Readonly<{ userId: string; runId: string }>,
): Promise<FundingPreparationRun | null> {
  return tx(pool, async (client) => {
    const result = await client.query<RunRow>(
      `
        select ${RUN_COLUMNS}
        from funding_preparation_runs
        where id = $1 and user_id = $2
        for update
      `,
      [input.runId, input.userId],
    );
    if (!result.rows[0]) return null;
    const run = await expireUnsubmittedRunIfNeeded(client, result.rows[0]);
    return mapRun(client, run, false, true);
  });
}

export type FundingPreparationActionReport = Readonly<{
  outcome: "submitted" | "ambiguous" | "failed" | "cancelled";
  transactionReference: string | null;
  networkFeeRaw: string | null;
  admissionKey?: string;
  notStartedReason?: "wallet_not_invoked" | "wallet_rejected";
}>;

export type FundingPreparationAdmissionResult = Readonly<{
  runId: string;
  actionId: string;
  admitted: boolean;
  requestKeyMatches: boolean;
  action: NormalizedAction | null;
  executionKey: string | null;
  delivery: "client" | "embedded";
}>;

async function lockPreparationRun(
  client: PoolClient,
  userId: string,
  runId: string,
) {
  const result = await client.query<RunRow>(
    `select ${RUN_COLUMNS} from funding_preparation_runs where id=$1 and user_id=$2 for update`,
    [runId, userId],
  );
  const row = result.rows[0];
  if (!row)
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding preparation run was not found",
    );
  return row;
}

async function startPreparationAdmission(
  client: PoolClient,
  action: FundingPreparationActionAttempt,
  now: Date,
) {
  await client.query(
    `update funding_preparation_action_attempts
     set state='ambiguous', broadcast_may_have_occurred=true,
         report_snapshot=$2::jsonb,reported_at=$3
     where action_id=$1`,
    [
      action.actionId,
      {
        outcome: "ambiguous",
        transactionReference: null,
        networkFeeRaw: null,
        admissionPending: true,
      },
      now,
    ],
  );
}

/** One-time grant. A retry never returns executable payload, even to the same caller. */
export async function admitFundingPreparationAction(
  pool: Pool,
  input: Readonly<{
    userId: string;
    runId: string;
    actionId: string;
    requestKey: string;
    inspectionRevision: string;
    controllerWalletRef: string;
    executionMode: "web_client" | "privy_authorization";
    signer: string;
  }>,
): Promise<FundingPreparationAdmissionResult> {
  const keyHash = preparationAdmissionKeyHash(input.requestKey);
  return tx(pool, async (client) => {
    const row = await lockPreparationRun(client, input.userId, input.runId);
    const journal = row.request_snapshot.executionJournal;
    if (journal?.version !== 1)
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "This preparation predates execution admission; do not resend an uncertain wallet action",
      );
    const actions = await loadActions(client, row.id, true);
    const action = actions.find(
      (candidate) => candidate.actionId === input.actionId,
    );
    if (!action)
      throw new FundingPersistenceError(
        "operation_not_found",
        "funding preparation action was not found",
      );
    const previous = journal.admissions[action.actionId];
    if (previous)
      return {
        runId: row.id,
        actionId: action.actionId,
        admitted: false,
        requestKeyMatches: previous.keyHash === keyHash,
        action: null,
        executionKey: null,
        delivery: previous.delivery,
      };
    const now = new Date();
    if (
      !["action_required", "submitted", "ambiguous"].includes(row.status) ||
      row.expires_at <= now ||
      action.state !== "action_required" ||
      action.broadcastMayHaveOccurred ||
      action.report ||
      action.transactionReference ||
      row.inspection_revision !== input.inspectionRevision ||
      row.controller_wallet_ref !== input.controllerWalletRef
    ) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "Preparation is closed, changed or already submitted; inspect its existing status",
      );
    }
    const embedded =
      input.executionMode === "privy_authorization" &&
      ["evm_transaction", "evm_transaction_batch"].includes(action.action.kind);
    const grant: PreparationAdmission = {
      id: randomUUID(),
      keyHash,
      delivery: embedded ? "embedded" : "client",
      signer: input.signer,
      phase: embedded ? "reserved" : "started",
      createdAt: now.toISOString(),
    };
    const request = {
      ...row.request_snapshot,
      executionJournal: {
        ...journal,
        admissions: { ...journal.admissions, [action.actionId]: grant },
      },
    };
    if (!embedded) await startPreparationAdmission(client, action, now);
    const status = runStatusForActions(await loadActions(client, row.id, true));
    await client.query(
      "update funding_preparation_runs set request_snapshot=$2::jsonb,status=$3 where id=$1",
      [row.id, request, status],
    );
    return {
      runId: row.id,
      actionId: action.actionId,
      admitted: true,
      requestKeyMatches: true,
      action: action.action,
      executionKey: preparationExecutionKey({
        runId: row.id,
        actionId: action.actionId,
        admissionId: grant.id,
      }),
      delivery: grant.delivery,
    };
  });
}

/** Validate and fence server-mediated dispatch before its provider POST. */
export async function beginEmbeddedPreparationDispatch(
  pool: Pool,
  input: Readonly<{
    userId: string;
    runId: string;
    actionId: string;
    admissionId: string;
    validate: (action: NormalizedAction, grant: PreparationAdmission) => void;
  }>,
): Promise<void> {
  return tx(pool, async (client) => {
    const row = await lockPreparationRun(client, input.userId, input.runId);
    const journal = row.request_snapshot.executionJournal;
    const grant = journal?.admissions[input.actionId];
    const actions = await loadActions(client, row.id, true);
    const action = actions.find(
      (candidate) => candidate.actionId === input.actionId,
    );
    if (
      !action ||
      !journal ||
      !grant ||
      grant.id !== input.admissionId ||
      grant.delivery !== "embedded"
    )
      throw new FundingPersistenceError(
        "quote_mismatch",
        "Embedded request does not match its preparation admission",
      );
    input.validate(action.action, grant);
    if (
      grant.phase !== "reserved" ||
      action.state !== "action_required" ||
      action.broadcastMayHaveOccurred ||
      !["action_required", "submitted", "ambiguous"].includes(row.status) ||
      row.expires_at <= new Date()
    )
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "Preparation requires status recovery, not another send",
      );
    await startPreparationAdmission(client, action, new Date());
    await client.query(
      "update funding_preparation_runs set request_snapshot=$2::jsonb,status=$3 where id=$1",
      [
        row.id,
        {
          ...row.request_snapshot,
          executionJournal: {
            ...journal,
            admissions: {
              ...journal.admissions,
              [input.actionId]: { ...grant, phase: "started" },
            },
          },
        },
        runStatusForActions(await loadActions(client, row.id, true)),
      ],
    );
  });
}

function actionStateForReport(
  report: FundingPreparationActionReport,
): Exclude<FundingPreparationActionState, "action_required" | "succeeded"> {
  return report.outcome;
}

function runStatusForActions(
  actions: readonly FundingPreparationActionAttempt[],
): FundingPreparationRunStatus {
  if (actions.some((action) => action.state === "ambiguous"))
    return "ambiguous";
  if (actions.some((action) => action.state === "submitted"))
    return "submitted";
  // An unresolved broadcast still wins above; an unsubmitted sibling must
  // not restart a run after another approval has provably failed.
  if (actions.some((action) => action.state === "failed")) return "failed";
  if (actions.some((action) => action.state === "action_required")) {
    return "action_required";
  }
  if (actions.some((action) => action.state === "cancelled"))
    return "cancelled";
  return "succeeded";
}

export async function reportFundingPreparationAction(
  pool: Pool,
  input: Readonly<{
    userId: string;
    runId: string;
    actionId: string;
    report: FundingPreparationActionReport;
    internalAdmissionId?: string;
    now?: Date;
  }>,
): Promise<FundingPreparationRun> {
  return tx(pool, async (client) => {
    const runResult = await client.query<RunRow>(
      `
        select ${RUN_COLUMNS}
        from funding_preparation_runs
        where id = $1 and user_id = $2
        for update
      `,
      [input.runId, input.userId],
    );
    const run = runResult.rows[0];
    if (!run) {
      throw new FundingPersistenceError(
        "operation_not_found",
        "funding preparation run was not found",
      );
    }
    const actions = await loadActions(client, run.id, true);
    const action = actions.find(
      (candidate) => candidate.actionId === input.actionId,
    );
    if (!action) {
      throw new FundingPersistenceError(
        "operation_not_found",
        "funding preparation action was not found",
      );
    }
    const journal = run.request_snapshot.executionJournal;
    const grant = journal?.admissions[action.actionId];
    const internal = Boolean(
      grant &&
      input.internalAdmissionId === grant.id &&
      grant.delivery === "embedded",
    );
    if (
      journal &&
      (!grant ||
        (!internal &&
          (!input.report.admissionKey ||
            preparationAdmissionKeyHash(input.report.admissionKey) !==
              grant.keyHash)))
    ) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "A matching preparation admission is required before reporting execution",
      );
    }
    if (grant?.phase === "not_started") {
      if (
        action.report?.outcome === input.report.outcome &&
        action.transactionReference === input.report.transactionReference
      )
        return mapRun(client, run, true, true);
      throw new FundingPersistenceError(
        "idempotency_conflict",
        "This admission was explicitly closed without execution",
      );
    }
    const negative =
      input.report.outcome === "failed" || input.report.outcome === "cancelled";
    if (
      grant &&
      negative &&
      (((grant.delivery === "embedded" || grant.phase === "reported") &&
        action.broadcastMayHaveOccurred &&
        !internal) ||
        !input.report.notStartedReason)
    ) {
      // A client timeout or generic failure cannot undo a server dispatch.
      return mapRun(client, run, true, true);
    }
    const reportSnapshot: JsonRecord = {
      outcome: input.report.outcome,
      transactionReference: input.report.transactionReference,
      networkFeeRaw: input.report.networkFeeRaw,
      ...(input.report.notStartedReason
        ? { notStartedReason: input.report.notStartedReason }
        : {}),
    };
    const pendingAdmission = Boolean(
      grant &&
      (action.report?.admissionPending === true ||
        (action.state === "ambiguous" &&
          action.transactionReference === null &&
          ((internal && negative) ||
            input.report.transactionReference !== null))) &&
      ["started", "reported"].includes(grant.phase),
    );
    if (action.report) {
      // The server may already know provider acceptance when the caller lost
      // that response. A weaker timeout report cannot erase the reference or
      // trap status-only recovery behind a permanent idempotency conflict.
      if (
        grant &&
        action.transactionReference &&
        input.report.transactionReference === null &&
        input.report.outcome === "ambiguous"
      )
        return mapRun(client, run, true, true);
      const sameAcceptedReference = Boolean(
        grant &&
        action.report.outcome === input.report.outcome &&
        action.transactionReference === input.report.transactionReference,
      );
      if (
        !pendingAdmission &&
        !sameAcceptedReference &&
        !canonicalJsonEqual(action.report, reportSnapshot)
      ) {
        throw new FundingPersistenceError(
          "idempotency_conflict",
          "funding preparation action already has a different report",
        );
      }
      if (!pendingAdmission) return mapRun(client, run, true, true);
    }
    if (action.state !== "action_required" && !pendingAdmission) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "funding preparation action is not awaiting a report",
      );
    }
    const state = actionStateForReport(input.report);
    const broadcastMayHaveOccurred =
      state === "submitted" || state === "ambiguous";
    const now = input.now ?? new Date();
    await client.query(
      `
        update funding_preparation_action_attempts
        set state = $4,
            broadcast_may_have_occurred = $5,
            transaction_reference = $6,
            report_snapshot = $7::jsonb,
            reported_at = $8::timestamptz,
            resolved_at = case
              when $5::boolean then null
              else $8::timestamptz
            end
        where run_id = $1 and action_id = $2 and state = $3
      `,
      [
        run.id,
        action.actionId,
        action.state,
        state,
        broadcastMayHaveOccurred,
        input.report.transactionReference,
        reportSnapshot,
        now,
      ],
    );
    const updatedActions = await loadActions(client, run.id, true);
    const status = runStatusForActions(updatedActions);
    const resolvedAt =
      status === "failed" &&
      updatedActions.some(
        (attempt) =>
          attempt.state === "failed" && attempt.broadcastMayHaveOccurred,
      )
        ? now
        : null;
    const updatedRun = await client.query<RunRow>(
      `
        update funding_preparation_runs
        set status = $2, resolved_at = $3, request_snapshot = $4::jsonb
        where id = $1
        returning ${RUN_COLUMNS}
      `,
      [
        run.id,
        status,
        resolvedAt,
        grant && journal
          ? {
              ...run.request_snapshot,
              executionJournal: {
                ...journal,
                admissions: {
                  ...journal.admissions,
                  [action.actionId]: {
                    ...grant,
                    phase: negative ? "not_started" : "reported",
                  },
                },
              },
            }
          : run.request_snapshot,
      ],
    );
    return mapRun(client, updatedRun.rows[0] ?? run, false, true);
  });
}

export async function resolveFundingPreparationRun(
  pool: Pool,
  input: Readonly<{
    userId: string;
    runId: string;
    now?: Date;
  }> &
    (
      | Readonly<{
          succeeded: boolean;
          expectedActions?: readonly FundingPreparationActionAttempt[];
          approvalOutcomes?: never;
          signaturePostcondition?: never;
        }>
      | Readonly<{
          approvalOutcomes: readonly PreparationApprovalOutcome[];
          expectedActions: readonly FundingPreparationActionAttempt[];
          succeeded?: never;
          signaturePostcondition?: never;
        }>
      | Readonly<{
          signaturePostcondition: Readonly<{ inspectionRevision: string }>;
          expectedActions: readonly FundingPreparationActionAttempt[];
          succeeded?: never;
          approvalOutcomes?: never;
        }>
    ),
): Promise<FundingPreparationRun> {
  return tx(pool, async (client) => {
    const result = await client.query<RunRow>(
      `
        select ${RUN_COLUMNS}
        from funding_preparation_runs
        where id = $1 and user_id = $2
        for update
      `,
      [input.runId, input.userId],
    );
    const run = result.rows[0];
    if (!run) {
      throw new FundingPersistenceError(
        "operation_not_found",
        "funding preparation run was not found",
      );
    }
    if (
      !input.succeeded &&
      !input.approvalOutcomes &&
      !input.signaturePostcondition
    )
      return mapRun(client, run, false, true);
    if (run.resolved_at != null) return mapRun(client, run, false, true);
    if (input.expectedActions) {
      if (run.status !== "submitted" && run.status !== "ambiguous") {
        return mapRun(client, run, false, true);
      }
      const currentActions = await client.query<ActionRow>(
        `select ${ACTION_COLUMNS} from funding_preparation_action_attempts
          where run_id = $1 order by ordinal for update`,
        [run.id],
      );
      const evidenceIdentity = (action: FundingPreparationActionAttempt) => ({
        actionId: action.actionId,
        ordinal: action.ordinal,
        actionFingerprint: action.actionFingerprint,
        action: action.action,
        state: action.state,
        broadcastMayHaveOccurred: action.broadcastMayHaveOccurred,
        transactionReference: action.transactionReference,
      });
      if (
        !canonicalJsonEqual(
          currentActions.rows.map(mapAction).map(evidenceIdentity),
          input.expectedActions.map(evidenceIdentity),
        )
      ) {
        return mapRun(client, run, false, true);
      }
    }
    const now = input.now ?? new Date();
    if (input.approvalOutcomes || input.signaturePostcondition) {
      let updated = false;
      for (const outcome of input.approvalOutcomes ?? []) {
        if (outcome.status !== "succeeded" && outcome.status !== "failed")
          continue;
        const attempt = input.expectedActions.find(
          (candidate) => candidate.actionId === outcome.actionId,
        );
        if (
          !attempt ||
          !attempt.broadcastMayHaveOccurred ||
          !["submitted", "ambiguous"].includes(attempt.state) ||
          !attempt.transactionReference ||
          outcome.evidence.transactionReference !==
            attempt.transactionReference ||
          outcome.evidence.canonical !== true ||
          outcome.evidence.actionMatch !== true ||
          (outcome.status === "failed" &&
            outcome.evidence.failureFinalized !== true)
        ) {
          throw new FundingPersistenceError(
            "invalid_state_transition",
            "approval receipt does not match the submitted attempt",
          );
        }
        await client.query(
          `update funding_preparation_action_attempts
           set state = $3, resolved_at = $4, receipt_evidence = $5::jsonb
           where run_id = $1 and action_id = $2`,
          [run.id, outcome.actionId, outcome.status, now, outcome.evidence],
        );
        updated = true;
      }
      if (input.signaturePostcondition) {
        for (const attempt of input.expectedActions) {
          if (
            attempt.action.kind !== "signature" ||
            !attempt.broadcastMayHaveOccurred ||
            !["submitted", "ambiguous"].includes(attempt.state)
          )
            continue;
          await client.query(
            `update funding_preparation_action_attempts set state='succeeded',resolved_at=$3,receipt_evidence=$4::jsonb where run_id=$1 and action_id=$2`,
            [
              run.id,
              attempt.actionId,
              now,
              {
                kind: "signature_postcondition",
                inspectionRevision:
                  input.signaturePostcondition.inspectionRevision,
                checkedAt: now.toISOString(),
              },
            ],
          );
          updated = true;
        }
      }
      if (!updated) return mapRun(client, run, false, true);
      const actions = await loadActions(client, run.id, true);
      const status = runStatusForActions(actions);
      const result = await client.query<RunRow>(
        `update funding_preparation_runs
         set status = $2, resolved_at = $3
         where id = $1 returning ${RUN_COLUMNS}`,
        [
          run.id,
          status,
          status === "succeeded" || status === "failed" ? now : null,
        ],
      );
      return mapRun(client, result.rows[0] ?? run, false, true);
    }
    await client.query(
      `
        update funding_preparation_action_attempts
        set state = 'succeeded',
            resolved_at = $2
        where run_id = $1
          and state in ('action_required', 'submitted', 'ambiguous')
      `,
      [run.id, now],
    );
    const updated = await client.query<RunRow>(
      `
        update funding_preparation_runs
        set status = 'succeeded', resolved_at = $2
        where id = $1
        returning ${RUN_COLUMNS}
      `,
      [run.id, now],
    );
    return mapRun(client, updated.rows[0] ?? run, false, true);
  });
}
