import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assetKey,
  type Asset,
  type LocalActivity,
} from "./repos/trader-collections.js";
import { DAY, type Market } from "./services/trader-collection-ledger.js";
import {
  advanceLocalCalc,
  startLocalCalc,
  localEvidence,
} from "./services/trader-collection-local.js";
import { evaluateTrader } from "./services/trader-collection-ranking.js";
import {
  servingWindow,
  readCollection,
} from "./services/trader-collection-service.js";
import { collections } from "./schemas/trader-collections.js";

const end = 1800000000,
  owner = {
    id: "11111111-1111-4111-8111-111111111111",
    family: "fixture",
    name: "fixture",
    address: "unused",
    firstSeen: end - 25 * DAY,
  };
const fixture = (
  market: number,
  time: number,
  before: number,
  after: number,
  price: number,
): LocalActivity => ({
  stamp: new Date(time * 1000).toISOString(),
  id: String(time),
  observed_seconds: time,
  market_id: "market" + market,
  token: String(market),
  contract: "",
  venue: "polymarket",
  side: "YES",
  activity_type: "delta",
  source: "snapshot_delta",
  observation_source: "polymarket",
  action: before > after ? "SELL" : "BUY",
  previous_shares: String(before),
  current_shares: String(after),
  shares: String(Math.abs(after - before)),
  price: String(price),
  observed_balance: true,
  comparable_before: true,
  previous_mark: null,
  has_prior_snapshot: true,
  previous_seconds: time - 1,
});
const lookup = {
  markets: async (a: Asset[]) =>
    new Map(
      a.map((v) => {
        const m: Market = {
          instrument: {
            marketId: v.condition,
            eventId: "event",
            generation: "137:contract:v1",
            venue: "polymarket",
            side: "YES",
            title: "Fixture",
            tokenId: v.token,
            outcomeLabel: "Yes",
          },
          condition: "condition" + v.token,
          active: true,
          index: 0,
          category: "sports",
          ask: 500000n,
          markBid: 500000n,
          quoteAt: end,
        };
        return [assetKey(v), m];
      }),
    ),
};
const history = Array.from({ length: 21 }, (_, i) => [
  fixture(i, end - DAY * (i === 0 ? 16 : 2) + i * 2, 0, 100, 0.5),
  fixture(
    i,
    end - DAY * (i === 0 ? 16 : 2) + i * 2 + 1,
    100,
    0,
    i === 0 ? 0.3 : 0.6,
  ),
]).flat();
const today = [
  fixture(21, end - 200, 0, 100, 0.5),
  fixture(21, end - 150, 100, 0, 0.7),
  fixture(22, end - 149, 0, 100, 0.5),
  fixture(22, end - 145, 100, 0, 0.4),
  fixture(23, end - 100 + 0.123456, 0, 2000, 0.5),
];
const run = async (rows: LocalActivity[], pause = 3) => {
  let calc = startLocalCalc(end);
  for (let i = 0; i < rows.length; i += pause) {
    advanceLocalCalc(calc, rows.slice(i, i + pause));
    calc = JSON.parse(JSON.stringify(calc));
  }
  const ev = await localEvidence(calc, owner, lookup);
  return { ev, ranking: evaluateTrader(ev, end), calc };
};
const { ranking, ev } = await run([...history, ...today]);
const daily = ranking.choices["top-earners-today"][0]?.item.achievement;
assert.ok(daily?.kind === "top_earner_24h");
assert.equal(
  daily.estimatedNetPnl24hUsd,
  "10",
  "include both the profit and the loss",
);
const move = ranking.choices["big-moves"][0]?.item;
assert.ok(move?.achievement.kind === "big_move");
assert.equal(move.achievement.estimatedIncreaseUsd, "1000");
assert.equal(move.summary, "Position grew by approximately $1000.");
assert.equal(
  (await run([...history, { ...today[4], has_prior_snapshot: false }])).ranking
    .choices["big-moves"].length,
  0,
);
const hiddenHedge = await run([
  ...history,
  fixture(23, end - 220, 0, 2000, 0.5),
  { ...fixture(23, end - 200, 2000, 0, 0.5), observed_balance: false },
  { ...fixture(23, end - 180, 0, 2000, 0.5), side: "NO", token: "999" },
]);
const pairEvidence = await localEvidence(hiddenHedge.calc, owner, {
  markets: async (a) => {
    const mm = await lookup.markets(a);
    for (const m of mm.values())
      if (m.instrument.tokenId === "999") {
        m.condition = "condition23";
        m.index = 1;
        m.instrument.side = "NO";
      }
    return mm;
  },
});
assert.equal(
  evaluateTrader(pairEvidence, end).rejected["big-moves"],
  "exposure_uncertain",
);
const carry = await run([
  ...history,
  fixture(23, end - 100, 0, 2000, 0.5),
  {
    ...fixture(23, end - 70, 2000, 0, 0.5),
    side: "NO",
    token: "999",
    previous_mark: ".5",
    previous_seconds: end - 3 * DAY,
  },
]);
const carryEvidence = await localEvidence(carry.calc, owner, {
  markets: async (a) => {
    const mm = await lookup.markets(a);
    for (const m of mm.values())
      if (m.instrument.tokenId === "999") {
        m.condition = "condition23";
        m.index = 1;
        m.instrument.side = "NO";
      }
    return mm;
  },
});
assert.equal(
  evaluateTrader(carryEvidence, end).rejected["big-moves"],
  "paired_exposure",
);
assert.equal(
  move.achievement.positionAsOf,
  new Date(today[4].observed_seconds * 1000).toISOString(),
);
assert.ok(!JSON.stringify(move).match(/fillVwap|transactionAt|committedUsd/));
assert.equal(
  ranking.choices["winning-streaks"].length,
  0,
  "a loss resets the streak",
);
const streak = (await run(history)).ranking.choices["winning-streaks"][0]?.item
  .achievement;
assert.ok(streak?.kind === "winning_streak");
assert.equal(streak.currentLength, 20);
assert.deepEqual((await run([...history, ...today], 1000)).ev, ev);
assert.equal(
  (
    await run([
      ...history,
      ...today.slice(0, -1),
      fixture(23, end - 100, 0, 999, 0.5),
    ])
  ).ranking.choices["big-moves"].length,
  0,
);
assert.equal(
  (
    await run([
      ...history,
      { ...today[4], activity_type: "trade", source: "hunch_order_fill" },
    ])
  ).ranking.choices["big-moves"].length,
  0,
);
const dropout = await run([
  fixture(77, end - 200, 0, 100, 0.5),
  { ...fixture(77, end - 100, 100, 0, 0.99), observed_balance: false },
]);
const reappeared = await run([
  ...history,
  fixture(77, end - 220, 0, 2000, 0.5),
  { ...fixture(77, end - 200, 2000, 0, 0.5), observed_balance: false },
  { ...fixture(77, end - 190, 0, 2000, 0.5), comparable_before: false },
  fixture(77, end - 185, 2000, 1000, 0.9),
]);
assert.equal(reappeared.ranking.choices["big-moves"].length, 0);
assert.equal(reappeared.ranking.choices["top-earners-today"].length, 0);
assert.equal(
  (await run([...history.slice(2), ...today])).ranking.rejected["big-moves"],
  "history_too_short",
);
const repriced = await run([
  ...history,
  fixture(100, end - 1000, 0, 10000, 0.8),
]);
assert.equal(
  repriced.ranking.rejected["big-moves"],
  "open_losses_offset_profit",
);
const anchored = await run([
  { ...fixture(9, end - 50, 100, 0, 0.6), previous_mark: ".4" },
]);
assert.equal(anchored.ev.ledgers[0].ledger.closes[0].net, 20000000n);
assert.equal(anchored.ev.observedBasis, true);
const uncertain = await run([
  ...history,
  { ...fixture(91, end - 200, 100, 0, 0.6), previous_mark: null },
  today[4],
]);
assert.equal(uncertain.ranking.rejected["big-moves"], "typical_stake_unknown");
const minimumStreak = await run(
  history.map((v) =>
    v.market_id === "market0" && v.action === "SELL"
      ? { ...v, price: ".6" }
      : v,
  ),
);
assert.match(
  minimumStreak.ranking.choices["winning-streaks"][0].item.summary,
  /At least 21/,
);
const unsettled = await run([fixture(45, end - 1000, 0, 500, 0.4)]);
for (const [winner, expected] of [
  ["YES", 300000000n],
  ["NO", -200000000n],
] as const) {
  const settled = await localEvidence(unsettled.calc, owner, {
    markets: async (a) => {
      const mm = await lookup.markets(a);
      for (const m of mm.values())
        Object.assign(m, { winner, resolvedAt: end - 100 });
      return mm;
    },
  });
  assert.equal(settled.ledgers[0].ledger.closes[0].net, expected);
}
assert.equal(dropout.ev.ledgers[0].ledger.closes.length, 0);
assert.equal(
  dropout.ev.ledgers[0].ledger.income.reduce((n, v) => n + v.net, 0n),
  0n,
);
const many = Array.from({ length: 14001 }, (_, i) =>
  fixture(1, end - 3 * DAY + i, i, i + 1, 0.5),
);
const dense = await run(many, 500);
assert.equal(dense.ev.ledgers[0].ledger.current, 14001000000n);
assert.ok(JSON.stringify(dense.calc).length < 1300);
for (const k of collections) {
  const r = await readCollection(
    async () => servingWindow(null, end, k, end),
    k,
    undefined,
    end,
  );
  assert.equal(r?.response.availability, "preparing");
}
const producer = readFileSync(
  new URL("./services/trader-collection-runtime.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  producer,
  /providerPages|polymarket-data-api|trader-collection-source|\bfetch\(/,
);
console.log(
  "OK: three local rankings, daily net/losing reset, $500 gate, sampling dropout, 14,001-row resumed wallet, no venue client",
);
