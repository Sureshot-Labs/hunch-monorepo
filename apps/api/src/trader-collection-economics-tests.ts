import assert from "node:assert/strict";
import {
  DAY,
  UNIT,
  fmt,
  indexPairedExposure,
  replay,
  units,
  type Action,
  type Close,
  type Increase,
  type Ledger,
  type Market,
  type Position,
  type Resolution,
} from "./services/trader-collection-ledger.js";
import {
  candidates,
  evaluateTrader,
  type Evidence,
  iso,
} from "./services/trader-collection-ranking.js";
import {
  collectEvidence,
  type ReadPage,
} from "./services/trader-collection-source.js";

const end = 1800000000,
  first = end - 3000;
const market: Market = {
  condition: "c",
  index: 0,
  category: "sports",
  active: true,
  ask: UNIT / 2n,
  quoteAt: end,
  instrument: {
    venue: "polymarket",
    marketId: "m",
    eventId: "e",
    tokenId: "1",
    generation: "g",
    side: "YES",
    outcomeLabel: "Yes",
    title: "Fixture",
  },
};
const owner = {
  id: "11111111-1111-4111-8111-111111111111",
  family: "family",
  name: null,
  address: "fixture",
};
const trade = (
  at: number,
  shares: number,
  gross: number,
  side = "BUY",
  tx = String(at),
): Action => ({
  kind: "TRADE",
  time: at,
  side,
  shares: units(shares),
  cash: units(gross),
  index: 0,
  condition: "c",
  token: "1",
  tx,
  label: "Yes",
});
const position = (shares: number, pnl: number, last: number): Position => ({
  condition: "c",
  token: "1",
  index: 0,
  label: "Yes",
  shares: units(shares),
  pnl: units(pnl),
  unrealized: 0n,
  first,
  last,
});
const sale = (at: number, shares: number, gross: number) =>
  trade(at, shares, gross, "SELL");
function confirmed(result: Ledger | null) {
  assert.ok(result, "expected a complete replay");
  return result;
}
const replayed = (...args: Parameters<typeof replay>) =>
  confirmed(replay(...args));
const blank: Ledger = {
  current: 0n,
  openLoss: 0n,
  first,
  closes: [],
  moves: [],
  income: [],
};
const historical = (stake: bigint, at: number): Close => ({
  at,
  stake,
  shares: stake * 2n,
  net: UNIT,
  instrument: market.instrument,
});
function choices(
  ledger: Ledger,
  history?: Close[],
  others: Evidence["ledgers"] = [],
  completeLifetime = true,
  quoteClock = end,
  liveMarket = market,
  uncertainExposureConditions?: Set<string>,
  supplemental?: Evidence["supplemental"],
) {
  const closes =
    history ??
    Array.from({ length: 20 }, (_, i) =>
      historical(500n * UNIT, end - 2 * DAY + i),
    );
  return candidates(
    {
      owner,
      historyStart: end - (completeLifetime ? 25 : 60) * DAY,
      completeLifetime,
      uncertainExposureConditions,
      supplemental,
      gaps: new Set(),
      ledgers: [
        { market, ledger: { ...blank, closes, income: closes } },
        { market: liveMarket, ledger },
        ...others,
      ],
    },
    end,
    undefined,
    quoteClock,
  );
}
const buy = trade(first, 2000, 1000),
  small = trade(first + 1, 10, 5);
const held = replayed(
  [buy, small],
  position(2010, 0, small.time),
  market,
  undefined,
  1,
  end,
);
const before = choices(
  replayed([buy], position(2000, 0, first), market, undefined, 1, end),
);
const after = choices(held);
assert.equal(before["big-moves"].length, 1);
assert.equal(after["big-moves"].length, 1);
assert.equal(
  after["big-moves"][0].item.latestOpenPosition?.lastObservedIncreaseAt,
  iso(first),
);
const achievement = after["big-moves"][0].item.achievement;
assert.ok(achievement.kind === "big_move");
assert.equal(achievement.estimatedIncreaseUsd, "1000");
assert.equal(achievement.relativeToTypical, "2");
// Evidence is frozen at end; asks collected by later work slices use the
// live observation clock, with their own explicit freshness/market expiry.
const later = end + 190;
const lateOpportunity = choices(held, undefined, [], true, later, {
  ...market,
  quoteAt: later,
  tradableUntil: later + 12,
})["big-moves"][0].item.achievement;
assert.ok(lateOpportunity.kind === "big_move");
assert.equal(lateOpportunity.quote.asOf, iso(later));
assert.equal(lateOpportunity.quote.validUntil, iso(later + 12));
assert.equal(lateOpportunity.positionAsOf, iso(end));
assert.equal(
  choices(held, undefined, [], true, later, {
    ...market,
    quoteAt: later,
    tradableUntil: later,
  })["big-moves"].length,
  0,
);
assert.equal(
  choices(held, undefined, [], true, end + 301)["big-moves"].length,
  0,
);
// Condition-specific pre-window carry-ins are not a common account history.
// A single old loss on a reopened token cannot prove a break in the streak.
const sharedHistory = Array.from({ length: 20 }, (_, i) =>
  historical(500n * UNIT, end - 2 * DAY + i),
);
const sparseHistory = [
  ...Array.from({ length: 21 }, (_, i) => ({
    ...historical(10n * UNIT, end - 45 * DAY + i),
    net: -UNIT,
  })),
  ...sharedHistory,
];
const bounded = choices(held, sparseHistory, [], false);
assert.equal(bounded["winning-streaks"].length, 0);
const boundedMove = bounded["big-moves"][0].item.achievement;
assert.ok(boundedMove.kind === "big_move");
assert.equal(boundedMove.relativeToTypical, "2");
assert.equal(
  choices(
    held,
    [
      { ...historical(10n * UNIT, end - 3 * DAY), net: -UNIT },
      ...sharedHistory,
    ],
    [],
    false,
  )["winning-streaks"].length,
  1,
);
const biggerTopup = trade(first + 1, 40, 20);
const two = choices(
  replayed(
    [buy, biggerTopup],
    position(2040, 0, biggerTopup.time),
    market,
    undefined,
    1,
    end,
  ),
);
assert.equal(
  two["big-moves"][0].item.latestOpenPosition?.lastObservedIncreaseAt,
  iso(biggerTopup.time),
);
assert.equal(
  two["big-moves"][0].item.achievement.kind === "big_move" &&
    two["big-moves"][0].item.achievement.observedAt,
  iso(first),
);
// The large increase from 100 to 2,100 shares was completely unwound. A
// later top-up taking the holding back over 100 does not revive that fill.
const partialUnwind = [
  trade(first, 100, 50),
  trade(first + 1, 2000, 1000),
  sale(first + 2, 2000, 1000),
  trade(first + 3, 40, 20),
];
const unwound = replayed(
  partialUnwind,
  position(140, 0, first + 3),
  market,
  undefined,
  1,
  end,
);
assert.deepEqual(
  unwound.moves.map((m) => m.at),
  [first, first + 3],
);
assert.equal(choices(unwound)["big-moves"].length, 0);
// A partial exit genuinely above the original before-balance retains the increase.
const retained = replayed(
  [
    partialUnwind[0],
    partialUnwind[1],
    sale(first + 2, 1980, 990),
    partialUnwind[3],
  ],
  position(160, 0, first + 3),
  market,
  undefined,
  1,
  end,
);
assert.equal(choices(retained)["big-moves"].length, 1);
// Prefix medians ignore dust, include ties only after their timestamp, and
// use the actual middle pair for an even population.
const prefixes = [
  historical(4n * UNIT, first - 4),
  historical(200n * UNIT, first - 3),
  historical(600n * UNIT, first - 3),
  ...Array.from({ length: 18 }, () => historical(800n * UNIT, first)),
];
const med = choices(held, prefixes)["big-moves"][0].item.achievement;
assert.ok(med.kind === "big_move");
assert.equal(med.relativeToTypical, "2.5");
const lateBuy = trade(first + 1, 2000, 1000);
const afterSameSecond = choices(
  replayed(
    [lateBuy],
    { ...position(2000, 0, first + 1), first: first + 1 },
    market,
    undefined,
    1,
    end,
  ),
  prefixes,
)["big-moves"][0].item.achievement;
assert.ok(afterSameSecond.kind === "big_move");
assert.equal(afterSameSecond.relativeToTypical, "1.25");
const fixtureFallback = {
  category: "sports",
  net30: UNIT,
  net24: 0n,
  openLoss: 0n,
  uncertainClose: first - 10,
};
const fallbackRanks = (extra: Evidence["supplemental"]) =>
  choices(
    held,
    [
      historical(10n * UNIT, first - 1000),
      ...Array.from({ length: 19 }, () => historical(UNIT, first - 1100)),
    ],
    [],
    true,
    end,
    market,
    undefined,
    extra,
  );
assert.equal(fallbackRanks([])["big-moves"].length, 1);
const knownStakes = Array.from({ length: 20 }, (_, i) => ({
  at: first - 200 + i,
  stake: 10000n * UNIT,
}));
const repriced = fallbackRanks([
  { ...fixtureFallback, referenceCloses: knownStakes },
]);
assert.equal(repriced["big-moves"].length, 0);
// Dollar earnings and latest open opportunity survive a missing denominator.
const unpriced = fallbackRanks([
  {
    ...fixtureFallback,
    uncertainClose: end - 2 * DAY,
    earliestPossibleClose: end - 3 * DAY,
    referenceCloses: null,
  },
]);
assert.equal(unpriced["big-moves"].length, 0);
// Independent latest opportunity is present on an unaffected earnings card
// when daily amount, close count and largest episode metadata are established.
const daily = unpriced["top-earners-today"][0];
assert.ok(daily);
assert.equal(daily.item.latestOpenPosition?.lastObservedIncreaseAt, iso(first));
const afterFill = fallbackRanks([
  {
    ...fixtureFallback,
    uncertainClose: first + 100,
    earliestPossibleClose: first,
    referenceCloses: null,
  },
]);
assert.equal(
  afterFill["big-moves"].length,
  1,
  "an unknown close no earlier than the fill is outside its median",
);

// Binary pairs are evaluated within the exact condition and generation. A
// matched hedge can't surface as a directional purchase, even on a historical
// trader's independently selected latest-position card.
const opposite: Market = {
  ...market,
  index: 1,
  instrument: {
    ...market.instrument,
    tokenId: "2",
    side: "NO",
    outcomeLabel: "No",
  },
};
function leg(m: Market, actions: Action[]) {
  const rows = actions.map((x) => ({
    ...x,
    condition: m.condition,
    token: m.instrument.tokenId,
    index: m.index,
  }));
  const shares = rows.reduce(
    (n, x) => n + (x.side === "BUY" ? x.shares : -x.shares),
    0n,
  );
  return {
    market: m,
    ledger: replayed(
      rows,
      {
        ...position(0, 0, rows[rows.length - 1].time),
        condition: m.condition,
        token: m.instrument.tokenId,
        index: m.index,
        first: rows[0].time,
        shares,
      },
      m,
      undefined,
      1,
      end,
    ),
  };
}
const own = leg(market, [buy]);
const directional = (
  l: Ledger,
  counter: Evidence["ledgers"],
  uncertain?: Set<string>,
) => choices(l, undefined, counter, true, end, market, uncertain);
function noDirectional(cs: ReturnType<typeof choices>) {
  assert.equal(cs["big-moves"].length, 0);
  assert.equal(
    cs["winning-streaks"].length,
    1,
    "a hedge does not erase historical performance",
  );
  assert.equal(cs["winning-streaks"][0].item.latestOpenPosition, null);
}
for (const at of [first - 100, first, first + 90]) {
  const paired = leg(opposite, [trade(at, 2000, 1000, "BUY", buy.tx)]);
  noDirectional(directional(own.ledger, [paired]));
}
// A material partial hedge must not be advertised at full gross outlay.
noDirectional(
  directional(own.ledger, [leg(opposite, [trade(first, 200, 100)])]),
);
const priorLong = leg(market, [trade(end - 2 * DAY, 10000, 5000), buy]);
noDirectional(
  directional(priorLong.ledger, [
    leg(opposite, [trade(first, 2000, 1000, "BUY", buy.tx)]),
  ]),
);
// A later hedging/unhedging cycle cannot turn the old neutralized position
// back into a new BUY.
noDirectional(
  directional(own.ledger, [
    leg(opposite, [trade(first + 2, 2000, 1000), sale(first + 3, 2000, 1000)]),
  ]),
);
// A side exhausted *before* this purchase (or sold in the same transaction)
// no longer offsets it. Unrelated conditions, generations and dust are benign.
for (const counter of [
  leg(opposite, [trade(first - 50, 2000, 1000), sale(first - 5, 2000, 1000)]),
  leg(opposite, [trade(first - 50, 2000, 1000), sale(first, 2000, 1000)]),
  leg({ ...opposite, condition: "other", active: false }, [
    trade(first, 2000, 1000),
  ]),
  leg(
    {
      ...opposite,
      active: false,
      instrument: { ...opposite.instrument, generation: "old" },
    },
    [trade(first, 2000, 1000)],
  ),
  leg(opposite, [trade(first, 5, 2.5)]),
])
  assert.equal(directional(own.ledger, [counter])["big-moves"].length, 1);
// Existing same-side stock already covers the opposite stake: the later
// $1,000 purchase is incremental directional exposure, not the matched pair.
const inventory = leg(market, [trade(first - 10, 1000, 500), buy]);
const asIncrement = directional(inventory.ledger, [
  leg(opposite, [trade(first - 10, 1000, 500)]),
])["big-moves"][0].item.achievement;
assert.ok(asIncrement.kind === "big_move");
assert.equal(asIncrement.observedAt, iso(first));
assert.equal(asIncrement.estimatedIncreaseUsd, "1000");
for (const key of [
  market.condition,
  market.condition + ":" + market.instrument.generation,
])
  noDirectional(directional(own.ledger, [], new Set([key])));
assert.equal(
  directional(own.ledger, [], new Set(["c:old", "other"]))["big-moves"].length,
  1,
);

const resolved: Resolution = { at: first + 120, payout: [UNIT, 0n] };
const p = position(2000, 0, first);
const cost = { entry: 1000n * UNIT, fees: units(0.25), total: units(1000.25) };
const settle = (native: Position, result = resolved) =>
  replay([buy], native, market, result, 1, end);
assert.equal(settle(p), null, "pre-resolution native P&L does not verify fees");
assert.equal(settle(p, { ...resolved, payout: [0n, UNIT] }), null);
assert.equal(
  settle({ ...p, pnl: units(999.75) }),
  null,
  "do not allocate unproven cost",
);
assert.equal(
  fmt(confirmed(settle({ ...p, pnl: units(1000) })).income[0].net),
  "1000",
);
assert.equal(
  fmt(confirmed(settle({ ...p, remainingCost: cost })).income[0].net),
  "999.75",
);
assert.equal(
  fmt(
    confirmed(
      settle(
        { ...p, remainingCost: cost },
        { ...resolved, payout: [0n, UNIT] },
      ),
    ).income[0].net,
  ),
  "-1000.25",
);
const explicitZero = { entry: 1000n * UNIT, fees: 0n, total: 1000n * UNIT };
assert.equal(
  fmt(confirmed(settle({ ...p, remainingCost: explicitZero })).income[0].net),
  "1000",
);
for (const offset of [-10, 10]) {
  const claim = { ...trade(resolved.at + offset, 2000, 2000), kind: "REDEEM" };
  const result = replay(
    [buy, claim],
    position(0, 1000, claim.time),
    market,
    resolved,
    1,
    end,
  );
  assert.deepEqual(result?.income, [{ at: resolved.at, net: 1000n * UNIT }]);
  assert.equal(
    replay(
      [buy, claim],
      position(0, 999.75, claim.time),
      market,
      resolved,
      1,
      end,
    ),
    null,
  );
  if (offset < 0)
    assert.equal(
      replay(
        [buy, claim],
        position(0, 1000, claim.time),
        market,
        resolved,
        1,
        claim.time,
      ),
      null,
    );
}

// One proven lifetime sale, not a redistribution of fees among episodes.
// Check the actual position/activity parser and ranking, including a loss at
// the head of the series. The daily income must not appear a second time as
// a supplemental native total.
async function soleSaleFixture(
  lastIsLoss = false,
  duplicateStates?: Record<string, unknown>[],
) {
  const activity: Record<string, unknown>[] = [],
    positions: Record<string, unknown>[] = [];
  const instruments = new Map<string, Market>();
  for (let i = 0; i < 20; i++) {
    const condition = "0x" + String(i + 1).padStart(64, "0"),
      token = String(i + 1);
    const bought = end - (22 - i) * DAY,
      sold = i === 19 ? end - 60 : bought + 3600;
    const losing = i === 0 || (i === 19 && lastIsLoss);
    const key = {
      proxy_wallet: owner.address,
      condition_id: condition,
      token_id: token,
      outcome_index: 0,
      outcome: "YES",
    };
    activity.push(
      {
        ...key,
        type: "TRADE",
        side: "BUY",
        timestamp: bought,
        size: 250,
        usdc_size: 100,
        transaction_hash: "0x" + String(i * 2 + 1).padStart(64, "0"),
      },
      {
        ...key,
        type: "TRADE",
        side: "SELL",
        timestamp: sold,
        size: 250,
        usdc_size: losing ? 99 : 111,
        transaction_hash: "0x" + String(i * 2 + 2).padStart(64, "0"),
      },
    );
    positions.push({
      ...key,
      status: "CLOSED",
      redeemable: false,
      current_size: 0,
      total_size: 250,
      entry_cost_usdc: 0,
      entry_fees_usdc: 1,
      total_cost_usdc: 1,
      realized_pnl: losing ? -2 : 10,
      unrealized_pnl: 0,
      first_entry_at: bought,
      last_event_at: sold,
    });
    instruments.set(condition + ":" + token + ":0", {
      ...market,
      condition,
      instrument: { ...market.instrument, tokenId: token },
    });
  }
  if (duplicateStates) {
    const last = positions.pop();
    assert.ok(last);
    positions.push(...duplicateStates.map((state) => ({ ...last, ...state })));
  }
  const read: ReadPage = async (ep, params) => ({
    data:
      ep === "positions" && params.status === "CLOSED"
        ? positions
        : ep === "activity"
          ? params.limit === "1"
            ? [activity[0]]
            : [...activity].sort(
                (a, b) => Number(b.timestamp) - Number(a.timestamp),
              )
          : [],
    nextCursor: null,
  });
  const e = await collectEvidence(
    owner,
    end,
    read,
    async () => instruments,
    new AbortController().signal,
  );
  return e;
}
const flat = { redeemable: false };
const matchedSales = await soleSaleFixture(false, [flat, flat]);
assert.equal(matchedSales.supplemental?.length, 0);
assert.equal(matchedSales.ledgers.flatMap((x) => x.ledger.closes).length, 20);
const soleWins = evaluateTrader(matchedSales, end);
const streak = soleWins.choices["winning-streaks"][0]?.item.achievement;
assert.ok(streak?.kind === "winning_streak");
assert.equal(streak.currentLength, 19);
assert.equal(streak.estimatedStreakPnlUsd, "190");
const earnedToday = soleWins.choices["top-earners-today"][0]?.item.achievement;
assert.ok(earnedToday?.kind === "top_earner_24h");
assert.equal(earnedToday.estimatedNetPnl24hUsd, "10");
assert.equal(earnedToday.completedPositionCount24h, 1);
assert.equal(earnedToday.largestProfitableClose?.estimatedEpisodePnlUsd, "10");
const soleLoss = evaluateTrader(await soleSaleFixture(true), end);
assert.equal(soleLoss.choices["winning-streaks"].length, 0);
assert.equal(
  soleLoss.rejected["winning-streaks"],
  "streak_interrupted_by_loss",
);
assert.equal(soleLoss.choices["top-earners-today"].length, 0);
const missingFlag = await soleSaleFixture(false, [{ redeemable: null }]);
assert.equal(missingFlag.ledgers.flatMap((x) => x.ledger.closes).length, 19);
assert.equal(missingFlag.supplemental?.length, 1);
for (const disputedState of [{ redeemable: true }, { status: "OPEN" }]) {
  for (const states of [
    [disputedState, flat],
    [flat, disputedState],
  ]) {
    const disputed = await soleSaleFixture(false, states);
    assert.equal(disputed.ledgers.flatMap((x) => x.ledger.closes).length, 19);
    assert.ok(disputed.gaps.has("sports"));
    assert.equal(disputed.distinctClosed, 19);
    assert.equal(
      evaluateTrader(disputed, end).choices["winning-streaks"].length,
      0,
    );
  }
}

// A broken balance replay may still be a provable buy-only tail via native
// total_size = current_size. Every duplicate must support that identity.
async function buyOnlyDay(sizes: number[]) {
  const condition = "0x" + "a".repeat(64),
    bought = end - 2 * DAY,
    latest = end - 20;
  const key = {
    proxy_wallet: owner.address,
    condition_id: condition,
    token_id: "1",
    outcome_index: 0,
    outcome: "Yes",
  };
  const rows = sizes.map((n) => ({
    ...key,
    status: "OPEN",
    redeemable: false,
    current_size: 250,
    total_size: n,
    realized_pnl: 0,
    unrealized_pnl: 0,
    first_entry_at: bought,
    last_event_at: latest,
  }));
  const buys = [latest, bought].map((timestamp) => ({
    ...key,
    type: "TRADE",
    side: "BUY",
    size: 100,
    usdc_size: 40,
    timestamp,
    transaction_hash: "0x" + String(timestamp).padStart(64, "0"),
  }));
  const read: ReadPage = async (ep, p) => ({
    data:
      ep === "activity"
        ? p.limit === "1"
          ? [buys[1]]
          : buys
        : ep === "positions" && p.status === "OPEN"
          ? rows
          : [],
    nextCursor: null,
  });
  const e = await collectEvidence(
    owner,
    end,
    read,
    async () => new Map([[condition + ":1:0", { ...market, condition }]]),
    new AbortController().signal,
  );
  assert.equal(e.supplemental?.length, 1);
  return e.supplemental[0].net24;
}
assert.equal(await buyOnlyDay([250, 250]), 0n);
assert.equal(await buyOnlyDay([300, 250]), null);
assert.equal(await buyOnlyDay([250, 300]), null);

const saleAt = first + 20,
  fullSale = sale(saleAt, 2000, 1200);
const disclosedSale: Position = {
  ...position(0, 199, saleAt),
  closedBoughtShares: 2000n * UNIT,
  remainingCost: { entry: 0n, total: UNIT, fees: UNIT },
};
assert.equal(
  replayed([buy, fullSale], disclosedSale, market, undefined, 1, end).closes[0]
    .net,
  199n * UNIT,
);
for (const [acts, observed, m, res] of [
  [
    [buy, fullSale],
    { ...disclosedSale, remainingCost: undefined },
    market,
    undefined,
  ],
  [[buy, fullSale], { ...disclosedSale, pnl: 198n * UNIT }, market, undefined],
  [
    [buy, fullSale],
    { ...disclosedSale, closedBoughtShares: undefined },
    market,
    undefined,
  ],
  [
    [buy, fullSale],
    { ...disclosedSale, closedBoughtShares: 2001n * UNIT },
    market,
    undefined,
  ],
  [[buy, fullSale], { ...disclosedSale, shares: 1n }, market, undefined],
  [[buy, fullSale], { ...disclosedSale, last: saleAt + 1 }, market, undefined],
  [[buy, { ...fullSale, tx: buy.tx }], disclosedSale, market, undefined],
  [[buy, fullSale], { ...disclosedSale, redeemable: true }, market, undefined],
  [[buy, fullSale], disclosedSale, { ...market, terminal: true }, undefined],
  [[buy, fullSale], disclosedSale, market, resolved],
  [
    [buy, sale(first + 1, 1000, 600), sale(saleAt, 1000, 600)],
    disclosedSale,
    market,
    undefined,
  ],
  [
    [buy, sale(first + 1, 2000, 1200), trade(first + 2, 2000, 1000), fullSale],
    { ...disclosedSale, pnl: 399n * UNIT, closedBoughtShares: 4000n * UNIT },
    market,
    undefined,
  ],
] as [Action[], Position, Market, Resolution | undefined][]) {
  assert.equal(replay(acts, observed, m, res, 1, end), null);
}

// Realistic upper-size regression: measure accesses to source stakes, not
// scheduler-dependent wall time. Refilter/resort per instrument is quadratic.
let stakeReads = 0;
const nCloses = 4500,
  nAssets = 1000,
  start = performance.now();
const manyCloses = Array.from({ length: nCloses }, (_, i) => {
  const v = historical(BigInt(50 + ((i * 103) % 1400)) * UNIT, end - DAY + i);
  const stake = v.stake;
  Object.defineProperty(v, "stake", {
    get: () => {
      stakeReads++;
      return stake;
    },
  });
  return v;
});
const manyAssets = Array.from({ length: nAssets }, (_, i) => {
  const move: Increase = {
    at: end - 6000 + i,
    before: 0n,
    after: 2000n * UNIT,
    cash: 1000n * UNIT,
    shares: 2000n * UNIT,
    tx: String(i),
  };
  return {
    market: {
      ...market,
      instrument: { ...market.instrument, tokenId: String(i + 2) },
    },
    ledger: { ...blank, current: move.after, moves: [move] },
  };
});
const many = choices(blank, manyCloses, manyAssets);
assert.equal(many["big-moves"].length, 1);
assert.ok(
  stakeReads < (nCloses + nAssets) * 30,
  `unexpectedly repeated economic evidence scans: ${stakeReads}`,
);
// A busy binary book is indexed once, not joined event-for-event for every
// candidate. Counting original observations keeps this independent of CPU speed.
let pairReads = 0;
const nPairs = 4000;
const series = (side: 0 | 1) =>
  Array.from({ length: nPairs }, (_, i) => {
    const shares = BigInt(i + 1) * 1000n * UNIT;
    return {
      at: first - nPairs + i,
      get shares() {
        pairReads++;
        return side === 0 || i % 2 === 0 ? shares : 0n;
      },
    };
  });
const startPair = performance.now();
const check = indexPairedExposure([
  { market, ledger: { ...blank, current: 1000n * UNIT, exposure: series(0) } },
  { market: opposite, ledger: { ...blank, current: 0n, exposure: series(1) } },
]);
for (let i = 0; i < nPairs; i++) {
  const shares = 1000n * UNIT;
  check(
    market,
    {
      at: first - nPairs + i,
      shares,
      before: BigInt(i) * shares,
      after: BigInt(i + 1) * shares,
      cash: shares / 2n,
      tx: String(i),
    },
    UNIT / 2n,
    10n * UNIT,
  );
}
assert.equal(pairReads, 2 * nPairs);
console.log(
  "OK: known/unknown fees, claim clocks, retained fills and prefix medians",
  {
    closes: nCloses,
    instruments: nAssets,
    stakeReads,
    elapsedMs: Math.round(performance.now() - start),
    pairReads,
    pairElapsedMs: Math.round(performance.now() - startPair),
  },
);
