import assert from "node:assert/strict";
import { buildHolderResearchPriceMovement } from "./services/holder-research-price-movement.js";
import {
  buildSignalPublicationSnapshot,
  parseSignalPublicationSnapshot,
  publicationQuoteQuality,
} from "./services/signal-publication-snapshot.js";

const now = new Date("2026-09-06T12:30:00Z");
const baseline = {
  yes: 0.2,
  no: 0.8,
  yesAt: "2026-09-05T12:00:00Z",
  noAt: "2026-09-05T12:00:00Z",
};
const movement = (overrides: Partial<typeof baseline> = {}, current = 0.22) =>
  buildHolderResearchPriceMovement({
    baseline: { ...baseline, ...overrides },
    yesProbabilityNow: current,
    now,
  });
assert.equal(movement().quality, "available");
assert.equal(
  movement({ yesAt: "2026-09-05T08:00:00Z", noAt: "2026-09-05T08:00:00Z" })
    .quality,
  "stale",
);
assert.equal(movement({ yesAt: "2026-09-05T13:00:00Z" }).quality, "stale");
assert.equal(movement({ no: 0.7 }).quality, "inconsistent");
assert.equal(
  movement({ noAt: "2026-09-05T11:00:00Z" }).quality,
  "inconsistent",
);
assert.equal(
  buildHolderResearchPriceMovement({
    baseline: null,
    yesProbabilityNow: 0.2,
    now,
  }).yesDeltaProbability24h,
  null,
);
const onlyNo = buildHolderResearchPriceMovement({
  baseline: { ...baseline, yes: null },
  yesProbabilityNow: 0.22,
  now,
});
assert.ok(Math.abs((onlyNo.yesDeltaProbability24h ?? NaN) - 0.02) < 1e-9);
const zero = movement({ yes: 0, no: 1 }, 0.02);
assert.equal(zero.yesRelativeReturn24h, null);
assert.equal(zero.yesDeltaProbability24h, 0.02);
assert.equal(zero.noRelativeReturn24h, -0.02);

const snapshot = buildSignalPublicationSnapshot({
  marketId: "m",
  venue: "polymarket",
  side: "NO",
  now,
  priceSnapshot: {
    version: 1,
    marketId: "m",
    venue: "polymarket",
    displaySide: "NO",
    asOf: now.toISOString(),
    displayPrice: 0.8,
    displayPriceSource: "midpoint",
    YES: { bid: 0.19, ask: 0.21, mark: 0.2 },
    NO: { bid: 0.79, ask: 0.81, mark: 0.8 },
  },
});
assert.equal(snapshot.ask, 0.81);
assert.equal(snapshot.displayPrice, 0.8);
assert.equal(snapshot.quoteQuality, "quoted_ask");
assert.equal(
  publicationQuoteQuality(snapshot, new Date(now.getTime() + 11 * 60_000)),
  "stale_quote",
);
assert.equal(
  publicationQuoteQuality({ ...snapshot, ask: null }, now),
  "missing_ask",
);
assert.equal(
  publicationQuoteQuality({ ...snapshot, bid: 0.9 }, now),
  "invalid_quote",
);
assert.equal(
  publicationQuoteQuality(
    { ...snapshot, quoteAsOf: new Date(now.getTime() + 1).toISOString() },
    now,
  ),
  "stale_quote",
);
assert.deepEqual(
  parseSignalPublicationSnapshot(JSON.parse(JSON.stringify(snapshot))),
  snapshot,
);
assert.equal(
  parseSignalPublicationSnapshot({ ...snapshot, ask: "not-a-price" }),
  null,
);
console.log("[signal-price-contract-tests] passed");
