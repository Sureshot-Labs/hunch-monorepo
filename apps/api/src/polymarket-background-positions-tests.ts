import assert from "node:assert/strict";
import { keccak256, toUtf8Bytes } from "ethers";
import {
  discoverBackgroundPolymarketPositions as discover,
  loadBackgroundPositionConfig,
  type PositionDiscoveryStore,
} from "./services/polymarket-background-positions.js";
import { walletIntelProtocolAddresses } from "./services/wallet-intel-protocol-addresses.js";
import { serialQueryClient } from "./lib/serial-query-client.js";

const owner = "0x1111111111111111111111111111111111111111";
const maxToken = ((1n << 256n) - 1n).toString();
const position = (token = "1") => ({
  token_id: token,
  proxy_wallet: owner,
  condition_id: `0x${"11".repeat(32)}`,
  current_size: 2,
  total_size: 3,
  avg_price: 0.4,
  outcome_index: 0,
  redeemable: false,
  entry_cost_usdc: 0.8,
  entry_fees_usdc: 0,
  total_cost_usdc: 0.8,
  realized_pnl: 0,
  unrealized_pnl: 0,
  current_value: 0.8,
});
const page = (rows: unknown[], cursor: string | null) =>
  Response.json({ data: rows, pagination: { next_cursor: cursor } });
const failure = (status: number, extra: object = {}, headers?: HeadersInit) =>
  Response.json({ code: "invalid_request", ...extra }, { status, headers });
function memoryStore() {
  const values = new Map<string, string>();
  const store: PositionDiscoveryStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    del: async (key) => {
      values.delete(key);
    },
  };
  return { store, values };
}
const defaults = {
  owner,
  baseUrl: "https://data.example.invalid/v2",
  sleep: async () => {},
};
const fetcher = (handler: (url: URL) => Response | Promise<Response>) =>
  (async (url: URL | string | Request) =>
    handler(new URL(String(url)))) as typeof fetch;
const basic = await discover({
  ...defaults,
  fetchImpl: fetcher(() => page([position(maxToken)], null)),
});
assert.equal(basic.status, "complete");
assert.deepEqual(basic.tokens, [{ tokenId: maxToken, averagePrice: "0.4" }]);
assert.equal(loadBackgroundPositionConfig({}).walletBudgetMs, 15000);
assert.equal(
  loadBackgroundPositionConfig({
    WALLET_INTEL_POLY_POSITIONS_WALLET_BUDGET_MS: "0",
  }).walletBudgetMs,
  15000,
);
assert.equal(
  loadBackgroundPositionConfig({
    WALLET_INTEL_POLY_POSITIONS_PAGES_PER_SLICE: "100",
  }).pagesPerSlice,
  100,
);
assert.equal(
  walletIntelProtocolAddresses([owner.toUpperCase(), owner, "invalid"]).filter(
    (a) => a === owner,
  ).length,
  1,
);

// More than the UI's 20-page ceiling, with a process restart between slices.
const resume = memoryStore();
const cursors: (string | null)[] = [];
const many = fetcher((url) => {
  const cursor = url.searchParams.get("cursor");
  cursors.push(cursor);
  const index = cursor === null ? 0 : Number(cursor);
  return page(
    [position(String(index + 1))],
    index === 24 ? null : String(index + 1),
  );
});
const first = await discover({
  ...defaults,
  store: resume.store,
  fetchImpl: many,
  config: { pagesPerSlice: 10 },
});
assert.equal(first.reason, "page_budget");
assert.deepEqual(first.tokens, []);
assert.equal(first.discoveredTokens, 10);
assert.equal(first.checkpointAvailable, true);
const second = await discover({
  ...defaults,
  store: resume.store,
  fetchImpl: many,
});
assert.equal(second.status, "complete");
assert.equal(second.resumed, true);
assert.equal(second.tokens.length, 25);
assert.equal(second.pages, 25);
assert.equal(cursors[10], "10");
assert.equal(resume.values.size, 0);

// Wall-clock budget applies to the slice, not an entire large portfolio.
let clock = 1000;
const budget = memoryStore();
const timed = await discover({
  ...defaults,
  store: budget.store,
  now: () => clock,
  config: { walletBudgetMs: 100 },
  fetchImpl: fetcher(() => {
    clock += 100;
    return page([position()], "next");
  }),
});
assert.equal(timed.reason, "time_budget");
assert.deepEqual(timed.tokens, []);
assert.equal(timed.pages, 1);

// Transient errors retry the same cursor, then keep usable progress for recovery.
const retry = memoryStore();
let calls = 0;
const retryCursors: (string | null)[] = [];
const deferred = await discover({
  ...defaults,
  store: retry.store,
  fetchImpl: fetcher((url) => {
    retryCursors.push(url.searchParams.get("cursor"));
    calls++;
    if (calls === 1) return page([position()], "next");
    return failure(503, { retryable: true });
  }),
});
assert.equal(deferred.reason, "upstream_error");
assert.equal(deferred.retries, 1);
assert.deepEqual(deferred.tokens, []);
assert.deepEqual(retryCursors, [null, "next", "next"]);
const recovered = await discover({
  ...defaults,
  store: retry.store,
  fetchImpl: fetcher((url) => {
    assert.equal(url.searchParams.get("cursor"), "next");
    return page([position("2")], null);
  }),
});
assert.equal(recovered.tokens.length, 2);
let timeoutCalls = 0;
const timeout = await discover({
  ...defaults,
  fetchImpl: fetcher(() => {
    timeoutCalls++;
    throw new DOMException("test", "TimeoutError");
  }),
});
assert.equal(timeout.reason, "upstream_timeout");
assert.equal(timeoutCalls, 2);
let delays = 0;
const limited = await discover({
  ...defaults,
  sleep: async () => {
    delays++;
  },
  fetchImpl: fetcher(() =>
    failure(429, { retryable: true }, { "retry-after": "60" }),
  ),
});
assert.equal(limited.reason, "rate_limited");
assert.equal(delays, 0);
assert.equal(limited.httpStatus, 429);
const rateCache = memoryStore();
let rateClock = 10000;
let rateCalls = 0;
const rateFetch = fetcher(() => {
  rateCalls++;
  return rateCalls === 1
    ? page([position()], "rate-cursor")
    : failure(429, { retryable: true }, { "retry-after": "60" });
});
const rateFirst = await discover({
  ...defaults,
  store: rateCache.store,
  now: () => rateClock,
  fetchImpl: rateFetch,
});
assert.equal(rateFirst.reason, "rate_limited");
assert.equal(rateFirst.pagesThisSlice, 1);
await discover({
  ...defaults,
  store: rateCache.store,
  now: () => rateClock,
  fetchImpl: rateFetch,
});
assert.equal(rateCalls, 2, "server Retry-After survives a process restart");
rateClock += 60001;
const rateRecovery = await discover({
  ...defaults,
  store: rateCache.store,
  now: () => rateClock,
  fetchImpl: fetcher((url) => {
    assert.equal(url.searchParams.get("cursor"), "rate-cursor");
    return page([], null);
  }),
});
assert.equal(rateRecovery.status, "complete");
// Inventory age cannot override Retry-After, including a non-retryable 429.
for (const retryable of [true, false]) {
  const ageCache = memoryStore();
  let ageClock = 100000;
  let calls = 0;
  let savedTtl = 0;
  const ageStore: PositionDiscoveryStore = {
    ...ageCache.store,
    set: async (key, value, options) => {
      savedTtl = options.PX;
      return ageCache.store.set(key, value, options);
    },
  };
  const now = () => ageClock;
  await discover({
    ...defaults,
    now,
    store: ageStore,
    config: { pagesPerSlice: 1 },
    fetchImpl: fetcher(() => page([position()], "old-cursor")),
  });
  ageClock += 6 * 3600000 - 1000;
  await discover({
    ...defaults,
    now,
    store: ageStore,
    fetchImpl: fetcher(() => {
      calls++;
      return failure(429, { retryable }, { "retry-after": "86400" });
    }),
  });
  assert.equal(savedTtl, 86400000, "Redis TTL covers the provider deadline");
  ageClock += 2000;
  const waiting = await discover({
    ...defaults,
    now,
    store: ageStore,
    fetchImpl: fetcher(() => {
      calls++;
      return page([], null);
    }),
  });
  assert.equal(waiting.reason, "rate_limited");
  assert.equal(
    waiting.discoveredTokens,
    0,
    "expired inventory discarded independently",
  );
  assert.equal(calls, 1);
  ageClock += 86400000;
  const afterDelay = await discover({
    ...defaults,
    now,
    store: ageStore,
    fetchImpl: fetcher((url) => {
      assert.equal(url.searchParams.get("cursor"), null);
      return page([position("2")], null);
    }),
  });
  assert.equal(afterDelay.status, "complete");
  assert.equal(afterDelay.tokens.length, 1);
}
const burn = keccak256(toUtf8Bytes("NO_TOKEN_BURN_ADDRESS")).slice(0, 42);
assert.equal(burn, "0xa5ef39c3d3e10d0b270233af41cac69796b12966");
assert.ok(walletIntelProtocolAddresses().includes(burn));

// A rejected opaque cursor has one immediate recovery path, not a stale cooldown.
const rejected = memoryStore();
await discover({
  ...defaults,
  store: rejected.store,
  config: { pagesPerSlice: 1 },
  fetchImpl: fetcher(() => page([position()], "expired")),
});
const resetCursors: (string | null)[] = [];
const reset = await discover({
  ...defaults,
  store: rejected.store,
  fetchImpl: fetcher((url) => {
    const cursor = url.searchParams.get("cursor");
    resetCursors.push(cursor);
    return cursor
      ? failure(400, { parameter: "cursor" })
      : page([position("2")], null);
  }),
});
assert.equal(reset.status, "complete");
assert.equal(reset.cursorRestarts, 1);
assert.deepEqual(resetCursors, ["expired", null]);
assert.deepEqual(
  reset.tokens.map((t) => t.tokenId),
  ["2"],
);
const stuckCache = memoryStore();
const stuckCursors: (string | null)[] = [];
const stuck = await discover({
  ...defaults,
  store: stuckCache.store,
  fetchImpl: fetcher((url) => {
    stuckCursors.push(url.searchParams.get("cursor"));
    return page([position()], "stuck");
  }),
});
assert.equal(stuck.reason, "invalid_response");
assert.equal(stuck.cursorRestarts, 1);
assert.equal(stuckCache.values.size, 0);
assert.deepEqual(stuckCursors, [null, "stuck", null, "stuck"]);
const stuckRecovery = await discover({
  ...defaults,
  store: stuckCache.store,
  fetchImpl: fetcher((url) => {
    assert.equal(url.searchParams.get("cursor"), null);
    return page([position()], null);
  }),
});
assert.equal(stuckRecovery.status, "complete");

let unexpected = 0;
const protocol = walletIntelProtocolAddresses()[1];
assert.ok(protocol);
const excluded = await discover({
  ...defaults,
  owner: protocol,
  fetchImpl: fetcher(() => {
    unexpected++;
    return page([], null);
  }),
});
assert.equal(excluded.reason, "protocol_contract");
assert.equal(unexpected, 0);
const providerExcluded = await discover({
  ...defaults,
  fetchImpl: fetcher(() =>
    failure(400, {
      parameter: "user",
      error: `user is a protocol contract address: ${owner}`,
    }),
  ),
});
assert.equal(providerExcluded.status, "excluded");
assert.equal(providerExcluded.parameter, "user");
assert.equal(JSON.stringify(providerExcluded).includes(owner), false);
const invalid = await discover({
  ...defaults,
  fetchImpl: fetcher(() =>
    failure(400, { parameter: "unsafe secret=payload" }),
  ),
});
assert.equal(invalid.reason, "invalid_request");
assert.equal(invalid.parameter, null);
assert.equal(invalid.retries, 0);

for (const response of [
  () => page([{ ...position(), proxy_wallet: protocol }], null),
  () => Response.json({ data: [] }),
  () => page([position()], "repeat"),
]) {
  let n = 0;
  const malformed = await discover({
    ...defaults,
    fetchImpl: fetcher(() => {
      n++;
      return response();
    }),
  });
  assert.equal(malformed.status, "deferred");
  assert.equal(malformed.reason, "invalid_response");
  assert.deepEqual(malformed.tokens, []);
  assert.ok(n <= 4, "at most one immediate cursor reset");
}
const capacity = memoryStore();
const capped = await discover({
  ...defaults,
  store: capacity.store,
  config: { maxRows: 1 },
  fetchImpl: many,
});
assert.equal(capped.reason, "capacity");
assert.deepEqual(capped.tokens, []);
const uncapped = await discover({
  ...defaults,
  store: capacity.store,
  config: { maxRows: 100 },
  fetchImpl: many,
});
assert.equal(uncapped.status, "complete");
assert.equal(uncapped.resumed, true);
const pageCap = memoryStore();
const pageCapped = await discover({
  ...defaults,
  store: pageCap.store,
  config: { maxPages: 2 },
  fetchImpl: many,
});
assert.equal(pageCapped.reason, "capacity");
const pageRecovered = await discover({
  ...defaults,
  store: pageCap.store,
  config: { maxPages: 100 },
  fetchImpl: many,
});
assert.equal(pageRecovered.status, "complete");
assert.equal(pageRecovered.resumed, true);

// Cache corruption, expiry, and an unavailable Redis never fabricate empty holdings.
for (const kind of ["json", "age", "shape"]) {
  const cache = memoryStore();
  await discover({
    ...defaults,
    store: cache.store,
    config: { pagesPerSlice: 1 },
    fetchImpl: many,
  });
  const entry = [...cache.values][0];
  assert.ok(entry);
  const [key, value] = entry;
  const parsed = JSON.parse(value);
  if (kind === "age") parsed.startedAt = 0;
  if (kind === "shape") parsed.tokens = [["not-a-token", null]];
  cache.values.set(key, kind === "json" ? "{" : JSON.stringify(parsed));
  const fresh = await discover({
    ...defaults,
    store: cache.store,
    fetchImpl: fetcher((url) => {
      assert.equal(url.searchParams.get("cursor"), null);
      return page([], null);
    }),
  });
  assert.equal(fresh.status, "complete");
  assert.equal(fresh.resumed, false);
}
const broken: PositionDiscoveryStore = {
  get: async () => {
    throw Error("offline");
  },
  set: async () => {
    throw Error("offline");
  },
  del: async () => {
    throw Error("offline");
  },
};
const offline = await discover({
  ...defaults,
  store: broken,
  config: { pagesPerSlice: 1 },
  fetchImpl: many,
});
assert.equal(offline.checkpointAvailable, false);
assert.equal(offline.status, "deferred");
assert.deepEqual(offline.tokens, []);
const offlineComplete = await discover({
  ...defaults,
  store: broken,
  fetchImpl: fetcher(() => page([position()], null)),
});
assert.equal(offlineComplete.status, "complete");
assert.equal(offlineComplete.tokens.length, 1);
const isolated = memoryStore();
await discover({
  ...defaults,
  store: isolated.store,
  config: { pagesPerSlice: 1 },
  fetchImpl: many,
});
await discover({
  ...defaults,
  baseUrl: "https://other.example.invalid",
  store: isolated.store,
  fetchImpl: fetcher((url) => {
    assert.equal(url.searchParams.get("cursor"), null);
    return page([], null);
  }),
});
assert.equal(isolated.values.size, 1);

// Match the old PG single-connection ordering explicitly, without failed-query poisoning.
let active = 0,
  maxActive = 0;
const ordered: number[] = [];
const serial = serialQueryClient({
  query: async (n: number) => {
    active++;
    maxActive = Math.max(active, maxActive);
    await new Promise((resolve) => setTimeout(resolve, 1));
    ordered.push(n);
    active--;
    if (n === 2) throw Error("expected");
    return n;
  },
});
const results = await Promise.allSettled(
  [1, 2, 3].map((n) => serial.client.query(n)),
);
assert.equal(maxActive, 1);
assert.deepEqual(ordered, [1, 2, 3]);
assert.equal(results[2]?.status, "fulfilled");
await assert.rejects(
  (
    serial.client.query as unknown as (callback: () => void) => Promise<unknown>
  )(() => {}),
  /promise-based/,
);
await serial.drain();
await assert.rejects(serial.client.query(4), /closed/);
console.log(
  "[background positions] complete/resume/recovery/protocol/privacy/SQL queue scenarios passed",
);
