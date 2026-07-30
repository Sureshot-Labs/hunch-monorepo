import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type {
  JsonValue,
  NormalizedAction,
  PreparationPurpose,
} from "../domain/types.js";
import { canonicalJsonEqual, canonicalJsonHash } from "./canonical.js";
import { FundingPersistenceError } from "./funding-operation-repository.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type FundingPreparationRunRequest = Readonly<{
  venueBindingOptionId: string;
  purpose: PreparationPurpose;
  marketContextId: string | null;
  marketClass: string | null;
  positionActionRef: string | null;
  controllerWalletRef: string | null;
  expectedInspectionRevision: string;
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
    ...request,
  })}`;
}

export async function createOrReplayFundingPreparationRun(
  pool: Pool,
  input: Readonly<{
    userId: string;
    request: FundingPreparationRunRequest;
    expiresAt: Date;
    materialize: (runId: string) => Promise<
      Readonly<{
        actions: readonly NormalizedAction[];
        controllerWalletRef: string;
      }>
    >;
  }>,
): Promise<FundingPreparationRun> {
  const requestFingerprint = fundingPreparationRequestFingerprint(
    input.request,
  );
  return tx(pool, async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`funding-preparation:${input.userId}:${requestFingerprint}`],
    );
    const existing = await client.query<RunRow>(
      `
        select ${RUN_COLUMNS}
        from funding_preparation_runs
        where user_id = $1 and request_fingerprint = $2
        for update
      `,
      [input.userId, requestFingerprint],
    );
    if (existing.rows[0]) {
      const existingRun = await expireUnsubmittedRunIfNeeded(
        client,
        existing.rows[0],
      );
      return mapRun(client, existingRun, true, true);
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
        input.request,
        input.request.expectedInspectionRevision,
        input.request.controllerWalletRef,
        input.expiresAt,
      ],
    );
    const row = runResult.rows[0];
    if (!row) throw new Error("funding preparation run insert returned no row");
    const materialized = await input.materialize(row.id);
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
}>;

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
  if (actions.some((action) => action.state === "action_required")) {
    return "action_required";
  }
  if (actions.some((action) => action.state === "failed")) return "failed";
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
    const reportSnapshot = input.report as unknown as JsonRecord;
    if (action.report) {
      if (!canonicalJsonEqual(action.report, reportSnapshot)) {
        throw new FundingPersistenceError(
          "idempotency_conflict",
          "funding preparation action already has a different report",
        );
      }
      return mapRun(client, run, true, true);
    }
    if (action.state !== "action_required") {
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
        "action_required",
        state,
        broadcastMayHaveOccurred,
        input.report.transactionReference,
        reportSnapshot,
        now,
      ],
    );
    const updatedActions = await loadActions(client, run.id, true);
    const status = runStatusForActions(updatedActions);
    const updatedRun = await client.query<RunRow>(
      `
        update funding_preparation_runs
        set status = $2, resolved_at = null
        where id = $1
        returning ${RUN_COLUMNS}
      `,
      [run.id, status],
    );
    return mapRun(client, updatedRun.rows[0] ?? run, false, true);
  });
}

export async function resolveFundingPreparationRun(
  pool: Pool,
  input: Readonly<{
    userId: string;
    runId: string;
    succeeded: boolean;
    now?: Date;
  }>,
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
    if (!input.succeeded) return mapRun(client, run, false, true);
    const now = input.now ?? new Date();
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
