import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { readFileSync, writeFileSync } from "node:fs";
import { createTradingBookCache } from "./services/trading-book-cache.js";
import {
  capSpendByFunds,
  readSpendLevels,
  spendDepth,
  walkSpend,
} from "./services/recommended-spend-math.js";
import {
  createRecommendedSpendService,
  type RecommendedSpendDependencies,
} from "./services/recommended-spend.js";
import {
  selectedReadyCollateral,
  readyForDirectCollateral,
} from "./services/recommended-spend-account.js";
import { readRecommendedSpendOrderPage } from "./services/recommended-spend-orders.js";
import type { PreparationResult } from "./funding/domain/contracts.js";
import { createRecommendedSpendRoutes } from "./routes/recommended-spend.js";
import { recommendedSpendResponse } from "./schemas/recommended-spend.js";
import type { ApiTradeMarket } from "./services/api-trading-market-repo.js";
import {
  calculatePolymarketQuote,
  calculatePolymarketSignedBuyRequiredSpendRaw,
  type PolymarketQuoteContext,
} from "./services/polymarket-quote.js";
import type { AccountValueReadModel } from "./account-value/runtime-service.js";
import { findMaxPolymarketMarketBuyUsdForFunds } from "./services/polymarket-trading-service.js";

const start = Date.now();
let clock = start;
const levels = readSpendLevels(
  {
    asks: [
      { price: "0.51", size: "100" },
      { price: "0.50", size: "100" },
    ],
  },
  "polymarket",
);
const strict = spendDepth(levels, "0.01", 100);
assert.equal(strict.capacityRaw, 50_000_000n);
assert.equal(strict.priceLimit, "0.5");
assert.equal(spendDepth(levels, "0.001", 100).priceLimit, "0.505");
assert.equal(spendDepth(levels, "0.01", 200).capacityRaw, 101_000_000n);
assert.deepEqual(walkSpend(strict, 25_000_000n), {
  expectedShares: "50",
  averagePrice: "0.5",
  worstPrice: "0.5",
});
assert.equal(
  capSpendByFunds(
    50_000_000n,
    20_000_000n,
    (raw) => raw + raw / 10n,
    1_000_000n,
  ),
  18_180_000n,
);
assert.equal(
  capSpendByFunds(
    50_000_000n,
    100n,
    () => {
      throw Error("do not quote dust");
    },
    1_000_000n,
  ),
  0n,
);
assert.equal(
  capSpendByFunds(50_000_000n, 20_000_000n, () => null),
  null,
);
assert.equal(
  capSpendByFunds(10n ** 30n, 20_000_000n, (raw) => {
    assert.ok(raw <= 20_000_000n);
    return raw;
  }),
  20_000_000n,
);
assert.equal(
  spendDepth(
    readSpendLevels(
      { bids: [{ price: "0.3", size: "100000000" }] },
      "limitless",
      true,
    ),
    "0.001",
    30,
  ).capacityRaw,
  70_000_000n,
);
assert.equal(
  spendDepth(
    readSpendLevels(
      { asks: [{ price: "0.5", size: "9007199254740993" }] },
      "polymarket",
    ),
    "0.01",
    30,
  ).capacityRaw,
  4_503_599_627_370_496_500_000n,
);
assert.equal(spendDepth([], "0.01", 30).capacityRaw, 0n);
assert.throws(() =>
  readSpendLevels({ asks: [{ price: "oops", size: "10" }] }, "polymarket"),
);
assert.throws(() => spendDepth(levels, "0", 30));
assert.throws(() => spendDepth(levels, "0.01", -1));
assert.equal(
  spendDepth(
    readSpendLevels({ asks: [{ price: "0.999", size: "10" }] }, "polymarket"),
    "0.001",
    10_000,
  ).priceLimit,
  "0.999",
);

const cache = createTradingBookCache(() => clock, 2);
let fetches = 0;
const fetchBook = async () => {
  fetches++;
  return { timestamp: String(start), asks: [] };
};
const [first, second] = await Promise.all([
  cache.load("a", fetchBook),
  cache.load("a", fetchBook),
]);
assert.strictEqual(first, second);
assert.equal(fetches, 1);
clock += 1_000;
assert.equal(
  (await cache.load("a", fetchBook)).expiresAt,
  new Date(start + 5_000).toISOString(),
);
clock += 1_001;
await cache.load("a", fetchBook);
assert.equal(fetches, 2);
await assert.rejects(
  cache.load("failure", async () => {
    throw Error("upstream");
  }),
);
await cache.load("failure", fetchBook);
assert.equal(fetches, 3);
const unknownClock = await cache.load("no-clock", async () => ({ asks: [] }));
assert.equal(unknownClock.sourceAsOf, null);
clock = start;

// Slow in-flight loads remain single-flight beyond the cache TTL; bounded cache
// must not evict them and accidentally issue duplicate provider calls.
let finish!: (value: unknown) => void;
const pendingCache = createTradingBookCache(() => clock, 1);
let pendingCalls = 0;
const pending = pendingCache.load("pending", () => {
  pendingCalls++;
  return new Promise((resolve) => {
    finish = resolve;
  });
});
clock += 2500;
const samePending = pendingCache.load("pending", async () => {
  pendingCalls++;
  return {};
});
await assert.rejects(
  pendingCache.load("other", async () => ({})),
  /book_cache_busy/,
);
finish({ asks: [] });
assert.strictEqual(await pending, await samePending);
assert.equal(pendingCalls, 1);
assert.equal((await pending).observedAt, new Date(start).toISOString());
clock = start;

const funder = `0x${"a".repeat(40)}`;
const order = {
  id: "one",
  maker_address: funder,
  side: "BUY",
  price: "0.5",
  original_size: "100",
  size_matched: "10",
};
assert.equal(
  readRecommendedSpendOrderPage(
    { data: [order], next_cursor: "LTE=" },
    funder,
    new Set(),
  ).lockedRaw,
  45_000_000n,
);
assert.equal(
  readRecommendedSpendOrderPage(
    { data: [], next_cursor: "LTE=" },
    funder,
    new Set(),
  ).lockedRaw,
  0n,
);
assert.throws(
  () => readRecommendedSpendOrderPage({}, funder, new Set()),
  /invalid_open_orders_page/,
);
assert.throws(() =>
  readRecommendedSpendOrderPage(
    { data: [order], next_cursor: "" },
    funder,
    new Set(),
  ),
);
assert.throws(() =>
  readRecommendedSpendOrderPage(
    { data: [{ ...order, price: null }], next_cursor: "LTE=" },
    funder,
    new Set(),
  ),
);
assert.throws(() =>
  readRecommendedSpendOrderPage(
    { data: [{ ...order, size_matched: "101" }], next_cursor: "LTE=" },
    funder,
    new Set(),
  ),
);
assert.throws(() =>
  readRecommendedSpendOrderPage(
    { data: [order, order], next_cursor: "LTE=" },
    funder,
    new Set(),
  ),
);
const preparation = {
  binding: { venueId: "polymarket" },
  expiresAt: new Date(start + 5000).toISOString(),
  readinessClass: "internal_managed",
  evidence: {
    checks: [
      { checkId: "owner", status: "satisfied" },
      { checkId: "funding_router_ready", status: "unavailable" },
    ],
  },
} as unknown as PreparationResult;
assert.equal(readyForDirectCollateral(preparation, start), true);
assert.equal(
  readyForDirectCollateral({ ...preparation, expiresAt: "bad" }, start),
  false,
);
assert.equal(
  readyForDirectCollateral(
    {
      ...preparation,
      evidence: {
        ...preparation.evidence,
        checks: [
          ...preparation.evidence.checks,
          {
            checkId: "venue_approval",
            status: "action_required",
            safeLabel: "",
            reasonCode: null,
          },
        ],
      },
    },
    start,
  ),
  false,
);

const market: ApiTradeMarket = {
  id: "polymarket:1",
  venue: "polymarket",
  venue_market_id: "1",
  event_id: "e",
  event_title: "Election",
  title: "Candidate",
  outcomes: '["Named yes","Named no"]',
  token_yes: "yes",
  token_no: "no",
  slug: "market",
  metadata: {},
  status: "ACTIVE",
  accepting_orders: true,
  best_ask: null,
  best_bid: null,
  last_price: null,
  updated_at: new Date(start),
  is_initialized: true,
  clob_token_ids: null,
  close_time: null,
  expiration_time: null,
  event_end_time: null,
  condition_id: "condition",
};
const ctx: PolymarketQuoteContext = {
  bookSnapshot: {
    payload: { asks: [{ price: "0.5", size: "100" }] },
    observedAt: new Date(start).toISOString(),
    sourceAsOf: null,
    expiresAt: new Date(start + 5000).toISOString(),
  },
  orderbook: {
    asks: [{ price: 0.5, size: 100 }],
    bids: [{ price: 0.49, size: 100 }],
    tickSize: 0.01,
    minOrderSize: 5,
    negRisk: false,
  },
  marketInfo: null,
  platformFeeCurve: null,
  feePolicySnapshot: {
    venue: "polymarket",
    collectionMode: "none",
    builderCode: `0x${"0".repeat(64)}`,
    builderTakerFeeBps: 0,
    builderMakerFeeBps: 0,
    builderRateSource: "none",
    builderEnabled: false,
    legacyFeeBps: 0,
    feePolicyId: null,
    capturedAt: new Date(start).toISOString(),
  },
};
let fundsCalls = 0;
const deps: RecommendedSpendDependencies = {
  market: async () => market,
  orderable: async () => true,
  polyContext: async () => ctx,
  limitlessBook: async () => ({
    payload: {
      tokenId: "1",
      asks: [{ price: "0.5", size: "100000000" }],
      bids: [{ price: "0.3", size: "100000000" }],
    },
    observedAt: new Date(start).toISOString(),
    sourceAsOf: null,
    expiresAt: new Date(start + 5000).toISOString(),
  }),
  funds: async () => {
    fundsCalls++;
    return {
      status: "ready",
      walletId: "wallet",
      availableRaw: 20_000_000n,
      asOf: new Date(start).toISOString(),
    };
  },
  now: () => clock,
};
const input = { marketId: market.id, tokenId: "yes", slippageBps: 100 };
const service = createRecommendedSpendService(deps);
const publicResult = await service.read(input);
recommendedSpendResponse.parse(publicResult);
assert.equal(publicResult.market.maxOrderAmountUsd, "50");
assert.equal(publicResult.market.totalDebitUsd, "50");
assert.equal(publicResult.outcomeLabel, "Named yes");
assert.equal(fundsCalls, 0);
const personal = await service.read(input, {
  userId: "user",
  signer: "signer",
});
assert.deepEqual(personal.market, publicResult.market);
assert.equal(personal.account?.recommendedOrderAmountUsd, "20");
assert.equal(personal.account?.limitingFactor, "balance");
await assert.rejects(
  service.read({ ...input, tokenId: "unknown" }),
  /instrument_mismatch/,
);
assert.equal(
  (
    await createRecommendedSpendService({
      ...deps,
      market: async () => ({
        ...market,
        venue: "limitless",
        token_yes: "1",
        token_no: "2",
      }),
    }).read({ ...input, tokenId: "2" })
  ).market.maxOrderAmountUsd,
  "70",
);
assert.equal(
  (
    await createRecommendedSpendService({
      ...deps,
      orderable: async () => false,
    }).read(input)
  ).market.status,
  "market_unavailable",
);
assert.equal(
  (
    await createRecommendedSpendService({
      ...deps,
      funds: async () => ({
        status: "balance_unavailable",
        walletId: null,
        availableRaw: null,
        asOf: null,
      }),
    }).read(input, { userId: "user", signer: null })
  ).account?.recommendedOrderAmountUsd,
  null,
);
const recordedOnly = await createRecommendedSpendService({
  ...deps,
  funds: async () => ({
    status: "ready",
    walletId: "wallet",
    availableRaw: 20_000_000n,
    asOf: new Date(start).toISOString(),
    openOrderCoverage: "hunch_recorded",
  }),
}).read(input, { userId: "user", signer: null });
assert.equal(recordedOnly.account?.openOrderCoverage, "hunch_recorded");
assert.ok(recordedOnly.warnings.includes("external_orders_not_included"));
const failedAccounting = await createRecommendedSpendService({
  ...deps,
  funds: async () => {
    throw Error("account read failed");
  },
}).read(input, { userId: "user", signer: null });
assert.equal(failedAccounting.account?.status, "balance_unavailable");
assert.equal(failedAccounting.account?.openOrderCoverage, "unknown");
assert.equal(failedAccounting.account?.availableCollateralUsd, null);
assert.equal(failedAccounting.market.status, "ready");
assert.equal(
  (
    await createRecommendedSpendService({
      ...deps,
      polyContext: async () => ({ ...ctx, platformFeeCurveUnavailable: true }),
    }).read(input, { userId: "user", signer: "signer" })
  ).account?.status,
  "fees_unavailable",
);
const changed = createRecommendedSpendService({
  ...deps,
  market: async () => {
    const value = { ...market };
    if (++reads > 1) value.token_yes = "replacement";
    return value;
  },
});
let reads = 0;
assert.equal((await changed.read(input)).market.status, "market_unavailable");
for (const [metadata, expected] of [
  [{ version: "v2" }, "market_unavailable"],
  [{ volume: "new display metric" }, "ready"],
] as const) {
  let generationReads = 0;
  const checked = await createRecommendedSpendService({
    ...deps,
    market: async () => ({
      ...market,
      metadata: ++generationReads > 1 ? metadata : {},
    }),
  }).read(input);
  assert.equal(checked.market.status, expected);
}
let failedReads = 0;
const failedFinalCheck = await createRecommendedSpendService({
  ...deps,
  market: async () => {
    if (++failedReads > 1) throw Error("db offline");
    return market;
  },
}).read(input, { userId: "user", signer: null });
assert.equal(failedFinalCheck.market.status, "unavailable");
assert.equal(failedFinalCheck.account?.recommendedOrderAmountUsd, null);
clock = start + 5001;
assert.equal((await service.read(input)).market.status, "stale_book");
clock = start;
const oldMax = await findMaxPolymarketMarketBuyUsdForFunds({} as never, {
  tokenId: "yes",
  executableFundsRaw: 100_000_000n,
  context: ctx,
  slippageBps: 100,
});
assert.ok(oldMax.ok);
assert.equal(oldMax.maxAmountUsdRaw, "50000000");
for (const [price, tick, max] of [
  [0.53, 0.01, "99640000"],
  [0.531, 0.001, "95580000"],
  [0.999, 0.001, "99900000"],
] as const) {
  const zeroContext = {
    ...ctx,
    orderbook: {
      ...ctx.orderbook,
      tickSize: tick,
      asks: [{ price, size: 10000 }],
    },
  };
  for (const slippageBps of [0, undefined]) {
    const result = await findMaxPolymarketMarketBuyUsdForFunds({} as never, {
      tokenId: "yes",
      executableFundsRaw: 100_000_000n,
      context: zeroContext,
      slippageBps,
    });
    assert.ok(result.ok);
    assert.equal(result.maxAmountUsdRaw, max);
    assert.equal(
      Number(result.quote.makerAmount) / Number(result.quote.takerAmount),
      price,
    );
  }
}
assert.ok(ctx.bookSnapshot);
const expiredContext = {
  ...ctx,
  bookSnapshot: {
    ...ctx.bookSnapshot,
    expiresAt: new Date(Date.now() - 1).toISOString(),
  },
};
assert.throws(
  () =>
    calculatePolymarketQuote({
      tokenId: "yes",
      side: "BUY",
      orderType: "FOK",
      amountType: "usd",
      amountUsdRawInput: 10_000_000n,
      context: expiredContext,
    }),
  /expired/,
);
assert.equal(
  calculatePolymarketSignedBuyRequiredSpendRaw({
    context: expiredContext,
    makerAmountRaw: 10_000_000n,
    takerAmountRaw: 20_000_000n,
    orderType: "FOK",
  }),
  null,
);
const minShareContext = {
  ...ctx,
  orderbook: { ...ctx.orderbook, minOrderSize: 1000 },
};
assert.equal(
  (
    await createRecommendedSpendService({
      ...deps,
      polyContext: async () => minShareContext,
    }).read(input)
  ).market.maxOrderAmountUsd,
  "50",
);
const amm = createRecommendedSpendService({
  ...deps,
  market: async () => ({
    ...market,
    venue: "limitless",
    token_yes: "1",
    token_no: "2",
    metadata: { tradeType: "amm" },
  }),
});
assert.equal(
  (await amm.read({ ...input, tokenId: "1" })).market.status,
  "unsupported_market_type",
);

// Only the selected economic component; max(local, live) locks, plus durable holds.
const asset = {
  networkId: "evm:137",
  assetId: "0xasset",
  decimals: 6,
  kind: "erc20",
} as const;
const account = {
  projection: {
    components: [
      {
        componentId: "one",
        category: "cash",
        valuationEligibility: "included",
        location: { details: { address: "0xfunder" } },
      },
    ],
  },
  cashAvailability: {
    components: [
      {
        componentId: "one",
        amount: { asset, raw: "100000000" },
        lockedRaw: "10000000",
        reservedRaw: "20000000",
        submittedDebitRaw: "5000000",
        freshness: "fresh",
        reasonCodes: [],
        asOf: new Date(start).toISOString(),
      },
    ],
  },
} as unknown as AccountValueReadModel;
const selection = {
  account,
  address: "0xfunder",
  asset,
  observedRaw: "100000000",
  liveLockedRaw: 15_000_000n,
  now: start,
};
assert.equal(selectedReadyCollateral(selection)?.availableRaw, 60_000_000n);
assert.equal(
  selectedReadyCollateral({ ...selection, allowanceRaw: 50_000_000n })
    ?.availableRaw,
  10_000_000n,
);
assert.equal(
  selectedReadyCollateral({ ...selection, allowanceRaw: 1_000_000n })
    ?.availableRaw,
  0n,
);
assert.equal(
  selectedReadyCollateral({ ...selection, address: "0xother" }),
  null,
);
assert.equal(
  selectedReadyCollateral({ ...selection, now: start + 30_001 }),
  null,
);
assert.equal(
  selectedReadyCollateral({
    ...selection,
    account: {
      ...account,
      cashAvailability: {
        ...account.cashAvailability,
        components: [
          ...account.cashAvailability.components,
          ...account.cashAvailability.components,
        ],
      },
    },
  }),
  null,
);

const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(swagger, {
  openapi: { info: { title: "Recommended spend", version: "1" } },
  transform: jsonSchemaTransform,
});
let allow = true;
await app.register(
  createRecommendedSpendRoutes(
    service,
    async (request, reply) => {
      if (request.headers.authorization !== "test-session") {
        await reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      request.user = { id: "user" } as never;
      request.walletAddress = "signer";
    },
    async () => allow,
  ),
);
await app.ready();
try {
  const url = `/markets/${market.id}/recommended-spend?tokenId=yes`;
  assert.equal((await app.inject({ url })).statusCode, 200);
  assert.equal(
    (await app.inject({ url: `${url}&slippageBps=-1` })).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/trade/recommended-spend",
        payload: input,
      })
    ).statusCode,
    401,
  );
  const reply = await app.inject({
    method: "POST",
    url: "/trade/recommended-spend",
    payload: input,
    headers: { authorization: "test-session" },
  });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.headers["cache-control"], "private, no-store");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/trade/recommended-spend",
        payload: { ...input, balance: 1e9 },
        headers: { authorization: "test-session" },
      })
    ).statusCode,
    400,
  );
  allow = false;
  assert.equal((await app.inject({ url })).statusCode, 429);
  allow = true;
  const times: number[] = [];
  for (let i = 0; i < 200; i++) {
    const before = performance.now();
    await app.inject({ url });
    times.push(performance.now() - before);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)] ?? Infinity;
  assert.ok(p95 <= 150, `warm in-process route p95 ${p95}ms`);
  console.log(
    `Recommended spend injected route (fixture data), n=200 p95=${p95.toFixed(2)}ms; zero external calls`,
  );
  const paths = app.swagger().paths ?? {};
  for (const key of [
    "/markets/{marketId}/recommended-spend",
    "/trade/recommended-spend",
  ])
    assert.ok(paths[key]);
  if (
    process.argv.includes("--write-openapi") ||
    process.argv.includes("--compare-openapi")
  ) {
    const path = new URL("../openapi.json", import.meta.url);
    const committed = JSON.parse(readFileSync(path, "utf8"));
    for (const key of [
      "/markets/{marketId}/recommended-spend",
      "/trade/recommended-spend",
    ]) {
      if (process.argv.includes("--write-openapi"))
        committed.paths[key] = paths[key];
      else assert.deepEqual(committed.paths[key], paths[key]);
    }
    if (process.argv.includes("--write-openapi"))
      writeFileSync(path, `${JSON.stringify(committed, null, 2)}\n`);
  }
} finally {
  await app.close();
}
console.log(
  "Recommended spend math, fees, account isolation, cache, expiry, generation, HTTP and OpenAPI passed",
);
const timeoutStarted = performance.now();
const timedOut = await createRecommendedSpendService({
  ...deps,
  polyContext: () => new Promise(() => {}),
}).read(input);
assert.equal(timedOut.market.status, "unavailable");
assert.ok(
  performance.now() - timeoutStarted < 4_000,
  "provider wait remains bounded",
);
console.log(
  "Unresponsive quote source returns unavailable within bounded timeout",
);
