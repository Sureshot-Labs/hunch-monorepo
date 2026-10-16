import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import {
  createHip4ReadClient,
  createHip4AccountClient,
} from "./services/hip4-client.js";
import { selectHip4Outcomes } from "./services/hip4-indexer.js";

test("public client admits weight before fetching and uses the explicit environment", async () => {
  const weights: number[] = [];
  const calls: string[] = [];
  const read = createHip4ReadClient(
    { ...DEFAULT_HIP4_READ_POLICY, environment: "testnet" },
    async (weight) => {
      weights.push(weight);
      return true;
    },
    async (url, options) => {
      calls.push(String(url));
      assert.equal(JSON.parse(String(options?.body)).type, "outcomeMeta");
      return new Response('{"outcomes":[]}');
    },
  );
  assert.deepEqual(await read({ type: "outcomeMeta" }), { outcomes: [] });
  assert.deepEqual(weights, [20]);
  assert.deepEqual(calls, ["https://api.hyperliquid-testnet.xyz/info"]);
  const denied = createHip4ReadClient(
    DEFAULT_HIP4_READ_POLICY,
    async () => false,
    async () => {
      throw new Error("must_not_fetch");
    },
  );
  await assert.rejects(denied({ type: "spotMeta" }), /budget_exhausted/);
  await assert.rejects(
    denied({ type: "l2Book", coin: "BTC" }),
    /invalid_hip4_coin/,
  );
});

test("account evidence rechecks its absolute deadline after shared admission and recovers next job", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  let admissions = 0;
  let transports = 0;
  const request = {
    type: "userNonFundingLedgerUpdates" as const,
    user: `0x${"a".repeat(40)}`,
    startTime: 0,
    endTime: 999,
  };
  const client = (deadlineMs: number) =>
    createHip4AccountClient(
      DEFAULT_HIP4_READ_POLICY,
      async () => {
        admissions++;
        now += 100;
        return true;
      },
      async () => {
        transports++;
        return Response.json([]);
      },
      { deadlineMs },
    );
  await assert.rejects(client(1100)(request), /budget_exhausted/);
  assert.equal(admissions, 1);
  assert.equal(transports, 0, "expired DB admission never starts a transport");
  await assert.rejects(client(1100)(request), /budget_exhausted/);
  assert.equal(
    admissions,
    1,
    "already expired work does not consume admission",
  );
  assert.deepEqual(await client(2000)(request), []);
  assert.equal(admissions, 2);
  assert.equal(
    transports,
    1,
    "ordinary next lease recovers without state clearing",
  );
});
test("errors, oversized and invalid payloads do not become an empty metadata generation", async () => {
  for (const response of [
    new Response("{}", { status: 429 }),
    new Response("not json"),
    new Response("x".repeat(1025)),
  ]) {
    const read = createHip4ReadClient(
      { ...DEFAULT_HIP4_READ_POLICY, responseMaxBytes: 1024 },
      async () => true,
      async () => response,
    );
    await assert.rejects(read({ type: "outcomeMeta" }));
  }
});
test("combined spot metadata and contexts costs one metadata request, independent of local processing limits", async () => {
  const weights: number[] = [];
  const read = createHip4ReadClient(
    DEFAULT_HIP4_READ_POLICY,
    async (weight) => {
      weights.push(weight);
      return true;
    },
    async (_url, options) => {
      assert.deepEqual(JSON.parse(String(options?.body)), {
        type: "spotMetaAndAssetCtxs",
      });
      return Response.json([
        { tokens: [] },
        [{ coin: "#87750", dayNtlVlm: "1" }],
      ]);
    },
  );
  assert.ok(Array.isArray(await read({ type: "spotMetaAndAssetCtxs" })));
  assert.deepEqual(weights, [20]);
});
test("bounded cursor rotation covers old/missing outcomes without starving later instances", () => {
  const policy = {
    ...DEFAULT_HIP4_READ_POLICY,
    outcomeAllowlist: [9, 2, 7, 2],
    maxOutcomesPerCycle: 2,
  };
  assert.deepEqual(selectHip4Outcomes(policy, -1), [2, 7]);
  assert.deepEqual(selectHip4Outcomes(policy, 7), [9, 2]);
  assert.deepEqual(selectHip4Outcomes(policy, 9), [2, 7]);
});
test("processing limit cannot reduce provider admission for a 1000-row response", async () => {
  const weights: number[] = [];
  const read = createHip4ReadClient(
    { ...DEFAULT_HIP4_READ_POLICY, maxTradesPerResponse: 1 },
    async (weight) => {
      weights.push(weight);
      return true;
    },
    async (_url, options) => {
      assert.deepEqual(JSON.parse(String(options?.body)), {
        type: "recentTrades",
        coin: "#87750",
      });
      return Response.json(Array(1000).fill({}));
    },
  );
  assert.equal(
    ((await read({ type: "recentTrades", coin: "#87750" })) as unknown[])
      .length,
    1000,
  );
  assert.equal(weights[0], 120);
});
