import assert from "node:assert/strict";
import { runWalletIntelDiscoveryQueue as queue } from "./services/wallet-intel-discovery-queue.js";
import {
  discoverBackgroundPolymarketPositions as discover,
  type BackgroundPositionResult,
} from "./services/polymarket-background-positions.js";

const result = (
  extra: Partial<BackgroundPositionResult> = {},
): BackgroundPositionResult => ({
  status: "complete",
  reason: "complete",
  tokens: [],
  pages: 1,
  pagesThisSlice: 1,
  discoveredTokens: 1,
  elapsedMs: 1,
  resumed: false,
  checkpointAvailable: true,
  retries: 0,
  cursorRestarts: 0,
  httpStatus: null,
  parameter: null,
  traceId: null,
  rateLimitSource: null,
  retryAfterMs: null,
  cfRay: null,
  responseFormat: null,
  ...extra,
});
const order: string[] = [];
let clock = 0;
const completed = await queue({
  targets: ["large", "small", "other"],
  concurrency: 1,
  sliceBudgetMs: 100,
  now: () => clock,
  discover: async (target) => {
    order.push(target);
    clock += 10;
    return target === "large" && order.filter((v) => v === target).length === 1
      ? result({ status: "deferred", reason: "time_budget" })
      : result({ pages: 2 });
  },
});
assert.deepEqual(order, ["large", "small", "other", "large"]);
assert.equal(completed.summary.completed, 3);
assert.equal(completed.summary.continuations, 1);
assert.equal(completed.summary.chargedMs, 40);
for (const reason of [
  "upstream_timeout",
  "rate_limited",
  "capacity",
  "invalid_response",
] as const) {
  let calls = 0;
  await queue({
    targets: [1],
    concurrency: 2,
    sliceBudgetMs: 10,
    discover: async () => {
      calls++;
      return result({ status: "deferred", reason });
    },
  });
  assert.equal(calls, 1, reason);
}
for (const extra of [{ checkpointAvailable: false }, { pagesThisSlice: 0 }]) {
  let calls = 0;
  await queue({
    targets: [1],
    concurrency: 1,
    sliceBudgetMs: 10,
    discover: async () => {
      calls++;
      return result({ status: "deferred", reason: "time_budget", ...extra });
    },
  });
  assert.equal(calls, 1);
}
let spent = 0,
  attempts = 0;
const exhausted = await queue({
  targets: [1, 2],
  concurrency: 1,
  sliceBudgetMs: 100,
  now: () => spent,
  discover: async (_target, budget) => {
    spent += budget;
    attempts++;
    return result({
      status: "deferred",
      reason: "page_budget",
      pages: attempts,
    });
  },
});
assert.equal(exhausted.summary.chargedMs, 200);
assert.equal(attempts, 2);
const isolated = await queue({
  targets: [1, 2],
  concurrency: 2,
  sliceBudgetMs: 100,
  discover: async (t) => {
    if (t === 1) throw Error("offline");
    return result();
  },
});
assert.equal(isolated.errors.size, 1);
assert.equal(isolated.summary.completed, 1);

// Exercise a real resumable reader: >55K tokens, cursor provenance and no
// repeated calls for fast wallets. Transport and store remain strictly local.
const state = new Map<string, string>();
const calls = new Map<string, number>();
const owner = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
const targets = Array.from({ length: 50 }, (_, i) => owner(i + 1));
const many = await queue({
  targets,
  concurrency: 2,
  sliceBudgetMs: 15000,
  discover: (user, walletBudgetMs) =>
    discover({
      owner: user,
      baseUrl: "https://example.invalid",
      config: { pagesPerSlice: 20, walletBudgetMs },
      store: {
        get: async (k) => state.get(k) ?? null,
        set: async (k, v) => {
          state.set(k, v);
        },
        del: async (k) => state.delete(k),
      },
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        const cursor = Number(url.searchParams.get("cursor") ?? 0);
        calls.set(user, (calls.get(user) ?? 0) + 1);
        const count = user === targets[0] ? 500 : 1;
        return Response.json({
          data: Array.from({ length: count }, (_, i) => ({
            token_id: String(cursor * 500 + i + 1),
            proxy_wallet: user,
            condition_id: `0x${"11".repeat(32)}`,
            current_size: 1,
            avg_price: 0.4,
            outcome_index: 0,
            redeemable: false,
          })),
          pagination: {
            next_cursor:
              user === targets[0] && cursor < 110 ? String(cursor + 1) : null,
          },
        });
      }) as typeof fetch,
    }),
});
assert.equal(many.summary.completed, 50);
const firstTarget = targets[0],
  secondTarget = targets[1];
assert.ok(firstTarget);
assert.ok(secondTarget);
assert.equal(many.results.get(firstTarget)?.tokens.length, 55500);
assert.equal(calls.get(secondTarget), 1);
assert.equal(state.size, 0);
console.log(
  "[discovery queue] fairness/budgets/failures/55K portfolio/50 wallets passed",
);
