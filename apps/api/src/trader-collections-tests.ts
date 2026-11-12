import assert from "node:assert/strict";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  validatorCompiler,
  serializerCompiler,
} from "fastify-type-provider-zod";
import { createTraderCollectionRoutes } from "./routes/trader-collections.js";
import { collectionSchema, collections } from "./schemas/trader-collections.js";
import {
  DAY,
  UNIT,
  replay,
  fmt,
  units,
  type Action,
  type Position,
  type Market,
} from "./services/trader-collection-ledger.js";
import {
  candidates,
  assemble,
  DEFAULT_TRADER_POLICY,
  winningRun,
} from "./services/trader-collection-ranking.js";
import {
  collectEvidence,
  type ReadPage,
  type ActivityCache,
} from "./services/trader-collection-source.js";
import { assetKey } from "./repos/trader-collections.js";
const end = 1800000000,
  owner = {
    id: "11111111-1111-4111-8111-111111111111",
    address: "0x" + "12".repeat(20),
    family: "family",
    name: "Fixture",
  };
const m: Market = {
  instrument: {
    marketId: "m",
    eventId: "e",
    tokenId: "15",
    venue: "polymarket",
    generation: "v2:test",
    side: "NO",
    outcomeLabel: "Away",
    title: "Example",
  },
  condition: "0x" + "a".repeat(64),
  index: 1,
  category: "sports",
  ask: units(".5".replace(".", "0.")),
  quoteAt: end,
  active: true,
};
const act = (
  kind: string,
  side: string,
  t: number,
  s: number,
  c: number,
  tx = "tx" + t,
): Action => ({
  kind,
  side,
  time: t,
  shares: units(s),
  cash: units(c),
  tx,
  condition: m.condition,
  token: "15",
  index: 1,
  label: "Away",
});
const pos = (
  shares: number,
  pnl: number,
  first: number,
  last: number,
): Position => ({
  condition: m.condition,
  token: "15",
  index: 1,
  label: "Away",
  shares: units(shares),
  pnl: units(pnl),
  unrealized: 0n,
  first,
  last,
});
const a = end - 2 * DAY,
  b = end - 30,
  c = end - 10;
const actions = [
  act("TRADE", "BUY", a, 2000, 1000),
  act("TRADE", "SELL", b, 500, 350),
  act("TRADE", "SELL", c, 1500, 900),
];
const sold = replay(actions, pos(0, 250, a, c), m, undefined, 1, end);
assert.ok(sold);
assert.deepEqual(
  sold.income.map((r) => fmt(r.net)),
  ["100", "150"],
);
assert.equal(sold.closes.length, 1);
assert.equal(sold.closes[0].net, 250n * UNIT);
assert.equal(replay(actions, pos(0, 999, a, c), m, undefined, 1, end), null);
assert.equal(
  replay(actions.slice(1), pos(0, 250, a, c), m, undefined, 1, end),
  null,
);
const buys = [act("TRADE", "BUY", a, 5000, 750)];
const loss = replay(
  buys,
  {
    ...pos(5000, 0, a, a),
    remainingCost: { total: units(750), entry: units(750), fees: 0n },
  },
  m,
  { at: b, payout: [UNIT, 0n] },
  1,
  end,
);
assert.ok(loss);
assert.equal(loss.closes[0].net, -750n * UNIT);
assert.equal(loss.closes[0].at, b);
assert.equal(loss.current, 0n);
const nativeFees = {
  total: units(750.25),
  entry: units(750),
  fees: units(0.25),
};
const netLoss = replay(
  buys,
  { ...pos(5000, 0, a, a), remainingCost: nativeFees },
  m,
  { at: b, payout: [UNIT, 0n] },
  1,
  end,
);
assert.equal(netLoss?.closes[0].net, -units(750.25));
assert.equal(
  replay(
    buys,
    {
      ...pos(5000, 0, a, a),
      remainingCost: { ...nativeFees, total: units(752) },
    },
    m,
    { at: b, payout: [UNIT, 0n] },
    1,
    end,
  ),
  null,
);
assert.equal(
  replay(
    buys,
    { ...pos(5000, 0, a, a), redeemable: true },
    m,
    undefined,
    1,
    end,
  ),
  null,
);
const win = replay(
  [...buys, act("REDEEM", "", c, 5000, 5000)],
  pos(0, 4250, a, c),
  m,
  { at: b, payout: [0n, UNIT] },
  1,
  end,
);
assert.ok(win);
assert.equal(win.income.length, 1);
assert.equal(win.closes[0].at, b);
const claimBeforePublication = [...buys, act("REDEEM", "", b, 5000, 5000)];
const reportedLater = { at: c, payout: [0n, UNIT] as const };
const lagged = replay(
  claimBeforePublication,
  pos(0, 4250, a, b),
  m,
  reportedLater,
  1,
  end,
);
assert.ok(lagged);
assert.deepEqual(lagged.income, [{ at: c, net: 4250n * UNIT }]);
assert.equal(lagged.closes.length, 1);
assert.equal(
  replay(claimBeforePublication, pos(0, 4250, a, b), m, reportedLater, 1, b),
  null,
);
assert.equal(
  replay(
    [...buys, act("REDEEM", "", b, 5000, 2)],
    pos(0, 4250, a, b),
    m,
    reportedLater,
    1,
    end,
  ),
  null,
);
const duplicate = act("TRADE", "BUY", c, 1000, 500);
const bought = replay(
  [duplicate, duplicate],
  pos(2000, 0, c, c),
  m,
  undefined,
  1,
  end,
);
assert.ok(bought);
assert.equal(bought.moves.length, 1);
assert.equal(bought.moves[0].cash, 1000n * UNIT);
assert.equal(bought.moves[0].before, 0n);
const closed = Array.from({ length: 21 }, (_, i) => ({
  ...sold.closes[0],
  net: i === 0 ? -10n * UNIT : 50n * UNIT,
  at: end - 23 * DAY + i * DAY,
  stake: 400n * UNIT,
  shares: 1000n * UNIT,
}));
const r = winningRun(
  [...closed, { ...closed[5], at: end - 1, stake: 999n * UNIT }],
  DEFAULT_TRADER_POLICY,
  false,
);
assert.ok(r);
assert.equal(r.n, 20);
assert.equal(winningRun(closed.slice(1), DEFAULT_TRADER_POLICY, false), null);
assert.equal(
  winningRun(
    [...closed, { ...closed[closed.length - 1], net: -1n }],
    DEFAULT_TRADER_POLICY,
    true,
  ),
  null,
);
const markets = new Map<string, Market>();
const raw: Record<string, unknown>[] = [],
  rawPos: Record<string, unknown>[] = [];
for (let i = 0; i < 23; i++) {
  const t = String(i + 1),
    condition = "0x" + (i + 1).toString(16).padStart(64, "0"),
    first = end - (25 - i) * DAY,
    at = i === 21 ? end - 200 : first + 100;
  const market = {
    ...m,
    condition,
    tradableUntil: end + 120,
    instrument: { ...m.instrument, tokenId: t, marketId: "m" + i },
  };
  markets.set(assetKey({ token: t, condition, index: 1 }), market);
  const seal = {
    proxy_wallet: owner.address,
    condition_id: condition,
    token_id: t,
    outcome_index: 1,
    outcome: "Away",
  };
  const isOpen = i === 22;
  const start = isOpen ? c : first;
  raw.push({
    ...seal,
    type: "TRADE",
    side: "BUY",
    timestamp: start,
    size: isOpen ? 2000 : 1000,
    usdc_size: isOpen ? 1000 : 400,
    transaction_hash: "0x" + String(i).padStart(64, "0"),
  });
  if (!isOpen)
    raw.push({
      ...seal,
      type: "TRADE",
      side: "SELL",
      timestamp: at,
      size: 1000,
      usdc_size: i === 0 ? 390 : 460,
      transaction_hash: "0x" + String(i + 24).padStart(64, "0"),
    });
  rawPos.push({
    ...seal,
    status: isOpen ? "OPEN" : "CLOSED",
    current_size: isOpen ? 2000 : 0,
    realized_pnl: isOpen ? 0 : i === 0 ? -10 : 60,
    unrealized_pnl: 0,
    first_entry_at: start,
    last_event_at: isOpen ? start : at,
  });
}
const read: ReadPage = async (ep, params, cursor) => {
  if (ep === "positions") {
    if (params.status === "CLOSED")
      assert.equal(params.include_archived, undefined);
    else {
      assert.equal(params.filter_amount, "0");
      assert.equal(params.include_archived, "true");
    }
    return {
      data: rawPos.filter((p) => p.status === params.status),
      nextCursor: null,
    };
  }
  if (ep === "resolutions") return { data: [], nextCursor: null };
  const page = [...raw].sort(
    (a, b) => Number(b.timestamp) - Number(a.timestamp),
  );
  if (params.limit === "1") return { data: page.slice(-1), nextCursor: null };
  return !cursor
    ? { data: page.slice(0, 20), nextCursor: "tail" }
    : { data: page.slice(20), nextCursor: null };
};
const evidence = await collectEvidence(
  owner,
  end,
  read,
  async () => markets,
  new AbortController().signal,
);
assert.deepEqual([...evidence.gaps], []);
const cs = candidates(evidence, end);
for (const k of collections) assert.equal(cs[k].length, 1, k);
// Independently reliable native fee-bearing P&L need not imply that an
// individual sale's profit is known. The observed capital still belongs in
// the normal stake distribution; omitting it turns a small trade into a whale.
const feeRead =
  (allNative: boolean): ReadPage =>
  async (ep, p, cursor, s) => {
    const page = await read(ep, p, cursor, s);
    return {
      ...page,
      data: page.data.map((r) => {
        if (r.token_id === "23" || (ep !== "activity" && ep !== "positions"))
          return r;
        if (r.token_id === "1" && !allNative)
          return ep === "positions"
            ? { ...r, realized_pnl: 1 }
            : { ...r, size: 25, usdc_size: r.side === "BUY" ? 10 : 11 };
        return ep === "positions"
          ? { ...r, realized_pnl: 95 }
          : { ...r, size: 25000, usdc_size: r.side === "BUY" ? 10000 : 10100 };
      }),
    };
  };
for (const allNative of [false, true]) {
  const e = await collectEvidence(
    owner,
    end,
    feeRead(allNative),
    async () => markets,
    new AbortController().signal,
  );
  const stakes = e.supplemental?.flatMap((v) => v.referenceCloses ?? []) ?? [];
  assert.ok(stakes.filter((c) => c.stake === units(10000)).length >= 20);
  const cards = candidates(e, end);
  assert.equal(cards["big-moves"].length, 0);
  const earned = cards["top-earners-today"][0]?.item.achievement;
  assert.ok(earned?.kind === "top_earner_24h");
  assert.equal(earned.netRealized24hUsd, "95");
}
const openRow = rawPos.find((r) => r.status === "OPEN");
assert.ok(openRow);
const hedgeKey = {
  condition: String(openRow.condition_id),
  token: "799",
  index: 0,
};
const hedgeMarket = {
  ...m,
  index: 0,
  condition: hedgeKey.condition,
  instrument: {
    ...m.instrument,
    tokenId: hedgeKey.token,
    side: "YES" as const,
  },
};
const pairedMarkets = new Map(markets).set(assetKey(hedgeKey), hedgeMarket);
const pairedRead: ReadPage = async (ep, p, cur, s) => {
  const page = await read(ep, p, cur, s);
  if (ep === "positions" && p.status === "OPEN")
    return {
      ...page,
      data: [
        ...page.data,
        {
          ...openRow,
          token_id: hedgeKey.token,
          outcome_index: 0,
          first_entry_at: end - 60 * DAY,
          last_event_at: end - 60 * DAY,
          current_size: 2000,
        },
      ],
    };
  return page;
};
const withDormant = await collectEvidence(
  owner,
  end,
  pairedRead,
  async () => pairedMarkets,
  new AbortController().signal,
);
assert.equal(
  withDormant.ledgers.find((v) => v.market.instrument.tokenId === "799")?.ledger
    .current,
  units(2000),
);
const hedgedRank = candidates(withDormant, end);
assert.equal(hedgedRank["big-moves"].length, 0);
assert.equal(hedgedRank["top-earners-today"][0].item.latestOpenPosition, null);
// Exercise actual filter behavior: an archived unclaimed loss that has no
// recent activity must still cancel a superficially profitable day.
const lossCondition = "0x" + "f".repeat(64);
const lossMarket = {
  ...m,
  condition: lossCondition,
  terminal: true,
  active: false,
  instrument: { ...m.instrument, tokenId: "99", marketId: "loss" },
};
const extraMarket = new Map(markets).set(
  assetKey({ condition: lossCondition, token: "99", index: 1 }),
  lossMarket,
);
const oldBuy = {
  ...raw[0],
  proxy_wallet: owner.address,
  condition_id: lossCondition,
  token_id: "99",
  outcome_index: 1,
  side: "BUY",
  type: "TRADE",
  timestamp: end - 45 * DAY,
  size: 10000,
  usdc_size: 750,
};
const lossPosition = {
  ...oldBuy,
  status: "REDEEMABLE_LOST",
  current_size: 10000,
  first_entry_at: oldBuy.timestamp,
  last_event_at: oldBuy.timestamp,
  unrealized_pnl: 0,
  realized_pnl: 0,
  entry_cost_usdc: 750,
  entry_fees_usdc: 0,
  total_cost_usdc: 750,
};
const withArchived: ReadPage = async (ep, p, cursor, s) => {
  if (ep === "positions" && p.status === "REDEEMABLE_LOST")
    return {
      data:
        p.filter_amount === "0" && p.include_archived === "true"
          ? [lossPosition]
          : [],
      nextCursor: null,
    };
  if (ep === "resolutions")
    return {
      data: p.condition.split(",").includes(lossCondition)
        ? [
            {
              condition_id: lossCondition,
              status: "resolved",
              resolved_at: new Date((end - 20) * 1000).toISOString(),
              payouts: [1000000, 0],
            },
          ]
        : [],
      nextCursor: null,
    };
  if (ep === "activity" && p.condition === lossCondition)
    return { data: [oldBuy], nextCursor: null };
  return read(ep, p, cursor, s);
};
const withLoss = await collectEvidence(
  owner,
  end,
  withArchived,
  async () => extraMarket,
  new AbortController().signal,
);
assert.equal(
  withLoss.ledgers.find((v) => v.market.condition === lossCondition)?.ledger
    .closes[0].net,
  -units(750),
);
assert.equal(candidates(withLoss, end)["top-earners-today"].length, 0);
const conflicting: ReadPage = async (ep, p, cursor, s) => {
  const page = await read(ep, p, cursor, s);
  if (ep === "positions" && p.status === "OPEN" && page.data.length)
    return {
      ...page,
      data: [...page.data, { ...page.data[0], outcome_index: 0 }],
    };
  return page;
};
const invalid = await collectEvidence(
  owner,
  end,
  conflicting,
  async () => markets,
  new AbortController().signal,
);
assert.ok(invalid.gaps.has("sports"));
assert.equal(candidates(invalid, end)["top-earners-today"].length, 0);
// Provider reports the claim already, but the official settlement falls beyond
// our frozen end. Its lifetime P&L is not earnings in this window.
const claimed: ReadPage = async (ep, p, cursor, s) => {
  const page = await read(ep, p, cursor, s);
  if (ep === "positions" && p.status === "CLOSED")
    return {
      ...page,
      data: [
        ...page.data,
        {
          ...lossPosition,
          status: "CLOSED",
          current_size: 0,
          realized_pnl: 9250,
          first_entry_at: end - 400,
          last_event_at: end - 5,
        },
      ],
    };
  if (ep === "activity" && p.limit !== "1" && !cursor)
    return {
      ...page,
      data: [
        {
          ...oldBuy,
          type: "REDEEM",
          side: "",
          timestamp: end - 5,
          usdc_size: 10000,
        },
        { ...oldBuy, timestamp: end - 400 },
        ...page.data,
      ],
    };
  if (ep === "resolutions" && p.condition.split(",").includes(lossCondition))
    return {
      data: [
        {
          condition_id: lossCondition,
          status: "resolved",
          resolved_at: new Date((end + 12) * 1000).toISOString(),
          payouts: [0, 1000000],
        },
      ],
      nextCursor: null,
    };
  return page;
};
const beforeResolution = await collectEvidence(
  owner,
  end,
  claimed,
  async () => extraMarket,
  new AbortController().signal,
);
const undescribedClaim: ReadPage = async (ep, p, cursor, s) => {
  const page = await claimed(ep, p, cursor, s);
  return {
    ...page,
    data: page.data.map((x) =>
      x.type === "REDEEM" ? { ...x, token_id: null, outcome_index: null } : x,
    ),
  };
};
const unknownClaim = await collectEvidence(
  owner,
  end,
  undescribedClaim,
  async () => extraMarket,
  new AbortController().signal,
);
assert.equal(candidates(unknownClaim, end)["top-earners-today"].length, 0);
assert.equal(
  beforeResolution.supplemental?.find((v) => v.category === "sports")?.net24,
  null,
);
assert.equal(
  cs["top-earners-today"][0].item.achievement.kind,
  "top_earner_24h",
);
assert.equal(
  candidates({ ...evidence, gaps: new Set(["sports"]) }, end)["winning-streaks"]
    .length,
  0,
);
await assert.rejects(
  collectEvidence(
    owner,
    end,
    async () => ({ data: [{ proxy_wallet: "wrong" }], nextCursor: null }),
    async () => markets,
    new AbortController().signal,
  ),
  /owner_mismatch/,
);
await assert.rejects(
  collectEvidence(
    owner,
    end,
    async () => ({ data: [], nextCursor: "repeat" }),
    async () => markets,
    new AbortController().signal,
  ),
  /repeated_cursor/,
);
const cache = new Map<string, ActivityCache>();
const pages: { end: string; cursor: string | null }[] = [];
const paged: ReadPage = async (ep, p, c, s) => {
  if (ep === "activity" && p.limit !== "1" && !p.condition) {
    pages.push({ end: p.end, cursor: c });
    if (p.end === String(end) && p.start === String(end - 30 * DAY + 1)) {
      const i = c === null ? 0 : Number(c);
      return { data: [], nextCursor: i < 9 ? String(i + 1) : null };
    }
    return { data: [], nextCursor: null };
  }
  return ep === "activity" ? read(ep, p, c, s) : { data: [], nextCursor: null };
};
const shortCoverage = await collectEvidence(
  owner,
  end,
  paged,
  async () => new Map(),
  new AbortController().signal,
  cache,
);
assert.equal(shortCoverage.positionWindowFallback, true);
assert.equal(cache.get(owner.address)?.pending?.cursor, "8");
await collectEvidence(
  owner,
  end + 120,
  paged,
  async () => new Map(),
  new AbortController().signal,
  cache,
);
assert.deepEqual(pages.slice(9), [
  { end: String(end), cursor: "8" },
  { end: String(end), cursor: "9" },
  { end: String(end + 120), cursor: null },
]);
assert.equal(cache.get(owner.address)?.end, end + 120);
const gap30 = {
  ...evidence,
  supplemental: [
    {
      category: "sports",
      net30: null,
      net24: 0n,
      openLoss: 0n,
      uncertainClose: 0,
    },
  ],
};
assert.equal(candidates(gap30, end)["top-earners-today"].length, 0);
const oldGap = {
  ...evidence,
  supplemental: [
    {
      category: "sports",
      net30: 0n,
      net24: 0n,
      openLoss: 0n,
      uncertainClose: end - 28 * DAY,
    },
  ],
};
assert.equal(candidates(oldGap, end)["winning-streaks"].length, 1);
const todayGap = {
  ...evidence,
  supplemental: [
    {
      category: "sports",
      net30: 0n,
      net24: null,
      openLoss: 0n,
      uncertainClose: end - 1,
      earliestPossibleClose: end - 1,
    },
  ],
};
assert.equal(candidates(todayGap, end)["winning-streaks"].length, 0);
assert.equal(candidates(todayGap, end)["top-earners-today"].length, 0);
assert.equal(candidates(todayGap, end)["big-moves"].length, 1);
const knownDaily = {
  ...todayGap,
  supplemental: todayGap.supplemental.map((s) => ({
    ...s,
    net24: units(9),
    net30: units(9),
  })),
};
const dailyCard = candidates(knownDaily, end)["top-earners-today"][0]?.item
  .achievement;
assert.ok(dailyCard?.kind === "top_earner_24h");
assert.equal(dailyCard.netRealized24hUsd, "69");
assert.equal(dailyCard.closeDetailsComplete, false);
assert.equal(dailyCard.completedPositionCount24h, null);
assert.equal(dailyCard.largestProfitableClose, null);
for (const skew of [-3, 3]) {
  const skewed: ReadPage = async (ep, p, cur, s) => {
    const page = await read(ep, p, cur, s);
    if (ep === "positions" && p.status === "OPEN")
      return {
        ...page,
        data: page.data.map((x) => ({
          ...x,
          last_event_at: Number(x.last_event_at) + skew,
        })),
      };
    return page;
  };
  const observed = await collectEvidence(
    owner,
    end,
    skewed,
    async () => markets,
    new AbortController().signal,
  );
  const ranked = candidates(observed, end);
  assert.equal(ranked["big-moves"].length, 0);
  assert.equal(ranked["top-earners-today"].length, skew < 0 ? 0 : 1);
}
const snapshots = assemble([cs, cs], end, "snap", 2, ["sports", "mentions"]);
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(swagger, {
  openapi: { info: { title: "Intel", version: "1" } },
  transform: jsonSchemaTransform,
});
let clock = end,
  reads = 0,
  unavailable = false;
await app.register(
  createTraderCollectionRoutes(
    async (k) => {
      reads++;
      return unavailable ? null : snapshots[k];
    },
    () => clock * 1000,
  ),
);
await app.ready();
try {
  for (const k of collections) {
    const url = "/intel/traders/" + k;
    assert.ok(app.swagger().paths?.[url]?.get);
    const first = await app.inject(url + "?category=sports");
    assert.equal(first.statusCode, 200, first.body);
    const body = collectionSchema.parse(first.json());
    assert.equal(body.groups.length, 1);
    assert.equal(body.groups[0].items.length, 1);
    assert.equal(body.groups[0].items[0].rank, 1);
    assert.equal(body.groups[0].coverage.eligibleWallets, 1);
    assert.equal(body.snapshotId, "snap");
    assert.ok(!first.body.includes(owner.address));
    const unchanged = await app.inject({
      url: url + "?category=sports",
      headers: { "if-none-match": String(first.headers.etag) },
    });
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.body, "");
    assert.equal(
      (await app.inject(url + "?category=other")).json().groups[0].status,
      "unsupported",
    );
    assert.equal(
      (await app.inject(url + "?category=mentions")).json().groups[0].status,
      "insufficient_evidence",
    );
    assert.equal((await app.inject(url + "?category=%21")).statusCode, 400);
  }
  clock = end + 120;
  assert.equal(
    (await app.inject("/intel/traders/big-moves?category=sports")).json()
      .groups[0].items.length,
    0,
  );
  assert.equal(
    (
      await app.inject("/intel/traders/top-earners-today?category=sports")
    ).json().groups[0].items[0].latestOpenPosition,
    null,
  );
  clock = end + 301;
  const old = await app.inject("/intel/traders/big-moves?category=sports");
  assert.equal(old.json().groups[0].items.length, 0);
  assert.equal(
    (
      await app.inject("/intel/traders/top-earners-today?category=sports")
    ).json().groups[0].items[0].latestOpenPosition,
    null,
  );
  clock = end + 1800;
  assert.equal(
    (await app.inject("/intel/traders/winning-streaks")).statusCode,
    503,
  );
  unavailable = true;
  clock = end;
  assert.equal(
    (await app.inject("/intel/traders/big-moves")).headers["retry-after"],
    "30",
  );
  console.log(
    "OK: provider → ledger → rankings → three Fastify/OpenAPI routes",
    { reads },
  );
} finally {
  await app.close();
}
