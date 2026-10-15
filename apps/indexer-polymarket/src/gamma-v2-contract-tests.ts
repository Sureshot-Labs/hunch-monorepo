import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeGammaLifecycle } from "@hunch/shared";
import { GammaEvent, PolymarketEvent, PolymarketMarket } from "./types.js";
import { mapToUnifiedMarket, mapPolymarketMarketRow } from "./mappers.js";
import {
  repairGammaEvents,
  GAMMA_EVENT_REPAIR_KEY,
} from "./gamma-event-repair.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/polymarket/v2-public-20261015.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
process.env.HUNCH_RUNTIME_SECRETS_LOADED = "1";
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";
const { postBooksOnce } = await import("./clobClient.js");
const originalFetch = globalThis.fetch;
try {
  // Empty and one-sided CLOB responses stay empty/one-sided. Gamma's nominal
  // 0.5/0.5 is not an executable quote and must not fill in either book side.
  const books = [fixture.emptyBook, { ...fixture.book.payload, asks: [] }];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(books))) as typeof fetch;
  assert.deepEqual(
    await postBooksOnce(books.map((book) => book.asset_id)),
    books,
  );
  const unquoted = mapToUnifiedMarket(
    PolymarketMarket.parse({
      ...fixture.markets[0],
      outcomePrices: '["0.5","0.5"]',
      bestBid: null,
      bestAsk: null,
    }),
    "1188976",
  );
  assert.equal(unquoted.best_bid, undefined);
  assert.equal(unquoted.best_ask, undefined);
} finally {
  globalThis.fetch = originalFetch;
}
for (const raw of fixture.markets) {
  const event = PolymarketEvent.parse(
    GammaEvent.parse({
      id: "1188976",
      title: "Public V2 fixture",
      markets: [raw],
    }),
  );
  const market = event.markets[0];
  assert.ok(market);
  const unified = mapToUnifiedMarket(market, event.id, event);
  assert.equal(unified.clob_token_ids, JSON.stringify(raw.positionIds));
  assert.equal(
    mapPolymarketMarketRow(event.id, market).clob_token_ids,
    unified.clob_token_ids,
  );
  assert.deepEqual(
    normalizeGammaLifecycle(raw).resolvedOutcome,
    unified.resolved_outcome ?? null,
  );
  assert.equal(
    unified.status,
    raw.resolutionStatus === "resolved" ? "SETTLED" : "ACTIVE",
  );
}
for (const version of [undefined, "v1", "v2", "future"]) {
  for (const resolutionStatus of [
    undefined,
    "active",
    "inactive",
    "resolved",
    "unknown",
  ]) {
    for (const outcomePrices of [
      '["1","0"]',
      '["0","1"]',
      '["0.5","0.5"]',
      '["1",null]',
      '[null,"1","0"]',
      '["1",""]',
      '["2","-1"]',
    ]) {
      const raw = {
        ...fixture.markets[0],
        version,
        resolutionStatus,
        closed: true,
        outcomePrices,
      };
      const result = normalizeGammaLifecycle(raw);
      const canResolve =
        version == null ||
        version === "v1" ||
        (version === "v2" && resolutionStatus === "resolved");
      const expected = !canResolve
        ? null
        : outcomePrices === '["1","0"]'
          ? "YES"
          : outcomePrices === '["0","1"]'
            ? "NO"
            : null;
      assert.equal(result.resolvedOutcome, expected, JSON.stringify(raw));
      const mapped = mapToUnifiedMarket(PolymarketMarket.parse(raw), "1188976");
      assert.equal(mapped.resolved_outcome ?? null, expected);
      assert.equal(mapped.status, result.status);
    }
  }
}
assert.equal(
  normalizeGammaLifecycle({
    version: "v1",
    active: true,
    outcomePrices: '["1","0"]',
  }).resolvedOutcome,
  null,
);
assert.equal(
  normalizeGammaLifecycle({
    version: "v1",
    archived: true,
    outcomePrices: '["1","0"]',
  }).status,
  "ARCHIVED",
);
assert.equal(
  normalizeGammaLifecycle({
    version: "v2",
    archived: true,
    resolutionStatus: "resolved",
    outcomePrices: '["1","0"]',
  }).status,
  "SETTLED",
);

// Durable skipped IDs can be recovered even after the catalog is complete.
const pending = new Map([
  ["41", 1],
  ["42", 2],
  ["43", 3],
]);
const redis = {
  zRange: async (key: string, start: number, stop: number) => {
    assert.equal(key, GAMMA_EVENT_REPAIR_KEY);
    return [...pending]
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id)
      .slice(start, stop + 1);
  },
  zAdd: async (
    _key: string,
    values: Array<{ value: string; score: number }>,
  ) => {
    values.forEach((item) => pending.set(item.value, item.score));
  },
  zRem: async (_key: string, ids: string[]) => {
    ids.forEach((id) => pending.delete(id));
  },
  zCard: async () => pending.size,
};
let fixed = false;
const repair = () =>
  repairGammaEvents({
    redis,
    limit: 2,
    now: 10,
    fetchEvents: async (ids) => ({
      events: ids
        .filter((id) => id !== "43")
        .map((id) => ({ id, title: id, markets: [] })),
      missingIds: ids.filter((id) => id === "43"),
      failedIds: [],
    }),
    processEvents: async (events) => {
      const valid = events.filter((event) => fixed || event.id !== "41");
      await redis.zRem(
        GAMMA_EVENT_REPAIR_KEY,
        valid.map((event) => event.id),
      );
      return { processedEvents: valid.length };
    },
  });
assert.equal((await repair()).remaining, 2);
assert.equal(pending.has("41"), true);
fixed = true;
assert.equal((await repair()).remaining, 0);
assert.equal((await repair()).requested, 0);
console.log(
  "ok - public V2 binary/NegRisk/UpDown, lifecycle matrix, durable skipped-event recovery",
);
