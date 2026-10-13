import { z } from "zod";
import { hip4SpotMetadataSchema, type Hip4ReadPolicy } from "@hunch/shared";
import type { Pool } from "pg";
import {
  hip4AccountAbstractionSchema,
  hip4AccountRoleSchema,
  parseHip4LedgerObservation,
} from "./hip4-account-contract.js";
import {
  createHip4AccountClient,
  createHip4ReadClient,
  Hip4ReadError,
} from "./hip4-client.js";
import { admitHip4Request, readHip4Policy } from "./hip4-repository.js";
import {
  claimHip4AccountRefresh,
  failHip4AccountRefresh,
  persistHip4AccountRefresh,
  readHip4AccountPolicy,
  readHip4AccountSnapshot,
} from "./hip4-account-repository.js";
import {
  projectHip4Account,
  projectHip4Execution,
} from "./hip4-account-projection.js";
import {
  hip4AccountResponseSchema,
  type Hip4AccountExecution,
  type Hip4AccountObservation,
} from "../schemas/hip4-account.js";
import type { Hip4AccountPolicy } from "./hip4-account-policy.js";
import {
  advanceHip4FillRepair,
  hip4FillPageSchema,
  planHip4FillRepair,
} from "./hip4-account-history.js";
import { hip4FillRepairSchema } from "../schemas/hip4-account.js";

const boundedRows = z.array(z.record(z.string(), z.unknown())).max(2000);
const errorCode = (error: unknown) =>
  error instanceof Hip4ReadError
    ? error.reason
    : error instanceof Error &&
        [
          "unsupported_account_role",
          "invalid_history_cursor",
          "invalid_history_page_order",
          "invalid_history_page_size",
        ].includes(error.message)
      ? error.message
      : "invalid_account_response";

export async function refreshHip4OwnedAccount(input: {
  pool: Pool;
  policy: Hip4ReadPolicy;
  accountPolicy: Hip4AccountPolicy;
  address: string;
  lease: string;
  now: number;
  fetcher?: typeof fetch;
}) {
  const { pool, policy, address, now, lease, accountPolicy } = input;
  const admit = async (weight: number) => {
    const [read, account] = await Promise.all([
      readHip4Policy(pool, "accountRead"),
      readHip4AccountPolicy(pool),
    ]);
    if (
      !read.policy.enabled ||
      !account.policy.enabled ||
      read.policy.environment !== policy.environment
    )
      return false;
    return admitHip4Request(
      pool,
      policy.environment,
      weight,
      read.policy.requestWeightPerMinute,
    );
  };
  const accountRead = createHip4AccountClient(policy, admit, input.fetcher);
  const publicRead = createHip4ReadClient(policy, admit, input.fetcher);
  let observation: Hip4AccountObservation | null = null;
  const executions: Hip4AccountExecution[] = [];
  const executionSources: unknown[] = [];
  const ledger: ReturnType<typeof parseHip4LedgerObservation>["entry"][] = [];
  const history: Record<string, unknown> = {};
  const errors: string[] = [];
  // Read after claiming the lease, not from the pre-claim freshness read. A
  // refresh completed between those steps may have advanced the durable cursor.
  const previous = await readHip4AccountSnapshot(
    pool,
    policy.environment,
    address,
  );
  try {
    const role = hip4AccountRoleSchema.parse(
      await accountRead({ type: "userRole", user: address }),
    );
    if (role.role !== "user" && role.role !== "missing")
      throw new Error("unsupported_account_role");
    const mode = hip4AccountAbstractionSchema.parse(
      await accountRead({ type: "userAbstraction", user: address }),
    );
    const metadata = hip4SpotMetadataSchema.parse(
      await publicRead({ type: "spotMeta" }),
    );
    const quote = metadata.tokens.find(
      (token) => token.name === "USDC" && token.index === 0,
    );
    if (!quote?.tokenId || quote.weiDecimals !== 8)
      throw new Error("unknown_quote_identity");
    const state = await accountRead({
      type: "spotClearinghouseState",
      user: address,
    });
    observation = projectHip4Account({
      environment: policy.environment,
      observedAt: new Date(now).toISOString(),
      role: role.role,
      mode,
      state,
      quote: {
        tokenId: quote.tokenId,
        index: quote.index,
        weiDecimals: quote.weiDecimals,
      },
    });
  } catch (error) {
    errors.push(errorCode(error));
  }
  // Account binding/role is checked before history. A failed fresh account read
  // does not allow following agent/master relationships or fabricating zeros.
  if (observation) {
    const startTime = Math.max(0, now - accountPolicy.historyLookbackMs);
    history.lookbackStart = new Date(startTime).toISOString();
    try {
      const rows = boundedRows.parse(
        await accountRead({
          type: "userFills",
          user: address,
          aggregateByTime: false,
        }),
      );
      const selected = rows.filter(
        (row) => typeof row.coin === "string" && row.coin.startsWith("#"),
      );
      const projected = selected
        .map((row) => ({
          entry: projectHip4Execution(policy.environment, address, row),
          source: row,
        }))
        .filter((row) => row.entry.time >= startTime);
      if (projected.some((row) => row.entry.time > Date.now()))
        throw new Error("wrong_time_range");
      executions.push(...projected.map((row) => row.entry));
      executionSources.push(...projected.map((row) => row.source));
      history.executionsObservedAt = new Date(now).toISOString();
      history.fillsProviderCapped = rows.length >= 2000;
    } catch (error) {
      errors.push(`fills_${errorCode(error)}`);
    }
    try {
      const rows = boundedRows.parse(
        await accountRead({
          type: "userNonFundingLedgerUpdates",
          user: address,
          startTime,
          endTime: now,
        }),
      );
      const parsed = rows.map((row) => parseHip4LedgerObservation(row).entry);
      if (parsed.some((row) => row.time < startTime || row.time > now))
        throw new Error("wrong_time_range");
      ledger.push(...parsed);
      history.ledgerObservedAt = new Date(now).toISOString();
      history.ledgerProviderCapped = rows.length >= 500;
    } catch (error) {
      errors.push(`ledger_${errorCode(error)}`);
    }
    if (accountPolicy.historyRepairPagesPerRefresh > 0) {
      let repair;
      try {
        repair = planHip4FillRepair(
          previous?.history.fillRepair,
          accountPolicy.historyLookbackMs,
          now,
          accountPolicy.historyRepairMaxGapDetails,
        );
        for (
          let page = 0;
          page < accountPolicy.historyRepairPagesPerRefresh &&
          repair.nextTime != null;
          page++
        ) {
          const startTime = repair.nextTime;
          repair = { ...repair, lastAttemptAt: new Date(now).toISOString() };
          const rows = hip4FillPageSchema.parse(
            await accountRead({
              type: "userFillsByTime",
              user: address,
              startTime,
              endTime: repair.endTime,
              aggregateByTime: false,
            }),
          );
          const projected = rows
            .filter(
              (row) => typeof row.coin === "string" && row.coin.startsWith("#"),
            )
            .map((row) => ({
              entry: projectHip4Execution(policy.environment, address, row),
              source: row,
            }));
          const next = advanceHip4FillRepair(
            repair,
            rows,
            new Date(now).toISOString(),
            accountPolicy.historyRepairMaxGapDetails,
          );
          executions.push(...projected.map((row) => row.entry));
          executionSources.push(...projected.map((row) => row.source));
          repair = next;
        }
      } catch (error) {
        const reason = errorCode(error);
        errors.push(`fill_repair_${reason}`);
        // Failed transport/admission/validation leaves the next range intact.
        // Valid earlier pages in this refresh are committed with their cursor.
        if (repair) repair = { ...repair, lastError: reason };
      }
      if (repair) history.fillRepair = repair;
    }
  }
  try {
    await persistHip4AccountRefresh(pool, {
      environment: policy.environment,
      address,
      lease,
      observation,
      executions,
      executionSources,
      ledger,
      history,
      error: errors.length ? errors.join(",") : null,
    });
  } catch {
    await failHip4AccountRefresh(
      pool,
      policy.environment,
      address,
      lease,
      "account_persistence_failed",
    );
    throw new Error("account_persistence_failed");
  }
}

export function hip4AccountReadResponse(input: {
  row: Awaited<ReturnType<typeof readHip4AccountSnapshot>>;
  policy: Hip4ReadPolicy;
  accountPolicy: Hip4AccountPolicy;
  revision: string;
  address: string;
  now: number;
}) {
  const { row, policy, accountPolicy, revision, address, now } = input;
  const observedAt = row?.observation?.observedAt;
  const validUntil = observedAt
    ? new Date(
        Date.parse(observedAt) + accountPolicy.snapshotMaxAgeMs,
      ).toISOString()
    : null;
  const refreshing =
    !!row?.lease_until && new Date(row.lease_until).getTime() > now;
  return hip4AccountResponseSchema.parse({
    version: 1,
    environment: policy.environment,
    address,
    policyRevision: revision,
    refreshAfterMs: Math.min(
      accountPolicy.snapshotMaxAgeMs,
      policy.policyCheckMs,
    ),
    observation: row?.observation ?? null,
    validUntil,
    state: !observedAt
      ? "unavailable"
      : validUntil && Date.parse(validUntil) > now
        ? "fresh"
        : "stale",
    refreshState: refreshing
      ? "refreshing"
      : row?.attempt_error
        ? "failed"
        : "idle",
    lastAttemptAt: row?.attempt_at
      ? new Date(row.attempt_at).toISOString()
      : null,
    error: row?.attempt_error ?? null,
    history: {
      allTimeComplete: false,
      interpretation: "native_records_cost_basis_unverified",
      executionsObservedAt: row?.history.executionsObservedAt ?? null,
      ledgerObservedAt: row?.history.ledgerObservedAt ?? null,
      lookbackStart: row?.history.lookbackStart ?? null,
      fillsProviderCapped: row?.history.fillsProviderCapped ?? false,
      ledgerProviderCapped: row?.history.ledgerProviderCapped ?? false,
      fillRepair:
        hip4FillRepairSchema.safeParse(row?.history.fillRepair).data ?? null,
    },
  });
}

export function createHip4OwnedAccountService(
  pool: Pool,
  fetcher: typeof fetch = fetch,
) {
  return {
    policy: async () => {
      const [read, account] = await Promise.all([
        readHip4Policy(pool, "accountRead"),
        readHip4AccountPolicy(pool),
      ]);
      return {
        readPolicy: read.policy,
        accountPolicy: account.policy,
        revision: `${read.revision}:${account.revision}`,
      };
    },
    load: async (
      address: string,
      readPolicy: Hip4ReadPolicy,
      accountPolicy: Hip4AccountPolicy,
      revision: string,
      refresh: boolean,
    ) => {
      const now = Date.now();
      const stored = await readHip4AccountSnapshot(
        pool,
        readPolicy.environment,
        address,
      );
      if (
        refresh ||
        !stored?.observation ||
        Date.parse(stored.observation.observedAt) +
          accountPolicy.snapshotMaxAgeMs <=
          now
      ) {
        const lease = await claimHip4AccountRefresh(
          pool,
          readPolicy.environment,
          address,
          accountPolicy.leaseMs,
          new Date(now),
        );
        if (lease)
          await refreshHip4OwnedAccount({
            pool,
            policy: readPolicy,
            accountPolicy,
            address,
            lease,
            now,
            fetcher,
          });
      }
      return hip4AccountReadResponse({
        row: await readHip4AccountSnapshot(
          pool,
          readPolicy.environment,
          address,
        ),
        policy: readPolicy,
        accountPolicy,
        revision,
        address,
        now: Date.now(),
      });
    },
  };
}
