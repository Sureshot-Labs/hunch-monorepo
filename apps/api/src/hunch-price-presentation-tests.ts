import assert from "node:assert/strict";
import { publicHunchPricePresentation } from "./services/hunch-price-presentation.js";

const now = Date.parse("2026-09-27T21:52:13Z");
const input = {
  kind: "signal",
  side: "NO",
  researchedSide: "NO",
  researchedPrice: 0.755,
  researchedAt: "2026-09-27T10:30:18.588Z",
  acceptingOrders: false,
  venue: "polymarket",
  metadata: {
    outcomePrices: '["0.0005", "0.9995"]',
    umaResolutionStatuses: '["proposed", "proposed"]',
  },
  marketUpdatedAt: "2026-09-27T21:46:48.730Z",
  resolvedOutcome: null,
  quotePrice: null,
  quoteAsOf: "2026-09-27T21:49:53.406Z",
  now,
};

// Public production snapshots: the selected-side books have only a bid or ask.
for (const [side, from, prices, expected] of [
  ["NO", 0.755, '["0.0005", "0.9995"]', 0.9995],
  ["NO", 0.665, '["0.9995", "0.0005"]', 0.0005],
  ["YES", 0.415, '["0.0005", "0.9995"]', 0.0005],
] as const) {
  for (const age of [0, 4 * 60 * 60_000]) {
    const result = publicHunchPricePresentation({
      ...input,
      side,
      researchedSide: side,
      researchedPrice: from,
      metadata: { ...input.metadata, outcomePrices: prices },
      now: now + age,
    });
    assert.equal(result.resolutionStatus, "proposed");
    assert.equal(result.selectedSideResult, null);
    assert.deepEqual(result.latestPriceSnapshot, {
      asOf: input.marketUpdatedAt,
      side,
      price: expected,
    });
  }
}

for (const prices of ['["1", "0"]', [1, 0]]) {
  const pending = publicHunchPricePresentation({
    ...input,
    acceptingOrders: true,
    metadata: { outcomePrices: prices, umaResolutionStatuses: '["proposed"]' },
  });
  assert.equal(
    pending.selectedSideResult,
    null,
    "a proposal and endpoint price are not a recorded final result",
  );
  assert.equal(
    pending.latestPriceSnapshot?.price,
    0,
    "zero must not be treated as missing",
  );
}

const quote = { quotePrice: 0.9, quoteAsOf: "2026-09-27T20:45:00Z" };
assert.equal(
  publicHunchPricePresentation({ ...input, ...quote }).latestPriceSnapshot
    ?.price,
  0.9995,
  "newer venue price supersedes a stopped pre-match book",
);
assert.equal(
  publicHunchPricePresentation({
    ...input,
    ...quote,
    quoteAsOf: "2026-09-27T21:50:00Z",
  }).latestPriceSnapshot?.price,
  0.9,
  "a newer valid two-sided quote still wins",
);
assert.equal(
  publicHunchPricePresentation({
    ...input,
    ...quote,
    acceptingOrders: true,
    metadata: { outcomePrices: '["0", "1"]' },
  }).latestPriceSnapshot?.price,
  0.9,
  "an open market prefers its fresh quote",
);
assert.equal(
  publicHunchPricePresentation({
    ...input,
    ...quote,
    acceptingOrders: true,
    metadata: {},
    now: now + 4 * 60 * 60_000,
  }).latestPriceSnapshot,
  null,
  "open markets retain stale-quote protection",
);
assert.equal(
  publicHunchPricePresentation({
    ...input,
    ...quote,
    metadata: {},
    now: now + 4 * 60 * 60_000,
  }).latestPriceSnapshot?.price,
  0.9,
  "a stopped market retains its last known quote",
);

for (const status of ["resolved", "finalized"]) {
  const final = publicHunchPricePresentation({
    ...input,
    resolvedOutcome: "NO",
    metadata: { umaResolutionStatus: status },
  });
  assert.equal(final.selectedSideResult, "WIN");
}
// Over and Under are labels; selected-side settlement uses the same canonical
// token mapping as prices. A NO/Under winner must not disappear or invert.
for (const side of ["YES", "NO"]) {
  const result = publicHunchPricePresentation({
    ...input,
    side,
    researchedSide: side,
    resolvedOutcome: side,
    metadata: { umaResolutionStatuses: '["proposed", "proposed"]' },
  });
  assert.equal(
    result.selectedSideResult,
    "WIN",
    "old proposal history cannot override the canonical winner",
  );
  assert.equal(result.resolutionStatus, "resolved");
}
assert.equal(
  publicHunchPricePresentation({
    ...input,
    resolvedOutcome: "YES",
    metadata: {},
  }).selectedSideResult,
  "LOSS",
);
assert.equal(
  publicHunchPricePresentation({
    ...input,
    metadata: { umaResolutionStatuses: ["disputed"] },
  }).selectedSideResult,
  null,
);
assert.equal(
  publicHunchPricePresentation({
    ...input,
    metadata: { outcomePrices: [1, 0] },
  }).selectedSideResult,
  null,
  "endpoint prices alone never establish settlement",
);

for (const price of [null, "", " ", true, "NaN", -1, 1.1]) {
  assert.equal(
    publicHunchPricePresentation({ ...input, metadata: {}, quotePrice: price })
      .latestPriceSnapshot,
    null,
  );
}
for (const asOf of [
  "invalid",
  "2026-09-27T09:00:00Z",
  "2026-09-28T00:00:00Z",
]) {
  assert.equal(
    publicHunchPricePresentation({ ...input, marketUpdatedAt: asOf })
      .latestPriceSnapshot,
    null,
    "never retimestamp an invalid, pre-call, or future venue observation",
  );
}
assert.equal(
  publicHunchPricePresentation({
    ...input,
    metadata: { outcomePrices: '["", " "]' },
  }).latestPriceSnapshot,
  null,
);
assert.equal(
  publicHunchPricePresentation({ ...input, researchedSide: "YES" })
    .latestPriceSnapshot,
  null,
);
assert.equal(
  publicHunchPricePresentation({ ...input, kind: "context" })
    .latestPriceSnapshot,
  null,
);
assert.equal(
  publicHunchPricePresentation({ ...input, venue: "kalshi" })
    .latestPriceSnapshot,
  null,
  "Polymarket outcome-array semantics are not guessed for another venue",
);
console.log("hunch price presentation tests passed");
