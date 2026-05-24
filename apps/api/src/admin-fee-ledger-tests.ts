#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { DbQuery } from "./db.js";
import {
  getAdminFeeLedgerBuilderSweep,
  getAdminFeeLedgerTreasuryRun,
  listAdminFeeLedgerBuilderSweeps,
  listAdminFeeLedgerTreasuryRuns,
} from "./services/admin-fee-ledger.js";

type QueryCall = { sql: string; params?: unknown[] };

function createLedgerDb(inputs: {
  treasuryRows?: Array<Record<string, unknown>>;
  builderSweepRows?: Array<Record<string, unknown>>;
}): DbQuery & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query = async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> => {
    calls.push({ sql, params });
    if (/from reward_treasury_runs/i.test(sql)) {
      if (/count\(\*\)/i.test(sql)) {
        return {
          rows: [
            { total: String(inputs.treasuryRows?.length ?? 0) } as unknown as T,
          ],
        };
      }
      return { rows: (inputs.treasuryRows ?? []) as T[] };
    }
    if (/from polymarket_builder_sweeps/i.test(sql)) {
      if (/count\(\*\)/i.test(sql)) {
        return {
          rows: [
            {
              total: String(inputs.builderSweepRows?.length ?? 0),
            } as unknown as T,
          ],
        };
      }
      return { rows: (inputs.builderSweepRows ?? []) as T[] };
    }
    throw new Error(`Unexpected admin fee ledger query: ${sql}`);
  };

  return { query: query as DbQuery["query"], calls };
}

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`[admin-fee-ledger-tests] ok ${name}`);
}

await test("lists treasury runs with filters and maps nested report fields", async () => {
  const now = new Date("2026-05-24T12:00:00.000Z");
  const db = createLedgerDb({
    treasuryRows: [
      {
        id: "run-1",
        mode: "execute",
        chain_id: "137",
        status: "completed",
        liability_mode: "event_time_frozen",
        report: {
          report: { liabilityMode: "event_time_frozen", minSweepUsd: "1" },
          actions: [{ chainId: "137", txHash: "0xtreasury" }],
          polymarketBuilderSweep: {
            txHash: "0xbuilder",
            relayerTransactionId: "relayer-1",
          },
        },
        error: null,
        started_at: now,
        finished_at: now,
        created_at: now,
        updated_at: now,
      },
    ],
  });

  const result = await listAdminFeeLedgerTreasuryRuns(db, {
    status: "completed",
    chainId: "137",
    txHash: "0xtreasury",
    from: "2026-05-24T00:00:00Z",
    to: "2026-05-25T00:00:00Z",
    limit: 5,
    offset: 2,
  });

  assert.equal(result.total, 1);
  assert.equal(result.limit, 5);
  assert.equal(result.offset, 2);
  assert.deepEqual(result.items[0]?.actions, [
    { chainId: "137", txHash: "0xtreasury" },
  ]);
  assert.deepEqual(result.items[0]?.report, {
    liabilityMode: "event_time_frozen",
    minSweepUsd: "1",
  });
  assert.deepEqual(result.items[0]?.polymarketBuilderSweep, {
    txHash: "0xbuilder",
    relayerTransactionId: "relayer-1",
  });
  assert.deepEqual(db.calls[0]?.params, [
    "completed",
    "137",
    "0xtreasury",
    "2026-05-24T00:00:00Z",
    "2026-05-25T00:00:00Z",
  ]);
  assert.deepEqual(db.calls[1]?.params?.slice(-2), [5, 2]);
});

await test("lists builder sweeps with filters and maps raw balances", async () => {
  const now = new Date("2026-05-24T12:00:00.000Z");
  const db = createLedgerDb({
    builderSweepRows: [
      {
        id: "sweep-1",
        builder_address: "0xBuilder",
        owner_address: "0xOwner",
        destination_address: "0xHot",
        token_address: "0xpUSD",
        token_symbol: "pUSD",
        amount_raw: "123456",
        amount: "0.123456",
        pre_builder_balance_raw: "1000000",
        post_builder_balance_raw: "876544",
        pre_hot_balance_raw: "250000",
        post_hot_balance_raw: "373456",
        relayer_transaction_id: "relayer-1",
        tx_hash: "0xsweep",
        state: "confirmed",
        relayer_state: "executed",
        error: null,
        submitted_at: now,
        broadcast_at: now,
        confirmed_at: now,
        failed_at: null,
        created_at: now,
        updated_at: now,
      },
    ],
  });

  const result = await listAdminFeeLedgerBuilderSweeps(db, {
    status: "confirmed",
    chainId: "polygon",
    txHash: "0xsweep",
    builderAddress: "0xBuilder",
    destinationAddress: "0xHot",
    relayerTransactionId: "relayer-1",
    from: "2026-05-24T00:00:00Z",
    to: "2026-05-25T00:00:00Z",
    limit: 10,
    offset: 3,
  });

  assert.equal(result.total, 1);
  assert.equal(result.items[0]?.amount, "0.123456");
  assert.equal(result.items[0]?.preBuilderBalance, "1");
  assert.equal(result.items[0]?.postBuilderBalance, "0.876544");
  assert.equal(result.items[0]?.preHotBalance, "0.25");
  assert.equal(result.items[0]?.postHotBalance, "0.373456");
  assert.deepEqual(db.calls[0]?.params, [
    "confirmed",
    "polygon",
    "0xsweep",
    "0xBuilder",
    "0xHot",
    "relayer-1",
    "2026-05-24T00:00:00Z",
    "2026-05-25T00:00:00Z",
  ]);
  assert.deepEqual(db.calls[1]?.params?.slice(-2), [10, 3]);
});

await test("detail helpers return null for unknown rows", async () => {
  const db = createLedgerDb({});

  assert.equal(await getAdminFeeLedgerTreasuryRun(db, "missing-run"), null);
  assert.equal(await getAdminFeeLedgerBuilderSweep(db, "missing-sweep"), null);
  assert.deepEqual(db.calls[0]?.params, ["missing-run"]);
  assert.deepEqual(db.calls[2]?.params, ["missing-sweep"]);
});
