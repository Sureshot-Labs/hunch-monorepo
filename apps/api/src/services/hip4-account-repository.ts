import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { fetchActiveRuntimePolicy } from "@hunch/db";
import type { Hip4Environment } from "@hunch/shared";
import { z } from "zod";
import { hip4AccountPolicySchema } from "./hip4-account-policy.js";
import {
  hip4AccountExecutionSchema,
  hip4AccountObservationSchema,
  type Hip4AccountExecution,
  type Hip4AccountObservation,
} from "../schemas/hip4-account.js";
import { readHip4PositionAccounting } from "./hip4-accounting-repository.js";
import { hip4BasisFillFingerprint } from "./hip4-position-accounting.js";
import { projectHip4Execution } from "./hip4-account-projection.js";
import { hip4FillPageSchema } from "./hip4-account-history.js";

/** Public API response bound applies BEFORE exact-scope filtering. A capped
 * page can prove included rows but never absent ones; no completeness claim. */
export function selectHip4ExactRecheckSources(
  body: unknown,
  scope: { coin: string; orderId: string; timeMs: number },
) {
  return hip4FillPageSchema
    .parse(body)
    .filter(
      (row) =>
        row.coin === scope.coin &&
        String(row.oid) === scope.orderId &&
        row.time === scope.timeMs,
    );
}

export type Hip4ProviderEvidenceStatus = {
  version: 1;
  revision: string;
  state: "conflicted" | "matched";
  reason:
    | "execution_identity_conflict"
    | "execution_accounting_conflict"
    | null;
  retainedFingerprint: string;
  retainedBasisFingerprint: string;
  observedFingerprint: string;
  observedBasisFingerprint: string;
};

/** NULL is legacy/unmarked, not proof of a fresh recheck. Unknown versions are
 * unavailable; callers must not reinterpret malformed state as an acquittal. */
export function readHip4ProviderEvidenceStatus(
  value: unknown,
): Hip4ProviderEvidenceStatus | null | undefined {
  if (value == null) return null;
  const parsed = hip4ProviderEvidenceStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function hip4LegacyExecutionConflictTime(
  history: unknown,
  coin: string,
): number | null {
  const time =
    history &&
    typeof history === "object" &&
    "accountingConflicts" in history &&
    history.accountingConflicts &&
    typeof history.accountingConflicts === "object"
      ? (history.accountingConflicts as Record<string, unknown>)[coin]
      : null;
  return typeof time === "number" && Number.isSafeInteger(time) && time >= 0
    ? time
    : null;
}

const hip4ProviderEvidenceStatusSchema = z
  .object({
    version: z.literal(1),
    revision: z.string().regex(/^[1-9]\d*$/u),
    state: z.enum(["conflicted", "matched"]),
    reason: z
      .enum(["execution_identity_conflict", "execution_accounting_conflict"])
      .nullable(),
    retainedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    retainedBasisFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    observedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    observedBasisFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .refine((value) => (value.state === "matched") === (value.reason === null));

function fingerprintJson(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** The source must be a real, valid provider fact projecting to this exact
 * retained identity. An absent source, partial page or transport failure can
 * never clear a known contradiction. Decimal spellings normalize upstream. */
function authoritativeBasisFingerprint(
  environment: Hip4Environment,
  address: string,
  source: unknown,
  executionFingerprint: string,
): string | null {
  if (source == null) return null;
  try {
    if (
      fingerprintJson(projectHip4Execution(environment, address, source)) !==
      executionFingerprint
    )
      return null;
    const basis = hip4BasisFillFingerprint(source);
    return basis == null ? null : fingerprintJson(basis);
  } catch {
    return null;
  }
}

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
      lease_token=excluded.lease_token,lease_until=excluded.lease_until
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
export const HIP4_ACCOUNT_REFRESH_LOCK_SQL = `select lease_token, history, observation from hip4_account_snapshots
  where environment=$1 and account_address=$2 and lease_token=$3 for update`;

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
    const locked = await db.query(HIP4_ACCOUNT_REFRESH_LOCK_SQL, [
      input.environment,
      input.address,
      input.lease,
    ]);
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
    // Conflicting variants in a single provider response are not a later
    // independent matching recheck, irrespective of their array order.
    const conflictedInRefresh = new Set<string>();
    for (const [index, entry] of input.executions.entries()) {
      const source = input.executionSources?.[index];
      const providerFingerprint =
        source == null
          ? null
          : createHash("sha256").update(canonicalJson(source)).digest("hex");
      const fingerprint = createHash("sha256")
        .update(canonicalJson(entry))
        .digest("hex");
      const result = await db.query<{
        fingerprint: string;
        provider_fill: unknown;
        provider_evidence_status: unknown;
      }>(
        `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,market_id,execution,fingerprint,provider_fill,provider_fingerprint)
        values($1,$2,$3,$4,$5,$6,$7,(select id from unified_markets where id=$7),$8::jsonb,$9,$10::jsonb,$11)
        on conflict(environment,account_address,time_ms,coin,tid,oid) do update set market_id=coalesce(hip4_account_executions.market_id,excluded.market_id),
          provider_fill=case when hip4_account_executions.fingerprint=excluded.fingerprint
            then coalesce(hip4_account_executions.provider_fill,excluded.provider_fill) else hip4_account_executions.provider_fill end,
          provider_fingerprint=case when hip4_account_executions.fingerprint=excluded.fingerprint
            then coalesce(hip4_account_executions.provider_fingerprint,excluded.provider_fingerprint) else hip4_account_executions.provider_fingerprint end
        returning fingerprint,provider_fill,provider_evidence_status`,
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
      const retained = result.rows[0];
      const identityConflict = retained.fingerprint !== fingerprint;
      const accountingConflict =
        source != null &&
        retained.provider_fill != null &&
        hip4BasisFillFingerprint(source) !==
          hip4BasisFillFingerprint(retained.provider_fill);
      if (identityConflict) {
        persistenceError = [persistenceError, "execution_identity_conflict"]
          .filter(Boolean)
          .join(",");
        accountingConflicts[entry.coin] = Math.max(
          accountingConflicts[entry.coin] ?? 0,
          entry.time,
        );
      } else if (accountingConflict) {
        persistenceError = [persistenceError, "execution_accounting_conflict"]
          .filter(Boolean)
          .join(",");
        accountingConflicts[entry.coin] = Math.max(
          accountingConflicts[entry.coin] ?? 0,
          entry.time,
        );
      }
      const freshBasis = authoritativeBasisFingerprint(
        input.environment,
        input.address,
        source,
        fingerprint,
      );
      const retainedBasis = authoritativeBasisFingerprint(
        input.environment,
        input.address,
        retained.provider_fill,
        retained.fingerprint,
      );
      const previousStatus = readHip4ProviderEvidenceStatus(
        retained.provider_evidence_status,
      );
      // A valid original and a valid fresh official fact are needed for a
      // positive contradiction. Invalid/legacy provenance remains unavailable.
      if (freshBasis != null && retainedBasis != null) {
        const conflicted = identityConflict || freshBasis !== retainedBasis;
        if (conflicted) conflictedInRefresh.add(entry.id);
        const canRestore = !conflictedInRefresh.has(entry.id) && !conflicted;
        if (
          conflicted ||
          (canRestore &&
            (previousStatus?.state === "conflicted" ||
              (previousStatus === null &&
                accountingConflicts[entry.coin] != null &&
                accountingConflicts[entry.coin] >= entry.time)))
        ) {
          const status: Hip4ProviderEvidenceStatus = {
            version: 1,
            revision: (BigInt(previousStatus?.revision ?? "0") + 1n).toString(),
            state: conflicted ? "conflicted" : "matched",
            reason: conflicted
              ? identityConflict
                ? "execution_identity_conflict"
                : "execution_accounting_conflict"
              : null,
            retainedFingerprint: retained.fingerprint,
            retainedBasisFingerprint: retainedBasis,
            observedFingerprint: fingerprint,
            observedBasisFingerprint: freshBasis,
          };
          const changed = await db.query(
            `update hip4_account_executions set provider_evidence_status=$7::jsonb
            where environment=$1 and account_address=$2 and time_ms=$3 and coin=$4 and tid=$5 and oid=$6
              and provider_evidence_status is not distinct from $8::jsonb returning tid`,
            [
              input.environment,
              input.address,
              entry.time,
              entry.coin,
              entry.tradeId,
              entry.orderId,
              JSON.stringify(status),
              retained.provider_evidence_status == null
                ? null
                : JSON.stringify(retained.provider_evidence_status),
            ],
          );
          if (changed.rows.length !== 1)
            throw new Error("execution_evidence_revision_conflict");
        }
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
    // A history-only pass may finish the range needed by the retained balance
    // snapshot. Derive against that exact locked snapshot, never a new clock or
    // a caller's pre-lease view, and do not promote its balance freshness.
    const accountingObservation =
      input.observation ??
      hip4AccountObservationSchema.safeParse(locked.rows[0].observation).data;
    if (accountingObservation && input.accountingMaxRows != null) {
      // A savepoint protects valid snapshot/fill facts if a derived read fails.
      await db.query("savepoint hip4_basis_derivation");
      try {
        history.positionAccounting = await readHip4PositionAccounting(db, {
          environment: input.environment,
          address: input.address,
          observation: accountingObservation,
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
