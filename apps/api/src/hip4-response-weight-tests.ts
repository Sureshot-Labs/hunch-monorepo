import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import {
  createHip4AccountClient,
  createHip4ReadClient,
  hip4SuccessfulResponseWeight,
} from "./services/hip4-client.js";

const request = {
  type: "userFillsByTime" as const,
  user: `0x${"ab".repeat(20)}`,
  startTime: 0,
  endTime: 100,
  aggregateByTime: false as const,
};
const fill = {
  coin: "#14731",
  px: "0.5",
  sz: "2",
  side: "B",
  time: 10,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "0",
  hash: `0x${"cd".repeat(32)}`,
  oid: 1,
  crossed: true,
  fee: "0.0001",
  tid: 1,
  feeToken: "USDC",
  cloid: null,
};
const trade = {
  coin: "#14731",
  px: "0.5",
  sz: "2",
  side: "B",
  time: 10,
  tid: 1,
  hash: "synthetic",
};

test("documented variable weights count every raw returned row, never a local processing cap", () => {
  for (const [count, expected] of [
    [0, 20],
    [1, 21],
    [2, 21],
    [20, 21],
    [21, 22],
    [1999, 120],
  ]) {
    assert.equal(
      hip4SuccessfulResponseWeight(request, Array(count).fill(fill)),
      expected,
    );
    assert.equal(
      hip4SuccessfulResponseWeight(
        { type: "recentTrades", coin: trade.coin },
        Array(count).fill(trade),
      ),
      expected,
    );
  }
  assert.equal(
    hip4SuccessfulResponseWeight(request, [
      { ...fill, coin: "BTC", px: "12345" },
      fill,
    ]),
    21,
    "mixed spot/perp/outcome rows all count",
  );
});

test("malformed, capped, wrong-scope and unknown responses retain the worst-case reservation", () => {
  for (const payload of [
    null,
    {},
    [null],
    [{}],
    [{ ...fill, px: "bad" }],
    [{ ...fill, coin: "#14731", px: "2" }],
    [{ ...fill, time: 101 }],
    Array(2000).fill(fill),
    Array(2001).fill(fill),
  ])
    assert.equal(hip4SuccessfulResponseWeight(request, payload), null);
  assert.equal(
    hip4SuccessfulResponseWeight(request, [{ ...fill, time: 11 }, fill]),
    null,
  );
  assert.equal(
    hip4SuccessfulResponseWeight({ type: "recentTrades", coin: trade.coin }, [
      { ...trade, coin: "#14730" },
    ]),
    null,
  );
  assert.equal(
    hip4SuccessfulResponseWeight(
      {
        type: "userNonFundingLedgerUpdates",
        user: request.user,
        startTime: 0,
        endTime: 100,
      },
      [],
    ),
    null,
  );
});

test("the client reserves 120 before IO, then settles only a completely valid successful response", async () => {
  const events: string[] = [];
  const read = createHip4AccountClient(
    DEFAULT_HIP4_READ_POLICY,
    async (weight) => {
      events.push(`reserve:${weight}`);
      return {
        reservedWeight: weight,
        settle: async (actual) => {
          events.push(`settle:${actual}`);
        },
      };
    },
    async () => {
      events.push("fetch");
      return Response.json([fill, fill]);
    },
  );
  assert.deepEqual(await read(request), [fill, fill]);
  assert.deepEqual(events, ["reserve:120", "fetch", "settle:21"]);
  const publicRead = createHip4ReadClient(
    { ...DEFAULT_HIP4_READ_POLICY, maxTradesPerResponse: 1 },
    async (weight) => ({
      reservedWeight: weight,
      settle: async (actual) => {
        events.push(`public:${actual}`);
      },
    }),
    async () => Response.json(Array(21).fill(trade)),
  );
  assert.equal(
    (
      (await publicRead({
        type: "recentTrades",
        coin: trade.coin,
      })) as unknown[]
    ).length,
    21,
  );
  assert.equal(events.at(-1), "public:22");
});

test("failed IO, invalid JSON, malformed arrays, and capped arrays never settle; settlement failure never hides valid evidence", async () => {
  for (const response of [
    () => Promise.reject(new Error("synthetic transport")),
    async () => new Response("[]", { status: 503 }),
    async () => new Response("not JSON"),
    async () => Response.json([{}]),
    async () => Response.json(Array(2000).fill(fill)),
  ]) {
    let settlements = 0;
    const read = createHip4AccountClient(
      DEFAULT_HIP4_READ_POLICY,
      async (weight) => ({
        reservedWeight: weight,
        settle: async () => {
          settlements++;
        },
      }),
      response,
    );
    await read(request).catch(() => undefined);
    assert.equal(settlements, 0);
  }
  const read = createHip4AccountClient(
    DEFAULT_HIP4_READ_POLICY,
    async (weight) => ({
      reservedWeight: weight,
      settle: async () => {
        throw new Error("synthetic budget row contention");
      },
    }),
    async () => Response.json([fill]),
  );
  assert.deepEqual(await read(request), [fill]);
});

test("expired transport budgets retain the reservation even if a test transport ignores abort", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  let settlements = 0;
  const read = createHip4AccountClient(
    DEFAULT_HIP4_READ_POLICY,
    async (weight) => ({
      reservedWeight: weight,
      settle: async () => {
        settlements++;
      },
    }),
    async () => {
      now = 2001;
      return Response.json([fill]);
    },
    { deadlineMs: 2000 },
  );
  assert.deepEqual(await read(request), [fill]);
  assert.equal(settlements, 0);
});

test("native ledger reads reserve a conservative45 and do not claim alias-specific settlement", async () => {
  const weights: number[] = [];
  let settlements = 0;
  const read = createHip4AccountClient(
    DEFAULT_HIP4_READ_POLICY,
    async (weight) => {
      weights.push(weight);
      return {
        reservedWeight: weight,
        settle: async () => {
          settlements++;
        },
      };
    },
    async () => Response.json([]),
  );
  assert.deepEqual(
    await read({
      type: "userNonFundingLedgerUpdates",
      user: request.user,
      startTime: 0,
      endTime: 100,
    }),
    [],
  );
  assert.deepEqual(weights, [45]);
  assert.equal(settlements, 0);
});
