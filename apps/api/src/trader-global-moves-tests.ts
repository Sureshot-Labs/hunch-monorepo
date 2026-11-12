import assert from "node:assert/strict";
import {
  buildGlobalMoves,
  retainedMove,
} from "./services/trader-global-moves.js";
import { collectionSchema } from "./schemas/trader-collections.js";
import { assetKey } from "./repos/trader-collections.js";
import type { Balance, Delta } from "./repos/trader-global-moves.js";
import type { Market } from "./services/trader-collection-ledger.js";
import {
  createSweep,
  sweepSnapshots,
} from "./services/trader-collection-sweep.js";
import { emptyChoices } from "./services/trader-collection-ranking.js";
const end = 1800000000,
  at = end - 1000,
  wallet = (i: number) =>
    "00000000-0000-4000-8000-" + String(i).padStart(12, "0");
const delta = (w: string, cash = "500"): Delta => ({
  wallet: w,
  market: "m",
  side: "YES",
  provenance: "polymarket",
  token: "123",
  contract: "contract",
  prev_qty: "100",
  curr_qty: String(100 + Number(cash) * 2),
  shares: String(Number(cash) * 2),
  price: "0.5",
  cash,
  observed_sec: at,
});
const m: Market = {
  active: true,
  index: 0,
  oppositeToken: "456",
  category: "sports",
  condition: "c",
  instrument: {
    eventId: "e",
    title: "M",
    marketId: "m",
    venue: "polymarket",
    tokenId: "123",
    generation: "137:contract:v1",
    side: "YES",
    outcomeLabel: "YES",
  },
  ask: 510000n,
  quoteAt: end,
};
const d = delta(wallet(1)),
  row = (when: number, qty: string, other = false): Balance => ({
    wallet: d.wallet,
    market: "m",
    side: other ? "NO" : "YES",
    token: other ? "456" : "123",
    contract: "contract",
    observed: true,
    shares: qty,
    observed_sec: when,
  });
const base = row(at - 100, "100"),
  mark = row(at, "1100");
const proof = (...r: Balance[]) => retainedMove(d, r, m, m.oppositeToken, end);
assert.deepEqual(proof(base, mark), { asOf: at, qty: 1100000000n });
assert.equal(proof(mark), "balance_not_comparable");
assert.equal(
  proof({ ...base, observed: false }, mark),
  "balance_not_comparable",
);
assert.equal(
  proof({ ...base, contract: "other" }, mark),
  "balance_not_comparable",
);
assert.equal(
  proof({ ...base, token: "other" }, mark),
  "balance_not_comparable",
);
assert.equal(
  proof({ ...base, observed_sec: end - 86401 }, mark),
  "balance_not_comparable",
);
assert.equal(
  proof(base, mark, row(at + 1, "90"), row(at + 2, "2000")),
  "increase_not_retained",
);
assert.equal(
  proof(base, mark, row(at + 1, "1100", true), row(at + 2, "0", true)),
  "paired_exposure",
);
assert.equal(
  proof(
    base,
    mark,
    { ...row(at + 1, "0"), observed: false },
    row(at + 2, "1100"),
  ),
  "balance_not_comparable",
);
assert.equal(proof(base, { ...mark, shares: "0" }), "balance_not_comparable");
const events = Array.from({ length: 76 }, (_, i) =>
  delta(wallet(i), String(500 + i)),
);
events[75].provenance = "alchemy"; // independently public holder fallback, no tracking membership
events.push({ ...delta(wallet(76), "99999"), provenance: "followed_wallet" });
const page = await buildGlobalMoves(
  {
    async deltas(lo, hi) {
      return at > lo && at <= hi ? events : [];
    },
    async owners(ids) {
      return ids.map((w) => ({
        wallet: w,
        family: w === wallet(74) ? wallet(75) : w,
        name: null,
        system_tracked: false,
      }));
    },
    async balances(pairs) {
      return pairs.flatMap((p) =>
        [
          base,
          {
            ...mark,
            shares: events.find((x) => x.wallet === p.w)?.curr_qty ?? "invalid",
          },
        ].map((r) => ({ ...r, wallet: p.w })),
      );
    },
  },
  {
    async markets() {
      return new Map([
        [assetKey({ condition: "m", token: "123", index: 0 }), m],
      ]);
    },
  },
  end,
  "audit",
  1000,
  new AbortController().signal,
  () => end,
);
assert.ok(collectionSchema.safeParse(page).success);
assert.deepEqual(
  page.groups
    .find((g) => g.category === "sports")
    ?.items.map((i) => i.trader.traderId),
  [wallet(75), wallet(73), wallet(72)],
);
assert.equal(page.diagnostics?.selectedWallets, 77);
assert.equal(page.diagnostics?.qualifiedWallets, 76);
assert.deepEqual(page.diagnostics?.exclusions, [
  { code: "wallet_not_public_trader", wallets: 1 },
]);
const o = Array.from({ length: 100 }, (_, i) => ({
  id: wallet(i),
  family: wallet(i),
  address: "",
  name: null,
}));
const sw = createSweep(o, end);
sw.evaluated[70] = {
  choices: emptyChoices(),
  rejected: { "winning-streaks": "streak_interrupted_by_loss" },
};
sw.attempts[70] = 1;
sw.attempts[99] = 1;
sw.failed[99] = "local_activity_timeout";
sw.queue = sw.queue.filter((i) => !sw.attempts[i]);
const snaps = sweepSnapshots(sw, "test", end);
assert.deepEqual(snaps["winning-streaks"].diagnostics, {
  scope: "whole_shortlist_at_ranking",
  selectedWallets: 100,
  attemptedWallets: 2,
  pendingWallets: 98,
  observedWallets: 1,
  sourceFailures: [{ code: "local_activity_timeout", wallets: 1 }],
  qualifiedWallets: 0,
  exclusions: [{ code: "streak_interrupted_by_loss", wallets: 1 }],
});
assert.equal(snaps["top-earners-today"].diagnostics?.observedWallets, 1);
console.log("global Big Moves and shared shortlist coverage: ok");
