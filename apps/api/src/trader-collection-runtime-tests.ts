import assert from "node:assert/strict";
import {
  traderRedisCommand,
  traderSliceAction,
  delayNewSweep,
  expediteNextSweep,
  replacementDue,
} from "./services/trader-collection-service.js";
import {
  createSweep,
  decodeSweep,
  encodeSweep,
  finishSlice,
  progress,
  recordEvaluation,
  slicePlan,
  sweepExpired,
  sweepSnapshots,
  walletFailure,
  visitSweepSlice,
} from "./services/trader-collection-sweep.js";
import {
  emptyChoices,
  evaluateTrader,
} from "./services/trader-collection-ranking.js";
import { collections, collectionSchema } from "./schemas/trader-collections.js";

// A ready but blackholed Redis socket must not pin the only active cycle or
// Fastify onClose. A later pass can use a replacement client straight away.
let discarded = 0;
await assert.rejects(
  traderRedisCommand(
    () => new Promise<never>(() => {}),
    () => {
      discarded++;
    },
    5,
  ),
  /trader_cache_timeout/,
);
assert.equal(discarded, 1);
assert.equal(
  await traderRedisCommand(
    async () => "OK",
    () => {
      discarded++;
    },
  ),
  "OK",
);
assert.equal(discarded, 1);

const slice = {
  stopped: false,
  lostLease: false,
  cooling: false,
  remaining: 3,
  sincePublication: 25,
  selected: 5,
  observed: 2,
};
assert.equal(traderSliceAction(slice), "checkpoint");
assert.equal(delayNewSweep(1760, 1800, 1761), false);
assert.equal(delayNewSweep(1760, 1800, 1801), false);
assert.equal(delayNewSweep(1760, 3500, 1761), true);
assert.equal(expediteNextSweep(50, 0, 1799), true);
assert.equal(expediteNextSweep(50, 0, 1805), true);
assert.equal(expediteNextSweep(0, 0, 1805), false);
assert.equal(expediteNextSweep(50, 0, 100), false);
assert.equal(
  traderSliceAction({ ...slice, replaceExpiring: replacementDue(1800, 1785) }),
  "publish",
);
assert.equal(
  traderSliceAction({ ...slice, replaceExpiring: true, cooling: true }),
  "checkpoint",
);
assert.equal(
  traderSliceAction({ ...slice, replaceExpiring: true, observed: 0 }),
  "checkpoint",
);
assert.equal(traderSliceAction({ ...slice, sincePublication: 211 }), "publish");
// Budget expiry allows explicitly partial publication, but provider cooldown
// must checkpoint the same work without replacing the previously served version.
assert.equal(
  traderSliceAction({ ...slice, sincePublication: 211, cooling: true }),
  "checkpoint",
);
assert.equal(
  traderSliceAction({ ...slice, cooling: true, lostLease: true }),
  "retain",
);
assert.equal(traderSliceAction({ ...slice, stopped: true }), "retain");
assert.equal(
  traderSliceAction({ ...slice, remaining: 0, observed: 0 }),
  "finish_without_publication",
);
assert.equal(
  traderSliceAction({ ...slice, remaining: 0, observed: 5 }),
  "publish",
);
assert.equal(
  traderSliceAction({ ...slice, sincePublication: 300, observed: 0 }),
  "checkpoint",
);
const end = 1800000000,
  owners = Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    family: "f" + i,
    address: "private" + i,
    name: null,
  }));
let state = createSweep(owners, end);
{
  const legacy = createSweep(owners.slice(0, 4), end);
  delete legacy.pageJournal;
  legacy.queue = [3];
  legacy.failed = {
    0: "incomplete_pages",
    1: "owner_mismatch",
    2: "wallet_request_budget",
  };
  const rescued = decodeSweep(encodeSweep(legacy));
  assert.deepEqual(rescued.queue, [3, 0, 2]);
  assert.deepEqual(rescued.failed, { 1: "owner_mismatch" });
  assert.deepEqual(decodeSweep(encodeSweep(rescued)), rescued);
}
const obs = {
  choices: emptyChoices(),
  rejected: {
    "big-moves": "no_recent_retained_buy",
    "top-earners-today": "daily_profit_unknown",
    "winning-streaks": "too_few_verified_wins",
  },
} as const;
for (const [round, n] of [13, 16, 13, 8].entries()) {
  let budget = n;
  assert.equal(
    await visitSweepSlice(
      state,
      () => budget > 0,
      async (i) => {
        budget--;
        await Promise.resolve();
        assert.equal(state.attempts[i], 1);
        recordEvaluation(state, i, obs);
        return "done";
      },
    ),
    n,
  );
  const now = end + (round + 1) * 220;
  const page = sweepSnapshots(state, "v" + round, now);
  state.publishedAt = now;
  state = decodeSweep(encodeSweep(state)); // a new process after every publication
  for (const k of collections) {
    const body = collectionSchema.parse(page[k]),
      d = body.diagnostics;
    assert.ok(d);
    assert.equal(body.windowEnd, new Date(end * 1000).toISOString());
    assert.equal(d.observedWallets + d.pendingWallets, 50);
    assert.equal(d.attemptedWallets, d.observedWallets);
    assert.deepEqual(d.exclusions, [
      { code: obs.rejected[k], wallets: d.observedWallets },
    ]);
    assert.equal(d.qualifiedWallets, 0);
    assert.ok(!JSON.stringify(body).includes("private"));
  }
}
assert.deepEqual(state.queue, []);
assert.equal(progress(state).observedWallets, 50);
// Two large wallets cannot share one slice, but each fits its own 90-call
// budget. Keep them behind untouched owners and then let each finish alone.
const heavy = createSweep(owners.slice(0, 3), end);
const visited: number[] = [];
await visitSweepSlice(
  heavy,
  () => visited.length < 2,
  async (i) => {
    visited.push(i);
    return "shared_budget";
  },
);
assert.deepEqual(heavy.queue, [2, 0, 1]);
for (let pass = 0; pass < 3; pass++) {
  await visitSweepSlice(
    heavy,
    () => true,
    async (i) => {
      visited.push(i);
      recordEvaluation(heavy, i, obs);
      return "done";
    },
  );
}
assert.deepEqual(visited, [0, 1, 2, 0, 1]);
assert.equal(progress(heavy).observedWallets, 3);
const mixed = createSweep(owners, end);
const reason = evaluateTrader(
  {
    owner: owners[0],
    historyStart: end,
    gaps: new Set(),
    ledgers: [],
    completeLifetime: false,
  },
  end,
);
assert.deepEqual(
  Object.values(reason.rejected),
  Array(3).fill("history_too_short"),
);
mixed.attempts[0]++;
recordEvaluation(mixed, 0, reason);
mixed.attempts[1]++;
assert.ok(!walletFailure(mixed, 1, "incomplete_pages", false));
mixed.attempts[2]++;
assert.ok(walletFailure(mixed, 2, "wallet_timeout", true));
finishSlice(mixed, 3, [2]);
mixed.needsFullSlice[2] = true;
assert.deepEqual(slicePlan(mixed), { concurrency: 2, count: 47 });
const counts = progress(mixed);
assert.deepEqual(counts, {
  selectedWallets: 50,
  attemptedWallets: 3,
  observedWallets: 1,
  pendingWallets: 48,
  sourceFailures: [{ code: "incomplete_pages", wallets: 1 }],
});
assert.equal(sweepExpired(mixed, end + 600), false);
assert.equal(sweepExpired(mixed, end + 1800), true);
const renewed = createSweep(
  [...owners].reverse().slice(1),
  end + 1800,
  0,
  mixed,
);
assert.equal(renewed.owners[renewed.queue[0]].id, "3");
assert.equal(progress(renewed).observedWallets, 0);
finishSlice(mixed, 47, []);
assert.deepEqual(slicePlan(mixed), { concurrency: 1, count: 1 });
assert.ok(walletFailure(mixed, 2, "wallet_timeout", true));
assert.ok(!walletFailure(mixed, 2, "wallet_timeout", true));
assert.equal(
  traderSliceAction({ ...slice, remaining: 0, observed: 0, selected: 0 }),
  "publish",
);
console.log("OK: trader cache timeouts, recovery and fenced slice decisions");
