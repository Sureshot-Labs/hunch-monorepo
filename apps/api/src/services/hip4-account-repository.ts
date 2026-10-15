import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { fetchActiveRuntimePolicy } from "@hunch/db";
import type { Hip4Environment } from "@hunch/shared";
import { hip4AccountPolicySchema } from "./hip4-account-policy.js";
import {
  hip4AccountExecutionSchema,
  hip4AccountObservationSchema,
  type Hip4AccountExecution,
  type Hip4AccountObservation,
} from "../schemas/hip4-account.js";
import { readHip4PositionAccounting } from "./hip4-accounting-repository.js";
import { hip4BasisFillFingerprint } from "./hip4-position-accounting.js";

export async function readHip4AccountPolicy(db: Pick<Pool, "query">) {
  const row = await fetchActiveRuntimePolicy(db, "hip4_account");
  return {
    // Account access is gated by common venue_lifecycle in the service/routes.
    // Legacy enabled is accepted for stored-policy compatibility, not a second
    // product switch. Refresh/reconciliation limits remain provider-specific.
    policy: {
      ...hip4AccountPolicySchema.parse(row?.payload ?? {}),
      enabled: true,
    },
    revision: row ? `account-v2-db-${row.id}` : "account-v2-defaults",
  };
}
export async function readHip4AccountSnapshot(
  db: Pick<Pool, "query">,
  environment: Hip4Environment,
  address: string,
) {
  const result = await db.query(
    `select observation, observed_at, attempt_at, attempt_error, lease_until, history
    from hip4_account_snapshots where environment=$1 and account_address=$2`,
    [environment, address],
  );
  const row = result.rows[0];
  return row
    ? {
        ...row,
        observation: row.observation
          ? hip4AccountObservationSchema.parse(row.observation)
          : null,
      }
    : null;
}
export async function claimHip4AccountRefresh(
  db: Pick<Pool, "query">,
  environment: Hip4Environment,
  address: string,
  leaseMs: number,
  startedAt: Date,
  scope: "account" | "order_fills" = "account",
) {
  const token = randomUUID();
  const result = await db.query(
    `insert into hip4_account_snapshots(environment,account_address,attempt_at,lease_token,lease_until)
    values($1,$2,case when $6='order_fills' then null else $3::timestamptz end,$4,statement_timestamp()+$5*interval '1 millisecond')
    on conflict(environment,account_address) do update set attempt_at=case when $6='order_fills' then hip4_account_snapshots.attempt_at else excluded.attempt_at end,
      lease_token=excluded.lease_token,lease_until=excluded.lease_until,
      attempt_error=case when $6='order_fills' then hip4_account_snapshots.attempt_error else null end
    where hip4_account_snapshots.lease_until is null or hip4_account_snapshots.lease_until<statement_timestamp()
    returning lease_token`,
    [environment, address, startedAt, token, leaseMs, scope],
  );
  return result.rows.length ? token : null;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("invalid_observation_json");
  return serialized;
}
export async function persistHip4AccountRefresh(
  pool: Pool,
  input: {
    environment: Hip4Environment;
    address: string;
    lease: string;
    observation: Hip4AccountObservation | null;
    executions: Hip4AccountExecution[];
    executionSources?: readonly unknown[];
    ledger: { time: number; hash: string; delta: Record<string, unknown> }[];
    history: Record<string, unknown>;
    error: string | null;
    accountingMaxRows?: number;
    preserveAttemptError?: boolean;
  },
) {
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query("begin");
    let persistenceError = input.error;
    if (
      input.executionSources &&
      input.executionSources.length !== input.executions.length
    )
      throw new Error("execution_source_mismatch");
    const locked = await db.query(
      `select lease_token, history from hip4_account_snapshots
      where environment=$1 and account_address=$2 and lease_token=$3 for update`,
      [input.environment, input.address, input.lease],
    );
    if (!locked.rows.length) {
      await db.query("rollback");
      return false;
    }
    const accountingConflicts: Record<string, number> = {};
    const savedConflicts = locked.rows[0].history?.accountingConflicts;
    if (savedConflicts && typeof savedConflicts === "object")
      for (const [coin, time] of Object.entries(savedConflicts))
        if (
          /^#\d+$/.test(coin) &&
          typeof time === "number" &&
          Number.isSafeInteger(time) &&
          time >= 0
        )
          accountingConflicts[coin] = time;
    if (input.observation) {
      await db.query(
        "delete from hip4_account_positions where environment=$1 and account_address=$2",
        [input.environment, input.address],
      );
      for (const position of input.observation.positions) {
        await db.query(
          `insert into hip4_account_positions(environment,account_address,coin,canonical_market_id,market_id,"position")
          values($1,$2,$3,$4,(select id from unified_markets where id=$4),$5::jsonb)`,
          [
            input.environment,
            input.address,
            position.coin,
            position.marketId,
            JSON.stringify(position),
          ],
        );
      }
    }
    for (const [index, entry] of input.executions.entries()) {
      const source = input.executionSources?.[index];
      const providerFingerprint =
        source == null
          ? null
          : createHash("sha256").update(canonicalJson(source)).digest("hex");
      const fingerprint = createHash("sha256")
        .update(canonicalJson(entry))
        .digest("hex");
      const result = await db.query(
        `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,market_id,execution,fingerprint,provider_fill,provider_fingerprint)
        values($1,$2,$3,$4,$5,$6,$7,(select id from unified_markets where id=$7),$8::jsonb,$9,$10::jsonb,$11)
        on conflict(environment,account_address,time_ms,coin,tid,oid) do update set market_id=coalesce(hip4_account_executions.market_id,excluded.market_id),
          provider_fill=coalesce(hip4_account_executions.provider_fill,excluded.provider_fill),
          provider_fingerprint=coalesce(hip4_account_executions.provider_fingerprint,excluded.provider_fingerprint)
        where hip4_account_executions.fingerprint=excluded.fingerprint returning tid, provider_fill`,
        [
          input.environment,
          input.address,
          entry.time,
          entry.coin,
          entry.tradeId,
          entry.orderId,
          entry.marketId,
          JSON.stringify(entry),
          fingerprint,
          source == null ? null : JSON.stringify(source),
          providerFingerprint,
        ],
      );
      // Preserve the original fact and diagnose the conflict without dropping
      // an independently valid balance snapshot or other new executions.
      if (!result.rows.length) {
        persistenceError = [persistenceError, "execution_identity_conflict"]
          .filter(Boolean)
          .join(",");
        accountingConflicts[entry.coin] = Math.max(
          accountingConflicts[entry.coin] ?? 0,
          entry.time,
        );
      } else if (
        source != null &&
        result.rows[0].provider_fill != null &&
        hip4BasisFillFingerprint(source) !==
          hip4BasisFillFingerprint(result.rows[0].provider_fill)
      ) {
        persistenceError = [persistenceError, "execution_accounting_conflict"]
          .filter(Boolean)
          .join(",");
        accountingConflicts[entry.coin] = Math.max(
          accountingConflicts[entry.coin] ?? 0,
          entry.time,
        );
      }
    }
    for (const entry of input.ledger) {
      const eventKey = createHash("sha256")
        .update(canonicalJson(entry))
        .digest("hex");
      await db.query(
        `insert into hip4_account_ledger(environment,account_address,event_key,time_ms,ledger_entry)
        values($1,$2,$3,$4,$5::jsonb) on conflict do nothing`,
        [
          input.environment,
          input.address,
          eventKey,
          entry.time,
          JSON.stringify(entry),
        ],
      );
    }
    const history = { ...locked.rows[0].history, ...input.history };
    history.accountingConflicts = accountingConflicts;
    if (input.observation && input.accountingMaxRows != null) {
      // A savepoint protects valid snapshot/fill facts if a derived read fails.
      await db.query("savepoint hip4_basis_derivation");
      try {
        history.positionAccounting = await readHip4PositionAccounting(db, {
          environment: input.environment,
          address: input.address,
          observation: input.observation,
          history,
          maxRows: input.accountingMaxRows,
          conflicts: accountingConflicts,
        });
      } catch {
        await db.query("rollback to savepoint hip4_basis_derivation");
        history.positionAccounting = null;
        persistenceError = [persistenceError, "position_accounting_unavailable"]
          .filter(Boolean)
          .join(",");
      }
      await db.query("release savepoint hip4_basis_derivation");
    }
    await db.query(
      `update hip4_account_snapshots set
      observation=coalesce($4::jsonb,observation), observed_at=coalesce($5,observed_at),
      history=history||$6::jsonb, attempt_error=case when $8::boolean then attempt_error else $7 end,lease_token=null,lease_until=null
      where environment=$1 and account_address=$2 and lease_token=$3`,
      [
        input.environment,
        input.address,
        input.lease,
        input.observation ? JSON.stringify(input.observation) : null,
        input.observation?.observedAt ?? null,
        JSON.stringify(history),
        persistenceError,
        input.preserveAttemptError ?? false,
      ],
    );
    await db.query("commit");
    return true;
  } catch (error) {
    try {
      await db.query("rollback");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    db.release(discard);
  }
}
export async function failHip4AccountRefresh(
  db: Pick<Pool, "query">,
  environment: Hip4Environment,
  address: string,
  lease: string,
  error: string,
  preserveAttemptError = false,
) {
  await db.query(
    `update hip4_account_snapshots set attempt_error=case when $5::boolean then attempt_error else $4 end,lease_token=null,lease_until=null
    where environment=$1 and account_address=$2 and lease_token=$3`,
    [environment, address, lease, error, preserveAttemptError],
  );
}

export type Hip4ExecutionCursor = {
  time: number;
  coin: string;
  tid: string;
  oid: string;
};
export function parseHip4ExecutionCursor(
  cursor: string | undefined,
  environment: Hip4Environment,
  address: string,
  marketId?: string,
): Hip4ExecutionCursor | null {
  if (!cursor) return null;
  let value;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    throw new Error("invalid_cursor");
  }
  if (
    value.version !== 1 ||
    value.environment !== environment ||
    value.address !== address ||
    value.marketId !== (marketId ?? null) ||
    !Number.isSafeInteger(value.time) ||
    value.time < 0 ||
    typeof value.coin !== "string" ||
    !/^#\d+$/.test(value.coin) ||
    typeof value.tid !== "string" ||
    !/^\d{1,16}$/.test(value.tid) ||
    typeof value.oid !== "string" ||
    !/^\d{1,16}$/.test(value.oid)
  )
    throw new Error("invalid_cursor");
  return value;
}
export const HIP4_EXECUTION_PAGE_SQL = `select execution from hip4_account_executions
  where environment=$1 and account_address=$2
  and (time_ms,coin,tid,oid)<($3::bigint,$4::text,$5::bigint,$6::bigint)
  order by time_ms desc,coin desc,tid desc,oid desc limit $7`;
export const HIP4_EXECUTION_MARKET_PAGE_SQL = `select execution from hip4_account_executions
  where environment=$1 and account_address=$2 and canonical_market_id=$8
  and (time_ms,coin,tid,oid)<($3::bigint,$4::text,$5::bigint,$6::bigint)
  order by time_ms desc,coin desc,tid desc,oid desc limit $7`;
export async function readHip4AccountExecutions(
  db: Pick<Pool, "query">,
  environment: Hip4Environment,
  address: string,
  limit: number,
  cursor?: string,
  marketId?: string,
) {
  const after = parseHip4ExecutionCursor(
    cursor,
    environment,
    address,
    marketId,
  );
  const args = [
    environment,
    address,
    after?.time ?? Number.MAX_SAFE_INTEGER,
    after?.coin ?? "~",
    after?.tid ?? "9007199254740991",
    after?.oid ?? "9007199254740991",
    limit + 1,
  ];
  if (marketId) args.push(marketId);
  const result = await db.query(
    marketId ? HIP4_EXECUTION_MARKET_PAGE_SQL : HIP4_EXECUTION_PAGE_SQL,
    args,
  );
  const items = result.rows
    .slice(0, limit)
    .map((row) => hip4AccountExecutionSchema.parse(row.execution));
  const last = items.at(-1);
  return {
    environment,
    address,
    items,
    allTimeComplete: false as const,
    nextCursor:
      result.rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              environment,
              address,
              marketId: marketId ?? null,
              time: last.time,
              coin: last.coin,
              tid: last.tradeId,
              oid: last.orderId,
            }),
          ).toString("base64url")
        : null,
  };
}
