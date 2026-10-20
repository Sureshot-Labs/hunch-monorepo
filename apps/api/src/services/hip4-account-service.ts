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
  HIP4_LEDGER_REQUEST_WEIGHT,
  Hip4ReadError,
} from "./hip4-client.js";
import {
  reserveHip4Request,
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
import type { Hip4DefaultSpotCashEvidence } from "./hip4-spot-cash-mode.js";
import { proveHip4FillTailCoverage } from "./hip4-tail-history.js";
import {
  HIP4_ACCOUNT_CASH_REQUEST_WEIGHT,
  reserveHip4AccountCashBudget,
} from "./hip4-account-cash-budget.js";

const boundedRows = z.array(z.record(z.string(), z.unknown())).max(2000);
// Match transport admission: role + mode + spot metadata + spot/perps states
// + mode recheck, followed by open orders and one bounded fill response.
const STANDARD_CASH_AND_ONE_FILL_WEIGHT = 60 + 20 + 20 + 2 + 2 + 20 + 20 + 120;
const DEFAULT_SPOT_CASH_WEIGHT = 60 + 20 + 20 + 20 + 20 + 2 + 20 + 20;
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
  const recheckAdmissionPolicy = async () => {
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
    return read.policy;
  };
  const reserve = (
    weight: number,
    readPolicy: Hip4ReadPolicy,
    background = false,
  ) =>
    reserveHip4Request(
      pool,
      policy.environment,
      weight,
      readPolicy.requestWeightPerMinute,
      background || input.background
        ? {
            scope: "background_repair",
            maximum: hip4BackgroundRepairWeightLimit(readPolicy),
            backgroundMaximum: hip4BackgroundRequestWeightLimit(readPolicy),
          }
        : undefined,
    );
  const admit = async (weight: number, background = false) => {
    const readPolicy = await recheckAdmissionPolicy();
    return reserve(weight, readPolicy, background);
  };
  let cashBudget: Awaited<
    ReturnType<typeof reserveHip4AccountCashBudget>
  > | null = null;
  const admitCash = async (weight: number) => {
    return cashBudget ? cashBudget.admit(weight) : admit(weight);
  };
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
  let splitBackgroundReads = false;
  let historyIdentityVerified = false;
  const shouldSplit = (defaultSpot: boolean) =>
    Boolean(
      input.background &&
      hip4BackgroundRepairWeightLimit(policy) <
        (defaultSpot
          ? DEFAULT_SPOT_CASH_WEIGHT + 20 + 120
          : STANDARD_CASH_AND_ONE_FILL_WEIGHT) +
          (accountPolicy.ledgerRepairPagesPerRefresh > 0
            ? HIP4_LEDGER_REQUEST_WEIGHT
            : 0),
    );
  const retainedObservation = previous?.observation;
  // This is historical evidence for an already observed exact-address snapshot,
  // not a current balance/role/mode observation or permission to trade. Each IO
  // still rechecks current local ownership and policy in admit(). No agent or
  // master relationship is followed, and the query cannot pass the snapshot.
  historyOnly = Boolean(
    retainedObservation &&
    previous?.history.nextBackgroundRead === "history" &&
    shouldSplit(
      retainedObservation.mode === "default" &&
        retainedObservation.role === "user",
    ),
  );
  try {
    if (historyOnly) {
      splitBackgroundReads = true;
      history.nextBackgroundRead = "cash";
      historyIdentityVerified = true;
    } else {
      // Neither background work nor foreground UI polling may spend partial
      // prefixes forever. Keep the older per-request recovery path only for a
      // small interactive ceiling that fits Standard124 but not the unknown-
      // mode182 reservation. Optional history keeps its background quota.
      if (
        input.background ||
        policy.requestWeightPerMinute >= HIP4_ACCOUNT_CASH_REQUEST_WEIGHT
      )
        cashBudget = await reserveHip4AccountCashBudget({
          background: Boolean(input.background),
          recheck: recheckAdmissionPolicy,
          reserve,
        });
      const cashDeadline = cashBudget
        ? { deadlineMs: cashBudget.deadlineMs }
        : undefined;
      const accountRead = createHip4AccountClient(
        policy,
        admitCash,
        input.fetcher,
        cashDeadline,
      );
      const publicRead = createHip4ReadClient(
        policy,
        admitCash,
        input.fetcher,
        cashDeadline,
      );
      const role = hip4AccountRoleSchema.parse(
        await accountRead({ type: "userRole", user: address }),
      );
      if (role.role !== "user" && role.role !== "missing")
        throw new Error("unsupported_account_role");
      const mode = hip4AccountAbstractionSchema.parse(
        await accountRead({ type: "userAbstraction", user: address }),
      );
      const defaultSpot = mode === "default" && role.role === "user";
      splitBackgroundReads = shouldSplit(defaultSpot);
      if (splitBackgroundReads) history.nextBackgroundRead = "history";
      let defaultSpotCashEvidence: Hip4DefaultSpotCashEvidence | undefined;
      if (defaultSpot) {
        defaultSpotCashEvidence = {
          legacyDexAbstraction: await accountRead({
            type: "userDexAbstraction",
            user: address,
          }),
          borrowLendState: await accountRead({
            type: "borrowLendUserState",
            user: address,
          }),
        };
      }
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
      if (
        defaultSpotCashEvidence &&
        ((await accountRead({ type: "userAbstraction", user: address })) !==
          mode ||
          (await accountRead({ type: "userDexAbstraction", user: address })) !==
            defaultSpotCashEvidence.legacyDexAbstraction)
      )
        throw new Error("native_cash_mode_changed");
      observation = projectHip4Account({
        environment: policy.environment,
        observedAt: new Date(now).toISOString(),
        role: role.role,
        mode,
        state,
        defaultSpotCashEvidence,
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
  } finally {
    // All mandatory cash IO has settled. Optional history below remains on its
    // normal background quota and cannot consume this prepaid cash allowance.
    await cashBudget?.settle();
  }
  // Current reads require a fresh account binding. Historical reads use only
  // the retained exact snapshot and never follow agent/master relationships or
  // turn that past binding into current cash or execution authority.
  if (observation || historyIdentityVerified) {
    const refreshOpenOrders = async () => {
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
    };
    const historyThrough =
      historyOnly && retainedObservation
        ? Date.parse(retainedObservation.observedAt)
        : now;
    const startTime = Math.max(
      0,
      historyThrough - accountPolicy.historyLookbackMs,
    );
    history.lookbackStart = new Date(startTime).toISOString();
    const refreshRecentFills = async () => {
      try {
        const requestStartedAt = Date.now();
        const rows = boundedRows.parse(
          await historyRead({
            type: "userFills",
            user: address,
            aggregateByTime: false,
          }),
        );
        const receivedAt = Date.now();
        const tailCoverage = observation
          ? proveHip4FillTailCoverage({
              environment: policy.environment,
              address,
              request: {
                environment: policy.environment,
                address,
                startedAt: requestStartedAt,
              },
              snapshotTime: Date.parse(observation.observedAt),
              receivedAt,
              lookbackMs: accountPolicy.historyLookbackMs,
              previous: history.fillRepair ?? previous?.history.fillRepair,
              page: rows,
            })
          : null;
        // A bridge must retain every new economic fact after its old proven
        // end, even when that end predates the moving display lookback. Dropping
        // an intervening exit/re-entry could falsely preserve same-size basis.
        const captureFrom = tailCoverage
          ? Math.min(startTime, tailCoverage.baseCoveredThrough)
          : startTime;
        const selected = rows.filter(
          (row) => typeof row.coin === "string" && row.coin.startsWith("#"),
        );
        const projected = selected
          .map((row) => ({
            entry: projectHip4Execution(policy.environment, address, row),
            source: row,
          }))
          .filter((row) => row.entry.time >= captureFrom);
        if (projected.some((row) => row.entry.time > Date.now()))
          throw new Error("wrong_time_range");
        executions.push(...projected.map((row) => row.entry));
        executionSources.push(...projected.map((row) => row.source));
        history.executionsObservedAt = new Date(now).toISOString();
        history.fillsProviderCapped = rows.length >= 2000;
        if (tailCoverage) history.fillsTailCoverage = tailCoverage;
      } catch (error) {
        errors.push(`fills_${errorCode(error)}`);
      }
    };
    const refreshLedger = async () => {
      if (accountPolicy.ledgerRepairPagesPerRefresh <= 0) return;
      let repair = planHip4LedgerRepair(
        previous?.history.ledgerRepair,
        accountPolicy.historyLookbackMs,
        historyThrough,
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
          historyThrough,
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
    if (historyOnly) {
      // Only bounded historical sources belong in this phase. userFills and
      // frontendOpenOrders observe the present, not the retained snapshot.
      await refreshFillRepair();
      await refreshLedger();
    } else if (!splitBackgroundReads) {
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
    // Current display history is optional and cannot consume the headroom
    // needed to complete snapshot accounting. Strict financial capacity still
    // comes from fresh spot holds, never this list. A denial preserves its
    // previous timestamp/list; historical-only work never observes it.
    if (!historyOnly) await refreshOpenOrders();
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
        // This authenticated foreground read honors snapshot TTL, but
        // refresh=false is not background-service priority. Optional
        // history and the periodic worker retain their separate quotas.
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
