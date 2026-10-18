import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_HIP4_READ_POLICY,
  hip4Identity,
  hip4ReadPolicySchema,
  type Hip4ReadMarket,
} from "@hunch/shared";
import { createHip4ReadClient, Hip4ReadError } from "./services/hip4-client.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import {
  hip4HotOutcomeIds,
  hip4VisibleBookLeadMs,
  readHip4HotMarkets,
  refreshHip4VisibleBooks,
  selectHip4VisibleBookMarkets,
  selectHip4VisibleLiveOutcomes,
} from "./services/hip4-visible-books.js";

const now = Date.parse("2026-10-18T12:00:00Z");
const policy = {
  ...DEFAULT_HIP4_READ_POLICY,
  enabled: true,
  catalogMode: "all" as const,
  maxLiveOutcomes: 3,
};
const base = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
).observations[0];
const mapped = mapHip4Market({
  ...base,
  outcome: 8775,
  settlement: null,
  fetchedAt: new Date(now).toISOString(),
  generation: "test",
});
function market(outcome: number, age = 120_000): Hip4ReadMarket {
  const identity = hip4Identity("mainnet", outcome);
  return {
    ...structuredClone(mapped.market),
    outcome,
    marketId: identity.marketId,
    status: "observed",
    expiry: "2099-01-01T00:00:00Z",
    sides: mapped.market.sides.map((side, index) => ({
      ...side,
      ...identity.sides[index],
      bookAt: new Date(now - age).toISOString(),
      bookState: "stale",
    })),
  };
}
function harness(markets: Hip4ReadMarket[]) {
  const stored = new Map(
    markets.map((entry) => [
      entry.outcome,
      { market: structuredClone(entry), raw: mapped.raw },
    ]),
  );
  const requests: string[] = [];
  const writes: Parameters<
    Parameters<typeof refreshHip4VisibleBooks>[5]["persist"]
  >[0][] = [];
  const published: Hip4ReadMarket[] = [];
  let clock = now;
  const dependencies: Parameters<typeof refreshHip4VisibleBooks>[5] = {
    now: () => clock,
    readPolicy: async () => ({ policy, revision: "r1" }),
    readStored: async (outcome) => structuredClone(stored.get(outcome) ?? null),
    readBook: async (request) => {
      assert.equal(
        request.type,
        "l2Book",
        "visible repair must never fetch history or metadata",
      );
      if (!("coin" in request)) throw new Error("unexpected request");
      requests.push(request.coin);
      return {
        coin: request.coin,
        time: clock,
        levels: [
          [{ px: "0.4", sz: "1", n: 1 }],
          [{ px: "0.5", sz: "1", n: 1 }],
        ],
      };
    },
    persist: async (input) => {
      writes.push(input);
      stored.set(input.market.outcome, {
        market: structuredClone(input.market),
        raw: mapped.raw,
      });
      return true;
    },
  };
  return {
    stored,
    requests,
    writes,
    published,
    dependencies,
    advance: () => {
      clock += policy.visibleBookRefreshMs;
    },
    run: (
      candidates = [...stored.values()].map((entry) => entry.market),
      attempts = new Map<number, number>(),
    ) =>
      refreshHip4VisibleBooks(
        policy,
        "r1",
        candidates,
        attempts,
        async (entry) => {
          published.push(entry);
        },
        dependencies,
      ),
  };
}

test("visible demand validates identities, deduplicates sides and bounds indexed point reads", async () => {
  const tokens = [
    ...[1, 2, 3].flatMap((outcome) =>
      hip4Identity("mainnet", outcome).sides.map((side) => side.tokenId),
    ),
  ];
  assert.deepEqual(
    hip4HotOutcomeIds(policy, [
      "hyperliquid:testnet:10",
      "hyperliquid:mainnet:12",
      "hyperliquid:mainnet:010",
    ]),
    [],
  );
  assert.deepEqual(
    hip4HotOutcomeIds({ ...policy, maxHotOutcomes: 2 }, tokens),
    [1, 2],
  );
  let calls = 0;
  const db = {
    query: async (sql: string, parameters: unknown[]) => {
      calls++;
      assert.equal(
        sql,
        "select read_model, raw from hip4_read_markets where environment=$1 and outcome=$2",
      );
      return {
        rows: [{ read_model: market(Number(parameters[1])), raw: mapped.raw }],
      };
    },
  } as unknown as Parameters<typeof readHip4HotMarkets>[0];
  assert.equal(
    (await readHip4HotMarkets(db, { ...policy, maxHotOutcomes: 2 }, tokens))
      .length,
    2,
  );
  assert.equal(calls, 2);
  assert.deepEqual(await readHip4HotMarkets(db, policy, []), []);
  assert.equal(calls, 2, "disappeared demand does no catalog/provider work");
  const malformed = {
    query: async (_sql: string, parameters: unknown[]) => ({
      rows: [
        {
          read_model: Number(parameters[1]) === 1 ? {} : market(2),
          raw: mapped.raw,
        },
      ],
    }),
  } as unknown as Parameters<typeof readHip4HotMarkets>[0];
  assert.deepEqual(
    (
      await readHip4HotMarkets(
        malformed,
        { ...policy, maxHotOutcomes: 2 },
        tokens,
      )
    ).map((entry) => entry.outcome),
    [2],
  );
});

test("fair live selection rotates capped demand, excludes expired/settled and recovers after no WS data", () => {
  const markets = Array.from({ length: 12 }, (_, index) => market(index + 1));
  const selected = new Map<number, number>();
  for (let pass = 0; pass < 4; pass++) {
    const outcomes = selectHip4VisibleLiveOutcomes(
      policy,
      markets,
      selected,
      now + pass,
    );
    assert.deepEqual(
      outcomes,
      [1, 2, 3].map((id) => id + pass * 3),
    );
    for (const outcome of outcomes) selected.set(outcome, now + pass);
  }
  assert.deepEqual(
    selectHip4VisibleLiveOutcomes(
      policy,
      [
        market(50),
        { ...market(51), status: "expired" },
        { ...market(52), expiry: new Date(now - 1).toISOString() },
        { ...market(53), status: "settled" },
      ],
      selected,
      now,
    ),
    [50],
  );
  assert.deepEqual(
    selectHip4VisibleLiveOutcomes(policy, [], selected, now),
    [],
  );
});

test("visible cohort starts before its whole bounded drain deadline, without extending TTL", () => {
  assert.equal(hip4VisibleBookLeadMs(policy, 12), 25_000);
  assert.equal(hip4VisibleBookLeadMs(policy, 100), policy.bookMaxAgeMs);
  assert.equal(
    selectHip4VisibleBookMarkets(
      policy,
      Array.from({ length: 12 }, (_, index) => market(index, 36_000)),
      new Map(),
      now,
    ).length,
    4,
  );
  assert.equal(
    selectHip4VisibleBookMarkets(policy, [market(1, 1_000)], new Map(), now)
      .length,
    0,
  );
  assert.throws(() => hip4ReadPolicySchema.parse({ maxHotOutcomes: 0 }));
  assert.throws(() =>
    hip4ReadPolicySchema.parse({ maxVisibleBookOutcomesPerCycle: 0 }),
  );
});

test("actual visible worker repairs all twelve markets fairly in bounded book-only passes", async () => {
  const worker = harness(
    Array.from({ length: 12 }, (_, index) => market(index + 1)),
  );
  const attempted = new Map<number, number>();
  for (let pass = 0; pass < 3; pass++) {
    const result = await worker.run(undefined, attempted);
    assert.equal(result.selected, 4);
    assert.equal(result.attempts, 8);
    assert.equal(result.refreshed, 8);
    worker.advance();
  }
  assert.equal(new Set(worker.requests).size, 24);
  assert.equal(worker.writes.length, 12);
  assert.ok(
    worker.writes.every(
      (input) => input.advanceCursor === false && input.trades.length === 0,
    ),
  );
  assert.equal((await worker.run()).attempts, 0);
});

test("canonical recheck avoids duplicate reads and publishes committed state", async () => {
  const old = market(1);
  const worker = harness([market(1, 0)]);
  assert.equal((await worker.run([old])).attempts, 0);
  assert.equal(worker.requests.length, 0);
  assert.equal(
    worker.published[0].sides[0].bookAt,
    new Date(now).toISOString(),
  );
});

test("budget denial issues no HTTP and automatically recovers on the next bounded pass", async () => {
  const worker = harness([market(1)]);
  let admit = false;
  let http = 0;
  worker.dependencies.readBook = createHip4ReadClient(
    policy,
    async () => admit,
    async (_url, init) => {
      http++;
      const request = JSON.parse(String(init?.body));
      return Response.json({ coin: request.coin, time: now, levels: [[], []] });
    },
  );
  const denied = await worker.run();
  assert.equal(denied.budgetDenied, 1);
  assert.equal(http, 0);
  assert.equal(
    worker.writes[0].market.sides[0].bookAttempt?.result,
    "budget_exhausted",
  );
  admit = true;
  worker.advance();
  assert.equal((await worker.run()).refreshed, 2);
  assert.equal(http, 2);
});

test("timeouts yield fairly and policy changes stop both further IO and publication", async () => {
  const worker = harness(
    Array.from({ length: 8 }, (_, index) => market(index + 1)),
  );
  worker.dependencies.readBook = async () => {
    throw new Hip4ReadError("timeout");
  };
  assert.equal((await worker.run()).failures, 8);
  worker.advance();
  assert.deepEqual(
    selectHip4VisibleBookMarkets(
      policy,
      [...worker.stored.values()].map((entry) => entry.market),
      new Map(),
      now + 5000,
    ).map((entry) => entry.outcome),
    [5, 6, 7, 8],
  );
  const changed = harness([market(1)]);
  const read = changed.dependencies.readBook;
  changed.dependencies.readBook = async (request) => {
    const payload = await read(request);
    changed.dependencies.readPolicy = async () => ({ policy, revision: "r2" });
    return payload;
  };
  assert.equal((await changed.run()).policyChanged, true);
  assert.equal(changed.requests.length, 1);
  assert.equal(changed.writes.length, 0);
  assert.equal(changed.published.length, 0);
});

test("an exhausted pass yields after one slow book, commits the partial side and retries fairly", async () => {
  const worker = harness(
    Array.from({ length: 8 }, (_, index) => market(index + 1)),
  );
  const read = worker.dependencies.readBook;
  worker.dependencies.readBook = async (request) => {
    const payload = await read(request);
    worker.advance();
    return payload;
  };
  const result = await worker.run();
  assert.equal(result.deadlineReached, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.refreshed, 1);
  assert.equal(worker.writes.length, 1);
  assert.equal(
    worker.writes[0].market.sides[0].bookAt,
    new Date(now).toISOString(),
  );
  assert.equal(
    worker.writes[0].market.sides[1].bookAt,
    new Date(now - 120_000).toISOString(),
  );
  worker.dependencies.readBook = read;
  await worker.run();
  assert.equal(
    worker.requests[1],
    "#20",
    "the next normal pass serves waiting demand before retrying the partial market",
  );
});

test("public book deadline rechecks slow admission before HTTP and bounds slow transport", async (t) => {
  let clock = 1000;
  let admissions = 0;
  let http = 0;
  t.mock.method(Date, "now", () => clock);
  const read = (deadlineMs: number) =>
    createHip4ReadClient(
      policy,
      async () => {
        admissions++;
        clock += 100;
        return true;
      },
      async () => {
        http++;
        return Response.json({});
      },
      { deadlineMs },
    );
  await assert.rejects(
    read(1100)({ type: "l2Book", coin: "#10" }),
    /budget_exhausted/,
  );
  assert.equal(http, 0);
  await assert.rejects(
    read(1100)({ type: "l2Book", coin: "#10" }),
    /budget_exhausted/,
  );
  assert.equal(
    admissions,
    1,
    "expired passes cannot consume another admission",
  );
  await read(2000)({ type: "l2Book", coin: "#10" });
  assert.equal(http, 1, "a new deadline automatically recovers");
  t.mock.restoreAll();
  const timeoutRead = createHip4ReadClient(
    policy,
    async () => true,
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () =>
            reject(
              Object.assign(new Error("bounded transport"), {
                name: "TimeoutError",
              }),
            ),
          { once: true },
        );
      }),
    { deadlineMs: Date.now() + 25 },
  );
  // Keep this mock transport alive until AbortSignal.timeout fires; unlike a
  // real socket it has no native handle of its own.
  const keeper = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      timeoutRead({ type: "l2Book", coin: "#10" }),
      /timeout/,
    );
  } finally {
    clearTimeout(keeper);
  }
});
