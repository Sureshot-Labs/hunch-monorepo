import { z } from "zod";
import {
  hip4SpotMetadataSchema,
  hip4BackgroundRequestWeightLimit,
  hip4BackgroundRepairWeightLimit,
  type Hip4ReadPolicy,
} from "@hunch/shared";
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
import {
  admitHip4Request,
  readHip4Policy,
  readHip4Markets,
} from "./hip4-repository.js";
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
  planHip4LedgerRepair,
  advanceHip4LedgerRepair,
} from "./hip4-account-history.js";
import {
  hip4FillRepairSchema,
  hip4LedgerRepairSchema,
  hip4PositionAccountingSchema,
} from "../schemas/hip4-account.js";
import { projectHip4OpenOrders } from "./hip4-open-orders.js";
import { projectHip4PerpsCash } from "./hip4-perps-cash.js";

const boundedRows = z.array(z.record(z.string(), z.unknown())).max(2000);
// Match transport admission: role + mode + spot metadata + spot/perps states
// + mode recheck, followed by open orders and one bounded fill response.
const STANDARD_CASH_AND_ONE_FILL_WEIGHT = 60 + 20 + 20 + 2 + 2 + 20 + 20 + 120;
const errorCode = (error: unknown) =>
  error instanceof Hip4ReadError
    ? error.reason
    : error instanceof Error &&
        [
          "unsupported_account_role",
          "account_owner_unavailable",
          "account_read_disabled",
          "account_history_binding_changed",
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
  requireCurrentOwner?: boolean;
  background?: boolean;
}) {
  const { pool, policy, address, now, lease, accountPolicy } = input;
  let historyOnly = false;
  const admit = async (weight: number, background = false) => {
    if (input.requireCurrentOwner || historyOnly) {
      const owned = await pool.query(
        `select 1 from user_wallets wallet_row
        join users owner_row on owner_row.id=wallet_row.user_id and owner_row.is_active
        where wallet_row.is_verified and wallet_row.wallet_type='ethereum'
          and wallet_row.wallet_address_norm=$1 limit 1`,
        [address],
      );
      if (!owned.rowCount) throw new Error("account_owner_unavailable");
    }
    const [read, account] = await Promise.all([
      readHip4Policy(pool, "accountRead"),
      readHip4AccountPolicy(pool),
    ]);
    if (
      !read.policy.enabled ||
      !account.policy.enabled ||
      read.policy.environment !== policy.environment
    )
      throw new Error("account_read_disabled");
    return admitHip4Request(
      pool,
      policy.environment,
      weight,
      read.policy.requestWeightPerMinute,
      background || input.background
        ? {
            scope: "background_repair",
            maximum: hip4BackgroundRepairWeightLimit(read.policy),
            backgroundMaximum: hip4BackgroundRequestWeightLimit(read.policy),
          }
        : undefined,
    );
  };
  const accountRead = createHip4AccountClient(policy, admit, input.fetcher);
  const publicRead = createHip4ReadClient(policy, admit, input.fetcher);
  // Optional history work cannot consume the interactive reserve merely
  // because an explicit balance refresh initiated it. Deferred history keeps
  // its old facts/cursors; independently valid fresh cash is still persisted.
  const historyRead = createHip4AccountClient(
    policy,
    (weight) => admit(weight, true),
    input.fetcher,
  );
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
  // A Standard cash observation plus open orders, one fill, and one enabled
  // ledger page must fit; otherwise ledger repair would always be last/denied.
  // Split phases only where that work cannot fit: larger existing budgets
  // keep their ordinary cash-refresh cadence and combined history pass.
  const splitBackgroundReads = Boolean(
    input.background &&
    hip4BackgroundRepairWeightLimit(policy) <
      STANDARD_CASH_AND_ONE_FILL_WEIGHT +
        (accountPolicy.ledgerRepairPagesPerRefresh > 0 ? 20 : 0),
  );
  historyOnly = Boolean(
    splitBackgroundReads &&
    previous?.observation &&
    previous.history.nextBackgroundRead === "history",
  );
  if (splitBackgroundReads)
    history.nextBackgroundRead = historyOnly ? "cash" : "history";
  let historyIdentityVerified = false;
  try {
    const role = hip4AccountRoleSchema.parse(
      await accountRead({ type: "userRole", user: address }),
    );
    if (role.role !== "user" && role.role !== "missing")
      throw new Error("unsupported_account_role");
    const mode = hip4AccountAbstractionSchema.parse(
      await accountRead({ type: "userAbstraction", user: address }),
    );
    if (historyOnly) {
      // Fresh role/mode and ownership checks authorize only exact-address
      // historical reads. Old cash is identity context, never a fresh balance.
      if (
        !previous?.observation ||
        role.role !== previous.observation.role ||
        mode !== previous.observation.mode
      )
        throw new Error("account_history_binding_changed");
      historyIdentityVerified = true;
    } else {
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
      // Independent cash class: a failed perps read must not discard valid HIP
      // spot facts, nor reuse an old refund as current spendable money.
      try {
        const state =
          mode === "disabled" && role.role === "user"
            ? await accountRead({
                type: "clearinghouseState",
                user: address,
                dex: "",
              })
            : null;
        if (
          state !== null &&
          (await accountRead({ type: "userAbstraction", user: address })) !==
            mode
        )
          throw new Error("native_cash_mode_changed");
        observation.perpsCash = projectHip4PerpsCash({
          state,
          mode,
          role: role.role,
          observedAt: new Date(now).toISOString(),
          now: Date.now(),
        });
      } catch {
        observation.perpsCash = {
          observedAt: new Date(now).toISOString(),
          state: "unavailable",
          totalRaw: null,
          availableRaw: null,
          reason: "read_failed",
        };
      }
    }
  } catch (error) {
    errors.push(errorCode(error));
  }
  // Account binding/role is checked before history. A failed fresh account read
  // does not allow following agent/master relationships or fabricating zeros.
  if (observation || historyIdentityVerified) {
    try {
      history.openOrders = projectHip4OpenOrders(
        policy.environment,
        await historyRead({ type: "frontendOpenOrders", user: address }),
        Date.now(),
      );
      history.openOrdersError = null;
    } catch (error) {
      // Preserve the last successful list/time. Failure is not an empty list.
      history.openOrdersError = errorCode(error);
      errors.push(`open_orders_${errorCode(error)}`);
    }
    const startTime = Math.max(0, now - accountPolicy.historyLookbackMs);
    history.lookbackStart = new Date(startTime).toISOString();
    const refreshRecentFills = async () => {
      try {
        const rows = boundedRows.parse(
          await historyRead({
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
    };
    const refreshLedger = async () => {
      if (accountPolicy.ledgerRepairPagesPerRefresh <= 0) return;
      let repair = planHip4LedgerRepair(
        previous?.history.ledgerRepair,
        accountPolicy.historyLookbackMs,
        now,
        accountPolicy.historyRepairMaxGapDetails,
      );
      try {
        for (
          let page = 0;
          page < accountPolicy.ledgerRepairPagesPerRefresh &&
          repair.nextTime != null;
          page++
        ) {
          const ledgerStartTime = repair.nextTime;
          if (ledgerStartTime == null) break;
          repair = { ...repair, lastAttemptAt: new Date(now).toISOString() };
          const rows = boundedRows.parse(
            await historyRead({
              type: "userNonFundingLedgerUpdates",
              user: address,
              startTime: ledgerStartTime,
              endTime: repair.endTime,
            }),
          );
          const parsed = rows.map(
            (row) => parseHip4LedgerObservation(row).entry,
          );
          const next = advanceHip4LedgerRepair(
            repair,
            rows,
            new Date(now).toISOString(),
            accountPolicy.historyRepairMaxGapDetails,
          );
          ledger.push(...parsed);
          repair = next;
          history.ledgerObservedAt = new Date(now).toISOString();
          history.ledgerProviderCapped = rows.length >= 500;
        }
      } catch (error) {
        const reason = errorCode(error);
        errors.push(`ledger_${reason}`);
        repair = { ...repair, lastError: reason };
      }
      history.ledgerRepair = repair;
    };
    const refreshFillRepair = async () => {
      if (accountPolicy.historyRepairPagesPerRefresh <= 0) return;
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
            await historyRead({
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
    };
    // The history-only background phase fits one 120-weight fill read after
    // its fresh binding checks. Rotate a derived scheduling hint even when
    // admission/IO/validation fails; an unhealthy source must not monopolize
    // every free budget window. This hint is never coverage or freshness proof:
    // only successful reads update observations and inclusive repair cursors.
    if (!splitBackgroundReads || historyOnly) {
      const repairFirst =
        accountPolicy.historyRepairPagesPerRefresh > 0 &&
        previous?.history.nextFillRead === "repair";
      history.nextFillRead =
        accountPolicy.historyRepairPagesPerRefresh > 0 && !repairFirst
          ? "repair"
          : "tail";
      if (repairFirst) await refreshFillRepair();
      else await refreshRecentFills();
      await refreshLedger();
      if (repairFirst) await refreshRecentFills();
      else await refreshFillRepair();
    } else {
      // Cash/open-orders/ledger and expensive fills cannot all fit in the
      // catalog-preserving class quota. Cash phases leave fill scheduling
      // untouched, so alternating phases cannot pin either fill source.
      await refreshLedger();
    }
  }
  try {
    const saved = await persistHip4AccountRefresh(pool, {
      environment: policy.environment,
      address,
      lease,
      observation,
      executions,
      executionSources,
      ledger,
      history,
      error: errors.length ? errors.join(",") : null,
      accountingMaxRows: accountPolicy.accountingMaxRows,
      preserveAttemptError: historyOnly,
    });
    return { saved, errors };
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
      ledgerRepair:
        hip4LedgerRepairSchema.safeParse(row?.history.ledgerRepair).data ??
        null,
      positionAccounting:
        hip4PositionAccountingSchema.safeParse(row?.history.positionAccounting)
          .data ?? null,
    },
  });
}

export function createHip4OwnedAccountService(
  pool: Pool,
  fetcher: typeof fetch = fetch,
) {
  return {
    // Metadata for an owned holding remains readable in exit-only mode. This
    // does not refresh the provider, grant discovery or authorize a sale.
    market: async (
      address: string,
      readPolicy: Hip4ReadPolicy,
      marketId: string,
    ) => {
      const snapshot = await readHip4AccountSnapshot(
        pool,
        readPolicy.environment,
        address,
      );
      if (
        !snapshot?.observation?.positions.some(
          (position: Hip4AccountObservation["positions"][number]) =>
            position.marketId === marketId,
        )
      )
        return null;
      const outcome = Number(marketId.split(":").at(-1));
      const rows = await readHip4Markets(
        pool,
        readPolicy.environment,
        [outcome],
        outcome - 1,
        1,
      );
      return rows.find((row) => row.marketId === marketId) ?? null;
    },
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
