import assert from "node:assert/strict";

import {
  PolymarketClient,
  PolymarketRateLimiter,
} from "./services/polymarket-client.js";
import {
  fetchPolymarketPriceHistory,
  parsePolymarketPricePoint,
  polymarketPriceHistoryParams,
} from "./services/polymarket-price-history.js";

const now = 1791220000;
assert.deepEqual(polymarketPriceHistoryParams("1", { interval: "1m" }, now), {
  token_id: "1",
  limit: "10000",
  start: String(now + 1 - 60),
  end: String(now + 1),
});
for (const interval of ["max", "1M", "6M", "1Y"]) {
  assert.deepEqual(polymarketPriceHistoryParams("1", { interval }, now), {
    token_id: "1",
    limit: "10000",
    interval: "max",
    bucket_seconds: "10800",
  });
}
const historical = { startTs: now - 200 * 86400, endTs: now - 199 * 86400 };
const historicalParams = polymarketPriceHistoryParams("1", historical, now);
assert.equal(historicalParams.start, String(historical.startTs));
assert.equal(historicalParams.end, String(historical.endTs));
assert.equal(
  historicalParams.bucket_seconds,
  undefined,
  "service chooses a retained historical grain",
);
assert.throws(() => polymarketPriceHistoryParams("NaN", {}, now));
assert.throws(() =>
  polymarketPriceHistoryParams("1", { startTs: now, endTs: now - 1 }, now),
);
assert.deepEqual(
  parsePolymarketPricePoint({
    timestamp: now,
    price: 0,
    resolution_seconds: 0,
  }),
  { t: now, p: 0, resolutionSeconds: 0 },
);
assert.throws(() =>
  parsePolymarketPricePoint({
    timestamp: now,
    price: 69,
    resolution_seconds: 0,
  }),
);

const requests: URL[] = [];
const response = (data: unknown[], cursor: string | null) =>
  Response.json({ data, pagination: { next_cursor: cursor } });
const result = await fetchPolymarketPriceHistory({
  baseUrl: "https://data-api.example.invalid",
  params: historicalParams,
  timeoutMs: 1000,
  fetchImpl: (async (url) => {
    requests.push(new URL(String(url)));
    return requests.length === 1
      ? response(
          [{ timestamp: now - 2, price: 0.4, resolution_seconds: 10800 }],
          "next",
        )
      : response(
          [
            { timestamp: now - 2, price: 0.4, resolution_seconds: 10800 },
            { timestamp: now, price: 0, resolution_seconds: 0 },
          ],
          null,
        );
  }) as typeof fetch,
});
assert.equal(result.history.length, 2);
assert.equal(result.history.at(-1)?.p, 0);
assert.equal(requests[1]?.searchParams.get("start"), historicalParams.start);
assert.equal(requests[1]?.searchParams.get("end"), historicalParams.end);

const originalFetch = globalThis.fetch;
try {
  let calls = 0;
  globalThis.fetch = (async (url) => {
    calls++;
    assert.equal(new URL(String(url)).pathname, "/v2/prices-history");
    const points = Array.from({ length: 130 }, (_, i) => ({
      timestamp: now - 129 * 60 + i * 60,
      price: 0.4,
      resolution_seconds: 60,
    }));
    points.push({ timestamp: now + 1, price: 1, resolution_seconds: 0 });
    return response(points, null);
  }) as typeof fetch;
  const client = new PolymarketClient(new PolymarketRateLimiter());
  const long = await client.getPriceHistory("1", {
    interval: "max",
    endTs: now + 2,
    fidelity: 30,
  });
  const points = long.history as Array<{ t: number; p: number }>;
  assert.equal(
    points.at(-1)?.p,
    1,
    "downsampling preserves terminal settlement tick",
  );
  await Promise.all([
    client.getPriceHistory("1", { interval: "max" }),
    client.getPriceHistory("1", { interval: "1h", endTs: now }),
  ]);
  assert.equal(
    calls,
    3,
    "full-life and short-window in-flight reads must not share coarse data",
  );
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "[polymarket-price-history-tests] window bounds, units, cursor, sparse/terminal and queue paths passed",
);
