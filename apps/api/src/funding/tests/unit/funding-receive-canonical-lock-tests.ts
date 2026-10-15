import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lockFundingReceiveCanonicalEvents,
  compareFundingReceiveCanonicalEvents,
  type FundingReceiveCanonicalEventInput,
} from "../../persistence/funding-receive-session-repository.js";

const event: FundingReceiveCanonicalEventInput = {
  networkId: "evm:8453",
  asset: {
    networkId: "evm:8453",
    assetId: `0x${"ab".repeat(20)}`,
    decimals: 6,
  },
  destinationAddress: `0x${"bc".repeat(20)}`,
  sourceAddress: `0x${"cd".repeat(20)}`,
  rawAmount: "4000000",
  transactionHash: `0x${"de".repeat(32)}`,
  eventIndex: "1",
  ledgerHeight: "123",
  blockHash: `0x${"ef".repeat(32)}`,
  observedAt: new Date("2026-10-14T00:00:00Z"),
  now: new Date("2026-10-14T00:00:01Z"),
};

function memoryDatabase() {
  const calls: string[] = [];
  const rows = new Map<string, object>();
  return {
    calls,
    rows,
    query: async (sql: string, args: unknown[]) => {
      assert.match(sql, /insert into funding_receive_canonical_events/);
      assert.match(sql, /on conflict \(network_id, tx_hash, event_index\)/);
      assert.match(sql, /case when \$12::text is null then 'pending'/);
      assert.equal(args[11], null, "prelock is not quarantine or allocation");
      const key = `${args[0]}:${args[6]}:${args[7]}`;
      calls.push(key);
      if (!rows.has(key))
        rows.set(key, {
          id: key,
          network_id: args[0],
          asset_id: args[1],
          asset_decimals: args[2],
          destination_address: args[3],
          source_address: args[4],
          raw_amount: args[5],
          tx_hash: args[6],
          event_index: args[7],
          ledger_height: args[8],
          block_hash: args[9],
          observed_at: args[10],
          allocation_status: "pending",
          allocated_receive_session_id: null,
          allocated_receipt_id: null,
          allocation_error_code: null,
        });
      return { rows: [rows.get(key)] };
    },
  };
}

test("receive prelocks every physical key in common order regardless of scan order", async () => {
  const second = { ...event, transactionHash: `0x${"ab".repeat(32)}` };
  const third = { ...event, eventIndex: "2" };
  const expected = [event, second, third]
    .sort(compareFundingReceiveCanonicalEvents)
    .map(
      (entry) =>
        `${entry.networkId}:${entry.transactionHash}:${entry.eventIndex}`,
    );
  for (const input of [
    [event, second, third],
    [third, second, event],
  ]) {
    const originalOrder = [...input];
    const db = memoryDatabase();
    await lockFundingReceiveCanonicalEvents(db as never, input);
    assert.deepEqual(db.calls, expected);
    assert.deepEqual(
      input,
      originalOrder,
      "caller-owned scanner order is unchanged",
    );
  }
  const empty = memoryDatabase();
  await lockFundingReceiveCanonicalEvents(empty as never, []);
  assert.equal(empty.calls.length, 0);
});

test("receive prelock checks repeated physical identities instead of dropping conflicts", async () => {
  const db = memoryDatabase();
  await lockFundingReceiveCanonicalEvents(db as never, [event, event]);
  assert.equal(db.rows.size, 1);
  assert.equal(db.calls.length, 2);
  for (const patch of [
    { rawAmount: "1" },
    { blockHash: `0x${"a".repeat(64)}` },
    { ledgerHeight: "124" },
    { destinationAddress: `0x${"ad".repeat(20)}` },
    { asset: { ...event.asset, decimals: 8 } },
  ]) {
    await assert.rejects(
      lockFundingReceiveCanonicalEvents(db as never, [{ ...event, ...patch }]),
      /identity collision/,
    );
  }
});

test("the shared order is total even for raw EVM casing aliases and Solana identities", () => {
  assert.notEqual(
    compareFundingReceiveCanonicalEvents(event, {
      ...event,
      transactionHash: event.transactionHash.toUpperCase(),
    }),
    0,
  );
  const upper = {
    ...event,
    transactionHash: event.transactionHash.toUpperCase(),
  };
  assert.deepEqual(
    [event, upper].sort(compareFundingReceiveCanonicalEvents),
    [upper, event].sort(compareFundingReceiveCanonicalEvents),
  );
  assert.notEqual(
    compareFundingReceiveCanonicalEvents(
      { ...event, networkId: "solana:mainnet", transactionHash: "AbCd" },
      { ...event, networkId: "solana:mainnet", transactionHash: "abcd" },
    ),
    0,
  );
});
