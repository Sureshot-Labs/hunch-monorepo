import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeGammaLifecycle } from "@hunch/shared";
import { resolvePolymarketGammaOutcome } from "./services/market-resolution-outcomes.js";
import { publicHunchPricePresentation } from "./services/hunch-price-presentation.js";
import {
  fetchPolymarketDataApiV2Page,
  parsePolymarketDataApiV2Page,
  parsePolymarketDataApiV2Trade,
  parsePolymarketDataApiV2Position,
  parsePolymarketDataApiV2HolderGroup,
} from "./services/polymarket-data-api-v2.js";
import { parsePolymarketPricePoint } from "./services/polymarket-price-history.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/polymarket/v2-public-20261015.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
for (const resolutionStatus of ["active", "inactive", "unknown", "resolved"]) {
  for (const outcomePrices of [
    '["1","0"]',
    '["0","1"]',
    '["0.5","0.5"]',
    '["1",null]',
  ]) {
    const raw = {
      ...fixture.markets[0],
      closed: true,
      resolutionStatus,
      outcomePrices,
    };
    const canonical = resolvePolymarketGammaOutcome(raw).resolvedOutcome;
    assert.equal(canonical, normalizeGammaLifecycle(raw).resolvedOutcome);
    assert.equal(
      canonical,
      resolutionStatus !== "resolved"
        ? null
        : outcomePrices === '["1","0"]'
          ? "YES"
          : outcomePrices === '["0","1"]'
            ? "NO"
            : null,
    );
    const publicResult = publicHunchPricePresentation({
      kind: "signal",
      side: "YES",
      researchedSide: "YES",
      researchedPrice: 0.5,
      researchedAt: "2026-10-14T10:00:00Z",
      acceptingOrders: false,
      venue: "polymarket",
      metadata: raw,
      marketUpdatedAt: raw.updatedAt,
      resolvedOutcome: canonical,
      quotePrice: null,
      quoteAsOf: null,
    });
    assert.equal(
      publicResult.resolutionStatus,
      resolutionStatus === "resolved" ? "resolved" : null,
    );
    assert.equal(
      publicResult.selectedSideResult,
      canonical === "YES" ? "WIN" : canonical === "NO" ? "LOSS" : null,
    );
  }
}
const holders = parsePolymarketDataApiV2Page(
  fixture.holders.payload,
  parsePolymarketDataApiV2HolderGroup,
);
assert.deepEqual(
  holders.data.map((item) => item.tokenId),
  fixture.markets[0].positionIds,
);
assert.equal(
  parsePolymarketDataApiV2Page(
    fixture.positions,
    parsePolymarketDataApiV2Position,
  ).data[0]?.currentSize,
  20,
);
assert.equal(
  parsePolymarketDataApiV2Page(
    fixture.history.payload,
    parsePolymarketPricePoint,
  ).data[0]?.p,
  0.675,
);
const cursors: Array<string | null> = [];
const fetchImpl = (async (input: URL | RequestInfo) => {
  const cursor = new URL(String(input)).searchParams.get("cursor");
  cursors.push(cursor);
  return new Response(
    JSON.stringify(
      cursor ? fixture.tradesNext.payload : fixture.trades.payload,
    ),
    { status: 200 },
  );
}) as typeof fetch;
const options = {
  baseUrl: "https://data.test",
  endpoint: "trades" as const,
  params: { condition_id: fixture.markets[0].conditionId, limit: "2" },
  parseRow: parsePolymarketDataApiV2Trade,
  timeoutMs: 1000,
  fetchImpl,
};
const first = await fetchPolymarketDataApiV2Page(options);
const second = await fetchPolymarketDataApiV2Page({
  ...options,
  cursor: first.nextCursor,
});
assert.deepEqual(cursors, [
  null,
  fixture.trades.payload.pagination.next_cursor,
]);
assert.ok(first.data[0] && second.data[0]);
assert.notEqual(first.data[0].transactionHash, second.data[0].transactionHash);
assert.ok(first.data[0].timestamp > second.data[0].timestamp);
assert.equal(second.data[1]?.tokenId, fixture.markets[0].positionIds[1]);
console.log(
  "ok - real V2 holders/positions/trades/history/cursor, maintenance and Hunch resolution contracts",
);
