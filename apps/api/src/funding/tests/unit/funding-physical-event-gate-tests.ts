import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import {
  fundingPhysicalEventIsBusy,
  tryLockFundingPhysicalEvent,
  canonicalFundingPhysicalTransactionHash,
  FundingPhysicalEventBusyError,
} from "../../persistence/funding-physical-event-gate.js";
import { fundingReconciliationErrorIsNonTransient } from "../../reconciliation/funding-reducer.js";

test("only the shared try-gate SQLSTATE/constraint is an expected physical busy signal", () => {
  const busy = { code: "55P03", constraint: "funding_physical_event_busy" };
  assert.equal(fundingPhysicalEventIsBusy(busy), true);
  assert.equal(
    fundingPhysicalEventIsBusy(new FundingPhysicalEventBusyError()),
    true,
  );
  assert.equal(
    fundingPhysicalEventIsBusy(
      new AggregateError([busy, new AggregateError([busy])]),
    ),
    true,
    "the real receipt driver aggregates expected contention",
  );
  assert.equal(fundingReconciliationErrorIsNonTransient(busy), false);
  for (const other of [
    null,
    undefined,
    {},
    "busy",
    { code: "55P03" },
    { code: "23514", constraint: busy.constraint },
    { code: "55P03", constraint: "unrelated_lock" },
    new AggregateError([]),
    new AggregateError([busy, new Error("RPC unavailable")]),
    new AggregateError([busy, { code: "55P03" }]),
    new AggregateError([busy, new AggregateError([])]),
  ]) {
    assert.equal(fundingPhysicalEventIsBusy(other), false);
  }
});

test("only valid supported EVM hashes share the database alias namespace", () => {
  for (const networkId of ["evm:137", "evm:8453"])
    assert.equal(
      canonicalFundingPhysicalTransactionHash({
        networkId,
        transactionHash: "0X" + "AB".repeat(32),
      }),
      "0x" + "ab".repeat(32),
    );
  for (const networkId of ["hyperliquid:mainnet", "solana:mainnet", "evm:1"])
    assert.equal(
      canonicalFundingPhysicalTransactionHash({
        networkId,
        transactionHash: "0X" + "AB".repeat(32),
      }),
      null,
    );
  assert.equal(
    canonicalFundingPhysicalTransactionHash({
      networkId: "evm:8453",
      transactionHash: "synthetic-legacy-reference",
    }),
    null,
  );
});

test("explicit handoff gate preserves both EVM and native exact old key coverage", async () => {
  const queries: { sql: string; args: unknown[] }[] = [];
  const db = {
    query: async (sql: string, args: unknown[]) => {
      queries.push({ sql, args });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  for (const [networkId, eventIndex] of [
    ["evm:137", "7"],
    ["hyperliquid:mainnet", "hypercore:send:source_debit"],
  ]) {
    await tryLockFundingPhysicalEvent(db, {
      networkId,
      transactionHash: "0x" + "ab".repeat(32),
      eventIndex,
    });
    assert.deepEqual(queries.at(-1), {
      sql: "select funding_try_lock_physical_event($1,$2,$3)",
      args: [networkId, "0x" + "ab".repeat(32), eventIndex],
    });
  }
});
